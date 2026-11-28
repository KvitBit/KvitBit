import { RequestCaller } from "@kvitbit/api-contract";
/** `invitations` group handlers (http-mcp-contracts 3.5.1): anonymous peek (rate-limited) + session accept. */

import { Api, RateLimited } from "@kvitbit/api-contract";
import { Caller, Workspaces } from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Option from "effect/Option";
import { HttpConfig } from "../config";
import { RATE_LIMITS, RateLimiter } from "../edge/RateLimiter";
import { acceptLanguageLocale, clientIp } from "../edge/request";

export const InvitationsGroupLive = HttpApiBuilder.group(
  Api,
  "invitations",
  Effect.fnUntraced(function* (handlers) {
    const workspaces = yield* Workspaces;
    const limiter = yield* RateLimiter;
    const config = yield* HttpConfig;

    return handlers
      .handle(
        "peek",
        Effect.fnUntraced(function* ({ params }) {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const ip = clientIp(request, config.trustedProxyHops);
          const decision = yield* limiter.consume(`invite-peek:${ip}`, RATE_LIMITS.invitationPeek);
          if (!decision.allowed) {
            return yield* RateLimited.make({ retryAfterSeconds: decision.retryAfterSeconds });
          }
          const caller = Caller.invitationHolder({
            token: params.token,
            locale: acceptLanguageLocale(request.headers["accept-language"]) ?? "cs",
          });
          return yield* workspaces.peekInvitation(caller);
        }),
      )
      .handle(
        "accept",
        Effect.fnUntraced(function* ({ params }) {
          const caller = yield* RequestCaller;
          const member = yield* workspaces.acceptInvitation(caller, params.token);
          const mine = yield* workspaces.listMine(caller);
          const summary = Option.getOrUndefined(
            Arr.findFirst(mine, (ws) => ws.id === member.workspaceId),
          );
          if (summary === undefined) {
            return yield* Effect.die(
              `accepted workspace ${member.workspaceId} missing from listMine`,
            );
          }
          return summary;
        }),
      );
  }),
);
