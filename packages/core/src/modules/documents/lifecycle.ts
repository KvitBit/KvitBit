/**
 * Lifecycle methods (P2): issue, edit of an issued document (incl. the number override),
 * lock, unlock and cancel. Each follows the method shape of src/index.ts; the state checks
 * come from the transition table (transitions.ts).
 */

import type {
  Caller,
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
  NotFound,
  VatBreakdown,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as EffectRecord from "effect/Record";
import * as Schema from "effect/Schema";
import * as EffectString from "effect/String";
import { addDaysWithinRange, daysBetween, isCalendarDate } from "../../engines/calendar";
import { authorizeInWorkspace } from "../../policy/Policy";
import { appendAudit } from "../../shared/audit";
import { orUnavailable } from "../../shared/errors";
import { withIdempotency } from "../../shared/idempotency";
import { newId } from "../../shared/ids";
import { CoreStore } from "../../store/CoreStore";
import { NumberingSeries } from "../numbering";
import type { Composed } from "./compose";
import { applyPatch, compose, specFromInput, specFromRecord } from "./compose";
import { loadForCredit } from "./corrections";
import { digitsOf, issueCreditNote, remainderSpec, settlementOf } from "./credit";
import { DocumentIssuers } from "./ports";
import type { DocumentRecord, GivenFields } from "./record";
import { DocumentRecord as DocumentRecordSchema } from "./record";
import { DocumentsRepo } from "./repo";
import { DocumentSender } from "./sender";
import { insertNumbered, newDraftRecord, now, viewOf } from "./support";
import { guard, hasDependents, hasFinalInvoice, paymentsBlockCancel } from "./transitions";
import { DocumentViewCodec } from "./view";

const VARIABLE_SYMBOL = /^\d{1,10}$/;
const illegal = () => Conflict.make({ reason: "illegal_transition" });

const required = (path: string) =>
  Invalid.make({
    issues: [{ path: [path], code: "request.malformed", params: { reason: "required" } }],
  });

/** A required free-text reason (unlock, cancel), trimmed. */
const reasonOf = (reason: string) => {
  const trimmed = EffectString.trim(reason);
  return trimmed === "" ? Effect.fail(required("reason")) : Effect.succeed(trimmed);
};

// Issue -------------------------------------------------------------------------------------

/**
 * Pins the defaults the draft left floating (today, Contact and Workspace defaults) as the
 * document's own values, so later edits recompute from what was issued (rule D10 freezes the
 * parties; this freezes the defaults). The due date stays relative to `issuedOn` when it was
 * a default. The bank account is kept through the frozen issuer snapshot instead.
 */
const pinDefaults = (c: Composed): GivenFields => {
  const given = {
    ...c.given,
    currency: c.currency,
    issuedOn: c.issuedOn,
    due: c.given.due ?? { inDays: daysBetween(c.issuedOn, c.dueOn) },
    language: c.language,
    note: c.note,
    paymentMethod: c.paymentMethod,
  };
  if (c.taxableSupplyOn !== null) given.taxableSupplyOn = c.taxableSupplyOn;
  if (c.seriesId !== null) given.series = c.seriesId;
  return given;
};

/**
 * Numbers a composed document (rules D1, S3, S4: after the caller's row lock): the series the
 * document resolved (else the kind's default). Exhaustion is
 * `Conflict{illegal_transition, numbering.pattern_invalid}` and rolls the issue back.
 */
export const numbered = Effect.fn("numbered")(function* (
  workspaceId: WorkspaceId,
  documentId: DocumentId,
  composed: Composed,
) {
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
  to: Schema.String.pipe(Schema.Array, Schema.optional),
  language: Schema.optional(Locale),
  reminders: Schema.optional(Schema.Boolean),
  purpose: Schema.optional(DeliveryPurpose),
});

const IssuePayload = Schema.Struct({
  from: Schema.Union([
    Schema.Struct({ draft: DocumentIdSchema, expectedRevision: Schema.Finite }),
    Schema.Struct({ input: DocumentInput }),
  ]),
  send: Schema.optional(SendOptionsSchema),
});

export type IssueFrom =
  | { readonly draft: DocumentId; readonly expectedRevision: number }
  | { readonly input: DocumentInput };

const numberTaken = () => Conflict.make({ reason: "duplicate" });

/**
 * Issue (D1, D10): from a draft (row-locked; a document that is no longer a draft fails with
 * `Conflict{illegal_transition}` before the revision check, so a blind retry never numbers
 * twice) or straight from input. Recomposes with fresh party snapshots and today's defaults,
 * numbers it, pins the defaults, audits `document.issue` and, with `send`, queues the
 * delivery in the same transaction.
 */
export const issue = Effect.fn("issue")(
  function* (
    caller: Caller,
    from: IssueFrom,
    opts?: RequestOptions & { readonly send?: SendOptions },
  ) {
    const { caller: workspaceCaller, workspaceId } = yield* authorizeInWorkspace(
      caller,
      "document.issue",
    );
    // R1a: every policy check runs before a replay (`send` queues a delivery).
    if (opts?.send !== undefined) yield* authorizeInWorkspace(workspaceCaller, "document.send");
    return yield* withIdempotency(
      {
        scope: { _tag: "Workspace", workspaceId },
        key: opts?.requestKey,
        method: "Documents.issue",
        payload: {
          schema: IssuePayload,
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
            return yield* Conflict.make({
              reason: "revision_changed",
              currentRevision: draft.revision,
            });
          }
          const composed = yield* compose(caller, workspaceId, specFromRecord(draft), { today });
          const next = yield* numbered(workspaceId, draft.id, composed);
          row = yield* repo
            .update(
              { ...draft, ...next, status: "issued", issuedAt: at, updatedAt: at },
              draft.revision,
            )
            .pipe(Effect.catchTag("UniqueViolation", numberTaken));
        } else {
          const id = yield* newId(DocumentIdSchema.make);
          const value_1 = yield* specFromInput(workspaceId, from.input);
          const composed = yield* compose(caller, workspaceId, value_1, { today });
          const draftRow = newDraftRecord(id, workspaceId, composed, at);
          row = yield* insertNumbered(
            draftRow,
            Effect.map(numbered(workspaceId, id, composed), (next) => ({
              ...draftRow,
              ...next,
              status: "issued" as const,
              issuedAt: at,
            })),
          );
        }
        yield* appendAudit(workspaceCaller, {
          workspaceId,
          subject: { entity: "Document", id: row.id },
          action: "document.issue",
          revision: row.revision,
          changes: [{ path: "number", before: null, after: row.number }],
        });
        if (opts?.send !== undefined) {
          yield* (yield* DocumentSender).send(workspaceCaller, row.id, opts.send);
          // The sender may have written the document (reminder choice, revision).
          row = yield* repo.get(workspaceId, row.id);
        }
        return yield* viewOf(row);
      }),
    );
  },
  (_) => orUnavailable(_),
);

