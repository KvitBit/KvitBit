# HTTP API and MCP adapter contracts

Issue #19. Status: design for review. Builds on the accepted core spec in [core-ports.md](core-ports.md) (issue #18, [ADR 0004](../adr/0004-hexagonal-core-ports.md)) and the approved flows in [user-flows.md](user-flows.md). Sibling contract: `docs/design/ui-port-contracts.md` (issue #20), which consumes the API client defined here.

This spec fixes everything `apps/server` exposes over the network: the edge routing table, how each credential becomes a core `Caller`, the Effect `HttpApi` contract in `packages/api-contract`, binary transfer, the Expo update and release routes, and the remote MCP server at `/mcp`. It adds no domain rules. Where a flow needs something core does not offer yet, section 9 lists it as a core gap instead of inventing behaviour at the edge.

Effect spellings follow `effect@4.1.4` (`effect/unstable/httpapi` in the 4.x line; core-ports uses the same path). The endpoint shape `HttpApiEndpoint.get(name, path, { params, query, headers, payload, success, error })`, `HttpApiSchema.status`, `HttpApiSchema.NoContent`, `HttpApiSchema.asMultipartStream`, `HttpApiSchema.asUint8Array` and `HttpApiMiddleware.Service` were checked against Deskohub's Effect 4 source. Section 10 lists what still needs confirming on 4.1.4.

---

## 0. Decisions at a glance

| Topic | Decision |
|---|---|
| Contract package | `packages/api-contract`, npm `@kvitbit/api-contract`. Exports `Api` (one `HttpApi`), its groups, edge-only schemas, and the theme schemas. Depends only on `@kvitbit/core/contract`. |
| Versioning | URL prefix `/api/v1`. Breaking changes ship as `/api/v2` next to v1. Error shapes are part of the contract (ADR 0004). |
| Wire format | JSON. Money is a decimal string (`BigDecimal` encoded), dates are `IsoDate` (`YYYY-MM-DD`, Europe/Prague), instants are ISO-8601 UTC strings. Views are the core `Schema` classes unchanged. |
| Workspace in path | `/api/v1/workspaces/{workspaceId}/...`. The id feeds `Workspaces.enter`; it never reaches a domain method. Web URLs use the Workspace slug; the client resolves slug to id from `GET /api/v1/workspaces`. |
| Concurrency | `ETag: "<revision>"` on every revisioned read and write. Writes that take `expectedRevision` require `If-Match`. Missing gives 428, stale gives 412. |
| Retry safety | `Idempotency-Key` header maps to `RequestOptions.requestKey`. MCP derives the key itself. |
| Pagination | `cursor` + `limit` (1 to 100, default 50) + typed filters; response is core `Page`. Bounded collections return plain arrays. |
| Errors | The five core `Schema.TaggedError`s keep their own status. The edge adds seven edge errors (section 3.3). |
| Binary | Uploads are `multipart/form-data` with one part named `file`. Downloads are plain authenticated `GET`s. No signed URLs in v1. |
| Theme | Material 3 `ThemeSource` (preset, seed, or Material Theme Builder JSON) on account preferences and on Workspace branding, resolved server-side to `ResolvedTheme`. |
| MCP | Stateless Streamable HTTP at `/mcp`, OAuth 2.1 resource server, 28 curated tools, 9 resources. Anything that assigns a document number or sends email needs preview then confirm. |

---

## 1. Edge routing table

`apps/server` (Bun, Effect `HttpRouter`) owns every path below. It mounts the `HttpApi` and the raw routes into one router. Foldkit SSR handles everything that is not listed, so the table is the complete server surface.

| Path | Methods | Handler | Auth | Notes |
|---|---|---|---|---|
| `/api/v1/*` | all | `HttpApiBuilder` over `Api` (section 3) | Session cookie, session bearer (Expo), or API Key; none on public groups | JSON. OpenAPI at `/api/v1/openapi.json`, Scalar docs at `/api/v1/docs`. |
| `/api/auth/*` | all | Better Auth `auth.handler` | Better Auth's own | Sign up, sign in, magic link, passkeys, sessions, email change, account deletion, OAuth 2.1 authorization server (`/api/auth/oauth2/*`). ALTCHA proof checked in a before-hook (section 2.6). |
| `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp` | GET | Raw route | None | RFC 9728 metadata for the MCP resource (section 6.2). |
| `/.well-known/oauth-authorization-server`, `/.well-known/oauth-authorization-server/api/auth` | GET | Better Auth metadata | None | RFC 8414 metadata. Both paths answer, because clients differ in how they derive it from the issuer. |
| `/mcp` | POST (GET and DELETE answer 405) | MCP Streamable HTTP adapter (section 6) | OAuth 2.1 access token only | Fresh MCP server per request, JSON responses, no session id. |
| `/i/:token` | GET | Foldkit SSR page P14/P15 | None | Public Share Link page. It reads `/api/v1/share/{token}` server-side with the visitor caller. Sends `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`, `Cache-Control: private, no-store`. |
| `/app/*` | GET | Static Expo web export (PWA) | None (the app signs in through the API) | `index.html` is `no-cache`; hashed assets are `public, max-age=31536000, immutable`. Unknown paths under `/app/` fall back to `/app/index.html`. |
| `/api/mobile/updates/manifest` | GET | Expo Updates protocol v1 (section 5) | None | Code-signed manifest per platform, runtime version and channel. |
| `/api/mobile/updates/assets/:hash` | GET | Expo update assets | None | Content-addressed, immutable. |
| `/api/mobile/releases/latest` | GET | Android release JSON (section 5) | None | Feeds `/android` and Obtainium. |
| `/api/mobile/releases/:version/apk` | GET | Signed APK download | None | `Content-Disposition: attachment; filename="kvitbit-<version>.apk"`. |
| `/healthz` | GET | Raw route | None | 200 `{ "status": "ok" }` when the process is up and `SELECT 1` answers within 1 s, else 503. No other detail. |
| everything else | GET, HEAD (POST for SSR form actions) | Foldkit SSR (ADR 0001) | Session cookie when present | Public Web, App Web, `/android`, P10 invitation page at `/invite/:token`, P16 consent page at `/oauth/consent`. |

Cross-cutting edge behaviour:

- TLS terminates at Cloud Run or the self-host reverse proxy. The server trusts `X-Forwarded-For` only from the configured proxy hops, for rate limits and `VisitorHash`.
- Every response carries `X-Request-Id` (generated, or echoed when the client sent a valid UUID). Logs and traces carry it too.
- CORS: `/api/v1/*` and `/mcp` allow no cross-origin browser calls by default. Self-hosters can list extra origins. `/mcp` validates `Origin` when present (MCP Streamable HTTP security rule) and rejects unknown origins with 403.
- Request size limits: JSON bodies 1 MB, multipart uploads 20 MB plus 64 KB of overhead, theme JSON 64 KB. Larger bodies get 413 before the handler runs.

---

## 2. Authentication and Caller construction

### 2.1 Credential kinds

Nothing in a `Caller` comes from a request body or a client-chosen field (core rule 2.2). Each credential resolves to a verified `UserId` first, then to a `Caller`.

| Credential | Wire form | Issued by | Accepted on | Channel | Scopes passed to `Workspaces.enter` | Workspace binding |
|---|---|---|---|---|---|---|
| Web session | Cookie `__Secure-kvitbit.session_token` (`HttpOnly`, `Secure`, `SameSite=Lax`) | Better Auth | `/api/v1/*`, `/api/auth/*`, Foldkit SSR | `web` | `"all"` | Any Workspace the user is a Member of |
| Mobile session | `Authorization: Bearer <session token>` (Better Auth `bearer` plugin; the Expo client keeps the token in SecureStore) | Better Auth | `/api/v1/*`, `/api/auth/*` | `mobile` | `"all"` | Any Workspace the user is a Member of |
| API Key | `Authorization: Bearer kvb_<key id>_<secret>` | `POST /api/v1/workspaces/{ws}/api-keys` (Better Auth `apiKey` plugin storage, hashed secret) | `/api/v1/workspaces/{ws}/*` only | `api` | The key's stored scope list | Exactly the Workspace the key was created in |
| MCP access token | `Authorization: Bearer <opaque token>` with audience `https://<host>/mcp` | Better Auth OAuth 2.1 server after P16 consent | `/mcp` only | `mcp` | Expanded from the grant (section 6.3) | Exactly the Workspace picked at consent |

Rules:

- A1. The API Key prefix `kvb_` decides the lookup. A bearer value without it is tried as a Better Auth session token. MCP access tokens are never accepted on `/api/v1` and session tokens and API Keys are never accepted on `/mcp` (RFC 8707 audience binding), so a leaked MCP token cannot drive the REST API and the reverse.
- A2. An API Key or MCP grant acts as the Member who created it. Its scopes only narrow that Member's role at request time (core rule R1), so a demoted creator's key loses access on the next request. Removing the creator from the Workspace, or the creator leaving, revokes their keys and grants in the same step (flow 2.6, 2.7).
- A3. A request to another Workspace with a Workspace-bound credential answers `404 NotFound{entity: "Workspace"}`, the same answer a non-Member gets (core rule R2).
- A4. Account-level endpoints (`/api/v1/me/*`, `GET|POST /api/v1/workspaces`, invitations, OAuth consent) accept only session credentials. An API Key there gets `401 Unauthorized{reason: "credential_not_allowed"}`.
- A5. Cookie-authenticated writes on `/api/v1` must carry an `Origin` (or, failing that, `Referer`) from the trusted origin list, else `403 OriginRejected` (section 3.3). Bearer requests skip it.
- A6. Owner-only danger actions (`transferOwnership`, `close`) need a fresh session: authenticated within the last 5 minutes, through password or passkey re-entry. A stale session gets `401 Unauthorized{reason: "reauthentication_required"}` and the client runs the Better Auth re-auth step, then retries with the same `Idempotency-Key` where one applies.
- A7. Unverified email: Better Auth refuses to create a session until the email is verified (flow 1.2), so the edge never builds a caller for an unverified user.

### 2.2 Scope vocabulary

Core defines `Scope = \`${ScopeArea}:${"read" | "write"}\`` over ten areas: `workspace`, `members`, `contacts`, `catalog`, `documents`, `payments`, `expenses`, `templates`, `reports`, `share`. The edge never invents finer scopes; it only chooses which of these a credential carries.

| Access mode (UI and consent wording) | Core scopes |
|---|---|
| `read` preset ("Read only") | all ten `<area>:read` |
| `read_write` preset ("Read and write") | all ten `<area>:read` and `<area>:write` |
| `custom` (granular scopes) | explicit non-empty subset of `${ScopeArea}:${"read" | "write"}` (selecting `<area>:write` implies `<area>:read`) |

Both API Keys (flow 10.7) and MCP grants (flow 10.8, 10.9) support quick presets (`read`, `read_write`) and granular per-area `read`/`write` selection across all ten `ScopeArea`s in v1, stored as the expanded `Scope[]` list. The wire types, shared by the `apiKeys`, `connectedApps` and `oauthConsent` groups:

```ts
// packages/api-contract/src/edge.ts (ScopeArea and Scope re-exported from @kvitbit/core/contract)
export const ScopeArea = Schema.Literals(["workspace", "members", "contacts", "catalog", "documents", "payments", "expenses", "templates", "reports", "share"])
export const ScopeLevel = Schema.Literals(["read", "write"])
export const Scope = Schema.TemplateLiteral([ScopeArea, ":", ScopeLevel])   // e.g. "documents:write"
export const AccessMode = Schema.Literals(["read", "read_write", "custom"])
/** What a creator or consenting user asks for. Presets expand server-side; custom must be non-empty and `<area>:write` adds `<area>:read`. */
export const AccessRequest = Schema.Union([
  Schema.Struct({ access: Schema.Literals(["read", "read_write"]) }),
  Schema.Struct({ access: Schema.Literal("custom"), scopes: Schema.NonEmptyArray(Scope) }),
])
/** What a stored credential carries: the mode as chosen plus the expanded list. */
export const GrantedAccess = Schema.Struct({ access: AccessMode, scopes: Schema.Array(Scope) })
```

Available scopes are capped at creation/consent by the creator's role (e.g. an `accountant` can only grant `<area>:read`, and only `owner` or `admin` can create API Keys at all). That cap is a convenience; core rule R1 enforces role ∩ scopes on every call regardless.

### 2.3 Middleware and Caller construction

Two middlewares do all of it. `Authentication` turns a credential into a verified principal. `WorkspaceMember` turns the principal plus the `{workspaceId}` path segment into a `MemberCaller` through `Workspaces.enter`. Groups opt into the middleware they need.

```ts
// packages/api-contract/src/security.ts
import { Context, Schema } from "effect"
import { HttpApiMiddleware, HttpApiSecurity } from "effect/unstable/httpapi"
import { Caller, CurrentCaller, UserId, WorkspaceId, Locale } from "@kvitbit/core/contract"
import { Unauthorized } from "./edge-errors.js"

/** What a verified credential proves. Built only by apps/server. */
export interface Principal {
  readonly userId: UserId
  readonly email: string
  readonly channel: "web" | "mobile" | "api" | "mcp"
  readonly credential:
    | { readonly _tag: "Session"; readonly sessionId: string; readonly authenticatedAt: string }
    | { readonly _tag: "ApiKey"; readonly keyId: string; readonly keyName: string; readonly workspaceId: WorkspaceId; readonly scopes: ReadonlyArray<Scope> }
    | { readonly _tag: "McpGrant"; readonly grantId: string; readonly clientId: string; readonly clientName: string; readonly workspaceId: WorkspaceId; readonly scopes: ReadonlyArray<Scope> }
  readonly locale: Locale // account preference, else Accept-Language, else "cs"
}
export class CurrentPrincipal extends Context.Service<CurrentPrincipal, Principal>()("kvitbit/edge/Principal") {}

/** Session (cookie or bearer) or API Key. Provides the principal and an Account caller. */
export class Authentication extends HttpApiMiddleware.Service<Authentication>()("kvitbit/edge/Authentication", {
  provides: [CurrentPrincipal, CurrentCaller], // CurrentCaller = Caller.account(...) at this stage
  error: Unauthorized,
  security: {
    session: HttpApiSecurity.apiKey({ in: "cookie", key: "__Secure-kvitbit.session_token" }),
    bearer: HttpApiSecurity.bearer,
  },
}) {}

/** Replaces CurrentCaller with the MemberCaller from Workspaces.enter. Needs Authentication first. */
export class WorkspaceMember extends HttpApiMiddleware.Service<WorkspaceMember>()("kvitbit/edge/WorkspaceMember", {
  provides: CurrentCaller,
  error: [NotFound.schema, Forbidden.schema],
  requires: CurrentPrincipal,
}) {}

/** Session only: rejects API Keys on account endpoints (rule A4). */
export class SessionOnly extends HttpApiMiddleware.Service<SessionOnly>()("kvitbit/edge/SessionOnly", {
  error: Unauthorized,
  requires: CurrentPrincipal,
}) {}

/** Public Share Link visitor. Provides Caller.shareLinkVisitor from the {token} path segment. */
export class ShareLinkVisitor extends HttpApiMiddleware.Service<ShareLinkVisitor>()("kvitbit/edge/ShareLinkVisitor", {
  provides: CurrentCaller,
}) {}
```

Server implementation, in order, for a Workspace route:

```ts
// apps/server/src/edge/WorkspaceMemberLive.ts (sketch)
export const WorkspaceMemberLive = Layer.effect(WorkspaceMember, Effect.gen(function* () {
  const workspaces = yield* Workspaces
  return WorkspaceMember.of(Effect.gen(function* () {
    const principal = yield* CurrentPrincipal
    const workspaceId = yield* pathParam("workspaceId", WorkspaceId) // 404 NotFound{Workspace} when malformed
    const bound = principal.credential._tag === "Session" ? null : principal.credential.workspaceId
    if (bound !== null && bound !== workspaceId) {
      return yield* new NotFound({ entity: "Workspace", id: workspaceId }) // rule A3
    }
    const scopes = principal.credential._tag === "Session" ? "all" : principal.credential.scopes
    // enter runs as the Account caller Authentication provided; it re-reads the role on every request
    const c = principal.credential
    const client = c._tag === "ApiKey" ? { kind: "api_key" as const, id: c.keyId, name: c.keyName }
      : c._tag === "McpGrant" ? { kind: "mcp" as const, id: c.grantId, name: c.clientName }
      : undefined
    return yield* workspaces.enter(workspaceId, { scopes, channel: principal.channel, client })
  }))
}))
```

1. `Authentication` reads the cookie or bearer value. Session: `auth.api.getSession` with the request headers. API Key: hash lookup, check not revoked or expired, update `lastUsedAt` at most once a minute. Failure is `401 Unauthorized` with `WWW-Authenticate: Bearer realm="kvitbit"` for bearer callers.
2. It provides `CurrentPrincipal` and `CurrentCaller = Caller.account({ userId, email, locale, channel })`.
3. `WorkspaceMember` applies rule A3, then calls `Workspaces.enter(workspaceId, { scopes, channel })`. `NotFound` means not a Member (existence not revealed). The returned `MemberCaller` replaces `CurrentCaller` for the handler.
4. The handler calls exactly one module method (sometimes two for a read-after-write such as `create` then `current`). Core runs `can(caller, action)` first, then request-log replay (rule R1a), so a Member who lost access never replays a stored result.
5. Public share routes skip 1 to 3. `ShareLinkVisitor` builds `Caller.shareLinkVisitor({ token, visitor: VisitorHash(ip, userAgent), locale })` from the path and connection.

