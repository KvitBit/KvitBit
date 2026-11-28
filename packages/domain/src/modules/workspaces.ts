/** Workspaces module (core-ports section 4.1). Interface only. */

import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import type { Caller, Channel, MemberCaller } from "../caller";
import type { Conflict, Forbidden, Invalid, NotFound, Unavailable } from "../errors";
import type { BankAccountId, InvitationId, InvitationToken, NumberingSeriesId } from "../ids";
import {
  InvitationId as InvitationIdSchema,
  NumberingSeriesId as NumberingSeriesIdSchema,
  UserId,
  WorkspaceId,
} from "../ids";
import type { FileDownload } from "../shared";
import { OpenStruct } from "../shared";
import { Hex, ThemeSource } from "../theme";
import type { ClientRef, DocumentKind, RequestOptions } from "../vocabulary";
import {
  type BrandingImage,
  DocumentKind as DocumentKindSchema,
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
  footerText: Schema.String.pipe(Schema.NullOr, Schema.optional),
  theme: ThemeSource.pipe(Schema.NullOr, Schema.optional),
});
export type BrandingPatch = typeof BrandingPatch.Type;

/** Partly specified: also carries Issuing Entity, Tax Regime, defaults and bank accounts (open). */
export const WorkspaceView = OpenStruct({
  slug: WorkspaceSlug,
  branding: WorkspaceBranding,
  revision: Schema.Int,
});
export type WorkspaceView = typeof WorkspaceView.Type;
/** Onboarding input; partly specified (open). */
export const NewWorkspace = OpenStruct({
  slug: Schema.optional(WorkspaceSlug), // default: derived from the name, made unique
});
export type NewWorkspace = typeof NewWorkspace.Type;
export const IssuingEntityPatch = Schema.Unknown.pipe(Schema.brand("IssuingEntityPatch"));
export type IssuingEntityPatch = typeof IssuingEntityPatch.Type;
/** Also carries defaults and reminder policy, not yet specified (open). */
export const WorkspaceSettingsPatch = OpenStruct({
  slug: Schema.optional(WorkspaceSlug),
  branding: Schema.optional(BrandingPatch),
});
export type WorkspaceSettingsPatch = typeof WorkspaceSettingsPatch.Type;
/** IBAN, BIC, currency, default per currency (ui-port notes). Fields not yet specified. */
export const BankAccountInput = Schema.Unknown.pipe(Schema.brand("BankAccountInput"));
export type BankAccountInput = typeof BankAccountInput.Type;
export const BankAccountView = Schema.Unknown.pipe(Schema.brand("BankAccountView"));
export type BankAccountView = typeof BankAccountView.Type;

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

