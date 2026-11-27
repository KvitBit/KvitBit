import { describe, expect, test } from "bun:test";
import type { Action, Caller, Role, Scope, ScopeArea } from "@kvitbit/domain/contract";
import {
  Action as ActionSchema,
  DocumentId,
  ExportId,
  Forbidden,
  SCOPE_AREAS,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Order from "effect/Order";
import { actionScope, can } from "../src/contract";
import { authorize, authorizeInWorkspace } from "../src/policy";
import { account, invitationHolder, member, shareVisitor, system } from "./helpers/callers";
import { runWithCaller } from "./helpers/run";

const ACTIONS: ReadonlyArray<Action> = ActionSchema.literals;
const ROLES: ReadonlyArray<Role> = ["owner", "admin", "member", "accountant"];

// Table 2.3, written out independently of src/policy/table.ts.
type Column = Role | "Account" | "ShareLinkVisitor" | "InvitationHolder" | "System";
const GROUPS: ReadonlyArray<{
  readonly actions: ReadonlyArray<Action>;
  readonly allowed: ReadonlyArray<Column>;
}> = [
  {
    actions: [
      "workspace.read",
      "member.read",
      "contact.read",
      "priceList.read",
      "document.read",
      "payment.read",
      "expense.read",
      "template.read",
      "share.read",
      "document.pdf",
      "document.history",
      "report.run",
      "report.export",
      "expense.attachment.read",
    ],
    allowed: ["owner", "admin", "member", "accountant", "System"],
  },
  {
    actions: [
      "contact.write",
      "priceList.write",
      "template.write",
      "schedule.write",
      "expense.write",
    ],
    allowed: ["owner", "admin", "member"],
  },
  {
    actions: [
      "document.draft",
      "document.edit",
      "document.cancel",
      "document.correct",
      "document.finalInvoice",
      "document.lock",
      "share.write",
      "payment.write",
    ],
    allowed: ["owner", "admin", "member"],
  },
  { actions: ["document.issue", "document.send"], allowed: ["owner", "admin", "member", "System"] },
  { actions: ["document.unlock", "document.overrideNumber"], allowed: ["owner", "admin"] },
  { actions: ["workspace.settings"], allowed: ["owner", "admin"] },
  { actions: ["member.invite", "member.setRole", "invitation.read"], allowed: ["owner", "admin"] },
  { actions: ["member.manageAdmins"], allowed: ["owner"] },
  { actions: ["member.leave"], allowed: ["admin", "member", "accountant"] },
  { actions: ["apiKey.manage", "grant.read.all", "grant.revoke.all"], allowed: ["owner", "admin"] },
  {
    actions: ["grant.create", "grant.read.own", "grant.revoke.own"],
    allowed: ["owner", "admin", "member", "accountant"],
  },
  { actions: ["workspace.transferOwnership", "workspace.close"], allowed: ["owner"] },
  {
    actions: [
      "workspace.create",
      "workspace.listMine",
      "workspace.enter",
      "invitation.accept",
      "registry.lookup",
    ],
    allowed: ["Account"],
  },
  { actions: ["share.open", "share.pdf", "share.logo"], allowed: ["ShareLinkVisitor"] },
  { actions: ["invitation.peek"], allowed: ["InvitationHolder"] },
];

const COLUMNS: ReadonlyArray<readonly [Column, Caller]> = [
  ...EffectArray.map(ROLES, (role) => [role, member(role)] as const),
  ["Account", account()],
  ["ShareLinkVisitor", shareVisitor()],
  ["InvitationHolder", invitationHolder()],
  [
    "System",
    system({
      _tag: "PaymentReminders",
      documentId: DocumentId.make("01900000-0000-7000-8000-00000000000d"),
    }),
  ],
];

describe("can: table 2.3", () => {
  test("the groups cover every Action exactly once", () => {
    const listed = EffectArray.flatMap(GROUPS, (g) => g.actions);
    expect(new Set(listed).size).toBe(listed.length);
    expect(EffectArray.sort(listed, Order.String)).toEqual(EffectArray.sort(ACTIONS, Order.String));
  });

  for (const group of GROUPS) {
    for (const action of group.actions) {
      test(action, () => {
        for (const [column, caller] of COLUMNS) {
          expect({ column, allowed: can(caller, action) }).toEqual({
            column,
            allowed: group.allowed.includes(column),
          });
        }
      });
    }
  }
});

describe("can: scopes (R1)", () => {
  const SESSION_ONLY: ReadonlyArray<Action> = [
    "apiKey.manage",
    "grant.read.all",
    "grant.revoke.all",
    "grant.create",
    "grant.read.own",
    "grant.revoke.own",
  ];

  test("every Action maps to one of the ten areas", () => {
    for (const action of ACTIONS) {
      expect(SCOPE_AREAS).toContain(actionScope(action).area);
    }
  });

  for (const area of SCOPE_AREAS) {
    for (const level of ["read", "write"] as const) {
      test(`${area}:${level} grants exactly the ${area} actions up to ${level}`, () => {
        const owner = member("owner", { scopes: [`${area}:${level}`] });
        for (const action of ACTIONS) {
          const scope = actionScope(action);
          const expected =
            can(member("owner"), action) &&
            !SESSION_ONLY.includes(action) &&
            scope.area === area &&
            (level === "write" || scope.level === "read");
          expect({ action, allowed: can(owner, action) }).toEqual({ action, allowed: expected });
        }
      });
    }
  }

  test("documents:read only reads documents, whatever the role", () => {
    const token = member("owner", { scopes: ["documents:read"] });
    expect(can(token, "document.read")).toBe(true);
    expect(can(token, "document.pdf")).toBe(true);
    expect(can(token, "document.draft")).toBe(false);
    expect(can(token, "contact.read")).toBe(false);
  });

  test("scoped callers never exceed the role table, for every role and scope set", () => {
    const allScopes: ReadonlyArray<Scope> = EffectArray.flatMap(SCOPE_AREAS, (a: ScopeArea) => [
      `${a}:read` as const,
      `${a}:write` as const,
    ]);
    // Deterministic pseudo-random scope subsets (LCG), plus the empty and the full set.
    let seed = 42;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed;
    };
    const subsets: Array<ReadonlyArray<Scope>> = [[], allScopes];
    for (let i = 0; i < 200; i++)
      subsets.push(EffectArray.filter(allScopes, () => next() % 2 === 0));
    for (const role of ROLES) {
      for (const scopes of subsets) {
        const scoped = member(role, { scopes });
        for (const action of ACTIONS) {
          const roleAllows = !can(scoped, action) || can(member(role), action);
          expect({ role, action, roleAllows }).toEqual({ role, action, roleAllows: true });
        }
      }
    }
  });

  test("a token with every scope still cannot touch credentials (R1d)", () => {
    const allScopes = EffectArray.flatMap(SCOPE_AREAS, (a) => [
      `${a}:read` as const,
      `${a}:write` as const,
    ]);
    for (const action of SESSION_ONLY) {
      expect(can(member("owner", { scopes: allScopes }), action)).toBe(false);
      expect(can(member("owner"), action)).toBe(true);
    }
  });
});