Core gap G7 (section 9, resolved): audit entries show "X via <client name>" for MCP and "X via API Key <name>" for keys. The edge passes the verified `client` (`ClientRef`) to `enter`, which copies it into `MemberCaller.client` and the audit actor.

### 2.4 Locale

`Principal.locale` is the account preference when set, else the first supported tag in `Accept-Language` (`cs` or `en`), else `cs`. It feeds `MemberCaller.locale` and `AccountCaller.locale`. Document, PDF and email language never come from this header; core resolves them from the document, Contact and Workspace.

### 2.5 Rate limits

Limits run in the edge before auth where possible, keyed as stated. Breaches answer `429 RateLimited{retryAfterSeconds}` plus `Retry-After`.

| Surface | Key | Limit |
|---|---|---|
| `/api/auth/*` sign-up, sign-in, magic link, password reset | IP and email | Better Auth `rateLimit`: 5 per minute per email, 20 per minute per IP |
| `GET /api/v1/bot-protection/challenges/{scope}` | IP | 30 per minute |
| `GET /api/v1/registry/companies/{ico}`, `POST .../contacts/from-ico` | user | 20 per minute (protects ARES) |
| `POST /api/v1/themes/resolve`, `POST .../branding/preview-pdf` | user | 60 and 30 per minute |
| `/api/v1/*` with an API Key | key | 600 per minute |
| `/api/v1/*` with a session | user | 1200 per minute |
| `/mcp` | grant | 300 per minute |
| `/api/v1/share/{token}/*`, `/i/:token` | IP | 120 per minute |
| `GET /api/v1/invitations/{token}` | IP | 30 per minute |

Hosted counters live in Postgres (one table, sliding window per key and minute) so every Cloud Run instance shares them. Self-hosted installs use the same table.

### 2.6 ALTCHA bot protection at the edge

`BotProtection` is the edge-only port from core-ports section 6, adapter `AltchaBotProtection` (ADR 0002). It guards the Better Auth endpoints that create accounts or send mail to arbitrary addresses.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v1/bot-protection/challenges/{scope}` | GET | Issues a fresh HMAC-signed, expiring ALTCHA v2 challenge for `scope`. `Cache-Control: no-store`. Answers `204 No Content` when the install runs `NoopBotProtection`, so clients skip the widget. |
| `X-Altcha` request header | | Base64 ALTCHA payload (the solved challenge) on each protected POST below. |

Protected Better Auth endpoints and their fixed scopes:

| Better Auth path | `BotScope` |
|---|---|
| `POST /api/auth/sign-up/email` | `sign_up` |
| `POST /api/auth/sign-in/email` | `sign_in` |
| `POST /api/auth/sign-in/magic-link` | `magic_link` |
| `POST /api/auth/request-password-reset` | `password_reset` |
| `POST /api/v1/invitations/{token}/accept` when it creates an account (P10 "Create account") | `invitation_accept` |

```ts
// apps/server/src/auth/altcha-hook.ts (sketch)
const protectedPaths: Record<string, BotScope> = {
  "/sign-up/email": "sign_up",
  "/sign-in/email": "sign_in",
  "/sign-in/magic-link": "magic_link",
  "/request-password-reset": "password_reset",
}
export const altchaBeforeHook = createAuthMiddleware(async (ctx) => {
  const scope = protectedPaths[ctx.path]
  if (scope === undefined) return
  const payload = ctx.headers?.get("x-altcha") ?? ""
  // runPromise bridges Better Auth's promise hooks into the Effect runtime that owns BotProtection
  await runtime.runPromise(BotProtection.use((bp) => bp.verify(scope, payload)).pipe(
    Effect.catchTag("InvalidBotProof", () => Effect.fail(new APIError("BAD_REQUEST", { code: "InvalidBotProof" }))),
  ))
})
```

Rules:

- B1. The scope comes from the route, never from the client. A challenge issued for one scope fails verification on another, because the scope is inside the signed challenge.
- B2. `verify` checks HMAC, proof of work and expiry, then consumes the challenge with an atomic Postgres insert, before Better Auth runs any side effect. A replayed or expired payload fails.
- B3. Failure answers `400 { "_tag": "InvalidBotProof" }`. The client restarts the widget and keeps the form values (flow 1.2).
- B4. There is no standalone verify endpoint: verifying would burn the single-use challenge before the real request.
- B5. `GET /api/v1/config` reports `botProtection: "altcha" | "none"` so clients know whether to load the solver.
- B6. `BotProtectionUnavailable` (store down) answers `503 Unavailable` with `Retry-After: 5`. It never fails open.

### 2.7 Better Auth surface

Better Auth owns `/api/auth/*` (names to confirm against the pinned Better Auth version, section 10). The contract does not wrap these in `HttpApi`; ui-port calls them through the Better Auth client.

| Flow | Better Auth endpoints |
|---|---|
| 1.2 Sign up | `POST sign-up/email`, `GET verify-email`, `POST send-verification-email` |
| 1.3 Password | `POST sign-in/email` |
| 1.4 Magic link | `POST sign-in/magic-link`, `GET magic-link/verify` |
| 1.5 Passkeys | `passkey/generate-register-options`, `passkey/verify-registration`, `passkey/generate-authenticate-options`, `passkey/verify-authentication`, `passkey/list-user-passkeys`, `passkey/update-passkey`, `passkey/delete-passkey` |
| 1.6 Reset password | `POST request-password-reset`, `POST reset-password` |
| 1.8 Account and security | `POST update-user` (name), `POST change-email`, `POST change-password`, `GET list-sessions`, `POST revoke-session`, `POST revoke-other-sessions` |
| 1.9 Delete account | `POST delete-user`, guarded by a before-hook that calls core to check Workspace ownership (flow 1.9 branches; core gap G10) |
| 1.10 Log out | `POST sign-out` |
| 10.8 OAuth 2.1 | `GET oauth2/authorize`, `POST oauth2/token`, `POST oauth2/register` (dynamic client registration), `POST oauth2/revoke`, consent through `/api/v1/oauth/consents/{consentId}` (section 3.5.2) |

Better Auth configuration: email and password with verification required, magic link, passkey (RP ID = host), `bearer` (mobile), `expo` (deep-link callback for the native app), `apiKey` (storage for `kvb_` keys, no Better Auth key routes exposed), OAuth 2.1 provider with opaque tokens, PKCE S256 required, refresh token rotation. Hooks: ALTCHA (section 2.6), invitation-locked email on sign-up (flow 2.5), account deletion guard.

---
## 3. The `HttpApi` contract

### 3.1 Package layout

```
packages/api-contract/src/
  index.ts          export { Api } and every group, schema and error below
  http.ts           shared headers, page query, entity tags, status helpers
  edge-errors.ts    the seven edge errors (section 3.3)
  security.ts       Authentication, SessionOnly, WorkspaceMember, ShareLinkVisitor middleware tags
  theme.ts          re-exports Hex, ThemePresetId, ThemeSource from @kvitbit/core/contract;
                    adds ThemePresets, ResolvedTheme (agreement AG-HTTP-THEME)
  edge.ts           edge-owned views: ConfigView, AccountPreferences, BrandingView, ApiKeyView,
                    ConnectedAppView, ConsentView, ReleaseInfo (InvitationPeek comes from core)
  groups/*.ts       one file per HttpApiGroup (section 3.5)
```

`packages/api-contract` imports only `effect` and `@kvitbit/core/contract`. It is safe for browser and React Native bundles, like `/contract`. `apps/server` implements it with `HttpApiBuilder.group(Api, "<group>", (handlers) => ...)`, one handler per endpoint, each calling one core method. ui-port builds `KvitbitApi = HttpApiClient.make(Api, { baseUrl })` and adds nothing on top (agreement AG-UI-1).

```ts
// packages/api-contract/src/index.ts
import { HttpApi, OpenApi } from "effect/unstable/httpapi"

export class Api extends HttpApi.make("kvitbit")
  // public
  .add(ConfigGroup).add(BotProtectionGroup).add(PublicShareGroup).add(InvitationsGroup)
  // account (session only)
  .add(MeGroup).add(MyWorkspacesGroup).add(OAuthConsentGroup).add(RegistryGroup).add(ThemesGroup)
  // workspace (session or API Key, then Workspaces.enter)
  .add(WorkspaceGroup).add(TeamGroup).add(BrandingGroup).add(ApiKeysGroup).add(ConnectedAppsGroup)
  .add(ContactsGroup).add(PriceListGroup).add(DocumentsGroup).add(ShareLinksGroup)
  .add(PaymentsGroup).add(ExpensesGroup).add(TemplatesGroup).add(ReportsGroup)
  .prefix("/api/v1")
  .annotate(OpenApi.Title, "kvitbit API")
  .annotate(OpenApi.Version, "1.0.0") {}
```

### 3.2 Conventions

```ts
// packages/api-contract/src/http.ts
import { Context, Schema } from "effect"
import { HttpApiSchema } from "effect/unstable/httpapi"

/** Strong entity tag holding a revision: `"7"`. Weak tags (W/) and `*` are rejected. */
export const EntityTag = Schema.String.pipe(Schema.pattern(/^"(0|[1-9]\d{0,9})"$/))
export const parseEntityTag = (tag: string): number => Number(tag.slice(1, -1))
export const entityTag = (revision: number): string => `"${revision}"`

/** Client-chosen retry key. UUIDv7 recommended. Maps to RequestOptions.requestKey. */
export const IdempotencyKey = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{8,128}$/))

export const IfMatchHeaders = Schema.Struct({ "if-match": Schema.optional(EntityTag) })
export const IdempotencyHeaders = Schema.Struct({ "idempotency-key": Schema.optional(IdempotencyKey) })
export const WriteHeaders = Schema.Struct({ ...IfMatchHeaders.fields, ...IdempotencyHeaders.fields })

/** Query fields every paged list accepts, merged with the list's own filter fields. */
export const PageQueryFields = {
  cursor: Schema.optional(Schema.String.pipe(Schema.maxLength(512))),
  limit: Schema.optional(Schema.NumberFromString.pipe(Schema.int(), Schema.between(1, 100))), // default 50
}

/** Endpoint annotation: the success value has a `revision`, so the server sets `ETag` from it. */
export class Revisioned extends Context.Reference<boolean>()("kvitbit/http/Revisioned", { defaultValue: () => false }) {}

export const Created = <S extends Schema.Top>(schema: S) => schema.pipe(HttpApiSchema.status(201))
export const Accepted = <S extends Schema.Top>(schema: S) => schema.pipe(HttpApiSchema.status(202))
export const NoContent = HttpApiSchema.NoContent // 204
```

Request and response rules:

| Concern | Rule |
|---|---|
| Content types | Requests: `application/json`, or `multipart/form-data` on upload endpoints. Responses: `application/json`, or the file's own type on download endpoints. `Accept` is not negotiated. |
| Status codes | Read 200. Create 201 with `Location` and `ETag`. Action 200 with the updated view. Queued delivery 202. Delete, revoke and archive 204. |
| `ETag` | Every endpoint whose success value has a `revision` field sets `ETag: "<revision>"` (annotation `Revisioned`, applied by the server's `EntityTagResponse` middleware). Lists and reports carry no `ETag`. |
| `If-Match` | Required on every endpoint whose core method takes `expectedRevision` (marked "If-Match" in the tables). Missing: `428 PreconditionRequired`. Stale: `412 PreconditionFailed{currentRevision}`. `If-None-Match` is not supported in v1. |
| `Idempotency-Key` | Accepted on every endpoint whose core method takes `RequestOptions` (marked "Idem" in the tables), optional but strongly recommended; ui-port always sends one, minted per user intent and reused on retry (AG-UI-1). Ignored elsewhere. A replay returns the stored result with `Idempotent-Replayed: true` (needs core gap G1). Same key with a different payload: `409 Conflict{idempotency_mismatch}`. Keys live 24 hours, scoped to the Workspace (or user for account endpoints). |
| Pagination | Paged lists take `cursor`, `limit` and flat filter params decoded by one schema per list, and return `Page<A>` = `{ items, nextCursor: string | null }`. The cursor is opaque and bound to a hash of the filters; reusing it with other filters gives `422 Invalid{page.cursor_mismatch}`. Order is fixed per list in v1 (documents: `issuedOn` desc then id desc; expenses: `receivedOn` desc then id desc; contacts: name asc then id asc). Bounded collections (price list, templates, series, bank accounts, members, invitations, API Keys, connected apps, my Workspaces) return plain arrays. |
| Money and dates | Decimal strings, `IsoDate`, ISO-8601 instants (UTC), as in the core schemas. |
| Unknown fields | Request payloads reject unknown fields (`onExcessProperty: "error"`) so typos fail loudly as `422 Invalid`. |

How a handler maps `If-Match` and 412 (the council rule: core keeps 409, the HTTP edge turns a failed `If-Match` into 412):

```ts
// apps/server/src/http/preconditions.ts
export const withRevision = <A, E, R>(
  ifMatch: string | undefined,
  run: (expectedRevision: number) => Effect.Effect<A, E | Conflict, R>,
): Effect.Effect<A, E | Conflict | PreconditionRequired | PreconditionFailed, R> =>
  ifMatch === undefined
    ? Effect.fail(new PreconditionRequired({}))
    : run(parseEntityTag(ifMatch)).pipe(
        Effect.catchIf(
          (e): e is Conflict => e instanceof Conflict && e.reason === "revision_changed",
          (e) => Effect.fail(new PreconditionFailed({ currentRevision: e.currentRevision ?? null })),
        ),
      )

// usage in the documents group
handlers.handle("edit", ({ params, headers, payload }) =>
  withRevision(headers["if-match"], (rev) => Documents.use((d) => d.edit(params.documentId, payload, rev))))
```

Any other `Conflict` reason (for example `document_locked`) stays 409.

### 3.3 Errors and status mapping

The five core errors carry their status through `HttpApiSchema.status` (core-ports section 3), so every endpoint lists them in `error` and the encoder needs no per-endpoint mapping. The body is the encoded tagged error, for example `{ "_tag": "Conflict", "reason": "document_locked" }`.

| Error | Source | Status | Extra headers | Typical cause |
|---|---|---|---|---|
| `NotFound{entity, id}` | core | 404 | | Unknown id, another Workspace's record (rule R2), not a Member, unknown share token |
| `Forbidden{action}` | core | 403 | | Role or scope does not allow the action, closed Workspace (W5) |
| `Invalid{issues}` | core | 422 | | Schema decode failure of the payload, or a domain validation (`IssueCode`) |
| `Conflict{reason, currentRevision?, detail?}` | core | 409 | | `document_locked`, `illegal_transition`, `duplicate`, `idempotency_mismatch`; `revision_changed` only when no `If-Match` was involved (MCP) |
| `Unavailable{dependency, retryAfterSeconds?}` | core | 503 | `Retry-After` when set | ARES, CNB, blob storage or database down |
| `Unauthorized{reason}` | edge | 401 | `WWW-Authenticate` | `missing`, `invalid`, `expired`, `credential_not_allowed`, `reauthentication_required` |
| `InvalidBotProof` | edge | 400 | | ALTCHA payload missing, wrong scope, expired or replayed |
| `OriginRejected` | edge | 403 | | Cookie write from an untrusted `Origin` (rule A5), or a `/mcp` request from an unknown `Origin` |
| `PreconditionFailed{currentRevision}` | edge | 412 | `ETag` of the current revision | `If-Match` did not match |
| `PayloadTooLarge{limitBytes}` | edge | 413 | | Declared or streamed body over the limit before core sees it |
| `PreconditionRequired` | edge | 428 | | `If-Match` missing on a revisioned write |
| `RateLimited{retryAfterSeconds}` | edge | 429 | `Retry-After` | Section 2.5 |

```ts
// packages/api-contract/src/edge-errors.ts
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  reason: Schema.Literals(["missing", "invalid", "expired", "credential_not_allowed", "reauthentication_required"]),
}) { static schema = this.pipe(HttpApiSchema.status("Unauthorized")) }
export class InvalidBotProof extends Schema.TaggedError<InvalidBotProof>()("InvalidBotProof", {})
  { static schema = this.pipe(HttpApiSchema.status("BadRequest")) }
export class OriginRejected extends Schema.TaggedError<OriginRejected>()("OriginRejected", {})
  { static schema = this.pipe(HttpApiSchema.status("Forbidden")) }
