import { FeedbackSubmission, STRICT_REQUEST, sanitizeFeedbackPageUrl } from "@kvitbit/api-contract";
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as SqlClient from "effect/sql/SqlClient";
import { AuthServer } from "../../auth/AuthServer";
import { HttpConfig } from "../config";
import { RATE_LIMITS, RateLimiter } from "../edge/RateLimiter";
import { isRequestBodyTooLarge } from "../edge/request";
import { canSubmitFeedback, feedbackSessionCookie } from "./access";
import { createFeedbackIssue } from "./issue";

const BODY_MAX_BYTES = 256 * 1024;
const forbidden = HttpServerResponse.empty({ status: 403 });
const malformed = HttpServerResponse.empty({ status: 400 });
const oversized = HttpServerResponse.empty({ status: 413 });
const decode = Schema.decodeUnknownEffect(FeedbackSubmission, STRICT_REQUEST);

export const FeedbackRoutesLive = HttpRouter.use(
  Effect.fnUntraced(function* (router) {
    const config = yield* HttpConfig;
    const auth = yield* AuthServer;
    const sql = yield* SqlClient.SqlClient;
    const client = yield* HttpClient.HttpClient;
    const fetch = yield* FetchHttpClient.Fetch;
    const limiter = yield* RateLimiter;
    const clock = yield* Clock.Clock;

    yield* router.add(
      "POST",
      "/api/feedback",
      Effect.gen(function* () {
        if (config.feedback === undefined) return HttpServerResponse.empty({ status: 404 });

        const request = yield* HttpServerRequest.HttpServerRequest;
        const origin = request.headers.origin;
        const cookie = feedbackSessionCookie(request);
        // Require an exact trusted Origin for this browser-only write.
        if (origin === undefined || !config.trustedOrigins.has(origin) || cookie === undefined) {
          return forbidden;
        }

        const session = yield* Effect.tryPromise({
          try: () =>
            auth.api.getSession({
              headers: new Headers({ cookie }),
              query: { disableCookieCache: true, disableRefresh: true },
            }),
          catch: () => forbidden,
        }).pipe(Effect.orElseSucceed(() => null));
        if (
          session === null ||
          session === undefined ||
          !(yield* canSubmitFeedback(sql, config.feedback, session.user))
        )
          return forbidden;

        const mediaType = Str.split(request.headers["content-type"] ?? "", ";")[0];
        const contentType = Str.toLowerCase(Str.trim(mediaType));
        if (contentType !== "application/json") return malformed;
        if (Number(request.headers["content-length"]) > BODY_MAX_BYTES) return oversized;

        const json = yield* request.json.pipe(
          Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(BODY_MAX_BYTES)),
          Effect.result,
        );
        if (json._tag === "Failure") {
          return isRequestBodyTooLarge(json.failure) ? oversized : malformed;
        }

        const submission = yield* decode(json.success).pipe(Effect.result);
        if (submission._tag === "Failure") return malformed;
        const page = sanitizeFeedbackPageUrl(submission.success.page.url);
        if (page === undefined || new URL(page.url).origin !== origin) return malformed;

        const decision = yield* limiter
          .consume(`feedback:${session.user.id}`, RATE_LIMITS.feedback)
          .pipe(Effect.provideService(Clock.Clock, clock));
        if (!decision.allowed) {
          return HttpServerResponse.empty({
            status: 429,
            headers: { "retry-after": String(decision.retryAfterSeconds) },
          });
        }

        const issue = yield* createFeedbackIssue(
          client,
          config.feedback,
          submission.success,
          page,
        ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
        return issue === undefined
          ? HttpServerResponse.empty({ status: 502 })
          : HttpServerResponse.jsonUnsafe(issue, {
              status: 201,
              headers: { "cache-control": "no-store" },
            });
      }),
    );
  }),
).pipe(Layer.provide(FetchHttpClient.layer));
