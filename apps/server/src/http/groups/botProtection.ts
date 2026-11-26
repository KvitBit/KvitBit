/** `botProtection` group handler (http-mcp-contracts 2.6, 3.5.1): ALTCHA v2 challenge issuance. */
import { BotProtection } from "@kvitbit/adapters/altcha";
import { AltchaChallenge, Api, RateLimited } from "@kvitbit/api-contract";
import { Unavailable } from "@kvitbit/domain/contract";
import { Effect } from "effect";
import { HttpEffect, HttpServerResponse } from "effect/http";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import { HttpApiBuilder } from "effect/http-api";
import { HttpConfig } from "../config";
import { RATE_LIMITS, RateLimiter } from "../edge/RateLimiter";
import { clientIp } from "../edge/request";

export const BotProtectionGroupLive = HttpApiBuilder.group(Api, "botProtection", (handlers) =>
  Effect.gen(function* () {
    const botProtection = yield* BotProtection;
    const limiter = yield* RateLimiter;
    const config = yield* HttpConfig;

    return handlers.handle("issueChallenge", ({ params }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const ip = clientIp(request, config.trustedProxyHops);
        const decision = yield* limiter.consume(`bot-challenge:${ip}`, RATE_LIMITS.botChallenge);
        if (!decision.allowed) {
          return yield* new RateLimited({ retryAfterSeconds: decision.retryAfterSeconds });
        }

        const challenge = yield* botProtection
          .issue(params.scope)
          .pipe(
            Effect.mapError(
              () => new Unavailable({ dependency: "database", retryAfterSeconds: 5 }),
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

        return AltchaChallenge.make({
          parameters: {
            algorithm: challenge.parameters.algorithm,
            nonce: challenge.parameters.nonce,
            salt: challenge.parameters.salt,
            cost: challenge.parameters.cost,
            keyLength: challenge.parameters.keyLength,
            keyPrefix: challenge.parameters.keyPrefix,
            ...(challenge.parameters.memoryCost === undefined
              ? {}
              : { memoryCost: challenge.parameters.memoryCost }),
            ...(challenge.parameters.parallelism === undefined
              ? {}
              : { parallelism: challenge.parameters.parallelism }),
            ...(challenge.parameters.expiresAt === undefined
              ? {}
              : { expiresAt: challenge.parameters.expiresAt }),
            ...(challenge.parameters.data === undefined
              ? {}
              : { data: challenge.parameters.data as Record<string, string | number | boolean> }),
          },
          ...(challenge.signature === undefined ? {} : { signature: challenge.signature }),
        });
      }),
    );
  }),
);
