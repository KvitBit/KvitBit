import { RequestCaller } from "@kvitbit/api-contract";
/**
 * The HttpApi middleware of `@kvitbit/api-contract` security.ts (http-mcp-contracts 2.3):
 * Authentication, EdgeGuard, SessionOnly, WorkspaceMember and ShareLinkVisitor. SchemaErrors
 * lives in `./response.ts`.
 */

import {
  ATTACHMENT_MAX_BYTES,
  Authentication,
  CurrentPrincipal,
  EdgeGuard,
  OriginRejected,
  PayloadTooLarge,
  type Principal,
  RateLimited,
  SessionOnly,
  ShareLinkVisitor,
  THEME_JSON_MAX_BYTES,
  Unauthorized,
  WorkspaceMember,
} from "@kvitbit/api-contract";
import {
  Caller,
  type ClientRef,
  NotFound,
  ShareToken,
  VisitorHash,
  WorkspaceId,
  Workspaces,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as ByteSize from "effect/ByteSize";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerError from "effect/http/HttpServerError";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApiError from "effect/http-api/HttpApiError";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as EffectRecord from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { PrincipalResolver } from "../../auth/PrincipalResolver";
import { HttpConfig } from "../config";
import { RATE_LIMITS, RateLimiter, type RateRule } from "./RateLimiter";
import {
  acceptLanguageLocale,
  bearerToken,
  clientIp,
  headersRequest,
  isRequestBodyTooLarge,
} from "./request";

// --- Authentication ----------------------------------------------------------------------------

const principalCaller = (principal: Principal) =>
  Caller.account({
    userId: principal.userId,
    email: principal.email,
    locale: principal.locale,
    channel: principal.channel,
  });

/**
 * Both security schemes run the same resolution over the whole request, so the answer does not
 * depend on which scheme HttpApiBuilder tries last: PrincipalResolver prefers the bearer header,
 * then the session cookie (rule A1 decides between session token and API Key).
 */
const AuthenticationLive = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const resolver = yield* PrincipalResolver;
    const config = yield* HttpConfig;
    const authenticate = Effect.fnUntraced(function* <A, E, R>(handler: Effect.Effect<A, E, R>) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const principal = yield* resolver.fromApiRequest(headersRequest(request, config.appOrigin));
      return yield* handler.pipe(
        Effect.provideService(CurrentPrincipal, principal),
        Effect.provideService(RequestCaller, principalCaller(principal)),
      );
    });
    return Authentication.of({
      session: authenticate,
      bearer: authenticate,
    });
  }),
);

// --- EdgeGuard ---------------------------------------------------------------------------------

/** JSON bodies (section 1). */
export const JSON_BODY_MAX_BYTES = 1024 * 1024;
/** Multipart uploads: the part limit plus 64 KB of envelope (section 1). */
const MULTIPART_BODY_MAX_BYTES = ATTACHMENT_MAX_BYTES + 64 * 1024;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Endpoint-specific limits of section 2.5, keyed `group.endpoint`, counted per user. */
const ENDPOINT_LIMITS: Readonly<
  Record<string, { readonly name: string; readonly rule: RateRule }>
> = {
  "registry.lookupCompany": { name: "registry", rule: RATE_LIMITS.registry },
  "contacts.fromIco": { name: "registry", rule: RATE_LIMITS.registry },
  "themes.resolve": { name: "theme-resolve", rule: RATE_LIMITS.themeResolve },
  "branding.previewPdf": { name: "preview-pdf", rule: RATE_LIMITS.previewPdf },
};

/** Endpoints whose JSON body is a theme document (64 KB, section 1). */
const THEME_BODY_ENDPOINTS = new Set([
  "themes.resolve",
  "branding.updateBranding",
  "me.updatePreferences",
]);

const bodyLimitFor = (endpointKey: string, contentType: string | undefined): number =>
  Str.startsWith("multipart/")(Str.toLowerCase(contentType ?? ""))
    ? MULTIPART_BODY_MAX_BYTES
    : THEME_BODY_ENDPOINTS.has(endpointKey)
      ? THEME_JSON_MAX_BYTES + 4 * 1024
      : JSON_BODY_MAX_BYTES;