export class PreconditionFailed extends Schema.TaggedError<PreconditionFailed>()("PreconditionFailed", {
  currentRevision: Schema.NullOr(Schema.Int),
}) { static schema = this.pipe(HttpApiSchema.status("PreconditionFailed")) }
export class PayloadTooLarge extends Schema.TaggedError<PayloadTooLarge>()("PayloadTooLarge", {
  limitBytes: Schema.Int,
}) { static schema = this.pipe(HttpApiSchema.status("PayloadTooLarge")) }
export class PreconditionRequired extends Schema.TaggedError<PreconditionRequired>()("PreconditionRequired", {})
  { static schema = this.pipe(HttpApiSchema.status(428)) }
export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
  retryAfterSeconds: Schema.Int,
}) { static schema = this.pipe(HttpApiSchema.status("TooManyRequests")) }

/** Errors every authenticated Workspace endpoint can return besides its core errors. */
export const WorkspaceEdgeErrors = [
  Unauthorized.schema, OriginRejected.schema, RateLimited.schema, PayloadTooLarge.schema,
] as const
export const RevisionedEdgeErrors = [PreconditionFailed.schema, PreconditionRequired.schema] as const
```

Defects (bugs, broken invariants) answer `500 { "_tag": "InternalError", "requestId": "..." }` and are logged with the request id. No stack, SQL or provider text crosses the wire. Schema decode failures of params, query, headers or payload are reported as `422 Invalid` with `code: "request.malformed"` and the failing path, through `HttpApiMiddleware.layerSchemaErrorTransform`, so clients see one validation shape.

ui-port maps `PreconditionFailed` and `Conflict{revision_changed}` to one `StaleRevision` message (AG-UI-1).

### 3.4 Binary transfer

Agreed with ui-port as AG-UI-1 (P5).

Uploads:

| Endpoint | Part | Types | Max size | Core method |
|---|---|---|---|---|
| `POST /api/v1/workspaces/{ws}/expenses/{expenseId}/attachments` | `file` | `application/pdf`, `image/jpeg`, `image/png`, `image/heic` | 20 MB | `Expenses.attach` |
| `PUT /api/v1/workspaces/{ws}/branding/logo` | `file` | `image/png`, `image/jpeg` | 2 MB | core gap G4 (`Workspaces.setBrandingImage`) |
| `PUT /api/v1/workspaces/{ws}/branding/stamp` | `file` | `image/png`, `image/jpeg` | 2 MB | core gap G4 |

- The body is `multipart/form-data` with exactly one part named `file` carrying a filename and a content type. Expo uses `expo-file-system` `uploadAsync` in MULTIPART mode with field name `file` and the bearer header; web posts a `FormData`.
- The server streams the part to core (`HttpApiSchema.asMultipartStream` with a 20 MB part limit). Nothing is buffered whole in memory.
- A declared `Content-Length` over the limit fails `413 PayloadTooLarge` before streaming. A stream that grows past the limit fails in core as `422 Invalid{attachment.too_large}`. A wrong type fails `422 Invalid{attachment.type_rejected}` (core sniffs magic bytes, not only the declared type). SVG is rejected for branding because it can carry script.
- `Expenses.attach` is idempotent by content hash, so retrying an upload (offline queue, flow 5.2) never makes a second attachment.
- `GET /api/v1/config` returns the limits and types so clients validate before uploading.

Downloads:

| Endpoint | Core method | Content type |
|---|---|---|
| `GET /api/v1/workspaces/{ws}/documents/{documentId}/pdf?template&language&disposition` | `Documents.pdf` | `application/pdf` |
| `GET /api/v1/workspaces/{ws}/expenses/{expenseId}/attachments/{attachmentId}?disposition` | `Expenses.attachment` | stored type |
| `GET /api/v1/workspaces/{ws}/reports/{report}/export?format&from&to&groupBy` | `Reports.export` | `text/csv; charset=utf-8` or `application/pdf` |
| `GET /api/v1/workspaces/{ws}/branding/{logo or stamp}` | core gap G4 | stored type |
| `POST /api/v1/workspaces/{ws}/branding/preview-pdf` | core gap G5 | `application/pdf`, always inline |
| `GET /api/v1/workspaces/{ws}/exports/{exportId}/file` | core gap G9 | `application/zip` |
| `GET /api/v1/share/{token}/pdf?language` | `PublicShareLinks.pdf` | `application/pdf` |
| `GET /api/v1/share/{token}/logo` | core gap G4 | stored type |

- Response headers: `Content-Type`, `Content-Disposition` (`attachment` by default, `inline` with `?disposition=inline` for in-app viewers; filename in RFC 6266 `filename*=UTF-8''...` form, from `FileDownload.filename`), `Content-Length` when known, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`. Branding images add a strong `ETag` of the content hash and `Cache-Control: private, max-age=300`.
- Authentication is the same as the rest of the API: the cookie on web (an anchor `href` works), the bearer header on Expo (`downloadAsync` with headers). No signed URLs in v1.
- The success schema is `HttpApiSchema.asUint8Array` for small bodies and a streamed body for PDFs and exports, so a large export never sits in memory.

### 3.5 Groups

22 groups, 104 endpoints. In the tables, `{ws}` is `/api/v1/workspaces/{workspaceId}`, "If-Match" marks a required `If-Match` (412 and 428 apply), "Idem" marks an accepted `Idempotency-Key`, and "G<n>" marks an endpoint that waits on a core gap from section 9. Every Workspace group runs `Authentication` then `WorkspaceMember`, so its endpoints can also fail with `Unauthorized`, `OriginRejected`, `RateLimited`, `NotFound{Workspace}` and `Forbidden`; the tables list only the errors beyond those.

#### 3.5.1 Public groups (no credential)

| Group | Endpoint | Method and path | Backed by | Success | Errors |
|---|---|---|---|---|---|
| `config` | `getConfig` | `GET /api/v1/config` | apps/server config | `ConfigView` | |
| `botProtection` | `issueChallenge` | `GET /api/v1/bot-protection/challenges/{scope}` | `BotProtection.issue` | `AltchaChallenge`, or 204 when Noop | `RateLimited`, `Unavailable` |
| `publicShare` | `open` | `GET /api/v1/share/{token}` | `PublicShareLinks.open` | `SharedDocumentView` | `NotFound`, `RateLimited` |
| `publicShare` | `pdf` | `GET /api/v1/share/{token}/pdf?language` | `PublicShareLinks.pdf` | PDF bytes | `NotFound`, `Unavailable`, `RateLimited` |
| `publicShare` | `logo` | `GET /api/v1/share/{token}/logo` | G4 | image bytes | `NotFound` |
| `invitations` | `peek` | `GET /api/v1/invitations/{token}` | G3 (`Workspaces.peekInvitation`) | `InvitationPeek` | `NotFound`, `RateLimited` |
| `invitations` | `accept` | `POST /api/v1/invitations/{token}/accept` | `Workspaces.acceptInvitation` (session required) | `WorkspaceSummary` | `Unauthorized`, `NotFound`, `Conflict` |

```ts
// packages/api-contract/src/groups/public.ts
export const ConfigView = Schema.Struct({
  version: Schema.String,
  botProtection: Schema.Literals(["altcha", "none"]),
  uploads: Schema.Struct({
    attachment: Schema.Struct({ maxBytes: Schema.Int, types: Schema.Array(Schema.String) }),
    brandingImage: Schema.Struct({ maxBytes: Schema.Int, types: Schema.Array(Schema.String) }),
    themeJson: Schema.Struct({ maxBytes: Schema.Int }),
  }),
  features: Schema.Struct({ signUp: Schema.Boolean, mcp: Schema.Boolean, apiKeys: Schema.Boolean }),
})

export class ConfigGroup extends HttpApiGroup.make("config")
  .add(HttpApiEndpoint.get("getConfig", "/config", { success: ConfigView })) {}

export const BotScope = Schema.Literals(["sign_up", "sign_in", "magic_link", "password_reset", "invitation_accept"])
export class BotProtectionGroup extends HttpApiGroup.make("botProtection")
  .add(HttpApiEndpoint.get("issueChallenge", "/bot-protection/challenges/:scope", {
    params: { scope: BotScope },
    success: [AltchaChallenge, HttpApiSchema.NoContent],
    error: [RateLimited.schema, Unavailable.schema],
  })) {}

export class PublicShareGroup extends HttpApiGroup.make("publicShare")
  .add(HttpApiEndpoint.get("open", "/", { success: SharedDocumentView, error: [NotFound.schema, RateLimited.schema] }))
  .add(HttpApiEndpoint.get("pdf", "/pdf", {
    query: { language: Schema.optional(Locale) },
    success: PdfBytes, // HttpApiSchema.asUint8Array({ contentType: "application/pdf" })
    error: [NotFound.schema, Unavailable.schema, RateLimited.schema],
  }))
  .add(HttpApiEndpoint.get("logo", "/logo", { success: ImageBytes, error: NotFound.schema }))
  .prefix("/share/:token")
  .middleware(ShareLinkVisitor) {}

// InvitationPeek is defined in @kvitbit/core/contract (core-ports 4.1); shown for reference.
export const InvitationPeek = Schema.Struct({
  workspaceName: Schema.String,
  inviterName: Schema.String,
  role: Schema.Literals(["admin", "member", "accountant"]),
  email: Schema.String,             // shown and locked on the sign-up form (flow 2.5)
  status: Schema.Literals(["pending", "expired", "revoked", "accepted"]),
  expiresAt: Schema.String,
})
export class InvitationsGroup extends HttpApiGroup.make("invitations")
  .add(HttpApiEndpoint.get("peek", "/invitations/:token", {
    params: { token: Schema.String }, success: InvitationPeek, error: [NotFound.schema, RateLimited.schema],
  }))
  .add(HttpApiEndpoint.post("accept", "/invitations/:token/accept", {
    params: { token: Schema.String },
    success: WorkspaceSummary,
    error: [Unauthorized.schema, NotFound.schema, Conflict.schema, Forbidden.schema],
  }).middleware(Authentication).middleware(SessionOnly)) {}
```

Notes:

- `open` records a view (deduplicated per visitor per hour in core). When the request also carries a session of a Member of the issuing Workspace, the page shows "You are viewing as the issuer" and no view should be recorded (flow 8.2); that needs core gap G15.
- `peek` is anonymous because P10 must show the invited email before the visitor has an account. It reveals only the fields above, answers `NotFound` for unknown tokens, and is rate limited.
- `accept` for a visitor without an account: the client first signs up through Better Auth with the invited email locked and `X-Altcha` scope `invitation_accept`; Better Auth marks the email verified because the invitation link proved it (flow 2.5), then the client calls `accept`.

#### 3.5.2 Account groups (session only)

These run `Authentication` then `SessionOnly`. The caller is an `AccountCaller`.

| Group | Endpoint | Method and path | Backed by | Headers | Success | Errors |
|---|---|---|---|---|---|---|
| `me` | `getPreferences` | `GET /api/v1/me/preferences` | Better Auth user record | | `AccountPreferences` (ETag) | |
| `me` | `updatePreferences` | `PATCH /api/v1/me/preferences` | Better Auth user record | If-Match | `AccountPreferences` (ETag) | `Invalid` |
| `myWorkspaces` | `listMine` | `GET /api/v1/workspaces` | `Workspaces.listMine` | | `WorkspaceSummary[]` | |
| `myWorkspaces` | `create` | `POST /api/v1/workspaces` | `Workspaces.create`, then `current` as the new owner | Idem | 201 `WorkspaceView` (ETag, Location) | `Invalid`, `Unavailable` |
| `oauthConsent` | `getConsent` | `GET /api/v1/oauth/consents/{consentId}` | Better Auth OAuth provider + `listMine` | | `ConsentView` | `NotFound` |
| `oauthConsent` | `decide` | `POST /api/v1/oauth/consents/{consentId}` | Better Auth OAuth provider + `Workspaces.enter` | | `ConsentResult` | `NotFound`, `Invalid`, `Forbidden` |
| `registry` | `lookupCompany` | `GET /api/v1/registry/companies/{ico}` | G2 (`Workspaces.lookupCompany`) | | `RegistryResult` | `Invalid{ico.checksum}`, `NotFound`, `Unavailable`, `RateLimited` |
| `themes` | `resolve` | `POST /api/v1/themes/resolve` | `ThemeResolver` (apps/server) | | `ResolvedTheme` | `Invalid{theme.*}`, `RateLimited` |

`registry` and `themes` also accept API Keys and any session, because both are pure lookups with no Workspace data; they skip `SessionOnly`.

```ts
// packages/api-contract/src/groups/account.ts
export class MeGroup extends HttpApiGroup.make("me")
  .add(HttpApiEndpoint.get("getPreferences", "/me/preferences", { success: AccountPreferences }).annotate(Revisioned, true))
  .add(HttpApiEndpoint.patch("updatePreferences", "/me/preferences", {
    headers: IfMatchHeaders,
    payload: AccountPreferencesPatch, // { locale?: Locale | null, theme?: ThemePreference }
    success: AccountPreferences,
    error: [Invalid.schema, ...RevisionedEdgeErrors],
  }).annotate(Revisioned, true))
  .middleware(Authentication).middleware(SessionOnly) {}

export class MyWorkspacesGroup extends HttpApiGroup.make("myWorkspaces")
  .add(HttpApiEndpoint.get("listMine", "/workspaces", { success: Schema.Array(WorkspaceSummary) }))
  .add(HttpApiEndpoint.post("create", "/workspaces", {
    headers: IdempotencyHeaders,
    payload: NewWorkspace,
    success: Created(WorkspaceView),
    error: [Invalid.schema, Unavailable.schema, Forbidden.schema],
  }).annotate(Revisioned, true))
  .middleware(Authentication).middleware(SessionOnly) {}

export const ConsentView = Schema.Struct({
  client: Schema.Struct({ id: Schema.String, name: Schema.String, redirectHost: Schema.String, logoUri: Schema.NullOr(Schema.String) }),
  requestedAccess: AccessMode,                          // from the OAuth scope parameter (section 6.3)
  requestedScopes: Schema.Array(Scope),                 // expanded; preselected in the granular picker
  workspaces: Schema.Array(Schema.Struct({
    id: WorkspaceId, name: Schema.String, role: Role,
    maxAccess: Schema.Literals(["read", "read_write"]), // accountant: read
    grantableScopes: Schema.Array(Scope),               // role cap per area; accountant: the ten <area>:read
  })),
})
export const ConsentDecision = Schema.Union([
  Schema.TaggedStruct("Approve", { workspace: WorkspaceId, grant: AccessRequest }),
  Schema.TaggedStruct("Deny", {}),
])
export const ConsentResult = Schema.Struct({ redirectTo: Schema.String })

export class OAuthConsentGroup extends HttpApiGroup.make("oauthConsent")
  .add(HttpApiEndpoint.get("getConsent", "/oauth/consents/:consentId", { params: { consentId: Schema.String }, success: ConsentView, error: NotFound.schema }))
  .add(HttpApiEndpoint.post("decide", "/oauth/consents/:consentId", {
    params: { consentId: Schema.String }, payload: ConsentDecision, success: ConsentResult,
    error: [NotFound.schema, Invalid.schema, Forbidden.schema],
  }))
  .middleware(Authentication).middleware(SessionOnly) {}

export class ThemesGroup extends HttpApiGroup.make("themes")
  .add(HttpApiEndpoint.post("resolve", "/themes/resolve", {
    payload: Schema.Struct({ source: ThemeSource, contrast: Schema.optional(ThemeContrast) }),
    success: ResolvedTheme,
    error: [Invalid.schema, RateLimited.schema],
  }))
  .middleware(Authentication) {}
```

Consent rules (flow 10.8):

- `getConsent` answers `NotFound` for an unknown, expired or already decided consent id, and for a client whose redirect URI did not match its registration (P16 shows an error and no approve button).
- `decide` with `Approve` re-checks membership through `Workspaces.enter`, expands `grant` (section 2.2) and rejects any scope outside `grantableScopes` (`Forbidden{action: "grant.create"}`), stores the grant `(clientId, userId, workspaceId, access, scopes)`, and returns the redirect with the authorization code. `Deny` returns the redirect with `error=access_denied` and stores nothing.
- A Member of no Workspace gets `workspaces: []`; P16 tells them to create one first.

Material 3 theme (agreement AG-HTTP-THEME, user requirement for custom palettes):

