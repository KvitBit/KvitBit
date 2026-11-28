/**
 * The policy table of core-ports section 2.3 as data. Every `Action` has exactly one row, so
 * adding an action to the domain union fails typecheck until its permissions are decided here.
 */
import type { Action, Role, ScopeArea, ScopeLevel } from "@kvitbit/domain/contract";

/** Which caller kinds may hold an action, before scopes narrow a Member (rule R1). */
export interface ActionRule {
  /** The `ScopeArea` and level a scoped token must carry (rule R1). */
  readonly area: ScopeArea;
  readonly level: ScopeLevel;
  /** Member roles the role table grants. */
  readonly roles: ReadonlyArray<Role>;
  /** Session only (rule R1d): a Member whose `scopes` is not `"all"` never holds it. */
  readonly sessionOnly?: true;
  /** System callers (workflows, crons) may hold it (rules R4, R5). */
  readonly system?: true;
  /** The non-Member caller kind that holds it, if any. */
  readonly holder?: "Account" | "ShareLinkVisitor" | "InvitationHolder";
}

const ALL: ReadonlyArray<Role> = ["owner", "admin", "member", "accountant"];
const WRITERS: ReadonlyArray<Role> = ["owner", "admin", "member"];
const MANAGERS: ReadonlyArray<Role> = ["owner", "admin"];
const OWNER: ReadonlyArray<Role> = ["owner"];
const NONE: ReadonlyArray<Role> = [];

const read = (area: ScopeArea): ActionRule => ({ area, level: "read", roles: ALL, system: true });
const write = (area: ScopeArea, roles: ReadonlyArray<Role>): ActionRule => ({
  area,
  level: "write",
  roles,
});
const session = (level: ScopeLevel, roles: ReadonlyArray<Role>): ActionRule => ({
  area: "members",
  level,
  roles,
  sessionOnly: true,
});
const held = (
  holder: NonNullable<ActionRule["holder"]>,
  area: ScopeArea,
  level: ScopeLevel,
): ActionRule => ({ area, level, roles: NONE, holder });

export const POLICY = {
  // `*.read` and the other read-only actions: every Member role and System.
  "workspace.read": read("workspace"),
  "member.read": read("members"),
  "contact.read": read("contacts"),
  "priceList.read": read("catalog"),
  "document.read": read("documents"),
  "document.pdf": read("documents"),
  "document.history": read("documents"),
  "payment.read": read("payments"),
  "expense.read": read("expenses"),
  "expense.attachment.read": read("expenses"),
  "template.read": read("templates"),
  "share.read": read("share"),
  "report.run": read("reports"),
  "report.export": read("reports"),
  // Writes open to `member`.
  "contact.write": write("contacts", WRITERS),
  "priceList.write": write("catalog", WRITERS),
  "template.write": write("templates", WRITERS),
  "schedule.write": write("templates", WRITERS),
  "expense.write": write("expenses", WRITERS),
  "document.draft": write("documents", WRITERS),
  "document.issue": { ...write("documents", WRITERS), system: true },
  "document.edit": write("documents", WRITERS),
  "document.cancel": write("documents", WRITERS),
  "document.correct": write("documents", WRITERS),
  "document.finalInvoice": write("documents", WRITERS),
  "document.send": { ...write("documents", WRITERS), system: true },
  "document.lock": write("documents", WRITERS), // R1b: locking only restricts
  "share.write": write("share", WRITERS),
  "payment.write": write("payments", WRITERS),
  // owner and admin.
  "document.unlock": write("documents", MANAGERS),
  "document.overrideNumber": write("documents", MANAGERS),
  "workspace.settings": write("workspace", MANAGERS),
  "member.invite": write("members", MANAGERS),
  "member.setRole": write("members", MANAGERS),
  "invitation.read": { area: "members", level: "read", roles: MANAGERS },
  "apiKey.manage": session("write", MANAGERS),
  "grant.read.all": session("read", MANAGERS),
  "grant.revoke.all": session("write", MANAGERS),
  // owner only (R1c and workspace lifecycle).
  "member.manageAdmins": write("members", OWNER),
  "workspace.transferOwnership": write("workspace", OWNER),
  "workspace.close": write("workspace", OWNER),
  // Everyone but the owner (R3: the owner cannot leave).
  "member.leave": write("members", ["admin", "member", "accountant"]),
  // Any Member role, session only (R1d). The edge caps an accountant's grant to read-only.
  "grant.create": session("write", ALL),
  "grant.read.own": session("read", ALL),
  "grant.revoke.own": session("write", ALL),
  // Account caller.
  "workspace.create": held("Account", "workspace", "write"),
  "workspace.listMine": held("Account", "workspace", "read"),
  "workspace.enter": held("Account", "workspace", "read"),
  "invitation.accept": held("Account", "members", "write"),
  "registry.lookup": held("Account", "contacts", "read"),
  // ShareLinkVisitor caller (own token only; the module checks the token).
  "share.open": held("ShareLinkVisitor", "share", "read"),
  "share.pdf": held("ShareLinkVisitor", "share", "read"),
  "share.logo": held("ShareLinkVisitor", "share", "read"),
  // InvitationHolder caller (own token only).
  "invitation.peek": held("InvitationHolder", "members", "read"),
} satisfies { readonly [A in Action]: ActionRule };
