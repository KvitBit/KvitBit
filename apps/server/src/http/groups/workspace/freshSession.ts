/**
 * Rule A6 (http-mcp-contracts 2.1): owner-only danger actions (`close`, `transferOwnership`)
 * require a fresh session authenticated within the last 5 minutes.
 */
import { CurrentPrincipal, Unauthorized } from "@kvitbit/api-contract";
import { Clock, Effect } from "effect";

export const FRESH_SESSION_MAX_AGE_MS = 5 * 60 * 1000;

export const requireFreshSession: Effect.Effect<void, Unauthorized, CurrentPrincipal> = Effect.gen(
  function* () {
    const principal = yield* CurrentPrincipal;
    if (principal.credential._tag !== "Session") {
      return yield* new Unauthorized({ reason: "credential_not_allowed" });
    }
    const authenticatedAt = Date.parse(principal.credential.authenticatedAt);
    if (!Number.isFinite(authenticatedAt)) {
      return yield* new Unauthorized({ reason: "reauthentication_required" });
    }
    const now = yield* Clock.currentTimeMillis;
    if (now - authenticatedAt > FRESH_SESSION_MAX_AGE_MS) {
      return yield* new Unauthorized({ reason: "reauthentication_required" });
    }
  },
);
