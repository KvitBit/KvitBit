/** `botProtection` group handler (http-mcp-contracts 2.6, 3.5.1): ALTCHA v2 challenge issuance. */
import { BotProtection } from "@kvitbit/adapters/altcha";
import { AltchaChallenge, Api, RateLimited } from "@kvitbit/api-contract";
import { Unavailable } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Schema from "effect/Schema";
import { HttpConfig } from "../config";
import { compact } from "../conventions";
import { RATE_LIMITS, RateLimiter } from "../edge/RateLimiter";
import { clientIp } from "../edge/request";

export const BotProtectionGroupLive = HttpApiBuilder.group(
  Api,
  "botProtection",
  Effect.fnUntraced(function* (handlers) {
    const botProtection = yield* BotProtection;
    const limiter = yield* RateLimiter;
    const config = yield* HttpConfig;

    return handlers.handle(
      "issueChallenge",
      Effect.fnUntraced(function* ({ params }) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const ip = clientIp(request, config.trustedProxyHops);
        const decision = yield* limiter.consume(`bot-challenge:${ip}`, RATE_LIMITS.botChallenge);
        if (!decision.allowed) {
          return yield* RateLimited.make({ retryAfterSeconds: decision.retryAfterSeconds });
        }

        const challenge = yield* botProtection
          .issue(params.scope)
          .pipe(
            Effect.mapError(() =>
              Unavailable.make({ dependency: "database", retryAfterSeconds: 5 }),
            ),
          );

        yield* HttpEffect.appendPreResponseHandler((_req, res) =>
          Effect.succeed(HttpServerResponse.setHeader(res, "cache-control", "no-store")),
        );

        // NoopBotProtection returns algorithm "NONE" -> 204 No Content so clients skip the widget.
        if (challenge.parameters.algorithm === "NONE") {
          return HttpServerResponse.empty({
            status: 204,
            headers: { "cache-control": "no-store" },
          });
        }

        const data =
          challenge.parameters.data === undefined
            ? undefined
            : yield* Schema.decodeEffect(Schema.JsonObject)(challenge.parameters.data).pipe(
                Effect.orDie,
              );
        return AltchaChallenge.make({
          parameters: {
            algorithm: challenge.parameters.algorithm,
            nonce: challenge.parameters.nonce,
            salt: challenge.parameters.salt,
            cost: challenge.parameters.cost,
            keyLength: challenge.parameters.keyLength,
            keyPrefix: challenge.parameters.keyPrefix,
            ...compact({
              memoryCost: challenge.parameters.memoryCost,
              parallelism: challenge.parameters.parallelism,
              expiresAt: challenge.parameters.expiresAt,
              data,
            }),
          },
          ...compact({ signature: challenge.signature }),
        });
      }),
    );
  }),
);