```ts
// packages/api-contract/src/theme.ts
// Hex, ThemePresetId and ThemeSource are defined in @kvitbit/core/contract (core-ports section 1)
// and re-exported here; they are shown for reference.
export const Hex = Schema.String.pipe(Schema.pattern(/^#[0-9A-Fa-f]{6}$/))
export const ThemePresetId = Schema.Literals(["kvitbit", "forest", "ocean", "plum", "sand", "graphite"])
export const ThemePresets: Record<typeof ThemePresetId.Type, { readonly seed: string; readonly contrast?: "standard" | "medium" | "high" }>
export const ThemeContrast = Schema.Literals(["standard", "medium", "high"])
export const ThemeMode = Schema.Literals(["system", "light", "dark"])
/** Typography and shape style (screen 00): "elegant" is sharp corners and serif display type, "cozy" is soft corners and rounded type. */
export const ThemeStyle = Schema.Literals(["elegant", "cozy"])

export const ThemeSource = Schema.Union([
  Schema.TaggedStruct("Preset", { id: ThemePresetId }),
  Schema.TaggedStruct("Seed", { seed: Hex }),
  /** Raw material-theme.json exported by Google Material Theme Builder, at most 64 KB encoded. */
  Schema.TaggedStruct("MaterialThemeBuilder", { json: Schema.Unknown }),
])

export const ThemePreference = Schema.Struct({
  mode: ThemeMode,
  style: ThemeStyle,                     // default "elegant"; the M3 colour source is independent of style
  contrast: ThemeContrast,
  dynamicColor: Schema.Boolean,          // default true; honoured on Android 12+ only
  source: Schema.NullOr(ThemeSource),    // null follows the Workspace theme
})

const ExtendedColor = Schema.Struct({ color: Hex, onColor: Hex, colorContainer: Hex, onColorContainer: Hex })
const Scheme = Schema.Struct({
  roles: Schema.Record(M3ColorRole, Hex),   // primary, onPrimary, ..., surfaceContainerHighest, the full M3 role set
  extended: Schema.Struct({ paid: ExtendedColor, proforma: ExtendedColor, overdue: ExtendedColor, draft: ExtendedColor }),
})
export const ResolvedTheme = Schema.Struct({
  source: ThemeSource,
  schemes: Schema.Struct({ light: Scheme, dark: Scheme, lightMedium: Scheme, lightHigh: Scheme, darkMedium: Scheme, darkHigh: Scheme }),
})

export const AccountPreferences = Schema.Struct({
  locale: Schema.NullOr(Locale),
  theme: ThemePreference,
  resolvedTheme: Schema.NullOr(ResolvedTheme), // null when source is null
  revision: Schema.Int,
})
```

Theme rules:

- T1. `ThemeResolver` in apps/server uses `@material/material-color-utilities` (pinned, same version as the Expo offline engine). A `Seed` or `Preset` produces all six schemes. A `MaterialThemeBuilder` file must decode as Material Theme Builder JSON (`seed`, `coreColors`, `extendedColors`, `schemes`, `palettes`); its schemes are used as given, missing contrast schemes are generated from its seed, and its `extendedColors` named `paid`, `proforma`, `overdue` or `draft` replace Kvitbit's defaults (their `harmonize` flag is respected).
- T2. Validation failures are `422 Invalid` with `theme.json_invalid`, `theme.too_large` or `theme.seed_invalid`. A file whose schemes fail the M3 contrast floor for `onPrimary`/`primary` and `onSurface`/`surface` (4.5:1) is accepted with a `theme.low_contrast` warning in the resolved view, not rejected.
- T3. The stored value is the `ThemeSource` as sent. `ResolvedTheme` is computed on read and cached by content hash, so a library upgrade re-resolves every theme consistently.
- T4. Precedence for app chrome: Android dynamic colour (when enabled and available), then the account `source`, then the Workspace theme, then the `kvitbit` preset. PDFs and the Public Share Link page use Workspace branding only.
- T5. Account preferences are not core data (auth never enters core). apps/server stores them in a `user_preferences` table keyed by Better Auth user id, with its own `revision`.

#### 3.5.3 Workspace administration groups

| Group | Endpoint | Method and path | Core method | Headers | Success | Errors |
|---|---|---|---|---|---|---|
| `workspace` | `current` | `GET {ws}` | `Workspaces.current` | | `WorkspaceView` (ETag) | |
| `workspace` | `updateIssuingEntity` | `PATCH {ws}/issuing-entity` | `Workspaces.updateIssuingEntity` | If-Match | `WorkspaceView` (ETag) | `Invalid`, `Conflict` |
| `workspace` | `updateSettings` | `PATCH {ws}/settings` | `Workspaces.updateSettings` | If-Match | `WorkspaceView` (ETag) | `Invalid`, `Conflict` |
| `workspace` | `listBankAccounts` | `GET {ws}/bank-accounts` | `Workspaces.current` (projection of its bank accounts) | | `BankAccountView[]` | |
| `workspace` | `createBankAccount` | `POST {ws}/bank-accounts` | `Workspaces.saveBankAccount` | Idem | 201 `BankAccountView` | `Invalid` |
| `workspace` | `updateBankAccount` | `PUT {ws}/bank-accounts/{bankAccountId}` | `Workspaces.saveBankAccount` with id | | `BankAccountView` | `Invalid` |
| `workspace` | `removeBankAccount` | `DELETE {ws}/bank-accounts/{bankAccountId}?replacement` | G14 | | 204 | `Conflict` |
| `workspace` | `listSeries` | `GET {ws}/numbering-series` | `Workspaces.listSeries` | | `NumberingSeriesView[]` | |
| `workspace` | `createSeries` | `POST {ws}/numbering-series` | `Workspaces.configureSeries` | Idem | 201 `NumberingSeriesView` | `Invalid`, `Conflict` |
| `workspace` | `updateSeries` | `PUT {ws}/numbering-series/{seriesId}` | `Workspaces.configureSeries` with id | | `NumberingSeriesView` | `Invalid`, `Conflict` |
| `workspace` | `close` | `POST {ws}/close` | `Workspaces.close` (fresh session, rule A6) | | 204 | `Invalid`, `Unauthorized` |
| `team` | `listMembers` | `GET {ws}/members` | G3 (`Workspaces.members`) | | `MemberView[]` | |
| `team` | `setRole` | `PUT {ws}/members/{userId}/role` | `Workspaces.setRole` | | 204 | `Conflict` |
| `team` | `removeMember` | `DELETE {ws}/members/{userId}` | `Workspaces.setRole(userId, null)` | | 204 | `Conflict` |
| `team` | `leave` | `POST {ws}/members/me/leave` | G3 (`Workspaces.leave`) | | 204 | `Conflict` |
| `team` | `listInvitations` | `GET {ws}/invitations` | G3 (`Workspaces.invitations`) | | `InvitationView[]` | |
| `team` | `invite` | `POST {ws}/invitations` | `Workspaces.invite` | Idem | 201 `InvitationView` | `Invalid`, `Conflict` |
| `team` | `revokeInvitation` | `DELETE {ws}/invitations/{invitationId}` | `Workspaces.revokeInvitation` | | 204 | |
| `team` | `resendInvitation` | `POST {ws}/invitations/{invitationId}/resend` | G3 (`Workspaces.resendInvitation`) | | 202 | `Conflict` |
| `team` | `transferOwnership` | `POST {ws}/ownership-transfer` | `Workspaces.transferOwnership` (fresh session) | | 204 | `Conflict`, `Unauthorized` |
| `branding` | `getBranding` | `GET {ws}/branding` | G4 (fields of `WorkspaceView`) | | `BrandingView` (ETag = Workspace revision) | |
| `branding` | `updateBranding` | `PATCH {ws}/branding` | G4 (`Workspaces.updateSettings` with a `branding` patch) | If-Match | `BrandingView` (ETag) | `Invalid`, `Conflict` |
| `branding` | `putImage` | `PUT {ws}/branding/{image}` (`logo` or `stamp`, multipart) | G4 (`Workspaces.setBrandingImage`) | | `ImageRef` | `Invalid`, `PayloadTooLarge`, `Unavailable` |
| `branding` | `getImage` | `GET {ws}/branding/{image}` | G4 (`Workspaces.brandingImage`) | | image bytes | `Unavailable` |
| `branding` | `removeImage` | `DELETE {ws}/branding/{image}` | G4 (`Workspaces.removeBrandingImage`) | | 204 | |
| `branding` | `previewPdf` | `POST {ws}/branding/preview-pdf` | G5 (`Workspaces.previewBranding`) | | PDF bytes, inline | `Invalid`, `Unavailable`, `RateLimited` |
| `apiKeys` | `listApiKeys` | `GET {ws}/api-keys` | apps/server `ApiKeys` | | `ApiKeyView[]` | |
| `apiKeys` | `createApiKey` | `POST {ws}/api-keys` | apps/server `ApiKeys` | | 201 `ApiKeyCreated` | `Invalid` |
| `apiKeys` | `revokeApiKey` | `DELETE {ws}/api-keys/{keyId}` | apps/server `ApiKeys` | | 204 | |
| `connectedApps` | `listConnectedApps` | `GET {ws}/connected-apps` | apps/server `McpGrants` | | `ConnectedAppView[]` | |
| `connectedApps` | `revokeConnectedApp` | `DELETE {ws}/connected-apps/{grantId}` | apps/server `McpGrants` | | 204 | |

```ts
// packages/api-contract/src/groups/workspace.ts
// The group prefix carries :workspaceId; WorkspaceMember decodes it (section 2.3), so endpoints
// below declare only their own path parameters.

export class WorkspaceGroup extends HttpApiGroup.make("workspace")
  .add(HttpApiEndpoint.get("current", "/", { success: WorkspaceView }).annotate(Revisioned, true))
  .add(HttpApiEndpoint.patch("updateIssuingEntity", "/issuing-entity", {
    headers: IfMatchHeaders, payload: IssuingEntityPatch, success: WorkspaceView,
    error: [Invalid.schema, Conflict.schema, ...RevisionedEdgeErrors],
  }).annotate(Revisioned, true))
  .add(HttpApiEndpoint.patch("updateSettings", "/settings", {
    headers: IfMatchHeaders, payload: WorkspaceSettingsPatch, success: WorkspaceView,
    error: [Invalid.schema, Conflict.schema, ...RevisionedEdgeErrors],
  }).annotate(Revisioned, true))
  .add(HttpApiEndpoint.get("listBankAccounts", "/bank-accounts", { success: Schema.Array(BankAccountView) }))
  .add(HttpApiEndpoint.post("createBankAccount", "/bank-accounts", { headers: IdempotencyHeaders, payload: BankAccountInput, success: Created(BankAccountView), error: Invalid.schema }))
  .add(HttpApiEndpoint.put("updateBankAccount", "/bank-accounts/:bankAccountId", {
    params: { bankAccountId: BankAccountId }, payload: BankAccountInput, success: BankAccountView, error: Invalid.schema,
  }))
  .add(HttpApiEndpoint.delete("removeBankAccount", "/bank-accounts/:bankAccountId", {
    params: { bankAccountId: BankAccountId }, query: { replacement: Schema.optional(BankAccountId) },
    success: NoContent, error: Conflict.schema,
  }))
  .add(HttpApiEndpoint.get("listSeries", "/numbering-series", { success: Schema.Array(NumberingSeriesView) }))
  .add(HttpApiEndpoint.post("createSeries", "/numbering-series", { headers: IdempotencyHeaders, payload: SeriesInput, success: Created(NumberingSeriesView), error: [Invalid.schema, Conflict.schema] }))
  .add(HttpApiEndpoint.put("updateSeries", "/numbering-series/:seriesId", {
    params: { seriesId: NumberingSeriesId }, payload: SeriesInput, success: NumberingSeriesView, error: [Invalid.schema, Conflict.schema],
  }))
  .add(HttpApiEndpoint.post("close", "/close", {
    payload: Schema.Struct({ confirmName: Schema.String }), success: NoContent, error: [Invalid.schema, Unauthorized.schema],
  }))
  .prefix("/workspaces/:workspaceId")
  .middleware(Authentication).middleware(WorkspaceMember)
  .annotate(OpenApi.Description, "Issuing Entity, Tax Regime, defaults, bank accounts and Numbering Series") {}

export class TeamGroup extends HttpApiGroup.make("team")
  .add(HttpApiEndpoint.get("listMembers", "/members", { success: Schema.Array(MemberView) }))
  .add(HttpApiEndpoint.put("setRole", "/members/:userId/role", {
    params: { userId: UserId }, payload: Schema.Struct({ role: Schema.Literals(["admin", "member", "accountant"]) }),
    success: NoContent, error: Conflict.schema,
  }))
  .add(HttpApiEndpoint.delete("removeMember", "/members/:userId", { params: { userId: UserId }, success: NoContent, error: Conflict.schema }))
  .add(HttpApiEndpoint.post("leave", "/members/me/leave", { success: NoContent, error: Conflict.schema }))
  .add(HttpApiEndpoint.get("listInvitations", "/invitations", { success: Schema.Array(InvitationView) }))
  .add(HttpApiEndpoint.post("invite", "/invitations", {
    headers: IdempotencyHeaders,
    payload: Schema.Struct({ email: Schema.String, role: Schema.Literals(["admin", "member", "accountant"]) }),
    success: Created(InvitationView), error: [Invalid.schema, Conflict.schema],
  }))
  .add(HttpApiEndpoint.delete("revokeInvitation", "/invitations/:invitationId", { params: { invitationId: InvitationId }, success: NoContent }))
  .add(HttpApiEndpoint.post("resendInvitation", "/invitations/:invitationId/resend", {
    params: { invitationId: InvitationId }, success: HttpApiSchema.Empty(202), error: Conflict.schema,
  }))
  .add(HttpApiEndpoint.post("transferOwnership", "/ownership-transfer", {
    payload: Schema.Struct({ to: UserId }), success: NoContent, error: [Conflict.schema, Unauthorized.schema],
  }))
  .prefix("/workspaces/:workspaceId")
  .middleware(Authentication).middleware(WorkspaceMember) {}

export const BrandingView = Schema.Struct({
  pdfTemplate: PdfTemplate,         // core: "classic" | "modern_minimal"
  accentColor: Hex,
  footerText: Schema.NullOr(Schema.String),
  theme: Schema.NullOr(ThemeSource),
  resolvedTheme: Schema.NullOr(ResolvedTheme),
  logo: Schema.NullOr(ImageRef),     // { contentType, bytes, sha256, updatedAt }
  stamp: Schema.NullOr(ImageRef),
  revision: Schema.Int,              // the Workspace revision
})
export const BrandingImage = Schema.Literals(["logo", "stamp"])

export class BrandingGroup extends HttpApiGroup.make("branding")
  .add(HttpApiEndpoint.get("getBranding", "/", { success: BrandingView }).annotate(Revisioned, true))
  .add(HttpApiEndpoint.patch("updateBranding", "/", {
    headers: IfMatchHeaders, payload: BrandingPatch, success: BrandingView,
    error: [Invalid.schema, Conflict.schema, ...RevisionedEdgeErrors],
  }).annotate(Revisioned, true))
  .add(HttpApiEndpoint.put("putImage", "/:image", {
    params: { image: BrandingImage },
    payload: HttpApiSchema.asMultipartStream(Schema.Struct({ file: UploadedFile })),
    success: ImageRef, error: [Invalid.schema, PayloadTooLarge.schema, Unavailable.schema],
  }))
  .add(HttpApiEndpoint.get("getImage", "/:image", { params: { image: BrandingImage }, success: ImageBytes, error: Unavailable.schema }))
  .add(HttpApiEndpoint.delete("removeImage", "/:image", { params: { image: BrandingImage }, success: NoContent }))
  .add(HttpApiEndpoint.post("previewPdf", "/preview-pdf", {
    payload: Schema.Struct({ branding: BrandingPatch, kind: DocumentKind, language: Locale }),
    success: PdfBytes, error: [Invalid.schema, Unavailable.schema, RateLimited.schema],
  }))
  .prefix("/workspaces/:workspaceId/branding")
  .middleware(Authentication).middleware(WorkspaceMember) {}

export const ApiKeyView = Schema.Struct({
  id: Schema.String, name: Schema.String, prefix: Schema.String, // "kvb_01J...", shown so users can tell keys apart
  ...GrantedAccess.fields,                                        // access mode and expanded scopes
  createdBy: Schema.Struct({ userId: UserId, name: Schema.String }),
  createdAt: Schema.String, lastUsedAt: Schema.NullOr(Schema.String), expiresAt: Schema.NullOr(Schema.String),
})
export const ApiKeyCreated = Schema.Struct({ key: ApiKeyView, secret: Schema.String }) // secret shown once
const ApiKeyFields = { name: Schema.String, expiresOn: Schema.optional(IsoDate) }
export const ApiKeyCreate = Schema.Union([                       // AccessRequest (section 2.2) plus name and expiry
  Schema.Struct({ ...ApiKeyFields, access: Schema.Literals(["read", "read_write"]) }),
  Schema.Struct({ ...ApiKeyFields, access: Schema.Literal("custom"), scopes: Schema.NonEmptyArray(Scope) }),
])

export class ApiKeysGroup extends HttpApiGroup.make("apiKeys")
  .add(HttpApiEndpoint.get("listApiKeys", "/", { success: Schema.Array(ApiKeyView) }))
  .add(HttpApiEndpoint.post("createApiKey", "/", { // no Idempotency-Key: a replay would have to store the secret
    payload: ApiKeyCreate, // scopes capped by the creator's role
    success: Created(ApiKeyCreated), error: Invalid.schema,
  }))
  .add(HttpApiEndpoint.delete("revokeApiKey", "/:keyId", { params: { keyId: Schema.String }, success: NoContent }))
  .prefix("/workspaces/:workspaceId/api-keys")
  .middleware(Authentication).middleware(SessionOnly).middleware(WorkspaceMember) {}

export const ConnectedAppView = Schema.Struct({
  grantId: Schema.String,
  client: Schema.Struct({ id: Schema.String, name: Schema.String, redirectHost: Schema.String }),
  member: Schema.Struct({ userId: UserId, name: Schema.String }),
  ...GrantedAccess.fields,
  createdAt: Schema.String, lastUsedAt: Schema.NullOr(Schema.String),
})
export class ConnectedAppsGroup extends HttpApiGroup.make("connectedApps")
  .add(HttpApiEndpoint.get("listConnectedApps", "/", { success: Schema.Array(ConnectedAppView) }))
  .add(HttpApiEndpoint.delete("revokeConnectedApp", "/:grantId", { params: { grantId: Schema.String }, success: NoContent }))
  .prefix("/workspaces/:workspaceId/connected-apps")
  .middleware(Authentication).middleware(SessionOnly).middleware(WorkspaceMember) {}
```

