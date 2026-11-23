/** Workspaces module (core-ports section 4.1). Interface only. */
import type { Effect, Stream } from "effect";
import { Context, Schema } from "effect";
import type { Channel, CurrentCaller, MemberCaller } from "../caller";
import type { Conflict, Forbidden, Invalid, NotFound, Unavailable } from "../errors";
import type { BankAccountId, InvitationId, InvitationToken, NumberingSeriesId } from "../ids";
import { InvitationId as InvitationIdSchema, UserId, WorkspaceId } from "../ids";
import type { FileDownload, Unspecified } from "../shared";
import { Hex, ThemeSource } from "../theme";
import type { ClientRef, DocumentKind, RequestOptions } from "../vocabulary";
import {
  type BrandingImage,
  ImageRef,
  IsoDate,
  type Locale,
  PdfTemplate,
  Role,
  TaxRegime,
  WorkspaceSlug,
} from "../vocabulary";

export const WorkspaceSummary = Schema.Struct({
  id: WorkspaceId,
  slug: WorkspaceSlug,
  name: Schema.String,
  role: Role, // the caller's role
  memberCount: Schema.Int, // lets the edge guard account deletion (flow 1.9)
  taxRegime: TaxRegime,
  closed: Schema.Boolean,
});
export type WorkspaceSummary = typeof WorkspaceSummary.Type;

export const WorkspaceBranding = Schema.Struct({
  pdfTemplate: PdfTemplate, // default "classic"
  accentColor: Hex,
  footerText: Schema.NullOr(Schema.String), // at most 500 chars
  theme: Schema.NullOr(ThemeSource),
  logo: Schema.NullOr(ImageRef),
  stamp: Schema.NullOr(ImageRef),
});
export type WorkspaceBranding = typeof WorkspaceBranding.Type;

export const BrandingPatch = Schema.Struct({
  pdfTemplate: Schema.optional(PdfTemplate),
  accentColor: Schema.optional(Hex),
  footerText: Schema.optional(Schema.NullOr(Schema.String)),
  theme: Schema.optional(Schema.NullOr(ThemeSource)),
});
export type BrandingPatch = typeof BrandingPatch.Type;

/** Issuing Entity, Tax Regime, defaults, bank accounts, revision, slug, branding. Fields not yet specified. */
export type WorkspaceView = Unspecified<"WorkspaceView">;
/** Onboarding input; known to carry `slug?: WorkspaceSlug`. Fields not yet specified. */
export type NewWorkspace = Unspecified<"NewWorkspace">;
export type IssuingEntityPatch = Unspecified<"IssuingEntityPatch">;
/** Defaults, slug, reminder policy and `branding?: BrandingPatch`. Fields not yet specified. */
export type WorkspaceSettingsPatch = Unspecified<"WorkspaceSettingsPatch">;
/** IBAN, BIC, currency, default per currency (ui-port notes). Fields not yet specified. */
export type BankAccountInput = Unspecified<"BankAccountInput">;
export type BankAccountView = Unspecified<"BankAccountView">;

export const InvitationRole = Schema.Literals(["admin", "member", "accountant"]);
export const InvitationStatus = Schema.Literals(["pending", "expired", "revoked", "accepted"]);

export const MemberView = Schema.Struct({
  userId: UserId,
  name: Schema.String,
  email: Schema.String,
  role: Role,
  joinedAt: Schema.String,
});
export type MemberView = typeof MemberView.Type;

export const InvitationView = Schema.Struct({
  id: InvitationIdSchema,
  email: Schema.String,
  role: InvitationRole,
  status: InvitationStatus,
  invitedBy: Schema.Struct({ userId: UserId, name: Schema.String }),
  createdAt: Schema.String,
  expiresAt: Schema.String,
});
export type InvitationView = typeof InvitationView.Type;

export const InvitationPeek = Schema.Struct({
  workspaceName: Schema.String,
  inviterName: Schema.String,
  role: InvitationRole,
  email: Schema.String, // shown and locked on the sign-up form (flow 2.5)
  status: InvitationStatus,
  expiresAt: Schema.String,
});
export type InvitationPeek = typeof InvitationPeek.Type;

