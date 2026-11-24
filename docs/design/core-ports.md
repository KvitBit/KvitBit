# Core ports: canonical specification

Issue #18. Status: accepted design, ready to implement. Decision record: [ADR 0004](../adr/0004-hexagonal-core-ports.md).

This spec merges the three Design-It-Twice candidates (`core-ports-opt-1.md`, `core-ports-opt-2.md`, `core-ports-opt-3.md`). The base is Candidate 2: nine caller-facing modules named after CONTEXT.md concepts, no repository port, one small error vocabulary, and durable jobs on `ClusterWorkflowEngine` plus `ClusterCron`. From Candidate 3 it takes the sealed `Caller` union. From Candidate 1 it takes the driven port names, the "records in another Workspace are NotFound" rule, and the outbox reconcile.

Product rules fixed before this spec:

- VAT is calculated per rate bucket (Facturoid convention).
- QR Platba (SPAYD) for CZK, EPC QR (SEPA credit transfer) for EUR, no payment QR for other currencies.
- Facturoid-style permissive lifecycle: drafts are freely editable and deletable. Issued documents stay editable, with an audit trail and a unique number override, until someone locks them. Issued documents are never hard-deleted; they are cancelled or corrected with a Credit Note. Paying a Proforma of a `vat_payer` issues the Payment Tax Document automatically. The Final Invoice that deducts the advance is an explicit action.
- Hosted: Neon Postgres, Cloud Run for HTTP, Compute Engine cluster runners. Self-hosted: one Postgres with `SingleRunner`.

Terms follow CONTEXT.md. Effect APIs follow `effect@4.1.4` as checked in `docs/research/effect-cluster-workflow.md` and as used in Deskohub (`Context.Service`, `Schema.TaggedError`, `effect/http-api`). Section 12 lists the spellings to confirm against 4.1.4 during implementation; none of them changes the design.

---

## 0. Shape and packages

```
 Foldkit web (SSR)    Expo app     MCP server     Public share page
        │                 │             │                 │
        └──── HttpApiClient (#20) ──────┤                 │
                                        ▼                 ▼
              apps/server: HttpApi (#19), MCP tools, auth, BotProtection
              builds Caller: Account → Workspaces.enter → Member | ShareLinkVisitor
                                        │
   ┌──────────────── @kvitbit/core: nine caller-facing modules ─────────────────┐
   │ Workspaces  Contacts  PriceList  Documents  Payments  Expenses  Templates    │
   │ Reports  PublicShareLinks                                                    │
   └──────────────────────────────────────────────────────────────────────────────┘
     internal: Policy · AuditLog · RequestLog · Outbox · workflows · crons
     pure engines (@kvitbit/core/engines): VatMath · Numbering · PaymentQr ·
                                             StatutoryText · Schedules · PdfRenderer (server)
     driven ports: CompanyRegistry · ExchangeRates · EmailSender · BlobStorage
     Effect-owned seams: SqlClient (Postgres | PGlite) · WorkflowEngine · Sharding
     edge-only port (apps/server): BotProtection
```

`packages/core` has four entry points. Bundlers and lint enforce the split: web and mobile code may import only the first two.

| Entry point | Contents | Runtime deps | Consumers |
|---|---|---|---|
| `@kvitbit/core/contract` | Branded IDs, input and view `Schema` classes, the five errors (with HTTP status annotations), `Caller` types and edge constructors, `Action` union and the pure `can(caller, action)` policy, `IssueCode` union | `effect` only | apps/server, api contract, ui-port, Foldkit, Expo, tests |
| `@kvitbit/core/engines` | `VatMath`, `Numbering`, `PaymentQr`, `StatutoryText`, `Schedules` (pure) | `effect` only | core, ui-port (live totals), tests |
| `@kvitbit/core` | The nine module services and their live layers, workflows, crons, driven port tags, `PdfRenderer` | `effect`, `@react-pdf/renderer`, `qrcode` | apps/server, cluster runners |
| `@kvitbit/core/testing` | `TestCore` layer and fake adapters | as above | tests |

Nothing in `@kvitbit/core` is reachable from `/contract` or `/engines`, so browser and React Native bundles never pull SQL, workflow or PDF code.

---

## 1. Shared vocabulary

```ts
// @kvitbit/core/contract/vocabulary.ts
import { BigDecimal, Schema } from "effect"

export const WorkspaceId = Schema.String.pipe(Schema.brand("WorkspaceId"))
// Same pattern for: UserId, ContactId, PriceListItemId, DocumentId, LineId, PaymentId,
// ExpenseId, AttachmentId, TemplateId, ScheduleId, NumberingSeriesId, BankAccountId,
// InvitationId, InvitationToken, DeliveryId, AuditEntryId, ExportId, ShareViewId, ShareToken,
// VisitorHash, RequestKey.
// All ids are UUIDv7 except InvitationToken, ShareToken and VisitorHash.
// InvitationToken = 32 random bytes, base64url; stored only as its SHA-256 hash.
// ShareToken = "v{keyVersion}." + base64url(HMAC-SHA256(shareKey[keyVersion], shareLinkId)).
//   Re-derivable, so the owner UI can show the link again without storing the token;
//   rotating the key version invalidates every old link. Lookup is by hash of the token.
// VisitorHash = HMAC of IP + user agent with a daily rotated key.

/** URL name of a Workspace: lowercase letters, digits and hyphens, 3 to 40 chars, unique across the install. */
export const WorkspaceSlug = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/)), Schema.brand("WorkspaceSlug"))

export const Role = Schema.Literals(["owner", "admin", "member", "accountant"])
export const TaxRegime = Schema.Literals(["non_vat_payer", "vat_payer", "identified_person"])
export const Locale = Schema.Literals(["cs", "en"])
export const DocumentKind = Schema.Literals(["invoice", "proforma", "payment_tax_document", "credit_note"])
/** How the buyer is asked to pay; printed on the document and used as the default Payment method. */
export const PaymentMethod = Schema.Literals(["bank_transfer", "cash", "card", "other"])
export const CurrencyCode = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Z]{3}$/)), Schema.brand("CurrencyCode"))
/** Calendar date in Europe/Prague, YYYY-MM-DD. */
export const IsoDate = Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)), Schema.brand("IsoDate"))

export const Money = Schema.Struct({ amount: Schema.BigDecimal, currency: CurrencyCode })

/**
 * VAT is chosen by supply class, never by a raw percentage. VatMath resolves the
 * percentage in force on the tax point (§47), so 21 and 12 never appear in caller code.
 */
export const VatTreatment = Schema.Literals([
  "standard",              // 21 % since 2024-01-01
  "reduced",               // 12 % since 2024-01-01
  "exempt_intra_eu_goods", // §64, buyer EU VAT ID required
  "reverse_charge",        // §92a domestic or EU services; buyer VAT ID required
  "outside_scope",         // the only treatment for non_vat_payer and for identified_person domestic supplies
])

export const LineInput = Schema.Struct({
  item: Schema.optional(PriceListItemId),        // fills description, unit, unitPrice, vat from the Price List Item
  description: Schema.optional(Schema.String),
  quantity: Schema.optional(Schema.BigDecimal),  // default 1
  unit: Schema.optional(Schema.String),
  unitPrice: Schema.optional(Schema.BigDecimal), // document currency; excl. VAT unless pricesIncludeVat
  vat: Schema.optional(VatTreatment),            // default from Tax Regime + Contact (section 4.4, rule D9)
})

export const Page = <A>(item: Schema.Schema<A>) =>
  Schema.Struct({ items: Schema.Array(item), nextCursor: Schema.NullOr(Schema.String) })
/** Cursor paging input. limit 1 to 100, default 50. A cursor is bound to the filter it came from. */
export const PageRequest = Schema.Struct({
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 })))),
})

/**
 * Retry-safety token. HTTP maps the Idempotency-Key header. MCP maps the optional
 * idempotencyKey tool argument (`mcp:<grantId>:<idempotencyKey>`) on single-call writes and the
 * confirmation id (`mcp-confirm:<confirmationId>`) on confirmed two-step calls; it never uses
 * JSON-RPC call ids, which restart per connection. Workflows derive their keys.
 */
export const RequestOptions = Schema.Struct({ requestKey: Schema.optional(RequestKey) })

/** The API Key or MCP client a Member acts through. Shown in audit as "X via <name>". */
export const ClientRef = Schema.Struct({
  kind: Schema.Literals(["api_key", "mcp"]),
  id: Schema.String,   // API Key id or MCP grant id (apps/server owns both)
  name: Schema.String, // key name or OAuth client name at the time of the call
})

/** A stored image or file reference. */
export const ImageRef = Schema.Struct({
  contentType: Schema.String, bytes: Schema.Int, sha256: Schema.String, updatedAt: Schema.String,
})
```

All money arithmetic uses `BigDecimal`. Amounts cross the wire as decimal strings.

Theme types live in `/contract` too, because Workspace branding stores a theme (section 4.1). `packages/api-contract/src/theme.ts` re-exports them and adds the edge-only `ThemePresets`, `ThemeContrast`, `ThemeMode`, `ThemeStyle` (`"elegant" | "cozy"`, default `"elegant"`), `ThemePreference` and `ResolvedTheme`.

```ts
// @kvitbit/core/contract/theme.ts
export const Hex = Schema.String.pipe(Schema.check(Schema.isPattern(/^#[0-9A-Fa-f]{6}$/)))
export const ThemePresetId = Schema.Literals(["graphite_atelier", "forest", "ocean", "plum", "sand", "graphite"])
export const ThemeSource = Schema.Union([
  Schema.TaggedStruct("Preset", { id: ThemePresetId }),
  Schema.TaggedStruct("Seed", { seed: Hex }),
  /** Raw material-theme.json from Material Theme Builder, at most 64 KB encoded. */
  Schema.TaggedStruct("MaterialThemeBuilder", { json: Schema.Unknown }),
])
```

Core checks the size and the top-level shape of a `MaterialThemeBuilder` value (`theme.too_large`, `theme.json_invalid`) and a `Seed` value (`theme.seed_invalid`) and stores the source as sent. Resolving a source into M3 schemes and the `theme.low_contrast` warning stay in apps/server (`ThemeResolver`).

---

## 2. Caller context and RBAC

### 2.1 The sealed `Caller`

```ts
// @kvitbit/core/contract/caller.ts
import { Context } from "effect"

export type Channel = "web" | "mobile" | "api" | "mcp"

/** The ten permission areas of rule R1. API Keys and MCP grants carry any non-empty subset of Scope. */
export type ScopeArea =
  | "workspace" | "members" | "contacts" | "catalog" | "documents"
  | "payments" | "expenses" | "templates" | "reports" | "share"
export type Scope = `${ScopeArea}:${"read" | "write"}` // e.g. "documents:write"; write implies read at grant time

export interface MemberCaller {
  readonly _tag: "Member"
  readonly userId: UserId
  readonly workspaceId: WorkspaceId
  readonly role: Role
  /**
   * Session callers get "all". API and MCP tokens carry the scopes they were granted;
   * scopes only narrow the role, never widen it.
   */
  readonly scopes: "all" | ReadonlyArray<Scope>
  readonly locale: Locale // UI locale; document language is resolved separately
  readonly channel: Channel
  /** API Key or MCP client the request came through; null for web and mobile sessions. */
  readonly client: ClientRef | null
}

/** Authenticated user with no Workspace chosen yet (onboarding, workspace picker, invitations). */
export interface AccountCaller {
  readonly _tag: "Account"
  readonly userId: UserId
  readonly email: string
  readonly locale: Locale
  readonly channel: Channel
}

/** Anonymous holder of a Public Share Link token. */
export interface ShareLinkVisitorCaller {
  readonly _tag: "ShareLinkVisitor"
  readonly token: ShareToken
  readonly visitor: VisitorHash
  readonly locale: Locale
  /** Set when the request also carries a verified session; a Member of the issuing Workspace records no view. */
  readonly signedInUser?: UserId
}

/** Anonymous holder of an invitation link, before or without an account (invitation page). */
export interface InvitationHolderCaller {
  readonly _tag: "InvitationHolder"
  readonly token: InvitationToken
  readonly locale: Locale
}

declare const SystemSeal: unique symbol // declared in core/src/internal; never exported

/** Workflows and crons. Constructible only inside @kvitbit/core. */
export interface SystemCaller {
  readonly _tag: "System"
  readonly [SystemSeal]: true
  readonly workspaceId: WorkspaceId
  readonly job:
    | { readonly _tag: "RecurringIssuance"; readonly scheduleId: ScheduleId; readonly occurrence: IsoDate }
    | { readonly _tag: "PaymentReminders"; readonly documentId: DocumentId }
    | { readonly _tag: "DocumentDelivery"; readonly deliveryId: DeliveryId }
    | { readonly _tag: "DataExport"; readonly exportId: ExportId }
}

export type Caller = MemberCaller | AccountCaller | ShareLinkVisitorCaller | InvitationHolderCaller | SystemCaller

export class CurrentCaller extends Context.Service<CurrentCaller, Caller>()("kvitbit/Caller") {}

/** Edge constructors. There is deliberately no constructor for System. */
export const Caller: {
  readonly account: (a: Omit<AccountCaller, "_tag">) => AccountCaller
  readonly shareLinkVisitor: (v: Omit<ShareLinkVisitorCaller, "_tag">) => ShareLinkVisitorCaller
  readonly invitationHolder: (i: Omit<InvitationHolderCaller, "_tag">) => InvitationHolderCaller
  // MemberCaller comes only from Workspaces.enter (section 4.1), which checks membership.
}
```

Sealing works on two levels. The type cannot be satisfied outside core because `SystemSeal` is a `unique symbol` that no entry point exports. At runtime, `Policy` accepts a System caller only if it is the instance created by core's internal `systemCaller(...)` factory (a module-private `WeakSet` membership check), so a decoded or spread object fails with `Forbidden`. A lint rule bans deep imports into `@kvitbit/core/src/internal`.

Every module method requires `CurrentCaller` in its `R` channel. Domain methods take no `workspaceId` parameter: the Workspace comes from the caller, so a caller cannot pass the wrong one.

Replay signal. apps/server sets the `Idempotent-Replayed` header from a request-scoped service that core writes to when rule C3 returns a stored result. It is optional: core reads it with `Effect.serviceOption`, so it never appears in a method's `R` channel, and callers that do not provide it (MCP, tests, workflows) lose nothing.

```ts
// @kvitbit/core (server only)
export class RequestOutcome extends Context.Service<RequestOutcome, {
  readonly markReplayed: Effect.Effect<void>
  readonly replayed: Effect.Effect<boolean>
}>()("kvitbit/RequestOutcome") {
  /** A fresh Ref-backed instance; the edge provides one per HTTP request. */
  static readonly make: Effect.Effect<RequestOutcome["Service"]>
}
```

### 2.2 How edges build a caller

