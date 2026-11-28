import { describe, expect, test } from "bun:test";
import type { AccessEvent, UserId } from "@kvitbit/domain/contract";
import {
  Conflict,
  Forbidden,
  Invalid,
  InvitationToken,
  NotFound,
  RequestKey,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as EffectString from "effect/String";
import * as TestClock from "effect/testing/TestClock";
import { CaptureInvitationDelivery } from "../../../src/modules/workspaces";
import { invitationHolder } from "../../helpers";
import {
  ACCOUNTANT,
  ADMIN,
  accountOf,
  as,
  failure,
  history,
  historyOf,
  join,
  lastToken,
  MEMBER,
  OUTSIDER,
  OWNER,
  SECOND_ADMIN,
  scenario,
  scoped,
  seed,
  W,
} from "./harness";

const illegal = Conflict.make({ reason: "illegal_transition" });
const forbidden = (action: Forbidden["action"]) => Forbidden.make({ action });

describe("members and roles (R1c, R3)", () => {
  test("members lists names and emails from the UserDirectory", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const members = yield* as(s.accountant)(ws.members(s.accountant));
        expect(EffectArray.map(members, (m) => [m.name, m.email, m.role])).toEqual([
          ["Olga Owner", "owner@example.cz", "owner"],
          ["Adam Admin", "admin@example.cz", "admin"],
          ["Marie Member", "member@example.cz", "member"],
          ["Alena Accountant", "accountant@example.cz", "accountant"],
        ]);
      }),
    ));

  test("matrix: who may invite, promote, demote and remove whom", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        yield* join(s.owner)(SECOND_ADMIN, "admin");
        // Admins manage member and accountant only.
        yield* as(s.admin)(ws.invite(s.admin, "a@example.cz", "member"));
        yield* as(s.admin)(ws.invite(s.admin, "b@example.cz", "accountant"));
        const inviteFailure = yield* ws
          .invite(s.admin, "c@example.cz", "admin")
          .pipe(as(s.admin), failure);
        expect(inviteFailure).toEqual(forbidden("member.manageAdmins"));
        // Exercise the service guard for an untyped caller sending an owner invitation.
        const inviteOwner: ReturnType<typeof ws.invite> = Reflect.apply(ws.invite, ws, [
          s.admin,
          "d@example.cz",
          "owner",
        ]);
        const inviteFailure2 = yield* inviteOwner.pipe(as(s.admin), failure);
        expect(inviteFailure2).toEqual(illegal);
        yield* as(s.admin)(ws.setRole(s.admin, MEMBER, "accountant"));
        yield* as(s.admin)(ws.setRole(s.admin, MEMBER, "member"));
        const setRoleFailure = yield* ws
          .setRole(s.admin, MEMBER, "admin")
          .pipe(as(s.admin), failure);
        expect(setRoleFailure).toEqual(forbidden("member.manageAdmins"));
        const setRoleFailure2 = yield* ws
          .setRole(s.admin, SECOND_ADMIN, "member")
          .pipe(as(s.admin), failure);
        expect(setRoleFailure2).toEqual(forbidden("member.manageAdmins"));
        const setRoleFailure3 = yield* ws
          .setRole(s.admin, SECOND_ADMIN, null)
          .pipe(as(s.admin), failure);
        expect(setRoleFailure3).toEqual(forbidden("member.manageAdmins"));
        const setRoleFailure4 = yield* ws
          .setRole(s.admin, OWNER, "member")
          .pipe(as(s.admin), failure);
        // Nobody demotes or removes the owner.
        expect(setRoleFailure4).toEqual(illegal);
        const setRoleFailure5 = yield* ws
          .setRole(s.owner, OWNER, "admin")
          .pipe(as(s.owner), failure);
        expect(setRoleFailure5).toEqual(illegal);
        const setRoleFailure6 = yield* ws.setRole(s.owner, OWNER, null).pipe(as(s.owner), failure);
        expect(setRoleFailure6).toEqual(illegal);
        // The owner manages admins.
        yield* as(s.owner)(ws.invite(s.owner, "c@example.cz", "admin"));
        yield* as(s.owner)(ws.setRole(s.owner, SECOND_ADMIN, "member"));
        yield* as(s.owner)(ws.setRole(s.owner, MEMBER, "admin"));
        yield* as(s.owner)(ws.setRole(s.owner, MEMBER, null));
        const setRoleFailure7 = yield* ws
          .setRole(s.accountant, SECOND_ADMIN, "accountant")
          .pipe(as(s.accountant), failure);
        // Member and accountant cannot manage anyone.
        expect(setRoleFailure7).toEqual(forbidden("member.setRole"));
        const inviteFailure3 = yield* ws
          .invite(s.accountant, "e@example.cz", "member")
          .pipe(as(s.accountant), failure);
        expect(inviteFailure3).toEqual(forbidden("member.invite"));
        const setRoleFailure8 = yield* ws
          .setRole(s.admin, OUTSIDER, "member")
          .pipe(as(s.admin), failure);
        expect(setRoleFailure8).toEqual(NotFound.make({ entity: "Member", id: OUTSIDER }));
        const members = yield* as(s.owner)(ws.members(s.owner));
        const roles = EffectArray.map(members, (m) => [m.userId, m.role]);
        expect(roles).toEqual([
          [OWNER, "owner"],
          [ADMIN, "admin"],
          [ACCOUNTANT, "accountant"],
          [SECOND_ADMIN, "member"],
        ]);
        const entries = yield* history(s.workspaceId);
        const actions = EffectArray.map(entries, (e) => e.action);
        expect(EffectArray.filter(actions, (a) => a === "member.remove").length).toBe(1);
      }),
    ));

  test("leave: the owner cannot; others can; a token needs members:write", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const failureResult = yield* ws.leave(s.owner).pipe(as(s.owner), failure);
        expect(failureResult).toEqual(
          Conflict.make({ reason: "illegal_transition", detail: "member.owner_cannot_leave" }),
        );
        const failureResult2 = yield* ws
          .leave(scoped(["members:read"])(s.member))
          .pipe(as(scoped(["members:read"])(s.member)), failure);
        expect(failureResult2).toEqual(forbidden("member.leave"));
        yield* as(s.member)(ws.leave(s.member));
        yield* as(s.accountant)(ws.leave(s.accountant));
        const members = yield* as(s.owner)(ws.members(s.owner));
        expect(EffectArray.map(members, (m) => m.userId)).toEqual([OWNER, ADMIN]);
        const enterFailure = yield* ws
          .enter(accountOf(MEMBER), s.workspaceId, { scopes: "all", channel: "web" })
          .pipe(as(accountOf(MEMBER)), failure);
        expect(enterFailure).toEqual(NotFound.make({ entity: "Workspace", id: s.workspaceId }));
        expect((yield* history(s.workspaceId)).at(-1)).toMatchObject({
          action: "member.leave",
          changes: [{ path: `members.${ACCOUNTANT}`, before: "accountant", after: null }],
        });
      }),
    ));

  test("transferOwnership: owner only; the caller becomes admin in the same change (W4)", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const transferOwnershipFailure = yield* ws
          .transferOwnership(s.admin, MEMBER)
          .pipe(as(s.admin), failure);
        expect(transferOwnershipFailure).toEqual(forbidden("workspace.transferOwnership"));
        const transferOwnershipFailure2 = yield* ws
          .transferOwnership(s.owner, OUTSIDER)
          .pipe(as(s.owner), failure);
        expect(transferOwnershipFailure2).toEqual(
          NotFound.make({ entity: "Member", id: OUTSIDER }),
        );
        const transferOwnershipFailure3 = yield* ws
          .transferOwnership(s.owner, OWNER)
          .pipe(as(s.owner), failure);
        expect(transferOwnershipFailure3).toEqual(illegal);
        yield* as(s.owner)(ws.transferOwnership(s.owner, MEMBER));
        const members = yield* as(s.admin)(ws.members(s.admin));
        const roles = new Map(EffectArray.map(members, (m) => [m.userId, m.role]));
        expect(roles.get(MEMBER)).toBe("owner");
        expect(roles.get(OWNER)).toBe("admin");
        expect(EffectArray.filter([...roles.values()], (r) => r === "owner").length).toBe(1);
        const transferOwnershipFailure4 = yield* ws
          .transferOwnership(s.owner, ADMIN)
          .pipe(as(s.owner), failure);
        // A stale MemberCaller still saying "owner" cannot transfer again.
        expect(transferOwnershipFailure4).toEqual(forbidden("workspace.transferOwnership"));
        // The former owner may leave now; the new owner may not.
        const newOwner = yield* as(accountOf(MEMBER))(
          ws.enter(accountOf(MEMBER), s.workspaceId, { scopes: "all", channel: "web" }),
        );
        const failureResult = yield* ws.leave(newOwner).pipe(as(newOwner), failure);
        expect(failureResult).toEqual(
          Conflict.make({ reason: "illegal_transition", detail: "member.owner_cannot_leave" }),
        );
        const formerOwner = yield* as(accountOf(OWNER))(
          ws.enter(accountOf(OWNER), s.workspaceId, { scopes: "all", channel: "web" }),
        );
        expect(formerOwner.role).toBe("admin");
        yield* as(formerOwner)(ws.leave(formerOwner));
      }),
    ));
});

