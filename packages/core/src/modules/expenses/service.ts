/**
 * `ExpensesLive`: the domain `Expenses` tag (core-ports 4.7) on `ExpensesRepo`, `CoreStore`,
 * `BlobStorage`, `ExchangeRates` and `ExpenseSuppliers`.
 *
 * Method shape (src/index.ts): authorize -> withIdempotency / transaction -> lock + revision ->
 * rules -> write -> appendAudit -> orUnavailable. `ExpensesImpl` declares each method's honest
 * errors; where the frozen domain tag omits one (record: Conflict{idempotency_mismatch};
 * remove, detach, get, list: Unavailable), `asTagService` is the one cast (board #340/#341).
 *
 * External calls (supplier lookup through Contacts/ARES, the CNB fixing) never run under the
 * Expense row lock: `edit` prepares the next row from an unlocked read, then locks and re-checks
 * the revision. `record` runs them inside its idempotent transaction, which holds only the
 * request-log claim, so a reused key is matched (C3) before any input is judged.
 */
import type {
  AttachmentId,
  AttachmentView,
  CurrentCaller,
  ExpenseId,
  ExpenseInput as ExpenseInputType,
  ExpensePatch,
  ExpenseQuery,
  ExpenseSummary,
  ExpenseView,
  FileDownload,
  Forbidden,
  IsoDate,
  Page,
  RequestOptions,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import {
  Conflict,
  ExpenseId as ExpenseIdSchema,
  ExpenseInput,
  Expenses,
  ExpenseView as ExpenseViewSchema,
  Invalid,
  NotFound,
  Unavailable,
} from "@kvitbit/domain/contract";
import type { BlobKey } from "@kvitbit/domain/ports";
import { BlobStorage, ExchangeRates } from "@kvitbit/domain/ports";
import type { Stream } from "effect";
import { BigDecimal, Clock, Effect, Layer, Option, Result, Schema } from "effect";
import type { FxRate } from "../../engines/fx";
import { authorizeInWorkspace } from "../../policy/Policy";
import { appendAudit } from "../../shared/audit";
import { canonicalJson } from "../../shared/canonicalJson";
import { orUnavailable } from "../../shared/errors";
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
export const attachmentKey = (
  workspaceId: WorkspaceId,
  expenseId: ExpenseId,
  attachmentId: AttachmentId,
): BlobKey =>
  `workspaces/${workspaceId}/expenses/${expenseId}/attachments/${attachmentId}` as BlobKey;

const DEFAULT_LIMIT = 50;

/** The honest service: each method's errors as the spec and the store produce them. */
export interface ExpensesImpl {
  readonly record: (
    input: ExpenseInputType,
    opts?: RequestOptions,
  ) => Effect.Effect<
    ExpenseView,
    Invalid | NotFound | Unavailable | Forbidden | Conflict,
    CurrentCaller
  >;
  readonly edit: (
    id: ExpenseId,
    patch: ExpensePatch,
    expectedRevision: number,
  ) => Effect.Effect<
    ExpenseView,
    NotFound | Invalid | Conflict | Unavailable | Forbidden,
    CurrentCaller
  >;
  readonly remove: (
    id: ExpenseId,
    expectedRevision: number,
  ) => Effect.Effect<void, NotFound | Conflict | Forbidden | Unavailable, CurrentCaller>;
  readonly attach: (
    id: ExpenseId,
    file: {
      readonly name: string;
      readonly contentType: string;
      readonly bytes: Stream.Stream<Uint8Array>;
    },
  ) => Effect.Effect<AttachmentView, NotFound | Invalid | Unavailable | Forbidden, CurrentCaller>;
  readonly detach: (
    id: ExpenseId,
    attachment: AttachmentId,
  ) => Effect.Effect<void, NotFound | Forbidden | Unavailable, CurrentCaller>;
  readonly attachment: (
    id: ExpenseId,
    attachment: AttachmentId,
  ) => Effect.Effect<FileDownload, NotFound | Unavailable | Forbidden, CurrentCaller>;
  readonly get: (
    id: ExpenseId,
  ) => Effect.Effect<ExpenseView, NotFound | Forbidden | Unavailable, CurrentCaller>;
  readonly list: (
    q: ExpenseQuery,
  ) => Effect.Effect<Page<ExpenseSummary>, Invalid | Forbidden | Unavailable, CurrentCaller>;
}

/** A service shape with every method's error channel erased; the rest stays checked. */
type ErasedErrors<S> = {
  readonly [K in keyof S]: S[K] extends (
    ...args: infer A
  ) => Effect.Effect<infer X, unknown, infer R>
    ? (...args: A) => Effect.Effect<X, never, R>
    : S[K];
};

/**
 * The one unchecked step between the honest implementation and the frozen domain tag:
 * arguments, success values and requirements must match (`checked` fails to compile
 * otherwise); only the error channels are cast.
 */
const asTagService = <Tag, Impl>(
  impl: Impl,
  checked: (impl: ErasedErrors<Impl>) => ErasedErrors<Tag>,
): Tag => checked(impl as unknown as ErasedErrors<Impl>) as unknown as Tag;

const nowIso = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString());