1. A verified Better Auth session cookie, bearer token, or MCP OAuth 2.1 token gives a `UserId` and, for tokens, the granted scopes. Nothing in a `Caller` comes from the request body (auth never enters core).
2. The edge provides `Caller.account(...)`.
3. For Workspace routes it calls `Workspaces.enter(workspaceId, { scopes, channel, client })`, which loads the membership and returns a `MemberCaller`, or `NotFound` when the user is not a Member (the Workspace's existence is not revealed). `client` is the verified API Key or MCP grant, never request input; sessions pass none.
4. The edge provides that `MemberCaller` for the rest of the request.
5. Public share routes skip auth and provide `Caller.shareLinkVisitor({ token, visitor, locale, signedInUser? })`. `signedInUser` is set only from a verified session cookie that happens to be present.
6. The invitation peek route skips auth and provides `Caller.invitationHolder({ token, locale })`. Accepting an invitation needs an `AccountCaller`.

### 2.3 Actions and the policy table

`Action` is a closed literal union in `/contract`. `can(caller, action): boolean` is pure and exported, so ui-port hides controls with the same table the core enforces. Core enforces it inside every module method through the internal `Policy` service; callers never check permissions themselves.

| Action group | owner | admin | member | accountant | Account | ShareLinkVisitor | InvitationHolder | System |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `*.read` (including `member.read`, `share.read` for view tracking), `document.pdf`, `document.history`, `report.run`, `report.export` (report files and the full data export), `expense.attachment.read` | ✓ | ✓ | ✓ | ✓ | | | | ✓ |
| `contact.write`, `priceList.write`, `template.write`, `schedule.write`, `expense.write` | ✓ | ✓ | ✓ | | | | | |
| `document.draft`, `document.issue`, `document.edit`, `document.cancel`, `document.correct`, `document.finalInvoice`, `document.send`, `document.lock`, `share.write`, `payment.write` | ✓ | ✓ | ✓ | | | | | `issue`, `send` only |
| `document.unlock` (reason required), `document.overrideNumber` | ✓ | ✓ | | | | | | |
| `workspace.settings` (Issuing Entity, Tax Regime, slug, bank accounts, Numbering Series, defaults, reminder policy, branding and its images and preview) | ✓ | ✓ | | | | | | |
| `member.invite`, `member.setRole` (target and role are `member` or `accountant` only), `invitation.read` | ✓ | ✓ | | | | | | |
| `member.manageAdmins` (invite as, promote to, demote from, or remove an `admin`) | ✓ | | | | | | | |
| `member.leave` | | ✓ | ✓ | ✓ | | | | |
| `apiKey.manage`, `grant.read.all`, `grant.revoke.all` | ✓ | ✓ | | | | | | |
| `grant.create`, `grant.read.own`, `grant.revoke.own` | ✓ | ✓ | ✓ | ✓ (read-only grants) | | | | |
| `workspace.transferOwnership`, `workspace.close` | ✓ | | | | | | | |
| `workspace.create`, `workspace.listMine`, `workspace.enter`, `invitation.accept`, `registry.lookup` | | | | | ✓ | | | |
| `share.open`, `share.pdf`, `share.logo` (own token only) | | | | | | ✓ | | |
| `invitation.peek` (own token only) | | | | | | | ✓ | |

Rules:

- R1. Effective permission = role table ∩ scopes. Each `Action` belongs to one `ScopeArea` (`workspace`, `members`, `contacts`, `catalog`, `documents`, `payments`, `expenses`, `templates`, `reports`, `share`) and is a read or a write. A token with `documents:read` only can read documents and nothing else, whatever the role.
- R1a. `can` runs before anything else in a method, including the request-log replay of rule C3, so a Member who lost access cannot replay a stored result.
- R1b. Locking is open to `member` because it only restricts; unlocking needs `owner` or `admin`. This is a product decision, not a legal one.
- R1c. Admin changes are owner only (user-flows section 4). `invite` with role `admin`, `setRole` to `admin`, and `setRole` (including removal) of a Member who is an `admin` need `member.manageAdmins` in addition to `member.invite` or `member.setRole`. Admins manage `member` and `accountant` Members only. `can(caller, "member.manageAdmins")` is what ui-port uses to offer the `admin` role.
- R1d. `apiKey.*` and `grant.*` guard records that apps/server owns (API Keys, MCP grants). They are session-only: a caller whose `scopes` is not `"all"` never holds them, so a key or token cannot mint or revoke credentials. An `accountant` may create only read-only grants; the edge caps `access` by role.
- R1e. `registry.lookup` covers the Account caller (onboarding). A Member caller of `Workspaces.lookupCompany` needs `contact.read` instead (MCP `lookup_ares`, contact editor prefill).
- R2. A record that belongs to another Workspace is `NotFound`, never `Forbidden`.
- R3. A Workspace always has exactly one `owner`. Removing or demoting the owner fails with `Conflict{illegal_transition}`, and the owner cannot `leave` (`Conflict{illegal_transition}`, detail `member.owner_cannot_leave`); ownership moves only through `transferOwnership`.
- R4. A System caller is scoped to its `workspaceId` and its `job`. Audit entries attribute it as `system` plus the job (for example "Recurring Schedule X, occurrence 2026-12-01").
- R5. Workflows never run as a Member. They never unlock, override numbers, or change membership. The `DataExport` job only reads.

---

## 3. Shared errors

Five `Schema.TaggedError` classes cover every expected failure across all modules. Each carries its HTTP status, so HttpApi and MCP encode them without per-endpoint mapping. Defects (bugs, broken invariants) stay defects: adapters log them and answer 500 or an MCP internal error.

```ts
// @kvitbit/core/contract/errors.ts
import { Schema } from "effect"
import { HttpApiSchema } from "effect/http-api"

export const EntityKind = Schema.Literals([
  "Workspace", "Member", "Invitation", "Contact", "PriceListItem", "Document", "Payment",
  "Expense", "Attachment", "Template", "Schedule", "NumberingSeries", "BankAccount", "ShareLink",
  "BrandingImage", "Export", "ApiKey", "McpGrant",
])

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  entity: EntityKind,
  id: Schema.String,
}) { static schema = this.pipe(HttpApiSchema.status("NotFound")) }            // 404

export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  action: Action,
}) { static schema = this.pipe(HttpApiSchema.status("Forbidden")) }           // 403

export class Invalid extends Schema.TaggedError<Invalid>()("Invalid", {
  issues: Schema.NonEmptyArray(Schema.Struct({
    path: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
    code: IssueCode,                                 // stable i18n key; presenters localize cs/en
    params: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  })),
}) { static schema = this.pipe(HttpApiSchema.status("UnprocessableEntity")) } // 422

export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
  reason: Schema.Literals([
    "revision_changed",     // stale expectedRevision / If-Match
    "document_locked",      // edit or cancel on a locked document
    "illegal_transition",   // e.g. send a draft, discard an issued document, remove last owner
    "duplicate",            // number override taken, second Final Invoice, duplicate IČO Contact
    "idempotency_mismatch", // same requestKey, different payload
  ]),
  currentRevision: Schema.optional(Schema.Number),
  detail: Schema.optional(IssueCode),
}) { static schema = this.pipe(HttpApiSchema.status("Conflict")) }            // 409

export class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", {
  dependency: Schema.Literals(["company_registry", "exchange_rates", "blob_storage", "database"]),
  retryAfterSeconds: Schema.optional(Schema.Number),
}) { static schema = this.pipe(HttpApiSchema.status("ServiceUnavailable")) }  // 503

export type CoreError = NotFound | Forbidden | Invalid | Conflict | Unavailable
```

`IssueCode` is a closed union in `/contract`, grouped by prefix, so ui-port and MCP localize every code from one table. Core codes, for example: `ico.checksum`, `vat.not_allowed_for_regime`, `document.buyer_vat_id_required`, `document.lines_required`, `document.due_before_issue`, `credit_note.exceeds_original`, `final_invoice.proforma_unpaid`, `payment.currency_mismatch`, `payment.has_tax_document`, `numbering.pattern_invalid`, `qr.field_too_long`, `fx.rate_missing`, `attachment.too_large`, `attachment.type_rejected`, `schedule.cadence_invalid`, `schedule.missed_occurrences`.

Codes added for the HTTP, MCP and ui-port contracts (#19, #20):

| Code | Raised by | Error |
|---|---|---|
| `workspace.slug_invalid`, `workspace.slug_taken` | `Workspaces.create`, `updateSettings` | `Invalid` (a form field issue) |
| `member.owner_cannot_leave` | `Workspaces.leave` | `Conflict{illegal_transition}` |
| `invitation.not_pending` | `Workspaces.resendInvitation`, `acceptInvitation` | `Conflict{illegal_transition}` |
| `bank_account.in_use`, `bank_account.replacement_invalid` | `Workspaces.removeBankAccount` | `Conflict{illegal_transition}`; `Invalid` |
| `branding.image_too_large`, `branding.image_type_rejected`, `branding.accent_invalid` | `Workspaces.setBrandingImage`, `updateSettings` | `Invalid` |
| `theme.json_invalid`, `theme.too_large`, `theme.seed_invalid` | `Workspaces.updateSettings` (branding theme), apps/server `ThemeResolver` | `Invalid` |
| `theme.low_contrast` | apps/server `ThemeResolver` | warning in the resolved view, never an error |
| `fx.manual_rate_invalid`, `fx.manual_not_allowed_for_czk` | `Documents` (manual FX, rule D11) | `Invalid` |
| `reminder.document_settled` | `Documents.send` with `purpose: "reminder"` | `Conflict{illegal_transition}` |
| `expense.incomplete` | operations that need a complete Expense (`Payments.record` on it) | `Invalid` |
| `export.not_ready` | `Reports.exportFile` while the job runs or after it failed | `Conflict{illegal_transition}` |
| `page.cursor_mismatch` | every paged read (cursor from another filter) | `Invalid` |
| `request.malformed` | apps/server schema decode failure | `Invalid` |
| `mcp.confirmation_invalid`, `mcp.confirmation_mismatch`, `mcp.confirmation_expired`, `mcp.confirmation_required` | apps/server MCP two-step confirmation | `Invalid` |

`theme.low_contrast`, `request.malformed` and the `mcp.*` codes are raised only by apps/server; they live in the union so there is one i18n table.

Email outages never surface as errors: `send` returns `queued`, and the delivery status shows the outcome later. Driven-port failures are internal `Data.TaggedError`s; modules translate them to `Unavailable`, so provider details (ARES payloads, Resend bodies, SQL text) never cross the seam.

---

## 4. Domain modules

Common rules for all nine modules:

- C1. Every mutating method runs in one Postgres transaction that covers the domain change, its audit entries, its request-log row, and any outbox intent row (section 8).
- C2. Mutations of an existing aggregate take `expectedRevision`. A mismatch fails with `Conflict{revision_changed, currentRevision}`. HTTP maps it to `If-Match` and the view's `revision` to `ETag`.
- C3. Creates and non-idempotent actions take `RequestOptions`. After the policy check (rule R1a), a repeated `requestKey` with the same method and payload hash returns the stored result. A different method or payload fails with `Conflict{idempotency_mismatch}`. Keys are scoped to `(workspaceId or userId, requestKey)` and kept 24 hours. Workflow-derived keys are prefixed (`recurring:`, `reminder:`) so they cannot collide with client keys.
- C4. Views echo every resolved default, so callers see what the core chose.
- C5. Audit entries are append-only (section 4.10). The rows a module writes and the audit rule for each method are listed with the module.
- C6. Retry coverage. Every mutating method is covered by exactly one of three mechanisms:

| Mechanism | Methods |
|---|---|
| `requestKey` (creates and actions with a new outcome) | `Workspaces.create`, `invite`, `saveBankAccount` (new), `configureSeries` (new); `Contacts.save` (new); `PriceList.save` (new); `Documents.createDraft`, `issue`, `cancel`, `correct`, `issueFinalInvoice`, `send`; `Payments.record`; `Expenses.record`; `Templates.save` (new), `use`; `Reports.startExport` |
| `expectedRevision` (changes to an existing aggregate) | `Workspaces.updateIssuingEntity`, `updateSettings`; `Contacts.save` (existing); `PriceList.save` (existing); `Documents.edit`, `discardDraft`; `Expenses.edit`, `remove`; `Templates.save` (existing), `schedule` |
| Idempotent by state (a repeat returns the same result) | `Documents.lock`, `unlock`; `PublicShareLinks.create`, `revoke`; `Payments.remove`; every `archive`; `Workspaces.saveBankAccount` (existing, full replacement), `configureSeries` (existing, full replacement), `removeBankAccount`, `setRole`, `leave`, `revokeInvitation`, `resendInvitation` (no second email within 60 s of the last one), `setBrandingImage` (by content hash), `removeBrandingImage`, `recordAccessEvent` (by subject and action), `transferOwnership`, `close`; `Templates.resume`; `Expenses.attach` (by content hash), `detach` |

Dry runs (`Documents.preview`, `previewSend`, `previewFinalInvoice`, `previewCorrection`, `Workspaces.previewBranding`) write nothing, so they need no retry mechanism.

### 4.1 `Workspaces`

Owns the Workspace, its slug, Issuing Entity, Tax Regime, bank accounts, Numbering Series, Members, invitations, branding, and Workspace defaults (currency, payment terms, document language, reminder policy, payment rounding, Payment Tax Document auto-send). It also serves the read-only company registry lookup, because onboarding needs it before any Workspace exists.

```ts
export class Workspaces extends Context.Service<Workspaces, {
  // Account caller
  /** Onboarding. Prefills the Issuing Entity from CompanyRegistry when ico is given. Caller becomes owner. */
  readonly create: (input: NewWorkspace, opts?: RequestOptions) =>
    Effect.Effect<MemberCaller, Invalid | Unavailable | Forbidden, CurrentCaller>
  readonly listMine: Effect.Effect<ReadonlyArray<WorkspaceSummary>, Forbidden, CurrentCaller>
  /** The only way to obtain a MemberCaller. NotFound when the user is not a Member. */
  readonly enter: (workspace: WorkspaceId, opts: {
    readonly scopes: MemberCaller["scopes"]
    readonly channel: Channel
    readonly client?: ClientRef // verified API Key or MCP grant; copied into MemberCaller.client and audit
  }) => Effect.Effect<MemberCaller, NotFound | Forbidden, CurrentCaller>
  readonly acceptInvitation: (token: InvitationToken) =>
    Effect.Effect<MemberCaller, NotFound | Conflict | Forbidden, CurrentCaller>

  // Account caller (registry.lookup) or Member caller (contact.read)
  /** Read-only CompanyRegistry lookup: checksum first, 24 h cache, nothing saved. NotFound when ARES has no record. */
  readonly lookupCompany: (ico: string) =>
    Effect.Effect<RegistryResult, Invalid | NotFound | Unavailable | Forbidden, CurrentCaller>

  // InvitationHolder caller
  /** What the invitation page shows before sign-up. Unknown tokens are NotFound; others show their status. */
  readonly peekInvitation: Effect.Effect<InvitationPeek, NotFound, CurrentCaller>

  // Member caller
  readonly current: Effect.Effect<WorkspaceView, Forbidden, CurrentCaller>
  readonly updateIssuingEntity: (patch: IssuingEntityPatch, expectedRevision: number) =>
    Effect.Effect<WorkspaceView, Invalid | Conflict | Forbidden, CurrentCaller>
  /** Defaults, slug, reminder policy and branding (fields of WorkspaceSettingsPatch). */
  readonly updateSettings: (patch: WorkspaceSettingsPatch, expectedRevision: number) =>
    Effect.Effect<WorkspaceView, Invalid | Conflict | Forbidden, CurrentCaller>
  readonly saveBankAccount: (input: BankAccountInput & { readonly id?: BankAccountId }, opts?: RequestOptions) =>
    Effect.Effect<BankAccountView, Invalid | NotFound | Conflict | Forbidden, CurrentCaller>
  /**
   * Archives the account. Issued documents keep their snapshot. When drafts, Templates or a
   * currency default use it, `replacement` (same currency) takes its place in the same transaction;
   * without one the call fails Conflict{illegal_transition, bank_account.in_use}.
   */
  readonly removeBankAccount: (id: BankAccountId, replacement?: BankAccountId) =>
    Effect.Effect<void, Invalid | NotFound | Conflict | Forbidden, CurrentCaller>
  readonly configureSeries: (input: {
    readonly id?: NumberingSeriesId
    readonly kind: DocumentKind
    readonly name: string
    readonly pattern: string          // tokens: YYYY YY MM N…; e.g. "YYYY-NNNN", "FV-YY-NNN"
    readonly nextNumber?: number      // only raises the counter for the current period
    readonly isDefault?: boolean
  }, opts?: RequestOptions) => Effect.Effect<NumberingSeriesView, Invalid | NotFound | Conflict | Forbidden, CurrentCaller>
  readonly listSeries: Effect.Effect<ReadonlyArray<NumberingSeriesView>, Forbidden, CurrentCaller>

  readonly setBrandingImage: (image: BrandingImage, file: {
    readonly contentType: string                // image/png or image/jpeg, at most 2 MB
    readonly bytes: Stream.Stream<Uint8Array>
  }) => Effect.Effect<ImageRef, Invalid | Unavailable | Forbidden, CurrentCaller>
  readonly brandingImage: (image: BrandingImage) =>
    Effect.Effect<FileDownload, NotFound | Unavailable | Forbidden, CurrentCaller>
  readonly removeBrandingImage: (image: BrandingImage) =>
    Effect.Effect<void, Forbidden, CurrentCaller>
  /**
   * Renders a fixed sample document of `kind` with the current branding merged with `branding`,
   * through PdfRenderer. Persists nothing, allocates no number, writes no audit entry.
   */
  readonly previewBranding: (input: { readonly branding: BrandingPatch; readonly kind: DocumentKind; readonly language: Locale }) =>
    Effect.Effect<FileDownload, Invalid | Unavailable | Forbidden, CurrentCaller>

  readonly members: Effect.Effect<ReadonlyArray<MemberView>, Forbidden, CurrentCaller>
  /** Pending and recently expired invitations (invitation.read). */
  readonly invitations: Effect.Effect<ReadonlyArray<InvitationView>, Forbidden, CurrentCaller>
  readonly invite: (email: string, role: Exclude<Role, "owner">, opts?: RequestOptions) =>
    Effect.Effect<InvitationView, Invalid | Conflict | Forbidden, CurrentCaller>
  /** Sends the email again and extends expiry by 7 days. Pending invitations only. */
  readonly resendInvitation: (id: InvitationId) =>
    Effect.Effect<void, NotFound | Conflict | Forbidden, CurrentCaller>
  readonly revokeInvitation: (id: InvitationId) => Effect.Effect<void, NotFound | Forbidden, CurrentCaller>
  readonly setRole: (member: UserId, role: Exclude<Role, "owner"> | null /* null removes */) =>
    Effect.Effect<void, NotFound | Conflict | Forbidden, CurrentCaller>
  /** The caller leaves the Workspace. The owner must transfer ownership first (rule R3). */
  readonly leave: Effect.Effect<void, Conflict | Forbidden, CurrentCaller>
  readonly transferOwnership: (to: UserId) => Effect.Effect<void, NotFound | Conflict | Forbidden, CurrentCaller>
  /** Makes the Workspace read-only. Purging is an operator task because of statutory retention. */
  readonly close: (confirmName: string) => Effect.Effect<void, Invalid | Forbidden, CurrentCaller>

  /**
   * Audit hook for credentials apps/server owns. The edge calls it after it creates or revokes
   * an API Key or MCP grant; core checks the matching apiKey.* or grant.* action and writes the entry.
   */
  readonly recordAccessEvent: (event: {
    readonly action: "apiKey.create" | "apiKey.revoke" | "grant.create" | "grant.revoke"
    readonly subject: { readonly entity: "ApiKey" | "McpGrant"; readonly id: string; readonly name: string }
    readonly onBehalfOf?: UserId // the grant's Member, when an owner or admin revokes someone else's grant
  }) => Effect.Effect<void, Forbidden, CurrentCaller>
}>()("kvitbit/Workspaces") {}

export const BrandingImage = Schema.Literals(["logo", "stamp"])

export const WorkspaceSummary = Schema.Struct({
  id: WorkspaceId,
  slug: WorkspaceSlug,
  name: Schema.String,
  role: Role,                 // the caller's role
  memberCount: Schema.Int,    // lets the edge guard account deletion (flow 1.9)
  taxRegime: TaxRegime,
  closed: Schema.Boolean,
})

export const WorkspaceBranding = Schema.Struct({
  pdfTemplate: PdfTemplate,                    // default "classic"
  accentColor: Hex,
  footerText: Schema.NullOr(Schema.String),    // at most 500 chars
  theme: Schema.NullOr(ThemeSource),
  logo: Schema.NullOr(ImageRef),
  stamp: Schema.NullOr(ImageRef),
})
export const BrandingPatch = Schema.Struct({
  pdfTemplate: Schema.optional(PdfTemplate),
  accentColor: Schema.optional(Hex),
  footerText: Schema.optional(Schema.NullOr(Schema.String)),
  theme: Schema.optional(Schema.NullOr(ThemeSource)),
})

// WorkspaceView adds to its existing fields (Issuing Entity, Tax Regime, defaults, bank accounts, revision):
//   slug: WorkspaceSlug, branding: WorkspaceBranding.
// NewWorkspace adds slug?: WorkspaceSlug (default: derived from the name, made unique with a suffix).
// WorkspaceSettingsPatch adds slug?: WorkspaceSlug and branding?: BrandingPatch.

export const MemberView = Schema.Struct({
  userId: UserId, name: Schema.String, email: Schema.String, role: Role, joinedAt: Schema.String,
})
export const InvitationView = Schema.Struct({
  id: InvitationId, email: Schema.String, role: Schema.Literals(["admin", "member", "accountant"]),
  status: Schema.Literals(["pending", "expired", "revoked", "accepted"]),
  invitedBy: Schema.Struct({ userId: UserId, name: Schema.String }),
  createdAt: Schema.String, expiresAt: Schema.String,
})
export const InvitationPeek = Schema.Struct({
  workspaceName: Schema.String,
  inviterName: Schema.String,
  role: Schema.Literals(["admin", "member", "accountant"]),
  email: Schema.String,             // shown and locked on the sign-up form (flow 2.5)
  status: Schema.Literals(["pending", "expired", "revoked", "accepted"]),
  expiresAt: Schema.String,
})
export const RegistryResult = Schema.Struct({
  ico: Schema.String,
  name: Schema.String,
  address: Schema.Struct({ street: Schema.String, city: Schema.String, postalCode: Schema.String, country: Schema.String }),
  dic: Schema.NullOr(Schema.String),           // presence does not prove VAT-payer status
  legalForm: Schema.String,
  registerEntry: Schema.NullOr(Schema.String), // §435 commercial register line
  terminatedOn: Schema.NullOr(IsoDate),        // the editor warns about a dissolved company
})

export interface NumberingSeriesView {
  readonly id: NumberingSeriesId
  readonly kind: DocumentKind
  readonly name: string
  readonly pattern: string
  readonly isDefault: boolean
  readonly periodKey: string   // Numbering.periodKey for today (Prague): "2026", "2026-11" or "all"
  readonly nextCounter: number // counter the next issue in periodKey will try (reserved numbers are still skipped)
  readonly nextNumber: string  // Numbering.format of nextCounter, for the issue dialog
}
```

Invariants:

- W1. One Workspace has exactly one Issuing Entity.
- W2. A Tax Regime change takes an `effectiveFrom` date. Documents with a tax point before it keep the old regime. Issued documents are never rewritten.
- W3. Each `DocumentKind` has exactly one default Numbering Series. Pattern validation uses `Numbering.parsePattern`. Changing a pattern applies to the next allocation only. `nextNumber` may raise the counter, never lower it below a number already issued in the period. `nextCounter` in the view is a read; only `issue` allocates (rule S3).
- W4. Exactly one owner (rule R3). `transferOwnership` demotes the caller to `admin` in the same transaction. Admin changes are owner only (rule R1c).
- W5. A closed Workspace rejects every non-read action with `Forbidden`.
- W6. Slugs are unique across the install and validated by `WorkspaceSlug` (`Invalid{workspace.slug_invalid | workspace.slug_taken}`). A slug change keeps the old slug as a redirect alias for 90 days; URLs carry the slug, API paths carry the id.
- W7. Branding images are stored in `BlobStorage` under `branding/{workspaceId}/{image}/{sha256}`, checked while streaming (`Invalid{branding.image_too_large | branding.image_type_rejected}`). PDFs and the Public Share Link page use Workspace branding only. A branding change bumps the Workspace revision, which is part of every cached PDF key (section 5.5).
- W8. `leave` and `setRole(..., null)` end the membership in one transaction. apps/server then revokes that Member's API Keys and MCP grants for this Workspace.
- W9. `lookupCompany` shares the checksum and the 24 h per-IČO cache with `Contacts.fromIco` and never writes a Contact.

Idempotency: `create` and `invite` use `requestKey`; `invite` to an email with a pending invitation returns it. `MemberInvitation` workflow sends the email (section 7); `resendInvitation` bumps the invitation's send epoch and starts a new execution.
Audit: every method except reads, dry runs (`previewBranding`, `lookupCompany`, `peekInvitation`) and `enter` writes an audit entry on subject `Workspace`. `recordAccessEvent` writes on subject `ApiKey` or `McpGrant`.

### 4.2 `Contacts`

```ts
export class Contacts extends Context.Service<Contacts, {
  /** IČO in, saved Contact out: checksum, CompanyRegistry lookup, cache, upsert by IČO. */
  readonly fromIco: (ico: string, opts?: { readonly role?: "customer" | "supplier" }) =>
    Effect.Effect<ContactView, Invalid | Unavailable | Forbidden, CurrentCaller>
  readonly save: (input: ContactInput & { readonly id?: ContactId; readonly expectedRevision?: number }, opts?: RequestOptions) =>
    Effect.Effect<ContactView, Invalid | NotFound | Conflict | Forbidden, CurrentCaller>
  readonly archive: (id: ContactId) => Effect.Effect<void, NotFound | Forbidden, CurrentCaller>
  readonly get: (id: ContactId) => Effect.Effect<ContactView, NotFound | Forbidden, CurrentCaller>
  readonly search: (q: { readonly text?: string; readonly role?: "customer" | "supplier"; readonly cursor?: string }) =>
    Effect.Effect<Page<ContactView>, Forbidden, CurrentCaller>
}>()("kvitbit/Contacts") {}
```

Invariants: IČO is unique per Workspace among active Contacts (`Conflict{duplicate}`). The mod-11 checksum runs before any registry call. Registry results are cached 24 hours per IČO and never fanned out in parallel. VAT-payer status is never inferred from the presence of a DIČ. Contacts referenced by documents are archived, never deleted; issued documents keep their frozen party snapshot.

Per-Contact billing overrides (`ContactInput.defaults`, all optional, falling back along `Document → Contact → Workspace`). This is the source-of-truth schema; http-mcp-contracts section 3.5 and ui-port-contracts section 8.15 mirror it:

```ts
export const ReminderPolicy = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("inherit") }),                 // follow the Workspace reminder schedule
  Schema.Struct({ mode: Schema.Literal("disabled") }),                // no automatic reminders for this Contact
  Schema.Struct({ mode: Schema.Literal("custom"), offsetsDays: Schema.Array(Schema.Int) }), // days after due
])
export const ContactDefaults = Schema.Struct({
  currency: Schema.optional(CurrencyCode),
  language: Schema.optional(Locale),
  dueDays: Schema.optional(Schema.Int),
  paymentMethod: Schema.optional(PaymentMethod),
  /** Partial map: any subset of kinds, including none. A kind left out uses the Workspace default series. */
  preferredSeriesByKind: Schema.optional(Schema.Record(DocumentKind, Schema.optionalKey(NumberingSeriesId))),
  defaultNote: Schema.optional(Schema.String),
  reminderPolicy: Schema.optional(ReminderPolicy),                    // absent behaves as { mode: "inherit" }
})
```

Each `DocumentInput` field that the Contact can override (`currency`, `language`, `due` from `dueDays`, `paymentMethod`, `series` from `preferredSeriesByKind[kind]`, `note` from `defaultNote`) resolves `Document → Contact → Workspace` in `createDraft`, `issue` from input and `preview`: a value on the Document wins, then the Contact's, then the Workspace default. `reminderPolicy` resolves when reminders are armed (rule D16).
Audit: `save` and `archive`.

### 4.3 `PriceList`

```ts
export class PriceList extends Context.Service<PriceList, {
  readonly save: (input: PriceListItemInput & { readonly id?: PriceListItemId; readonly expectedRevision?: number }, opts?: RequestOptions) =>
    Effect.Effect<PriceListItemView, Invalid | NotFound | Conflict | Forbidden, CurrentCaller>
  readonly archive: (id: PriceListItemId) => Effect.Effect<void, NotFound | Forbidden, CurrentCaller>
  readonly list: (q?: { readonly text?: string; readonly includeArchived?: boolean }) =>
    Effect.Effect<ReadonlyArray<PriceListItemView>, Forbidden, CurrentCaller>
}>()("kvitbit/PriceList") {}
```

A Price List Item only supplies defaults. Lines copy its values when a document is drafted, so later item edits never change existing documents. Not audited (no tax effect).

### 4.4 `Documents`

The deepest module. It covers Invoice, Proforma, Payment Tax Document and Credit Note: drafting, issuing, numbering, VAT, FX, statutory text, payment QR, Document Lock, cancellation, correction, the Final Invoice, delivery, PDF and history.

```ts
/** Manual exchange rate, decision Q4: `quantity` units of the document currency = `rate` CZK. */
export const FxOverride = Schema.Struct({
  manual: Schema.Struct({ rate: Schema.BigDecimal, quantity: Schema.Int }),
})

export const DocumentInput = Schema.Struct({
  kind: Schema.Literals(["invoice", "proforma"]), // PTDs come from Payments; Credit Notes from correct/cancel
  contact: ContactId,
  lines: Schema.NonEmptyArray(LineInput),
  currency: Schema.optional(CurrencyCode),        // default: Contact → Workspace (CZK)
  issuedOn: Schema.optional(IsoDate),             // default: today (Prague)
  taxableSupplyOn: Schema.optional(IsoDate),      // default: issuedOn; drives VAT rate and CNB fixing
  due: Schema.optional(Schema.Union([Schema.Struct({ on: IsoDate }), Schema.Struct({ inDays: Schema.Int })])), // default: Contact → Workspace
  language: Schema.optional(Locale),              // default: Contact → Workspace
  series: Schema.optional(NumberingSeriesId),     // default: Contact preferredSeriesByKind → Workspace default for kind
  bankAccount: Schema.optional(BankAccountId),    // default: Issuing Entity default for currency
  pricesIncludeVat: Schema.optional(Schema.Boolean), // default false; selects §37(b) top-down math
  variableSymbol: Schema.optional(Schema.String),    // default: digits of the number
  orderNumber: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),           // default: Contact → Workspace
  paymentMethod: Schema.optional(PaymentMethod),  // default: Contact → Workspace
  fx: Schema.optional(FxOverride),                // default: CNB fixing (rule D11); non-CZK only
})

/** Every DocumentInput field except kind, each optional, plus two edit-only fields. */
export const DocumentPatch = Schema.Struct({
  contact: Schema.optional(ContactId),
  lines: Schema.optional(Schema.NonEmptyArray(LineInput)),
  // currency, issuedOn, taxableSupplyOn, due, language, series (drafts only), bankAccount,
  // pricesIncludeVat, variableSymbol, orderNumber, note, paymentMethod: as in DocumentInput, all optional
  fx: Schema.optional(Schema.NullOr(FxOverride)),// null returns to the CNB fixing (rule D11)
  number: Schema.optional(Schema.String),         // issued only; owner/admin; unique (rule D4)
  refreshParties: Schema.optional(Schema.Boolean),// re-snapshot Contact and Issuing Entity (rule D10)
})

export interface DocumentView {
  readonly id: DocumentId
  readonly kind: DocumentKind
  readonly number: string | null                   // null while draft
  readonly status: "draft" | "issued" | "cancelled"
  readonly locked: boolean
  readonly settlement: "unpaid" | "partially_paid" | "paid" | "overpaid" | "credited" // derived at read
  readonly overdue: boolean                        // derived at read
  readonly revision: number
  readonly taxDocument: boolean                    // true when the document is a VAT tax document
  readonly contact: ContactSnapshot                // buyer particulars as printed
  readonly issuer: IssuerSnapshot                  // Issuing Entity particulars, §435 register entry, bank account
  readonly dates: { readonly issuedOn: IsoDate; readonly taxableSupplyOn: IsoDate | null; readonly dueOn: IsoDate }
  readonly paymentMethod: PaymentMethod             // resolved Document → Contact → Workspace
  readonly lines: ReadonlyArray<LineView>          // resolved VatTreatment and rate %
  readonly totals: VatBreakdown                    // from VatMath, section 5.1
  readonly fx: null | { readonly rate: BigDecimal.BigDecimal; readonly quantity: number; readonly fixingDate: IsoDate | null /* null for manual */; readonly source: "cnb" | "manual" }
  readonly statutoryNotes: ReadonlyArray<StatutoryNote> // from StatutoryText, section 5.4
  readonly paymentQr: null | { readonly format: "spayd" | "epc"; readonly payload: string }
  readonly related: ReadonlyArray<{ readonly relation: "corrects" | "corrected_by" | "advance_of" | "tax_document_for" | "final_invoice_for" | "deducts"; readonly id: DocumentId; readonly kind: DocumentKind; readonly number: string }>
  readonly share: null | { readonly url: string; readonly views: number; readonly lastViewedAt: string | null }
  readonly deliveries: ReadonlyArray<{ readonly id: DeliveryId; readonly to: ReadonlyArray<string>; readonly purpose: DeliveryPurpose; readonly status: "queued" | "sending" | "sent" | "failed" | "skipped"; readonly at: string }>
}

export class Documents extends Context.Service<Documents, {
  /** Live totals for an editor. Same code path as issue; nothing is stored or numbered. */
  readonly preview: (input: DocumentInput) =>
    Effect.Effect<DocumentView, Invalid | Unavailable | Forbidden, CurrentCaller>
  readonly createDraft: (input: DocumentInput, opts?: RequestOptions) =>
    Effect.Effect<DocumentView, Invalid | NotFound | Unavailable | Forbidden, CurrentCaller>
  /** Drafts only. Hard delete. */
  readonly discardDraft: (id: DocumentId, expectedRevision: number) =>
    Effect.Effect<void, NotFound | Conflict | Forbidden, CurrentCaller>
  /** From an existing draft or straight from input. Assigns the number. */
  readonly issue: (
    from: { readonly draft: DocumentId; readonly expectedRevision: number } | { readonly input: DocumentInput },
    opts?: RequestOptions & { readonly send?: SendOptions },
  ) => Effect.Effect<DocumentView, CoreError, CurrentCaller>
  /** Drafts and unlocked issued documents. Issued edits are audited field by field. */
  readonly edit: (id: DocumentId, patch: DocumentPatch, expectedRevision: number) =>
    Effect.Effect<DocumentView, CoreError, CurrentCaller>
  readonly lock: (id: DocumentId) => Effect.Effect<DocumentView, NotFound | Conflict | Forbidden, CurrentCaller>
  readonly unlock: (id: DocumentId, reason: string) => Effect.Effect<DocumentView, NotFound | Conflict | Forbidden, CurrentCaller>
  /** Void an issued document without deleting it (rule D6). */
  readonly cancel: (id: DocumentId, input: { readonly reason: string; readonly on?: IsoDate }, opts?: RequestOptions) =>
    Effect.Effect<{ readonly document: DocumentView; readonly creditNote: DocumentView | null }, CoreError, CurrentCaller>
  /** Credit Note against an issued Invoice or Payment Tax Document. */
  readonly correct: (id: DocumentId, input: CorrectionInput, opts?: RequestOptions) =>
    Effect.Effect<DocumentView, CoreError, CurrentCaller>
  /** The Final Invoice for a paid Proforma, deducting the advance (§37a). Explicit; once per Proforma. */
  readonly issueFinalInvoice: (proforma: DocumentId, input?: { readonly patch?: DocumentPatch }, opts?: RequestOptions) =>
    Effect.Effect<DocumentView, CoreError, CurrentCaller>
  /**
   * Queue email delivery. Never fails on provider outage. purpose "document" arms payment reminders
   * unless disabled; purpose "reminder" sends one manual reminder and never re-arms the schedule (rule D14).
   */
  readonly send: (id: DocumentId, input?: SendOptions, opts?: RequestOptions) =>
    Effect.Effect<{ readonly deliveryId: DeliveryId; readonly status: "queued" }, NotFound | Conflict | Invalid | Forbidden, CurrentCaller>

  // Dry runs for MCP two-step confirmation (rule D15). Same code paths as the real call; nothing is stored.
  /** Recipients, language, subject and attachments that send(id, input) would use now. Checks document.send. */
  readonly previewSend: (id: DocumentId, input?: SendOptions) =>
    Effect.Effect<SendPreview, NotFound | Conflict | Invalid | Forbidden, CurrentCaller>
  /** The Final Invoice issueFinalInvoice would produce, with deductions, unnumbered. Checks document.finalInvoice. */
  readonly previewFinalInvoice: (proforma: DocumentId, input?: { readonly patch?: DocumentPatch }) =>
    Effect.Effect<DocumentView, CoreError, CurrentCaller>
  /** The Credit Note correct(id, input) would produce, unnumbered. Checks document.correct. */
  readonly previewCorrection: (id: DocumentId, input: CorrectionInput) =>
    Effect.Effect<DocumentView, CoreError, CurrentCaller>

  readonly pdf: (id: DocumentId, opts?: { readonly template?: PdfTemplate; readonly language?: Locale }) =>
    Effect.Effect<FileDownload, NotFound | Unavailable | Forbidden, CurrentCaller>
  readonly get: (id: DocumentId) => Effect.Effect<DocumentView, NotFound | Forbidden, CurrentCaller>
  readonly list: (q: DocumentQuery) => Effect.Effect<Page<DocumentSummary>, Invalid | Forbidden, CurrentCaller>
  readonly history: (id: DocumentId) => Effect.Effect<ReadonlyArray<AuditEntry>, NotFound | Forbidden, CurrentCaller>
}>()("kvitbit/Documents") {}

export interface CorrectionInput {
  readonly reason: string
  readonly lines: "full" | ReadonlyArray<{ readonly line: LineId; readonly quantity?: BigDecimal.BigDecimal; readonly unitPrice?: BigDecimal.BigDecimal }>
  readonly correctedOn?: IsoDate
}
export const DeliveryPurpose = Schema.Literals(["document", "reminder"])
export interface SendOptions {
  readonly to?: ReadonlyArray<string>     // default: Contact invoicing email
  readonly language?: Locale
  readonly reminders?: boolean            // default: effective reminder policy (rule D16); ignored for purpose "reminder"
  readonly purpose?: DeliveryPurpose      // default "document"
}
export interface SendPreview {
  readonly purpose: DeliveryPurpose
  readonly to: ReadonlyArray<string>
  readonly language: Locale
  readonly subject: string
  readonly attachments: ReadonlyArray<{ readonly filename: string; readonly contentType: string }>
  readonly armsReminders: boolean
}
/** "Classic Czech" (screen 23) and "Modern Minimal" (screen 24). */
export const PdfTemplate = Schema.Literals(["classic", "modern_minimal"])
export type PdfTemplate = typeof PdfTemplate.Type
export interface FileDownload { readonly filename: string; readonly contentType: string; readonly bytes: Stream.Stream<Uint8Array> }
```

Lifecycle:

```
            createDraft / edit
                 ┌───┐
                 ▼   │
  (none) ──► draft ──┘ ──discardDraft──► (deleted)
                 │
               issue (number assigned)
                 ▼
  ┌──────────► issued ◄───unlock (reason)───┐
  │  edit        │  │                       │
  └──────────────┘  └──lock──► issued+locked┘
                 │
               cancel ──► cancelled (non-tax) | issued + full Credit Note (tax document)
```

Invariants:

- D1. **Numbering.** `issue` assigns the number from the document's Numbering Series in the same transaction as the status change (row-locked counter, section 8). Allocation is gapless per series and period: a draft has no number, discarding drafts never consumes one, and a rolled-back issue reverts the counter. Every number ever assigned to a document is reserved permanently in the Workspace and is never assigned again. Payment Tax Documents and Credit Notes are numbered from their own kind's series when they are created.
- D2. **No hard delete after issue.** `discardDraft` on an issued document fails with `Conflict{illegal_transition}`.
- D3. **Permissive edit.** An issued, unlocked document accepts `edit`. Each accepted edit bumps `revision` and writes one audit entry with the field-level diff. Kind and series never change. Edits that touch lines, dates, currency or contact recompute VAT, FX, statutory notes and the payment QR, and invalidate cached PDFs (the cache key includes `revision`). Deliveries already queued keep the content they were queued with (section 7.2).
- D3a. **Edit limits that protect linked documents.** Lines, currency and tax point of an issued document are frozen (`Conflict{illegal_transition}`) once another document depends on them: a Proforma with payments or a Final Invoice, an Invoice or PTD with a Credit Note. A Payment Tax Document's amounts always follow its payment and are never edited directly; only text fields (note, order number, language) change. A cancelled document accepts no edits.
- D4. **Number override.** `patch.number` is accepted on issued documents only, for `owner` and `admin` (`document.overrideNumber`). The new number must not be reserved in the Workspace for that kind (`Conflict{duplicate}`). The old number stays reserved, so it is never reused, and the series shows a gap there; the audit entry records both. The series counter does not move; the allocator skips reserved numbers. The variable symbol follows the new number unless it was set explicitly.
- D5. **Document Lock.** `lock` is idempotent. On a locked document, `edit`, `cancel` and `correct` fail with `Conflict{document_locked}`. Recording payments, sending, sharing and PDF still work. `unlock` needs `owner` or `admin` and a reason, which goes into the audit entry. A cancelled document is always locked.
- D6. **Cancel (storno).** Eligibility depends on `taxDocument`:
  - Tax documents (an Invoice or Payment Tax Document whose issuer was a `vat_payer` at the tax point, or an `identified_person` document carrying VAT): `cancel` issues a full Credit Note for the uncorrected remainder and returns it; the original stays `issued` with `settlement: "credited"`. A tax document that is already fully credited fails with `Conflict{illegal_transition}`.
  - Non-tax documents (any Proforma, any Invoice without VAT from a `non_vat_payer` or an `identified_person` domestic supply): `cancel` sets `status: "cancelled"`, keeps the number reserved, and returns `creditNote: null`.
  - A document with recorded payments cannot be cancelled until its payments are removed (`Conflict{illegal_transition}`). For a Proforma with a Payment Tax Document that means correcting the PTD first (rule P3).
  - A Proforma that already has a Final Invoice cannot be cancelled; correct the Final Invoice instead.
  - Cancelling ends reminders, because the reminder check sees the new state.
- D7. **Credit Note.** `correct` accepts an issued Invoice or Payment Tax Document. The Credit Note records the original number, reason, correction date and the deltas of base, VAT and gross per rate (§45(1)). Cumulative corrections per rate bucket never exceed the original (`Invalid{credit_note.exceeds_original}`). The Credit Note inherits the original's currency, exchange rate (including a manual `fx.manual` rate) and VAT rate per bucket (§42, decision Q5); it is never re-fixed on the correction date.
- D8. **Final Invoice.** `issueFinalInvoice` needs an issued Proforma with at least one payment (`Invalid{final_invoice.proforma_unpaid}`) and runs once per Proforma (`Conflict{duplicate}`, enforced by a unique `final_invoice_for` link). It locks the Proforma row first, the same lock `Payments.record` takes, so a payment cannot slip in between reading the deposits and writing the deductions. Deductions are explicit lines with `relation: "deducts"`: for a `vat_payer`, one line per rate bucket for each linked Payment Tax Document, with negative base and VAT equal to the PTD's uncorrected amounts (§37a), so VAT already declared is not taxed twice; for other regimes, one line for the amount paid. Payments recorded on the Proforma after the Final Invoice are applied to the Final Invoice instead. The Proforma links to the Final Invoice as `final_invoice_for`.
- D9. **Tax Regime and VAT.** `non_vat_payer`, and `identified_person` for domestic supplies, accept only `outside_scope` (`Invalid{vat.not_allowed_for_regime}`). `reverse_charge` and `exempt_intra_eu_goods` need the buyer's VAT ID on the Contact (`Invalid{document.buyer_vat_id_required}`). Default treatment: `vat_payer` + domestic Contact gives `standard`; `vat_payer` + EU business Contact with VAT ID gives `reverse_charge` for services; everyone else gives `outside_scope`. VAT is computed per rate bucket by `VatMath`. A non-CZK VAT document always shows VAT per bucket in CZK.
- D10. **Frozen parties.** Contact and Issuing Entity particulars are snapshotted at issue. Later edits to the Contact or the Workspace never change an issued document unless an `edit` sends `refreshParties: true`.
- D11. **FX.** A non-CZK document takes the CNB fixing valid on `taxableSupplyOn` (the latest fixing published on or before it, §4(8)). An edit that changes the tax point re-fixes the rate, and the audit entry records old and new rate. A manual rate (`fx.manual`, decision Q4) replaces the fixing: it is accepted only for non-CZK documents (`Invalid{fx.manual_not_allowed_for_czk}`) with `rate > 0` and `quantity >= 1` (`Invalid{fx.manual_rate_invalid}`), it survives tax point changes, `fx: null` in a patch returns to the CNB fixing, and every change is audited with old and new rate and source. `VatMath` uses whichever rate the view shows. A Credit Note takes no fixing of its own: it carries the original document's rate (rule D7).
- D12. **Payment QR.** `paymentQr` is SPAYD when the currency is CZK and the bank account has an IBAN, EPC when the currency is EUR and the account has an IBAN, otherwise `null`. Credit Notes and cancelled documents never carry one.
- D13. **Ordering.** `send`, `share`, `lock`, `cancel`, `correct` and `issueFinalInvoice` on a draft fail with `Conflict{illegal_transition}`. `send` may repeat; each call creates a new delivery.
- D14. **Manual reminder.** `send` with `purpose: "reminder"` needs an issued Invoice or Proforma that is not cancelled and not settled (`Conflict{illegal_transition}`, detail `reminder.document_settled`). It uses the reminder email template, ignores `reminders`, and never bumps `reminder_epoch`, so the automatic schedule is unchanged. Deliveries record their purpose.
- D15. **Dry runs.** `preview`, `previewSend`, `previewFinalInvoice` and `previewCorrection` run the policy check of the real operation and the same validation code, then roll back: no number, no delivery, no audit, no request-log row. Their results may differ from the real call if state changes in between; the real call re-validates everything, and MCP passes the revision it previewed as `expectedRevision`.
- D16. **Effective reminder policy.** When `send` with `purpose: "document"` arms reminders (and when a due date change or turning reminders back on re-arms them), core resolves the policy `Document → Contact → Workspace`: (1) `SendOptions.reminders: false` arms nothing; (2) otherwise the Contact's `reminderPolicy` applies: `disabled` arms nothing unless the send passed `reminders: true`, `custom` uses its `offsetsDays`; (3) `inherit` or absent uses the Workspace reminder policy (its enabled flag, its Proforma setting and its offsets). An explicit `reminders: true` with a Contact on `disabled` or `inherit` uses the Workspace offsets. Each `send` with `purpose: "document"` stores the Document's own choice as `documents.reminders_choice` (`"on"` for `reminders: true`, `"off"` for `false`, `"inherit"` when absent); a due date change carries no `SendOptions`, so its re-arm resolves again from the stored choice and the current Contact and Workspace policies, which keeps an explicit `on` while an inherited choice follows a Contact that has since switched to `disabled`. Arming stores the outcome on the document (`documents.reminders_on`) and puts the resolved offsets in the `PaymentReminders` payload (section 7.2). Pending steps re-check `reminders_on` both when enqueuing and in the delivery claim, so turning reminders off on the document stops them, including a reminder already queued but not yet claimed; later changes to the Contact's `reminderPolicy` or the Workspace schedule apply from the next arm or re-arm. `SendPreview.armsReminders` reports this resolution, and the send dialog uses it as the default of its reminders toggle.

Idempotency: `createDraft`, `issue`, `cancel`, `correct`, `issueFinalInvoice` and `send` take `requestKey` (rule C3). An agent that retries `issue` never gets a second numbered Invoice. Without a `requestKey`, issuing a document that is already issued fails with `Conflict{illegal_transition}`, so a blind retry from a draft still cannot allocate a second number.
Audit: everything on issued documents (issue, edit with diff, number override, lock, unlock with reason, cancel, correct, final invoice, send, share create and revoke). Drafts audit only create, discard and issue.

### 4.5 `Payments`

```ts
export class Payments extends Context.Service<Payments, {
  /** Default amount = outstanding; default date = today. Applies statutory follow-ups. */
  readonly record: (input: {
    readonly target: { readonly document: DocumentId } | { readonly expense: ExpenseId }
    readonly amount?: Money
    readonly paidOn?: IsoDate
    readonly method?: "bank_transfer" | "cash" | "card" | "other"
    readonly note?: string
  }, opts?: RequestOptions) => Effect.Effect<{
    readonly payment: PaymentView
    readonly settlement: "partially_paid" | "paid" | "overpaid"
    readonly issued: ReadonlyArray<DocumentView> // the auto-issued Payment Tax Document, if any
  }, CoreError, CurrentCaller>
  readonly remove: (id: PaymentId, reason: string) =>
    Effect.Effect<void, NotFound | Conflict | Forbidden, CurrentCaller>
  readonly listFor: (target: { readonly document: DocumentId } | { readonly expense: ExpenseId }) =>
    Effect.Effect<ReadonlyArray<PaymentView>, NotFound | Forbidden, CurrentCaller>
}>()("kvitbit/Payments") {}
```

Invariants:

- P1. A Payment's currency equals its target's currency (`Invalid{payment.currency_mismatch}`). Settlement is derived from payments and Credit Notes at read time, never stored as authoritative state.
- P2. **Automatic Payment Tax Document.** When the Issuing Entity is a `vat_payer` and the target is an issued Proforma, `record` issues one Payment Tax Document for the payment in the same transaction. Its tax point is `paidOn`, its number comes from the Payment Tax Document series, its VAT is split across the Proforma's rate buckets in proportion to their gross amounts (top-down math), and non-CZK amounts use the CNB fixing for `paidOn`. When the Workspace setting `autoSendPaymentTaxDocument` is on, the same transaction queues a delivery (section 7). `non_vat_payer` and `identified_person` get no Payment Tax Document.
- P3. `remove` fails with `Conflict{illegal_transition}` (detail `payment.has_tax_document`) while a Payment Tax Document issued from the payment is not fully credited, or while a Final Invoice deducts it. The user corrects the PTD with `Documents.correct` or `Documents.cancel` first. A removed payment is soft-deleted, so a repeated `remove` succeeds.
- P2a. `record` on a Proforma locks the Proforma row before anything else (the same lock as rule D8), then the PTD series counter (rule S4).
- P4. Payments work on locked documents.
- P5. Recording a payment does not cancel reminder workflows directly; each reminder re-checks settlement before it sends.

Idempotency: `record` takes `requestKey`. A bank import later uses the bank transaction id as the key.
Audit: `record` and `remove` (reason required), on the target's subject.

### 4.6 `PublicShareLinks`

Serves both sides of a Public Share Link: Members manage it, visitors open it.

```ts
export class PublicShareLinks extends Context.Service<PublicShareLinks, {
  // Member caller
  /** Idempotent: returns the active link if one exists. Issued documents only. */
  readonly create: (id: DocumentId) => Effect.Effect<{ readonly url: string }, NotFound | Conflict | Forbidden, CurrentCaller>
  readonly revoke: (id: DocumentId) => Effect.Effect<void, NotFound | Forbidden, CurrentCaller>
  /** View and download events for the document's links, newest first (share.read). */
  readonly views: (id: DocumentId, page?: PageRequest) =>
    Effect.Effect<Page<ShareViewEvent>, Invalid | NotFound | Forbidden, CurrentCaller>
  // ShareLinkVisitor caller (token comes from the caller)
  /** Records a view (deduplicated per visitor per hour) and returns the recipient view. */
  readonly open: Effect.Effect<SharedDocumentView, NotFound, CurrentCaller>
  /** Records a download event. */
  readonly pdf: (opts?: { readonly language?: Locale }) => Effect.Effect<FileDownload, NotFound | Unavailable, CurrentCaller>
  /** The issuing Workspace's logo for the page header; NotFound when it has none. */
  readonly logo: Effect.Effect<FileDownload, NotFound | Unavailable, CurrentCaller>
}>()("kvitbit/PublicShareLinks") {}

export const ShareViewEvent = Schema.Struct({
  id: ShareViewId,
  kind: Schema.Literals(["view", "download"]),
  at: Schema.String,                                               // ISO instant
  device: Schema.Literals(["desktop", "mobile", "tablet", "unknown"]), // coarse, from the user agent
})
// SharedDocumentView adds viewerIsIssuer: boolean (true when signedInUser is a Member of the issuing Workspace).
```

Invariants: tokens are derived from the link id with a versioned HMAC key (section 1) and looked up by their SHA-256 hash, so `create` can return the same URL again without storing the token. One active link per document; `revoke` then `create` makes a new link id and a new token. Unknown, revoked, and expired tokens all return `NotFound`, so the page cannot probe tokens. `SharedDocumentView` is a narrowed projection: issuer branding, parties, lines, totals, statutory notes, `paymentQr`, settlement and PDF link; no audit history, internal notes or deliveries. View and download events go to a separate table, not the audit log; the first view sets `viewedAt`. They store the `VisitorHash`, time and coarse device only, never the IP or user agent. When `signedInUser` is a Member of the issuing Workspace, `open` and `pdf` record nothing and the view carries `viewerIsIssuer: true`. `DocumentView.share.views` counts view events. A cancelled or credited document stays viewable and shows its state.
Audit: `create` and `revoke`.

### 4.7 `Expenses`

```ts
export class Expenses extends Context.Service<Expenses, {
  /** Supplier is a Contact or an IČO (resolved through Contacts.fromIco). */
  readonly record: (input: ExpenseInput, opts?: RequestOptions) =>
    Effect.Effect<ExpenseView, Invalid | NotFound | Unavailable | Forbidden, CurrentCaller>
  readonly edit: (id: ExpenseId, patch: ExpensePatch, expectedRevision: number) =>
    Effect.Effect<ExpenseView, NotFound | Invalid | Conflict | Unavailable | Forbidden, CurrentCaller>
  readonly remove: (id: ExpenseId, expectedRevision: number) =>
    Effect.Effect<void, NotFound | Conflict | Forbidden, CurrentCaller>
  readonly attach: (id: ExpenseId, file: { readonly name: string; readonly contentType: string; readonly bytes: Stream.Stream<Uint8Array> }) =>
    Effect.Effect<AttachmentView, NotFound | Invalid | Unavailable | Forbidden, CurrentCaller>
  readonly detach: (id: ExpenseId, attachment: AttachmentId) =>
    Effect.Effect<void, NotFound | Forbidden, CurrentCaller>
  readonly attachment: (id: ExpenseId, attachment: AttachmentId) =>
    Effect.Effect<FileDownload, NotFound | Unavailable | Forbidden, CurrentCaller>
  readonly get: (id: ExpenseId) => Effect.Effect<ExpenseView, NotFound | Forbidden, CurrentCaller>
  readonly list: (q: ExpenseQuery) => Effect.Effect<Page<ExpenseSummary>, Invalid | Forbidden, CurrentCaller>
}>()("kvitbit/Expenses") {}

// Fields this spec fixes; the rest of ExpenseInput (supplier, dates, VAT breakdown, category, tags) is unchanged.
// ExpenseInput.status?: "complete" | "incomplete"   default "complete"
// ExpensePatch.status?: "complete" | "incomplete"   "complete" runs the full validation
// ExpenseView.status, ExpenseSummary.status: "complete" | "incomplete"
// ExpenseQuery.incomplete?: boolean                 true lists only incomplete Expenses; plus cursor and limit (PageRequest)
```

Invariants: an Expense saved with `status: "incomplete"` (flow 5.2, offline capture) skips every required-field and arithmetic check, so an attachment with no fields is valid; reports leave it out and the dashboard counts it. Setting `status: "complete"` runs the full validation. `Payments.record` on an incomplete Expense fails with `Invalid{expense.incomplete}`. For a complete Expense, the VAT breakdown entered for a received document must add up to its gross (`Invalid`); the core checks the arithmetic with `VatMath` but never recalculates the supplier's figures. Non-CZK expenses store the CNB fixing for the tax point so reports have CZK amounts. Attachments are streamed to `BlobStorage` under a staged key and committed with the database row; staged blobs with no row are collected after 24 hours. Size and content type limits are checked while streaming (`Invalid{attachment.too_large | attachment.type_rejected}`). An Expense with payments cannot be removed until the payments are removed.
Audit: `record`, `edit`, `remove`, `attach`, `detach`.

### 4.8 `Templates`

Owns Invoice Templates and their Recurring Schedules.

```ts
export class Templates extends Context.Service<Templates, {
  readonly save: (input: TemplateInput & { readonly id?: TemplateId; readonly expectedRevision?: number }, opts?: RequestOptions) =>
    Effect.Effect<TemplateView, Invalid | NotFound | Conflict | Forbidden, CurrentCaller>
  readonly archive: (id: TemplateId) => Effect.Effect<void, NotFound | Forbidden, CurrentCaller>
  /** Attach, change, or detach (null) the Recurring Schedule. Durable once this returns. */
  readonly schedule: (template: TemplateId, schedule: null | {
    readonly every: { readonly weeks: number } | { readonly months: number } | { readonly years: number }
    readonly startOn: IsoDate
    readonly endOn?: IsoDate
    readonly issueAs: "invoice" | "proforma"
    readonly autoSend: boolean
  }, expectedRevision: number) => Effect.Effect<TemplateView, Invalid | NotFound | Conflict | Forbidden, CurrentCaller>
  /** Clears a failure pause; the next sweep issues due occurrences. */
  readonly resume: (template: TemplateId) => Effect.Effect<TemplateView, NotFound | Conflict | Forbidden, CurrentCaller>
  /** Manual use: delegates to Documents.createDraft or Documents.issue with template values as defaults. */
  readonly use: (template: TemplateId, input?: { readonly as?: "draft" | "issued"; readonly patch?: DocumentPatch }, opts?: RequestOptions) =>
    Effect.Effect<DocumentView, CoreError, CurrentCaller>
  readonly get: (id: TemplateId) => Effect.Effect<TemplateView, NotFound | Forbidden, CurrentCaller>
  readonly list: Effect.Effect<ReadonlyArray<TemplateView>, Forbidden, CurrentCaller>
  /** Run history of the template's Recurring Schedule, newest occurrence first. */
  readonly runs: (template: TemplateId, page?: PageRequest) =>
    Effect.Effect<Page<RecurringRunView>, Invalid | NotFound | Forbidden, CurrentCaller>
}>()("kvitbit/Templates") {}

// TemplateInput = DocumentInput without issuedOn/taxableSupplyOn plus name and a relative due (inDays).
// The schedule argument of `schedule` is a ScheduleRule (section 5.6) plus issueAs and autoSend.

export const RecurringRunView = Schema.Struct({
  occurrence: IsoDate,
  outcome: Schema.Literals(["issued", "failed", "skipped_missed"]), // skipped_missed: paused by the catch-up cap
  at: Schema.String,                                                // when the run finished
  document: Schema.NullOr(Schema.Struct({ id: DocumentId, number: Schema.String })),
  delivery: Schema.NullOr(Schema.Struct({ id: DeliveryId, status: Schema.Literals(["queued", "sending", "sent", "failed", "skipped"]) })),
  failure: Schema.NullOr(IssueCode),                                // why the run paused the schedule
})
```

Invariants: occurrences are calendar dates in Europe/Prague; a monthly schedule started on the 31st issues on the last day of shorter months. Each `(scheduleId, occurrence)` produces at most one document, across crashes, retries and concurrent sweeps (unique constraint plus workflow key, section 7). After downtime, occurrences up to 7 days late are issued in order with their own occurrence date; an occurrence more than 7 days late pauses the schedule with `schedule.missed_occurrences`, and `resume` issues the missed ones (catch-up cap). A failed occurrence pauses the schedule and records the reason on `TemplateView.schedule.pausedReason`; nothing issues until `resume`. Changing a schedule affects future occurrences only. Occurrence dates come from `Schedules.nextOccurrences` (section 5.6), the same function ui-port uses for the "next three dates" preview. `runs` reads one row per processed occurrence from the schedule run table that `RecurringIssuance` writes (outcome, document, failure code); delivery status is joined from `deliveries`.
Audit: `save`, `archive`, `schedule`, `resume`.

### 4.9 `Reports`

```ts
export class Reports extends Context.Service<Reports, {
  readonly run: (q: ReportQuery) => Effect.Effect<ReportView, Invalid | Forbidden, CurrentCaller>
  readonly export: (q: ReportQuery, format: "csv" | "pdf") =>
    Effect.Effect<FileDownload, Invalid | Forbidden, CurrentCaller>
  /** Dashboard tiles and a 12-month cashflow series ending at period.to (report.run). */
  readonly dashboard: (period: { readonly from: IsoDate; readonly to: IsoDate }) =>
    Effect.Effect<DashboardView, Invalid | Forbidden, CurrentCaller>
  /** CNB fixing for a currency on a date, through the fx_fixings cache (report.run). */
  readonly fxRate: (q: { readonly currency: CurrencyCode; readonly on: IsoDate }) =>
    Effect.Effect<FxRateView, Invalid | Unavailable | Forbidden, CurrentCaller>

  // Full data export (report.export): ZIP of document PDFs, Expense attachments and CSVs of every table.
  /** Starts the DataExport workflow. Returns the running job when one is already running. */
  readonly startExport: (opts?: RequestOptions) => Effect.Effect<ExportJobView, Forbidden, CurrentCaller>
  readonly getExport: (id: ExportId) => Effect.Effect<ExportJobView, NotFound | Forbidden, CurrentCaller>
  /** The ZIP. Conflict{illegal_transition, export.not_ready} while running or failed; NotFound after expiry. */
  readonly exportFile: (id: ExportId) =>
    Effect.Effect<FileDownload, NotFound | Conflict | Unavailable | Forbidden, CurrentCaller>
}>()("kvitbit/Reports") {}

export const ReportKind = Schema.Literals(["revenue", "vat_summary", "receivables", "expenses", "profit", "cashflow"])
export interface ReportQuery {
  readonly report: typeof ReportKind.Type
  readonly period: { readonly from: IsoDate; readonly to: IsoDate }
  readonly groupBy?: "month" | "contact" | "currency" | "category"
}

export const CashflowPoint = Schema.Struct({ month: Schema.String /* YYYY-MM */, in: Money, out: Money, net: Money })
export const DashboardView = Schema.Struct({
  period: Schema.Struct({ from: IsoDate, to: IsoDate }),
  revenue: Money,                                          // CZK, issued in period, as the revenue report
  unpaid: Money,                                           // CZK, open receivables today
  overdue: Schema.Struct({ total: Money, count: Schema.Int }),
  expenses: Money,                                         // CZK, complete Expenses in period
  incompleteExpenses: Schema.Int,
  cashflow: Schema.Array(CashflowPoint),                   // 12 months, oldest first
})
export const FxRateView = Schema.Struct({
  currency: CurrencyCode, rate: Schema.BigDecimal, quantity: Schema.Int, fixingDate: IsoDate, source: Schema.Literal("cnb"),
})
export const ExportJobView = Schema.Struct({
  id: ExportId, status: Schema.Literals(["running", "ready", "failed"]),
  createdAt: Schema.String, readyAt: Schema.NullOr(Schema.String), expiresAt: Schema.NullOr(Schema.String), // ready for 7 days
  sizeBytes: Schema.NullOr(Schema.Int),
})
```

`report` is a closed union; new reports add members rather than free-form query parameters. `cashflow` is Payments in versus Payments out per month by payment date, with a net line (flow 9.4). The dashboard is a separate method, not a `ReportKind`, because its shape is a set of tiles rather than rows; its figures use the same queries as `revenue`, `receivables`, `expenses` and `cashflow`. `fxRate` for a currency the fixing lacks is `Invalid{fx.rate_missing}`. Export jobs are kept 7 days after `readyAt`, then `Housekeeping` deletes the row and the blob; one job runs per Workspace at a time. Every report includes CZK totals computed from the fixings stored on each document and expense, never from today's rate. `vat_summary` groups by tax point and rate bucket and includes Credit Notes and Payment Tax Documents, with Final Invoice deductions netted. Exports stream rows. Reports are read-only and not audited, except `startExport`, which writes one audit entry on subject `Export` (a full data export is a disclosure worth recording).

### 4.10 Audit log

```ts
export interface AuditEntry {
  readonly id: AuditEntryId
  readonly at: string // ISO instant
  readonly actor:
    | { readonly _tag: "Member"; readonly userId: UserId; readonly channel: Channel; readonly client: ClientRef | null } // "X via <client.name>"
    | { readonly _tag: "System"; readonly job: SystemCaller["job"] }
  readonly subject: { readonly entity: typeof EntityKind.Type; readonly id: string }
  readonly action: string          // e.g. "document.edit", "document.unlock", "payment.record"
  readonly revision: number | null // subject revision after the change
  readonly changes: ReadonlyArray<{ readonly path: string; readonly before: unknown; readonly after: unknown }>
  readonly reason: string | null
}
```

Rules: entries are written in the same transaction as the change they describe (rule C1). The `audit_entries` table is insert-only: the application role has no `UPDATE` or `DELETE` grant on it. `history` returns entries for one subject in time order. Account and visitor callers never produce entries; share views go to their own table.

---

## 5. Pure engines

Pure functions with no services. They live in `@kvitbit/core/engines` (except `PdfRenderer`), are tested with tables of cases, and are called only by the modules above (and by ui-port for live totals and schedule previews). They are not ports: there is one implementation each.

### 5.1 `VatMath`

```ts
export interface VatInputLine {
  readonly quantity: BigDecimal.BigDecimal
  readonly unitPrice: BigDecimal.BigDecimal
  readonly treatment: VatTreatment
}
export interface VatBucket {
  readonly treatment: VatTreatment
  readonly ratePercent: BigDecimal.BigDecimal // 0 for non-rated treatments
  readonly base: BigDecimal.BigDecimal
  readonly vat: BigDecimal.BigDecimal
  readonly gross: BigDecimal.BigDecimal
  readonly vatCzk: BigDecimal.BigDecimal | null // null for CZK documents
}
export interface VatBreakdown {
  readonly buckets: ReadonlyArray<VatBucket>
  readonly net: Money
  readonly vat: Money
  readonly roundingAdjustment: Money // whole-unit payment rounding, outside the tax base (§36(5))
  readonly gross: Money              // amount to pay
  readonly vatCzk: Money | null
}

export const VatMath: {
  /** Rate in force on the tax point; fails when the treatment is unknown for that date. */
  readonly rateFor: (treatment: VatTreatment, taxPoint: IsoDate) => BigDecimal.BigDecimal
  readonly calculate: (input: {
    readonly lines: ReadonlyArray<VatInputLine>
    readonly currency: CurrencyCode
    readonly taxPoint: IsoDate
    readonly pricesIncludeVat: boolean
    readonly fx: null | { readonly rate: BigDecimal.BigDecimal; readonly quantity: number }
    readonly paymentRounding: "none" | "whole_unit"
  }) => VatBreakdown
  /** Splits a received advance across a Proforma's buckets by gross share (Payment Tax Document). */
  readonly splitAdvance: (proforma: VatBreakdown, paid: BigDecimal.BigDecimal) => ReadonlyArray<VatBucket>
}
```

Rules (per-rate-bucket, Facturoid convention):

1. Line amounts keep full precision; they are rounded to 2 decimals only for display.
2. Lines are grouped into buckets by `(treatment, ratePercent)`.
3. Bottom-up (§37(a)): bucket base = round2(sum of line nets); bucket VAT = round2(base × rate / 100).
4. Top-down (§37(b), `pricesIncludeVat`): bucket gross = round2(sum of line grosses); bucket VAT = round2(gross × rate / (100 + rate)); base = gross − VAT.
5. Rounding is half away from zero.
6. CZK VAT per bucket = round2(VAT × fx.rate / fx.quantity).
7. `whole_unit` rounding applies only to the amount to pay and is reported as `roundingAdjustment`, never added to a bucket base.
8. Rates come from an internal table with effective dates (21 and 12 from 2024-01-01). A tax point before the table's first entry is a defect, not a user error.

The law does not prescribe line versus bucket rounding (`czech-invoicing-specs.md` §2); bucket rounding is a product choice and lives only here.

### 5.2 `Numbering`

```ts
export interface NumberPattern { readonly tokens: ReadonlyArray<PatternToken>; readonly reset: "yearly" | "monthly" | "never" }

export const Numbering: {
  /** Tokens: YYYY, YY, MM, a run of N (zero-padded counter of that width), literal text. Max 20 chars rendered. */
  readonly parsePattern: (pattern: string) => Either.Either<NumberPattern, Invalid>
  /** Counter partition for a date: "2026", "2026-11", or "all". */
  readonly periodKey: (pattern: NumberPattern, issuedOn: IsoDate) => string
  readonly format: (pattern: NumberPattern, issuedOn: IsoDate, counter: number) => string
  /** Digits of the number, last 10, for the variable symbol; null when no digits. */
  readonly variableSymbol: (number: string) => string | null
}
```

A pattern must contain exactly one counter run. `reset` follows the finest date token present (MM gives monthly, YYYY or YY gives yearly, none gives never). Allocation itself is not pure; it lives in `Documents` (section 8).

### 5.3 `PaymentQr`

```ts
export const PaymentQr: {
  /** Czech QR Platba, CBA standard 1.2, header SPD*1.0*. CZK only. */
  readonly spayd: (input: {
    readonly iban: string; readonly bic?: string
    readonly amount: BigDecimal.BigDecimal          // AM: max 9,999,999.99
    readonly variableSymbol?: string               // X-VS: max 10 digits
    readonly constantSymbol?: string               // X-KS
    readonly dueOn?: IsoDate                       // DT: YYYYMMDD
    readonly recipientName?: string                // RN: max 35 chars
    readonly message?: string                      // MSG: max 60 chars
  }) => Either.Either<string, Invalid>
  /** EPC QR (EPC069-12, version 002, UTF-8, SCT). EUR only. */
  readonly epc: (input: {
    readonly iban: string; readonly bic?: string   // BIC optional in version 002 within the EEA
    readonly beneficiaryName: string               // max 70 chars
    readonly amount: BigDecimal.BigDecimal         // EUR 0.01 to 999,999,999.99
    readonly remittance: { readonly reference: string } | { readonly text: string } // ≤35 structured or ≤140 text
  }) => Either.Either<string, Invalid>
  /** Picks the format by currency; null when no QR applies (rule D12). */
  readonly forDocument: (doc: QrSource) => Either.Either<null | { readonly format: "spayd" | "epc"; readonly payload: string }, Invalid>
  /** SVG for the PDF and share page; error correction M (Deskohub packages/qr-code). */
  readonly toSvg: (payload: string) => string
}
```

Field limits are validated before encoding, values are uppercased and `*` is escaped as `%2A` in SPAYD. Overlong optional text (message, recipient name) is truncated at a word boundary rather than rejected; an invalid IBAN or amount is `Invalid{qr.*}`. EPC limits above follow EPC069-12; confirm against the current EPC guideline during implementation.

### 5.4 `StatutoryText`

```ts
export interface StatutoryNote { readonly code: StatutoryCode; readonly text: string }

export const StatutoryText: {
  readonly title: (input: { readonly kind: DocumentKind; readonly regime: TaxRegime; readonly taxDocument: boolean; readonly language: Locale }) => string
  readonly notes: (input: {
    readonly kind: DocumentKind
    readonly regime: TaxRegime
    readonly treatments: ReadonlySet<VatTreatment>
    readonly issuerRegisterEntry: string | null // §435 commercial register line
    readonly language: Locale
  }) => ReadonlyArray<StatutoryNote>
}
```

Examples: "Faktura – daňový doklad" / "Invoice – tax document"; "Zálohová faktura. Nejedná se o daňový doklad." / "Proforma invoice. This is not a tax document."; "Daň odvede zákazník." / "Reverse charge"; "Dodání zboží do jiného členského státu osvobozené od daně podle §64 zákona o DPH." / "Exempt intra-Community supply, Article 138 of Directive 2006/112/EC"; "Nejsem plátce DPH." / "Not a VAT payer."; "Opravný daňový doklad" / "Credit note". Texts are fixed data; the Czech wording for reverse charge is the exact §29(2)(c) text. All wording is reviewed against `czech-invoicing-specs.md` §1 during implementation.

### 5.5 `PdfRenderer`

```ts
// @kvitbit/core (server only)
export const PdfRenderer: {
  readonly render: (model: DocumentRenderModel, template: PdfTemplate, language: Locale) => Effect.Effect<Uint8Array>
}
// DocumentRenderModel = DocumentView facts + StatutoryText output + PaymentQr SVG
//   + WorkspaceBranding (template default, accent colour, footer text, logo and stamp bytes).
// PdfTemplate = "classic" (Classic Czech, screen 23) | "modern_minimal" (Modern Minimal, screen 24).
```

A function from render model to bytes with `@react-pdf/renderer` (Deskohub's presentation-model pattern). Renderer failures are defects. `Documents.pdf` and `DocumentDelivery` cache output in `BlobStorage` under `pdf/{workspaceId}/{documentId}/{revision}/{workspaceRevision}/{template}/{language}.pdf`, so a new document revision or a branding change never reuses an old PDF. Issued documents render with current branding; their fiscal content is frozen by rule D10, their look is not. `Workspaces.previewBranding` renders a fixed sample model and is never cached. Tests assert on the render model and smoke-test the bytes.

### 5.6 `Schedules`

```ts
// @kvitbit/core/engines
export const ScheduleRule = Schema.Struct({
  every: Schema.Union([
    Schema.Struct({ weeks: Schema.Int }), Schema.Struct({ months: Schema.Int }), Schema.Struct({ years: Schema.Int }),
  ]),
  startOn: IsoDate,
  endOn: Schema.optional(IsoDate),
})

export const Schedules: {
  /** Up to n occurrences on or after `from`, in order; fewer when endOn comes first. */
  readonly nextOccurrences: (rule: typeof ScheduleRule.Type, from: IsoDate, n: number) => ReadonlyArray<IsoDate>
  readonly validate: (rule: typeof ScheduleRule.Type) => Either.Either<typeof ScheduleRule.Type, Invalid> // schedule.cadence_invalid
}
```

Occurrence k is `startOn + k × every` on the Prague calendar, computed from `startOn` each time rather than from the previous occurrence, so a monthly rule started on the 31st gives 31 Jan, 28 Feb, 31 Mar. `RecurringSweep`, `RecurringIssuance` ("advance") and ui-port's schedule preview (flow 4.3) all call this function, so the preview cannot disagree with what the sweep issues.

---

## 6. Driven ports

A port exists only where two adapters are justified (two production adapters, or production plus a test fake). Port errors are internal `Data.TaggedError`s; modules map them to `Unavailable` (section 3).

```ts
// @kvitbit/core/ports
import { Context, Data, Effect, Stream } from "effect"

/** Czech business register. Core validates the IČO checksum and caches results. */
export class CompanyRegistry extends Context.Service<CompanyRegistry, {
  readonly lookup: (ico: string) => Effect.Effect<RegistryRecord | null, RegistryUnavailable>
}>()("kvitbit/CompanyRegistry") {}
// RegistryRecord: name, address, dic | null, legalForm, registerEntry | null.
// It carries no VAT-payer flag: ARES dic presence does not prove payer status.
// Adapters: AresV3 (shape from Deskohub packages/ares), FakeCompanyRegistry.

/** CNB daily fixing. Returns the latest fixing published on or before `date`. */
export class ExchangeRates extends Context.Service<ExchangeRates, {
  readonly fixing: (date: IsoDate) => Effect.Effect<CnbFixing, RatesUnavailable>
}>()("kvitbit/ExchangeRates") {}
// CnbFixing = { fixingDate, sequence, rates: ReadonlyArray<{ code; quantity /* množství */; rate: BigDecimal }> }
// Core caches fixings in fx_fixings; a currency missing from the fixing is Invalid{fx.rate_missing}.
// Adapters: CnbDailyTxt (denni_kurz.txt?date=DD.MM.YYYY), FixtureRates.

/** Transactional email. The idempotency key is the delivery id. */
export class EmailSender extends Context.Service<EmailSender, {
  readonly send: (message: OutboundEmail, opts: { readonly idempotencyKey: string }) =>
    Effect.Effect<{ readonly provider: string; readonly providerMessageId: string }, EmailRejected | EmailNotAccepted | EmailOutcomeUnknown>
}>()("kvitbit/EmailSender") {}
// OutboundEmail = { to, cc?, replyTo, subject, html, text, attachments: { filename, contentType, bytes }[], tags }
// EmailRejected       permanent (bad address, policy); never retried.
// EmailNotAccepted    the provider certainly did not take the message (connect failure, 429, 5xx
//                     before acceptance); retrying or failing over is safe.
// EmailOutcomeUnknown timeout or dropped connection after the request was sent; retry the SAME
//                     provider with the same key only.
// FallbackEmailSender(primary, secondary) fails over only on EmailNotAccepted, never on
// EmailOutcomeUnknown, so an accepted Resend message is not sent again over SMTP.
// AllowlistEmailSender(inner, allow) delivers only to allowlisted domains and captures the rest;
// every non-production environment (Neon preview branches included) must use it or Capture.
// Adapters: ResendEmailSender, SmtpEmailSender, FallbackEmailSender, AllowlistEmailSender,
// CaptureEmailSender (tests), ConsoleEmailSender (dev). Adapted from Deskohub email + email-resend.

/** Attachments and rendered PDFs. */
export class BlobStorage extends Context.Service<BlobStorage, {
  readonly put: (key: BlobKey, body: Stream.Stream<Uint8Array>, meta: { readonly contentType: string; readonly maxBytes: number }) =>
    Effect.Effect<{ readonly key: BlobKey; readonly bytes: number; readonly sha256: string }, BlobTooLarge | BlobUnavailable>
  readonly get: (key: BlobKey) => Effect.Effect<Stream.Stream<Uint8Array>, BlobMissing | BlobUnavailable>
  readonly delete: (key: BlobKey) => Effect.Effect<void, BlobUnavailable> // idempotent
}>()("kvitbit/BlobStorage") {}
// Keys are core-chosen and Workspace-prefixed. Adapters: GcsBlobStorage (hosted),
// S3CompatibleBlobStorage (S3, MinIO), LocalDiskBlobStorage (Docker/Nix), MemoryBlobStorage (tests).
```

Edge-only port, owned by apps/server. Core never requires it.

```ts
// apps/server/src/edge/BotProtection.ts (ADR 0002)
export type BotScope = "sign_up" | "sign_in" | "magic_link" | "password_reset" | "invitation_accept"

export class BotProtection extends Context.Service<BotProtection, {
  readonly issue: (scope: BotScope) => Effect.Effect<BotChallenge, BotProtectionUnavailable>
  /** Checks HMAC, proof of work and expiry, then consumes the challenge once (atomic Postgres insert). */
  readonly verify: (scope: BotScope, payload: string) =>
    Effect.Effect<void, InvalidBotProof | BotProtectionUnavailable>
}>()("kvitbit/edge/BotProtection") {}
// Adapters: AltchaBotProtection (altcha-lib, Postgres single-use store), NoopBotProtection (self-host opt-out, tests).
// The route picks the scope; it is never read from client input. verify runs before any side effect.
```

Not ports: Postgres (`SqlClient` used directly; tests swap PGlite or a scratch database), `WorkflowEngine` and `Sharding` (Effect's own seams, chosen at the composition root), `Clock` and `Random` (Effect services; `TestClock` in tests), and auth (Better Auth stays in apps/server and hands core only a `UserId`).

---

## 7. Durable jobs: Workflows and ClusterCrons

Workflows and crons are internal to `@kvitbit/core`; callers never import them. Modules start them after their transaction commits.

```ts
import * as Workflow from "effect/workflow/Workflow"
import * as Activity from "effect/workflow/Activity"
import * as DurableClock from "effect/workflow/DurableClock"
import * as ClusterCron from "effect/cluster/ClusterCron"
import * as ClusterWorkflowEngine from "effect/cluster/ClusterWorkflowEngine"
```

### 7.1 Rules that apply to every workflow

- J1. **Domain rows are the outbox.** The module transaction writes an intent row (`deliveries.status = 'queued'`, `invitations.status = 'pending'`, `exports.status = 'running'`, a due schedule) together with the domain change. After commit the module calls `Workflow.execute(..., { discard: true })` with a deterministic idempotency key and stamps `workflow_started_at`. If the process dies between commit and start, `OutboxReconcile` starts it later. Starting twice is harmless because the key attaches the second start to the first execution. Workflow starts are not made part of the domain transaction: `SqlMessageStorage` writes through its own path, so commit-then-start with reconcile is the portable option.
- J1a. **Reconcile reads intent state, not workflow history.** `OutboxReconcile` selects intent rows that are not terminal (`queued`, `sending`, `pending`) and older than a threshold, whatever `workflow_started_at` says, and re-executes them with the same key. If that execution already finished, the returned result is written back to the intent row. Workflow history may be pruned; intent rows are the record. For deliveries the threshold is measured from the row's last change (`updated_at`), which `claim` and every recorded dispatch attempt advance, so a job still working is not selected until it has been silent for the threshold. Core implements this half as `reconcileStaleDeliveries(olderThanMillis)` (modules/documents/deliveries/steps.ts) over `DeliveriesRepo.findStaleQueuedOrSending`: it calls `DeliveryJobs.start` with the delivery id for each row, and the restarted job runs `deliver`, so a queued row is re-checked (J3) and a `sending` row is dispatched again with the same provider key (J2). A start that still overlaps a live dispatch attaches to it by key; if it does not, the overlap can only send twice, which at-least-once delivery accepts. A start that finds a finished execution while the row is still `queued` or `sending` (the workflow failed after `claim` or after the provider call) must run `deliver` again, not only return the stored exit: the `DeliveryJobs` binding in apps/server owns this, for example by starting a new execution. The provider key stays the delivery id either way.
- J2. **Every Activity that writes or sends is idempotent by key.** Effect memoizes completed Activity results, but a crash after the side effect and before the result is persisted replays the Activity. Writes therefore use the workflow key as a `requestKey` or a unique constraint, and email uses the delivery id as the provider idempotency key.
- J3. **Content is snapshotted, eligibility is re-checked.** What a delivery sends (recipients, language, subject, and the `DocumentRenderModel` at the revision current when it was queued) is frozen on the `deliveries` row, so a retry after an edit sends the same content. Whether to send at all (document cancelled, reminder no longer due) is re-checked against current state just before dispatch.
- J3a. **Retention.** Intent rows (`deliveries`, `invitations`, `schedule_runs`, documents' `schedule_id, occurrence`) are kept for the life of the Workspace; `exports` rows only until 7 days after they are ready. Request-log rows live 24 hours. Cluster message and workflow history retention follows the Effect storage defaults; nothing in core depends on old history.
- J4. **No compensation in v1.** `Workflow.withCompensation` is reserved for Activities that create a reversible local reservation, and no v1 workflow has one. A numbered document is never un-issued (gapless numbering, no hard delete), and a sent email cannot be retracted. Failures instead mark the delivery `failed` or pause the schedule, both visible to users.
- J5. **Workflows run as System.** Each workflow builds its `SystemCaller` for its Workspace and job, and calls module operations through the same internal code paths, so policy, audit and invariants apply.
- J6. **Failure is data.** Expected failures end in a visible state (delivery `failed`, schedule paused). Only defects surface as workflow failures for operators.

### 7.2 Workflows

```ts
/** Email one document (initial send, reminder, or Payment Tax Document). */
export const DocumentDelivery = Workflow.make("kvitbit/DocumentDelivery", {
  payload: { workspaceId: WorkspaceId, deliveryId: DeliveryId },
  idempotencyKey: ({ deliveryId }) => deliveryId,
  success: Schema.Literals(["sent", "failed", "skipped"]),
})
// Started by: Documents.send, Documents.issue({ send }), Payments.record (PTD auto-send),
//             RecurringIssuance (autoSend), PaymentReminders (each step).
// The deliveries row (minted in the starting transaction) holds the immutable snapshot of J3:
// documentId, revision, recipients, language, purpose, subject, render model. Steps:
//   Activity "render"   PdfRenderer(snapshot.renderModel) → BlobStorage at
//                       pdf/.../{revision}/... (deterministic bytes, overwrite-safe).
//   Activity "claim"    one transaction: UPDATE deliveries SET status = 'sending'
//                       WHERE id = $1 AND status = 'queued' AND <eligible>, where eligible means
//                       the document is not cancelled; for any reminder, it is still unpaid and
//                       uncredited; and for an automatic reminder (deliveries.reminder_epoch set by
//                       PaymentReminders; null for a manual reminder, rule D14) documents.reminder_epoch
//                       still equals it and documents.reminders_on is true. No row → status "skipped".
//   Activity "dispatch" EmailSender.send(snapshot, { idempotencyKey: deliveryId }) with
//                       Activity.retry: exponential from 30 s, capped at 1 h, for 24 h total.
//                       EmailRejected or exhausted retries → status "failed".
//   Activity "record"   UPDATE deliveries SET status = 'sent' WHERE id = $1 AND status = 'sending'.
// Resend dedupes on the key. SMTP has no key, and the fallback is used only when Resend
// certainly did not accept the message, so a duplicate needs a crash inside an SMTP send.

/** Payment reminders for one issued Invoice or Proforma and one reminder epoch. */
export const PaymentReminders = Workflow.make("kvitbit/PaymentReminders", {
  payload: { workspaceId: WorkspaceId, documentId: DocumentId, epoch: Schema.Int, dueOn: IsoDate,
             offsetsDays: Schema.Array(Schema.Int) },  // effective policy offsets resolved at arm time (rule D16)
  idempotencyKey: ({ documentId, epoch }) => `${documentId}:${epoch}`,
})
// documents.reminder_epoch is a counter bumped in the same transaction as any change that
// re-arms reminders: the first send with reminders on, a due date change, or reminders turned
// back on. A key built from the due date would collide when a date changes A → B → A, because
// the execution id derives from the key (effect/workflow/Workflow.ts:345); the epoch never repeats.
// For each step i of payload.offsetsDays, the effective policy resolved Document → Contact →
// Workspace when the epoch was armed (rule D16; e.g. Contact custom [7, 21], else Workspace [3, 14]):
//   DurableClock.sleep({ name: `step-${i}`, duration: untilPrague(dueOn + offset_i) })
//   Activity "enqueue-${i}": one transaction that inserts the delivery
//     (id = uuidv5(`${documentId}:${epoch}:${i}`), reminder_epoch = payload.epoch, snapshot as in J3) only if
//     reminder_epoch = payload.epoch AND the document is unpaid, uncredited, not cancelled
//     and documents.reminders_on (set from the effective policy at arm time, rule D16);
//     ON CONFLICT DO NOTHING. No row inserted and none existing → end.
//   Then execute DocumentDelivery with that id (its "claim" re-checks eligibility).

/** One occurrence of a Recurring Schedule. */
export const RecurringIssuance = Workflow.make("kvitbit/RecurringIssuance", {
  payload: { workspaceId: WorkspaceId, scheduleId: ScheduleId, occurrence: IsoDate },
  idempotencyKey: ({ scheduleId, occurrence }) => `${scheduleId}:${occurrence}`,
  success: DocumentId,
  error: RecurringIssuanceFailed, // carries an IssueCode; the schedule is already paused
})
// Started by: RecurringSweep. Steps:
//   Activity "issue": Documents issue from the template as System, requestKey
//                     `recurring:${scheduleId}:${occurrence}`; documents(schedule_id, occurrence)
//                     is UNIQUE, so a replay returns the existing document.
//                     Invalid / NotFound / Forbidden → Activity "pause" records the reason, then fail.
//   Activity "advance": UPDATE schedules SET next_occurrence = $next
//                       WHERE id = $1 AND next_occurrence = $occurrence (compare and set),
//                       $next = Schedules.nextOccurrences(rule, occurrence + 1 day, 1).
//                       Same transaction: upsert schedule_runs(schedule_id, occurrence) with
//                       outcome "issued" and the document id ("pause" writes outcome "failed" and
//                       the IssueCode). Templates.runs reads this table.
//   if autoSend: Activity "enqueue-delivery" (deterministic delivery id) → DocumentDelivery.

/** Invitation email and expiry. One execution per send epoch (invite = 0, each resend + 1). */
export const MemberInvitation = Workflow.make("kvitbit/MemberInvitation", {
  payload: { workspaceId: WorkspaceId, invitationId: InvitationId, epoch: Schema.Int },
  idempotencyKey: ({ invitationId, epoch }) => `${invitationId}:${epoch}`,
})
// Activity "send" (EmailSender, key = `${invitationId}:${epoch}`); DurableClock.sleep({ name: "expiry", duration: "7 days" });
// Activity "expire": UPDATE invitations SET status = 'expired'
//                   WHERE id = $1 AND status = 'pending' AND send_epoch = $epoch.
// resendInvitation bumps send_epoch and expires_at in one transaction, so the older execution's
// "expire" step matches no row.

/** Full data export for one Workspace (flow 9.7). Runs as System with job DataExport; reads only. */
export const DataExport = Workflow.make("kvitbit/DataExport", {
  payload: { workspaceId: WorkspaceId, exportId: ExportId },
  idempotencyKey: ({ exportId }) => exportId,
  success: Schema.Literals(["ready", "failed"]),
})
// Activity "build": stream document PDFs (through the PDF cache), Expense attachments and one CSV
//                   per table into a ZIP at BlobStorage exports/{workspaceId}/{exportId}.zip
//                   (deterministic key, overwrite-safe).
// Activity "finish": UPDATE exports SET status = 'ready', ready_at, expires_at = ready_at + 7 days,
//                    size_bytes WHERE id = $1 AND status = 'running'. A failure sets 'failed'.
```

### 7.3 ClusterCrons

Crons are layers registered at the composition root. Their bodies only query and start workflows; they never change domain state themselves (except `Housekeeping`, which deletes expired rows).

```ts
export const RecurringSweep = ClusterCron.make({
  name: "kvitbit/recurring-sweep",
  cron: Cron.parseUnsafe("*/15 * * * *", "Europe/Prague"),
  execute: sweepDueSchedules,
  // For each active schedule with next_occurrence <= today (Prague): start RecurringIssuance
  // for that occurrence, or pause the schedule when it is more than 7 days late (section 4.8).
  // One occurrence per schedule per tick; catch-up happens tick by tick.
  skipIfOlderThan: Duration.hours(1),
})

export const CnbFixingWarmup = ClusterCron.make({
  name: "kvitbit/cnb-fixing",
  cron: Cron.parseUnsafe("45 14-17 * * 1-5", "Europe/Prague"), // retries hourly until 17:45
  execute: warmFixing,              // ExchangeRates.fixing(today) into fx_fixings; no-op when present
  skipIfOlderThan: Duration.hours(1),
})

export const OutboxReconcile = ClusterCron.make({
  name: "kvitbit/outbox-reconcile",
  cron: Cron.parseUnsafe("* * * * *", "UTC"),
  execute: reconcileOutbox,
  // Re-executes DocumentDelivery for deliveries in queued or sending older than 2 min,
  // MemberInvitation for pending invitations older than 2 min (current send epoch), and
  // DataExport for running exports older than 2 min, with the same keys (rule J1a).
  skipIfOlderThan: Duration.minutes(5),
})

export const Housekeeping = ClusterCron.make({
  name: "kvitbit/housekeeping",
  cron: Cron.parseUnsafe("30 3 * * *", "Europe/Prague"),
  execute: housekeeping,            // request_log > 24 h, staged blobs > 24 h, share view rollups,
                                    // export rows and ZIPs past expires_at
  skipIfOlderThan: Duration.hours(6),
})
```

Lookups never depend on `CnbFixingWarmup`: `ExchangeRates` is read through the `fx_fixings` cache, so a missed warm-up only costs one CNB request.

---

## 8. Persistence and concurrency

- S1. **Postgres is the system of record** for domain data and for Effect Cluster storage (`cluster_*` tables, `SqlMessageStorage` and `SqlRunnerStorage`). There is no repository port; each module owns its tables and SQL through `SqlClient`.
- S2. **Row locks plus revisions, no Cluster Entities in v1.** A mutation of an existing aggregate runs `SELECT … FOR UPDATE` on its row (scoped by `workspace_id`), checks `revision`, applies the change, bumps `revision`, and writes audit and request-log rows, all in one transaction at `READ COMMITTED`. Entities were rejected for v1: every edit would become a persisted cluster message with a hop from Cloud Run to a Compute Engine runner, which adds latency and Neon writes, and complicates read-your-writes and tests, while the row lock already serializes writers per document. An Entity can be introduced later behind the same module interface.
- S3. **Numbering allocation.** `issue` upserts `numbering_counters(series_id, period)` and locks it with `FOR UPDATE` in the issue transaction, formats the next number with `Numbering.format`, skips reserved numbers, inserts the reservation and the number, and increments the counter. A rollback reverts both, so allocation leaves no gap. `number_reservations(workspace_id, kind, number)` is unique and insert-only: a number stays reserved after an override moves the document to another number (rule D4), so manual renumbering can leave a visible gap but never a reuse.
- S4. **Lock order.** Lock the root document first, then dependent documents, then counters. `Payments.record` and `Documents.issueFinalInvoice` both lock the Proforma first. Deadlocks (`40P01`) and serialization failures (`40001`) are retried up to three times inside the module, then surface as `Unavailable{database}`.
- S5. **Neon connections.** Application queries use Neon's pooled endpoint (PgBouncer in transaction mode, so no session state and no named prepared statements). Only runner processes open `SqlRunnerStorage`, over the direct endpoint, because Postgres runner storage holds session advisory locks (`effect/cluster/SqlRunnerStorage`). Migrations for domain and cluster tables run at deploy with an owner role; runtime processes use the DML-only storage layers that 4.1.4 provides. Self-hosted installs use one direct pool for everything.
- S6. **Topology.** Hosted Compute Engine runners execute workflows and crons through `NodeClusterHttp`. Cloud Run API instances are clients only: `NodeClusterHttp` with `storage: "byo"`, `SqlMessageStorage` on the pooled endpoint, and in-memory `RunnerStorage`; they only start workflows with `discard: true`. Runners pick those messages up on their storage poll, so a start can wait up to the configured poll interval (10 s by default). Nothing user-facing waits on a workflow, so this latency is accepted pending a hosted proof. Self-hosted: one process with `SingleRunner.layer({ runnerStorage: "sql" })`. Module code is identical in all three.
- S7. **Tenancy.** Every domain table carries `workspace_id`, every query filters on the caller's Workspace, and composite foreign keys include `workspace_id` so a row cannot reference another Workspace's row.

---

## 9. Feeding HttpApi (#19) and ui-port (#20)

### 9.1 HttpApi contract

A separate package, `packages/api-contract`, defines the `HttpApi` with groups that use only `@kvitbit/core/contract` schemas plus edge-owned views. apps/server implements it with handlers that each call one module method. The server owns transport concerns only:

| Transport | Core |
|---|---|
| `Idempotency-Key` header | `RequestOptions.requestKey` |
| `Idempotent-Replayed` response header | `RequestOutcome.replayed` (section 2.1) |
| `If-Match: "<revision>"` / `ETag` | `expectedRevision` / `view.revision`. `If-Match` is required on revisioned writes (428 when missing), and the server maps `Conflict{revision_changed}` to `412 Precondition Failed` (RFC 9110 §13.1.1). 412 and 428 are HTTP-edge errors, not core errors. |
| Auth middleware (session, bearer, API Key, OAuth) | provides `CurrentCaller` (section 2.2), with `client` for API Keys and MCP |
| Error status | the `HttpApiSchema.status` on each error class |
| `Accept-Language` | `MemberCaller.locale` (the account preference wins) |

Route names, the full endpoint list and the edge-owned endpoints (API Keys, MCP grants, account preferences, themes) are defined in `http-mcp-contracts.md` section 3.5 under the `/api/v1` prefix; this spec does not repeat them. Examples: `POST {ws}/documents/issue` and `POST {ws}/documents/{id}/issue` for `Documents.issue`, `POST .../lock` and `POST .../unlock`, `GET /api/v1/share/{token}` for `PublicShareLinks.open`. The `{ws}` path segment feeds `Workspaces.enter`; it never reaches a domain method.

MCP tools call the same module methods with `channel: "mcp"`, `scopes` from the verified grant and `client: { kind: "mcp", id: grantId, name: clientName }`. Retry keys: single-call writes take an optional `idempotencyKey` tool argument, sent to core as `requestKey = "mcp:<grantId>:<idempotencyKey>"`; confirmed two-step calls use `requestKey = "mcp-confirm:<confirmationId>"`. JSON-RPC call ids are never used, because they restart per connection. Two-step previews use the dry runs of rule D15 and `Documents.preview`.

### 9.2 ui-port

`packages/ui-port` depends on `@kvitbit/core/contract`, `@kvitbit/core/engines` and `packages/api-contract`, never on `@kvitbit/core`. Its TEA programs (Model, Message, update, Commands) run Commands against an `KvitbitApi` service, which is `HttpApiClient.make(Api)`; Foldkit (web) and Expo (mobile) each provide it with their own fetch layer.

- Views are `Schema` classes, so they serialize across SSR hydration and React Native unchanged.
- Typed errors arrive as `CoreError` values and become Messages (for example `IssueFailed { error: Invalid }`). `Invalid.issues[].code` are i18n keys rendered by the shared i18n package.
- `can(caller, action)` from `/contract` decides which controls to show; the server enforces the same table.
- The editor computes keystroke totals with `VatMath.calculate` locally and calls `preview` (debounced) for the authoritative view with rate, FX, statutory notes and QR. `issue` always recomputes on the server.
- The schedule editor previews dates with `Schedules.nextOccurrences`; the issue dialog shows `NumberingSeriesView.nextNumber`.
- The Shell routes by `WorkspaceSummary.slug` and calls the API with the id.

---

## 10. Composition roots and testing

```ts
export const CoreLive = Layer.mergeAll(
  Workspaces.layer, Contacts.layer, PriceList.layer, Documents.layer, Payments.layer,
  PublicShareLinks.layer, Expenses.layer, Templates.layer, Reports.layer,
  WorkflowsLive,                                   // DocumentDelivery, PaymentReminders, RecurringIssuance, MemberInvitation, DataExport
)
export const CronsLive = Layer.mergeAll(RecurringSweep, CnbFixingWarmup, OutboxReconcile, Housekeeping)
// CoreLive requires: SqlClient | WorkflowEngine | CompanyRegistry | ExchangeRates | EmailSender | BlobStorage

// Self-hosted (Docker, Nix): one process serves HTTP and runs workflows and crons.
export const SelfHosted = Layer.mergeAll(CoreLive, CronsLive).pipe(Layer.provide([
  ClusterWorkflowEngine.layer, SingleRunner.layer({ runnerStorage: "sql" }), PgClient.layer(cfg.db),
  FallbackEmailSender.layer(ResendEmailSender.layer, SmtpEmailSender.layer),
  LocalDiskBlobStorage.layer, CnbDailyTxt.layer, AresV3.layer,
]))

// Hosted: Cloud Run API = CoreLive over client-only Sharding; Compute Engine runner = CoreLive + CronsLive
// over NodeClusterHttp.layer({ transport: "http", ... }); Neon pooled for app SQL, direct for cluster storage.

export const TestCore = CoreLive.pipe(Layer.provide([
  WorkflowEngine.layerMemory, PgliteClient.layer, CaptureEmailSender.layer, MemoryBlobStorage.layer,
  FixtureRates.layer, FakeCompanyRegistry.layer,
]))
```

Behaviour tests run through the nine module interfaces on `TestCore`. Examples: "issuing a EUR Invoice dated on a Saturday uses Friday's fixing and prints CZK VAT per bucket", "paying a vat_payer Proforma issues a PTD numbered in the PTD series", "a Recurring Schedule that crashes between issue and send produces exactly one document and one email", "an override number is skipped by the next allocation". Concurrency and numbering tests use a scratch Postgres database, because PGlite is a single connection and cannot show row-lock contention. The engines have table-driven unit tests.

---

## 11. Traceability

| Requirement | Where |
|---|---|
| Caller context and RBAC | Section 2 |
| Five shared errors | Section 3 |
| Domain modules, invariants, idempotency, audit | Section 4 |
| Pure engines | Section 5 |
| Driven ports and edge BotProtection | Section 6 |
| Workflows and ClusterCrons | Section 7 |
| Per-bucket VAT | Section 5.1 |
| SPAYD for CZK, EPC for EUR | Rule D12, section 5.3 |
| Permissive lifecycle, lock, number override, cancel, Credit Note | Rules D2 to D7 |
| PTD auto-issue, explicit Final Invoice | Rules P2, D8 |
| Neon hosted, SingleRunner self-hosted | Rules S5, S6, section 10 |
| Owner-only admin changes (user-flows section 4) | Rules R1c, R3, W4 |
| Core gaps from #19 and #20 | Section 14 |

## 12. Assumptions and spellings to confirm against effect@4.1.4

These do not change the design; confirm each during implementation.

- `WorkflowEngine.layerMemory` as the in-memory engine export for tests.
- Client-only Sharding on Cloud Run (a `ShardingConfig` with no runner address) that can start workflows whose execution happens on runners.
- `Cron.parseUnsafe(expression, timeZone)` as the cron constructor taking a time zone.
- `Schema.TaggedError`, `Schema.Literals`, `Schema.NonEmptyArray` and `HttpApiSchema.status("…")` as used in Deskohub on 4.1.4.
- `Workflow.execute(..., { discard: true })` as the fire-and-forget start.
- EPC069-12 field limits and the exact Czech statutory wording (section 5.3, 5.4).
- `effect/http-api` as the module path for `HttpApi`, `HttpApiEndpoint`, `HttpApiSchema` and `HttpApiMiddleware`. Confirmed against the installed effect@4.1.4: the 4.0 betas exposed it as `effect/unstable/httpapi`; the 4.1 line exposes `effect/http-api` (likewise `effect/http`, `effect/sql`, `effect/cluster`, `effect/workflow`).
- `Schema.check(Schema.isBetween({ minimum, maximum }))` on `Schema.Int` for `PageRequest.limit` and `Schema.check(Schema.isPattern(re))` for string patterns (confirmed in effect@4.1.4, which has no `Schema.between` or `Schema.pattern`), and `Effect.serviceOption` for the optional `RequestOutcome`.

Not yet proven, each needing an integration check before relying on it in production:

- Neon pooled endpoint with the Postgres client's prepared-statement setting.
- End-to-end Cloud Run client-only starts, runner polling latency, and recovery after a Neon restart.
- Collision behaviour when two clients reuse a request id across Workspaces (keys are Workspace-scoped, so expected to be safe).
- PGlite transaction and locking parity with Postgres for the behaviour suite.
- React Native multipart and binary upload transport for `Expenses.attach`.

Council review (four questions, consensus) is recorded in section 13. Reconciliation with the HTTP/MCP and ui-port contracts is recorded in section 14.

## 13. Council outcomes

| Question | Verdict | What changed in this spec |
|---|---|---|
| Row locks vs DocumentEntity on Neon | Accept, amended | Permanent number reservations (S3, D4); one Proforma lock for payments and Final Invoice (D8, P2a, S4); runner-only direct storage and deploy-time migrations (S5); client-only Cloud Run with `storage: "byo"` (S6). Dissent: an Entity would unify per-document ordering but not cross-aggregate numbering and PTD transactions. |
| Documents split | Amend | Series configuration in Workspaces, allocation in Documents, share management in PublicShareLinks; storno eligibility (D6), edit limits (D3a), explicit deductions (D8), retry coverage (C6), re-derivable versioned share tokens. Dissent: Documents still mixes fiscal operations with delivery and PDF; accepted for v1. |
| Workflow idempotency and compensation | Amend | Reminder epochs and atomic eligibility (7.2), immutable delivery snapshots (J3), reconcile from intent state (J1a), no SMTP failover after an ambiguous send (section 6), catch-up cap (4.8), retention (J3a), preview mail allowlist. No compensation kept. Dissent: transactional workflow starts; rejected for portability. |
| Core feeding HttpApi and ui-port | Amend | Caller from verified credentials only, scopes narrow roles (R1), policy before replay (R1a), 412 at the HTTP edge for failed `If-Match` (9.1), PdfRenderer server-only. |

## 14. Reconciliation with #19 and #20

Every core gap raised by `http-mcp-contracts.md` section 9 (H-ids below are its G-ids) and `ui-port-contracts.md` section 11 (U-ids are its G-ids), and every alignment decision from `http-mcp-contracts.md` section 8, is resolved here. The other two specs use the names below.

| Gap | Resolution in this spec |
|---|---|
| H1 `Idempotent-Replayed` | `RequestOutcome` service (section 2.1), mapped in 9.1 |
| H2, U8 ARES prefill | `Workspaces.lookupCompany(ico)` → `RegistryResult`; rules R1e, W9 |
| H3, U8, U9 team reads and actions | `Workspaces.members`, `invitations`, `leave`, `resendInvitation`, `peekInvitation` (with `InvitationHolderCaller`, `InvitationPeek`); `MemberView`, `InvitationView`; workflow epoch in 7.2 |
| H8 decision 4, H3 admin limits | `member.manageAdmins` (owner only) and rule R1c; admins manage `member` and `accountant` only |
| H4 branding | `WorkspaceBranding`, `BrandingPatch` (in `WorkspaceSettingsPatch.branding`), `WorkspaceView.branding`; `Workspaces.setBrandingImage`, `brandingImage`, `removeBrandingImage`; `PublicShareLinks.logo`; `ThemeSource` in `/contract` (section 1); rule W7 |
| H5 branding preview | `Workspaces.previewBranding({ branding, kind, language })` |
| H6, U2 dashboard and cashflow | `ReportKind` gains `cashflow`; `Reports.dashboard` → `DashboardView` (a method, so `ReportKind` stays a list of row reports) |
| H7 audit client attribution | `ClientRef`, `MemberCaller.client`, `enter({ client })`, `AuditEntry.actor.client` |
| H8 FX lookup | `Reports.fxRate({ currency, on })` → `FxRateView` |
| H9 full data export | `Reports.startExport`, `getExport`, `exportFile`; `ExportJobView`; `DataExport` workflow; System job `DataExport` |
| H10 account deletion guard | `WorkspaceSummary.role`, `memberCount` |
| H11, U5 manual reminder | `SendOptions.purpose: DeliveryPurpose`; rule D14 |
| H12 MCP confirmation previews | `Documents.previewSend` → `SendPreview`, `previewFinalInvoice`, `previewCorrection`; rule D15 |
| H13 actions and codes | `apiKey.manage`, `grant.create`, `grant.read.own`, `grant.read.all`, `grant.revoke.own`, `grant.revoke.all` (rule R1d); `Workspaces.recordAccessEvent` audit hook; the `page.*`, `request.*`, `theme.*`, `mcp.*` codes in section 3 |
| H14 bank accounts and retry coverage | `Workspaces.removeBankAccount(id, replacement?)`; `requestKey` on new bank accounts, series, Price List Items and Templates (rule C6) |
| H15 view tracking | `PublicShareLinks.views` → `Page<ShareViewEvent>`; `ShareLinkVisitorCaller.signedInUser`; `SharedDocumentView.viewerIsIssuer` |
| H8 decision 2 MCP retry keys | `RequestOptions` doc comment (section 1) and 9.1: optional `idempotencyKey` argument, confirmation id for confirmed calls, never JSON-RPC ids |
| H8 decision 6 route names | 9.1 defers to `http-mcp-contracts.md` 3.5 |
| U1 PDF template names | `PdfTemplate = "classic" \| "modern_minimal"` |
| U3 manual FX | `FxOverride` on `DocumentInput` and `DocumentPatch` (`fx`); `DocumentView.fx.source` gains `"manual"`; rule D11 |
| U4 incomplete Expenses | `status: "complete" \| "incomplete"` on Expense input, patch, view and summary; `ExpenseQuery.incomplete`; `Invalid{expense.incomplete}` |
| U6 schedule preview | `Schedules.nextOccurrences` in `@kvitbit/core/engines` (section 5.6) |
| U7 next counter | `NumberingSeriesView.periodKey`, `nextCounter`, `nextNumber` |
| U10 Workspace slug | `WorkspaceSlug`; `slug` on `WorkspaceSummary`, `WorkspaceView`, `NewWorkspace`, `WorkspaceSettingsPatch`; rule W6 |
| U12 run history | `Templates.runs` → `Page<RecurringRunView>`; `schedule_runs` written by `RecurringIssuance` |
| U11 legal pages, U13 flow count, U14 Expo session transport | No core change (edge and ui-port items) |