Rules for the edge-owned administration endpoints:

- API Keys and MCP grants live in apps/server (Better Auth tables plus `workspace_id`, `created_by`, `access`, `scopes`), not in core. Their permission checks still use the core policy table through `can(caller, action)` with the actions `apiKey.manage` (owner, admin), `grant.read.own`, `grant.read.all`, `grant.revoke.own`, `grant.revoke.all` (core gap G13 adds them to `Action`), so ui-port hides the same controls. Their writes are audited on subject `Workspace` through a small core hook (part of G13), because flow 10.7 and 10.9 changes are security-relevant.
- `createApiKey` caps `access` at the creator's role: an `accountant` cannot reach the endpoint at all (`apiKey.manage`), and a key is never wider than its creator (rule A2). The secret is returned once and stored only as a hash.
- `listConnectedApps` returns the caller's own grants, or every grant in the Workspace for `owner` and `admin` (flow 10.9). `revokeConnectedApp` revokes the grant and every access and refresh token under it; the client gets 401 on its next call.
- `removeMember` and `leave` revoke the affected Member's API Keys and grants in the same request, after core commits the membership change (flow 2.6, 2.7). The response of `removeMember` is 204; the dialog count in flow 2.6 comes from `listApiKeys` and `listConnectedApps` before the call.
- `setRole` to `admin` and `removeMember` of an `admin` are `owner` only (user-flows section 4). Core enforces this with the owner-only action `member.manageAdmins` (core-ports rule R1c).

#### 3.5.4 Domain groups

| Group | Endpoint | Method and path | Core method | Headers | Success | Errors |
|---|---|---|---|---|---|---|
| `contacts` | `search` | `GET {ws}/contacts?text&role&cursor&limit` | `Contacts.search` | | `Page<ContactView>` | `Invalid` |
| `contacts` | `get` | `GET {ws}/contacts/{contactId}` | `Contacts.get` | | `ContactView` (ETag) | |
| `contacts` | `create` | `POST {ws}/contacts` | `Contacts.save` (no id) | Idem | 201 `ContactView` | `Invalid`, `Conflict{duplicate}` |
| `contacts` | `update` | `PUT {ws}/contacts/{contactId}` | `Contacts.save` (id, expectedRevision) | If-Match | `ContactView` (ETag) | `Invalid`, `Conflict` |
| `contacts` | `fromIco` | `POST {ws}/contacts/from-ico` | `Contacts.fromIco` | | `ContactView` (ETag) | `Invalid{ico.checksum}`, `Unavailable`, `RateLimited` |
| `contacts` | `archive` | `POST {ws}/contacts/{contactId}/archive` | `Contacts.archive` | | 204 | |
| `priceList` | `list` | `GET {ws}/price-list-items?text&includeArchived` | `PriceList.list` | | `PriceListItemView[]` | |
| `priceList` | `create` | `POST {ws}/price-list-items` | `PriceList.save` (no id) | Idem | 201 `PriceListItemView` | `Invalid` |
| `priceList` | `update` | `PUT {ws}/price-list-items/{itemId}` | `PriceList.save` (id, expectedRevision) | If-Match | `PriceListItemView` (ETag) | `Invalid`, `Conflict` |
| `priceList` | `archive` | `POST {ws}/price-list-items/{itemId}/archive` | `PriceList.archive` | | 204 | |
| `documents` | `list` | `GET {ws}/documents?<DocumentQuery>&cursor&limit` | `Documents.list` | | `Page<DocumentSummary>` | `Invalid` |
| `documents` | `preview` | `POST {ws}/documents/preview` | `Documents.preview` | | `DocumentView` | `Invalid`, `Unavailable` |
| `documents` | `createDraft` | `POST {ws}/documents` | `Documents.createDraft` | Idem | 201 `DocumentView` | `Invalid`, `Unavailable` |
| `documents` | `issueFromInput` | `POST {ws}/documents/issue` | `Documents.issue({ input })` | Idem | 201 `DocumentView` | core errors |
| `documents` | `get` | `GET {ws}/documents/{documentId}` | `Documents.get` | | `DocumentView` (ETag) | |
| `documents` | `edit` | `PATCH {ws}/documents/{documentId}` | `Documents.edit` | If-Match | `DocumentView` (ETag) | core errors |
| `documents` | `discardDraft` | `DELETE {ws}/documents/{documentId}` | `Documents.discardDraft` | If-Match | 204 | `Conflict{illegal_transition}` |
| `documents` | `issueDraft` | `POST {ws}/documents/{documentId}/issue` | `Documents.issue({ draft, expectedRevision })` | If-Match, Idem | `DocumentView` (ETag) | core errors |
| `documents` | `lock` | `POST {ws}/documents/{documentId}/lock` | `Documents.lock` | | `DocumentView` (ETag) | `Conflict` |
| `documents` | `unlock` | `POST {ws}/documents/{documentId}/unlock` | `Documents.unlock` | | `DocumentView` (ETag) | `Conflict`, `Invalid` |
| `documents` | `cancel` | `POST {ws}/documents/{documentId}/cancel` | `Documents.cancel` | Idem | `CancelResult` | core errors |
| `documents` | `correct` | `POST {ws}/documents/{documentId}/credit-notes` | `Documents.correct` | Idem | 201 `DocumentView` (the Credit Note) | core errors |
| `documents` | `issueFinalInvoice` | `POST {ws}/documents/{documentId}/final-invoice` | `Documents.issueFinalInvoice` | Idem | 201 `DocumentView` | core errors |
| `documents` | `send` | `POST {ws}/documents/{documentId}/deliveries` | `Documents.send` (G11 for `purpose`) | Idem | 202 `{ deliveryId, status: "queued" }` | `Conflict`, `Invalid` |
| `documents` | `pdf` | `GET {ws}/documents/{documentId}/pdf?template&language&disposition` | `Documents.pdf` | | PDF bytes | `Unavailable` |
| `documents` | `history` | `GET {ws}/documents/{documentId}/history` | `Documents.history` | | `AuditEntry[]` | |
| `shareLinks` | `create` | `PUT {ws}/documents/{documentId}/share-link` | `PublicShareLinks.create` | | `{ url }` | `Conflict{illegal_transition}` |
| `shareLinks` | `revoke` | `DELETE {ws}/documents/{documentId}/share-link` | `PublicShareLinks.revoke` | | 204 | |
| `shareLinks` | `views` | `GET {ws}/documents/{documentId}/share-link/views?cursor&limit` | G15 | | `Page<ShareViewEvent>` | |
| `payments` | `record` | `POST {ws}/payments` | `Payments.record` | Idem | 201 `RecordPaymentResult` | core errors |
| `payments` | `remove` | `POST {ws}/payments/{paymentId}/remove` | `Payments.remove` | | 204 | `Conflict{illegal_transition}` |
| `payments` | `listForDocument` | `GET {ws}/documents/{documentId}/payments` | `Payments.listFor({ document })` | | `PaymentView[]` | |
| `payments` | `listForExpense` | `GET {ws}/expenses/{expenseId}/payments` | `Payments.listFor({ expense })` | | `PaymentView[]` | |
| `expenses` | `list` | `GET {ws}/expenses?<ExpenseQuery>&cursor&limit` | `Expenses.list` | | `Page<ExpenseSummary>` | `Invalid` |
| `expenses` | `record` | `POST {ws}/expenses` | `Expenses.record` | Idem | 201 `ExpenseView` | `Invalid`, `Unavailable` |
| `expenses` | `get` | `GET {ws}/expenses/{expenseId}` | `Expenses.get` | | `ExpenseView` (ETag) | |
| `expenses` | `edit` | `PATCH {ws}/expenses/{expenseId}` | `Expenses.edit` | If-Match | `ExpenseView` (ETag) | `Invalid`, `Conflict`, `Unavailable` |
| `expenses` | `remove` | `DELETE {ws}/expenses/{expenseId}` | `Expenses.remove` | If-Match | 204 | `Conflict` |
| `expenses` | `attach` | `POST {ws}/expenses/{expenseId}/attachments` (multipart) | `Expenses.attach` | | 201 `AttachmentView` | `Invalid`, `PayloadTooLarge`, `Unavailable` |
| `expenses` | `attachment` | `GET {ws}/expenses/{expenseId}/attachments/{attachmentId}?disposition` | `Expenses.attachment` | | file bytes | `Unavailable` |
| `expenses` | `detach` | `DELETE {ws}/expenses/{expenseId}/attachments/{attachmentId}` | `Expenses.detach` | | 204 | |
| `templates` | `list` | `GET {ws}/templates` | `Templates.list` | | `TemplateView[]` | |
| `templates` | `get` | `GET {ws}/templates/{templateId}` | `Templates.get` | | `TemplateView` (ETag) | |
| `templates` | `create` | `POST {ws}/templates` | `Templates.save` (no id) | Idem | 201 `TemplateView` | `Invalid` |
| `templates` | `update` | `PUT {ws}/templates/{templateId}` | `Templates.save` (id, expectedRevision) | If-Match | `TemplateView` (ETag) | `Invalid`, `Conflict` |
| `templates` | `archive` | `POST {ws}/templates/{templateId}/archive` | `Templates.archive` | | 204 | |
| `templates` | `setSchedule` | `PUT {ws}/templates/{templateId}/schedule` | `Templates.schedule(id, schedule, rev)` | If-Match | `TemplateView` (ETag) | `Invalid`, `Conflict` |
| `templates` | `removeSchedule` | `DELETE {ws}/templates/{templateId}/schedule` | `Templates.schedule(id, null, rev)` | If-Match | `TemplateView` (ETag) | `Conflict` |
| `templates` | `resume` | `POST {ws}/templates/{templateId}/resume` | `Templates.resume` | | `TemplateView` (ETag) | `Conflict` |
| `templates` | `runs` | `GET {ws}/templates/{templateId}/runs?cursor&limit` | `Templates.runs` | | `Page<RecurringRunView>` | `Invalid` |
| `templates` | `use` | `POST {ws}/templates/{templateId}/documents` | `Templates.use` | Idem | 201 `DocumentView` | core errors |
| `reports` | `run` | `GET {ws}/reports/{report}?from&to&groupBy` | `Reports.run` | | `ReportView` | `Invalid` |
| `reports` | `export` | `GET {ws}/reports/{report}/export?format&from&to&groupBy` | `Reports.export` | | CSV or PDF bytes | `Invalid` |
| `reports` | `dashboard` | `GET {ws}/reports/dashboard?from&to` | G6 | | `DashboardView` | `Invalid` |
| `reports` | `fxRate` | `GET {ws}/fx-rates/{currency}?on` | G8 | | `FxRateView` | `Invalid{fx.rate_missing}`, `Unavailable` |
| `reports` | `startExport` | `POST {ws}/exports` | G9 | Idem | 202 `ExportJobView` | |
| `reports` | `getExport` | `GET {ws}/exports/{exportId}` | G9 | | `ExportJobView` | |
| `reports` | `exportFile` | `GET {ws}/exports/{exportId}/file` | G9 | | ZIP bytes | `Conflict{illegal_transition}` while running |

The Documents group in full, as the pattern every domain group follows:

```ts
// packages/api-contract/src/groups/documents.ts
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import {
  Conflict, DocumentId, DocumentInput, DocumentPatch, DocumentQuery, DocumentSummary, DocumentView,
  DeliveryId, Forbidden, Invalid, IsoDate, LineId, Locale, NotFound, Page, Unavailable, AuditEntry,
} from "@kvitbit/core/contract"

const DocParams = { documentId: DocumentId }
const CoreErrors = [NotFound.schema, Forbidden.schema, Invalid.schema, Conflict.schema, Unavailable.schema] as const

export const SendInput = Schema.Struct({
  to: Schema.optional(Schema.Array(Schema.String)),
  language: Schema.optional(Locale),
  reminders: Schema.optional(Schema.Boolean),
  purpose: Schema.optional(Schema.Literals(["document", "reminder"])), // G11; default "document"
})
export const PdfQuery = {
  template: Schema.optional(PdfTemplate), // core: "classic" | "modern_minimal"
  language: Schema.optional(Locale),
  disposition: Schema.optional(Schema.Literals(["attachment", "inline"])),
}
export const CancelResult = Schema.Struct({ document: DocumentView, creditNote: Schema.NullOr(DocumentView) })
export const PdfBytes = Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({ contentType: "application/pdf" }))

export class DocumentsGroup extends HttpApiGroup.make("documents")
  .add(HttpApiEndpoint.get("list", "/", {
    query: { ...DocumentQuery.fields, ...PageQueryFields },
    success: Page(DocumentSummary), error: Invalid.schema,
  }))
  .add(HttpApiEndpoint.post("preview", "/preview", {
    payload: DocumentInput, success: DocumentView, error: [Invalid.schema, Unavailable.schema],
  }))
  .add(HttpApiEndpoint.post("createDraft", "/", {
    headers: IdempotencyHeaders, payload: DocumentInput,
    success: Created(DocumentView), error: [Invalid.schema, NotFound.schema, Unavailable.schema],
  }).annotate(Revisioned, true))
  .add(HttpApiEndpoint.post("issueFromInput", "/issue", {
    headers: IdempotencyHeaders,
    payload: Schema.Struct({ input: DocumentInput, send: Schema.optional(SendInput) }),
    success: Created(DocumentView), error: CoreErrors,
  }).annotate(Revisioned, true))
  .add(HttpApiEndpoint.get("get", "/:documentId", { params: DocParams, success: DocumentView }).annotate(Revisioned, true))
  .add(HttpApiEndpoint.patch("edit", "/:documentId", {
    params: DocParams, headers: IfMatchHeaders, payload: DocumentPatch,
    success: DocumentView, error: [...CoreErrors, ...RevisionedEdgeErrors],
  }).annotate(Revisioned, true))
  .add(HttpApiEndpoint.delete("discardDraft", "/:documentId", {
    params: DocParams, headers: IfMatchHeaders, success: NoContent, error: [Conflict.schema, ...RevisionedEdgeErrors],
  }))
  .add(HttpApiEndpoint.post("issueDraft", "/:documentId/issue", {
    params: DocParams, headers: WriteHeaders,
    payload: Schema.Struct({ send: Schema.optional(SendInput) }),
    success: DocumentView, error: [...CoreErrors, ...RevisionedEdgeErrors],
  }).annotate(Revisioned, true))
  .add(HttpApiEndpoint.post("lock", "/:documentId/lock", { params: DocParams, success: DocumentView, error: Conflict.schema }).annotate(Revisioned, true))
  .add(HttpApiEndpoint.post("unlock", "/:documentId/unlock", {
    params: DocParams, payload: Schema.Struct({ reason: Schema.NonEmptyString }),
    success: DocumentView, error: [Conflict.schema, Invalid.schema],
  }).annotate(Revisioned, true))
  .add(HttpApiEndpoint.post("cancel", "/:documentId/cancel", {
    params: DocParams, headers: IdempotencyHeaders,
    payload: Schema.Struct({ reason: Schema.NonEmptyString, on: Schema.optional(IsoDate) }),
    success: CancelResult, error: CoreErrors,
  }))
  .add(HttpApiEndpoint.post("correct", "/:documentId/credit-notes", {
    params: DocParams, headers: IdempotencyHeaders,
    payload: Schema.Struct({
      reason: Schema.NonEmptyString,
      lines: Schema.Union([Schema.Literal("full"), Schema.Array(Schema.Struct({
        line: LineId, quantity: Schema.optional(Schema.BigDecimal), unitPrice: Schema.optional(Schema.BigDecimal),
      }))]),
      correctedOn: Schema.optional(IsoDate),
    }),
    success: Created(DocumentView), error: CoreErrors,
  }).annotate(Revisioned, true))
  .add(HttpApiEndpoint.post("issueFinalInvoice", "/:documentId/final-invoice", {
    params: DocParams, headers: IdempotencyHeaders,
    payload: Schema.Struct({ patch: Schema.optional(DocumentPatch) }),
    success: Created(DocumentView), error: CoreErrors,
  }).annotate(Revisioned, true))
  .add(HttpApiEndpoint.post("send", "/:documentId/deliveries", {
    params: DocParams, headers: IdempotencyHeaders, payload: SendInput,
    success: Accepted(Schema.Struct({ deliveryId: DeliveryId, status: Schema.Literal("queued") })),
    error: [NotFound.schema, Conflict.schema, Invalid.schema],
  }))
  .add(HttpApiEndpoint.get("pdf", "/:documentId/pdf", { params: DocParams, query: PdfQuery, success: PdfBytes, error: Unavailable.schema }))
  .add(HttpApiEndpoint.get("history", "/:documentId/history", { params: DocParams, success: Schema.Array(AuditEntry) }))
  .prefix("/workspaces/:workspaceId/documents")
  .middleware(Authentication).middleware(WorkspaceMember)
  .annotate(OpenApi.Description, "Invoices, Proformas, Payment Tax Documents and Credit Notes") {}
```

