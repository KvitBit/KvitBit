/** `invitations` group handlers (http-mcp-contracts 3.5.1): anonymous peek (rate-limited) + session accept. */
import { Api, RateLimited } from "@kvitbit/api-contract";
import { Caller, CurrentCaller, Workspaces } from "@kvitbit/domain/contract";
import { Effect } from "effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import { HttpApiBuilder } from "effect/http-api";
import { Analytics } from "../../runtime/analytics";
import { HttpConfig } from "../config";
import { RATE_LIMITS, RateLimiter } from "../edge/RateLimiter";
import { acceptLanguageLocale, clientIp } from "../edge/request";

export const InvitationsGroupLive = HttpApiBuilder.group(Api, "invitations", (handlers) =>
  Effect.gen(function* () {
    const workspaces = yield* Workspaces;
    const limiter = yield* RateLimiter;
    const config = yield* HttpConfig;
    const analytics = yield* Analytics;

    return handlers
      .handle("peek", ({ params }) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          const ip = clientIp(request, config.trustedProxyHops);
          const decision = yield* limiter.consume(`invite-peek:${ip}`, RATE_LIMITS.invitationPeek);
          if (!decision.allowed) {
            return yield* new RateLimited({ retryAfterSeconds: decision.retryAfterSeconds });
          }
          const caller = Caller.invitationHolder({
            token: params.token,
            locale: acceptLanguageLocale(request.headers["accept-language"]) ?? "cs",
          });
          return yield* workspaces.peekInvitation.pipe(
            Effect.provideService(CurrentCaller, caller),
          );
        }),
      )
      .handle("accept", ({ params }) =>
        Effect.gen(function* () {
          const member = yield* workspaces.acceptInvitation(params.token);
          const mine = yield* workspaces.listMine;
          const summary = mine.find((ws) => ws.id === member.workspaceId);
          if (summary === undefined) {
            return yield* Effect.die(
              `accepted workspace ${member.workspaceId} missing from listMine`,
            );
          }
          yield* analytics.capture({
            event: "invitation_accepted",
            userId: member.userId,
            workspaceId: member.workspaceId,
          });
          return summary;
        }),
      );
  }),
);
