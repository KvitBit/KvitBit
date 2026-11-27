/**
 * Exhaustive check of the policy (`can`, `authorizeInWorkspace`, `checkMembershipChange`) against
 * the role × action matrix of docs/design/core-ports.md section 2.3, written out here as data
 * independently of src/policy/table.ts. Every domain below is enumerated in full and its size is
 * asserted, so a shrinking domain fails the test. Guarded by .agents/skills/verify-auth-policy.
 */
import { describe, expect, test } from "bun:test";
import type {
  Action,
  Caller,
  Role,
  Scope,
  ScopeArea,
  ScopeLevel,
  SystemCaller,
  SystemJob,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import {
  Action as ActionSchema,
  CurrentCaller,
  DeliveryId,
  DocumentId,
  ExportId,
  IsoDate,
  Role as RoleSchema,
  SCOPE_AREAS,
  ScheduleId,
  SystemJob as SystemJobSchema,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Formatter from "effect/Formatter";
import * as EffectRecord from "effect/Record";
import * as EffectString from "effect/String";
import { actionScope, can } from "../../src/contract";
import type { MembershipChange } from "../../src/policy";
import { authorizeInWorkspace, checkMembershipChange } from "../../src/policy";
import {
  account,
  invitationHolder,
  member,
  shareVisitor,
  system,
  WORKSPACE_A,
  WORKSPACE_B,
} from "../helpers/callers";

const ACTIONS: ReadonlyArray<Action> = ActionSchema.literals;
const ROLES: ReadonlyArray<Role> = ["owner", "admin", "member", "accountant"];
const AREAS: ReadonlyArray<ScopeArea> = SCOPE_AREAS;

// --- The oracle: core-ports.md section 2.3, as data --------------------------------------------

type Holder = "Account" | "ShareLinkVisitor" | "InvitationHolder";

interface SpecRow {
  /** docs/design/core-ports.md line of the table row. */
  readonly line: number;
  readonly actions: ReadonlyArray<Action>;
  readonly roles: ReadonlyArray<Role>;
  /** System column: every action of the row, none, or the listed ones (`issue`, `send` only). */
  readonly system: "all" | "none" | ReadonlyArray<Action>;
  readonly holder?: Holder;
}

const MANAGERS: ReadonlyArray<Role> = ["owner", "admin"];
const WRITERS: ReadonlyArray<Role> = ["owner", "admin", "member"];

const SPEC: ReadonlyArray<SpecRow> = [
  {
    line: 274,
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
    roles: ROLES,
    system: "all",
  },
  {
    line: 275,
    actions: [
      "contact.write",
      "priceList.write",
      "template.write",
      "schedule.write",
      "expense.write",
    ],
    roles: WRITERS,
    system: "none",
  },
  {
    line: 276,
    actions: [
      "document.draft",
      "document.issue",
      "document.edit",
      "document.cancel",
      "document.correct",
      "document.finalInvoice",
      "document.send",
      "document.lock",
      "share.write",
      "payment.write",
    ],
    roles: WRITERS,
    system: ["document.issue", "document.send"],
  },
  {
    line: 277,
    actions: ["document.unlock", "document.overrideNumber"],
    roles: MANAGERS,
    system: "none",
  },
  { line: 278, actions: ["workspace.settings"], roles: MANAGERS, system: "none" },
  {
    line: 279,
    actions: ["member.invite", "member.setRole", "invitation.read"],
    roles: MANAGERS,
    system: "none",
  },
  { line: 280, actions: ["member.manageAdmins"], roles: ["owner"], system: "none" },
  {
    line: 281,
    actions: ["member.leave"],
    roles: ["admin", "member", "accountant"],
    system: "none",
  },
  {
    line: 282,
    actions: ["apiKey.manage", "grant.read.all", "grant.revoke.all"],
    roles: MANAGERS,
    system: "none",
  },
  {
    line: 283,
    actions: ["grant.create", "grant.read.own", "grant.revoke.own"],
    roles: ROLES,
    system: "none",
  },
  {
    line: 284,
    actions: ["workspace.transferOwnership", "workspace.close"],
    roles: ["owner"],
    system: "none",
  },
  {
    line: 285,
    actions: [
      "workspace.create",
      "workspace.listMine",
      "workspace.enter",
      "invitation.accept",
      "registry.lookup",
    ],
    roles: [],
    system: "none",
    holder: "Account",
  },
  {
    line: 286,
    actions: ["share.open", "share.pdf", "share.logo"],
    roles: [],
    system: "none",
    holder: "ShareLinkVisitor",
  },
  {
    line: 287,
    actions: ["invitation.peek"],
    roles: [],
    system: "none",
    holder: "InvitationHolder",
  },
];

/** R1d (core-ports.md:295): `apiKey.*` and `grant.*` are session only. */
const isSessionOnly = (action: Action): boolean =>
  EffectString.startsWith("apiKey.")(action) || EffectString.startsWith("grant.")(action);

/**
 * The scope an action needs (R1, core-ports.md:291). Stated in the MCP tool table
 * (http-mcp-contracts.md:1319-1346) for the actions it lists; for the rest the area is the one
 * R1 names for the action's noun and the level follows the table row (row 274 and `*.read` are
 * reads, every other Workspace row writes).
 */
const AREA_OF_NOUN: Readonly<Record<string, ScopeArea>> = {
  workspace: "workspace",
  member: "members",
  invitation: "members",
  contact: "contacts",
  priceList: "catalog",
  document: "documents",
  payment: "payments",
  expense: "expenses",
  template: "templates",
  schedule: "templates",
  report: "reports",
  share: "share",
};
const READS = new Set<Action>([...(SPEC[0]?.actions ?? []), "invitation.read"]);
const scopeOf = (action: Action): { readonly area: ScopeArea; readonly level: ScopeLevel } => {
  const area = AREA_OF_NOUN[EffectString.split(action, ".")[0] ?? ""];
  if (area === undefined) throw new Error(`no scope area for ${action}`);
  return { area, level: READS.has(action) ? "read" : "write" };
};
// Session-only and edge-holder actions have no area: scopes never apply to them.
const SCOPE_OF = new Map(
  EffectArray.map(
    EffectArray.filter(
      ACTIONS,
      (a) => AREA_OF_NOUN[EffectString.split(a, ".")[0] ?? ""] !== undefined,
    ),
    (action) => [action, scopeOf(action)] as const,
  ),
);
const specScope = (action: Action) => SCOPE_OF.get(action) ?? scopeOf(action);

const rowOf = new Map<Action, SpecRow>(
  EffectArray.flatMap(SPEC, (row) => EffectArray.map(row.actions, (a) => [a, row])),
);
const specRow = (action: Action): SpecRow => {
  const row = rowOf.get(action);
  if (row === undefined) throw new Error(`spec has no row for ${action}`);
  return row;
};

/** Role table ∩ scopes (R1). Write covers read (core-ports.md:171, write implies read). */
const specMember = (role: Role, scopes: "all" | ReadonlySet<Scope>, action: Action): boolean => {
  if (!specRow(action).roles.includes(role)) return false;
  if (scopes === "all") return true;
  if (isSessionOnly(action)) return false;
  const { area, level } = specScope(action);
  return scopes.has(`${area}:write`) || (level === "read" && scopes.has(`${area}:read`));
};

/** System column of 2.3; R5: the DataExport job only reads; 2.1: unsealed callers hold nothing. */
const specSystem = (job: SystemJob["_tag"], sealed: boolean, action: Action): boolean => {
  if (!sealed) return false;
  const { system: jobs } = specRow(action);
  const allowed = jobs === "all" || (jobs !== "none" && jobs.includes(action));
  return allowed && (job !== "DataExport" || READS.has(action));
};

const specHolder = (holder: Holder, action: Action): boolean => specRow(action).holder === holder;

// --- Domains -----------------------------------------------------------------------------------

const ALL_SCOPES: ReadonlyArray<Scope> = EffectArray.flatMap(AREAS, (area) => [
  `${area}:read` as const,
  `${area}:write` as const,
]);

/** Grant `g` in base 3, one digit per area: 0 none, 1 read, 2 read and write. */
const GRANTS = 3 ** AREAS.length;
const grantScopes = (g: number): Array<Scope> => {
  const scopes: Array<Scope> = [];
  let rest = g;
  for (const area of AREAS) {
    const digit = rest % 3;
    rest = (rest - digit) / 3;
    if (digit >= 1) scopes.push(`${area}:read`);
    if (digit === 2) scopes.push(`${area}:write`);
  }
  return scopes;
};

/** Raw (unnormalized) states of one area: none, read, write only, read and write. */
const RAW: ReadonlyArray<ReadonlyArray<ScopeLevel>> = [[], ["read"], ["write"], ["read", "write"]];
const rawScopeSets = (): Array<Array<Scope>> => {
  const sets: Array<Array<Scope>> = [];
  for (const [i, firstArea] of AREAS.entries()) {
    for (const secondArea of AREAS.slice(i + 1)) {
      for (const a of RAW) {
        for (const b of RAW) {
          // Write first and read last, so no check can rely on canonical order.
          const scopes = [
            ...EffectArray.map(b, (level): Scope => `${secondArea}:${level}`),
            ...EffectArray.map(a, (level): Scope => `${firstArea}:${level}`),
          ].reverse();
          sets.push(scopes);
        }
      }
    }
  }
  return sets;
};

const JOBS: ReadonlyArray<SystemJob> = [
  {
    _tag: "RecurringIssuance",
    scheduleId: ScheduleId.make("01900000-0000-7000-8000-0000000e0001"),
    occurrence: IsoDate.make("2026-12-01"),
  },
  { _tag: "PaymentReminders", documentId: DocumentId.make("01900000-0000-7000-8000-0000000e0002") },
  { _tag: "DocumentDelivery", deliveryId: DeliveryId.make("01900000-0000-7000-8000-0000000e0003") },
  { _tag: "DataExport", exportId: ExportId.make("01900000-0000-7000-8000-0000000e0004") },
];

const WORKSPACES: ReadonlyArray<WorkspaceId> = [WORKSPACE_A, WORKSPACE_B];

/** Every non-Member caller kind with its oracle. */
const otherCallers = (): Array<{
  readonly name: string;
  readonly caller: Caller;
  readonly spec: (a: Action) => boolean;
}> => [
  { name: "Account", caller: account(), spec: (a) => specHolder("Account", a) },
  {
    name: "ShareLinkVisitor",
    caller: shareVisitor(),
    spec: (a) => specHolder("ShareLinkVisitor", a),
  },
  {
    name: "ShareLinkVisitor signed in",
    caller: shareVisitor({ signedInUser: member("owner").userId }),
    spec: (a) => specHolder("ShareLinkVisitor", a),
  },
  {
    name: "InvitationHolder",
    caller: invitationHolder(),
    spec: (a) => specHolder("InvitationHolder", a),
  },
  ...EffectArray.flatMap(JOBS, (job) => {
    const sealed: SystemCaller = system(job);
    return [
      {
        name: `System ${job._tag}`,
        caller: sealed,
        spec: (a: Action) => specSystem(job._tag, true, a),
      },
      {
        name: `System ${job._tag} unsealed copy`,
        caller: { ...sealed },
        spec: (a: Action) => specSystem(job._tag, false, a),
      },
    ];
  }),
];

/**
 * Every Caller variant, checked by the compiler: a new variant fails typecheck here until it is
 * added, and the test below fails until the enumeration builds a caller of that kind.
 */
const CALLER_TAGS = {
  Member: true,
  Account: true,
  ShareLinkVisitor: true,
  InvitationHolder: true,
  System: true,
} as const satisfies Record<Caller["_tag"], true>;

// --- Properties --------------------------------------------------------------------------------

describe("can: exhaustive against core-ports 2.3", () => {
  test("the domain has the expected size and covers every real Role, System job and Caller kind", () => {
    expect(ACTIONS.length).toBe(54);
    expect([...ROLES]).toEqual([...RoleSchema.literals]);
    const jobTags = EffectArray.map(SystemJobSchema.members, (m) => m.fields._tag.schema.literal);
    expect(EffectArray.map(JOBS, (job) => job._tag)).toEqual(jobTags);
    const kinds = new Set<string>([
      member("owner")._tag,
      ...EffectArray.map(otherCallers(), (c) => c.caller._tag),
    ]);
    expect(kinds).toEqual(new Set(EffectRecord.keys(CALLER_TAGS)));
    expect(AREAS.length).toBe(10);
    expect(ALL_SCOPES.length).toBe(20);
    expect(GRANTS).toBe(59_049);
    expect(rawScopeSets().length).toBe(45 * 16);
    expect(otherCallers().length).toBe(12);
    // The oracle covers every Action exactly once, and only real Actions.
    const listed = EffectArray.flatMap(SPEC, (row) => row.actions);
    expect(listed.length).toBe(ACTIONS.length);
    expect(new Set(listed)).toEqual(new Set(ACTIONS));
  });

  test("actionScope equals the spec's area and level for every scoped Action", () => {
    // Session-only (6) and edge-holder (9) Actions ignore scopes, so their area is not checked.
    const scoped = EffectArray.filter(
      [...SCOPE_OF],
      ([a]) => !isSessionOnly(a) && specRow(a).holder === undefined,
    );
    expect(scoped.length).toBe(ACTIONS.length - 6 - 9);
    for (const [action, scope] of scoped) {
      expect([action, actionScope(action)]).toEqual([action, scope]);
    }
  });

  // 12.7M can() calls: well past bun's 5 s default on a loaded or single-CPU runner.
  test("Member: every role × every normalized grant and session × every Action equals role ∩ scopes; monotone in scopes", () => {
    // One bit per Action, split in two words; index role * (GRANTS + 1) + grant, grant GRANTS = "all".
    const lo = new Uint32Array(ROLES.length * (GRANTS + 1));
    const hi = new Uint32Array(ROLES.length * (GRANTS + 1));
    const indexedActions = Array.from(ACTIONS.entries());
    let checked = 0;
    let mismatches: Array<string> = [];
    for (const [r, role] of ROLES.entries()) {
      for (let g = 0; g <= GRANTS; g++) {
        const list = g === GRANTS ? "all" : grantScopes(g);
        const caller = member(role, { scopes: list });
        const set = list === "all" ? "all" : new Set(list);
        let wlo = 0;
        let whi = 0;
        for (const [i, action] of indexedActions) {
          const got = can(caller, action);
          checked++;
          if (got !== specMember(role, set, action) && mismatches.length < 5) {
            mismatches.push(`${role} ${Formatter.format(list)} ${action}: can=${got}`);
          }
          if (got) {
            if (i < 32) wlo |= 1 << i;
            else whi |= 1 << (i - 32);
          }
        }
        lo[r * (GRANTS + 1) + g] = wlo;
        hi[r * (GRANTS + 1) + g] = whi;
      }
    }
    expect(checked).toBe(ROLES.length * (GRANTS + 1) * ACTIONS.length);
    expect(mismatches).toEqual([]);

    // Monotone: raising one area by one level never removes an Action (write implies read), and
    // no scoped grant holds an Action its role's session does not (scopes never widen a role).
    mismatches = [];
    for (const [r, role] of ROLES.entries()) {
      const base = r * (GRANTS + 1);
      const sessionLo = lo[base + GRANTS] ?? 0;
      const sessionHi = hi[base + GRANTS] ?? 0;
      for (let g = 0; g < GRANTS; g++) {
        const gl = lo[base + g] ?? 0;
        const gh = hi[base + g] ?? 0;
        if ((gl & ~sessionLo) !== 0 || (gh & ~sessionHi) !== 0) {
          mismatches.push(`${role} grant ${g} exceeds its session`);
        }
        let rest = g;
        for (const [k, area] of AREAS.entries()) {
          const digit = rest % 3;
          rest = (rest - digit) / 3;
          if (digit === 2) continue;
          const up = base + g + 3 ** k;
          if ((gl & ~(lo[up] ?? 0)) !== 0 || (gh & ~(hi[up] ?? 0)) !== 0) {
            mismatches.push(`${role} grant ${g}: raising ${area} loses an Action`);
          }
        }
        if (mismatches.length >= 5) break;
      }
    }
    expect(mismatches).toEqual([]);
  }, 300_000);

  test("Member: every role × every raw two-area scope set (write-only and any order) × every Action equals role ∩ scopes", () => {
    const sets = rawScopeSets();
    const mismatches: Array<string> = [];
    let checked = 0;
    for (const role of ROLES) {
      // Each pair in two orders (area i first, and fully reversed), plus every area write-only.
      const allWrites = EffectArray.map(AREAS, (area): Scope => `${area}:write`);
      const lists = [
        ...sets,
        ...EffectArray.map(sets, (l) => [...l].reverse()),
        allWrites,
        [...allWrites].reverse(),
      ];
      for (const scopes of lists) {
        const caller = member(role, { scopes });
        const set = new Set(scopes);
        for (const action of ACTIONS) {
          checked++;
          const got = can(caller, action);
          if (got !== specMember(role, set, action)) {
            mismatches.push(`${role} ${Formatter.format(scopes)} ${action}: can=${got}`);
          }
        }
      }
    }
    expect(checked).toBe(ROLES.length * (2 * 720 + 2) * ACTIONS.length);
    expect(mismatches.slice(0, 5)).toEqual([]);
  });

  // Wide bound: every raw scope list (each area none, read, write only, or both: 4^10), about
  // 226M calls and a minute of runtime, so it runs only with KVITBIT_FORMAL_WIDE=1 (nightly and
  // when moving the sync commit). It closes the gap between the two domains above.
  const wide = Effect.runSync(Config.String("KVITBIT_FORMAL_WIDE").pipe(Config.withDefault("0")));
  const wideTitle =
    "wide: Member, every role × every raw scope list (4^10) × every Action equals role ∩ scopes";
  if (wide === "1")
    test(wideTitle, () => {
      const meta = EffectArray.map(ACTIONS, (action) => {
        const scope = SCOPE_OF.get(action);
        const area = scope === undefined ? -1 : AREAS.indexOf(scope.area);
        return {
          action,
          roles: specRow(action).roles,
          scoped: scope !== undefined && !isSessionOnly(action),
          read: area < 0 ? 0 : 1 << (2 * area),
          write: area < 0 ? 0 : 1 << (2 * area + 1),
          readLevel: scope?.level === "read",
        };
      });
      const SUBSETS = 2 ** ALL_SCOPES.length;
      let checked = 0;
      const mismatches: Array<string> = [];
      for (let mask = 0; mask < SUBSETS; mask++) {
        const list = EffectArray.filter(ALL_SCOPES, (_, i) => ((mask >>> i) & 1) === 1);
        for (const role of ROLES) {
          const caller = member(role, { scopes: list });
          for (const m of meta) {
            checked++;
            const expected =
              m.roles.includes(role) &&
              m.scoped &&
              ((mask & m.write) !== 0 || (m.readLevel && (mask & m.read) !== 0));
            if (can(caller, m.action) !== expected && mismatches.length < 5) {
              mismatches.push(`${role} ${Formatter.format(list)} ${m.action}`);
            }
          }
        }
      }
      expect(checked).toBe(SUBSETS * ROLES.length * ACTIONS.length);
      expect(mismatches).toEqual([]);
    }, 600_000);

  test("Member: channel and client never change the answer (2 scope sets × 4 channels × 2 clients)", () => {
    const mismatches: Array<string> = [];
    let checked = 0;
    for (const role of ROLES) {
      for (const scopes of ["all", ALL_SCOPES] as const) {
        for (const channel of ["web", "mobile", "api", "mcp"] as const) {
          for (const client of [null, { kind: "mcp", id: "g-1", name: "Client" }] as const) {
            const caller = member(role, {
              scopes,
              channel,
              client,
            });
            const set = scopes === "all" ? "all" : new Set(scopes);
            for (const action of ACTIONS) {
              checked++;
              if (can(caller, action) !== specMember(role, set, action)) {
                mismatches.push(
                  `${role} ${channel} ${client === null ? "session" : "client"} ${action}`,
                );
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(4 * 2 * 4 * 2 * ACTIONS.length);
    expect(mismatches).toEqual([]);
  });

  test("non-Member callers hold exactly their column; no caller kind escalates", () => {
    const mismatches: Array<string> = [];
    for (const { name, caller, spec } of otherCallers()) {
      for (const action of ACTIONS) {
        const got = can(caller, action);
        if (got !== spec(action)) mismatches.push(`${name} ${action}: can=${got}`);
        // No Workspace caller holds an edge-holder action, and no holder a Workspace action.
        if (got && caller._tag === "System" && specRow(action).holder !== undefined) {
          mismatches.push(`${name} holds holder action ${action}`);
        }
      }
    }
    for (const role of ROLES) {
      for (const action of ACTIONS) {
        if (specRow(action).holder !== undefined && can(member(role), action)) {
          mismatches.push(`${role} session holds holder action ${action}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});

// --- Workspace scoping (R2, R4) ----------------------------------------------------------------

const outcomeOf = <A, E>(effect: Effect.Effect<A, E>): A | E =>
  Effect.runSync(
    Effect.match(effect, { onFailure: (error) => error, onSuccess: (value) => value }),
  );

describe("authorizeInWorkspace: a caller is only ever scoped to its own Workspace", () => {
  test("every caller kind × both Workspaces × every Action", () => {
    const callers: Array<Caller> = [
      ...EffectArray.flatMap(WORKSPACES, (workspaceId) => [
        ...EffectArray.flatMap(ROLES, (role) => [
          member(role, { workspaceId }),
          member(role, { workspaceId, scopes: ALL_SCOPES }),
          member(role, { workspaceId, scopes: [] }),
        ]),
        ...EffectArray.map(JOBS, (job) => system(job, workspaceId)),
      ]),
      ...EffectArray.map(otherCallers(), (c) => c.caller),
    ];
    expect(callers.length).toBe(2 * (4 * 3 + 4) + 12);
    const mismatches: Array<string> = [];
    for (const caller of callers) {
      for (const action of ACTIONS) {
        const result = outcomeOf(
          Effect.provideService(authorizeInWorkspace(action), CurrentCaller, caller),
        );
        const inWorkspace = caller._tag === "Member" || caller._tag === "System";
        const expected = inWorkspace && can(caller, action);
        const label = `${caller._tag} ${action}`;
        if (expected) {
          if (!("workspaceId" in result)) {
            mismatches.push(`${label}: denied`);
          } else if (result.caller !== caller || result.workspaceId !== caller.workspaceId) {
            mismatches.push(`${label}: scoped to ${result.workspaceId}`);
          }
        } else if (!("_tag" in result) || result._tag !== "Forbidden" || result.action !== action) {
          mismatches.push(
            `${label}: expected Forbidden{${action}}, got ${Formatter.format(result)}`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});

// --- Membership changes (R1c, R3) --------------------------------------------------------------

describe("checkMembershipChange: exhaustive against R1c and R3", () => {
  const CHANGES: ReadonlyArray<MembershipChange> = [
    { _tag: "Leave" },
    ...EffectArray.map(ROLES, (role): MembershipChange => ({ _tag: "Invite", role })),
    ...EffectArray.map(ROLES, (targetRole): MembershipChange => ({ _tag: "Remove", targetRole })),
    ...EffectArray.flatMap(ROLES, (targetRole) =>
      EffectArray.map(ROLES, (role): MembershipChange => ({ _tag: "SetRole", targetRole, role })),
    ),
  ];
  const MEMBER_SCOPES: ReadonlyArray<"all" | ReadonlyArray<Scope>> = [
    "all",
    [],
    ["members:read"],
    ["members:write"],
    ["members:read", "members:write"],
    ["documents:write"],
  ];

  test("every caller × every change", () => {
    expect(CHANGES.length).toBe(1 + 4 + 4 + 16);
    const callers: Array<{ readonly caller: Caller; readonly holds: (a: Action) => boolean }> = [
      ...EffectArray.flatMap(ROLES, (role) =>
        EffectArray.map(MEMBER_SCOPES, (scopes) => ({
          caller: member(role, { scopes }),
          holds: (a: Action) => specMember(role, scopes === "all" ? "all" : new Set(scopes), a),
        })),
      ),
      ...EffectArray.map(otherCallers(), ({ caller, spec }) => ({ caller, holds: spec })),
    ];
    expect(callers.length).toBe(4 * 6 + 12);
    const mismatches: Array<string> = [];
    for (const { caller, holds } of callers) {
      const isOwner = caller._tag === "Member" && caller.role === "owner";
      for (const change of CHANGES) {
        const got = outcomeOf(checkMembershipChange(caller, change));
        // Allowed and acceptable denials, from R1c (core-ports.md:294) and R3 (:298).
        let allowed: boolean;
        let denials: Array<string>;
        const manage = holds("member.manageAdmins");
        switch (change._tag) {
          case "Leave":
            allowed = holds("member.leave");
            // R3: the owner cannot leave; a token without members:write is refused by R1 first.
            denials =
              isOwner && coversMembersWrite(caller)
                ? ["Conflict:illegal_transition:member.owner_cannot_leave"]
                : ["Forbidden:member.leave"];
            break;
          case "Invite": {
            const base = holds("member.invite");
            allowed = base && change.role !== "owner" && (change.role !== "admin" || manage);
            denials = !base
              ? ["Forbidden:member.invite"]
              : change.role === "owner"
                ? ["Conflict:illegal_transition:"]
                : ["Forbidden:member.manageAdmins"];
            break;
          }
          case "Remove":
          case "SetRole": {
            const base = holds("member.setRole");
            const next = change._tag === "SetRole" ? change.role : undefined;
            const touchesOwner = change.targetRole === "owner" || next === "owner";
            const touchesAdmin = change.targetRole === "admin" || next === "admin";
            allowed = base && !touchesOwner && (!touchesAdmin || manage);
            denials = !base
              ? ["Forbidden:member.setRole"]
              : touchesOwner && touchesAdmin && !manage
                ? ["Conflict:illegal_transition:", "Forbidden:member.manageAdmins"]
                : touchesOwner
                  ? ["Conflict:illegal_transition:"]
                  : ["Forbidden:member.manageAdmins"];
            break;
          }
        }
        const label = `${caller._tag}${caller._tag === "Member" ? ` ${caller.role} ${Formatter.format(caller.scopes)}` : ""} ${Formatter.format(change)}`;
        if (allowed) {
          if (got !== undefined)
            mismatches.push(`${label}: expected ok, got ${Formatter.format(got)}`);
          continue;
        }
        const key =
          got !== undefined
            ? got._tag === "Forbidden"
              ? `Forbidden:${got.action}`
              : `${got._tag}:${got.reason}:${got.detail ?? ""}`
            : "ok";
        if (!denials.includes(key)) {
          mismatches.push(`${label}: expected ${EffectArray.join(denials, " or ")}, got ${key}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});

/** Whether a Member's scopes cover `members:write` (R1; sessions hold every scope). */
const coversMembersWrite = (caller: Caller): boolean =>
  caller._tag === "Member" && (caller.scopes === "all" || caller.scopes.includes("members:write"));
