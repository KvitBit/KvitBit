/**
 * `ExpensesLive`: the domain `Expenses` tag (core-ports 4.7) on `ExpensesRepo`, `CoreStore`,
 * `BlobStorage`, `FxFixings` (CNB read through the fixing cache) and `ExpenseSuppliers`.
 *
 * Method shape (src/index.ts): authorize -> withIdempotency / transaction -> lock + revision ->
 * rules -> write -> appendAudit -> orUnavailable. `ExpensesImpl` declares each method's honest
 * errors, as the domain tag declares them.
 *
 * External calls (supplier lookup through Contacts/ARES, the CNB fixing) never run under the
 * Expense row lock: `edit` prepares the next row from an unlocked read, then locks and re-checks
 * the revision. `record` runs them inside its idempotent transaction, which holds only the
 * request-log claim, so a reused key is matched (C3) before any input is judged.
 */

import type {
  AttachmentId,
  AttachmentView,
  Caller,
  ExpenseId,
  ExpenseInput as ExpenseInputType,
  ExpensePatch,
  ExpenseQuery,
  ExpenseSummary,
  ExpenseView,
  FileDownload,
  Forbidden,
  Page,
  RequestOptions,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import {
  AttachmentId as AttachmentIdSchema,
  Conflict,
  ExpenseId as ExpenseIdSchema,
  ExpenseInput,
  Expenses,
  ExpenseView as ExpenseViewSchema,
  Invalid,
  NotFound,
  Unavailable,
} from "@kvitbit/domain/contract";
import { BlobKey, BlobStorage, BlobTooLarge } from "@kvitbit/domain/ports";
import * as EffectArray from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import * as EffectString from "effect/String";
import type { FxRate } from "../../engines/fx";
import { authorizeInWorkspace } from "../../policy/Policy";
import { appendAudit } from "../../shared/audit";
import { canonicalJson } from "../../shared/canonicalJson";
import { orUnavailable } from "../../shared/errors";
import { FxFixings } from "../../shared/fx";
import { withIdempotency } from "../../shared/idempotency";
import { IdGenerator, newId } from "../../shared/ids";
import { checkRevision } from "../../shared/revision";
import { CoreStore } from "../../store/CoreStore";
import type { ExpenseFields, ExpenseRow, SupplierRecord, SupplierRef } from "./model";
import {
  computeFigures,
  decodeFields,
  encodeAttachment,
  encodeSummary,
  encodeView,
  invalid,
  isJsonValue,
  needsFixing,
  percentOf,
  resolveFx,
  summaryFields,
  taxPointOf,
  validateComplete,
  viewFields,
} from "./model";
import { ExpensesRepo } from "./repo";
import { SNIFFABLE_TYPES, sniffing } from "./sniff";
import { ExpenseSuppliers } from "./suppliers";

/** Upload limit and accepted types (http-mcp-contracts 3.4, `GET /api/v1/config`). */
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_TYPES: ReadonlyArray<string> = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
];

export interface ExpensesOptions {
  readonly maxAttachmentBytes?: number;
  /** Subset of the sniffable types (PDF, JPEG, PNG, HEIC); others are never accepted. */
  readonly attachmentTypes?: ReadonlyArray<string>;
}

/** Workspace-prefixed key of an attachment's blob (core-ports 6: BlobKey is core-chosen). */
export const attachmentKey: {
  (expenseId: ExpenseId, attachmentId: AttachmentId): (workspaceId: WorkspaceId) => BlobKey;
  (workspaceId: WorkspaceId, expenseId: ExpenseId, attachmentId: AttachmentId): BlobKey;
} = Fn.dual(
  3,
  (workspaceId: WorkspaceId, expenseId: ExpenseId, attachmentId: AttachmentId): BlobKey =>
    BlobKey.make(`workspaces/${workspaceId}/expenses/${expenseId}/attachments/${attachmentId}`),
);

