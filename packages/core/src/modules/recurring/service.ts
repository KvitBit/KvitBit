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
  Caller,
  DocumentInput,
  DocumentPatch,
  NotFound,
  Page,
  PageRequest,
  RecurringRunView,
  RequestOptions,
  TemplateId,
  TemplateInput,
  TemplateSchedule,
  TemplateView,
  Unavailable,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import {
  Conflict,
  DocumentPatch as DocumentPatchSchema,
  Documents,
  DocumentView,
  Forbidden,
  Invalid,
  IsoDate,
  ScheduleId,
  TemplateId as TemplateIdSchema,
  TemplateInput as TemplateInputSchema,
  Templates,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as EffectRecord from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as EffectString from "effect/String";
import * as Struct from "effect/Struct";
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
import { runView, scheduleView, TemplateViewSchema, templateView } from "./view";

/** Default and maximum page sizes of `runs` (PageRequest). */
const DEFAULT_PAGE = 50;

type CoreFailure = Invalid | Conflict | Forbidden | Unavailable;

/**
 * The implementation's honest error types: every method can also fail with `Unavailable`
 * (a port failure), as the domain tag declares.
 */
export interface TemplatesImpl {
  readonly save: (
    caller: Caller,
    input: TemplateInput & { readonly id?: TemplateId; readonly expectedRevision?: number },
    opts?: RequestOptions,
  ) => Effect.Effect<TemplateView, CoreFailure | NotFound>;
  readonly archive: (
    caller: Caller,
    id: TemplateId,
  ) => Effect.Effect<void, NotFound | Forbidden | Unavailable>;
  readonly schedule: (
    caller: Caller,
    template: TemplateId,
    schedule: TemplateSchedule | null,
    expectedRevision: number,
  ) => Effect.Effect<TemplateView, CoreFailure | NotFound>;
  readonly resume: (
    caller: Caller,
    template: TemplateId,
  ) => Effect.Effect<TemplateView, NotFound | Conflict | Forbidden | Unavailable>;
  readonly use: (
    caller: Caller,
    template: TemplateId,
    input?: { readonly as?: "draft" | "issued"; readonly patch?: DocumentPatch },
    opts?: RequestOptions,
  ) => Effect.Effect<DocumentView, CoreFailure | NotFound>;
  readonly get: (
    caller: Caller,
    id: TemplateId,
  ) => Effect.Effect<TemplateView, NotFound | Forbidden | Unavailable>;
  readonly list: (
    caller: Caller,
  ) => Effect.Effect<ReadonlyArray<TemplateView>, Forbidden | Unavailable>;
  readonly runs: (
    caller: Caller,
    template: TemplateId,
    page?: PageRequest,
  ) => Effect.Effect<Page<RecurringRunView>, Invalid | NotFound | Forbidden | Unavailable>;
}

/**
 * Interim code for a blank Template name: no domain IssueCode names it yet and packages/domain is
 * read-only for core streams (board #430, same as numbering). Used for that case only.
 */
const malformed = (path: ReadonlyArray<string>, reason: string) =>
  Invalid.make({ issues: [{ path: [...path], code: "request.malformed", params: { reason } }] });

const illegal = () => Conflict.make({ reason: "illegal_transition" });

const UsePayload = Schema.Struct({
  template: TemplateIdSchema,
  as: Schema.Literals(["draft", "issued"]),
  patch: Schema.optional(DocumentPatchSchema),
});

/**
 * The request-log result of `use` (C3: a replay returns the original result). DocumentView
 * carries BigDecimal values the domain schema cannot JSON-encode, so the view is stored as JSON
 * with each BigDecimal tagged by its exact (value, scale) and restored on replay.
 */
const ViewSnapshot = Schema.Struct({ json: Schema.String });
const DECIMAL = "$kvitbit.decimal";
const tagDecimals = <A>(value: A): unknown => {
  if (BigDecimal.isBigDecimal(value)) return { [DECIMAL]: [value.value.toString(), value.scale] };
  if (EffectArray.isArray(value)) return EffectArray.map(value, tagDecimals);
  if (Predicate.isObject(value)) {
    return EffectRecord.fromEntries(
      EffectArray.map(EffectRecord.toEntries(value), ([k, v]) => [k, tagDecimals(v)]),
    );
  }
  return value;
};
const Json = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeEffect(Json);
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));
const DecimalSnapshot = Schema.Tuple([Schema.BigIntFromString, Schema.Int]);
const decodeDecimal = Schema.decodeUnknownEffect(DecimalSnapshot);

