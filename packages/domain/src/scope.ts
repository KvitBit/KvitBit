/**
 * Scope vocabulary (core-ports section 2.1, http-mcp-contracts section 2.2).
 * Core scopes are `<area>:<level>`; the OAuth wire form `kvitbit:<area>:<level>` is an edge
 * concern and maps one to one.
 */
import * as Schema from "effect/Schema";

/** The ten permission areas of rule R1. */
export const SCOPE_AREAS = [
  "workspace",
  "members",
  "contacts",
  "catalog",
  "documents",
  "payments",
  "expenses",
  "templates",
  "reports",
  "share",
] as const;

export const ScopeArea = Schema.Literals(SCOPE_AREAS);
export type ScopeArea = typeof ScopeArea.Type;

export const ScopeLevel = Schema.Literals(["read", "write"]);
export type ScopeLevel = typeof ScopeLevel.Type;

/** e.g. "documents:write"; write implies read at grant time. */
export const Scope = Schema.TemplateLiteral([ScopeArea, ":", ScopeLevel]);
export type Scope = typeof Scope.Type;
