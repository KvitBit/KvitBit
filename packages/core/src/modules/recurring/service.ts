/**
 * `TemplatesLive`: the domain `Templates` tag (core-ports 4.8) over `RecurringRepo`.
 *
 * Method shape (src/index.ts): authorize (R1a) -> withIdempotency (C3) or transaction ->
 * lock (C2/C6) -> rules -> update/insert -> appendAudit (C5) -> orUnavailable.
 * `schedule` and `resume` bump the Template's revision: it covers the attached schedule.
 * The issuance steps of RecurringIssuance live in ./issuance.ts.
 */
import type {
  Action,
  DocumentInput,
  DocumentPatch,
  DocumentView,
  IsoDate,
  NotFound,
  Page,
  PageRequest,
  RecurringRunView,
  RequestOptions,
  ScheduleId,
  TemplateId,
  TemplateInput,
  TemplateSchedule,
  TemplateView,
  Unavailable,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import {
  Conflict,
  type CurrentCaller,
  DocumentPatch as DocumentPatchSchema,
  Documents,
  DocumentView as DocumentViewSchema,
  Forbidden,
  Invalid,
  TemplateId as TemplateIdSchema,
  TemplateInput as TemplateInputSchema,
  Templates,
} from "@kvitbit/domain/contract";
import { Clock, Effect, Layer, Option, Result, Schema } from "effect";
import { pragueDate } from "../../engines/calendar";
import { Schedules } from "../../engines/schedules";
import { authorizeInWorkspace } from "../../policy/Policy";
import { appendAudit } from "../../shared/audit";
import { orUnavailable } from "../../shared/errors";
import { withIdempotency } from "../../shared/idempotency";
import { IdGenerator, newId } from "../../shared/ids";
import { CoreStore } from "../../store/CoreStore";
import { DeliveryStatusLookup } from "./deliveries";
import type { CadenceUnit, ScheduleRow, TemplateRow } from "./repo";
import { dieOnUnique, RecurringRepo } from "./repo";
import { startingOccurrence } from "./sweep";
import { runView, scheduleView, TemplateViewCodec, templateView } from "./view";

/** Default and maximum page sizes of `runs` (PageRequest). */
const DEFAULT_PAGE = 50;

type CoreFailure = Invalid | Conflict | Forbidden | Unavailable;

/**
 * The implementation's honest error types: every method can also fail with `Unavailable`
 * (a port failure), which the domain tag omits (board #340/#341). One documented cast at the
 * layer boundary below.
 */
export interface TemplatesImpl {
  readonly save: (
    input: TemplateInput & { readonly id?: TemplateId; readonly expectedRevision?: number },
    opts?: RequestOptions,
  ) => Effect.Effect<TemplateView, CoreFailure | NotFound, CurrentCaller>;
  readonly archive: (
    id: TemplateId,
  ) => Effect.Effect<void, NotFound | Forbidden | Unavailable, CurrentCaller>;
  readonly schedule: (
    template: TemplateId,
    schedule: TemplateSchedule | null,
    expectedRevision: number,
  ) => Effect.Effect<TemplateView, CoreFailure | NotFound, CurrentCaller>;
  readonly resume: (
    template: TemplateId,
  ) => Effect.Effect<TemplateView, NotFound | Conflict | Forbidden | Unavailable, CurrentCaller>;
  readonly use: (
    template: TemplateId,
    input?: { readonly as?: "draft" | "issued"; readonly patch?: DocumentPatch },
    opts?: RequestOptions,
  ) => Effect.Effect<DocumentView, CoreFailure | NotFound, CurrentCaller>;
  readonly get: (
    id: TemplateId,
  ) => Effect.Effect<TemplateView, NotFound | Forbidden | Unavailable, CurrentCaller>;
  readonly list: Effect.Effect<ReadonlyArray<TemplateView>, Forbidden | Unavailable, CurrentCaller>;
  readonly runs: (
    template: TemplateId,
    page?: PageRequest,
  ) => Effect.Effect<
    Page<RecurringRunView>,
    Invalid | NotFound | Forbidden | Unavailable,
    CurrentCaller
  >;
}

const malformed = (path: ReadonlyArray<string>, reason: string) =>
  new Invalid({ issues: [{ path: [...path], code: "request.malformed", params: { reason } }] });

const illegal = () => new Conflict({ reason: "illegal_transition" });

const UsePayload = Schema.Struct({
  template: TemplateIdSchema,
  as: Schema.Literals(["draft", "issued"]),
  patch: Schema.optional(DocumentPatchSchema),
});

const SavePayload = Schema.Struct({
  ...TemplateInputSchema.fields,
  id: Schema.optional(TemplateIdSchema),
  expectedRevision: Schema.optional(Schema.Int),
});

const TemplateInputJson = Schema.toCodecJson(TemplateInputSchema);
const encodeInput = (input: TemplateInput): Record<string, unknown> =>
  Schema.encodeSync(TemplateInputJson)(input) as Record<string, unknown>;

/** Field-level audit changes between two saved inputs (encoded, so decimals compare by value). */
const inputChanges = (before: TemplateInput | null, after: TemplateInput) => {
  const a = before === null ? {} : encodeInput(before);
  const b = encodeInput(after);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.flatMap((key) =>
    JSON.stringify(a[key]) === JSON.stringify(b[key])
      ? []
      : [{ path: key, before: a[key] ?? null, after: b[key] ?? null }],
  );
};

/** Stateless input rules of `save`. */
const validateInput = (input: TemplateInput): Result.Result<TemplateInput, Invalid> => {
  if (input.name.trim().length === 0) return Result.fail(malformed(["name"], "empty"));
  if (input.due !== undefined && input.due.inDays < 0) {
    return Result.fail(
      new Invalid({ issues: [{ path: ["due", "inDays"], code: "document.due_before_issue" }] }),
    );
  }
  return Result.succeed({ ...input, name: input.name.trim() });
};

/** The rule and send options of a `schedule` argument, or `Invalid{schedule.cadence_invalid}`. */
const validateSchedule = (
  input: TemplateSchedule,
): Result.Result<
  {
    readonly unit: CadenceUnit;
    readonly interval: number;
    readonly startOn: IsoDate;
    readonly endOn: IsoDate | null;
    readonly issueAs: "invoice" | "proforma";
    readonly autoSend: boolean;
  },
  Invalid
> => {
  const cadence = (input: TemplateSchedule["every"]) => {
    const keys = Object.keys(input);
    if (keys.length !== 1) return null;
    if ("weeks" in input) return { unit: "weeks" as const, interval: input.weeks };
    if ("months" in input) return { unit: "months" as const, interval: input.months };
    if ("years" in input) return { unit: "years" as const, interval: input.years };
    return null;
  };
  const invalid = (path: ReadonlyArray<string>, reason: string) =>
    Result.fail(
      new Invalid({
        issues: [{ path: [...path], code: "schedule.cadence_invalid", params: { reason } }],
      }),
    );
  const every =
    typeof input.every === "object" && input.every !== null ? cadence(input.every) : null;
  if (every === null) return invalid(["every"], "unit");
  if (input.issueAs !== "invoice" && input.issueAs !== "proforma") {
    return invalid(["issueAs"], "kind");
  }
  if (typeof input.autoSend !== "boolean") return invalid(["autoSend"], "type");
  const rule = {
    every: input.every,
    startOn: input.startOn,
    ...(input.endOn !== undefined ? { endOn: input.endOn } : {}),
  };
  return Result.map(Schedules.validate(rule), () => ({
    unit: every.unit,
    interval: every.interval,
    startOn: input.startOn,
    endOn: input.endOn ?? null,
    issueAs: input.issueAs,
    autoSend: input.autoSend,
  }));
};

const PATCH_FIELDS = [
  "contact",
  "lines",
  "currency",
  "issuedOn",
  "taxableSupplyOn",
  "due",
  "language",
  "series",
  "bankAccount",
  "pricesIncludeVat",
  "variableSymbol",
  "orderNumber",
  "note",
  "paymentMethod",
] as const satisfies ReadonlyArray<keyof DocumentPatch & keyof DocumentInput>;

/** The template's values as a DocumentInput (relative due kept as `inDays`). */
export const documentInputOf = (input: TemplateInput): DocumentInput => {
  const { name: _name, due, ...rest } = input;
  return { ...rest, ...(due !== undefined ? { due: { inDays: due.inDays } } : {}) };
};

/** `use`: template values as defaults, the patch on top. */
const applyPatch = (
  base: DocumentInput,
  patch: DocumentPatch | undefined,
): Result.Result<DocumentInput, Invalid> => {
  if (patch === undefined) return Result.succeed(base);
  if (patch.number !== undefined)
    return Result.fail(malformed(["patch", "number"], "not_applicable"));
  if (patch.refreshParties !== undefined) {
    return Result.fail(malformed(["patch", "refreshParties"], "not_applicable"));
  }
  const next: Record<string, unknown> = { ...base };
  for (const field of PATCH_FIELDS) {
    if (patch[field] !== undefined) next[field] = patch[field];
  }
  if (patch.fx === null) delete next.fx;
  else if (patch.fx !== undefined) next.fx = patch.fx;
  return Result.succeed(next as unknown as DocumentInput);
};

interface Cursor {
  readonly template: string;
  readonly occurrence: IsoDate;
  readonly id: string;
}

const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(JSON.stringify([cursor.template, cursor.occurrence, cursor.id])).toString(
    "base64url",
  );

const decodeCursor = (raw: string, template: TemplateId): Cursor | null => {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      parsed.every((part) => typeof part === "string") &&
      parsed[0] === template
    ) {
      return { template, occurrence: parsed[1] as IsoDate, id: parsed[2] as string };
    }
    return null;
  } catch {
    return null;
  }
};

