/**
 * Caller builders for tests. `systemCaller` mints a sealed System caller, so it lives here and
 * never in the published `@kvitbit/core/testing` entry point.
 */
import type {
  AccountCaller,
  Channel,
  ClientRef,
  DeliveryId,
  InvitationHolderCaller,
  InvitationToken,
  Locale,
  MemberCaller,
  Role,
  Scope,
  ShareLinkVisitorCaller,
  ShareToken,
  SystemCaller,
  SystemJob,
  UserId,
  VisitorHash,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Caller } from "@kvitbit/domain/contract";
import { systemCaller } from "../../src/internal/system";

export const WORKSPACE_A = "01900000-0000-7000-8000-00000000a001" as WorkspaceId;
export const WORKSPACE_B = "01900000-0000-7000-8000-00000000b001" as WorkspaceId;
export const USER_A = "01900000-0000-7000-8000-00000000c001" as UserId;

export const member = (
  role: Role,
  options: {
    readonly scopes?: "all" | ReadonlyArray<Scope>;
    readonly workspaceId?: WorkspaceId;
    readonly userId?: UserId;
    readonly channel?: Channel;
    readonly client?: ClientRef | null;
    readonly locale?: Locale;
  } = {},
): MemberCaller => {
  const scopes = options.scopes ?? "all";
  return {
    _tag: "Member",
    userId: options.userId ?? USER_A,
    workspaceId: options.workspaceId ?? WORKSPACE_A,
    role,
    scopes,
    locale: options.locale ?? "cs",
    channel: options.channel ?? (scopes === "all" ? "web" : "api"),
    client:
      options.client !== undefined
        ? options.client
        : scopes === "all"
          ? null
          : { kind: "api_key", id: "key-1", name: "Test key" },
  };
};

export const account = (
  options: { readonly userId?: UserId; readonly email?: string } = {},
): AccountCaller =>
  Caller.account({
    userId: options.userId ?? USER_A,
    email: options.email ?? "owner@example.cz",
    locale: "cs",
    channel: "web",
  });

export const system = (
  job: SystemJob = {
    _tag: "DocumentDelivery",
    deliveryId: "01900000-0000-7000-8000-00000000d001" as DeliveryId,
  },
  workspaceId: WorkspaceId = WORKSPACE_A,
): SystemCaller => systemCaller(workspaceId, job);

export const shareVisitor = (
  options: { readonly token?: string; readonly signedInUser?: UserId } = {},
): ShareLinkVisitorCaller =>
  Caller.shareLinkVisitor({
    token: (options.token ?? "v1.test-token") as ShareToken,
    visitor: "visitor-hash" as VisitorHash,
    locale: "cs",
    ...(options.signedInUser !== undefined ? { signedInUser: options.signedInUser } : {}),
  });

export const invitationHolder = (token = "invitation-token"): InvitationHolderCaller =>
  Caller.invitationHolder({ token: token as InvitationToken, locale: "cs" });
