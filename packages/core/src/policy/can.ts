/**
 * The pure policy (core-ports 2.3): `can(caller, action)`. Exported from `@kvitbit/core/contract`
 * so ui-port hides controls with the same table the core enforces.
 */
import type { Action, Caller, MemberCaller, ScopeArea, ScopeLevel } from "@kvitbit/domain/contract";
import { isSealedSystem } from "../internal/system";
import { POLICY } from "./table";

/** The scope a token must carry for an action (rule R1). Write implies read. */
export const actionScope = (
  action: Action,
): { readonly area: ScopeArea; readonly level: ScopeLevel } => {
  const rule = POLICY[action];
  return { area: rule.area, level: rule.level };
};

/** Whether a Member's scopes cover `area` at `level` (session callers hold every scope). */
export const scopesAllow = (caller: MemberCaller, area: ScopeArea, level: ScopeLevel): boolean => {
  if (caller.scopes === "all") return true;
  return caller.scopes.some(
    (scope) => scope === `${area}:write` || (level === "read" && scope === `${area}:read`),
  );
};

export const can = (caller: Caller, action: Action): boolean => {
  const rule = POLICY[action];
  switch (caller._tag) {
    case "Member":
      if (!rule.roles.includes(caller.role)) return false;
      if (rule.sessionOnly) return caller.scopes === "all";
      return scopesAllow(caller, rule.area, rule.level);
    case "System":
      // R5: the DataExport job only reads.
      if (!isSealedSystem(caller) || rule.system !== true) return false;
      return caller.job._tag !== "DataExport" || rule.level === "read";
    case "Account":
    case "ShareLinkVisitor":
    case "InvitationHolder":
      return rule.holder === caller._tag;
  }
};
