import { describe, expect, test } from "bun:test";
import type { Caller } from "@kvitbit/domain/contract";
import { Conflict, Forbidden } from "@kvitbit/domain/contract";
import { Effect, Exit } from "effect";
import type { MembershipChange } from "../src/policy";
import { checkMembershipChange } from "../src/policy";
import { member } from "./helpers/callers";

const check = (caller: Caller, change: MembershipChange) =>
  Effect.runSyncExit(checkMembershipChange(caller, change));
const ok = Exit.void;
const illegal = Exit.fail(new Conflict({ reason: "illegal_transition" }));
const forbidden = (
  action: "member.invite" | "member.setRole" | "member.leave" | "member.manageAdmins",
) => Exit.fail(new Forbidden({ action }));

describe("checkMembershipChange (R1c, R3)", () => {
  const owner = member("owner");
  const admin = member("admin");

  test("the owner cannot leave", () => {
    expect(check(owner, { _tag: "Leave" })).toEqual(
      Exit.fail(
        new Conflict({ reason: "illegal_transition", detail: "member.owner_cannot_leave" }),
      ),
    );
  });

  test("a scoped owner without members:write is Forbidden before the R3 Conflict", () => {
    expect(check(member("owner", { scopes: ["documents:write"] }), { _tag: "Leave" })).toEqual(
      forbidden("member.leave"),
    );
    expect(check(member("owner", { scopes: ["members:write"] }), { _tag: "Leave" })).toEqual(
      Exit.fail(
        new Conflict({ reason: "illegal_transition", detail: "member.owner_cannot_leave" }),
      ),
    );
    expect(check(member("member", { scopes: ["members:read"] }), { _tag: "Leave" })).toEqual(
      forbidden("member.leave"),
    );
  });

  test("everyone else may leave", () => {
    for (const role of ["admin", "member", "accountant"] as const) {
      expect(check(member(role), { _tag: "Leave" })).toEqual(ok);
    }
  });

  test("the owner is never removed or demoted, and nobody becomes owner", () => {
    expect(check(owner, { _tag: "Remove", targetRole: "owner" })).toEqual(illegal);
    expect(check(admin, { _tag: "SetRole", targetRole: "owner", role: "member" })).toEqual(illegal);
    expect(check(owner, { _tag: "SetRole", targetRole: "member", role: "owner" })).toEqual(illegal);
    expect(check(owner, { _tag: "Invite", role: "owner" })).toEqual(illegal);
  });

  test("admin targets and admin roles need manageAdmins", () => {
    expect(check(admin, { _tag: "Invite", role: "admin" })).toEqual(
      forbidden("member.manageAdmins"),
    );
    expect(check(admin, { _tag: "SetRole", targetRole: "member", role: "admin" })).toEqual(
      forbidden("member.manageAdmins"),
    );
    expect(check(admin, { _tag: "SetRole", targetRole: "admin", role: "member" })).toEqual(
      forbidden("member.manageAdmins"),
    );
    expect(check(admin, { _tag: "Remove", targetRole: "admin" })).toEqual(
      forbidden("member.manageAdmins"),
    );
    expect(check(owner, { _tag: "Invite", role: "admin" })).toEqual(ok);
    expect(check(owner, { _tag: "Remove", targetRole: "admin" })).toEqual(ok);
    expect(check(owner, { _tag: "SetRole", targetRole: "accountant", role: "admin" })).toEqual(ok);
  });

  test("admins manage members and accountants", () => {
    expect(check(admin, { _tag: "Invite", role: "accountant" })).toEqual(ok);
    expect(check(admin, { _tag: "SetRole", targetRole: "member", role: "accountant" })).toEqual(ok);
    expect(check(admin, { _tag: "Remove", targetRole: "member" })).toEqual(ok);
  });

  test("members and accountants manage nobody", () => {
    for (const role of ["member", "accountant"] as const) {
      expect(check(member(role), { _tag: "Invite", role: "member" })).toEqual(
        forbidden("member.invite"),
      );
      expect(check(member(role), { _tag: "Remove", targetRole: "member" })).toEqual(
        forbidden("member.setRole"),
      );
    }
  });

  test("a scoped token without members:write cannot manage members", () => {
    const token = member("owner", { scopes: ["members:read"] });
    expect(check(token, { _tag: "Invite", role: "member" })).toEqual(forbidden("member.invite"));
  });
});
