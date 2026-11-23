/**
 * `ExpensesLive`: the domain `Expenses` tag (core-ports 4.7) on `ExpensesRepo`, `CoreStore`,
 * `BlobStorage`, `ExchangeRates` and `ExpenseSuppliers`.
 *
 * Method shape (src/index.ts): authorize -> withIdempotency / transaction -> lock + revision ->
 * rules -> write -> appendAudit -> orUnavailable. The domain tag omits errors the spec and the
 * store require (`remove` has no Unavailable, `detach` neither Unavailable nor Conflict-free
 * storage); `ExpensesImpl` keeps them honest and `asTagService` is the one cast (board #340/#341).
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
import { BigDecimal, Clock, Effect, Layer, Option, Result } from "effect";
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
  needsFixing,
  percentOf,
  summaryFields,
  taxPointOf,
  validateComplete,
  viewFields,
} from "./model";
import { ExpensesRepo } from "./repo";
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

type Wide = NotFound | Invalid | Conflict | Unavailable | Forbidden;

/** The honest service: every error the spec and the store can produce. */
export interface ExpensesImpl {
  readonly record: (
    input: ExpenseInputType,
    opts?: RequestOptions,
  ) => Effect.Effect<ExpenseView, Wide, CurrentCaller>;
  readonly edit: (
    id: ExpenseId,
    patch: ExpensePatch,
    expectedRevision: number,
  ) => Effect.Effect<ExpenseView, Wide, CurrentCaller>;
  readonly remove: (
    id: ExpenseId,
    expectedRevision: number,
  ) => Effect.Effect<void, Wide, CurrentCaller>;
  readonly attach: (
    id: ExpenseId,
    file: {
      readonly name: string;
      readonly contentType: string;
      readonly bytes: Stream.Stream<Uint8Array>;
    },
  ) => Effect.Effect<AttachmentView, Wide, CurrentCaller>;
  readonly detach: (
    id: ExpenseId,
    attachment: AttachmentId,
  ) => Effect.Effect<void, Wide, CurrentCaller>;
  readonly attachment: (
    id: ExpenseId,
    attachment: AttachmentId,
  ) => Effect.Effect<FileDownload, Wide, CurrentCaller>;
  readonly get: (id: ExpenseId) => Effect.Effect<ExpenseView, Wide, CurrentCaller>;
  readonly list: (q: ExpenseQuery) => Effect.Effect<Page<ExpenseSummary>, Wide, CurrentCaller>;
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
  "deductibility",
  "category",
  "tags",
  "note",
];

const encodeCursor = (filter: string, id: ExpenseId) => btoa(JSON.stringify([filter, id]));
const decodeCursor = (cursor: string): readonly [string, ExpenseId] | null => {
  try {
    const value: unknown = JSON.parse(atob(cursor));
    return Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string" &&
      typeof value[1] === "string"
      ? [value[0], value[1] as ExpenseId]
      : null;
  } catch {
    return null;
  }
};

