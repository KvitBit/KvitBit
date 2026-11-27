/** `shareLinks` group handlers (http-mcp-contracts 3.5.4): member side of PublicShareLinks. */
import { Api } from "@kvitbit/api-contract";
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
      .handle("create", ({ params }) => shareLinks.create(params.documentId))
      .handle("revoke", ({ params }) => shareLinks.revoke(params.documentId))
      .handle("views", ({ params, query }) => shareLinks.views(params.documentId, compact(query)));
  }),
);