const DEFAULT_LIMIT = 50;

/** The honest service: each method's errors as the spec and the store produce them. */
export interface ExpensesImpl {
  readonly record: (
    caller: Caller,
    input: ExpenseInputType,
    opts?: RequestOptions,
  ) => Effect.Effect<ExpenseView, Invalid | NotFound | Unavailable | Forbidden | Conflict>;
  readonly edit: (
    caller: Caller,
    id: ExpenseId,
    patch: ExpensePatch,
    expectedRevision: number,
  ) => Effect.Effect<ExpenseView, NotFound | Invalid | Conflict | Unavailable | Forbidden>;
  readonly remove: (
    caller: Caller,
    id: ExpenseId,
    expectedRevision: number,
  ) => Effect.Effect<void, NotFound | Conflict | Forbidden | Unavailable>;
  readonly attach: (
    caller: Caller,
    id: ExpenseId,
    file: {
      readonly name: string;
      readonly contentType: string;
      readonly bytes: Stream.Stream<Uint8Array>;
    },
  ) => Effect.Effect<AttachmentView, NotFound | Invalid | Unavailable | Forbidden>;
  readonly detach: (
    caller: Caller,
    id: ExpenseId,
    attachment: AttachmentId,
  ) => Effect.Effect<void, NotFound | Forbidden | Unavailable>;
  readonly attachment: (
    caller: Caller,
    id: ExpenseId,
    attachment: AttachmentId,
  ) => Effect.Effect<FileDownload, NotFound | Unavailable | Forbidden>;
  readonly get: (
    caller: Caller,
    id: ExpenseId,
  ) => Effect.Effect<ExpenseView, NotFound | Forbidden | Unavailable>;
  readonly list: (
    caller: Caller,
    q: ExpenseQuery,
  ) => Effect.Effect<Page<ExpenseSummary>, Invalid | Forbidden | Unavailable>;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const notFound = (id: ExpenseId) => NotFound.make({ entity: "Expense", id });

/** Fields compared for the audit trail of `edit`. */
const AUDITED: ReadonlyArray<keyof ReturnType<typeof viewFields>> = [
  "status",
  "supplier",
  "supplierDocumentNumber",
  "issuedOn",
  "taxableSupplyOn",
  "dueOn",
  "currency",
  "total",
  "vat",
  "fx",
  "totalCzk",
  "deductibility",
  "category",
  "tags",
  "note",
];

/**
 * Cursor of `list`: the filter it came from and the last id. Order is id desc: ids are UUIDv7,
 * so this is the order Expenses were received in (the contract's `receivedOn desc, id desc`;
 * there is no separate receivedOn column).
 */
const ListCursor = Schema.StringFromBase64.pipe(
  Schema.decodeTo(Schema.fromJsonString(Schema.Tuple([Schema.String, ExpenseIdSchema]))),
);
const encodeCursor = Schema.encodeEffect(ListCursor);
const decodeCursor = (cursor: string) => Option.getOrNull(Schema.decodeOption(ListCursor)(cursor));

/** Errors the transaction surely rolled back on; a store failure may hide a commit. */
const surelyRolledBack = (e: { readonly _tag: string }) => e._tag !== "StoreUnavailable";

export const makeExpenses = Effect.fn("makeExpenses")(function* (options: ExpensesOptions = {}) {
  const maxBytes = options.maxAttachmentBytes ?? ATTACHMENT_MAX_BYTES;
  const types = EffectArray.filter(options.attachmentTypes ?? ATTACHMENT_TYPES, (t) =>
    SNIFFABLE_TYPES.includes(t),
  );
  const store = yield* CoreStore;
  const repo = yield* ExpensesRepo;
  const blobs = yield* BlobStorage;
  const rates = yield* FxFixings;
  const suppliers = yield* ExpenseSuppliers;
  const ids = yield* IdGenerator;

  const provide = <A, E>(
    effect: Effect.Effect<A, E, CoreStore | IdGenerator>,
  ): Effect.Effect<A, E> =>
    effect.pipe(Effect.provideService(CoreStore, store), Effect.provideService(IdGenerator, ids));

  const live = (row: ExpenseRow) =>
    row.removedAt === null ? Effect.succeed(row) : Effect.fail(notFound(row.id));
  /** A live Expense of the Workspace; removed or foreign is NotFound (R2). */
  const getLive = (ws: WorkspaceId, id: ExpenseId) => Effect.flatMap(repo.get(ws, id), live);
  const lockLive = (ws: WorkspaceId, id: ExpenseId) => Effect.flatMap(repo.lock(ws, id), live);

  const resolveSupplier = (caller: Caller, ref: SupplierRef) =>
    "contact" in ref
      ? suppliers.contact(caller, ref.contact)
      : "ico" in ref
        ? suppliers.fromIco(caller, ref.ico)
        : Effect.succeed<SupplierRecord>({
            contactId: null,
            name: ref.manual.name,
            ico: ref.manual.ico ?? null,
            dic: ref.manual.dic ?? null,
          });

  /** Applies the given fields onto `base` (absent keys keep, null clears). */
  const applyFields = Effect.fn("applyFields")(function* (
    caller: Caller,
    base: ExpenseRow,
    fields: ExpenseFields,
  ) {
    const supplier =
      fields.supplier === undefined
        ? base.supplier
        : fields.supplier === null
          ? null
          : yield* resolveSupplier(caller, fields.supplier);
    const keep = <A>(existing: A, patch: A | undefined): A =>
      patch === undefined ? existing : patch;
    const next: ExpenseRow = {
      ...base,
      status: fields.status ?? base.status,
      supplier,
      supplierDocumentNumber: keep(base.supplierDocumentNumber, fields.supplierDocumentNumber),
      issuedOn: keep(base.issuedOn, fields.issuedOn),
      taxableSupplyOn: keep(base.taxableSupplyOn, fields.taxableSupplyOn),
      dueOn: keep(base.dueOn, fields.dueOn),
      currency: keep(base.currency, fields.currency),
      total:
        fields.total === undefined
          ? base.total
          : fields.total === null
            ? null
            : BigDecimal.normalize(fields.total),
      vatLines:
        fields.vat === undefined
          ? base.vatLines
          : fields.vat === null
            ? null
            : EffectArray.map(fields.vat, (l) => ({
                treatment: l.treatment,
                base: BigDecimal.normalize(l.base),
                vat: BigDecimal.normalize(l.vat ?? BigDecimal.fromBigInt(0n)),
                selfAssessed: l.selfAssessed ?? null,
              })),
      deductiblePercent:
        fields.deductibility === undefined
          ? base.deductiblePercent
          : percentOf(fields.deductibility),
      category: keep(base.category, fields.category),
      tags: fields.tags === undefined ? base.tags : [...fields.tags],
      note: keep(base.note, fields.note),
    };
    return next;
  });

  /**
   * The rate for a complete row: the previous row's stored rate when currency and tax point are
   * unchanged (an unrelated edit never moves the CZK figures), else a fresh CNB fixing.
   */
  const rateFor = Effect.fn("rateFor")(function* (row: ExpenseRow, previous: ExpenseRow | null) {
    if (!needsFixing(row)) return null;
    const prior = previous?.figures?.fx ?? null;
    if (
      prior !== null &&
      previous !== null &&
      previous.currency === row.currency &&
      taxPointOf(previous) === taxPointOf(row)
    ) {
      return prior;
    }
    const taxPoint = Option.getOrThrow(Option.fromNullOr(taxPointOf(row)));
    const fixing = yield* rates.fixing(taxPoint);
    const fx = resolveFx(row, fixing);
    return Result.isFailure(fx) ? yield* fx.failure : fx.success;
  });

  /** The complete-Expense checks; fails with every issue at once. */
  const validate = (row: ExpenseRow) => {
    const [first, ...rest] = validateComplete(row);
    return first === undefined
      ? Effect.void
      : Effect.fail(Invalid.make({ issues: [first, ...rest] }));
  };

  /** The rate `row` needs once valid: null for incomplete or CZK rows (no CNB call). */
  const prepareRate = (row: ExpenseRow, previous: ExpenseRow | null) =>
    row.status === "incomplete"
      ? Effect.succeed(null)
      : Effect.andThen(validate(row), rateFor(row, previous));

  /** Full validation and derived figures at `fx`; none for an incomplete Expense. */
  const finish = (row: ExpenseRow, fx: FxRate | null) =>
    row.status === "incomplete"
      ? Effect.succeed<ExpenseRow>({ ...row, figures: null })
      : Effect.map(validate(row), () => ({ ...row, figures: computeFigures(row, fx) }));

  const viewOf = (ws: WorkspaceId, row: ExpenseRow) =>
    Effect.map(repo.attachmentsOf(ws, [row.id]), (atts) => encodeView(viewFields(row, atts)));

  const auditChanges = (before: ExpenseRow, after: ExpenseRow) => {
    const b = encodeView(viewFields(before, []));
    const a = encodeView(viewFields(after, []));
    return EffectArray.flatMap(AUDITED, (key) =>
      canonicalJson(b[key]) === canonicalJson(a[key])
        ? []
        : [{ path: key, before: b[key] ?? null, after: a[key] ?? null }],
    );
  };

  const subject = (id: ExpenseId) => ({ entity: "Expense" as const, id });

  /** Open fields must be plain JSON (what the wire delivers) to be fingerprinted (C3). */
  const requireJson = (value: ExpenseInputType | ExpensePatch) =>
    isJsonValue(value) ? Effect.void : Effect.fail(invalid("request.malformed", []));

  const record: ExpensesImpl["record"] = (caller, input, opts) =>
    provide(
      Effect.gen(function* () {
        const { caller: workspaceCaller, workspaceId } = yield* authorizeInWorkspace(
          caller,
          "expense.write",
        );
        yield* requireJson(input);
        return yield* withIdempotency(
          {
            scope: { _tag: "Workspace", workspaceId },
            key: opts?.requestKey,
            method: "Expenses.record",
            payload: { schema: ExpenseInput, value: input },
            result: ExpenseViewSchema,
          },
          Effect.gen(function* () {
            const fields = yield* decodeFields(input);
            const now = yield* nowIso;
            const empty: ExpenseRow = {
              id: yield* newId(ExpenseIdSchema.make),
              workspaceId,
              revision: 1,
              status: "complete",
              supplier: null,
              supplierDocumentNumber: null,
              issuedOn: null,
              taxableSupplyOn: null,
              dueOn: null,
              currency: null,
              total: null,
              vatLines: null,
              deductiblePercent: 100,
              category: null,
              tags: [],
              note: null,
              figures: null,
              paid: BigDecimal.fromBigInt(0n),
              payments: 0,
              removedAt: null,
              createdAt: now,
              updatedAt: now,
            };
            const merged = yield* applyFields(workspaceCaller, empty, fields);
            const value_1 = yield* prepareRate(merged, null);
            const row = yield* finish(merged, value_1);
            const saved = yield* repo.insert(row);
            yield* appendAudit(workspaceCaller, {
              workspaceId,
              subject: subject(saved.id),
              action: "expense.record",
              revision: saved.revision,
            });
            return yield* viewOf(workspaceId, saved);
          }),
        );
      }).pipe(orUnavailable, dieOnUnique),
    );

  const edit: ExpensesImpl["edit"] = (caller, id, patch, expectedRevision) =>
    provide(
      Effect.gen(function* () {
        const { caller: workspaceCaller, workspaceId } = yield* authorizeInWorkspace(
          caller,
          "expense.write",
        );
        yield* requireJson(patch);
        const fields = yield* decodeFields(patch);
        const existing = yield* getLive(workspaceId, id);
        // The CNB fixing (read-only, may call out) is fetched before the lock, from an unlocked
        // read at the expected revision; the supplier is resolved inside the transaction because
        // `fromIco` may upsert a Contact, which must roll back with a failed edit (C1).
        const seen = yield* checkRevision(existing, expectedRevision);
        const withFields = yield* applyFields(workspaceCaller, seen, {
          ...fields,
          supplier: undefined,
        });
        const fx = yield* prepareRate(withFields, seen);
        return yield* store.transaction(
          Effect.gen(function* () {
            const locked = yield* lockLive(workspaceId, id);
            // Same revision as `seen`, so `fx` was derived from the row now locked.
            const current = yield* checkRevision(locked, expectedRevision);
            const applied = yield* applyFields(workspaceCaller, current, fields);
            const prepared = yield* finish({ ...applied, updatedAt: yield* nowIso }, fx);
            if (current.payments > 0) {
              // A paid Expense keeps the currency its Payments are in (P1) and stays complete.
              if (prepared.currency !== current.currency) {
                return yield* invalid("payment.currency_mismatch", ["currency"]);
              }
              if (prepared.status === "incomplete") {
                return yield* invalid("expense.incomplete", ["status"]);
              }
            }
            const saved = yield* repo.update(prepared, current.revision);
            yield* appendAudit(workspaceCaller, {
              workspaceId,
              subject: subject(id),
              action: "expense.edit",
              revision: saved.revision,
              changes: auditChanges(current, saved),
            });
            return yield* viewOf(workspaceId, saved);
          }),
        );
      }).pipe(orUnavailable, dieOnUnique),
    );

  const remove: ExpensesImpl["remove"] = (caller, id, expectedRevision) =>
    provide(
      Effect.gen(function* () {
        const { workspaceId } = yield* authorizeInWorkspace(caller, "expense.write");
        yield* store.transaction(
          Effect.gen(function* () {
            const value_1 = yield* lockLive(workspaceId, id);
            const current = yield* checkRevision(value_1, expectedRevision);
            if (current.payments > 0) {
              return yield* Conflict.make({ reason: "illegal_transition" });
            }
            const now = yield* nowIso;
            const saved = yield* repo.update(
              { ...current, removedAt: now, updatedAt: now },
              current.revision,
            );
            yield* appendAudit(caller, {
              workspaceId,
              subject: subject(id),
              action: "expense.remove",
              revision: saved.revision,
            });
          }),
        );
      }).pipe(orUnavailable, dieOnUnique),
    );

  const attach: ExpensesImpl["attach"] = (caller, id, file) =>
    provide(
      Effect.gen(function* () {
        const { workspaceId } = yield* authorizeInWorkspace(caller, "expense.write");
        const contentType = EffectString.toLowerCase(
          EffectString.trim(EffectString.split(file.contentType, ";")[0] ?? ""),
        );
        const rejected = invalid("attachment.type_rejected", ["file", "contentType"]);
        if (!types.includes(contentType)) return yield* rejected;
        yield* getLive(workspaceId, id);
        const attachmentId = yield* newId(AttachmentIdSchema.make);
        const key = attachmentKey(workspaceId, id, attachmentId);
        const discard = blobs.delete(key).pipe(Effect.ignore);
        // Streamed before the transaction and committed with the row; a blob whose row never
        // commits is deleted here when the rollback is certain, else collected by housekeeping
        // after 24 h (core-ports 4.7). The prefix is sniffed while streaming.
        const sniffed = sniffing(contentType, file.bytes, maxBytes);
        const put = yield* blobs
          .put(key, sniffed.stream, { contentType, maxBytes })
          .pipe(
            Effect.catchIf(Schema.is(BlobTooLarge), (e) =>
              Effect.fail(
                invalid("attachment.too_large", ["file"], { maxBytes: String(e.maxBytes) }),
              ),
            ),
          );
        if (!sniffed.verdict()) {
          yield* discard;
          return yield* rejected;
        }
        const result = yield* store
          .transaction(
            Effect.gen(function* () {
              const expense = yield* lockLive(workspaceId, id);
              // The Expense row lock serializes attaches, so the hash index cannot race here.
              const existing = yield* repo.findAttachmentBySha(workspaceId, id, put.sha256);
              if (Option.isSome(existing)) {
                // Same content on this Expense: attach is idempotent by hash.
                yield* store.afterCommit(discard);
                return { row: existing.value, expenseRevision: expense.revision };
              }
              const now = yield* nowIso;
              const row = yield* repo.insertAttachment({
                id: attachmentId,
                workspaceId,
                revision: 1,
                expenseId: id,
                blobKey: key,
                name:
                  EffectString.trim(file.name) === "" ? "attachment" : EffectString.trim(file.name),
                contentType,
                bytes: put.bytes,
                sha256: put.sha256,
                createdAt: now,
              });
              const saved = yield* repo.update({ ...expense, updatedAt: now }, expense.revision);
              yield* appendAudit(caller, {
                workspaceId,
                subject: subject(id),
                action: "expense.attach",
                revision: saved.revision,
                changes: [{ path: "attachments", before: null, after: row.id }],
              });
              return { row, expenseRevision: saved.revision };
            }),
          )
          .pipe(
            Effect.tapError((e) => {
              const rolledBack = surelyRolledBack(e);
              return discard.pipe(Effect.when(Effect.succeed(rolledBack)));
            }),
          );
        const { row, expenseRevision } = result;
        return encodeAttachment({
          id: row.id,
          expenseId: row.expenseId,
          name: row.name,
          contentType: row.contentType,
          bytes: row.bytes,
          sha256: row.sha256,
          createdAt: row.createdAt,
          expenseRevision,
        });
      }).pipe(
        // The Expense row is locked in the transaction, so its update cannot race.
        Effect.catchTag("Conflict", (e) => Effect.die(e)),
        orUnavailable,
        dieOnUnique,
      ),
    );

  /** The attachment if it exists; one of another Expense is NotFound. */
  const findAttachmentOf = (ws: WorkspaceId, id: ExpenseId, attachment: AttachmentId) =>
    Effect.filterOrFail(
      repo.findAttachment(ws, attachment),
      (found) => !(Option.isSome(found) && found.value.expenseId !== id),
      () => NotFound.make({ entity: "Attachment", id: attachment }),
    );

  const detach: ExpensesImpl["detach"] = (caller, id, attachment) =>
    provide(
      Effect.gen(function* () {
        const { workspaceId } = yield* authorizeInWorkspace(caller, "expense.write");
        yield* store.transaction(
          Effect.gen(function* () {
            const expense = yield* lockLive(workspaceId, id);
            const found = yield* findAttachmentOf(workspaceId, id, attachment);
            // Idempotent by state (C6): an attachment already gone is detached; no audit.
            if (Option.isNone(found)) return;
            const row = found.value;
            yield* repo.removeAttachment(workspaceId, row.id, row.revision);
            const saved = yield* repo.update(
              { ...expense, updatedAt: yield* nowIso },
              expense.revision,
            );
            yield* appendAudit(caller, {
              workspaceId,
              subject: subject(id),
              action: "expense.detach",
              revision: saved.revision,
              changes: [{ path: "attachments", before: row.id, after: null }],
            });
            yield* store.afterCommit(blobs.delete(BlobKey.make(row.blobKey)).pipe(Effect.ignore));
          }),
        );
      }).pipe(
        // The attachment row is locked under the Expense lock, so its delete cannot race.
        Effect.catchTag("Conflict", (e) => Effect.die(e)),
        orUnavailable,
        dieOnUnique,
      ),
    );

  const attachmentRead: ExpensesImpl["attachment"] = (caller, id, attachment) =>
    provide(
      Effect.gen(function* () {
        const { workspaceId } = yield* authorizeInWorkspace(caller, "expense.attachment.read");
        yield* getLive(workspaceId, id);
        const found = yield* findAttachmentOf(workspaceId, id, attachment);
        if (Option.isNone(found)) {
          return yield* NotFound.make({ entity: "Attachment", id: attachment });
        }
        const row = found.value;
        const bytes = yield* blobs.get(BlobKey.make(row.blobKey)).pipe(
          // A row whose blob is gone is a storage fault, not a missing record.
          Effect.catchTag("BlobMissing", () =>
            Effect.fail(Unavailable.make({ dependency: "blob_storage" })),
          ),
        );
        return { filename: row.name, contentType: row.contentType, bytes } satisfies FileDownload;
      }).pipe(orUnavailable),
    );

  const get: ExpensesImpl["get"] = (caller, id) =>
    provide(
      Effect.gen(function* () {
        const { workspaceId } = yield* authorizeInWorkspace(caller, "expense.read");
        // One snapshot for the row and its attachments, so the view matches its revision.
        const { row, attachments } = yield* store.transaction(repo.detail(workspaceId, id));
        if (row.removedAt !== null) return yield* notFound(id);
        return encodeView(viewFields(row, attachments));
      }).pipe(orUnavailable),
    );

  const list: ExpensesImpl["list"] = (caller, q) =>
    provide(
      Effect.gen(function* () {
        const { workspaceId } = yield* authorizeInWorkspace(caller, "expense.read");
        const limit = q.limit ?? DEFAULT_LIMIT;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          return yield* invalid("request.malformed", ["limit"]);
        }
        const filter = q.incomplete === true ? "incomplete" : "all";
        let beforeId: ExpenseId | undefined;
        if (q.cursor !== undefined) {
          const cursor = decodeCursor(q.cursor);
          if (cursor === null) return yield* invalid("request.malformed", ["cursor"]);
          if (cursor[0] !== filter) return yield* invalid("page.cursor_mismatch", ["cursor"]);
          beforeId = cursor[1];
        }
        // Rows and attachment counts come from one snapshot (one repository read).
        const rows = yield* store.transaction(
          repo.page(workspaceId, {
            status: filter === "incomplete" ? "incomplete" : undefined,
            beforeId,
            limit: limit + 1,
          }),
        );
        const items = rows.slice(0, limit);
        const last = items.at(-1);
        return {
          items: EffectArray.map(items, (r) => encodeSummary(summaryFields(r.row, r.attachments))),
          nextCursor:
            rows.length > limit && last !== undefined
              ? yield* encodeCursor([filter, last.row.id]).pipe(Effect.orDie)
              : null,
        };
      }).pipe(orUnavailable),
    );

  const impl: ExpensesImpl = {
    record,
    edit,
    remove,
    attach,
    detach,
    attachment: attachmentRead,
    get,
    list,
  };
  return impl;
});

/** Expenses has no unique index a caller can break (the attachment hash is checked first). */
function dieOnUnique<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, { readonly _tag: "UniqueViolation" }>, R>;
function dieOnUnique<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return Effect.catchIf(
    effect,
    (error) => Predicate.hasProperty(error, "_tag") && error._tag === "UniqueViolation",
    Effect.die,
  );
}

/** `Expenses` with configurable attachment limits. */
export const makeExpensesLive = (options: ExpensesOptions = {}) =>
  Layer.effect(Expenses, makeExpenses(options));

/** `Expenses` with the default limits (20 MB; PDF, JPEG, PNG, HEIC). */
export const ExpensesLive = makeExpensesLive();