export const makeTemplates = Effect.gen(function* () {
  const store = yield* CoreStore;
  const ids = yield* IdGenerator;
  const repo = yield* RecurringRepo;
  const deliveries = yield* DeliveryStatusLookup;
  const documents = yield* Documents;
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(CoreStore, store), Effect.provideService(IdGenerator, ids));

  const nowIso = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString());
  const today = Effect.map(Clock.currentTimeMillis, pragueDate);

  const attached = (workspaceId: WorkspaceId, templateId: TemplateId) =>
    Effect.map(repo.attachedSchedule(workspaceId, templateId), Option.getOrNull);

  /**
   * The attached schedule, row-locked: the issuance steps change it under the same lock, so a
   * concurrent advance or pause is never overwritten (lock order: Template, then schedule).
   */
  const attachedLocked = (workspaceId: WorkspaceId, templateId: TemplateId) =>
    Effect.flatMap(attached(workspaceId, templateId), (found) =>
      found === null ? Effect.succeed(null) : repo.lockSchedule(workspaceId, found.id),
    );

  const viewOf = (row: TemplateRow) =>
    Effect.map(attached(row.workspaceId, row.id), (schedule) => templateView(row, schedule));

  /** Bumps the Template's revision for a schedule change it covers. */
  const touch = (row: TemplateRow) =>
    Effect.flatMap(nowIso, (at) => repo.updateTemplate({ ...row, updatedAt: at }, row.revision));

  const audit = (
    row: TemplateRow,
    action: string,
    changes: ReadonlyArray<{
      readonly path: string;
      readonly before: unknown;
      readonly after: unknown;
    }>,
  ) =>
    appendAudit({
      workspaceId: row.workspaceId,
      subject: { entity: "Template", id: row.id },
      action,
      revision: row.revision,
      changes,
    });

  const save: TemplatesImpl["save"] = (input, opts) =>
    Effect.gen(function* () {
      const { workspaceId } = yield* authorizeInWorkspace("template.write");
      const { id, expectedRevision, ...fields } = input;
      return yield* withIdempotency(
        {
          scope: { _tag: "Workspace", workspaceId },
          key: opts?.requestKey,
          method: "Templates.save",
          payload: { schema: SavePayload as Schema.Codec<typeof input, unknown>, value: input },
          result: TemplateViewCodec,
        },
        Effect.gen(function* () {
          const at = yield* nowIso;
          if (id === undefined) {
            const valid = yield* Effect.fromResult(validateInput(fields));
            const row = yield* repo.insertTemplate({
              id: yield* newId<TemplateId>(),
              workspaceId,
              revision: 1,
              name: valid.name,
              input: valid,
              archivedAt: null,
              createdAt: at,
              updatedAt: at,
            });
            yield* audit(row, "template.create", inputChanges(null, row.input));
            return templateView(row, null);
          }
          if (expectedRevision === undefined) {
            return yield* malformed(["expectedRevision"], "required");
          }
          const current = yield* repo.lockTemplate(workspaceId, id, expectedRevision);
          if (current.archivedAt !== null) return yield* illegal();
          const valid = yield* Effect.fromResult(validateInput(fields));
          const row = yield* repo.updateTemplate(
            { ...current, name: valid.name, input: valid, updatedAt: at },
            current.revision,
          );
          yield* audit(row, "template.save", inputChanges(current.input, row.input));
          return yield* viewOf(row);
        }),
      );
    }).pipe(provide, dieOnUnique, orUnavailable) as ReturnType<TemplatesImpl["save"]>;

  const detach = (schedule: ScheduleRow) =>
    Effect.flatMap(nowIso, (at) =>
      repo.updateSchedule({ ...schedule, detachedAt: at }, schedule.revision),
    );

  const archive: TemplatesImpl["archive"] = (id) =>
    Effect.gen(function* () {
      const { workspaceId } = yield* authorizeInWorkspace("template.write");
      yield* store.transaction(
        Effect.gen(function* () {
          const current = yield* repo.lockTemplateState(workspaceId, id);
          if (current.archivedAt !== null) return;
          const schedule = yield* attachedLocked(workspaceId, id);
          if (schedule !== null) yield* detach(schedule);
          const at = yield* nowIso;
          const row = yield* repo.updateTemplate(
            { ...current, archivedAt: at, updatedAt: at },
            current.revision,
          );
          yield* audit(row, "template.archive", [{ path: "archived", before: false, after: true }]);
        }),
      );
    }).pipe(provide, dieOnUnique, orUnavailable) as ReturnType<TemplatesImpl["archive"]>;

  const schedule: TemplatesImpl["schedule"] = (templateId, input, expectedRevision) =>
    Effect.gen(function* () {
      const { workspaceId } = yield* authorizeInWorkspace("schedule.write");
      const valid = input === null ? null : yield* Effect.fromResult(validateSchedule(input));
      return yield* store.transaction(
        Effect.gen(function* () {
          const current = yield* repo.lockTemplate(workspaceId, templateId, expectedRevision);
          if (current.archivedAt !== null) return yield* illegal();
          const before = yield* attachedLocked(workspaceId, templateId);
          if (valid === null) {
            if (before === null) return templateView(current, null);
            yield* detach(before);
            const row = yield* touch(current);
            yield* audit(row, "template.schedule", [
              { path: "schedule", before: scheduleView(before), after: null },
            ]);
            return templateView(row, null);
          }
          const day = yield* today;
          const rule = {
            every: { [valid.unit]: valid.interval } as TemplateSchedule["every"],
            startOn: valid.startOn,
            ...(valid.endOn !== null ? { endOn: valid.endOn } : {}),
          };
          const fields = {
            cadenceUnit: valid.unit,
            cadenceInterval: valid.interval,
            startOn: valid.startOn,
            endOn: valid.endOn,
            issueAs: valid.issueAs,
            autoSend: valid.autoSend,
          };
          let next: ScheduleRow;
          if (before === null) {
            next = yield* repo.insertSchedule({
              id: yield* newId<ScheduleId>(),
              workspaceId,
              revision: 1,
              templateId,
              ...fields,
              nextOccurrence: startingOccurrence(rule, day, null),
              pausedAt: null,
              pausedReason: null,
              pausedError: null,
              catchUpThrough: null,
              detachedAt: null,
              createdAt: yield* nowIso,
            });
          } else {
            // Changes affect future occurrences only: never one the schedule already issued.
            const last = yield* repo.lastIssuedRun(workspaceId, before.id);
            next = yield* repo.updateSchedule(
              {
                ...before,
                ...fields,
                nextOccurrence: startingOccurrence(
                  rule,
                  day,
                  Option.match(last, { onNone: () => null, onSome: (run) => run.occurrence }),
                ),
              },
              before.revision,
            );
          }
          const row = yield* touch(current);
          yield* audit(row, "template.schedule", [
            {
              path: "schedule",
              before: before === null ? null : scheduleView(before),
              after: scheduleView(next),
            },
          ]);
          return templateView(row, next);
        }),
      );
    }).pipe(provide, dieOnUnique, orUnavailable) as ReturnType<TemplatesImpl["schedule"]>;

  const resume: TemplatesImpl["resume"] = (templateId) =>
    Effect.gen(function* () {
      const { workspaceId } = yield* authorizeInWorkspace("schedule.write");
      return yield* store.transaction(
        Effect.gen(function* () {
          const current = yield* repo.lockTemplateState(workspaceId, templateId);
          const before = yield* attachedLocked(workspaceId, templateId);
          if (current.archivedAt !== null || before === null) return yield* illegal();
          // Idempotent by state (C6): resuming a running schedule changes nothing.
          if (before.pausedAt === null) return templateView(current, before);
          const next = yield* repo.updateSchedule(
            {
              ...before,
              pausedAt: null,
              pausedReason: null,
              pausedError: null,
              // The missed occurrences up to today issue on the following sweeps.
              catchUpThrough: yield* today,
            },
            before.revision,
          );
          const row = yield* touch(current);
          yield* audit(row, "template.resume", [
            { path: "schedule.pausedReason", before: before.pausedReason, after: null },
          ]);
          return templateView(row, next);
        }),
      );
    }).pipe(provide, dieOnUnique, orUnavailable) as ReturnType<TemplatesImpl["resume"]>;

  const use: TemplatesImpl["use"] = (templateId, input, opts) =>
    Effect.gen(function* () {
      const { caller, workspaceId } = yield* authorizeInWorkspace("template.read");
      const as = input?.as ?? "draft";
      const action: Action = as === "issued" ? "document.issue" : "document.draft";
      // R1a: both permissions before any read or replay.
      yield* authorizeInWorkspace(action);
      // Manual use only: a System caller issues through its RecurringIssuance job (R4, R5).
      if (caller._tag !== "Member") return yield* new Forbidden({ action });
      const payload = {
        template: templateId,
        as,
        ...(input?.patch !== undefined ? { patch: input.patch } : {}),
      };
      // The request key is Templates': a retry with another template or patch is a mismatch.
      // Documents runs nested in this transaction, without a key of its own.
      return yield* withIdempotency(
        {
          scope: { _tag: "Workspace", workspaceId },
          key: opts?.requestKey,
          method: "Templates.use",
          payload: { schema: UsePayload as Schema.Codec<typeof payload, unknown>, value: payload },
          result: DocumentViewSchema as unknown as Schema.Codec<DocumentView, unknown>,
        },
        Effect.gen(function* () {
          const row = yield* repo.getTemplate(workspaceId, templateId);
          if (row.archivedAt !== null) return yield* illegal();
          const document = yield* Effect.fromResult(
            applyPatch(documentInputOf(row.input), input?.patch),
          );
          return as === "issued"
            ? yield* documents.issue({ input: document })
            : yield* documents.createDraft(document);
        }),
      );
    }).pipe(provide, dieOnUnique, orUnavailable) as ReturnType<TemplatesImpl["use"]>;

  const get: TemplatesImpl["get"] = (id) =>
    Effect.gen(function* () {
      const { workspaceId } = yield* authorizeInWorkspace("template.read");
      return yield* store.transaction(Effect.flatMap(repo.getTemplate(workspaceId, id), viewOf));
    }).pipe(provide, dieOnUnique, orUnavailable) as ReturnType<TemplatesImpl["get"]>;

  const list: TemplatesImpl["list"] = Effect.gen(function* () {
    const { workspaceId } = yield* authorizeInWorkspace("template.read");
    return yield* store.transaction(
      Effect.flatMap(repo.listTemplates(workspaceId), (rows) => Effect.forEach(rows, viewOf)),
    );
  }).pipe(provide, dieOnUnique, orUnavailable) as TemplatesImpl["list"];

  const runs: TemplatesImpl["runs"] = (templateId, page) =>
    Effect.gen(function* () {
      const { workspaceId } = yield* authorizeInWorkspace("template.read");
      const limit = page?.limit ?? DEFAULT_PAGE;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return yield* malformed(["limit"], "range");
      }
      const cursor = page?.cursor === undefined ? null : decodeCursor(page.cursor, templateId);
      if (page?.cursor !== undefined && cursor === null) {
        return yield* new Invalid({ issues: [{ path: ["cursor"], code: "page.cursor_mismatch" }] });
      }
      return yield* store.transaction(
        Effect.gen(function* () {
          yield* repo.getTemplate(workspaceId, templateId);
          const schedules = yield* repo.schedulesOfTemplate(workspaceId, templateId);
          const rows = yield* repo.listRuns(workspaceId, {
            scheduleIds: schedules.map((s) => s.id),
            ...(cursor !== null ? { after: [cursor.occurrence, cursor.id] as const } : {}),
            limit: limit + 1,
          });
          const items = rows.slice(0, limit);
          const statuses = yield* deliveries.statuses(
            workspaceId,
            items.flatMap((run) => (run.deliveryId === null ? [] : [run.deliveryId])),
          );
          const last = items.at(-1);
          return {
            items: items.map((run) => runView(run, statuses)),
            nextCursor:
              rows.length > limit && last !== undefined
                ? encodeCursor({ template: templateId, occurrence: last.occurrence, id: last.id })
                : null,
          };
        }),
      );
    }).pipe(provide, dieOnUnique, orUnavailable) as ReturnType<TemplatesImpl["runs"]>;

  return { save, archive, schedule, resume, use, get, list, runs } satisfies TemplatesImpl;
});

/**
 * `Templates` on `RecurringRepo`. Needs CoreStore | IdGenerator | RecurringRepo |
 * DeliveryStatusLookup | Documents (the domain tag, for `use`).
 */
export const TemplatesLive: Layer.Layer<
  Templates,
  never,
  CoreStore | IdGenerator | RecurringRepo | DeliveryStatusLookup | Documents
> = Layer.effect(
  Templates,
  // The one cast (board #340/#341): the domain tag omits `Unavailable` from most signatures.
  Effect.map(makeTemplates, (impl) => Templates.of(impl as unknown as Templates["Service"])),
);
