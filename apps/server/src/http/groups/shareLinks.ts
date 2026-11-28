/** `shareLinks` group handlers (http-mcp-contracts 3.5.4): member side of PublicShareLinks. */

import { Api, RequestCaller } from "@kvitbit/api-contract";
import { PublicShareLinks } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { Analytics } from "../../runtime/analytics";
import { compact } from "../conventions";

export const ShareLinksGroupLive = HttpApiBuilder.group(
  Api,
  "shareLinks",
  Effect.fnUntraced(function* (handlers) {
    const shareLinks = yield* PublicShareLinks;
    const analytics = yield* Analytics;
    return handlers
      .handle(
        "create",
        Effect.fn("ShareLinks.create")(function* ({ params }) {
          const caller = yield* RequestCaller;
          const link = yield* shareLinks.create(caller, params.documentId);
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
      .handle("revoke", ({ params }) =>
        Effect.flatMap(RequestCaller, (caller) => shareLinks.revoke(caller, params.documentId)),
      )
      .handle("views", ({ params, query }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          shareLinks.views(caller, params.documentId, compact(query)),
        ),
      );
  }),
);