const notFound = (id: ExpenseId) => new NotFound({ entity: "Expense", id });

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
const encodeCursor = (filter: string, id: ExpenseId) => btoa(JSON.stringify([filter, id]));
const isExpenseId = Schema.is(ExpenseIdSchema);
const decodeCursor = (cursor: string): readonly [string, ExpenseId] | null => {
  try {
    const value: unknown = JSON.parse(atob(cursor));
    return Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string" &&
      isExpenseId(value[1])
      ? [value[0], value[1]]
      : null;
  } catch {
    return null;
  }
};

/** Errors the transaction surely rolled back on; a store failure may hide a commit. */
const surelyRolledBack = (e: { readonly _tag: string }) => e._tag !== "StoreUnavailable";

export const makeExpenses = (options: ExpensesOptions = {}) =>
  Effect.gen(function* () {
    const maxBytes = options.maxAttachmentBytes ?? ATTACHMENT_MAX_BYTES;
    const types = (options.attachmentTypes ?? ATTACHMENT_TYPES).filter((t) =>
      SNIFFABLE_TYPES.includes(t),
    );
    const store = yield* CoreStore;
    const repo = yield* ExpensesRepo;
    const blobs = yield* BlobStorage;
    const rates = yield* ExchangeRates;
    const suppliers = yield* ExpenseSuppliers;
    const ids = yield* IdGenerator;

    const provide = <A, E>(
      effect: Effect.Effect<A, E, CurrentCaller | CoreStore | IdGenerator>,
    ): Effect.Effect<A, E, CurrentCaller> =>
      effect.pipe(Effect.provideService(CoreStore, store), Effect.provideService(IdGenerator, ids));

    const live = (row: ExpenseRow) =>
      row.removedAt === null ? Effect.succeed(row) : Effect.fail(notFound(row.id));
    /** A live Expense of the Workspace; removed or foreign is NotFound (R2). */
    const getLive = (ws: WorkspaceId, id: ExpenseId) => Effect.flatMap(repo.get(ws, id), live);
    const lockLive = (ws: WorkspaceId, id: ExpenseId) => Effect.flatMap(repo.lock(ws, id), live);

    const resolveSupplier = (ref: SupplierRef) =>
      "contact" in ref
        ? suppliers.contact(ref.contact)
        : "ico" in ref
          ? suppliers.fromIco(ref.ico)
          : Effect.succeed<SupplierRecord>({
              contactId: null,
              name: ref.manual.name,
              ico: ref.manual.ico ?? null,
              dic: ref.manual.dic ?? null,
            });

    /** Applies the given fields onto `base` (absent keys keep, null clears). */
    const applyFields = (base: ExpenseRow, fields: ExpenseFields) =>
      Effect.gen(function* () {
        const supplier =
          fields.supplier === undefined
            ? base.supplier
            : fields.supplier === null
              ? null
              : yield* resolveSupplier(fields.supplier);
        const pick = <K extends keyof ExpenseFields & keyof ExpenseRow>(key: K): ExpenseRow[K] =>
          (fields[key] === undefined ? base[key] : fields[key]) as ExpenseRow[K];
        const next: ExpenseRow = {
          ...base,
          status: fields.status ?? base.status,
          supplier,
          supplierDocumentNumber: pick("supplierDocumentNumber"),
          issuedOn: pick("issuedOn"),
          taxableSupplyOn: pick("taxableSupplyOn"),
          dueOn: pick("dueOn"),
          currency: pick("currency"),
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
                : fields.vat.map((l) => ({
                    treatment: l.treatment,
                    base: BigDecimal.normalize(l.base),
                    vat: BigDecimal.normalize(l.vat ?? BigDecimal.fromBigInt(0n)),
                    selfAssessed: l.selfAssessed ?? null,
                  })),
          deductiblePercent:
            fields.deductibility === undefined
              ? base.deductiblePercent
              : percentOf(fields.deductibility),
          category: pick("category"),
          tags: fields.tags === undefined ? base.tags : [...fields.tags],
          note: pick("note"),
        };
        return next;
      });

    /**
     * The rate for a complete row: the previous row's stored rate when currency and tax point are
     * unchanged (an unrelated edit never moves the CZK figures), else a fresh CNB fixing.
     */
    const rateFor = (row: ExpenseRow, previous: ExpenseRow | null) =>
      Effect.gen(function* () {
        if (!needsFixing(row)) return null;
        const prior = previous?.figures?.fx ?? null;
        if (
          prior !== null &&
          previous !== null &&
          previous.currency === row.currency &&
          taxPointOf(previous) === taxPointOf(row)
        ) {
          return prior as FxRate;
        }
        const fixing = yield* rates.fixing(taxPointOf(row) as IsoDate);
        const fx = resolveFx(row, fixing);
        return Result.isFailure(fx) ? yield* fx.failure : fx.success;
      });

    /** The complete-Expense checks; fails with every issue at once. */
    const validate = (row: ExpenseRow) => {
      const [first, ...rest] = validateComplete(row);
      return first === undefined
        ? Effect.void
        : Effect.fail(new Invalid({ issues: [first, ...rest] }));
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
        : Effect.as(validate(row), { ...row, figures: computeFigures(row, fx) });

    const viewOf = (ws: WorkspaceId, row: ExpenseRow) =>
      Effect.map(
        repo.attachmentsOf(ws, [row.id]),
        (atts) => encodeView(viewFields(row, atts)) as unknown as ExpenseView,
      );

    const auditChanges = (before: ExpenseRow, after: ExpenseRow) => {
      const b = encodeView(viewFields(before, [])) as Record<string, unknown>;
      const a = encodeView(viewFields(after, [])) as Record<string, unknown>;
      return AUDITED.flatMap((key) =>
        canonicalJson(b[key]) === canonicalJson(a[key])
          ? []
          : [{ path: key, before: b[key] ?? null, after: a[key] ?? null }],
      );
    };

    const subject = (id: ExpenseId) => ({ entity: "Expense" as const, id });

    /** Open fields must be plain JSON (what the wire delivers) to be fingerprinted (C3). */
    const requireJson = (value: unknown) =>
      isJsonValue(value) ? Effect.void : Effect.fail(invalid("request.malformed", []));

    const record: ExpensesImpl["record"] = (input, opts) =>
      provide(
        Effect.gen(function* () {
          const { workspaceId } = yield* authorizeInWorkspace("expense.write");
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
                id: yield* newId<ExpenseId>(),
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
              const merged = yield* applyFields(empty, fields);
              const row = yield* finish(merged, yield* prepareRate(merged, null));
              const saved = yield* repo.insert(row);
              yield* appendAudit({
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

    const edit: ExpensesImpl["edit"] = (id, patch, expectedRevision) =>
      provide(
        Effect.gen(function* () {
          const { workspaceId } = yield* authorizeInWorkspace("expense.write");
          yield* requireJson(patch);
          const fields = yield* decodeFields(patch);
          // The CNB fixing (read-only, may call out) is fetched before the lock, from an unlocked
          // read at the expected revision; the supplier is resolved inside the transaction because
          // `fromIco` may upsert a Contact, which must roll back with a failed edit (C1).
          const seen = yield* checkRevision(yield* getLive(workspaceId, id), expectedRevision);
          const fx = yield* prepareRate(
            yield* applyFields(seen, { ...fields, supplier: undefined }),
            seen,
          );
          return yield* store.transaction(
            Effect.gen(function* () {
              // Same revision as `seen`, so `fx` was derived from the row now locked.
              const current = yield* checkRevision(
                yield* lockLive(workspaceId, id),
                expectedRevision,
              );
              const prepared = yield* finish(
                { ...(yield* applyFields(current, fields)), updatedAt: yield* nowIso },
                fx,
              );
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
              yield* appendAudit({
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

    const remove: ExpensesImpl["remove"] = (id, expectedRevision) =>
      provide(
        Effect.gen(function* () {
          const { workspaceId } = yield* authorizeInWorkspace("expense.write");
          yield* store.transaction(
            Effect.gen(function* () {
              const current = yield* checkRevision(
                yield* lockLive(workspaceId, id),
                expectedRevision,
              );
              if (current.payments > 0) {
                return yield* new Conflict({ reason: "illegal_transition" });
              }
              const now = yield* nowIso;
              const saved = yield* repo.update(
                { ...current, removedAt: now, updatedAt: now },
                current.revision,
              );
              yield* appendAudit({
                workspaceId,
                subject: subject(id),
                action: "expense.remove",
                revision: saved.revision,
              });
            }),
          );
        }).pipe(orUnavailable, dieOnUnique),
      );

    const attach: ExpensesImpl["attach"] = (id, file) =>
      provide(
        Effect.gen(function* () {
          const { workspaceId } = yield* authorizeInWorkspace("expense.write");
          const contentType = (file.contentType.split(";")[0] ?? "").trim().toLowerCase();
          const rejected = invalid("attachment.type_rejected", ["file", "contentType"]);
          if (!types.includes(contentType)) return yield* rejected;
          yield* getLive(workspaceId, id);
          const attachmentId = yield* newId<AttachmentId>();
          const key = attachmentKey(workspaceId, id, attachmentId);
          const discard = blobs.delete(key).pipe(Effect.ignore);
          // Streamed before the transaction and committed with the row; a blob whose row never
          // commits is deleted here when the rollback is certain, else collected by housekeeping
          // after 24 h (core-ports 4.7). The prefix is sniffed while streaming.
          const sniffed = sniffing(contentType, file.bytes, maxBytes);
          const put = yield* blobs
            .put(key, sniffed.stream, { contentType, maxBytes })
            .pipe(
              Effect.catchTag("BlobTooLarge", (e) =>
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
                  name: file.name.trim() === "" ? "attachment" : file.name.trim(),
                  contentType,
                  bytes: put.bytes,
                  sha256: put.sha256,
                  createdAt: now,
                });
                const saved = yield* repo.update({ ...expense, updatedAt: now }, expense.revision);
                yield* appendAudit({
                  workspaceId,
                  subject: subject(id),
                  action: "expense.attach",
                  revision: saved.revision,
                  changes: [{ path: "attachments", before: null, after: row.id }],
                });
                return { row, expenseRevision: saved.revision };
              }),
            )
            .pipe(Effect.tapError((e) => (surelyRolledBack(e) ? discard : Effect.void)));
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
          }) as unknown as AttachmentView;
        }).pipe(
          // The Expense row is locked in the transaction, so its update cannot race.
          Effect.catchTag("Conflict", (e) => Effect.die(e)),
          orUnavailable,
          dieOnUnique,
        ),
      );

    /** The attachment if it exists; one of another Expense is NotFound. */
    const findAttachmentOf = (ws: WorkspaceId, id: ExpenseId, attachment: AttachmentId) =>
      Effect.flatMap(repo.findAttachment(ws, attachment), (found) =>
        Option.isSome(found) && found.value.expenseId !== id
          ? Effect.fail(new NotFound({ entity: "Attachment", id: attachment }))
          : Effect.succeed(found),
      );

    const detach: ExpensesImpl["detach"] = (id, attachment) =>
      provide(
        Effect.gen(function* () {
          const { workspaceId } = yield* authorizeInWorkspace("expense.write");
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
              yield* appendAudit({
                workspaceId,
                subject: subject(id),
                action: "expense.detach",
                revision: saved.revision,
                changes: [{ path: "attachments", before: row.id, after: null }],
              });
              yield* store.afterCommit(blobs.delete(row.blobKey as BlobKey).pipe(Effect.ignore));
            }),
          );
        }).pipe(
          // The attachment row is locked under the Expense lock, so its delete cannot race.
          Effect.catchTag("Conflict", (e) => Effect.die(e)),
          orUnavailable,
          dieOnUnique,
        ),
      );

    const attachmentRead: ExpensesImpl["attachment"] = (id, attachment) =>
      provide(
        Effect.gen(function* () {
          const { workspaceId } = yield* authorizeInWorkspace("expense.attachment.read");
          yield* getLive(workspaceId, id);
          const found = yield* findAttachmentOf(workspaceId, id, attachment);
          if (Option.isNone(found)) {
            return yield* new NotFound({ entity: "Attachment", id: attachment });
          }
          const row = found.value;
          const bytes = yield* blobs.get(row.blobKey as BlobKey).pipe(
            // A row whose blob is gone is a storage fault, not a missing record.
            Effect.catchTag("BlobMissing", () =>
              Effect.fail(new Unavailable({ dependency: "blob_storage" })),
            ),
          );
          return { filename: row.name, contentType: row.contentType, bytes } satisfies FileDownload;
        }).pipe(orUnavailable),
      );

    const get: ExpensesImpl["get"] = (id) =>
      provide(
        Effect.gen(function* () {
          const { workspaceId } = yield* authorizeInWorkspace("expense.read");
          // One snapshot for the row and its attachments, so the view matches its revision.
          const { row, attachments } = yield* store.transaction(repo.detail(workspaceId, id));
          if (row.removedAt !== null) return yield* notFound(id);
          return encodeView(viewFields(row, attachments)) as unknown as ExpenseView;
        }).pipe(orUnavailable),
      );

    const list: ExpensesImpl["list"] = (q) =>
      provide(
        Effect.gen(function* () {
          const { workspaceId } = yield* authorizeInWorkspace("expense.read");
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
              ...(filter === "incomplete" ? { status: "incomplete" as const } : {}),
              ...(beforeId === undefined ? {} : { beforeId }),
              limit: limit + 1,
            }),
          );
          const items = rows.slice(0, limit);
          const last = items.at(-1);
          return {
            items: items.map(
              (r) =>
                encodeSummary(summaryFields(r.row, r.attachments)) as unknown as ExpenseSummary,
            ),
            nextCursor:
              rows.length > limit && last !== undefined ? encodeCursor(filter, last.row.id) : null,
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
const dieOnUnique = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchIf(
    effect,
    (e): e is Extract<E, { readonly _tag: "UniqueViolation" }> =>
      typeof e === "object" && e !== null && "_tag" in e && e._tag === "UniqueViolation",
    (e) => Effect.die(e),
  ) as Effect.Effect<A, Exclude<E, { readonly _tag: "UniqueViolation" }>, R>;

/** `Expenses` with configurable attachment limits. */
export const makeExpensesLive = (options: ExpensesOptions = {}) =>
  Layer.effect(
    Expenses,
    Effect.map(makeExpenses(options), (impl) =>
      asTagService<Expenses["Service"], ExpensesImpl>(impl, (checked) => checked),
    ),
  );

/** `Expenses` with the default limits (20 MB; PDF, JPEG, PNG, HEIC). */
export const ExpensesLive = makeExpensesLive();
