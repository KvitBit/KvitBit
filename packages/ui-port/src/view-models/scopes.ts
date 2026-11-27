/**
 * The shared scope picker of API Key creation (screen 21) and MCP OAuth consent (screen 05),
 * ui-port-contracts 8.21 and 8.5, over the ten `ScopeArea`s × {none, read, write}.
 *
 * Invariants: `<area>:write` implies `<area>:read`; nothing outside `grantable` is ever selected
 * (API Keys: the creator's role cap; consent: `offerableScopes` = expanded request ∩ role cap);
 * presets are offered only when their expansion fits `grantable`.
 */

import {
  type AccessMode,
  type AccessPreset,
  type AccessRequest,
  ALL_SCOPES,
  accessFromOAuthScopes,
  expandAccess,
  type GrantedAccess,
  normalizeScopes,
  type OAuthAccessScope,
  type OAuthScopeToken,
  oauthScopesForGrant,
  READ_SCOPES,
  SCOPE_AREAS,
  type Scope,
  type ScopeArea,
} from "@kvitbit/api-contract";
import type { Role } from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";

export type AreaLevel = "none" | "read" | "write";

export interface ScopePickerState {
  /** Presets are quick picks; `custom` uses `selected`. */
  readonly mode: AccessMode;
  readonly selected: ReadonlySet<Scope>;
  readonly grantable: ReadonlySet<Scope>;
}

const scopeOf = (area: ScopeArea, level: "read" | "write"): Scope => `${area}:${level}`;

/**
 * Scopes a role may put on an API Key or MCP grant (core R1d, http-mcp-contracts A2): owner,
 * admin and member any of the twenty (role ∩ scopes is still enforced per call by core R1);
 * accountant only the ten `<area>:read`. Who may create keys at all is `can(apiKey.manage)`.
 */
export const roleScopeCeiling = (role: Role): ReadonlySet<Scope> =>
  new Set(role === "accountant" ? READ_SCOPES : ALL_SCOPES);

const presetScopes = (preset: AccessPreset): ReadonlyArray<Scope> =>
  preset === "read" ? READ_SCOPES : ALL_SCOPES;

const fits = (scopes: Iterable<Scope>, grantable: ReadonlySet<Scope>): boolean => {
  for (const scope of scopes) if (!grantable.has(scope)) return false;
  return true;
};

/** Keeps only grantable scopes, then drops any write whose read is not kept. */
const cap = (scopes: Iterable<Scope>, grantable: ReadonlySet<Scope>): ReadonlySet<Scope> => {
  const kept = new Set(Arr.filter(normalizeScopes([...scopes]), (s) => grantable.has(s)));
  for (const area of SCOPE_AREAS) {
    if (kept.has(scopeOf(area, "write")) && !kept.has(scopeOf(area, "read"))) {
      kept.delete(scopeOf(area, "write"));
    }
  }
  return kept;
};

const levelIn = (scopes: ReadonlySet<Scope>, area: ScopeArea): AreaLevel =>
  scopes.has(scopeOf(area, "write"))
    ? "write"
    : scopes.has(scopeOf(area, "read"))
      ? "read"
      : "none";

/** The highest level `grantable` allows for an area (write needs both scopes grantable). */
const maxLevel = (grantable: ReadonlySet<Scope>, area: ScopeArea): AreaLevel =>
  grantable.has(scopeOf(area, "read"))
    ? grantable.has(scopeOf(area, "write"))
      ? "write"
      : "read"
    : "none";

const RANK: Record<AreaLevel, number> = { none: 0, read: 1, write: 2 };

/** The scopes the state grants: the preset's expansion or the custom selection, canonical order. */
export const effectiveScopes = (state: ScopePickerState): ReadonlyArray<Scope> =>
  state.mode === "custom" ? normalizeScopes(state.selected) : presetScopes(state.mode);

/** A preset is available only when its whole expansion is grantable. */
export const presetAvailable: {
  (preset: AccessPreset): (state: ScopePickerState) => boolean;
  (state: ScopePickerState, preset: AccessPreset): boolean;
} = Fn.dual(2, (state: ScopePickerState, preset: AccessPreset): boolean =>
  fits(presetScopes(preset), state.grantable),
);

export interface AreaRow {
  readonly area: ScopeArea;
  readonly level: AreaLevel;
  readonly readEnabled: boolean;
  readonly writeEnabled: boolean;
}

const toCustom = (state: ScopePickerState): ReadonlySet<Scope> =>
  state.mode === "custom" ? state.selected : cap(presetScopes(state.mode), state.grantable);

