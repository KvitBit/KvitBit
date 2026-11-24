/**
 * Lifecycle methods (P2): issue, edit of an issued document (incl. the number override),
 * lock, unlock and cancel. Each follows the method shape of src/index.ts; the state checks
 * come from the transition table (transitions.ts).
 */
import type {
  DocumentId,
  DocumentPatch,
  DocumentView,
  IsoDate,
  RequestOptions,
  SendOptions,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import {
  Conflict,
  DeliveryPurpose,
  DocumentId as DocumentIdSchema,
  DocumentInput,
  Invalid,
  IsoDate as IsoDateSchema,
  Locale,
} from "@kvitbit/domain/contract";
import { Effect, Schema } from "effect";
import { authorizeInWorkspace } from "../../policy/Policy";
import { appendAudit } from "../../shared/audit";
import { orUnavailable } from "../../shared/errors";
import { withIdempotency } from "../../shared/idempotency";
import { newId } from "../../shared/ids";
import { CoreStore } from "../../store/CoreStore";
import { NumberingSeries } from "../numbering";
import type { Composed } from "./compose";
import { applyPatch, compose, specFromInput, specFromRecord } from "./compose";
import { digitsOf, issueCreditNote, remainderSpec } from "./credit";
import type { DocumentRecord, GivenFields } from "./record";
import { DocumentRecord as DocumentRecordSchema } from "./record";
import { DocumentsRepo } from "./repo";
import { DocumentSender } from "./sender";
import { newDraftRecord, now, viewOf } from "./support";
import { guard, hasDependents, hasFinalInvoice, paymentsBlockCancel } from "./transitions";
import { DocumentViewCodec } from "./view";

const illegal = () => new Conflict({ reason: "illegal_transition" });

const required = (path: string) =>
  new Invalid({
    issues: [{ path: [path], code: "request.malformed", params: { reason: "required" } }],
  });

/** A required free-text reason (unlock, cancel), trimmed. */
const reasonOf = (reason: string) => {
  const trimmed = reason.trim();
  return trimmed === "" ? Effect.fail(required("reason")) : Effect.succeed(trimmed);
};

// Issue -------------------------------------------------------------------------------------

const daysBetween = (from: IsoDate, to: IsoDate) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Pins the defaults the draft left floating (today, Contact and Workspace defaults) as the
 * document's own values, so later edits recompute from what was issued (rule D10 freezes the
 * parties; this freezes the defaults). The due date stays relative to `issuedOn` when it was
 * a default. The bank account is kept through the frozen issuer snapshot instead.
 */
const pinDefaults = (c: Composed): GivenFields => ({
  ...c.given,
  currency: c.currency,
  issuedOn: c.issuedOn,
  ...(c.taxableSupplyOn === null ? {} : { taxableSupplyOn: c.taxableSupplyOn }),
  due: c.given.due ?? { inDays: daysBetween(c.issuedOn, c.dueOn) },
  language: c.language,
  ...(c.seriesId === null ? {} : { series: c.seriesId }),
  ...(c.note === null ? {} : { note: c.note }),
  paymentMethod: c.paymentMethod,
});

/**
 * Numbers a composed document (rules D1, S3, S4: after the caller's row lock): the series the
 * document resolved (else the kind's default). Exhaustion is
 * `Conflict{illegal_transition, numbering.pattern_invalid}` and rolls the issue back.
 */
const numbered = (workspaceId: WorkspaceId, documentId: DocumentId, composed: Composed) =>
  Effect.gen(function* () {
    const numbering = yield* NumberingSeries;
    const series = yield* numbering.resolve(
      workspaceId,
      composed.kind,
      composed.seriesId ?? undefined,
    );
    const allocation = yield* numbering.allocate({
      workspaceId,
      kind: composed.kind,
      seriesId: series.id,
      documentId,
      issuedOn: composed.issuedOn,
    });
    const given = { ...pinDefaults(composed), series: allocation.seriesId };
    return {
      ...composed,
      given,
      seriesId: allocation.seriesId,
      number: allocation.number,
      variableSymbol: given.variableSymbol ?? digitsOf(allocation.number),
    };
  });

const SendOptionsSchema = Schema.Struct({
  to: Schema.optional(Schema.Array(Schema.String)),
  language: Schema.optional(Locale),
  reminders: Schema.optional(Schema.Boolean),
  purpose: Schema.optional(DeliveryPurpose),
});

const IssuePayload = Schema.Struct({
  from: Schema.Union([
    Schema.Struct({ draft: DocumentIdSchema, expectedRevision: Schema.Number }),
    Schema.Struct({ input: DocumentInput }),
  ]),
  send: Schema.optional(SendOptionsSchema),
});

