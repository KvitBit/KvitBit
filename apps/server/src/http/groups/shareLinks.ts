/** `shareLinks` group handlers (http-mcp-contracts 3.5.4): member side of PublicShareLinks. */
import { Api } from "@kvitbit/api-contract";
import { CurrentCaller, PublicShareLinks } from "@kvitbit/domain/contract";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { Analytics } from "../../runtime/analytics";
import { compact } from "../conventions";

export const ShareLinksGroupLive = HttpApiBuilder.group(Api, "shareLinks", (handlers) =>
  Effect.gen(function* () {
    const shareLinks = yield* PublicShareLinks;
    const analytics = yield* Analytics;
    return handlers
      .handle("create", ({ params }) =>
        Effect.gen(function* () {
          const link = yield* shareLinks.create(params.documentId);
          const caller = yield* CurrentCaller;
          if (caller._tag === "Member") {
            yield* analytics.capture({
              event: "share_link_created",
              userId: caller.userId,
              workspaceId: caller.workspaceId,
            });
          }
          return link;
        }),
      )
      .handle("revoke", ({ params }) => shareLinks.revoke(params.documentId))
      .handle("views", ({ params, query }) => shareLinks.views(params.documentId, compact(query)));
  }),
);