export const NumberingSeriesView = Schema.Struct({
  id: NumberingSeriesIdSchema,
  kind: DocumentKindSchema,
  name: Schema.String,
  pattern: Schema.String,
  isDefault: Schema.Boolean,
  periodKey: Schema.String, // Numbering.periodKey for today (Prague): "2026", "2026-11" or "all"
  nextCounter: Schema.Int, // counter the next issue in periodKey will try
  nextNumber: Schema.String, // Numbering.format of nextCounter, for the issue dialog
});
export type NumberingSeriesView = typeof NumberingSeriesView.Type;

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
      caller: Caller,
      input: NewWorkspace,
      opts?: RequestOptions,
    ) => Effect.Effect<MemberCaller, Invalid | Conflict | Unavailable | Forbidden>;
    readonly listMine: (
      caller: Caller,
    ) => Effect.Effect<ReadonlyArray<WorkspaceSummary>, Unavailable | Forbidden>;
    /** The only way to obtain a MemberCaller. NotFound when the user is not a Member. */
    readonly enter: (
      caller: Caller,
      workspace: WorkspaceId,
      opts: {
        readonly scopes: MemberCaller["scopes"];
        readonly channel: Channel;
        readonly client?: ClientRef; // verified API Key or MCP grant; copied into MemberCaller.client and audit
      },
    ) => Effect.Effect<MemberCaller, NotFound | Unavailable | Forbidden>;
    readonly acceptInvitation: (
      caller: Caller,
      token: InvitationToken,
    ) => Effect.Effect<MemberCaller, NotFound | Conflict | Unavailable | Forbidden>;

    // Account caller (registry.lookup) or Member caller (contact.read)
    /** Read-only CompanyRegistry lookup: checksum first, 24 h cache, nothing saved. NotFound when ARES has no record. */
    readonly lookupCompany: (
      caller: Caller,
      ico: string,
    ) => Effect.Effect<RegistryResult, Invalid | NotFound | Unavailable | Forbidden>;

    // InvitationHolder caller
    /** What the invitation page shows before sign-up. Unknown tokens are NotFound; others show their status. */
    readonly peekInvitation: (
      caller: Caller,
    ) => Effect.Effect<InvitationPeek, NotFound | Unavailable>;

    // Member caller
    readonly current: (caller: Caller) => Effect.Effect<WorkspaceView, Unavailable | Forbidden>;
    readonly updateIssuingEntity: (
      caller: Caller,
      patch: IssuingEntityPatch,
      expectedRevision: number,
    ) => Effect.Effect<WorkspaceView, Invalid | Conflict | Unavailable | Forbidden>;
    /** Defaults, slug, reminder policy and branding (fields of WorkspaceSettingsPatch). */
    readonly updateSettings: (
      caller: Caller,
      patch: WorkspaceSettingsPatch,
      expectedRevision: number,
    ) => Effect.Effect<WorkspaceView, Invalid | Conflict | Unavailable | Forbidden>;
    readonly saveBankAccount: (
      caller: Caller,
      input: BankAccountInput & { readonly id?: BankAccountId },
      opts?: RequestOptions,
    ) => Effect.Effect<BankAccountView, Invalid | NotFound | Conflict | Unavailable | Forbidden>;
    /**
     * Archives the account. Issued documents keep their snapshot. When drafts, Templates or a
     * currency default use it, `replacement` (same currency) takes its place in the same
     * transaction; without one the call fails Conflict{illegal_transition, bank_account.in_use}.
     */
    readonly removeBankAccount: (
      caller: Caller,
      id: BankAccountId,
      replacement?: BankAccountId,
    ) => Effect.Effect<void, Invalid | NotFound | Conflict | Unavailable | Forbidden>;
    readonly configureSeries: (
      caller: Caller,
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
      Invalid | NotFound | Conflict | Unavailable | Forbidden
    >;
    readonly listSeries: (
      caller: Caller,
    ) => Effect.Effect<ReadonlyArray<NumberingSeriesView>, Unavailable | Forbidden>;

    readonly setBrandingImage: (
      caller: Caller,
      image: BrandingImage,
      file: {
        readonly contentType: string; // image/png or image/jpeg, at most 2 MB
        readonly bytes: Stream.Stream<Uint8Array>;
      },
    ) => Effect.Effect<ImageRef, Invalid | Unavailable | Forbidden>;
    readonly brandingImage: (
      caller: Caller,
      image: BrandingImage,
    ) => Effect.Effect<FileDownload, NotFound | Unavailable | Forbidden>;
    readonly removeBrandingImage: (
      caller: Caller,
      image: BrandingImage,
    ) => Effect.Effect<void, Unavailable | Forbidden>;
    /**
     * Renders a fixed sample document of `kind` with the current branding merged with
     * `branding`, through PdfRenderer. Persists nothing, allocates no number, writes no audit entry.
     */
    readonly previewBranding: (
      caller: Caller,
      input: {
        readonly branding: BrandingPatch;
        readonly kind: DocumentKind;
        readonly language: Locale;
      },
    ) => Effect.Effect<FileDownload, Invalid | Unavailable | Forbidden>;

    readonly members: (
      caller: Caller,
    ) => Effect.Effect<ReadonlyArray<MemberView>, Unavailable | Forbidden>;
    /** Pending and recently expired invitations (invitation.read). */
    readonly invitations: (
      caller: Caller,
    ) => Effect.Effect<ReadonlyArray<InvitationView>, Unavailable | Forbidden>;
    readonly invite: (
      caller: Caller,
      email: string,
      role: Exclude<Role, "owner">,
      opts?: RequestOptions,
    ) => Effect.Effect<InvitationView, Invalid | Conflict | Unavailable | Forbidden>;
    /** Sends the email again and extends expiry by 7 days. Pending invitations only. */
    readonly resendInvitation: (
      caller: Caller,
      id: InvitationId,
    ) => Effect.Effect<void, NotFound | Conflict | Unavailable | Forbidden>;
    readonly revokeInvitation: (
      caller: Caller,
      id: InvitationId,
    ) => Effect.Effect<void, NotFound | Unavailable | Forbidden>;
    /** `null` removes the Member. */
    readonly setRole: (
      caller: Caller,
      member: UserId,
      role: Exclude<Role, "owner"> | null,
    ) => Effect.Effect<void, NotFound | Conflict | Unavailable | Forbidden>;
    /** The caller leaves the Workspace. The owner must transfer ownership first (rule R3). */
    readonly leave: (caller: Caller) => Effect.Effect<void, Conflict | Unavailable | Forbidden>;
    readonly transferOwnership: (
      caller: Caller,
      to: UserId,
    ) => Effect.Effect<void, NotFound | Conflict | Unavailable | Forbidden>;
    /** Makes the Workspace read-only. Purging is an operator task because of statutory retention. */
    readonly close: (
      caller: Caller,
      confirmName: string,
    ) => Effect.Effect<void, Invalid | Unavailable | Forbidden>;

    /**
     * Audit hook for credentials apps/server owns. The edge calls it after it creates or revokes
     * an API Key or MCP grant; core checks the matching apiKey.* or grant.* action and writes the entry.
     */
    readonly recordAccessEvent: (
      caller: Caller,
      event: AccessEvent,
    ) => Effect.Effect<void, Unavailable | Forbidden>;
  }
>()("@kvitbit/domain/modules/workspaces") {}