export type IssueFrom =
  | { readonly draft: DocumentId; readonly expectedRevision: number }
  | { readonly input: DocumentInput };

const numberTaken = () => new Conflict({ reason: "duplicate" });

/**
 * Issue (D1, D10): from a draft (row-locked; a document that is no longer a draft fails with
 * `Conflict{illegal_transition}` before the revision check, so a blind retry never numbers
 * twice) or straight from input. Recomposes with fresh party snapshots and today's defaults,
 * numbers it, pins the defaults, audits `document.issue` and, with `send`, queues the
 * delivery in the same transaction.
 */
export const issue = (from: IssueFrom, opts?: RequestOptions & { readonly send?: SendOptions }) =>
  Effect.gen(function* () {
    const { workspaceId } = yield* authorizeInWorkspace("document.issue");
    return yield* withIdempotency(
      {
        scope: { _tag: "Workspace", workspaceId },
        key: opts?.requestKey,
        method: "Documents.issue",
        payload: {
          schema: IssuePayload as unknown as Schema.Codec<typeof IssuePayload.Type, unknown>,
          value: opts?.send === undefined ? { from } : { from, send: opts.send },
        },
        result: DocumentViewCodec,
      },
      Effect.gen(function* () {
        const repo = yield* DocumentsRepo;
        const { today, at } = yield* now;
        let row: DocumentRecord;
        if ("draft" in from) {
          const draft = yield* repo.lock(workspaceId, from.draft);
          yield* guard(draft, "issue");
          if (draft.revision !== from.expectedRevision) {
            return yield* new Conflict({
              reason: "revision_changed",
              currentRevision: draft.revision,
            });
          }
          const composed = yield* compose(workspaceId, specFromRecord(draft), { today });
          const next = yield* numbered(workspaceId, draft.id, composed);
          row = yield* repo
            .update(
              { ...draft, ...next, status: "issued", issuedAt: at, updatedAt: at },
              draft.revision,
            )
            .pipe(Effect.catchTag("UniqueViolation", numberTaken));
        } else {
          const id = yield* newId<DocumentId>();
          const composed = yield* compose(
            workspaceId,
            yield* specFromInput(workspaceId, from.input),
            { today },
          );
          const next = yield* numbered(workspaceId, id, composed);
          row = yield* repo
            .insert({
              ...newDraftRecord(id, workspaceId, composed, at),
              ...next,
              status: "issued",
              issuedAt: at,
            })
            .pipe(Effect.catchTag("UniqueViolation", numberTaken));
        }
        yield* appendAudit({
          workspaceId,
          subject: { entity: "Document", id: row.id },
          action: "document.issue",
          revision: row.revision,
          changes: [{ path: "number", before: null, after: row.number }],
        });
        if (opts?.send !== undefined) {
          yield* (yield* DocumentSender).send(row.id, opts.send);
        }
        return yield* viewOf(row);
      }),
    );
  }).pipe(orUnavailable);

// Edit of an issued document ----------------------------------------------------------------

/** Fields a Payment Tax Document or Credit Note accepts (D3a: their amounts are bound). */
const TEXT_FIELDS = new Set(["note", "orderNumber", "language", "number"]);

/** Audited record fields, in diff order (D3: one entry with the field-level diff). */
const DIFF_FIELDS = [
  "number",
  "contactId",
  "contact",
  "issuer",
  "currency",
  "language",
  "paymentMethod",
  "note",
  "issuedOn",
  "taxableSupplyOn",
  "dueOn",
  "pricesIncludeVat",
  "variableSymbol",
  "orderNumber",
  "lines",
  "totals",
  "fx",
  "fxOverride",
  "taxDocument",
] as const satisfies ReadonlyArray<keyof DocumentRecord>;

const encodeRecord = Schema.encodeUnknownSync(Schema.toCodecJson(DocumentRecordSchema));

/** The field-level diff of two versions of a record, values in their JSON encoding. */
export const diffRecords = (before: DocumentRecord, after: DocumentRecord) => {
  const a = encodeRecord(before) as Record<string, unknown>;
  const b = encodeRecord(after) as Record<string, unknown>;
  return DIFF_FIELDS.flatMap((path) =>
    JSON.stringify(a[path]) === JSON.stringify(b[path])
      ? []
      : [{ path, before: a[path] ?? null, after: b[path] ?? null }],
  );
};

const patchKeys = (patch: DocumentPatch) =>
  Object.entries(patch)
    .filter(([k, v]) => v !== undefined && !(k === "refreshParties" && v === false))
    .map(([k]) => k);