describe("invitations", () => {
  test("invite, peek, accept; the MemberCaller is a session caller", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const capture = yield* CaptureInvitationDelivery;
        const owner = yield* as(accountOf(OWNER))(ws.create(accountOf(OWNER), { name: "Acme" }));
        const invitation = yield* as(owner)(ws.invite(owner, "Outsider@Example.cz", "accountant"));
        expect(invitation).toMatchObject({
          email: "Outsider@Example.cz",
          role: "accountant",
          status: "pending",
          invitedBy: { userId: OWNER, name: "Olga Owner" },
          expiresAt: "2026-11-30T09:00:00.000Z",
        });
        const sent = yield* Ref.get(capture.sent);
        expect(sent).toEqual([
          { workspaceId: owner.workspaceId, invitationId: invitation.id, epoch: 0 },
        ]);
        const t = yield* lastToken;
        const result = yield* as(invitationHolder(t))(ws.peekInvitation(invitationHolder(t)));
        expect(result).toEqual({
          workspaceName: "Acme",
          inviterName: "Olga Owner",
          role: "accountant",
          email: "Outsider@Example.cz",
          status: "pending",
          expiresAt: "2026-11-30T09:00:00.000Z",
        });
        const acceptInvitationFailure = yield* ws
          .acceptInvitation(accountOf(MEMBER), t)
          .pipe(as(accountOf(MEMBER)), failure);
        // The token must be the invited email's account.
        expect(acceptInvitationFailure).toEqual(forbidden("invitation.accept"));
        const joined = yield* as(accountOf(OUTSIDER))(ws.acceptInvitation(accountOf(OUTSIDER), t));
        expect(joined).toMatchObject({
          userId: OUTSIDER,
          role: "accountant",
          scopes: "all",
          client: null,
        });
        expect(
          (yield* as(invitationHolder(t))(ws.peekInvitation(invitationHolder(t)))).status,
        ).toBe("accepted");
        const acceptInvitationFailure2 = yield* ws
          .acceptInvitation(accountOf(OUTSIDER), t)
          .pipe(as(accountOf(OUTSIDER)), failure);
        expect(acceptInvitationFailure2).toEqual(
          Conflict.make({ reason: "illegal_transition", detail: "invitation.not_pending" }),
        );
        const result2 = yield* as(owner)(ws.invitations(owner));
        expect(result2).toEqual([]);
        const entries = yield* history(owner.workspaceId);
        expect(EffectArray.map(entries, (e) => e.action)).toEqual([
          "workspace.create",
          "member.invite",
          "invitation.accept",
        ]);
      }),
    ));

  test("unknown tokens are NotFound; other callers cannot peek", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const failureResult = yield* ws
          .peekInvitation(invitationHolder("nope"))
          .pipe(as(invitationHolder("nope")), failure);
        expect(failureResult).toEqual(NotFound.make({ entity: "Invitation", id: "token" }));
        const acceptInvitationFailure = yield* ws
          .acceptInvitation(accountOf(OWNER), InvitationToken.make("nope"))
          .pipe(as(accountOf(OWNER)), failure);
        expect(acceptInvitationFailure).toEqual(
          NotFound.make({ entity: "Invitation", id: "token" }),
        );
        const failureResult2 = yield* ws
          .peekInvitation(accountOf(OWNER))
          .pipe(as(accountOf(OWNER)), failure);
        expect(failureResult2).toEqual(NotFound.make({ entity: "Invitation", id: "token" }));
      }),
    ));

  test("resend: new epoch and token, 60 s cooldown, pending only; expiry after 7 days", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const capture = yield* CaptureInvitationDelivery;
        const s = yield* seed();
        const invitation = yield* as(s.admin)(ws.invite(s.admin, "outsider@example.cz", "member"));
        const first = yield* lastToken;
        const sent = () =>
          Effect.map(Ref.get(capture.sent), (all) =>
            EffectArray.filter(all, (x) => x.invitationId === invitation.id),
          );
        // Within 60 s of the last send a resend is a no-op (C6).
        yield* as(s.admin)(ws.resendInvitation(s.admin, invitation.id));
        const initialSends = yield* sent();
        expect(EffectArray.map(initialSends, (x) => x.epoch)).toEqual([0]);
        yield* TestClock.adjust("2 minutes");
        yield* as(s.admin)(ws.resendInvitation(s.admin, invitation.id));
        const resendAttempts = yield* sent();
        expect(EffectArray.map(resendAttempts, (x) => x.epoch)).toEqual([0, 1]);
        const second = yield* lastToken;
        expect(second).not.toBe(first);
        const failureResult = yield* ws
          .peekInvitation(invitationHolder(first))
          .pipe(as(invitationHolder(first)), failure);
        expect(failureResult).toBeInstanceOf(NotFound);
        const result = yield* as(invitationHolder(second))(
          ws.peekInvitation(invitationHolder(second)),
        );
        expect(result).toMatchObject({
          status: "pending",
          expiresAt: "2026-11-30T09:02:00.000Z",
        });
        // Expired after 7 days: no accept, no resend; inviting the email again renews it.
        yield* TestClock.adjust("8 days");
        expect(
          (yield* as(invitationHolder(second))(ws.peekInvitation(invitationHolder(second)))).status,
        ).toBe("expired");
        const acceptInvitationFailure = yield* ws
          .acceptInvitation(accountOf(OUTSIDER), second)
          .pipe(as(accountOf(OUTSIDER)), failure);
        expect(acceptInvitationFailure).toEqual(
          Conflict.make({ reason: "illegal_transition", detail: "invitation.not_pending" }),
        );
        const resendInvitationFailure = yield* ws
          .resendInvitation(s.admin, invitation.id)
          .pipe(as(s.admin), failure);
        expect(resendInvitationFailure).toEqual(
          Conflict.make({ reason: "illegal_transition", detail: "invitation.not_pending" }),
        );
        const invitations = yield* as(s.admin)(ws.invitations(s.admin));
        expect(EffectArray.map(invitations, (i) => i.status)).toEqual(["expired"]);
        const renewed = yield* as(s.admin)(ws.invite(s.admin, "outsider@example.cz", "member"));
        expect(renewed).toMatchObject({ id: invitation.id, status: "pending" });
        const renewalAttempts = yield* sent();
        expect(EffectArray.map(renewalAttempts, (x) => x.epoch)).toEqual([0, 1, 2]);
        const third = yield* lastToken;
        yield* as(accountOf(OUTSIDER))(ws.acceptInvitation(accountOf(OUTSIDER), third));
        const members = yield* as(s.admin)(ws.members(s.admin));
        expect(EffectArray.map(members, (m) => m.userId)).toContain(OUTSIDER);
      }),
    ));

  test("revoke ends a pending or expired invitation and is idempotent", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const invitation = yield* as(s.admin)(ws.invite(s.admin, "outsider@example.cz", "member"));
        const t = yield* lastToken;
        yield* as(s.admin)(ws.revokeInvitation(s.admin, invitation.id));
        yield* as(s.admin)(ws.revokeInvitation(s.admin, invitation.id));
        expect(
          (yield* as(invitationHolder(t))(ws.peekInvitation(invitationHolder(t)))).status,
        ).toBe("revoked");
        const acceptInvitationFailure = yield* ws
          .acceptInvitation(accountOf(OUTSIDER), t)
          .pipe(as(accountOf(OUTSIDER)), failure);
        expect(acceptInvitationFailure).toEqual(
          Conflict.make({ reason: "illegal_transition", detail: "invitation.not_pending" }),
        );
        const resendInvitationFailure = yield* ws
          .resendInvitation(s.admin, invitation.id)
          .pipe(as(s.admin), failure);
        expect(resendInvitationFailure).toEqual(
          Conflict.make({ reason: "illegal_transition", detail: "invitation.not_pending" }),
        );
        const expiring = yield* as(s.admin)(ws.invite(s.admin, "late@example.cz", "member"));
        yield* TestClock.adjust("8 days");
        yield* as(s.admin)(ws.revokeInvitation(s.admin, expiring.id));
        const result = yield* as(s.admin)(ws.invitations(s.admin));
        expect(result).toEqual([]);
        const entries = yield* history(s.workspaceId);
        const actions = EffectArray.map(entries, (e) => e.action);
        expect(EffectArray.filter(actions, (a) => a === "member.invite.revoke").length).toBe(2);
      }),
    ));

  test("a pending email returns its invitation; a member's email is a duplicate; requestKey replays", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const capture = yield* CaptureInvitationDelivery;
        const s = yield* seed();
        const sentBefore = (yield* Ref.get(capture.sent)).length;
        const first = yield* as(s.admin)(ws.invite(s.admin, "new@example.cz", "member"));
        const again = yield* as(s.admin)(ws.invite(s.admin, "NEW@example.cz", "member"));
        expect(again.id).toBe(first.id);
        expect((yield* Ref.get(capture.sent)).length).toBe(sentBefore + 1);
        const inviteFailure = yield* ws
          .invite(s.admin, "member@example.cz", "member")
          .pipe(as(s.admin), failure);
        expect(inviteFailure).toEqual(Conflict.make({ reason: "duplicate" }));
        const inviteFailure2 = yield* ws
          .invite(s.admin, "not-an-email", "member")
          .pipe(as(s.admin), failure);
        expect(inviteFailure2).toEqual(
          Invalid.make({ issues: [{ path: ["email"], code: "request.malformed" }] }),
        );
        const opts = { requestKey: RequestKey.make("inv-1") };
        const keyed = yield* as(s.admin)(
          ws.invite(s.admin, "other@example.cz", "accountant", opts),
        );
        const inviteResult = yield* as(s.admin)(
          ws.invite(s.admin, "other@example.cz", "accountant", opts),
        );
        expect(inviteResult).toEqual(keyed);
        const inviteFailure3 = yield* ws
          .invite(s.admin, "third@example.cz", "accountant", opts)
          .pipe(as(s.admin), failure);
        expect(inviteFailure3).toEqual(Conflict.make({ reason: "idempotency_mismatch" }));
      }),
    ));

  test("admin invitations: only the owner resends or revokes them (R1c); accountant cannot read them", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const invitation = yield* as(s.owner)(ws.invite(s.owner, "boss@example.cz", "admin"));
        const resendInvitationFailure = yield* ws
          .resendInvitation(s.admin, invitation.id)
          .pipe(as(s.admin), failure);
        expect(resendInvitationFailure).toEqual(forbidden("member.manageAdmins"));
        const revokeInvitationFailure = yield* ws
          .revokeInvitation(s.admin, invitation.id)
          .pipe(as(s.admin), failure);
        expect(revokeInvitationFailure).toEqual(forbidden("member.manageAdmins"));
        const failureResult = yield* ws.invitations(s.accountant).pipe(as(s.accountant), failure);
        expect(failureResult).toEqual(forbidden("invitation.read"));
        const inviteFailure = yield* ws
          .invite(scoped(["members:read"])(s.admin), "x@example.cz", "member")
          .pipe(as(scoped(["members:read"])(s.admin)), failure);
        expect(inviteFailure).toEqual(forbidden("member.invite"));
        expect(
          (yield* as(scoped(["members:read"])(s.admin))(
            ws.invitations(scoped(["members:read"])(s.admin)),
          )).length,
        ).toBe(1);
        yield* as(s.owner)(ws.revokeInvitation(s.owner, invitation.id));
      }),
    ));
});

