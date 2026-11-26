/** `themes` group handlers (http-mcp-contracts 3.5.2): Material 3 theme resolution. */
import { Api } from "@kvitbit/api-contract";
import { HttpApiBuilder } from "effect/http-api";
import { resolveTheme } from "./workspace/themeResolver";

export const ThemesGroupLive = HttpApiBuilder.group(Api, "themes", (handlers) =>
  handlers.handle("resolve", ({ payload }) => resolveTheme(payload.source)),
);
