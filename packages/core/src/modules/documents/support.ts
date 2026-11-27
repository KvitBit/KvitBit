/** Helpers shared by the Documents method files. */

import type { DocumentId, DocumentView, WorkspaceId } from "@kvitbit/domain/contract";
import { Conflict } from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { pragueDate } from "../../engines/calendar";
import { ZERO } from "../../engines/decimal";
import { CoreStore, type StoreUnavailable, type UniqueViolation } from "../../store/CoreStore";
import { DocumentActivity } from "./activity";
import type { Composed } from "./compose";
import { type DocumentRecord, NUMBER_PER_KIND } from "./record";
import { DocumentsRepo } from "./repo";
import type { RelatedDocument, ViewContext } from "./view";
import { toView } from "./view";

/** Prague today and the current instant (ISO). */
export const now = Effect.map(Clock.currentTimeMillis, (millis) => ({
  today: pragueDate(millis),
  at: DateTime.formatIso(DateTime.makeUnsafe(millis)),
}));

/** A new draft record from composed fields. */
export const newDraftRecord: {
  (workspaceId: WorkspaceId, composed: Composed, at: string): (id: DocumentId) => DocumentRecord;
  (id: DocumentId, workspaceId: WorkspaceId, composed: Composed, at: string): DocumentRecord;
} = Fn.dual(
  4,
  (id: DocumentId, workspaceId: WorkspaceId, composed: Composed, at: string): DocumentRecord => ({
    ...composed,
    id,
    workspaceId,
    revision: 1,
    status: "draft",
    locked: false,
    lockedAt: null,
    number: null,
    remindersChoice: "inherit",
    remindersOn: false,
    links: [],
    paidAmount: ZERO,
    payments: 0,
    settlement: "unpaid",
    scheduleId: null,
    occurrence: null,
    cancelledOn: null,
    correctedNumber: null,
    reason: null,
    createdAt: at,
    updatedAt: at,
    issuedAt: null,
  }),
);

/** Linked documents that carry a number, for `DocumentView.related`. */
export const relatedOf = (
  row: DocumentRecord,
): Effect.Effect<ReadonlyArray<RelatedDocument>, StoreUnavailable, DocumentsRepo> =>
  row.links.length === 0
    ? Effect.succeed([])
    : Effect.gen(function* () {
        const repo = yield* DocumentsRepo;
        const linked = yield* repo.getMany(
          row.workspaceId,
          EffectArray.map(row.links, (l) => l.id),
        );
        const byId = new Map(EffectArray.map(linked, (d) => [d.id, d]));
        return EffectArray.flatMap(row.links, (l): ReadonlyArray<RelatedDocument> => {
          const d = byId.get(l.id);
          // A Credit Note prints the corrected number as it was at correction time (D7).
          const number = l.relation === "corrects" ? (row.correctedNumber ?? d?.number) : d?.number;
          return d !== undefined && number !== undefined && number !== null && number !== ""
            ? [{ relation: l.relation, id: d.id, kind: d.kind, number }]
            : [];
        });
      });

/**
 * The stored view of a record as of now: `share: null`, `deliveries: []`. It is what delivery
 * snapshots, idempotency results, the renderer and share-link visitors get, so a bearer share
 * URL or the delivery history never lands in stored or replayed data (core-ports.md 66-68).
 * Owner reads add them with `withActivity`; write results never carry them (rule C3).
 */
export const viewOf: {
  (
    row: DocumentRecord,
    extra?: Pick<ViewContext, "language">,
  ): Effect.Effect<DocumentView, StoreUnavailable, DocumentsRepo>;
  (
    extra?: Pick<ViewContext, "language">,
  ): (row: DocumentRecord) => Effect.Effect<DocumentView, StoreUnavailable, DocumentsRepo>;
} = Fn.dual(
  (args) => Predicate.hasProperty(args[0], "id"),
  Effect.fnUntraced(function* (row: DocumentRecord, extra?: Pick<ViewContext, "language">) {
    const { today } = yield* now;
    const related = yield* relatedOf(row);
    return toView(row, { ...extra, today, related });
  }),
);

/**
 * The owner-facing view of a read: `deliveries` and, when `canReadShare` (the caller holds
 * `share.read`, http-mcp-contracts `get_share_link`), `share` with its bearer URL, from
 * `DocumentActivity`. Without `share.read` the share stays `null`. Apply it to owner reads only,
 * never to a write result or a stored view. Drafts are never shared or sent, so they skip the
 * reads.
 */
