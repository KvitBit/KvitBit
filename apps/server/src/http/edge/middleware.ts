/**
 * The HttpApi middleware of `@kvitbit/api-contract` security.ts (http-mcp-contracts 2.3):
 * Authentication, EdgeGuard, SessionOnly, WorkspaceMember and ShareLinkVisitor. SchemaErrors
 * lives in `./response.ts`.
 */
import { createHmac } from "node:crypto";
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
  CurrentCaller,
  NotFound,
  ShareToken,
  VisitorHash,
  WorkspaceId,
  Workspaces,
} from "@kvitbit/domain/contract";
import { ByteSize, DateTime, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpIncomingMessage, HttpRouter, HttpServerError } from "effect/http";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import { HttpApiError } from "effect/http-api";
import { PrincipalResolver } from "../../auth/PrincipalResolver";
import { HttpConfig } from "../config";
import { RATE_LIMITS, RateLimiter, type RateRule } from "./RateLimiter";
import { acceptLanguageLocale, bearerToken, clientIp, headersRequest } from "./request";

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
export const AuthenticationLive = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const resolver = yield* PrincipalResolver;
    const config = yield* HttpConfig;
    const authenticate = <A, E, R>(handler: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const principal = yield* resolver.fromApiRequest(headersRequest(request, config.appOrigin));
        return yield* handler.pipe(
          Effect.provideService(CurrentPrincipal, principal),
          Effect.provideService(CurrentCaller, principalCaller(principal)),
        );
      });
    return Authentication.of({
      session: (handler) => authenticate(handler),
      bearer: (handler) => authenticate(handler),
    });
  }),
);

// --- EdgeGuard ---------------------------------------------------------------------------------

/** JSON bodies (section 1). */
export const JSON_BODY_MAX_BYTES = 1024 * 1024;
/** Multipart uploads: the part limit plus 64 KB of envelope (section 1). */
export const MULTIPART_BODY_MAX_BYTES = ATTACHMENT_MAX_BYTES + 64 * 1024;

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

export const bodyLimitFor = (endpointKey: string, contentType: string | undefined): number =>
  contentType?.toLowerCase().startsWith("multipart/") === true
    ? MULTIPART_BODY_MAX_BYTES
    : THEME_BODY_ENDPOINTS.has(endpointKey)
      ? THEME_JSON_MAX_BYTES + 4 * 1024
      : JSON_BODY_MAX_BYTES;

const originOf = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

/** Rule A5 applies to cookie sessions only; bearer callers (mobile, API Key) skip it. */
const isCookieSession = (principal: Principal) =>
  principal.credential._tag === "Session" && principal.channel === "web";

export const EdgeGuardLive = Layer.effect(
  EdgeGuard,
  Effect.gen(function* () {
    const config = yield* HttpConfig;
    const limiter = yield* RateLimiter;
    const limit = (key: string, rule: RateRule) =>
      Effect.flatMap(limiter.consume(key, rule), (decision) =>
        decision.allowed
          ? Effect.void
          : Effect.fail(new RateLimited({ retryAfterSeconds: decision.retryAfterSeconds })),
      );
    return EdgeGuard.of((handler, { endpoint, group }) =>
      Effect.gen(function* () {
        const principal = yield* CurrentPrincipal;
        const request = yield* HttpServerRequest;
        const endpointKey = `${group.identifier}.${endpoint.name}`;

        // A5: cookie writes need a trusted Origin, else Referer.
        if (!SAFE_METHODS.has(request.method) && isCookieSession(principal)) {
          const origin = originOf(request.headers.origin) ?? originOf(request.headers.referer);
          if (origin === undefined || !config.trustedOrigins.has(origin)) {
            return yield* new OriginRejected();
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
          return yield* new PayloadTooLarge({ limitBytes });
        }
        // Streamed bodies that outgrow a payload limit while decoding.
        return yield* handler.pipe(
          Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(limitBytes)),
          Effect.catchIf(HttpApiError.HttpApiPayloadTooLarge.is, () =>
            Effect.fail(new PayloadTooLarge({ limitBytes })),
          ),
          Effect.catchDefect((defect) =>
            HttpServerError.isHttpServerError(defect) &&
            defect.reason._tag === "RequestParseError" &&
            defect.reason.reason === "BodyTooLarge"
              ? Effect.fail(new PayloadTooLarge({ limitBytes }))
              : Effect.die(defect),
          ),
        );
      }),
    );
  }),
);