/**
 * `edit` of an issued, unlocked document (row from `getForUpdate`, guarded by the caller):
 * D3 recompute with frozen parties (D10, unless `refreshParties` or a new Contact), D3a
 * freezes, D4 number override (the caller authorized `document.overrideNumber`). Every
 * accepted edit bumps the revision and writes one `document.edit` entry with the diff.
 */
export const editIssued = (row: DocumentRecord, patch: DocumentPatch) =>
  Effect.gen(function* () {
    const repo = yield* DocumentsRepo;
    const { today, at } = yield* now;
    const keys = patchKeys(patch);
    const textOnly = row.kind === "payment_tax_document" || row.kind === "credit_note";
    if (textOnly && keys.some((k) => !TEXT_FIELDS.has(k))) return yield* illegal();
    // D3: the series never changes once a number is assigned.
    if (patch.series !== undefined && patch.series !== row.seriesId) return yield* illegal();
    if (
      hasDependents(row) &&
      (patch.lines !== undefined ||
        (patch.currency !== undefined && patch.currency !== row.currency) ||
        (patch.taxableSupplyOn !== undefined && patch.taxableSupplyOn !== row.taxableSupplyOn))
    ) {
      return yield* illegal();
    }

    // D4: the new number is reserved for the document; the old one stays reserved.
    let number = row.number;
    if (patch.number !== undefined && patch.number.trim() !== row.number) {
      number = yield* (yield* NumberingSeries).override({
        workspaceId: row.workspaceId,
        kind: row.kind,
        documentId: row.id,
        number: patch.number,
      });
    }

    let next: DocumentRecord;
    if (textOnly) {
      const given: GivenFields = {
        ...row.given,
        ...(patch.note === undefined ? {} : { note: patch.note }),
        ...(patch.language === undefined ? {} : { language: patch.language }),
      };
      next = {
        ...row,
        given,
        note: patch.note ?? row.note,
        language: patch.language ?? row.language,
        orderNumber: patch.orderNumber ?? row.orderNumber,
        number,
        variableSymbol:
          row.kind === "credit_note"
            ? row.variableSymbol
            : (given.variableSymbol ?? digitsOf(number)),
        updatedAt: at,
      };
    } else {
      const spec = yield* applyPatch(row.workspaceId, specFromRecord(row), {
        ...patch,
        series: undefined,
      });
      const refresh = patch.refreshParties === true;
      const composed = yield* compose(row.workspaceId, spec, {
        today,
        ...(refresh
          ? {}
          : {
              freeze: {
                contact: spec.contactId === row.contactId ? row.contact : undefined,
                issuer: row.issuer,
              },
            }),
      });
      next = {
        ...row,
        ...composed,
        seriesId: row.seriesId,
        number,
        variableSymbol: composed.given.variableSymbol ?? digitsOf(number),
        updatedAt: at,
      };
    }

    const saved = yield* repo
      .update(next, row.revision)
      .pipe(Effect.catchTag("UniqueViolation", numberTaken));
    yield* appendAudit({
      workspaceId: row.workspaceId,
      subject: { entity: "Document", id: row.id },
      action: "document.edit",
      revision: saved.revision,
      changes: diffRecords(row, saved),
    });
    return yield* viewOf(saved);
  });

// Lock / unlock -----------------------------------------------------------------------------

/** Document Lock (D5). Idempotent: a locked or cancelled document is returned unchanged. */
export const lock = (id: DocumentId) =>
  Effect.gen(function* () {
    const { workspaceId } = yield* authorizeInWorkspace("document.lock");
    const store = yield* CoreStore;
    return yield* store.transaction(
      Effect.gen(function* () {
        const repo = yield* DocumentsRepo;
        const row = yield* repo.lock(workspaceId, id);
        if ((yield* guard(row, "lock")) === "noop") return yield* viewOf(row);
        const { at } = yield* now;
        const next = yield* repo
          .update({ ...row, locked: true, lockedAt: at, updatedAt: at }, row.revision)
          .pipe(Effect.catchTag("UniqueViolation", (e) => Effect.die(e)));
        yield* appendAudit({
          workspaceId,
          subject: { entity: "Document", id },
          action: "document.lock",
          revision: next.revision,
          changes: [{ path: "locked", before: false, after: true }],
        });
        return yield* viewOf(next);
      }),
    );
  }).pipe(orUnavailable);

/**
 * Unlock (D5, R1b): owner or admin, with a reason that goes into the audit entry. An issued
 * document that is not locked is returned unchanged; drafts and cancelled documents fail.
 */