export const RegistryResult = Schema.Struct({
  ico: Schema.String,
  name: Schema.String,
  address: Schema.Struct({
    street: Schema.String,
    city: Schema.String,
    postalCode: Schema.String,
    country: Schema.String,
  }),
  dic: Schema.NullOr(Schema.String), // presence does not prove VAT-payer status
  legalForm: Schema.String,
  registerEntry: Schema.NullOr(Schema.String), // §435 commercial register line
  terminatedOn: Schema.NullOr(IsoDate), // the editor warns about a dissolved company
});
export type RegistryResult = typeof RegistryResult.Type;

export interface NumberingSeriesView {
  readonly id: NumberingSeriesId;
  readonly kind: DocumentKind;
  readonly name: string;
  readonly pattern: string;
  readonly isDefault: boolean;
  readonly periodKey: string; // Numbering.periodKey for today (Prague): "2026", "2026-11" or "all"
  readonly nextCounter: number; // counter the next issue in periodKey will try
  readonly nextNumber: string; // Numbering.format of nextCounter, for the issue dialog
}

export interface AccessEvent {
  readonly action: "apiKey.create" | "apiKey.revoke" | "grant.create" | "grant.revoke";
  readonly subject: {
    readonly entity: "ApiKey" | "McpGrant";
    readonly id: string;
    readonly name: string;
  };
  readonly onBehalfOf?: UserId; // the grant's Member, when an owner or admin revokes someone else's grant
}