// --- SessionOnly -------------------------------------------------------------------------------

/** Rule A4. */
export const SessionOnlyLive = Layer.succeed(
  SessionOnly,
  SessionOnly.of((handler) =>
    Effect.gen(function* () {
      const principal = yield* CurrentPrincipal;
      if (principal.credential._tag !== "Session") {
        return yield* new Unauthorized({ reason: "credential_not_allowed" });
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
export const WorkspaceMemberLive = Layer.effect(
  WorkspaceMember,
  Effect.gen(function* () {
    const workspaces = yield* Workspaces;
    return WorkspaceMember.of((handler) =>
      Effect.gen(function* () {
        const principal = yield* CurrentPrincipal;
        const route = yield* HttpRouter.RouteContext;
        const raw = route.params.workspaceId ?? "";
        const workspaceId = decodeWorkspaceId(raw);
        if (Option.isNone(workspaceId)) {
          return yield* new NotFound({ entity: "Workspace", id: raw });
        }
        const c = principal.credential;
        if (c._tag !== "Session" && c.workspaceId !== workspaceId.value) {
          return yield* new NotFound({ entity: "Workspace", id: workspaceId.value }); // A3
        }
        const client = clientOf(principal);
        const member = yield* workspaces.enter(workspaceId.value, {
          scopes: c._tag === "Session" ? "all" : c.scopes,
          channel: principal.channel,
          ...(client === undefined ? {} : { client }),
        });
        return yield* Effect.provideService(handler, CurrentCaller, member);
      }),
    );
  }),
);

// --- ShareLinkVisitor --------------------------------------------------------------------------

/**
 * `VisitorHash` (core ids): HMAC of IP and user agent under a key that rotates daily (UTC), so
 * views of one visitor collapse within a day and cannot be linked across days.
 */
export const visitorHash = (secret: string, day: string, ip: string, userAgent: string) => {
  const dayKey = createHmac("sha256", secret).update(`kvitbit-visitor:${day}`).digest();
  return VisitorHash.make(
    createHmac("sha256", dayKey).update(`${ip}\n${userAgent}`).digest("base64url"),
  );
};

/** Section 2.3 step 5. A verified session, when present, sets `signedInUser`. */
export const ShareLinkVisitorLive = Layer.effect(
  ShareLinkVisitor,
  Effect.gen(function* () {
    const config = yield* HttpConfig;
    const limiter = yield* RateLimiter;
    const resolver = yield* PrincipalResolver;
    const secret = Redacted.value(config.visitorSecret);
    return ShareLinkVisitor.of((handler) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const route = yield* HttpRouter.RouteContext;
        const ip = clientIp(request, config.trustedProxyHops);
        const decision = yield* limiter.consume(`share:${ip}`, RATE_LIMITS.shareLink);
        if (!decision.allowed) {
          return yield* new RateLimited({ retryAfterSeconds: decision.retryAfterSeconds });
        }
        const now = yield* DateTime.now;
        const day = DateTime.formatIsoDateUtc(now);
        const hasCredential =
          bearerToken(request.headers.authorization) !== undefined ||
          Object.keys(request.cookies).some((name) => name.endsWith("session_token"));
        const signedIn = hasCredential
          ? yield* resolver
              .fromApiRequest(headersRequest(request, config.appOrigin))
              .pipe(Effect.option)
          : Option.none();
        const caller = Caller.shareLinkVisitor({
          token: ShareToken.make(route.params.token ?? ""),
          visitor: visitorHash(secret, day, ip, request.headers["user-agent"] ?? ""),
          locale: acceptLanguageLocale(request.headers["accept-language"]) ?? "cs",
          ...(Option.isSome(signedIn) ? { signedInUser: signedIn.value.userId } : {}),
        });
        return yield* Effect.provideService(handler, CurrentCaller, caller);
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