export const ScopePicker = {
  /** API Key create dialog: starts empty in custom mode, capped by `grantable`. */
  init: (grantable: Iterable<Scope>, initial?: AccessRequest): ScopePickerState => {
    const ceiling = new Set(grantable);
    const base: ScopePickerState = { mode: "custom", selected: new Set(), grantable: ceiling };
    return initial === undefined ? base : ScopePicker.fromRequest(base, initial);
  },
  /**
   * MCP consent: `grantable` becomes the offerable set (expanded request ∩ role cap), preselected
   * in full, in the requested preset mode when that preset fits, otherwise custom.
   */
  forConsent: (requested: GrantedAccess, roleGrantable: Iterable<Scope>): ScopePickerState => {
    const roleCap = new Set(roleGrantable);
    const offerable = cap(scopesOf(requested), roleCap);
    const state: ScopePickerState = { mode: "custom", selected: offerable, grantable: offerable };
    return requested.access !== "custom" && presetAvailable(state, requested.access)
      ? { ...state, mode: requested.access }
      : state;
  },
  /** Applies a request (e.g. a stored grant being edited) within the ceiling. */
  fromRequest: (state: ScopePickerState, request: AccessRequest): ScopePickerState => {
    if (request.access !== "custom" && presetAvailable(state, request.access)) {
      return { ...state, mode: request.access, selected: new Set(presetScopes(request.access)) };
    }
    return {
      ...state,
      mode: "custom",
      selected: cap(expandAccess(request).scopes, state.grantable),
    };
  },
  /** Picks a preset; ignored when its expansion exceeds `grantable` (the preset is disabled). */
  choosePreset: (state: ScopePickerState, preset: AccessPreset): ScopePickerState =>
    presetAvailable(state, preset)
      ? { ...state, mode: preset, selected: new Set(presetScopes(preset)) }
      : state,
  /** Switches to custom, keeping what the current preset grants. */
  chooseCustom: (state: ScopePickerState): ScopePickerState => ({
    ...state,
    mode: "custom",
    selected: toCustom(state),
  }),
  /** Sets an area's level, clamped to what `grantable` allows; switches to custom. */
  setArea: (state: ScopePickerState, area: ScopeArea, level: AreaLevel): ScopePickerState => {
    const max = maxLevel(state.grantable, area);
    const target = RANK[level] > RANK[max] ? max : level;
    const selected = new Set(toCustom(state));
    selected.delete(scopeOf(area, "read"));
    selected.delete(scopeOf(area, "write"));
    if (target !== "none") selected.add(scopeOf(area, "read"));
    if (target === "write") selected.add(scopeOf(area, "write"));
    return { ...state, mode: "custom", selected };
  },
  /**
   * Checkbox toggle: checking write also checks read; unchecking read also unchecks write.
   * Scopes outside `grantable` cannot be checked.
   */
  toggle: (state: ScopePickerState, scope: Scope): ScopePickerState => {
    const [areaText, level] = Str.split(scope, ":");
    const area = Arr.findFirst(SCOPE_AREAS, (candidate) => candidate === areaText);
    if (Option.isNone(area)) return state;
    const selectedArea = area.value;
    const current = levelIn(toCustom(state), selectedArea);
    const next: AreaLevel =
      level === "write"
        ? current === "write"
          ? "read"
          : "write"
        : current === "none"
          ? "read"
          : "none";
    if (RANK[next] > RANK[maxLevel(state.grantable, selectedArea)]) return state;
    return ScopePicker.setArea(state, selectedArea, next);
  },
  /** One row per area for the matrix view. */
  rows: (state: ScopePickerState): ReadonlyArray<AreaRow> => {
    const scopes = new Set(effectiveScopes(state));
    return Arr.map(SCOPE_AREAS, (area) => ({
      area,
      level: levelIn(scopes, area),
      readEnabled: state.grantable.has(scopeOf(area, "read")),
      writeEnabled: maxLevel(state.grantable, area) === "write",
    }));
  },
};

/** The expanded scope list a stored or requested access stands for. */
const scopesOf = (access: GrantedAccess): ReadonlyArray<Scope> =>
  access.access === "custom" ? normalizeScopes(access.scopes) : presetScopes(access.access);

/**
 * Presets map to `{ access }`; custom maps to `{ access: "custom", scopes }`, None while empty
 * (submit disabled).
 */
export const toAccessRequest = (state: ScopePickerState): Option.Option<AccessRequest> => {
  if (state.mode !== "custom") return Option.some({ access: state.mode });
  const [first, ...rest] = normalizeScopes(state.selected);
  return first === undefined
    ? Option.none()
    : Option.some({ access: "custom", scopes: [first, ...rest] });
};

/** Renders a stored grant as one row per area: none, read or write. */
export const describeAccess = (
  granted: GrantedAccess,
): ReadonlyArray<{ readonly area: ScopeArea; readonly level: AreaLevel }> => {
  const scopes = new Set(normalizeScopes(granted.scopes));
  return Arr.map(SCOPE_AREAS, (area) => ({ area, level: levelIn(scopes, area) }));
};

/** OAuth wire scopes for the picker's grant (`kvitbit:read`, `kvitbit:write` or per-area). */
export const toOAuthScopes = (state: ScopePickerState): ReadonlyArray<OAuthAccessScope> =>
  Option.match(toAccessRequest(state), {
    onNone: () => [],
    onSome: (request) => oauthScopesForGrant(expandAccess(request)),
  });

/** Parses an OAuth `scope` parameter into the access it asks for; None without Kvitbit scopes. */
export const fromOAuthScopes = (
  tokens: ReadonlyArray<OAuthScopeToken>,
): Option.Option<GrantedAccess> =>
  Option.map(Option.fromNullishOr(accessFromOAuthScopes(tokens)), (r) => r.access);

export interface ConsentDiff {
  /** Requested and granted. */
  readonly granted: ReadonlyArray<Scope>;
  /** Requested but not granted (narrowed by the user or the role cap). */
  readonly withheld: ReadonlyArray<Scope>;
  /** Granted without being requested; always empty for a valid consent. */
  readonly extra: ReadonlyArray<Scope>;
  readonly narrowed: boolean;
}

/** Compares what a client requested with what the picker grants. */
export const consentDiff: {
  (state: ScopePickerState): (requested: GrantedAccess) => ConsentDiff;
  (requested: GrantedAccess, state: ScopePickerState): ConsentDiff;
} = Fn.dual(2, (requested: GrantedAccess, state: ScopePickerState): ConsentDiff => {
  const wanted = scopesOf(requested);
  const given = effectiveScopes(state);
  const givenSet = new Set(given);
  const wantedSet = new Set(wanted);
  const withheld = Arr.filter(wanted, (s) => !givenSet.has(s));
  return {
    granted: Arr.filter(given, (s) => wantedSet.has(s)),
    withheld,
    extra: Arr.filter(given, (s) => !wantedSet.has(s)),
    narrowed: withheld.length > 0,
  };
});
