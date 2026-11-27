import { FeedbackSubmission, STRICT_REQUEST, sanitizeFeedbackPageUrl } from "@kvitbit/api-contract";
import { ByteSize, Clock, Effect, Layer, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpIncomingMessage,
  HttpRouter,
  HttpServerResponse,
} from "effect/http";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import { SqlClient } from "effect/sql";
import { AuthServer } from "../../auth/AuthServer";
import { bindAuthLogging } from "../../auth/logging";
import { Analytics } from "../../runtime/analytics";
import { HttpConfig } from "../config";
import { RATE_LIMITS, RateLimiter } from "../edge/RateLimiter";
import { canSubmitFeedback, feedbackSessionCookie } from "./access";
import { createFeedbackIssue } from "./issue";

const BODY_MAX_BYTES = 256 * 1024;
const forbidden = HttpServerResponse.empty({ status: 403 });
const malformed = HttpServerResponse.empty({ status: 400 });
const oversized = HttpServerResponse.empty({ status: 413 });
const decode = Schema.decodeUnknownEffect(FeedbackSubmission, STRICT_REQUEST);

export const FeedbackRoutesLive = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const config = yield* HttpConfig;
    const auth = yield* AuthServer;
    const analytics = yield* Analytics;
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

        const request = yield* HttpServerRequest;
        const origin = request.headers.origin;
        const cookie = feedbackSessionCookie(request);
        // Require an exact trusted Origin for this browser-only write.
        if (origin === undefined || !config.trustedOrigins.has(origin) || cookie === undefined) {
          return forbidden;
        }

        const runAuth = yield* bindAuthLogging;
        const session = yield* Effect.tryPromise(() =>
          runAuth(() =>
            auth.api.getSession({
              headers: new Headers({ cookie }),
              query: { disableCookieCache: true, disableRefresh: true },
            }),
          ),
        ).pipe(Effect.orElseSucceed(() => null));
        if (session == null || !(yield* canSubmitFeedback(sql, config.feedback, session.user)))
          return forbidden;

        const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
        if (contentType !== "application/json") return malformed;
        if (Number(request.headers["content-length"]) > BODY_MAX_BYTES) return oversized;

        const json = yield* request.json.pipe(
          Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(BODY_MAX_BYTES)),
          Effect.result,
        );
        if (json._tag === "Failure") {
          const reason = json.failure.reason;
          return reason._tag === "RequestParseError" && reason.reason === "BodyTooLarge"
            ? oversized
            : malformed;
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
        if (issue === undefined) return HttpServerResponse.empty({ status: 502 });
        yield* analytics.capture({
          event: "feedback_submitted",
          userId: session.user.id,
          hasPin: submission.success.pins.length > 0,
        });
        return HttpServerResponse.jsonUnsafe(issue, {
          status: 201,
          headers: { "cache-control": "no-store" },
        });
      }),
    );
  }),
).pipe(Layer.provide(FetchHttpClient.layer));