// Edit of an issued document ----------------------------------------------------------------

/** Fields a Payment Tax Document or Credit Note accepts (D3a: their amounts are bound). */
const TEXT_FIELDS = new Set(["note", "orderNumber", "language", "number"]);

/**
 * Fields an edit applies to the stored record without recomputing (no Contact, Workspace, rate
 * or FX lookup), so an unrelated edit never moves the issued amounts. `series` passes only
 * unchanged (checked first).
 */
const LIGHT_FIELDS = new Set([
  ...TEXT_FIELDS,
  "paymentMethod",
  "variableSymbol",
  "due",
  "issuedOn",
  "series",
  "bankAccount",
]);

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
  "settlement",
] as const satisfies ReadonlyArray<keyof DocumentRecord>;

/**
 * Caller-given fields, audited as `given.<field>` whenever they change, next to the resolved
 * fields they drive: the term itself decides later behaviour (a fixed due date no longer
 * follows issuedOn, an explicit symbol no longer follows the number), even when the resolved
 * value stays the same.
 */
const GIVEN_DIFF_FIELDS = [
  "currency",
  "issuedOn",
  "taxableSupplyOn",
  "due",
  "language",
  "series",
  "bankAccount",
  "note",
  "paymentMethod",
  "variableSymbol",
] as const satisfies ReadonlyArray<keyof GivenFields>;

const encodeRecord = Schema.encodeOption(Schema.toCodecJson(DocumentRecordSchema));
const encodeTotalsJson = Schema.encodeOption(Schema.toCodecJson(VatBreakdown));
const encodeJson = Schema.encodeOption(Schema.fromJsonString(Schema.Json));
const isJsonObject = Schema.is(Schema.JsonObject);
const jsonRecord = (value: DocumentRecord) =>
  Option.getOrThrow(encodeRecord(value).pipe(Option.filter(isJsonObject)));