Handler sketch for the two `issue` shapes, showing the header mapping:

```ts
// apps/server/src/http/documents.ts
export const DocumentsLive = HttpApiBuilder.group(Api, "documents", (handlers) => handlers
  .handle("issueDraft", ({ params, headers, payload }) =>
    withRevision(headers["if-match"], (expectedRevision) =>
      Documents.use((d) => d.issue(
        { draft: params.documentId, expectedRevision },
        { requestKey: headers["idempotency-key"], send: payload.send },
      ))))
  .handle("issueFromInput", ({ headers, payload }) =>
    Documents.use((d) => d.issue({ input: payload.input }, { requestKey: headers["idempotency-key"], send: payload.send })))
  // ... one line per endpoint, each calling one core method
)
```

The remaining domain groups follow the same pattern; their non-core schemas:

```ts
// packages/api-contract/src/groups/contacts.ts (excerpt)
export class ContactsGroup extends HttpApiGroup.make("contacts")
  .add(HttpApiEndpoint.get("search", "/", {
    query: { text: Schema.optional(Schema.String), role: Schema.optional(Schema.Literals(["customer", "supplier"])), ...PageQueryFields },
    success: Page(ContactView), error: Invalid.schema,
  }))
  .add(HttpApiEndpoint.get("get", "/:contactId", { params: { contactId: ContactId }, success: ContactView }).annotate(Revisioned, true))
  .add(HttpApiEndpoint.post("create", "/", { headers: IdempotencyHeaders, payload: ContactInput, success: Created(ContactView), error: [Invalid.schema, Conflict.schema] }).annotate(Revisioned, true))
  .add(HttpApiEndpoint.put("update", "/:contactId", {
    params: { contactId: ContactId }, headers: IfMatchHeaders, payload: ContactInput,
    success: ContactView, error: [Invalid.schema, Conflict.schema, ...RevisionedEdgeErrors],
  }).annotate(Revisioned, true))
  .add(HttpApiEndpoint.post("fromIco", "/from-ico", {
    payload: Schema.Struct({ ico: Schema.String, role: Schema.optional(Schema.Literals(["customer", "supplier"])) }),
    success: ContactView, error: [Invalid.schema, Unavailable.schema, RateLimited.schema],
  }).annotate(Revisioned, true))
  .add(HttpApiEndpoint.post("archive", "/:contactId/archive", { params: { contactId: ContactId }, success: NoContent }))
  .prefix("/workspaces/:workspaceId/contacts")
  .middleware(Authentication).middleware(WorkspaceMember) {}

// packages/api-contract/src/groups/payments.ts (excerpt)
export const RecordPaymentInput = Schema.Struct({
  target: Schema.Union([Schema.Struct({ document: DocumentId }), Schema.Struct({ expense: ExpenseId })]),
  amount: Schema.optional(Money),           // default: outstanding
  paidOn: Schema.optional(IsoDate),         // default: today (Prague)
  method: Schema.optional(Schema.Literals(["bank_transfer", "cash", "card", "other"])),
  note: Schema.optional(Schema.String),
})
export const RecordPaymentResult = Schema.Struct({
  payment: PaymentView,
  settlement: Schema.Literals(["partially_paid", "paid", "overpaid"]),
  issued: Schema.Array(DocumentView),       // the auto-issued Payment Tax Document, if any (rule P2)
})

// packages/api-contract/src/groups/expenses.ts (excerpt)
export const UploadedFile = HttpApiSchema.MultipartStream // one streamed part: name, contentType, bytes
export const AttachPayload = HttpApiSchema.asMultipartStream(Schema.Struct({ file: UploadedFile }), {
  maxParts: 1, maxFileSize: 20 * 1024 * 1024,
})

// packages/api-contract/src/groups/templates.ts (excerpt)
export const ScheduleInput = Schema.Struct({
  every: Schema.Union([
    Schema.Struct({ weeks: Schema.Int }), Schema.Struct({ months: Schema.Int }), Schema.Struct({ years: Schema.Int }),
  ]),
  startOn: IsoDate, endOn: Schema.optional(IsoDate),
  issueAs: Schema.Literals(["invoice", "proforma"]), autoSend: Schema.Boolean,
})
export const UseTemplateInput = Schema.Struct({
  as: Schema.optional(Schema.Literals(["draft", "issued"])), patch: Schema.optional(DocumentPatch),
})

// packages/api-contract/src/groups/reports.ts (excerpt)
// ReportKind, DashboardView, FxRateView and ExportJobView come from @kvitbit/core/contract (core-ports 4.9).
export const ReportKind = Schema.Literals(["revenue", "vat_summary", "receivables", "expenses", "profit", "cashflow"])
export const ReportRange = {
  from: IsoDate, to: IsoDate,
  groupBy: Schema.optional(Schema.Literals(["month", "contact", "currency", "category"])),
}
export const ExportFormat = Schema.Literals(["csv", "pdf"])
export const FxRateView = Schema.Struct({
  currency: CurrencyCode, rate: Schema.BigDecimal, quantity: Schema.Int, fixingDate: IsoDate, source: Schema.Literal("cnb"),
})
export const ExportJobView = Schema.Struct({
  id: ExportId, status: Schema.Literals(["running", "ready", "failed"]),
  createdAt: Schema.String, readyAt: Schema.NullOr(Schema.String), expiresAt: Schema.NullOr(Schema.String), // ready for 7 days
  sizeBytes: Schema.NullOr(Schema.Int),
})
```

Domain group notes:

- Flow 3.7 "Duplicate" has no core method; the client reads the document and calls `createDraft` with its input. Flow 7.2 "correct a Payment" is `remove` then `record`. Flow 8.5 "Regenerate" is `DELETE` then `PUT` on the share link.
- `contacts.fromIco` both looks up and saves (upsert by IČO), which also serves "Refresh from ARES" (flow 6.3). The editor's prefill-without-saving uses `registry.lookupCompany`.
- `documents.edit` on a document with recorded payments whose new total falls below them succeeds with a warning (decision Q3); the warning travels in the view as core decides (C4), not as an HTTP header.
- `payments.record` is used for Proforma settlement (flow 3.8): when it auto-issues a Payment Tax Document, `issued` carries it and the response is still 201.
- `reports.dashboard` is a separate path so the closed `ReportKind` union stays closed; it calls `Reports.dashboard` (G6, resolved).
- Per-Contact billing overrides (core-ports section 4.2, screen 19) travel as `ContactInput.defaults` on `contacts.create` / `contacts.update` and come back on `ContactView.defaults`. The edge re-exports core's schema unchanged; it is shown here for reference. Every field is optional; an absent field falls back along `Document → Contact → Workspace`. `documents.createDraft`, `documents.issueFromInput` and the MCP `create_draft` / `issue_document` tools apply the fallback in core when the matching `DocumentInput` field (`currency`, `language`, `due`, `series`, `note`) is omitted.

```ts
// re-exported from @kvitbit/core/contract (core-ports section 4.2); field names and types are core's
const ReminderPolicy = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("inherit") }),                 // follow the Workspace reminder schedule
  Schema.Struct({ mode: Schema.Literal("disabled") }),                // no automatic reminders for this Contact
  Schema.Struct({ mode: Schema.Literal("custom"), offsetsDays: Schema.Array(Schema.Number) }),
])
const ContactDefaults = Schema.Struct({
  currency: Schema.optional(CurrencyCode),
  language: Schema.optional(Locale),
  dueDays: Schema.optional(Schema.Int),
  paymentMethod: Schema.optional(PaymentMethod),
  preferredSeriesByKind: Schema.optional(Schema.Record(DocumentKind, NumberingSeriesId)), // partial map
  defaultNote: Schema.optional(Schema.String),
  reminderPolicy: Schema.optional(ReminderPolicy),                    // absent behaves as { mode: "inherit" }
})
```

### 3.6 Core coverage

Every caller-facing core method has exactly one REST route, except `Workspaces.enter`, which is the `WorkspaceMember` middleware, and three kinds of method that apps/server calls without a route of their own: `Workspaces.recordAccessEvent` (called by the API Key and grant handlers), the dry runs `Documents.previewSend`, `previewFinalInvoice` and `previewCorrection` (MCP two-step previews), and `Workspaces.peekInvitation` and `lookupCompany`, whose routes are `invitations.peek` and `registry.lookupCompany`. The table lists the methods core had before section 9 was resolved; the methods core-ports section 14 added are the G-marked endpoints in 3.5.

| Module | Methods | Routes |
|---|---|---|
| `Workspaces` (15) | `create`, `listMine`, `enter`, `acceptInvitation`, `current`, `updateIssuingEntity`, `updateSettings`, `saveBankAccount`, `configureSeries`, `listSeries`, `invite`, `revokeInvitation`, `setRole`, `transferOwnership`, `close` | `myWorkspaces.create`, `myWorkspaces.listMine`, middleware, `invitations.accept`, `workspace.current` (+ `listBankAccounts`, `branding.getBranding`), `workspace.updateIssuingEntity`, `workspace.updateSettings` (+ `branding.updateBranding`), `workspace.createBankAccount` / `updateBankAccount`, `workspace.createSeries` / `updateSeries`, `workspace.listSeries`, `team.invite`, `team.revokeInvitation`, `team.setRole` / `removeMember`, `team.transferOwnership`, `workspace.close` |
| `Contacts` (5) | `fromIco`, `save`, `archive`, `get`, `search` | `contacts.fromIco`, `contacts.create` / `update`, `contacts.archive`, `contacts.get`, `contacts.search` |
| `PriceList` (3) | `save`, `archive`, `list` | `priceList.create` / `update`, `priceList.archive`, `priceList.list` |
| `Documents` (15) | `preview`, `createDraft`, `discardDraft`, `issue`, `edit`, `lock`, `unlock`, `cancel`, `correct`, `issueFinalInvoice`, `send`, `pdf`, `get`, `list`, `history` | `documents.*` (16 endpoints: `issue` has two) |
| `Payments` (3) | `record`, `remove`, `listFor` | `payments.record`, `payments.remove`, `payments.listForDocument` / `listForExpense` |
| `PublicShareLinks` (4) | `create`, `revoke`, `open`, `pdf` | `shareLinks.create`, `shareLinks.revoke`, `publicShare.open`, `publicShare.pdf` |
| `Expenses` (8) | `record`, `edit`, `remove`, `attach`, `detach`, `attachment`, `get`, `list` | `expenses.*` (8 endpoints) |
| `Templates` (7) | `save`, `archive`, `schedule`, `resume`, `use`, `get`, `list` | `templates.create` / `update`, `templates.archive`, `templates.setSchedule` / `removeSchedule`, `templates.resume`, `templates.use`, `templates.get`, `templates.list` |
| `Reports` (2) | `run`, `export` | `reports.run`, `reports.export` |

### 3.7 OpenAPI

- `GET /api/v1/openapi.json` serves `OpenApi.fromApi(Api)`. `GET /api/v1/docs` serves Scalar (`HttpApiScalar.layer`). Both are public in hosted and self-hosted installs.
- Security schemes: `session` (cookie `__Secure-kvitbit.session_token`) and `bearer` (session token or API Key). Each group's middleware annotation lists the schemes it accepts.
- Each endpoint carries an `operationId` of `<group>.<endpoint>` (for example `documents.issueDraft`), a summary in English, and its error responses from the error schemas, so generated clients get typed errors.
- `IssueCode` and `Action` are emitted as enums, so integrators can switch on them.
- MCP tools are not in the OpenAPI document. Section 6.5 is their contract.

---

## 4. Worked exchanges

Edit an issued document that someone else changed meanwhile:

```http
GET /api/v1/workspaces/0192.../documents/0193...            → 200, ETag: "7"
PATCH /api/v1/workspaces/0192.../documents/0193...
If-Match: "7"
{ "note": "Splatnost dle dohody" }                            → 412 { "_tag": "PreconditionFailed", "currentRevision": 8 }, ETag: "8"
GET  .../documents/0193...                                     → 200, ETag: "8"  (client shows the diff, user re-applies)
PATCH ... If-Match: "8"                                        → 200, ETag: "9"
```

Issue a draft over a flaky connection:

```http
POST .../documents/0193.../issue
If-Match: "3"
Idempotency-Key: 0193b2c4-7a1e-7c00-9f00-2b9d5e1f0a11
{ "send": { "reminders": true } }                              → connection drops after commit
POST .../documents/0193.../issue   (same headers and body)      → 200, Idempotent-Replayed: true, same number
```

Mobile offline expense capture (flow 5.2, decision Q9). The device queues the intent with one key per step:

```http
POST .../expenses           Idempotency-Key: K1   { ...ExpenseInput }   → 201 ExpenseView { id: E, revision: 1 }
POST .../expenses/E/attachments   multipart file=receipt.heic           → 201 AttachmentView (repeat is a no-op by content hash)
```

If the app dies between the two calls, the queue replays `POST .../expenses` with K1 (returns E again) and then the upload.

---

## 5. Expo updates and Android releases

These are raw `HttpRouter` routes, not `HttpApi` endpoints, because the Expo Updates protocol answers `multipart/mixed` with code signing. The asset store is a port in apps/server, `UpdateAssetStorage`, with GCS (hosted) and local disk (self-hosted) adapters; it never overwrites an object (Deskohub pattern, Vercel Blob replaced).

| Route | Request | Response |
|---|---|---|
| `GET /api/mobile/updates/manifest` | Headers `expo-protocol-version: 1`, `expo-platform: android | ios`, `expo-runtime-version`, `expo-channel-name` (default `production`), `expo-current-update-id`, `expo-expect-signature` | `multipart/mixed` with a `manifest` part (id, createdAt, runtimeVersion, launchAsset, assets, metadata, extra) or a `directive` part (`noUpdateAvailable`, `rollBackToEmbedded`). Each part signed: `expo-signature: sig="...", keyid="main", alg="rsa-v1_5-sha256"`. Response headers `expo-protocol-version: 1`, `expo-sfv-version: 0`, `cache-control: private, max-age=0`. Unknown runtime version: `noUpdateAvailable`. |
| `GET /api/mobile/updates/assets/{sha256}` | | Asset bytes with the content type from the manifest, `Cache-Control: public, max-age=31536000, immutable`. 404 for unknown hashes. |
| `GET /api/mobile/releases/latest` | | `ReleaseInfo` JSON, `Cache-Control: public, max-age=300`. |
| `GET /api/mobile/releases/{version}/apk` | | The signed APK, `application/vnd.android.package-archive`. |

```ts
// packages/api-contract/src/edge.ts
export const ReleaseInfo = Schema.Struct({
  version: Schema.String,            // "1.4.0"
  versionCode: Schema.Int,           // derived from version (Deskohub invariant)
  releasedAt: Schema.String,
  apkUrl: Schema.String,             // /api/mobile/releases/1.4.0/apk
  apkSha256: Schema.String,
  sizeBytes: Schema.Int,
  signingCertSha256: Schema.String,  // shown on /android (flow 1.7)
  minAndroidSdk: Schema.Int,
  obtainiumUrl: Schema.String,       // Obtainium import link with the APK regex prefilled
})
```

Publishing updates and releases is a CI job with operator credentials writing to `UpdateAssetStorage` and the release table. There is no public publish endpoint in v1. Native passkeys and the Better Auth Expo deep link need the same host, so `app.config.ts` derives the manifest URL from the API origin.

---

## 6. Remote MCP adapter

### 6.1 Transport