// Action -> scope area and level, written out independently of src/policy/table.ts.
const SCOPES: Readonly<Record<Action, string>> = {
  "workspace.read": "workspace:read",
  "member.read": "members:read",
  "contact.read": "contacts:read",
  "priceList.read": "catalog:read",
  "document.read": "documents:read",
  "document.pdf": "documents:read",
  "document.history": "documents:read",
  "payment.read": "payments:read",
  "expense.read": "expenses:read",
  "expense.attachment.read": "expenses:read",
  "template.read": "templates:read",
  "share.read": "share:read",
  "report.run": "reports:read",
  "report.export": "reports:read",
  "contact.write": "contacts:write",
  "priceList.write": "catalog:write",
  "template.write": "templates:write",
  "schedule.write": "templates:write",
  "expense.write": "expenses:write",
  "document.draft": "documents:write",
  "document.issue": "documents:write",
  "document.edit": "documents:write",
  "document.cancel": "documents:write",
  "document.correct": "documents:write",
  "document.finalInvoice": "documents:write",
  "document.send": "documents:write",
  "document.lock": "documents:write",
  "share.write": "share:write",
  "payment.write": "payments:write",
  "document.unlock": "documents:write",
  "document.overrideNumber": "documents:write",
  "workspace.settings": "workspace:write",
  "member.invite": "members:write",
  "member.setRole": "members:write",
  "invitation.read": "members:read",
  "apiKey.manage": "members:write",
  "grant.read.all": "members:read",
  "grant.revoke.all": "members:write",
  "member.manageAdmins": "members:write",
  "workspace.transferOwnership": "workspace:write",
  "workspace.close": "workspace:write",
  "member.leave": "members:write",
  "grant.create": "members:write",
  "grant.read.own": "members:read",
  "grant.revoke.own": "members:write",
  "workspace.create": "workspace:write",
  "workspace.listMine": "workspace:read",
  "workspace.enter": "workspace:read",
  "invitation.accept": "members:write",
  "registry.lookup": "contacts:read",
  "share.open": "share:read",
  "share.pdf": "share:read",
  "share.logo": "share:read",
  "invitation.peek": "members:read",
};

