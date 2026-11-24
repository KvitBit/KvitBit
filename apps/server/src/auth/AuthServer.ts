/**
 * The process-wide Better Auth instance (`@kvitbit/adapters/auth` `makeAuth`), built by the
 * HTTP stream's `AuthServerLive`. The MCP stream reads OAuth metadata through it.
 */
import type { Auth } from "@kvitbit/adapters/auth";
import { Context } from "effect";

export class AuthServer extends Context.Service<AuthServer, Auth>()("kvitbit/server/AuthServer") {}