const isJsonArray = (value: Schema.Json): value is Schema.JsonArray => EffectArray.isArray(value);

const isJsonObject = (value: Exclude<Schema.Json, Schema.JsonArray>): value is Schema.JsonObject =>
  Predicate.isObject(value);

const restoreDecimals = Effect.fnUntraced(function* (
  value: Schema.Json,
): Effect.fn.Return<unknown, Schema.SchemaError> {
  if (isJsonArray(value)) {
    return yield* Effect.forEach(value, restoreDecimals, { concurrency: 1 });
  }
  if (isJsonObject(value)) {
    if (DECIMAL in value) {
      const [digits, scale] = yield* decodeDecimal(value[DECIMAL]);
      return BigDecimal.make(digits, scale);
    }
    const fields = yield* Effect.forEach(
      EffectRecord.toEntries<string, Schema.Json>(value),
      ([key, input]) => restoreDecimals(input).pipe(Effect.map((item) => [key, item] as const)),
      { concurrency: 1 },
    );
    return EffectRecord.fromEntries(fields);
  }
  return value;
});

// Refine the restored value in place so persisted view fields survive decoding.
const RestoredView = Schema.Unknown.pipe(Schema.refine(Schema.is(Schema.toType(DocumentView))));

const restoreSnapshot = (json: string) =>
  decodeJson(json).pipe(
    Effect.flatMap(restoreDecimals),
    Effect.flatMap(Schema.decodeUnknownEffect(RestoredView)),
    Effect.orDie,
  );

const SavePayload = Schema.Struct({
  ...TemplateInputSchema.fields,
  id: Schema.optional(TemplateIdSchema),
  expectedRevision: Schema.optional(Schema.Int),
});

const encodeInput = Schema.encodeEffect(Schema.toCodecJson(TemplateInputSchema));
const InputFields = Schema.Record(Schema.String, Schema.Unknown);
const decodeInputFields = Schema.decodeUnknownEffect(InputFields);

/** Field-level audit changes between two saved inputs (encoded, so decimals compare by value). */
const inputChanges = Effect.fn("Templates.inputChanges")(function* (
  before: TemplateInput | null,
  after: TemplateInput,
) {
  const a =
    before === null ? {} : yield* encodeInput(before).pipe(Effect.flatMap(decodeInputFields));
  const b = yield* encodeInput(after).pipe(Effect.flatMap(decodeInputFields));
  const keys = [...new Set([...EffectRecord.keys(a), ...EffectRecord.keys(b)])].sort(
    (left, right) => (left < right ? -1 : left > right ? 1 : 0),
  );
  const changes = yield* Effect.forEach(
    keys,
    Effect.fnUntraced(function* (key) {
      const previous = a[key];
      const next = b[key];
      const previousJson = previous === undefined ? undefined : yield* encodeJson(previous);
      const nextJson = next === undefined ? undefined : yield* encodeJson(next);
      return previousJson === nextJson
        ? Option.none()
        : Option.some({ path: key, before: previous ?? null, after: next ?? null });
    }),
    { concurrency: 1 },
  );
  return EffectArray.getSomes(changes);
}, Effect.orDie);