describe("actionScope", () => {
  for (const action of ACTIONS) {
    test(action, () => {
      const { area, level } = actionScope(action);
      expect(`${area}:${level}`).toBe(SCOPES[action]);
    });
  }
});

describe("can: special rules", () => {
  test("R1c: only the owner manages admins", () => {
    expect(can(member("owner"), "member.manageAdmins")).toBe(true);
    expect(can(member("admin"), "member.manageAdmins")).toBe(false);
  });

  test("the accountant holds no write outside leave and own grants", () => {
    const accountant = member("accountant");
    const writes = EffectArray.filter(
      ACTIONS,
      (a) => can(accountant, a) && actionScope(a).level === "write",
    );
    expect(EffectArray.sort(writes, Order.String)).toEqual([
      "grant.create",
      "grant.revoke.own",
      "member.leave",
    ]);
  });

  test("System writes only issue and send; DataExport only reads (R4, R5)", () => {
    const delivery = system();
    const writes = EffectArray.filter(
      ACTIONS,
      (a) => can(delivery, a) && actionScope(a).level === "write",
    );
    expect(EffectArray.sort(writes, Order.String)).toEqual(["document.issue", "document.send"]);
    const exporter = system({
      _tag: "DataExport",
      exportId: ExportId.make("01900000-0000-7000-8000-00000000000e"),
    });
    expect(can(exporter, "document.read")).toBe(true);
    expect(can(exporter, "document.issue")).toBe(false);
    expect(can(exporter, "document.send")).toBe(false);
  });

  test("a sealed System caller's job cannot be changed afterwards", () => {
    const job = {
      _tag: "DataExport" as const,
      exportId: ExportId.make("01900000-0000-7000-8000-00000000000e"),
    };
    const exporter = system(job);
    Object.assign(job, { _tag: "RecurringIssuance" });
    expect(() => {
      Object.assign(exporter.job, { _tag: "RecurringIssuance" });
    }).toThrow();
    expect(can(exporter, "document.issue")).toBe(false);
  });

  test("an unsealed System caller is denied everything", () => {
    const caller = system();
    const forged = { ...caller };
    for (const action of ACTIONS) expect(can(forged, action)).toBe(false);
  });
});

describe("Policy enforcement", () => {
  test("authorize fails with Forbidden{action}", async () => {
    const exit = await runWithCaller(member("accountant"), authorize("contact.write"));
    expect(exit).toEqual(Exit.fail(Forbidden.make({ action: "contact.write" })));
  });

  test("authorizeInWorkspace returns the caller's Workspace", async () => {
    const caller = member("member");
    const exit = await runWithCaller(caller, authorizeInWorkspace("contact.write"));
    expect(exit).toEqual(Exit.succeed({ caller, workspaceId: caller.workspaceId }));
  });

  test("authorizeInWorkspace rejects non-Workspace callers", async () => {
    const exit = await runWithCaller(account(), authorizeInWorkspace("workspace.create"));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("authorize passes an allowed caller through", async () => {
    const exit = await runWithCaller(account(), Effect.asVoid(authorize("workspace.create")));
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});
