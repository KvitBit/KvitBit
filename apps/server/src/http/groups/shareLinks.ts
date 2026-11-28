/** `shareLinks` group handlers (http-mcp-contracts 3.5.4): member side of PublicShareLinks. */
import { Api, RequestCaller } from "@kvitbit/api-contract";
import { PublicShareLinks } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { compact } from "../conventions";

export const ShareLinksGroupLive = HttpApiBuilder.group(
  Api,
  "shareLinks",
  Effect.fnUntraced(function* (handlers) {
    const shareLinks = yield* PublicShareLinks;
    return handlers
      .handle("create", ({ params }) =>
        Effect.flatMap(RequestCaller, (caller) => shareLinks.create(caller, params.documentId)),
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