const encodeTotals = (totals: DocumentRecord["totals"]) =>
  Option.getOrThrow(encodeTotalsJson(totals).pipe(Option.flatMap(encodeJson)));
const jsonString = (value: Schema.Json | undefined) =>
  value === undefined ? undefined : Option.getOrThrow(encodeJson(value));

/** The field-level diff of two versions of a record, values in their JSON encoding. */
const diffRecordsImpl = (before: DocumentRecord, after: DocumentRecord) => {
  const a = jsonRecord(before);
  const b = jsonRecord(after);
  const ga = isJsonObject(a["given"]) ? a["given"] : {};
  const gb = isJsonObject(b["given"]) ? b["given"] : {};
  const same = (x: Schema.Json | undefined, y: Schema.Json | undefined) =>
    jsonString(x) === jsonString(y);
  return [
    ...EffectArray.flatMap(DIFF_FIELDS, (path) =>
      same(a[path], b[path]) ? [] : [{ path, before: a[path] ?? null, after: b[path] ?? null }],
    ),
    ...EffectArray.flatMap(GIVEN_DIFF_FIELDS, (field) =>
      same(ga[field], gb[field])
        ? []
        : [{ path: `given.${field}`, before: ga[field] ?? null, after: gb[field] ?? null }],
    ),
  ];
};
export const diffRecords: {
  (after: DocumentRecord): (before: DocumentRecord) => ReturnType<typeof diffRecordsImpl>;
  (before: DocumentRecord, after: DocumentRecord): ReturnType<typeof diffRecordsImpl>;
} = Fn.dual(2, diffRecordsImpl);

const patchKeys = (patch: DocumentPatch) =>
  EffectArray.map(
    EffectArray.filter(
      EffectRecord.toEntries<string, DocumentPatch[keyof DocumentPatch]>(patch),
      ([k, v]) => v !== undefined && !(k === "refreshParties" && v === false),
    ),
    ([k]) => k,
  );

const malformed = (path: string, reason: string) =>
  Invalid.make({ issues: [{ path: [path], code: "request.malformed", params: { reason } }] });

/** The light path: text, dates and payment fields on the stored record; amounts untouched. */
const lightEdit = Effect.fn("lightEdit")(function* (
  caller: Caller,
  row: DocumentRecord,
  patch: DocumentPatch,
  number: string | null,
) {
  const given = { ...row.given };
  if (patch.note !== undefined) given.note = patch.note;
  if (patch.language !== undefined) given.language = patch.language;
  if (patch.paymentMethod !== undefined) given.paymentMethod = patch.paymentMethod;
  if (patch.variableSymbol !== undefined) given.variableSymbol = patch.variableSymbol;
  if (patch.due !== undefined) given.due = patch.due;
  if (patch.issuedOn !== undefined) given.issuedOn = patch.issuedOn;
  if (patch.bankAccount !== undefined) given.bankAccount = patch.bankAccount;
  if (given.variableSymbol !== undefined && !VARIABLE_SYMBOL.test(given.variableSymbol)) {
    return yield* malformed("variableSymbol", "variable_symbol_invalid");
  }
  // Another account of the Workspace in the document currency; its particulars as of now.
  let issuerSnapshot = row.issuer;
  if (patch.bankAccount !== undefined && patch.bankAccount !== row.issuer.bankAccount?.id) {
    const workspace = yield* (yield* DocumentIssuers).forDocument(
      caller,
      row.workspaceId,
      row.taxableSupplyOn ?? row.issuedOn,
    );
    const account = Option.getOrUndefined(
      EffectArray.findFirst(workspace.bankAccounts, (a) => a.id === patch.bankAccount),
    );
    if (account === undefined) {
      return yield* NotFound.make({ entity: "BankAccount", id: patch.bankAccount });
    }
    if (account.currency !== row.currency) {
      return yield* Invalid.make({
        issues: [
          {
            path: ["bankAccount"],
            code: "request.malformed",
            params: { reason: "currency_mismatch", currency: account.currency },
          },
        ],
      });
    }
    issuerSnapshot = {
      ...row.issuer,
      bankAccount: {
        id: account.id,
        name: account.name,
        currency: account.currency,
        accountNumber: account.accountNumber,
        iban: account.iban,
        bic: account.bic,
      },
    };
  }
  const issuedOn = given.issuedOn ?? row.issuedOn;
  let dueOn = row.dueOn;
  if (patch.due !== undefined || patch.issuedOn !== undefined) {
    const due = given.due ?? { inDays: daysBetween(row.issuedOn, row.dueOn) };
    const nextDueOn = "on" in due ? due.on : addDaysWithinRange(issuedOn, due.inDays);
    if (nextDueOn === null || !isCalendarDate(nextDueOn))
      return yield* malformed("due", "out_of_range");
    if (nextDueOn < issuedOn) {
      return yield* Invalid.make({
        issues: [{ path: ["due"], code: "document.due_before_issue" }],
      });
    }
    dueOn = nextDueOn;
  }
  return {
    ...row,
    given,
    issuer: issuerSnapshot,
    note: patch.note ?? row.note,
    language: patch.language ?? row.language,
    paymentMethod: patch.paymentMethod ?? row.paymentMethod,
    orderNumber: patch.orderNumber ?? row.orderNumber,
    issuedOn,
    dueOn,
    number,
    variableSymbol: given.variableSymbol ?? digitsOf(number),
  } satisfies DocumentRecord;
});