describe("recordAccessEvent", () => {
  const event = (
    action: AccessEvent["action"],
    onBehalfOf?: UserId,
    id = "cred-1",
  ): AccessEvent => {
    const subject: AccessEvent["subject"] = {
      entity: EffectString.startsWith("apiKey")(action) ? "ApiKey" : "McpGrant",
      id,
      name: "CI",
    };
    return onBehalfOf === undefined ? { action, subject } : { action, subject, onBehalfOf };
  };

  test("audits on the credential subject with the matching action check (R1d)", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        yield* as(s.admin)(ws.recordAccessEvent(s.admin, event("apiKey.create")));
        const entries = yield* historyOf({ entity: "ApiKey", id: "cred-1" })(s.workspaceId);
        expect(EffectArray.map(entries, (e) => [e.action, e.actor])).toEqual([
          ["apiKey.create", { _tag: "Member", userId: ADMIN, channel: "web", client: null }],
        ]);
        const recordAccessEventFailure = yield* ws
          .recordAccessEvent(s.member, event("apiKey.create"))
          .pipe(as(s.member), failure);
        expect(recordAccessEventFailure).toEqual(forbidden("apiKey.manage"));
        const recordAccessEventFailure2 = yield* ws
          .recordAccessEvent(
            scoped(["workspace:write", "members:write"])(s.admin),
            event("apiKey.revoke"),
          )
          .pipe(as(scoped(["workspace:write", "members:write"])(s.admin)), failure);
        expect(recordAccessEventFailure2).toEqual(forbidden("apiKey.manage"));
        yield* as(s.accountant)(ws.recordAccessEvent(s.accountant, event("grant.create")));
        yield* as(s.member)(ws.recordAccessEvent(s.member, event("grant.revoke")));
        const recordAccessEventFailure3 = yield* ws
          .recordAccessEvent(s.member, event("grant.revoke", ADMIN))
          .pipe(as(s.member), failure);
        expect(recordAccessEventFailure3).toEqual(forbidden("grant.revoke.all"));
        // Idempotent by subject and action (C6): the repeat writes nothing.
        yield* as(s.member)(ws.recordAccessEvent(s.member, event("grant.revoke")));
        const grants = yield* historyOf({ entity: "McpGrant", id: "cred-1" })(s.workspaceId);
        expect(EffectArray.map(grants, (e) => e.action)).toEqual(["grant.create", "grant.revoke"]);
        yield* as(s.admin)(ws.recordAccessEvent(s.admin, event("grant.revoke", MEMBER, "cred-2")));
        const other = yield* historyOf({ entity: "McpGrant", id: "cred-2" })(s.workspaceId);
        expect(other.at(-1)?.changes).toContainEqual({
          path: "onBehalfOf",
          before: null,
          after: MEMBER,
        });
      }),
    ));
});