export const makeExpenses = (options: ExpensesOptions = {}) =>
  Effect.gen(function* () {
    const maxBytes = options.maxAttachmentBytes ?? ATTACHMENT_MAX_BYTES;
    const types = options.attachmentTypes ?? ATTACHMENT_TYPES;
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

    /** A live Expense of the Workspace; removed or foreign is NotFound (R2). */
    const getLive = (ws: WorkspaceId, id: ExpenseId) =>
      Effect.flatMap(repo.get(ws, id), (row) =>
        row.removedAt === null ? Effect.succeed(row) : Effect.fail(notFound(id)),
      );
    const lockLive = (ws: WorkspaceId, id: ExpenseId) =>
      Effect.flatMap(repo.lock(ws, id), (row) =>
        row.removedAt === null ? Effect.succeed(row) : Effect.fail(notFound(id)),
      );

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
              : fields.total && BigDecimal.normalize(fields.total),
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

    /** Full validation and derived figures for a complete Expense; none for an incomplete one. */
    const finish = (row: ExpenseRow) =>
      Effect.gen(function* () {
        if (row.status === "incomplete") return { ...row, figures: null };
        const [first, ...rest] = validateComplete(row);
        if (first !== undefined) return yield* new Invalid({ issues: [first, ...rest] });
        const fixing = needsFixing(row) ? yield* rates.fixing(taxPointOf(row) as IsoDate) : null;
        const figures = computeFigures(row, fixing);
        if (Result.isFailure(figures)) return yield* figures.failure;
        return { ...row, figures: figures.success };
      });

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

    const record: ExpensesImpl["record"] = (input, opts) =>
      provide(
        Effect.gen(function* () {
          const { workspaceId } = yield* authorizeInWorkspace("expense.write");
          const fields = yield* decodeFields(input);
          return yield* withIdempotency(
            {
              scope: { _tag: "Workspace", workspaceId },
              key: opts?.requestKey,
              method: "Expenses.record",
              payload: { schema: ExpenseInput, value: input },
              result: ExpenseViewSchema,
            },
            Effect.gen(function* () {
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
              const row = yield* finish(yield* applyFields(empty, fields));
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
          const fields = yield* decodeFields(patch);
          return yield* store.transaction(
            Effect.gen(function* () {
              const current = yield* checkRevision(
                yield* lockLive(workspaceId, id),
                expectedRevision,
              );
              const merged = yield* applyFields(current, fields);
              if (current.payments > 0) {
                // A paid Expense keeps the currency its Payments are in (P1) and stays complete.
                if (merged.currency !== current.currency) {
                  return yield* invalid("payment.currency_mismatch", ["currency"]);
                }
                if (merged.status === "incomplete") {
                  return yield* invalid("expense.incomplete", ["status"]);
                }
              }
              const next = yield* finish({ ...merged, updatedAt: yield* nowIso });
              const saved = yield* repo.update(next, current.revision);
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
          if (!types.includes(contentType)) {
            return yield* invalid("attachment.type_rejected", ["file", "contentType"]);
          }
          yield* getLive(workspaceId, id);
          const attachmentId = yield* newId<AttachmentId>();
          const key = attachmentKey(workspaceId, id, attachmentId);
          // Streamed before the transaction; a blob whose row never commits is collected by
          // housekeeping after 24 h (core-ports 4.7), and deleted at once when we know.
          const put = yield* blobs
            .put(key, file.bytes, { contentType, maxBytes })
            .pipe(
              Effect.catchTag("BlobTooLarge", (e) =>
                Effect.fail(
                  invalid("attachment.too_large", ["file"], { maxBytes: String(e.maxBytes) }),
                ),
              ),
            );
          const discard = blobs.delete(key).pipe(Effect.ignore);
          const view = yield* store
            .transaction(
              Effect.gen(function* () {
                const expense = yield* lockLive(workspaceId, id);
                const existing = yield* repo.findAttachmentBySha(workspaceId, id, put.sha256);
                // The Expense row lock serializes attaches, so the hash index cannot race here.
                if (Option.isSome(existing)) {
                  // Same content on this Expense: attach is idempotent by hash.
                  yield* store.afterCommit(discard);
                  return existing.value;
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
                return row;
              }),
            )
            .pipe(Effect.tapError(() => discard));
          return encodeAttachment({
            id: view.id,
            expenseId: view.expenseId,
            name: view.name,
            contentType: view.contentType,
            bytes: view.bytes,
            sha256: view.sha256,
            createdAt: view.createdAt,
          }) as unknown as AttachmentView;
        }).pipe(orUnavailable, dieOnUnique),
      );

    /** The attachment of a live Expense; one of another Expense is NotFound. */
    const attachmentOf = (ws: WorkspaceId, id: ExpenseId, attachment: AttachmentId) =>
      Effect.flatMap(repo.getAttachment(ws, attachment), (row) =>
        row.expenseId === id
          ? Effect.succeed(row)
          : Effect.fail(new NotFound({ entity: "Attachment", id: attachment })),
      );

    const detach: ExpensesImpl["detach"] = (id, attachment) =>
      provide(
        Effect.gen(function* () {
          const { workspaceId } = yield* authorizeInWorkspace("expense.write");
          yield* store.transaction(
            Effect.gen(function* () {
              const expense = yield* lockLive(workspaceId, id);
              const row = yield* attachmentOf(workspaceId, id, attachment);
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
        }).pipe(orUnavailable, dieOnUnique),
      );

    const attachmentRead: ExpensesImpl["attachment"] = (id, attachment) =>
      provide(
        Effect.gen(function* () {
          const { workspaceId } = yield* authorizeInWorkspace("expense.attachment.read");
          yield* getLive(workspaceId, id);
          const row = yield* attachmentOf(workspaceId, id, attachment);
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
          return yield* viewOf(workspaceId, yield* getLive(workspaceId, id));
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
          const rows = yield* repo.page(workspaceId, {
            ...(filter === "incomplete" ? { status: "incomplete" as const } : {}),
            ...(beforeId === undefined ? {} : { beforeId }),
            limit: limit + 1,
          });
          const items = rows.slice(0, limit);
          const atts = yield* repo.attachmentsOf(
            workspaceId,
            items.map((r) => r.id),
          );
          const counts = new Map<string, number>();
          for (const a of atts) counts.set(a.expenseId, (counts.get(a.expenseId) ?? 0) + 1);
          const last = items.at(-1);
          return {
            items: items.map(
              (r) =>
                encodeSummary(summaryFields(r, counts.get(r.id) ?? 0)) as unknown as ExpenseSummary,
            ),
            nextCursor:
              rows.length > limit && last !== undefined ? encodeCursor(filter, last.id) : null,
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
