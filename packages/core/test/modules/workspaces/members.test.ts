import { describe, expect, test } from "bun:test";
import type { InvitationToken, RequestKey } from "@kvitbit/domain/contract";
import { Conflict, Forbidden, Invalid, NotFound } from "@kvitbit/domain/contract";
import { Effect, Ref } from "effect";
import { TestClock } from "effect/testing";
import { CaptureInvitationDelivery } from "../../../src/modules/workspaces";
import { invitationHolder } from "../../helpers";
import {
  ACCOUNTANT,
  ADMIN,
  accountOf,
  as,
  failure,
  history,
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

const illegal = new Conflict({ reason: "illegal_transition" });
const forbidden = (action: Forbidden["action"]) => new Forbidden({ action });
const token = (t: string) => t as InvitationToken;

describe("members and roles (R1c, R3)", () => {
  test("members lists names and emails from the UserDirectory", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const members = yield* as(s.accountant)(ws.members);
        expect(members.map((m) => [m.name, m.email, m.role])).toEqual([
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
        yield* join(s.owner, SECOND_ADMIN, "admin");
        // Admins manage member and accountant only.
        yield* as(s.admin)(ws.invite("a@example.cz", "member"));
        yield* as(s.admin)(ws.invite("b@example.cz", "accountant"));
        expect(yield* failure(as(s.admin)(ws.invite("c@example.cz", "admin")))).toEqual(
          forbidden("member.manageAdmins"),
        );
        expect(yield* failure(as(s.admin)(ws.invite("d@example.cz", "owner" as never)))).toEqual(
          illegal,
        );
        yield* as(s.admin)(ws.setRole(MEMBER, "accountant"));
        yield* as(s.admin)(ws.setRole(MEMBER, "member"));
        expect(yield* failure(as(s.admin)(ws.setRole(MEMBER, "admin")))).toEqual(
          forbidden("member.manageAdmins"),
        );
        expect(yield* failure(as(s.admin)(ws.setRole(SECOND_ADMIN, "member")))).toEqual(
          forbidden("member.manageAdmins"),
        );
        expect(yield* failure(as(s.admin)(ws.setRole(SECOND_ADMIN, null)))).toEqual(
          forbidden("member.manageAdmins"),
        );
        // Nobody demotes or removes the owner.
        expect(yield* failure(as(s.admin)(ws.setRole(OWNER, "member")))).toEqual(illegal);
        expect(yield* failure(as(s.owner)(ws.setRole(OWNER, "admin")))).toEqual(illegal);
        expect(yield* failure(as(s.owner)(ws.setRole(OWNER, null)))).toEqual(illegal);
        // The owner manages admins.
        yield* as(s.owner)(ws.invite("c@example.cz", "admin"));
        yield* as(s.owner)(ws.setRole(SECOND_ADMIN, "member"));
        yield* as(s.owner)(ws.setRole(MEMBER, "admin"));
        yield* as(s.owner)(ws.setRole(MEMBER, null));
        // Member and accountant cannot manage anyone.
        expect(yield* failure(as(s.accountant)(ws.setRole(SECOND_ADMIN, "accountant")))).toEqual(
          forbidden("member.setRole"),
        );
        expect(yield* failure(as(s.accountant)(ws.invite("e@example.cz", "member")))).toEqual(
          forbidden("member.invite"),
        );
        expect(yield* failure(as(s.admin)(ws.setRole(OUTSIDER, "member")))).toEqual(
          new NotFound({ entity: "Member", id: OUTSIDER }),
        );
        const roles = (yield* as(s.owner)(ws.members)).map((m) => [m.userId, m.role]);
        expect(roles).toEqual([
          [OWNER, "owner"],
          [ADMIN, "admin"],
          [ACCOUNTANT, "accountant"],
          [SECOND_ADMIN, "member"],
        ]);
        const actions = (yield* history(s.workspaceId)).map((e) => e.action);
        expect(actions.filter((a) => a === "member.remove").length).toBe(1);
      }),
    ));

  test("leave: the owner cannot; others can; a token needs members:write", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        expect(yield* failure(as(s.owner)(ws.leave))).toEqual(
          new Conflict({ reason: "illegal_transition", detail: "member.owner_cannot_leave" }),
        );
        expect(yield* failure(as(scoped(s.member, ["members:read"]))(ws.leave))).toEqual(
          forbidden("member.leave"),
        );
        yield* as(s.member)(ws.leave);
        yield* as(s.accountant)(ws.leave);
        expect((yield* as(s.owner)(ws.members)).map((m) => m.userId)).toEqual([OWNER, ADMIN]);
        expect(
          yield* failure(
            as(accountOf(MEMBER))(ws.enter(s.workspaceId, { scopes: "all", channel: "web" })),
          ),
        ).toEqual(new NotFound({ entity: "Workspace", id: s.workspaceId }));
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
        expect(yield* failure(as(s.admin)(ws.transferOwnership(MEMBER)))).toEqual(
          forbidden("workspace.transferOwnership"),
        );
        expect(yield* failure(as(s.owner)(ws.transferOwnership(OUTSIDER)))).toEqual(
          new NotFound({ entity: "Member", id: OUTSIDER }),
        );
        expect(yield* failure(as(s.owner)(ws.transferOwnership(OWNER)))).toEqual(illegal);
        yield* as(s.owner)(ws.transferOwnership(MEMBER));
        const roles = new Map((yield* as(s.admin)(ws.members)).map((m) => [m.userId, m.role]));
        expect(roles.get(MEMBER)).toBe("owner");
        expect(roles.get(OWNER)).toBe("admin");
        expect([...roles.values()].filter((r) => r === "owner").length).toBe(1);
        // A stale MemberCaller still saying "owner" cannot transfer again.
        expect(yield* failure(as(s.owner)(ws.transferOwnership(ADMIN)))).toEqual(
          forbidden("workspace.transferOwnership"),
        );
        // The former owner may leave now; the new owner may not.
        const newOwner = yield* as(accountOf(MEMBER))(
          ws.enter(s.workspaceId, { scopes: "all", channel: "web" }),
        );
        expect(yield* failure(as(newOwner)(ws.leave))).toEqual(
          new Conflict({ reason: "illegal_transition", detail: "member.owner_cannot_leave" }),
        );
        const formerOwner = yield* as(accountOf(OWNER))(
          ws.enter(s.workspaceId, { scopes: "all", channel: "web" }),
        );
        expect(formerOwner.role).toBe("admin");
        yield* as(formerOwner)(ws.leave);
      }),
    ));
});

