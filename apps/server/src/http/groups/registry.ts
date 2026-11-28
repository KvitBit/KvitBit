/** `registry` group handlers (http-mcp-contracts 3.5.2): read-only company lookup by IČO. */
import { Api, RequestCaller } from "@kvitbit/api-contract";
import { Workspaces } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

export const RegistryGroupLive = HttpApiBuilder.group(
  Api,
  "registry",
  Effect.fnUntraced(function* (handlers) {
    const workspaces = yield* Workspaces;
    return handlers.handle("lookupCompany", ({ params }) =>
      Effect.flatMap(RequestCaller, (caller) => workspaces.lookupCompany(caller, params.ico)),
    );
  }),
);