- One endpoint, `POST /mcp`, MCP Streamable HTTP. Designed against protocol revision `2025-11-25`; the server also accepts `2025-06-18`, and assumes `2025-03-26` when `MCP-Protocol-Version` is absent, as the transport spec says. Unsupported versions answer 400.
- Stateless: no `Mcp-Session-Id`. Every request builds a fresh MCP server (`@modelcontextprotocol/server`, Deskohub's handler pattern) bound to that request's caller, runs it inside a request-scoped Effect, and closes the scope when the response completes. `initialize` is answered on any request, so clients that reconnect lose nothing.
- JSON response mode only (`enableJsonResponse: true`). `GET /mcp` and `DELETE /mcp` answer 405, because the server never pushes messages and holds no session. JSON-RPC batches are rejected.
- Capabilities: `tools: { listChanged: false }`, `resources: { subscribe: false, listChanged: false }`. No prompts, no sampling, no elicitation in v1.
- `serverInfo: { name: "kvitbit", version }` and an `instructions` string that explains the Workspace binding, the two-step rule (section 6.6) and where to read VAT treatments (`kvitbit://guide`).
- `Origin` is validated when present (rule in section 1). Body limit 1 MB.

### 6.2 OAuth 2.1 authorization

`/mcp` is an OAuth 2.1 resource server. Better Auth's OAuth 2.1 provider is the authorization server, with opaque tokens (Deskohub `disableJwtPlugin` pattern) and Kvitbit's consent page.

1. A request without a valid token gets `401` with
   `WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource/mcp", scope="kvitbit:read"`.
2. The client fetches the protected resource metadata (RFC 9728):

   ```json
   {
     "resource": "https://<host>/mcp",
     "authorization_servers": ["https://<host>/api/auth"],
     "scopes_supported": [
       "kvitbit:read", "kvitbit:write", "kvitbit:workspace:read", "kvitbit:workspace:write",
       "kvitbit:members:read", "kvitbit:members:write", "kvitbit:contacts:read", "kvitbit:contacts:write",
       "kvitbit:catalog:read", "kvitbit:catalog:write", "kvitbit:documents:read", "kvitbit:documents:write",
       "kvitbit:payments:read", "kvitbit:payments:write", "kvitbit:expenses:read", "kvitbit:expenses:write",
       "kvitbit:templates:read", "kvitbit:templates:write", "kvitbit:reports:read", "kvitbit:reports:write",
       "kvitbit:share:read", "kvitbit:share:write", "offline_access"
     ],
     "bearer_methods_supported": ["header"],
     "resource_name": "kvitbit",
     "resource_documentation": "https://<host>/docs/mcp"
   }
   ```

3. It reads the authorization server metadata (RFC 8414): issuer `https://<host>/api/auth`, `authorization_endpoint` `/api/auth/oauth2/authorize`, `token_endpoint` `/api/auth/oauth2/token`, `registration_endpoint` `/api/auth/oauth2/register`, `revocation_endpoint` `/api/auth/oauth2/revoke`, `code_challenge_methods_supported: ["S256"]`, `grant_types_supported: ["authorization_code", "refresh_token"]`, `token_endpoint_auth_methods_supported: ["none", "client_secret_basic"]`, `client_id_metadata_document_supported: true`.
4. Client registration: a Client ID Metadata Document (the `client_id` is an HTTPS URL) is preferred; dynamic client registration (RFC 7591) is the fallback. Redirect URIs match exactly, except loopback redirects for native clients, which may use any port.
5. Authorization request: PKCE `S256` required, `state` required, and `resource=https://<host>/mcp` required (RFC 8707). The browser signs in if needed (flows 1.3 to 1.5), then lands on P16 (`/oauth/consent?consent_id=...`), which uses the `oauthConsent` group (section 3.5.2).
6. Tokens: access tokens are opaque, valid 1 hour, bound to the audience `https://<host>/mcp`. Refresh tokens (only with `offline_access`) are valid 30 days, rotate on every use, and allow a 10 second reuse window for parallel refreshes. The token response `scope` reflects what the user granted, which may be narrower than what the client asked for.
7. Revocation: revoking the grant (flow 10.9), removing the Member (flow 2.6), the Member leaving (2.7), closing the Workspace (2.9) or deleting the account (1.9) revokes every token under the grant. A role change revokes nothing, because the role is re-read on every request.

### 6.3 Scopes and grants

| OAuth scope | Consent wording | Core scopes on the grant |
|---|---|---|
| `kvitbit:read` | "Read only" | all ten `<area>:read` |
| `kvitbit:write` | "Read and write" (includes read) | all `<area>:read` and `<area>:write` |
| `kvitbit:<area>:read`, `kvitbit:<area>:write` | "Custom", one checkbox per area and level | exactly `<area>:read` / `<area>:write` (write adds read); `<area>` is any of the ten `ScopeArea`s |
| `offline_access` | "Stay connected" | none (refresh token only) |

A client may request the presets or per-area scopes. On P16 the user can keep the request or narrow it to a custom per-area selection within `grantableScopes`; the token response `scope` then lists `kvitbit:read` or `kvitbit:write` for a preset grant and the per-area `kvitbit:<area>:<level>` strings for a custom one. `scopes_supported` lists the two presets, all twenty per-area scopes and `offline_access`.

A grant is `(grantId, clientId, clientName, userId, workspaceId, access, scopes, createdAt, lastUsedAt)`, with `access: AccessMode` and `scopes` the expanded `Scope[]` (section 2.2). One grant covers one client, one Member and one Workspace (flow 10.8). Consent caps `access` by role: an `accountant` sees only "Read only". A client that wants another Workspace runs the authorization flow again and gets a second grant.

### 6.4 Caller per request

```ts
// apps/server/src/mcp/caller.ts (sketch)
export const mcpCaller = (request: HttpServerRequest) => Effect.gen(function* () {
  const token = yield* bearerToken(request)                      // 401 with WWW-Authenticate when missing
  const grant = yield* McpGrants.use((g) => g.verifyAccessToken(token, { audience: mcpResourceUrl }))
  const account = Caller.account({ userId: grant.userId, email: grant.email, locale: grant.locale, channel: "mcp" })
  return yield* Workspaces.use((w) => w.enter(grant.workspaceId, {
    scopes: grant.scopes, channel: "mcp", client: { kind: "mcp", id: grant.grantId, name: grant.clientName },
  })).pipe(
    Effect.provideService(CurrentCaller, account),
    Effect.catchTag("NotFound", () => Effect.fail(new Unauthorized({ reason: "invalid" }))), // membership gone: token is dead
  )
})
```

- The `MemberCaller` is built once per HTTP request and provided to every tool call in it. Its `scopes` come from the verified grant, never from tool arguments.
- No tool takes a `workspaceId`. The Workspace is the grant's.
- Locale for tool text: the account preference, else the grant's consent-time locale, else `cs`. Tool text can be either language; structured content is language-neutral.

Retry keys (core-ports section 1 and 9.1 agree). MCP has no stable tool call id on the wire: JSON-RPC ids are per connection and restart at small integers, so deriving a key from them would replay one call's stored result for an unrelated later call. The adapter therefore uses:

| Tool kind | `requestKey` |
|---|---|
| Two-step tools (confirm call) | `mcp-confirm:<confirmationId>` (section 6.6) |
| Single-call creates and actions | `mcp:<grantId>:<idempotencyKey>` when the agent passes the optional `idempotencyKey` argument (8 to 128 chars), else none |
| Reads | none |

### 6.5 Tool catalog

28 tools. Mode "1" is single-call, "2" is preview then confirm. Annotations: RO `readOnlyHint`, D `destructiveHint`, I `idempotentHint`, O `openWorldHint`. Every tool declares an `inputSchema` and an `outputSchema` generated from the Effect schemas (`JSONSchema.make`), and returns `structuredContent` plus a short text summary.

| Tool | Flow | Core call | Action (scope) | Mode | Annotations |
|---|---|---|---|---|---|
| `get_workspace` | 2.3, 10.1 | `Workspaces.current`, `listSeries` | `workspace.read` (`workspace:read`) | 1 | RO |
| `list_documents` | 3.6 | `Documents.list` | `document.read` (`documents:read`) | 1 | RO |
| `get_document` | 3.6 | `Documents.get` | `document.read` (`documents:read`) | 1 | RO |
| `get_document_history` | 3.6, 8.6 | `Documents.history` | `document.history` (`documents:read`) | 1 | RO |
| `get_document_pdf` | 3.10 | `Documents.pdf` | `document.pdf` (`documents:read`) | 1 | RO |
| `list_payments` | 7.1 | `Payments.listFor` | `payment.read` (`payments:read`) | 1 | RO |
| `list_invoice_templates` | 4.2 | `Templates.list` | `template.read` (`templates:read`) | 1 | RO |
| `list_expenses` | 5.5 | `Expenses.list` | `expense.read` (`expenses:read`) | 1 | RO |
| `get_expense` | 5.5 | `Expenses.get` | `expense.read` (`expenses:read`) | 1 | RO |
| `list_contacts` | 6.3 | `Contacts.search` | `contact.read` (`contacts:read`) | 1 | RO |
| `lookup_ares` | 6.1 | G2 (`Workspaces.lookupCompany`) | `contact.read` (`contacts:read`) | 1 | RO, O |
| `list_price_list_items` | 6.4 | `PriceList.list` | `priceList.read` (`catalog:read`) | 1 | RO |
| `get_share_link` | 8.1 | `Documents.get` (`share` field) | `share.read` (`share:read`) | 1 | RO |
| `get_report` | 9.2 to 9.6 | `Reports.run` | `report.run` (`reports:read`) | 1 | RO |
| `get_fx_rate` | 3.11 | G8 | `report.run` (`reports:read`) | 1 | RO, O |
| `create_draft` | 3.1 | `Documents.createDraft` | `document.draft` (`documents:write`) | 1 | |
| `update_draft` | 3.1 | `Documents.edit` (drafts only) | `document.edit` (`documents:write`) | 1 | I |
| `upsert_contact` | 6.1, 6.2 | `Contacts.save` (args are `ContactInput`, including the optional per-Contact `defaults` from section 3.5.4), or `Contacts.fromIco` when only `ico` is given | `contact.write` (`contacts:write`) | 1 | I, O |
| `record_expense` | 5.1 | `Expenses.record` | `expense.write` (`expenses:write`) | 1 | |
| `record_payment` | 7.1, 5.4 | `Payments.record` | `payment.write` (`payments:write`) | 1 | |
| `settle_proforma` | 3.8 | `Payments.record` on a Proforma | `payment.write` (`payments:write`) | 1 | |
| `lock_document` | 3.5 | `Documents.lock` | `document.lock` (`documents:write`) | 1 | I |
| `create_from_template` | 4.2 | `Templates.use` | `document.draft`; also `document.issue` when `as: "issued"` (`documents:write`) | 1 for drafts, 2 when `as: "issued"` | |
| `issue_document` | 3.2 | `Documents.issue` (draft or input, optional send) | `document.issue`, plus `document.send` with `send` (`documents:write`) | 2 | D |
| `send_document` | 3.3 | `Documents.send` | `document.send` (`documents:write`) | 2 | O |
| `send_reminder` | 7.4 | `Documents.send` with `purpose: "reminder"` (G11) | `document.send` (`documents:write`) | 2 | O |
| `create_final_invoice` | 3.8 | `Documents.issueFinalInvoice` | `document.finalInvoice` (`documents:write`) | 2 | D |
| `create_credit_note` | 3.9 | `Documents.correct` | `document.correct` (`documents:write`) | 2 | D |

Not exposed in v1 (flow 10.10): unlock, discard draft, cancel, edits to issued documents (`update_draft` refuses them with `Conflict{illegal_transition}`), settings, team, API Keys, Recurring Schedule changes, share link create or revoke, Expense file upload.

Scope of the two-step rule. Decision Q8 names `issue` and `send`. The adapter applies it to every tool that assigns a document number or emails someone, because those are the irreversible acts (gapless numbering, no un-send): `issue_document`, `send_document`, `send_reminder`, `create_final_invoice`, `create_credit_note`, and `create_from_template` with `as: "issued"`. Payment tools stay single-call as Q8 says, even when `record_payment` or `settle_proforma` auto-issues a Payment Tax Document (rule P2), because that document is the statutory consequence of the payment, not a separate decision. Section 8 lists this reading for confirmation.

Input sketches (Effect schemas the JSON Schemas are generated from):

```ts
// apps/server/src/mcp/tools.ts (excerpt)
const Revision = Schema.Int.annotate({ description: "The document revision you last read. A stale value fails with Conflict revision_changed." })
const IdempotencyArg = Schema.optional(Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{8,128}$/)))
const ConfirmArgs = {
  confirm: Schema.optional(Schema.Literal(true)),
  confirmationToken: Schema.optional(Schema.String),
}

export const ListDocumentsArgs = Schema.Struct({ ...DocumentQuery.fields, cursor: Schema.optional(Schema.String), limit: Schema.optional(Schema.Int) })
export const CreateDraftArgs = Schema.Struct({ ...DocumentInput.fields, idempotencyKey: IdempotencyArg })
export const UpdateDraftArgs = Schema.Struct({ documentId: DocumentId, revision: Revision, patch: DocumentPatch })
export const IssueDocumentArgs = Schema.Struct({
  from: Schema.Union([
    Schema.Struct({ draft: DocumentId, revision: Revision }),
    Schema.Struct({ input: DocumentInput }),
  ]),
  send: Schema.optional(SendInput),
  ...ConfirmArgs,
})
export const SendDocumentArgs = Schema.Struct({ documentId: DocumentId, ...SendInput.omit("purpose").fields, ...ConfirmArgs })
export const SendReminderArgs = Schema.Struct({ documentId: DocumentId, to: Schema.optional(Schema.Array(Schema.String)), ...ConfirmArgs })
export const CreateCreditNoteArgs = Schema.Struct({ documentId: DocumentId, reason: Schema.NonEmptyString, lines: CorrectionLines, correctedOn: Schema.optional(IsoDate), ...ConfirmArgs })
export const CreateFinalInvoiceArgs = Schema.Struct({ proformaId: DocumentId, patch: Schema.optional(DocumentPatch), ...ConfirmArgs })
export const CreateFromTemplateArgs = Schema.Struct({ templateId: TemplateId, as: Schema.optional(Schema.Literals(["draft", "issued"])), patch: Schema.optional(DocumentPatch), idempotencyKey: IdempotencyArg, ...ConfirmArgs })
export const RecordPaymentArgs = Schema.Struct({ ...RecordPaymentInput.fields, idempotencyKey: IdempotencyArg })
export const SettleProformaArgs = Schema.Struct({ proformaId: DocumentId, amount: Schema.optional(Money), paidOn: Schema.optional(IsoDate), method: Schema.optional(PaymentMethod), idempotencyKey: IdempotencyArg })
export const GetReportArgs = Schema.Struct({ report: ReportKind, from: IsoDate, to: IsoDate, groupBy: Schema.optional(ReportGroupBy) })
export const GetDocumentPdfArgs = Schema.Struct({ documentId: DocumentId, template: Schema.optional(PdfTemplate), language: Schema.optional(Locale) })
```

`get_document_pdf` returns a `resource_link` to `kvitbit://documents/{id}/pdf` plus, when the PDF is under 1 MB, the same PDF as an embedded `resource` with a base64 `blob`. `get_report` maps the flow names: `revenue`, `expenses`, `receivables` (unpaid and overdue), `vat` → `vat_summary`, `cashflow` → `cashflow` (G6).

### 6.6 Two-step preview and confirm

```
agent                                   /mcp                                      core
  │ tools/call issue_document {from, send}  │                                        │
  │────────────────────────────────────────►│ can(caller, document.issue[, send])    │
  │                                         │ Documents.get / preview (read only) ──►│
  │                                         │ insert mcp_confirmations row           │
  │◄────────────── ConfirmationRequired ────│ (no domain write)                      │
  │  show summary to the user, get a yes    │                                        │
  │ tools/call issue_document {same args,   │                                        │
  │   confirm: true, confirmationToken}     │                                        │
  │────────────────────────────────────────►│ check token: grant, tool, args hash,   │
  │                                         │ expiry, not used by another call       │
  │                                         │ Documents.issue(..., requestKey =      │
  │                                         │   "mcp-confirm:<id>") ────────────────►│ policy, replay, write
  │◄─────────────── Issued result ──────────│ mark row consumed                      │
```

First call (no `confirm`):

1. Decode args. Check `can(caller, action)` for every action the confirmed call would need, so a read-only grant fails now, not after the user said yes.
2. Build the preview with reads only. `issue_document` from a draft: `Documents.get(draft)`, then check `revision` against the draft (stale: `Conflict{revision_changed}` right away). From input: `Documents.preview(input)`. `create_from_template` issued: `Templates.get` plus `Documents.preview` of the merged input. `send_document` and `send_reminder`: `Documents.get` plus resolved recipients, language and subject (G12). `create_final_invoice` and `create_credit_note`: the dry-run previews of G12; until core ships them, the adapter shows the source document, its payments or the selected lines, and marks amounts as "estimated".
3. Insert a row in `mcp_confirmations` (apps/server table): `id` (UUIDv7), `token_hash`, `grant_id`, `user_id`, `workspace_id`, `tool`, `args_hash` (SHA-256 of canonical JSON of the args without `confirm`, `confirmationToken`, `idempotencyKey`), `subject_revision`, `created_at`, `expires_at` (10 minutes), `consumed_at`.
4. Return, with `isError: false`:

```json
{
  "_tag": "ConfirmationRequired",
  "confirmationToken": "mcpc_01JDX...",
  "expiresAt": "2026-11-22T14:10:00Z",
  "action": "issue_document",
  "summary": {
    "text": "Issue Invoice for ACME s.r.o., 12 100,00 CZK incl. 21 % VAT, due 2026-12-06, number assigned from series FV (next free number at issue). Then email it to fakturace@acme.cz in Czech.",
    "document": { "kind": "invoice", "contact": "ACME s.r.o.", "currency": "CZK", "total": "12100.00", "vat": [{ "rate": "21", "base": "10000.00", "vat": "2100.00" }], "dueOn": "2026-12-06" },
    "send": { "to": ["fakturace@acme.cz"], "language": "cs" }
  },
  "warnings": ["document.no_bank_account_for_currency"],
  "next": "Show this summary to the user. Only after they approve, call issue_document again with the same arguments plus confirm: true and this confirmationToken."
}
```

Confirm call (`confirm: true` and `confirmationToken`):

| Check | Failure |
|---|---|
| Token row exists for this grant, user, Workspace and tool | `Invalid{mcp.confirmation_invalid}` |
| `args_hash` matches the new args | `Invalid{mcp.confirmation_mismatch}` (agent changed something after the user saw it) |
| Not expired, or already consumed (then it is a replay) | `Invalid{mcp.confirmation_expired}`; the agent previews again |
| `confirm: true` without a token, or a token without `confirm: true` | `Invalid{mcp.confirmation_required}` |

Then the adapter calls core with `requestKey = "mcp-confirm:<id>"`, the same `expectedRevision` the preview saw, and the same send options. Core re-runs policy and every invariant, so a draft edited after the preview fails `Conflict{revision_changed}` and the agent must preview again. On success the row is marked consumed. Calling confirm again with the same token returns core's stored result through the request log (24 hours), so a retried confirm never issues a second number or sends a second email.

The token is a capability for one exact action, held by the agent. The safety comes from the agent showing `summary.text` to the user before confirming; the tool descriptions say so in both languages. MCP elicitation would let the server ask the user directly, but it needs a server-to-client request inside a session, which this stateless server does not hold; it is a v2 option.

### 6.7 Resources

| URI | Kind | MIME type | Core call | Action |
|---|---|---|---|---|
| `kvitbit://workspace` | static | `application/json` | `Workspaces.current` | `workspace.read` |
| `kvitbit://templates` | static | `application/json` | `Templates.list` | `template.read` |
| `kvitbit://price-list` | static | `application/json` | `PriceList.list` | `priceList.read` |
| `kvitbit://guide` | static | `text/markdown` | none (bundled text, cs and en) | none |
| `kvitbit://documents/{documentId}` | template | `application/json` | `Documents.get` | `document.read` |
| `kvitbit://documents/{documentId}/pdf{?template,language}` | template | `application/pdf` (blob) | `Documents.pdf` | `document.pdf` |
| `kvitbit://contacts/{contactId}` | template | `application/json` | `Contacts.get` | `contact.read` |
| `kvitbit://expenses/{expenseId}` | template | `application/json` | `Expenses.get` | `expense.read` |
| `kvitbit://expenses/{expenseId}/attachments/{attachmentId}` | template | stored type (blob) | `Expenses.attachment` | `expense.attachment.read` |

- `resources/list` returns the four static resources. `resources/templates/list` returns the five templates. Listing every document as a resource is not offered; agents use `list_documents`.
- `kvitbit://guide` explains Tax Regimes, `VatTreatment` values and when each applies, the document lifecycle, Document Lock, the two-step rule, and the meaning of common `IssueCode`s, so agents can fill `DocumentInput` correctly without guessing percentages.
- Blobs over 5 MB are refused with `Invalid{attachment.too_large}`; agents fetch them through the web app.

### 6.8 Errors

- Core errors inside a tool become a tool result with `isError: true`, `structuredContent: { "error": <encoded tagged error> }`, and a localized text. Agents can read and recover from these.
- `Forbidden{action}` text names the missing access, as flow 10.10 requires. When the role allows the action but the grant does not: "This connection is read only. Reconnect Kvitbit with read and write access to issue documents." When the role does not: "Your role in this Workspace (accountant) cannot issue documents."
- Bad arguments: JSON-RPC `-32602` with the schema issues. Unknown tool or resource: `-32602`. Defects: `-32603` with the `X-Request-Id`, nothing else.
- Missing, invalid or revoked tokens are HTTP 401 before any JSON-RPC handling, with the `WWW-Authenticate` header from section 6.2. Rate limits are HTTP 429.

### 6.9 Read-only enforcement

An `accountant`, or any Member on a `read` grant, can never write through MCP. Four independent layers hold that:

1. Consent caps access: accountants are offered "Read only" only, and `decide` rejects a higher `access` (section 3.5.2).
2. The grant's scopes are the ten `<area>:read` scopes, and the token carries no `kvitbit:write`.
3. `tools/list` returns only tools for which `can(caller, action)` holds for every action the tool can need, so write tools are not even offered. A call to an unlisted tool still runs step 4 and gets the Forbidden text above.
4. Core enforces role ∩ scopes inside every method (rule R1), whatever the adapter does. Demoting a Member to `accountant` takes effect on the next request without touching tokens.

Audit: MCP writes are attributed to the Member with `channel: "mcp"`. Flow 10.10 wants "X via <client name>"; that needs G7.

---

## 7. Peer agreements with ui-port-contracts (#20)

Settled on the board channel `invoicarr/adapter-contracts` (pre-rename coordination ID matching the GitHub repo `totalolage/invoicarr`, a bootstrapped infra ID, kept) and labelled `agreement=current`.

| ID | Board message | Terms |
|---|---|---|
| AG-UI-1 | #28 (accepting #27 P1 to P5, P7, P8) | `Api` from `packages/api-contract` (`@kvitbit/api-contract`), prefix `/api/v1`, core views unchanged; cursor plus `limit` 1 to 100 (default 50), filter-bound cursor, plain arrays for bounded collections, fixed sort; strong `ETag: "<revision>"`, required `If-Match`, 428 and `412 PreconditionFailed{currentRevision}`, one `StaleRevision` message on the client for 412 and `Conflict{revision_changed}`; one UUIDv7 `Idempotency-Key` per user intent, reused on retry and offline replay, `Idempotent-Replayed` header; multipart uploads with part `file`, plain authenticated downloads with `?disposition=inline`, no signed URLs, 20 MB attachments (PDF, JPEG, PNG, HEIC) and 2 MB branding images (PNG, JPEG); wire errors including 401, 413, 429; `Accept-Language` with the account preference winning. |
| AG-HTTP-THEME | #31 (accepting #30, superseding P6 and U7) | `ThemeSource` (`Preset`, `Seed`, `MaterialThemeBuilder` raw JSON up to 64 KB), `ThemePreference` with `mode`, `style` (`"elegant" | "cozy"`, default `"elegant"`), `contrast`, `dynamicColor`, nullable `source`; `ResolvedTheme` with six schemes, M3 roles and harmonized `paid`, `proforma`, `overdue`, `draft` extended colours; `GET`/`PATCH /api/v1/me/preferences`; `GET`/`PATCH /api/v1/workspaces/{ws}/branding` with theme, images under `/branding/{logo|stamp}`; stateless `POST /api/v1/themes/resolve`; precedence dynamic colour, account, Workspace, default; PDFs and the share page use Workspace branding only. |
| AG-UI-2 | #33 (accepting #32, answers to #25 U8) | Routes for ARES prefill and save, FX lookup, ALTCHA challenge and `X-Altcha` header, Better Auth paths, API Keys, connected apps, OAuth consent, invitation peek and accept, Android release info, `GET /api/v1/config`; no activity feed in v1. |
| AG-HTTP-ASKS | #36 (answering #33 asks a to c) | `POST {ws}/branding/preview-pdf` (G5); manual reminder is `POST {ws}/documents/{id}/deliveries { purpose: "reminder" }` (G11); schedule next-occurrence preview is a pure `/engines` function, no endpoint; `reports/dashboard` stays in the contract behind G6, and ui-port composes it from three reports until core adds it. |

ui-port-contracts has returned to the orchestrator, so G-items that ui-port also depends on (G3, G4, G6, G8, G11) are now the orchestrator's to route to core.

---

## 8. Decisions for the parent to confirm

These are readings of the inputs that change behaviour. Each has a default written into this spec.

1. Two-step scope (section 6.5). Q8 names issue and send. This spec also requires preview and confirm for `create_final_invoice`, `create_credit_note`, `send_reminder` and `create_from_template` issued, because each assigns a number or emails a third party. Payments stay single-call even when they auto-issue a Payment Tax Document.
2. MCP retry keys (section 6.4). MCP has no stable call id, so single-call writes use an optional `idempotencyKey` argument and confirm calls use the confirmation id. Confirmed: core-ports section 1 and 9.1 now say the same.
3. `If-Match` is mandatory on revisioned REST writes (428 when missing). Scripts must read before they write. MCP passes `revision` as an argument and gets core's 409.
4. Admin limits (user-flows section 4 vs core 2.3). Only the owner may invite, promote, demote or remove an `admin`. Confirmed: core encodes it as the owner-only action `member.manageAdmins` (core-ports rule R1c).
5. Unlocking a document stays off MCP and API Key access is not narrower than "read" or "read and write" in v1.
6. Route names diverge from the core-ports 9.1 sketch: `/api/v1` prefix, `POST .../documents/issue` instead of `documents:issue` (a colon collides with path parameter syntax), `POST .../lock` and `POST .../unlock` instead of `PUT`/`DELETE .../lock` (`unlock` needs a reason body, which `DELETE` bodies do not carry reliably), and `/api/v1/share/{token}` for the visitor API with the page at `/i/:token`. Confirmed: core-ports 9.1 now defers route names to section 3.5.

---

## 9. Core gaps this contract depends on

The edge must not hold domain rules, so each item below is a request to the core owner (issue #18 follow-up). Endpoints marked G<n> in section 3.5 ship once the item lands. Status: every item is resolved in `core-ports.md` section 14, with the method and type names used in this spec.

| ID | Needed by | Request to core |
|---|---|---|
| G1 | `Idempotent-Replayed` header | Signal that a result came from the request log, for example a request-scoped `RequestOutcome` service the edge can read. |
| G2 | `registry.lookupCompany`, MCP `lookup_ares`, onboarding step 2, contact editor prefill | A read-only registry lookup for Account and Member callers, for example `Workspaces.lookupCompany(ico)` returning `RegistryResult` (name, address, DIČ, legal form, register entry, termination date) with the existing checksum and 24 hour cache. |
| G3 | Team screen, invitation page | `Workspaces.members`, `Workspaces.invitations`, `Workspaces.leave`, `Workspaces.resendInvitation`, `Workspaces.peekInvitation(token)` for an anonymous token holder, and owner-only changes to admins (decision 4). |
| G4 | Branding (flow 10.4), share page logo | Branding fields in `WorkspaceSettingsPatch` and `WorkspaceView` (`pdfTemplate`, `accentColor`, `footerText`, `theme: ThemeSource | null`), plus `setBrandingImage`, `brandingImage`, `removeBrandingImage` on `BlobStorage`, and `PublicShareLinks.logo` for visitors. `ThemeSource` then moves to `/contract` or core stores it as validated JSON. |
| G5 | Branding live preview (screen 18) | `Workspaces.previewBranding(patch, kind, language)` rendering a fixed sample document through `PdfRenderer` without persisting. |
| G6 | Dashboard (9.1), MCP `get_report` cashflow | `dashboard` and `cashflow` members of `ReportQuery.report`, or a `Reports.dashboard` method. |
| G7 | Audit "X via <client>" (flow 10.10, 10.7) | Optional `client: { kind: "api_key" | "mcp", id, name }` on `MemberCaller` and the audit actor; `Workspaces.enter` accepts it from the edge. |
| G8 | Expense FX, MCP `get_fx_rate` | `Reports.fxRate({ currency, on })` over the existing `fx_fixings` cache. |
| G9 | Full data export (flow 9.7, 2.9) | A background export job (ZIP of PDFs, attachments, CSVs) with status and a 7-day download, for example `Reports.startExport`, `getExport`, `exportFile`. |
| G10 | Account deletion guard (flow 1.9) | `WorkspaceSummary` carries role and member count, so the edge can block deleting an owner of a shared Workspace and warn about sole-member Workspaces; soft delete per decision Q7. |
| G11 | Manual reminder (flow 7.4), MCP `send_reminder` | `SendOptions.purpose: "document" | "reminder"`; a manual reminder never re-arms the automatic schedule. |
| G12 | MCP confirmation previews | Dry-run reads: `Documents.previewSend(id, input)` (resolved recipients, language, subject, attachments), `previewFinalInvoice(proforma, input)`, `previewCorrection(id, input)`. |
| G13 | `can` for edge-owned resources, new error codes | `Action` members `apiKey.manage`, `grant.create`, `grant.read.own`, `grant.read.all`, `grant.revoke.own`, `grant.revoke.all`; an audit hook for API Key and grant changes; `IssueCode` members `page.cursor_mismatch`, `request.malformed`, `theme.json_invalid`, `theme.too_large`, `theme.seed_invalid`, `theme.low_contrast`, `mcp.confirmation_invalid`, `mcp.confirmation_mismatch`, `mcp.confirmation_expired`, `mcp.confirmation_required`. |
| G14 | Bank accounts (flow 10.3) | `Workspaces.removeBankAccount(id, replacement?)` and retry coverage (rule C6) for creating bank accounts, series, Price List Items and Templates, which today have neither `requestKey` nor a revision. |
| G15 | View tracking (flow 8.2, 8.6) | `PublicShareLinks.views(documentId, page)` listing view and download events with time and coarse device; an optional signed-in `userId` on the visitor caller so a Member of the issuing Workspace records no view. |

---

## 10. Spellings and behaviour to confirm during implementation

None of these changes the contract; each needs a check against the pinned versions.

- `effect@4.1.4`: module path `effect/unstable/httpapi` (core-ports uses the same); `HttpApiEndpoint.get(name, path, { params, query, headers, payload, success, error })` with `success` and `error` accepting arrays; `HttpApiGroup.prefix` and `.middleware`; endpoint-level `.middleware` for `invitations.accept`; `HttpApiMiddleware.Service<Self>()(id, { provides, error, requires, security })` with `provides` taking more than one service; `HttpApiSecurity.apiKey({ in: "cookie" })` and `HttpApiSecurity.bearer`; `HttpApiSchema.status(428)` with a numeric code; `HttpApiSchema.Empty(202)`; `HttpApiSchema.asMultipartStream` part limits; a streamed binary success body (`HttpApiSchema.StreamUint8Array`); `HttpApiMiddleware.layerSchemaErrorTransform` for the `request.malformed` mapping; `OpenApi.fromApi`, `HttpApiScalar.layer`; `JSONSchema.make` for MCP tool schemas.
- How prefix path parameters (`:workspaceId`, `:token`) are declared and decoded for middleware, and `Context.Reference` as an endpoint annotation key.
- Setting `ETag`, `Location` and `Idempotent-Replayed` response headers from a typed handler (a response-transforming middleware keyed on the `Revisioned` annotation, or a raw handler variant).
- Better Auth endpoint names in section 2.7, the `bearer`, `expo`, `apiKey` and OAuth 2.1 provider plugin options, the `createAuthMiddleware` before-hook signature, consent page integration that lets Kvitbit store the Workspace and access on the grant, CIMD support, and the refresh token reuse window.
- MCP: `@modelcontextprotocol/server` stateless mode with `enableJsonResponse`, `outputSchema` and `structuredContent` on protocol `2025-11-25`, resource templates with query expansion.
- Expo Updates protocol v1 headers and multipart signing format, against the Expo SDK version `apps/mobile` pins.
- React Native multipart streaming upload through `expo-file-system` `uploadAsync` (also listed in core-ports section 12).

---

## 11. Traceability

| Acceptance item (issue #19 brief) | Where |
|---|---|
| (1) Edge routing table: `/api/v1/*`, `/api/auth/*`, `/mcp`, `/i/:token`, `/app/*`, `/api/mobile/updates/*`, `/api/mobile/releases/latest`, `/healthz` | Section 1, section 5 |
| (2) Auth middleware and Caller construction: Better Auth cookies and bearer, API Keys with scope narrowing, OAuth 2.1 MCP tokens, ALTCHA challenge and verify | Sections 2.1 to 2.7, 6.2 to 6.4 |
| (3) HttpApi groups for all 9 core modules | Sections 3.5, 3.6 |
| (3) Material 3 theme endpoints (seed or `material-theme.json`) on account preferences and Workspace branding | Section 3.5.2 (theme schemas, `me`, `themes`), 3.5.3 (`branding`) |
| (3) Binary upload and download (PDFs, branding images, expense attachments) | Section 3.4 |
| (3) ETag and `If-Match` mapped to 412, `Idempotency-Key`, cursor pagination | Section 3.2 |
| (3) Five shared `Schema.TaggedError` status mappings | Section 3.3 |
| (4) Remote Streamable HTTP MCP: OAuth 2.1 scopes, curated tools, two-step preview and confirm, resources, accountant read-only enforcement | Sections 6.1 to 6.9 |
| (5) Peer agreements with ui-port-contracts | Section 7 |
| Council hand-off rules: callers only from verified credentials, scopes only narrow, policy before replay, 412 at the edge | Rules A1 to A4, section 2.3 step 4, section 3.2 `withRevision` |