describe("invitations", () => {
  test("invite, peek, accept; the MemberCaller is a session caller", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const capture = yield* CaptureInvitationDelivery;
        const owner = yield* as(accountOf(OWNER))(ws.create({ name: "Acme" } as never));
        const invitation = yield* as(owner)(ws.invite("Outsider@Example.cz", "accountant"));
        expect(invitation).toMatchObject({
          email: "Outsider@Example.cz",
          role: "accountant",
          status: "pending",
          invitedBy: { userId: OWNER, name: "Olga Owner" },
          expiresAt: "2026-11-30T09:00:00.000Z",
        });
        const sent = yield* Ref.get(capture.sent);
        expect(sent.map((x) => [x.invitationId, x.sendEpoch, x.email])).toEqual([
          [invitation.id, 1, "Outsider@Example.cz"],
        ]);
        const t = token(yield* lastToken);
        expect(yield* as(invitationHolder(t))(ws.peekInvitation)).toEqual({
          workspaceName: "Acme",
          inviterName: "Olga Owner",
          role: "accountant",
          email: "Outsider@Example.cz",
          status: "pending",
          expiresAt: "2026-11-30T09:00:00.000Z",
        });
        // The token must be the invited email's account.
        expect(yield* failure(as(accountOf(MEMBER))(ws.acceptInvitation(t)))).toEqual(
          forbidden("invitation.accept"),
        );
        const joined = yield* as(accountOf(OUTSIDER))(ws.acceptInvitation(t));
        expect(joined).toMatchObject({
          userId: OUTSIDER,
          role: "accountant",
          scopes: "all",
          client: null,
        });
        expect((yield* as(invitationHolder(t))(ws.peekInvitation)).status).toBe("accepted");
        expect(yield* failure(as(accountOf(OUTSIDER))(ws.acceptInvitation(t)))).toEqual(
          new Conflict({ reason: "illegal_transition", detail: "invitation.not_pending" }),
        );
        expect(yield* as(owner)(ws.invitations)).toEqual([]);
        expect((yield* history(owner.workspaceId)).map((e) => e.action)).toEqual([
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
        expect(yield* failure(as(invitationHolder("nope"))(ws.peekInvitation))).toEqual(
          new NotFound({ entity: "Invitation", id: "token" }),
        );
        expect(yield* failure(as(accountOf(OWNER))(ws.acceptInvitation(token("nope"))))).toEqual(
          new NotFound({ entity: "Invitation", id: "token" }),
        );
        expect(yield* failure(as(accountOf(OWNER))(ws.peekInvitation))).toEqual(
          new NotFound({ entity: "Invitation", id: "token" }),
        );
      }),
    ));

  test("expiry after 7 days; resend extends it with a new token; revoke ends it", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const invitation = yield* as(s.admin)(ws.invite("outsider@example.cz", "member"));
        const first = token(yield* lastToken);
        yield* TestClock.adjust("8 days");
        expect((yield* as(invitationHolder(first))(ws.peekInvitation)).status).toBe("expired");
        expect(yield* failure(as(accountOf(OUTSIDER))(ws.acceptInvitation(first)))).toEqual(
          new Conflict({ reason: "illegal_transition", detail: "invitation.not_pending" }),
        );
        expect((yield* as(s.admin)(ws.invitations)).map((i) => i.status)).toEqual(["expired"]);
        yield* as(s.admin)(ws.resendInvitation(invitation.id));
        const second = token(yield* lastToken);
        expect(second).not.toBe(first);
        expect(yield* failure(as(invitationHolder(first))(ws.peekInvitation))).toBeInstanceOf(
          NotFound,
        );
        const renewed = yield* as(invitationHolder(second))(ws.peekInvitation);
        expect(renewed).toMatchObject({ status: "pending", expiresAt: "2026-12-08T09:00:00.000Z" });
        yield* as(s.admin)(ws.revokeInvitation(invitation.id));
        yield* as(s.admin)(ws.revokeInvitation(invitation.id)); // idempotent
        expect((yield* as(invitationHolder(second))(ws.peekInvitation)).status).toBe("revoked");
        expect(yield* failure(as(accountOf(OUTSIDER))(ws.acceptInvitation(second)))).toEqual(
          new Conflict({ reason: "illegal_transition", detail: "invitation.not_pending" }),
        );
        expect(yield* failure(as(s.admin)(ws.resendInvitation(invitation.id)))).toEqual(
          new Conflict({ reason: "illegal_transition", detail: "invitation.not_pending" }),
        );
        const actions = (yield* history(s.workspaceId)).map((e) => e.action).slice(-3);
        expect(actions).toEqual(["member.invite", "member.invite.resend", "member.invite.revoke"]);
      }),
    ));

  test("a pending email returns its invitation; a member's email is a duplicate; requestKey replays", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const capture = yield* CaptureInvitationDelivery;
        const s = yield* seed();
        const sentBefore = (yield* Ref.get(capture.sent)).length;
        const first = yield* as(s.admin)(ws.invite("new@example.cz", "member"));
        const again = yield* as(s.admin)(ws.invite("NEW@example.cz", "member"));
        expect(again.id).toBe(first.id);
        expect((yield* Ref.get(capture.sent)).length).toBe(sentBefore + 1);
        expect(yield* failure(as(s.admin)(ws.invite("member@example.cz", "member")))).toEqual(
          new Conflict({ reason: "duplicate" }),
        );
        expect(yield* failure(as(s.admin)(ws.invite("not-an-email", "member")))).toEqual(
          new Invalid({ issues: [{ path: ["email"], code: "request.malformed" }] }),
        );
        const opts = { requestKey: "inv-1" as RequestKey };
        const keyed = yield* as(s.admin)(ws.invite("other@example.cz", "accountant", opts));
        expect(yield* as(s.admin)(ws.invite("other@example.cz", "accountant", opts))).toEqual(
          keyed,
        );
        expect(
          yield* failure(as(s.admin)(ws.invite("third@example.cz", "accountant", opts))),
        ).toEqual(new Conflict({ reason: "idempotency_mismatch" }));
      }),
    ));

  test("admin invitations: only the owner resends or revokes them (R1c); accountant cannot read them", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const invitation = yield* as(s.owner)(ws.invite("boss@example.cz", "admin"));
        expect(yield* failure(as(s.admin)(ws.resendInvitation(invitation.id)))).toEqual(
          forbidden("member.manageAdmins"),
        );
        expect(yield* failure(as(s.admin)(ws.revokeInvitation(invitation.id)))).toEqual(
          forbidden("member.manageAdmins"),
        );
        expect(yield* failure(as(s.accountant)(ws.invitations))).toEqual(
          forbidden("invitation.read"),
        );
        expect(
          yield* failure(
            as(scoped(s.admin, ["members:read"]))(ws.invite("x@example.cz", "member")),
          ),
        ).toEqual(forbidden("member.invite"));
        expect((yield* as(scoped(s.admin, ["members:read"]))(ws.invitations)).length).toBe(1);
        yield* as(s.owner)(ws.revokeInvitation(invitation.id));
      }),
    ));
});

