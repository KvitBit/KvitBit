/** Helpers shared by the Documents method files (drafts, reads; P2/P3 lifecycle files). */
import type { DocumentId, DocumentView, IsoDate, WorkspaceId } from "@kvitbit/domain/contract";
import { Clock, Effect } from "effect";
import { pragueDate } from "../../engines/calendar";
import { ZERO } from "../../engines/decimal";
import type { StoreUnavailable } from "../../store/CoreStore";
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
          return d?.number
            ? [{ relation: l.relation, id: d.id, kind: d.kind, number: d.number }]
            : [];
        });
      });

/** The full view of a stored record as of now. */
export const viewOf = (
  row: DocumentRecord,
  extra: Omit<ViewContext, "today" | "related"> = {},
): Effect.Effect<DocumentView, StoreUnavailable, DocumentsRepo> =>
  Effect.gen(function* () {
    const { today } = yield* now;
    const related = yield* relatedOf(row);
    return toView(row, { ...extra, today, related });
  });

/** A method of a later phase: dies with a clear defect until that phase lands. */
export const notImplemented = (method: string, phase: string) =>
  Effect.die(new Error(`Documents.${method}: not implemented (${phase})`));