export class Workspaces extends Context.Service<
  Workspaces,
  {
    // Account caller
    /** Onboarding. Prefills the Issuing Entity from CompanyRegistry when ico is given. Caller becomes owner. */
    readonly create: (
      input: NewWorkspace,
      opts?: RequestOptions,
    ) => Effect.Effect<MemberCaller, Invalid | Unavailable | Forbidden, CurrentCaller>;
    readonly listMine: Effect.Effect<ReadonlyArray<WorkspaceSummary>, Forbidden, CurrentCaller>;
    /** The only way to obtain a MemberCaller. NotFound when the user is not a Member. */
    readonly enter: (
      workspace: WorkspaceId,
      opts: {
        readonly scopes: MemberCaller["scopes"];
        readonly channel: Channel;
        readonly client?: ClientRef; // verified API Key or MCP grant; copied into MemberCaller.client and audit
      },
    ) => Effect.Effect<MemberCaller, NotFound | Forbidden, CurrentCaller>;
    readonly acceptInvitation: (
      token: InvitationToken,
    ) => Effect.Effect<MemberCaller, NotFound | Conflict | Forbidden, CurrentCaller>;

    // Account caller (registry.lookup) or Member caller (contact.read)
    /** Read-only CompanyRegistry lookup: checksum first, 24 h cache, nothing saved. NotFound when ARES has no record. */
    readonly lookupCompany: (
      ico: string,
    ) => Effect.Effect<RegistryResult, Invalid | NotFound | Unavailable | Forbidden, CurrentCaller>;

    // InvitationHolder caller
    /** What the invitation page shows before sign-up. Unknown tokens are NotFound; others show their status. */
    readonly peekInvitation: Effect.Effect<InvitationPeek, NotFound, CurrentCaller>;

    // Member caller
    readonly current: Effect.Effect<WorkspaceView, Forbidden, CurrentCaller>;
    readonly updateIssuingEntity: (
      patch: IssuingEntityPatch,
      expectedRevision: number,
    ) => Effect.Effect<WorkspaceView, Invalid | Conflict | Forbidden, CurrentCaller>;
    /** Defaults, slug, reminder policy and branding (fields of WorkspaceSettingsPatch). */
    readonly updateSettings: (
      patch: WorkspaceSettingsPatch,
      expectedRevision: number,
    ) => Effect.Effect<WorkspaceView, Invalid | Conflict | Forbidden, CurrentCaller>;
    readonly saveBankAccount: (
      input: BankAccountInput & { readonly id?: BankAccountId },
      opts?: RequestOptions,
    ) => Effect.Effect<BankAccountView, Invalid | NotFound | Conflict | Forbidden, CurrentCaller>;
    /**
     * Archives the account. Issued documents keep their snapshot. When drafts, Templates or a
     * currency default use it, `replacement` (same currency) takes its place in the same
     * transaction; without one the call fails Conflict{illegal_transition, bank_account.in_use}.
     */
    readonly removeBankAccount: (
      id: BankAccountId,
      replacement?: BankAccountId,
    ) => Effect.Effect<void, Invalid | NotFound | Conflict | Forbidden, CurrentCaller>;
    readonly configureSeries: (
      input: {
        readonly id?: NumberingSeriesId;
        readonly kind: DocumentKind;
        readonly name: string;
        readonly pattern: string; // tokens: YYYY YY MM N…; e.g. "YYYY-NNNN", "FV-YY-NNN"
        readonly nextNumber?: number; // only raises the counter for the current period
        readonly isDefault?: boolean;
      },
      opts?: RequestOptions,
    ) => Effect.Effect<
      NumberingSeriesView,
      Invalid | NotFound | Conflict | Forbidden,
      CurrentCaller
    >;
    readonly listSeries: Effect.Effect<
      ReadonlyArray<NumberingSeriesView>,
      Forbidden,
      CurrentCaller
    >;

    readonly setBrandingImage: (
      image: BrandingImage,
      file: {
        readonly contentType: string; // image/png or image/jpeg, at most 2 MB
        readonly bytes: Stream.Stream<Uint8Array>;
      },
    ) => Effect.Effect<ImageRef, Invalid | Unavailable | Forbidden, CurrentCaller>;
    readonly brandingImage: (
      image: BrandingImage,
    ) => Effect.Effect<FileDownload, NotFound | Unavailable | Forbidden, CurrentCaller>;
    readonly removeBrandingImage: (
      image: BrandingImage,
    ) => Effect.Effect<void, Forbidden, CurrentCaller>;
    /**
     * Renders a fixed sample document of `kind` with the current branding merged with
     * `branding`, through PdfRenderer. Persists nothing, allocates no number, writes no audit entry.
     */
    readonly previewBranding: (input: {
      readonly branding: BrandingPatch;
      readonly kind: DocumentKind;
      readonly language: Locale;
    }) => Effect.Effect<FileDownload, Invalid | Unavailable | Forbidden, CurrentCaller>;

    readonly members: Effect.Effect<ReadonlyArray<MemberView>, Forbidden, CurrentCaller>;
    /** Pending and recently expired invitations (invitation.read). */
    readonly invitations: Effect.Effect<ReadonlyArray<InvitationView>, Forbidden, CurrentCaller>;
    readonly invite: (
      email: string,
      role: Exclude<Role, "owner">,
      opts?: RequestOptions,
    ) => Effect.Effect<InvitationView, Invalid | Conflict | Forbidden, CurrentCaller>;
    /** Sends the email again and extends expiry by 7 days. Pending invitations only. */
    readonly resendInvitation: (
      id: InvitationId,
    ) => Effect.Effect<void, NotFound | Conflict | Forbidden, CurrentCaller>;
    readonly revokeInvitation: (
      id: InvitationId,
    ) => Effect.Effect<void, NotFound | Forbidden, CurrentCaller>;
    /** `null` removes the Member. */
    readonly setRole: (
      member: UserId,
      role: Exclude<Role, "owner"> | null,
    ) => Effect.Effect<void, NotFound | Conflict | Forbidden, CurrentCaller>;
    /** The caller leaves the Workspace. The owner must transfer ownership first (rule R3). */
    readonly leave: Effect.Effect<void, Conflict | Forbidden, CurrentCaller>;
    readonly transferOwnership: (
      to: UserId,
    ) => Effect.Effect<void, NotFound | Conflict | Forbidden, CurrentCaller>;
    /** Makes the Workspace read-only. Purging is an operator task because of statutory retention. */
    readonly close: (
      confirmName: string,
    ) => Effect.Effect<void, Invalid | Forbidden, CurrentCaller>;

    /**
     * Audit hook for credentials apps/server owns. The edge calls it after it creates or revokes
     * an API Key or MCP grant; core checks the matching apiKey.* or grant.* action and writes the entry.
     */
    readonly recordAccessEvent: (
      event: AccessEvent,
    ) => Effect.Effect<void, Forbidden, CurrentCaller>;
  }
>()("kvitbit/Workspaces") {}