describe("recordAccessEvent", () => {
  const event = (
    action: "apiKey.create" | "apiKey.revoke" | "grant.create" | "grant.revoke",
    onBehalfOf?: string,
  ) => ({
    action,
    subject: {
      entity: action.startsWith("apiKey") ? ("ApiKey" as const) : ("McpGrant" as const),
      id: "cred-1",
      name: "CI",
    },
    ...(onBehalfOf === undefined ? {} : { onBehalfOf: onBehalfOf as never }),
  });

  test("audits on the credential subject with the matching action check (R1d)", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        yield* as(s.admin)(ws.recordAccessEvent(event("apiKey.create")));
        const entries = yield* history(s.workspaceId, { entity: "ApiKey", id: "cred-1" });
        expect(entries.map((e) => [e.action, e.actor])).toEqual([
          ["apiKey.create", { _tag: "Member", userId: ADMIN, channel: "web", client: null }],
        ]);
        expect(yield* failure(as(s.member)(ws.recordAccessEvent(event("apiKey.create"))))).toEqual(
          forbidden("apiKey.manage"),
        );
        expect(
          yield* failure(
            as(scoped(s.admin, ["workspace:write", "members:write"]))(
              ws.recordAccessEvent(event("apiKey.revoke")),
            ),
          ),
        ).toEqual(forbidden("apiKey.manage"));
        yield* as(s.accountant)(ws.recordAccessEvent(event("grant.create")));
        yield* as(s.member)(ws.recordAccessEvent(event("grant.revoke")));
        expect(
          yield* failure(as(s.member)(ws.recordAccessEvent(event("grant.revoke", ADMIN)))),
        ).toEqual(forbidden("grant.revoke.all"));
        yield* as(s.admin)(ws.recordAccessEvent(event("grant.revoke", MEMBER)));
        const grants = yield* history(s.workspaceId, { entity: "McpGrant", id: "cred-1" });
        expect(grants.map((e) => e.action)).toEqual([
          "grant.create",
          "grant.revoke",
          "grant.revoke",
        ]);
        expect(grants.at(-1)?.changes).toContainEqual({
          path: "onBehalfOf",
          before: null,
          after: MEMBER,
        });
      }),
    ));
});