export const withActivity: {
  (
    view: DocumentView,
    canReadShare: boolean,
  ): (workspaceId: WorkspaceId) => Effect.Effect<DocumentView, StoreUnavailable, DocumentActivity>;
  (
    workspaceId: WorkspaceId,
    view: DocumentView,
    canReadShare: boolean,
  ): Effect.Effect<DocumentView, StoreUnavailable, DocumentActivity>;
} = Fn.dual(
  3,
  (
    workspaceId: WorkspaceId,
    view: DocumentView,
    canReadShare: boolean,
  ): Effect.Effect<DocumentView, StoreUnavailable, DocumentActivity> =>
    view.status === "draft"
      ? Effect.succeed(view)
      : Effect.gen(function* () {
          const activity = yield* DocumentActivity;
          const share = canReadShare ? yield* activity.share(workspaceId, view.id) : null;
          const deliveries = yield* activity.deliveries(workspaceId, view.id);
          return { ...view, share, deliveries };
        }),
);

class PreviewRollback extends Schema.TaggedError<
  PreviewRollback,
  { readonly brand: unique symbol }
>()("PreviewRollback", {}) {}

/**
 * Runs `effect` (e.g. a number allocation) in a nested transaction that is always rolled back:
 * a dry run fails exactly where the real call would (rule D15) and stores nothing.
 */
export const rolledBack = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(CoreStore, (store) =>
    store
      .transaction(Effect.andThen(effect, Effect.fail(PreviewRollback.make({}))))
      .pipe(Effect.catchTag("PreviewRollback", () => Effect.void)),
  );

/** A new document as its unnumbered draft row: `status` draft, `number` and `issuedAt` null. */
const unnumbered = (row: DocumentRecord): DocumentRecord => ({
  ...row,
  status: "draft",
  number: null,
  issuedAt: null,
});

/** The numbered write hit `NUMBER_PER_KIND`: `Conflict{duplicate}`; any other index is a defect. */
const numberTaken = (e: UniqueViolation) =>
  e.constraint === NUMBER_PER_KIND
    ? Effect.fail(Conflict.make({ reason: "duplicate" }))
    : Effect.die(e);

/**
 * Inserts a new document's unnumbered draft row (revision 1), then runs `effect` with it.
 * `number_reservations_document_fk` is not deferrable, so a number for a new document can only
 * be reserved after its row exists (rule D1); `effect` allocates for `row.id`, locking the
 * counter after the row (S4). The row is new and unnumbered, so a unique violation of its insert
 * is a defect.
 */
export const withDraftRow: {
  <A, E, R>(
    effect: (draft: DocumentRecord) => Effect.Effect<A, E, R>,
  ): (row: DocumentRecord) => Effect.Effect<A, E | StoreUnavailable, R | DocumentsRepo>;
  <A, E, R>(
    row: DocumentRecord,
    effect: (draft: DocumentRecord) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | StoreUnavailable, R | DocumentsRepo>;
} = Fn.dual(
  2,
  <A, E, R>(row: DocumentRecord, effect: (draft: DocumentRecord) => Effect.Effect<A, E, R>) =>
    Effect.flatMap(DocumentsRepo, (repo) =>
      repo
        .insert(unnumbered(row))
        .pipe(Effect.catchTag("UniqueViolation", Effect.die), Effect.flatMap(effect)),
    ),
);

/**
 * Stores a new numbered document: inserts `row` unnumbered (`withDraftRow`), runs `numberIt`
 * (allocate for `row.id`, return the issued record) and stores its result over the draft by
 * compare-and-set, so the issued row is at revision 2. A `NUMBER_PER_KIND` violation is
 * `Conflict{duplicate}`. The transaction inserted the row and holds it, so a missing row or a
 * changed revision on the update is a defect.
 */
export const insertNumbered: {
  <E, R>(
    numberIt: Effect.Effect<DocumentRecord, E, R>,
  ): (
    row: DocumentRecord,
  ) => Effect.Effect<DocumentRecord, E | StoreUnavailable | Conflict, R | DocumentsRepo>;
  <E, R>(
    row: DocumentRecord,
    numberIt: Effect.Effect<DocumentRecord, E, R>,
  ): Effect.Effect<DocumentRecord, E | StoreUnavailable | Conflict, R | DocumentsRepo>;
} = Fn.dual(2, <E, R>(row: DocumentRecord, numberIt: Effect.Effect<DocumentRecord, E, R>) =>
  withDraftRow(
    row,
    Effect.fnUntraced(function* (draft) {
      const repo = yield* DocumentsRepo;
      const issued = yield* numberIt;
      return yield* repo.update(issued, draft.revision).pipe(
        Effect.catchTags({
          NotFound: Effect.die,
          Conflict: Effect.die,
          UniqueViolation: numberTaken,
        }),
      );
    }),
  ),
);