/** Stateless input rules of `save`. */
const validateInput = (input: TemplateInput): Result.Result<TemplateInput, Invalid> => {
  if (EffectString.trim(input.name).length === 0) return Result.fail(malformed(["name"], "empty"));
  if (input.due !== undefined && input.due.inDays < 0) {
    return Result.fail(
      Invalid.make({ issues: [{ path: ["due", "inDays"], code: "document.due_before_issue" }] }),
    );
  }
  return Result.succeed({ ...input, name: EffectString.trim(input.name) });
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
  const cadence = (value: TemplateSchedule["every"]) => {
    if (!Predicate.isObject(value)) return null;
    const record: Readonly<Record<string, number>> = value;
    const keys = EffectRecord.keys(record);
    if (keys.length !== 1) return null;
    if ("weeks" in value) {
      return { unit: "weeks" as const, interval: value.weeks };
    }
    if ("months" in value) {
      return { unit: "months" as const, interval: value.months };
    }
    if ("years" in value) {
      return { unit: "years" as const, interval: value.years };
    }
    return null;
  };
  const invalid = (path: ReadonlyArray<string>, reason: string) =>
    Result.fail(
      Invalid.make({
        issues: [{ path: [...path], code: "schedule.cadence_invalid", params: { reason } }],
      }),
    );
  const every = cadence(input.every);
  if (every === null) return invalid(["every"], "unit");
  if (input.issueAs !== "invoice" && input.issueAs !== "proforma") {
    return invalid(["issueAs"], "kind");
  }
  if (!Predicate.isBoolean(input.autoSend)) return invalid(["autoSend"], "type");
  const rule = {
    every: input.every,
    startOn: input.startOn,
    endOn: input.endOn,
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
  return { ...rest, due };
};

/** `use`: template values as defaults, the patch on top. */
const applyPatch = (
  base: DocumentInput,
  patch: DocumentPatch | undefined,
): Result.Result<DocumentInput, Conflict> => {
  if (patch === undefined) return Result.succeed(base);
  if (patch.number !== undefined)
    // A number override exists only for an issued document (rule D4), not at creation.
    return Result.fail(illegal());
  if (patch.refreshParties !== undefined) {
    // A new document snapshots the parties anyway; refreshing is an edit of an existing one.
    return Result.fail(illegal());
  }
  const selected: Readonly<Record<string, DocumentPatch[(typeof PATCH_FIELDS)[number]]>> =
    Struct.pick(patch, PATCH_FIELDS);
  const definedFields = EffectRecord.filter(selected, (value) => value !== undefined);
  const { fx: originalFx, ...original } = base;
  const fx = patch.fx === undefined ? originalFx : patch.fx;
  return Result.succeed({
    ...original,
    ...definedFields,
    fx: fx ?? undefined,
  });
};

const CursorJson = Schema.fromJsonString(Schema.Tuple([Schema.String, IsoDate, Schema.String]));
const encodeCursorJson = Schema.encodeEffect(CursorJson);
const decodeCursorJson = Schema.decodeEffect(CursorJson);
const encodeCursor = (template: TemplateId, occurrence: IsoDate, id: string) =>
  encodeCursorJson([template, occurrence, id]).pipe(
    Effect.map((value) => Buffer.from(value).toString("base64url")),
    Effect.orDie,
  );

const decodeCursor = (raw: string) =>
  decodeCursorJson(Buffer.from(raw, "base64url").toString("utf8")).pipe(Effect.option);

export const makeTemplates = Effect.gen(function* () {
  const store = yield* CoreStore;
  const ids = yield* IdGenerator;
  const repo = yield* RecurringRepo;
  const deliveries = yield* DeliveryStatusLookup;
  const documents = yield* Documents;
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(CoreStore, store), Effect.provideService(IdGenerator, ids));

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
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

  /** The latest occurrence any schedule of the Template (detached ones too) issued. */
  const lastIssuedOfTemplate = Effect.fn("lastIssuedOfTemplate")(function* (
    workspaceId: WorkspaceId,
    templateId: TemplateId,
  ) {
    const schedules = yield* repo.schedulesOfTemplate(workspaceId, templateId);
    let last: IsoDate | null = null;
    for (const s of schedules) {
      const run = yield* repo.lastIssuedRun(workspaceId, s.id);
      if (Option.isSome(run) && (last === null || run.value.occurrence > last)) {
        last = run.value.occurrence;
      }
    }
    return last;
  });

  const viewOf = (row: TemplateRow) =>
    Effect.map(attached(row.workspaceId, row.id), (attachedSchedule) =>
      templateView(row, attachedSchedule),
    );

  /** Bumps the Template's revision for a schedule change it covers. */
  const touch = (row: TemplateRow) =>
    Effect.flatMap(nowIso, (at) => repo.updateTemplate({ ...row, updatedAt: at }, row.revision));

  const audit = (
    caller: Caller,
    row: TemplateRow,
    action: string,
    changes: ReadonlyArray<{
      readonly path: string;
      readonly before: unknown;
      readonly after: unknown;
    }>,
  ) =>
    appendAudit(caller, {
      workspaceId: row.workspaceId,
      subject: { entity: "Template", id: row.id },
      action,
      revision: row.revision,
      changes,
    });

  const save: TemplatesImpl["save"] = Effect.fn("save")(
    function* (caller: Caller, input, opts) {
      const { workspaceId } = yield* authorizeInWorkspace(caller, "template.write");
      const { id, expectedRevision, ...fields } = input;
      return yield* withIdempotency(
        {
          scope: { _tag: "Workspace", workspaceId },
          key: opts?.requestKey,
          method: "Templates.save",
          payload: { schema: SavePayload, value: input },
          result: TemplateViewSchema,
        },
        Effect.gen(function* () {
          const at = yield* nowIso;
          if (id === undefined) {
            const valid = yield* Effect.fromResult(validateInput(fields));
            const row = yield* repo.insertTemplate({
              id: yield* newId(TemplateIdSchema.make),
              workspaceId,
              revision: 1,
              name: valid.name,
              input: valid,
              archivedAt: null,
              createdAt: at,
              updatedAt: at,
            });
            const changes = yield* inputChanges(null, row.input);
            yield* audit(caller, row, "template.create", changes);
            return templateView(row, null);
          }
          // An update without expectedRevision cannot be checked (C2): report the current
          // revision as a revision conflict so the caller refetches and retries.
          if (expectedRevision === undefined) {
            const locked = yield* repo.lockTemplateState(workspaceId, id);
            return yield* Conflict.make({
              reason: "revision_changed",
              currentRevision: locked.revision,
            });
          }
          const current = yield* repo.lockTemplate(workspaceId, id, expectedRevision);
          if (current.archivedAt !== null) return yield* illegal();
          const valid = yield* Effect.fromResult(validateInput(fields));
          const row = yield* repo.updateTemplate(
            { ...current, name: valid.name, input: valid, updatedAt: at },
            current.revision,
          );
          const changes = yield* inputChanges(current.input, row.input);
          yield* audit(caller, row, "template.save", changes);
          return yield* viewOf(row);
        }),
      );
    },
    provide,
    dieOnUnique,
    orUnavailable,
  );

  const detach = (row: ScheduleRow) =>
    Effect.flatMap(nowIso, (at) => repo.updateSchedule({ ...row, detachedAt: at }, row.revision));

  const archive: TemplatesImpl["archive"] = Effect.fn("archive")(
    function* (caller: Caller, id) {
      const { workspaceId } = yield* authorizeInWorkspace(caller, "template.write");
      yield* store.transaction(
        Effect.gen(function* () {
          const current = yield* repo.lockTemplateState(workspaceId, id);
          if (current.archivedAt !== null) return;
          const attachedSchedule = yield* attachedLocked(workspaceId, id);
          if (attachedSchedule !== null) yield* detach(attachedSchedule);
          const at = yield* nowIso;
          const row = yield* repo.updateTemplate(
            { ...current, archivedAt: at, updatedAt: at },
            current.revision,
          );
          yield* audit(caller, row, "template.archive", [
            { path: "archived", before: false, after: true },
          ]);
        }).pipe(
          // The Template and any attached Schedule stay locked until commit.
          Effect.catchTag("Conflict", Effect.die),
        ),
      );
    },
    provide,
    dieOnUnique,
    orUnavailable,
  );

  const schedule: TemplatesImpl["schedule"] = Effect.fn("schedule")(
    function* (caller: Caller, templateId, input, expectedRevision) {
      const { workspaceId } = yield* authorizeInWorkspace(caller, "schedule.write");
      return yield* store.transaction(
        Effect.gen(function* () {
          // Lock and revision check first (C2): a stale or foreign call never sees Invalid.
          const current = yield* repo.lockTemplate(workspaceId, templateId, expectedRevision);
          if (current.archivedAt !== null) return yield* illegal();
          const valid = input === null ? null : yield* Effect.fromResult(validateSchedule(input));
          const before = yield* attachedLocked(workspaceId, templateId);
          if (valid === null) {
            if (before === null) return templateView(current, null);
            yield* detach(before);
            const row = yield* touch(current);
            yield* audit(caller, row, "template.schedule", [
              { path: "schedule", before: scheduleView(before), after: null },
            ]);
            return templateView(row, null);
          }
          const day = yield* today;
          const rule = {
            every:
              valid.unit === "weeks"
                ? { weeks: valid.interval }
                : valid.unit === "months"
                  ? { months: valid.interval }
                  : { years: valid.interval },
            startOn: valid.startOn,
            endOn: valid.endOn ?? undefined,
          };
          const fields = {
            cadenceUnit: valid.unit,
            cadenceInterval: valid.interval,
            startOn: valid.startOn,
            endOn: valid.endOn,
            issueAs: valid.issueAs,
            autoSend: valid.autoSend,
          };
          // Never an occurrence any schedule of this Template already issued, so detaching and
          // reattaching cannot bill a date twice.
          const lastIssued = yield* lastIssuedOfTemplate(workspaceId, templateId);
          let next: ScheduleRow;
          if (before === null) {
            next = yield* repo.insertSchedule({
              id: yield* newId(ScheduleId.make),
              workspaceId,
              revision: 1,
              templateId,
              ...fields,
              nextOccurrence: startingOccurrence(rule, day, lastIssued),
              pausedAt: null,
              pausedReason: null,
              pausedError: null,
              catchUpThrough: null,
              detachedAt: null,
              createdAt: yield* nowIso,
            });
          } else {
            // Changes affect future occurrences only. An occurrence already due and not yet
            // processed stays next, so an edit never erases it; the new rule applies after it.
            // A cadence change otherwise restarts after the last issued occurrence.
            if (before.nextOccurrence !== null && before.nextOccurrence <= day) {
              // An occurrence is due and not processed yet (or the schedule paused on it).
              // Changing the rule or settings now would issue or skip it under the new ones,
              // so the edit waits: resume and let it issue, or detach and reattach.
              return yield* illegal();
            }
            const sameCadence =
              before.cadenceUnit === fields.cadenceUnit &&
              before.cadenceInterval === fields.cadenceInterval &&
              before.startOn === fields.startOn &&
              before.endOn === fields.endOn;
            const outstanding = before.nextOccurrence !== null && before.nextOccurrence <= day;
            next = yield* repo.updateSchedule(
              {
                ...before,
                ...fields,
                nextOccurrence:
                  sameCadence || outstanding
                    ? before.nextOccurrence
                    : startingOccurrence(rule, day, lastIssued),
              },
              before.revision,
            );
          }
          const row = yield* touch(current);
          yield* audit(caller, row, "template.schedule", [
            {
              path: "schedule",
              before: before === null ? null : scheduleView(before),
              after: scheduleView(next),
            },
          ]);
          return templateView(row, next);
        }),
      );
    },
    provide,
    dieOnUnique,
    orUnavailable,
  );

  const resume: TemplatesImpl["resume"] = Effect.fn("resume")(
    function* (caller: Caller, templateId) {
      const { workspaceId } = yield* authorizeInWorkspace(caller, "schedule.write");
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
          yield* audit(caller, row, "template.resume", [
            { path: "schedule.pausedReason", before: before.pausedReason, after: null },
          ]);
          return templateView(row, next);
        }),
      );
    },
    provide,
    dieOnUnique,
    orUnavailable,
  );

  const use: TemplatesImpl["use"] = Effect.fn("use")(
    function* (caller: Caller, templateId, input, opts) {
      const { caller: workspaceCaller, workspaceId } = yield* authorizeInWorkspace(
        caller,
        "template.read",
      );
      const as = input?.as ?? "draft";
      const action: Action = as === "issued" ? "document.issue" : "document.draft";
      // R1a: both permissions before any read or replay.
      yield* authorizeInWorkspace(workspaceCaller, action);
      // Manual use only: a System caller issues through its RecurringIssuance job (R4, R5).
      if (workspaceCaller._tag !== "Member") return yield* Forbidden.make({ action });
      const target = { template: templateId, as };
      const payload = input?.patch === undefined ? target : { ...target, patch: input.patch };
      // The request key is Templates': a retry with another template or patch is a mismatch.
      // Documents runs nested in this transaction, without a key of its own. The request log
      // stores a clean snapshot of the created document (no share URL, no delivery history; the
      // document is fresh and unsent, so nothing is lost), and a replay returns that snapshot.
      const created = yield* withIdempotency(
        {
          scope: { _tag: "Workspace", workspaceId },
          key: opts?.requestKey,
          method: "Templates.use",
          payload: { schema: UsePayload, value: payload },
          result: ViewSnapshot,
        },
        Effect.gen(function* () {
          const row = yield* repo.getTemplate(workspaceId, templateId);
          if (row.archivedAt !== null) return yield* illegal();
          const document = yield* Effect.fromResult(
            applyPatch(documentInputOf(row.input), input?.patch),
          );
          const view =
            as === "issued"
              ? yield* documents.issue(caller, { input: document })
              : yield* documents.createDraft(caller, document);
          // Never the owner-facing share URL or delivery history (core-ports.md 66-68).
          const json = yield* encodeJson(
            tagDecimals({ ...view, share: null, deliveries: [] }),
          ).pipe(Effect.orDie);
          return { json };
        }),
      );
      return yield* restoreSnapshot(created.json);
    },
    provide,
    dieOnUnique,
    orUnavailable,
  );

  const get: TemplatesImpl["get"] = Effect.fn("get")(
    function* (caller: Caller, id) {
      const { workspaceId } = yield* authorizeInWorkspace(caller, "template.read");
      return yield* store.transaction(Effect.flatMap(repo.getTemplate(workspaceId, id), viewOf));
    },
    provide,
    dieOnUnique,
    orUnavailable,
  );

  const list: TemplatesImpl["list"] = Effect.fn("list")(
    function* (caller) {
      const { workspaceId } = yield* authorizeInWorkspace(caller, "template.read");
      return yield* store.transaction(
        Effect.flatMap(repo.listTemplates(workspaceId), (rows) =>
          Effect.forEach(rows, viewOf, { concurrency: 1 }),
        ),
      );
    },
    provide,
    dieOnUnique,
    orUnavailable,
  );

  const runs: TemplatesImpl["runs"] = Effect.fn("runs")(
    function* (caller: Caller, templateId, page) {
      const { workspaceId } = yield* authorizeInWorkspace(caller, "template.read");
      const limit = page?.limit ?? DEFAULT_PAGE;
      // PageRequest bounds are enforced where the request is decoded; clamp defensively here.
      const size = Math.min(100, Math.max(1, Math.trunc(limit)));
      const cursor = page?.cursor === undefined ? Option.none() : yield* decodeCursor(page.cursor);
      if (page?.cursor !== undefined && (Option.isNone(cursor) || cursor.value[0] !== templateId)) {
        return yield* Invalid.make({
          issues: [{ path: ["cursor"], code: "page.cursor_mismatch" }],
        });
      }
      return yield* store.transaction(
        Effect.gen(function* () {
          yield* repo.getTemplate(workspaceId, templateId);
          const schedules = yield* repo.schedulesOfTemplate(workspaceId, templateId);
          const query = {
            scheduleIds: EffectArray.map(schedules, (s) => s.id),
            limit: size + 1,
          };
          const rows = yield* repo.listRuns(
            workspaceId,
            Option.isSome(cursor) ? { ...query, after: [cursor.value[1], cursor.value[2]] } : query,
          );
          const items = rows.slice(0, size);
          const statuses = yield* deliveries.statuses(
            workspaceId,
            EffectArray.flatMap(items, (run) => (run.deliveryId === null ? [] : [run.deliveryId])),
          );
          const last = items.at(-1);
          return {
            items: EffectArray.map(items, (run) => runView(run, statuses)),
            nextCursor:
              rows.length > size && last !== undefined
                ? yield* encodeCursor(templateId, last.occurrence, last.id)
                : null,
          };
        }),
      );
    },
    provide,
    dieOnUnique,
    orUnavailable,
  );

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
> = Layer.effect(Templates, makeTemplates);
