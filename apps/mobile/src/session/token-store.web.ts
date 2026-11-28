import * as Effect from "effect/Effect";
import { runMobileEffect } from "../runtime/request-intent";
import type { TokenStore } from "./token-store-port";

/** The PWA keeps the Better Auth session cookie (scoped to `/`), so there is no bearer to store. */
export const tokenStore: TokenStore = {
  usesBearer: false,
  read: (): Promise<string | null> => runMobileEffect(Effect.succeed(null)),
  write: (_token: string): Promise<void> => runMobileEffect(Effect.void),
  clear: (): Promise<void> => runMobileEffect(Effect.void),
};