/**
 * `edit` of an issued, unlocked document (row from `getForUpdate`, guarded by the caller).
 * Text, date and payment fields apply to the stored record (`lightEdit`); anything else
 * recomputes through `compose` with frozen parties (D10, unless `refreshParties` or a new
 * Contact). D3a: a document others depend on keeps its lines, currency, tax point and
 * amounts; Payment Tax Documents and Credit Notes accept text fields only. D4: `number` (the
 * caller authorized `document.overrideNumber`). Every accepted edit bumps the revision and
 * writes one `document.edit` entry with the diff; the settlement follows a changed total.
 */
export const editIssued = Effect.fn("editIssued")(function* (
  caller: Caller,
  row: DocumentRecord,
  patch: DocumentPatch,
) {
  const repo = yield* DocumentsRepo;
  const { today, at } = yield* now;
  const keys = patchKeys(patch);
  const textOnly = row.kind === "payment_tax_document" || row.kind === "credit_note";
  if (textOnly && EffectArray.some(keys, (k) => !TEXT_FIELDS.has(k))) return yield* illegal();
  // D3: the series never changes once a number is assigned.
  if (patch.series !== undefined && patch.series !== row.seriesId) return yield* illegal();
  const dependents = hasDependents(row);
  if (
    dependents &&
    (patch.lines !== undefined ||
      (patch.currency !== undefined && patch.currency !== row.currency) ||
      (patch.taxableSupplyOn !== undefined && patch.taxableSupplyOn !== row.taxableSupplyOn) ||
      patch.fx !== undefined)
  ) {
    return yield* illegal();
  }
  // Recorded payments are in the document currency.
  if (row.payments > 0 && patch.currency !== undefined && patch.currency !== row.currency) {
    return yield* illegal();
  }

  // D4: the new number is reserved for the document; the old one stays reserved.
  let number = row.number;
  if (patch.number !== undefined && EffectString.trim(patch.number) !== row.number) {
    number = yield* (yield* NumberingSeries).override({
      workspaceId: row.workspaceId,
      kind: row.kind,
      documentId: row.id,
      number: patch.number,
    });
  }

  let next: DocumentRecord;
  if (EffectArray.every(keys, (k) => LIGHT_FIELDS.has(k))) {
    next = yield* lightEdit(caller, row, patch, number);
  } else {
    const spec = yield* applyPatch(row.workspaceId, specFromRecord(row), {
      ...patch,
      series: undefined,
    });
    const refresh = patch.refreshParties === true;
    const composed = yield* compose(caller, row.workspaceId, spec, {
      today,
      // Tax results stay frozen even when the parties are refreshed (D6 eligibility,
      // amounts owed); only the printed particulars follow `refreshParties`.
      freeze: {
        contact: !refresh && spec.contactId === row.contactId ? row.contact : undefined,
        issuer: refresh ? undefined : row.issuer,
        bankAccount: refresh ? undefined : row.issuer.bankAccount,
        currency: row.currency,
        taxableSupplyOn: row.taxableSupplyOn,
        regime: row.issuer.regime,
        fx: row.fx,
        fxOverride: row.fxOverride,
        paymentRounding: row.paymentRounding,
      },
    });
    // D3a: whatever moved them (prices incl. VAT, rate, Contact, refreshed regime), the
    // amounts another document relies on stay as issued.
    if (dependents && encodeTotals(composed.totals) !== encodeTotals(row.totals)) {
      return yield* illegal();
    }
    next = {
      ...row,
      ...composed,
      seriesId: row.seriesId,
      number,
      variableSymbol: composed.given.variableSymbol ?? digitsOf(number),
    };
  }
  // With a Credit Note the totals are frozen (D3a), so the stored settlement stands.
  next = {
    ...next,
    settlement:
      dependents && EffectArray.some(row.links, (l) => l.relation === "corrected_by")
        ? row.settlement
        : settlementOf(next),
    updatedAt: at,
  };

  const saved = yield* repo
    .update(next, row.revision)
    .pipe(Effect.catchTag("UniqueViolation", numberTaken));
  yield* appendAudit(caller, {
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
export const lock = Effect.fn("lock")(
  function* (caller: Caller, id: DocumentId) {
    const { workspaceId } = yield* authorizeInWorkspace(caller, "document.lock");
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
        yield* appendAudit(caller, {
          workspaceId,
          subject: { entity: "Document", id },
          action: "document.lock",
          revision: next.revision,
          changes: [{ path: "locked", before: false, after: true }],
        });
        return yield* viewOf(next);
      }),
    );
  },
  (_) => orUnavailable(_),
);

/**
 * Unlock (D5, R1b): owner or admin, with a reason that goes into the audit entry. An issued
 * document that is not locked is returned unchanged; drafts and cancelled documents fail.
 */
export const unlock = Effect.fn("unlock")(
  function* (caller: Caller, id: DocumentId, reason: string) {
    const { workspaceId } = yield* authorizeInWorkspace(caller, "document.unlock");
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
        yield* appendAudit(caller, {
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
  },
  (_) => orUnavailable(_),
);

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
});

/**
 * Cancel (storno, D6). A tax document gets a full Credit Note for the uncorrected remainder
 * and stays issued with `settlement: "credited"`; any other document becomes `cancelled`
 * (always locked, number kept). Recorded payments, a Final Invoice on a Proforma, or a tax
 * document already fully credited fail with `Conflict{illegal_transition}`.
 */
export const cancel = Effect.fn("cancel")(
  function* (caller: Caller, id: DocumentId, input: CancelInput, opts?: RequestOptions) {
    const { workspaceId } = yield* authorizeInWorkspace(caller, "document.cancel");
    const reason = yield* reasonOf(input.reason);
    return yield* withIdempotency(
      {
        scope: { _tag: "Workspace", workspaceId },
        key: opts?.requestKey,
        method: "Documents.cancel",
        payload: {
          schema: CancelPayload,
          value: input.on === undefined ? { id, reason } : { id, reason, on: input.on },
        },
        result: CancelResultCodec,
      },
      Effect.gen(function* () {
        const repo = yield* DocumentsRepo;
        const { today, at } = yield* now;
        // S4: a PTD's Proforma first; a PTD a live Final Invoice deducts waits for it (D8).
        const { row, deductedBy } = yield* loadForCredit(workspaceId, id, true);
        yield* guard(row, "cancel");
        if (deductedBy !== null) return yield* illegal();
        // A Credit Note is corrected by issuing another document, never cancelled.
        if (row.kind === "credit_note") return yield* illegal();
        if (paymentsBlockCancel(row)) return yield* illegal();
        if (row.kind === "proforma" && hasFinalInvoice(row)) return yield* illegal();
        const on = input.on ?? today;
        if (on < row.issuedOn || on > today) {
          return yield* Invalid.make({
            issues: [
              { path: ["on"], code: "request.malformed", params: { reason: "out_of_range" } },
            ],
          });
        }

        // Fully credited: nothing is left to void (D6), whatever the classification.
        if (row.settlement === "credited") return yield* illegal();
        if (row.taxDocument) {
          const earlier = yield* repo.getMany(
            workspaceId,
            EffectArray.map(
              EffectArray.filter(row.links, (l) => l.relation === "corrected_by"),
              (l) => l.id,
            ),
          );
          const { original, creditNote } = yield* issueCreditNote(caller, row, {
            reason,
            issuedOn: today,
            correctedOn: on,
            credit: remainderSpec(row, earlier),
          });
          yield* appendAudit(caller, {
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

        // A Credit Note already offsets part of it: cancelling would count that credit twice.
        if (EffectArray.some(row.links, (l) => l.relation === "corrected_by"))
          return yield* illegal();
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
        yield* appendAudit(caller, {
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
  },
  (_) => orUnavailable(_),
);
