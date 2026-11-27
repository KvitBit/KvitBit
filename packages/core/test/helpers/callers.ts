/**
 * Caller builders for tests. `systemCaller` mints a sealed System caller, so it lives here and
 * never in the published `@kvitbit/core/testing` entry point.
 */
import type {
  AccountCaller,
  Channel,
  ClientRef,
  InvitationHolderCaller,
  Locale,
  MemberCaller,
  Scope,
  ShareLinkVisitorCaller,
  SystemCaller,
  SystemJob,
} from "@kvitbit/domain/contract";
import {
  Caller,
  DeliveryId,
  InvitationToken,
  Role,
  ShareToken,
  UserId,
  VisitorHash,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import * as EffectFunction from "effect/Function";
import * as Schema from "effect/Schema";
import { systemCaller } from "../../src/internal/system";

export const WORKSPACE_A = WorkspaceId.make("01900000-0000-7000-8000-00000000a001");
export const WORKSPACE_B = WorkspaceId.make("01900000-0000-7000-8000-00000000b001");
const USER_A = UserId.make("01900000-0000-7000-8000-00000000c001");

interface MemberOptions {
  readonly scopes?: "all" | ReadonlyArray<Scope>;
  readonly workspaceId?: WorkspaceId;
  readonly userId?: UserId;
  readonly channel?: Channel;
  readonly client?: ClientRef | null;
  readonly locale?: Locale;
}

export const member: {
  (options?: MemberOptions): (role: Role) => MemberCaller;
  (role: Role, options?: MemberOptions): MemberCaller;
} = EffectFunction.dual(
  (args) => Schema.is(Role)(args[0]),
  (role: Role, options: MemberOptions = {}): MemberCaller => {
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
  },
);

export const account = (
  options: { readonly userId?: UserId; readonly email?: string } = {},
): AccountCaller =>
  Caller.account({
    userId: options.userId ?? USER_A,
    email: options.email ?? "owner@example.cz",
    locale: "cs",
    channel: "web",
  });

export const system: {
  (workspaceId: WorkspaceId): (job: SystemJob | undefined) => SystemCaller;
  (job?: SystemJob): SystemCaller;
  (job: SystemJob | undefined, workspaceId: WorkspaceId): SystemCaller;
} = EffectFunction.dual(
  (args) => args.length !== 1 || !Schema.is(WorkspaceId)(args[0]),
  (
    job: SystemJob = {
      _tag: "DocumentDelivery",
      deliveryId: DeliveryId.make("01900000-0000-7000-8000-00000000d001"),
    },
    workspaceId: WorkspaceId = WORKSPACE_A,
  ): SystemCaller => systemCaller(workspaceId, job),
);

export const shareVisitor = (
  options: { readonly token?: string; readonly signedInUser?: UserId } = {},
): ShareLinkVisitorCaller => {
  const payload = {
    token: ShareToken.make(options.token ?? "v1.test-token"),
    visitor: VisitorHash.make("visitor-hash"),
    locale: "cs" as const,
  };
  return Caller.shareLinkVisitor(
    options.signedInUser === undefined
      ? payload
      : { ...payload, signedInUser: options.signedInUser },
  );
};

export const invitationHolder = (token = "invitation-token"): InvitationHolderCaller =>
  Caller.invitationHolder({ token: InvitationToken.make(token), locale: "cs" });