const readOrigin = Option.liftThrowable((value: string) => new URL(value).origin);
const originOf = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : Option.getOrUndefined(readOrigin(value));

/** Rule A5 applies to cookie sessions only; bearer callers (mobile, API Key) skip it. */
const isCookieSession = (principal: Principal) =>
  principal.credential._tag === "Session" && principal.channel === "web";

const EdgeGuardLive = Layer.effect(
  EdgeGuard,
  Effect.gen(function* () {
    const config = yield* HttpConfig;
    const limiter = yield* RateLimiter;
    const limit = (key: string, rule: RateRule) =>
      Effect.flatMap(limiter.consume(key, rule), (decision) => {
        if (decision.allowed) return Effect.void;
        return Effect.fail(RateLimited.make({ retryAfterSeconds: decision.retryAfterSeconds }));
      });
    return EdgeGuard.of(
      Effect.fnUntraced(function* (handler, { endpoint, group }) {
        const principal = yield* CurrentPrincipal;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const endpointKey = `${group.identifier}.${endpoint.name}`;

        // A5: cookie writes need a trusted Origin, else Referer.
        if (!SAFE_METHODS.has(request.method) && isCookieSession(principal)) {
          const origin =
            originOf(request.headers["origin"]) ?? originOf(request.headers["referer"]);
          if (origin === undefined || !config.trustedOrigins.has(origin)) {
            return yield* OriginRejected.make();
          }
        }

        // 2.5: per credential, then the endpoint's own limit.
        const credential = principal.credential;
        if (credential._tag === "ApiKey") {
          yield* limit(`api-key:${credential.keyId}`, RATE_LIMITS.apiKey);
        } else {
          yield* limit(`user:${principal.userId}`, RATE_LIMITS.session);
        }
        const special = ENDPOINT_LIMITS[endpointKey];
        if (special !== undefined) {
          yield* limit(`${special.name}:${principal.userId}`, special.rule);
        }

        // Section 1: declared bodies over the limit get 413 before the handler runs.
        const limitBytes = bodyLimitFor(endpointKey, request.headers["content-type"]);
        const declared = request.headers["content-length"];
        if (declared !== undefined && Number(declared) > limitBytes) {
          return yield* PayloadTooLarge.make({ limitBytes });
        }
        // Streamed bodies that outgrow a payload limit while decoding.
        return yield* handler.pipe(
          Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(limitBytes)),
          Effect.catchIf(HttpApiError.HttpApiPayloadTooLarge.is, () =>
            Effect.fail(PayloadTooLarge.make({ limitBytes })),
          ),
          Effect.catchDefect((defect) =>
            HttpServerError.isHttpServerError(defect) && isRequestBodyTooLarge(defect)
              ? Effect.fail(PayloadTooLarge.make({ limitBytes }))
              : Effect.die(defect),
          ),
        );
      }),
    );
  }),
);

// --- SessionOnly -------------------------------------------------------------------------------

/** Rule A4. */
const SessionOnlyLive = Layer.succeed(
  SessionOnly,
  SessionOnly.of(
    Effect.fnUntraced(function* (handler) {
      const principal = yield* CurrentPrincipal;
      if (principal.credential._tag !== "Session") {
        return yield* Unauthorized.make({ reason: "credential_not_allowed" });
      }
      return yield* handler;
    }),
  ),
);

// --- WorkspaceMember ---------------------------------------------------------------------------

const decodeWorkspaceId = Schema.decodeUnknownOption(WorkspaceId);

const clientOf = (principal: Principal): ClientRef | undefined => {
  const c = principal.credential;
  switch (c._tag) {
    case "ApiKey":
      return { kind: "api_key", id: c.keyId, name: c.keyName };
    case "McpGrant":
      return { kind: "mcp", id: c.grantId, name: c.clientName };
    case "Session":
      return undefined;
  }
};

