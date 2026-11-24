/** Helpers shared by the Documents method files. */
import type { DocumentId, DocumentView, IsoDate, WorkspaceId } from "@kvitbit/domain/contract";
import { Clock, Data, Effect } from "effect";
import { pragueDate } from "../../engines/calendar";
import { ZERO } from "../../engines/decimal";
import { CoreStore, type StoreUnavailable } from "../../store/CoreStore";
import { DocumentActivity } from "./activity";
import type { Composed } from "./compose";
import type { DocumentRecord } from "./record";
import { DocumentsRepo } from "./repo";
import type { RelatedDocument, ViewContext } from "./view";
import { toView } from "./view";

/** Prague today and the current instant (ISO). */
export const now = Effect.map(Clock.currentTimeMillis, (millis) => ({
  today: pragueDate(millis) as IsoDate,
  at: new Date(millis).toISOString(),
}));

/** A new draft record from composed fields. */
export const newDraftRecord = (
  id: DocumentId,
  workspaceId: WorkspaceId,
  composed: Composed,
  at: string,
): DocumentRecord => ({
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
});

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
          row.links.map((l) => l.id),
        );
        const byId = new Map(linked.map((d) => [d.id, d]));
        return row.links.flatMap((l): ReadonlyArray<RelatedDocument> => {
          const d = byId.get(l.id);
          // A Credit Note prints the corrected number as it was at correction time (D7).
          const number = l.relation === "corrects" ? (row.correctedNumber ?? d?.number) : d?.number;
          return d && number ? [{ relation: l.relation, id: d.id, kind: d.kind, number }] : [];
        });
      });

/**
 * The stored view of a record as of now: `share: null`, `deliveries: []`. It is what delivery
 * snapshots, idempotency results, the renderer and share-link visitors get, so a bearer share
 * URL or the delivery history never lands in stored or replayed data (core-ports.md 66-68).
 * Owner-facing boundaries add them with `withActivity`.
 */
export const viewOf = (
  row: DocumentRecord,
  extra: Pick<ViewContext, "language"> = {},
): Effect.Effect<DocumentView, StoreUnavailable, DocumentsRepo> =>
  Effect.gen(function* () {
    const { today } = yield* now;
    const related = yield* relatedOf(row);
    return toView(row, { ...extra, today, related });
  });

/**
 * The owner-facing view: `share` (with its bearer URL) and `deliveries` from `DocumentActivity`.
 * Apply it to what the caller gets, never to a view that is stored: a write applies it inside its
 * transaction (`withIdempotency`'s `present`), so a failing read rolls the write back.
 * Drafts are never shared or sent, so they skip the reads.
 */
export const withActivity = (
  workspaceId: WorkspaceId,
  view: DocumentView,
): Effect.Effect<DocumentView, StoreUnavailable, DocumentActivity> =>
  view.status === "draft"
    ? Effect.succeed(view)
    : Effect.gen(function* () {
        const activity = yield* DocumentActivity;
        const share = yield* activity.share(workspaceId, view.id);
        const deliveries = yield* activity.deliveries(workspaceId, view.id);
        return { ...view, share, deliveries };
      });

class PreviewRollback extends Data.TaggedError("PreviewRollback") {}

/**
 * Runs `effect` (e.g. a number allocation) in a nested transaction that is always rolled back:
 * a dry run fails exactly where the real call would (rule D15) and stores nothing.
 */
export const rolledBack = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(CoreStore, (store) =>
    store
      .transaction(Effect.andThen(effect, Effect.fail(new PreviewRollback())))
      .pipe(Effect.catchTag("PreviewRollback", () => Effect.void)),
  );
