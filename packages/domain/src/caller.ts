/** Caller context (core-ports section 2.1). */
import { Context, Schema } from "effect";
import type { InvitationToken, ShareToken, UserId, VisitorHash, WorkspaceId } from "./ids";
import { DeliveryId, DocumentId, ExportId, ScheduleId } from "./ids";
import type { Scope } from "./scope";
import type { ClientRef, Locale, Role } from "./vocabulary";
import { IsoDate } from "./vocabulary";

export const Channel = Schema.Literals(["web", "mobile", "api", "mcp"]);
export type Channel = typeof Channel.Type;

export interface MemberCaller {
  readonly _tag: "Member";
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId;
  readonly role: Role;
  /**
   * Session callers get "all". API and MCP tokens carry the scopes they were granted;
   * scopes only narrow the role, never widen it.
   */
  readonly scopes: "all" | ReadonlyArray<Scope>;
  readonly locale: Locale; // UI locale; document language is resolved separately
  readonly channel: Channel;
  /** API Key or MCP client the request came through; null for web and mobile sessions. */
  readonly client: ClientRef | null;
}

/** Authenticated user with no Workspace chosen yet (onboarding, workspace picker, invitations). */
export interface AccountCaller {
  readonly _tag: "Account";
  readonly userId: UserId;
  readonly email: string;
  readonly locale: Locale;
  readonly channel: Channel;
}

/** Anonymous holder of a Public Share Link token. */
export interface ShareLinkVisitorCaller {
  readonly _tag: "ShareLinkVisitor";
  readonly token: ShareToken;
  readonly visitor: VisitorHash;
  readonly locale: Locale;
  /** Set when the request also carries a verified session; a Member of the issuing Workspace records no view. */
  readonly signedInUser?: UserId;
}

/** Anonymous holder of an invitation link, before or without an account (invitation page). */
export interface InvitationHolderCaller {
  readonly _tag: "InvitationHolder";
  readonly token: InvitationToken;
  readonly locale: Locale;
}

/**
 * Never exported: no code outside this module can name the key, so no object literal can
 * satisfy `SystemCaller`. The runtime half of the seal (a WeakSet of instances created by the
 * core's internal factory) lives with the Policy implementation in the core package.
 */
declare const SystemSeal: unique symbol;

/** What a System caller is doing; also the audit attribution of workflow writes. */
export const SystemJob = Schema.Union([
  Schema.TaggedStruct("RecurringIssuance", { scheduleId: ScheduleId, occurrence: IsoDate }),
  Schema.TaggedStruct("PaymentReminders", { documentId: DocumentId }),
  Schema.TaggedStruct("DocumentDelivery", { deliveryId: DeliveryId }),
  Schema.TaggedStruct("DataExport", { exportId: ExportId }),
]);
export type SystemJob = typeof SystemJob.Type;

/** Workflows and crons. Constructible only inside the core. */
export interface SystemCaller {
  readonly _tag: "System";
  readonly [SystemSeal]: true;
  readonly workspaceId: WorkspaceId;
  readonly job: SystemJob;
}

export type Caller =
  | MemberCaller
  | AccountCaller
  | ShareLinkVisitorCaller
  | InvitationHolderCaller
  | SystemCaller;

export class CurrentCaller extends Context.Service<CurrentCaller, Caller>()("kvitbit/Caller") {}

/** Edge constructors. There is deliberately no constructor for System. */
export const Caller: {
  readonly account: (a: Omit<AccountCaller, "_tag">) => AccountCaller;
  readonly shareLinkVisitor: (v: Omit<ShareLinkVisitorCaller, "_tag">) => ShareLinkVisitorCaller;
  readonly invitationHolder: (i: Omit<InvitationHolderCaller, "_tag">) => InvitationHolderCaller;
  // MemberCaller comes only from Workspaces.enter (core-ports 4.1), which checks membership.
} = {
  account: (a) => ({ ...a, _tag: "Account" }),
  shareLinkVisitor: (v) => ({ ...v, _tag: "ShareLinkVisitor" }),
  invitationHolder: (i) => ({ ...i, _tag: "InvitationHolder" }),
};
