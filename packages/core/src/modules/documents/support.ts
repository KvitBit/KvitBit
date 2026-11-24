/** Helpers shared by the Documents method files. */
import type { DocumentId, DocumentView, IsoDate, WorkspaceId } from "@kvitbit/domain/contract";
import { Clock, Data, Effect, Option } from "effect";
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
 * `share` and `deliveries` from the optional `DocumentActivity` port; values in `extra` win.
 * Drafts are never shared or sent, so they skip the reads.
 */
const activityOf = (
  row: DocumentRecord,
  extra: Pick<ViewContext, "share" | "deliveries">,
): Effect.Effect<Pick<ViewContext, "share" | "deliveries">, StoreUnavailable> =>
  Effect.gen(function* () {
    if (row.status === "draft") return {};
    const port = yield* Effect.serviceOption(DocumentActivity);
    if (Option.isNone(port)) return {};
    const share =
      extra.share !== undefined ? extra.share : yield* port.value.share(row.workspaceId, row.id);
    const deliveries =
      extra.deliveries !== undefined
        ? extra.deliveries
        : yield* port.value.deliveries(row.workspaceId, row.id);
    return { share, deliveries };
  });

/** The full view of a stored record as of now. */
export const viewOf = (
  row: DocumentRecord,
  extra: Omit<ViewContext, "today" | "related"> = {},
): Effect.Effect<DocumentView, StoreUnavailable, DocumentsRepo> =>
  Effect.gen(function* () {
    const { today } = yield* now;
    const related = yield* relatedOf(row);
    const activity = yield* activityOf(row, extra);
    return toView(row, { ...extra, ...activity, today, related });
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