/** Section 2.3 steps 3: rule A3, then `Workspaces.enter` replaces the Account caller. */
const WorkspaceMemberLive = Layer.effect(
  WorkspaceMember,
  Effect.gen(function* () {
    const workspaces = yield* Workspaces;
    return WorkspaceMember.of(
      Effect.fnUntraced(function* (handler) {
        const principal = yield* CurrentPrincipal;
        const route = yield* HttpRouter.RouteContext;
        const raw = route.params["workspaceId"] ?? "";
        const workspaceId = decodeWorkspaceId(raw);
        if (Option.isNone(workspaceId)) {
          return yield* NotFound.make({ entity: "Workspace", id: raw });
        }
        const c = principal.credential;
        if (c._tag !== "Session" && c.workspaceId !== workspaceId.value) {
          return yield* NotFound.make({ entity: "Workspace", id: workspaceId.value }); // A3
        }
        const client = clientOf(principal);
        const enterOptions = {
          scopes: c._tag === "Session" ? ("all" as const) : c.scopes,
          channel: principal.channel,
        };
        const account = yield* RequestCaller;
        const member = yield* workspaces.enter(
          account,
          workspaceId.value,
          client === undefined ? enterOptions : { ...enterOptions, client },
        );
        return yield* Effect.provideService(handler, RequestCaller, member);
      }),
    );
  }),
);

// --- ShareLinkVisitor --------------------------------------------------------------------------

/**
 * `VisitorHash` (core ids): HMAC of IP and user agent under a key that rotates daily (UTC), so
 * views of one visitor collapse within a day and cannot be linked across days.
 */
const visitorHash = (secret: string, day: string, ip: string, userAgent: string) => {
  const dayKey = new Bun.CryptoHasher("sha256", secret).update(`kvitbit-visitor:${day}`).digest();
  return VisitorHash.make(
    new Bun.CryptoHasher("sha256", dayKey).update(`${ip}\n${userAgent}`).digest("base64url"),
  );
};

/** Section 2.3 step 5. A verified session, when present, sets `signedInUser`. */
const ShareLinkVisitorLive = Layer.effect(
  ShareLinkVisitor,
  Effect.gen(function* () {
    const config = yield* HttpConfig;
    const limiter = yield* RateLimiter;
    const resolver = yield* PrincipalResolver;
    const secret = Redacted.value(config.visitorSecret);
    return ShareLinkVisitor.of(
      Effect.fnUntraced(function* (handler) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const route = yield* HttpRouter.RouteContext;
        const ip = clientIp(request, config.trustedProxyHops);
        const decision = yield* limiter.consume(`share:${ip}`, RATE_LIMITS.shareLink);
        if (!decision.allowed) {
          return yield* RateLimited.make({ retryAfterSeconds: decision.retryAfterSeconds });
        }
        const now = yield* DateTime.now;
        const day = DateTime.formatIsoDateUtc(now);
        const hasCredential =
          bearerToken(request.headers["authorization"]) !== undefined ||
          Arr.some(EffectRecord.keys(request.cookies), (name) =>
            Str.endsWith("session_token")(name),
          );
        const signedIn = hasCredential
          ? yield* resolver
              .fromApiRequest(headersRequest(request, config.appOrigin))
              .pipe(Effect.option)
          : Option.none();
        const visitor = {
          token: ShareToken.make(route.params["token"] ?? ""),
          visitor: visitorHash(secret, day, ip, request.headers["user-agent"] ?? ""),
          locale: acceptLanguageLocale(request.headers["accept-language"]) ?? "cs",
        };
        const caller = Caller.shareLinkVisitor(
          Option.isSome(signedIn) ? { ...visitor, signedInUser: signedIn.value.userId } : visitor,
        );
        return yield* Effect.provideService(handler, RequestCaller, caller);
      }),
    );
  }),
);

/** Every HttpApi middleware except SchemaErrors. */
export const EdgeMiddlewareLive = Layer.mergeAll(
  AuthenticationLive,
  EdgeGuardLive,
  SessionOnlyLive,
  WorkspaceMemberLive,
  ShareLinkVisitorLive,
);
