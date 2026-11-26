/** `shareLinks` group handlers (http-mcp-contracts 3.5.4): member side of PublicShareLinks. */
import { Api } from "@kvitbit/api-contract";
import { PublicShareLinks } from "@kvitbit/domain/contract";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { compact } from "../conventions";

export const ShareLinksGroupLive = HttpApiBuilder.group(Api, "shareLinks", (handlers) =>
  Effect.gen(function* () {
    const shareLinks = yield* PublicShareLinks;
    return handlers
      .handle("create", ({ params }) => shareLinks.create(params.documentId))
      .handle("revoke", ({ params }) => shareLinks.revoke(params.documentId))
      .handle("views", ({ params, query }) => shareLinks.views(params.documentId, compact(query)));
  }),
);