export const unlock = (id: DocumentId, reason: string) =>
  Effect.gen(function* () {
    const { workspaceId } = yield* authorizeInWorkspace("document.unlock");
    const why = yield* reasonOf(reason);
    const store = yield* CoreStore;
    return yield* store.transaction(
      Effect.gen(function* () {
        const repo = yield* DocumentsRepo;
        const row = yield* repo.lock(workspaceId, id);
        if ((yield* guard(row, "unlock")) === "noop") return yield* viewOf(row);
        const { at } = yield* now;
        const next = yield* repo
          .update({ ...row, locked: false, lockedAt: null, updatedAt: at }, row.revision)
          .pipe(Effect.catchTag("UniqueViolation", (e) => Effect.die(e)));
        yield* appendAudit({
          workspaceId,
          subject: { entity: "Document", id },
          action: "document.unlock",
          revision: next.revision,
          changes: [{ path: "locked", before: true, after: false }],
          reason: why,
        });
        return yield* viewOf(next);
      }),
    );
  }).pipe(orUnavailable);

// Cancel ------------------------------------------------------------------------------------

export interface CancelInput {
  readonly reason: string;
  readonly on?: IsoDate;
}

export interface CancelResult {
  readonly document: DocumentView;
  readonly creditNote: DocumentView | null;
}

const CancelPayload = Schema.Struct({
  id: DocumentIdSchema,
  reason: Schema.String,
  on: Schema.optional(IsoDateSchema),
});

export const CancelResultCodec = Schema.Struct({
  document: DocumentViewCodec,
  creditNote: Schema.NullOr(DocumentViewCodec),
}) as unknown as Schema.Codec<CancelResult, unknown>;

/**
 * Cancel (storno, D6). A tax document gets a full Credit Note for the uncorrected remainder
 * and stays issued with `settlement: "credited"`; any other document becomes `cancelled`
 * (always locked, number kept). Recorded payments, a Final Invoice on a Proforma, or a tax
 * document already fully credited fail with `Conflict{illegal_transition}`.
 */
export const cancel = (id: DocumentId, input: CancelInput, opts?: RequestOptions) =>
  Effect.gen(function* () {
    const { workspaceId } = yield* authorizeInWorkspace("document.cancel");
    const reason = yield* reasonOf(input.reason);
    return yield* withIdempotency(
      {
        scope: { _tag: "Workspace", workspaceId },
        key: opts?.requestKey,
        method: "Documents.cancel",
        payload: {
          schema: CancelPayload as unknown as Schema.Codec<typeof CancelPayload.Type, unknown>,
          value: input.on === undefined ? { id, reason } : { id, reason, on: input.on },
        },
        result: CancelResultCodec,
      },
      Effect.gen(function* () {
        const repo = yield* DocumentsRepo;
        const { today, at } = yield* now;
        const row = yield* repo.lock(workspaceId, id);
        yield* guard(row, "cancel");
        if (paymentsBlockCancel(row)) return yield* illegal();
        if (row.kind === "proforma" && hasFinalInvoice(row)) return yield* illegal();
        const on = input.on ?? today;
        if (on < row.issuedOn) {
          return yield* new Invalid({
            issues: [
              { path: ["on"], code: "request.malformed", params: { reason: "out_of_range" } },
            ],
          });
        }

        if (row.taxDocument) {
          if (row.settlement === "credited") return yield* illegal();
          const earlier = yield* repo.getMany(
            workspaceId,
            row.links.filter((l) => l.relation === "corrected_by").map((l) => l.id),
          );
          const { original, creditNote } = yield* issueCreditNote(row, {
            reason,
            correctedOn: on,
            credit: remainderSpec(row, earlier),
          });
          yield* appendAudit({
            workspaceId,
            subject: { entity: "Document", id },
            action: "document.cancel",
            revision: original.revision,
            changes: [
              { path: "settlement", before: row.settlement, after: original.settlement },
              { path: "creditNote", before: null, after: creditNote.id },
            ],
            reason,
          });
          return {
            document: yield* viewOf(original),
            creditNote: yield* viewOf(creditNote),
          } satisfies CancelResult;
        }

        const next = yield* repo
          .update(
            {
              ...row,
              status: "cancelled",
              locked: true,
              lockedAt: row.lockedAt ?? at,
              cancelledOn: on,
              reason,
              updatedAt: at,
            },
            row.revision,
          )
          .pipe(Effect.catchTag("UniqueViolation", (e) => Effect.die(e)));
        yield* appendAudit({
          workspaceId,
          subject: { entity: "Document", id },
          action: "document.cancel",
          revision: next.revision,
          changes: [
            { path: "status", before: row.status, after: next.status },
            { path: "cancelledOn", before: null, after: on },
          ],
          reason,
        });
        return { document: yield* viewOf(next), creditNote: null } satisfies CancelResult;
      }),
    );
  }).pipe(orUnavailable);
