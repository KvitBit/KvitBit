/** `registry` group handlers (http-mcp-contracts 3.5.2): read-only company lookup by IČO. */
import { Api } from "@kvitbit/api-contract";
import { Workspaces } from "@kvitbit/domain/contract";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

export const RegistryGroupLive = HttpApiBuilder.group(Api, "registry", (handlers) =>
  Effect.gen(function* () {
    const workspaces = yield* Workspaces;
    return handlers.handle("lookupCompany", ({ params }) => workspaces.lookupCompany(params.ico));
  }),
);
