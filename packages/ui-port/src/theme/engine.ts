/**
 * Theme sources to effective app theme (spec 4.1, 4.2, 4.4): the `ThemeEngine` seam with its
 * pure local default, Android 12+ dynamic colour input, `ThemeState` and `effectiveTheme`.
 */
import {
  type Hex,
  M3_COLOR_ROLES,
  type M3ColorRole,
  type ResolvedTheme,
  type ThemeContrast,
  type ThemeMode,
  type ThemeSource,
  type ThemeStyle,
} from "@kvitbit/api-contract";
import { Invalid } from "@kvitbit/domain/contract";
import { Context, Effect, Layer, Option, Result } from "effect";
import { isHex } from "./color/utils";
import { CHECKED_ROLE_PAIRS, withContrast } from "./contrast-check";
import { type ExtendedScheme, extendedScheme } from "./extended";
import { resolveMaterialTheme } from "./material-theme-json";
import { KvitbitDefaultTheme, resolvePreset, resolveSeed, seedRecipe } from "./resolve";
import { type RoleMap, type SchemeVariant, schemeRoles, variantOf } from "./scheme";
import { StyleTokens } from "./style-tokens";

// Resolution ---------------------------------------------------------------------------------

const seedInvalid = () => new Invalid({ issues: [{ path: ["seed"], code: "theme.seed_invalid" }] });

/** Any source to a `ResolvedTheme`; a malformed seed or Theme Builder file fails with `Invalid`. */
export const resolveSource = (source: ThemeSource): Result.Result<ResolvedTheme, Invalid> => {
  switch (source._tag) {
    case "Preset":
      return Result.succeed(resolvePreset(source.id));
    case "Seed":
      return isHex(source.seed)
        ? Result.succeed(resolveSeed(source.seed))
        : Result.fail(seedInvalid());
    case "MaterialThemeBuilder":
      return resolveMaterialTheme(source.json);
  }
};

export interface ExtendedPair {
  readonly light: ExtendedScheme;
  readonly dark: ExtendedScheme;
}

/** Extended colours harmonized toward an arbitrary primary pair, e.g. the dynamic system primary. */
export const harmonizeExtended = (
  primary: { readonly light: Hex; readonly dark: Hex },
  contrast: ThemeContrast,
): ExtendedPair => ({
  light: extendedScheme(primary.light, variantOf("light", contrast)),
  dark: extendedScheme(primary.dark, variantOf("dark", contrast)),
});

// Android dynamic colour -----------------------------------------------------------------------

/**
 * What the `SystemTheme` port reads on Android 12+: the system's role maps (any subset; libraries
 * differ in which roles they expose) or just its seed / accent colour.
 */
export type DynamicColorInput =
  | {
      readonly _tag: "Roles";
      readonly light: Partial<Record<M3ColorRole, string>>;
      readonly dark: Partial<Record<M3ColorRole, string>>;
    }
  | { readonly _tag: "Seed"; readonly seed: Hex };

export interface DynamicRoles {
  readonly light: RoleMap;
  readonly dark: RoleMap;
}

const pickValid = (m: Partial<Record<M3ColorRole, string>>): Partial<Record<M3ColorRole, Hex>> => {
  const out: Partial<Record<M3ColorRole, Hex>> = {};
  for (const role of M3_COLOR_ROLES) {
    const v = m[role];
    if (v !== undefined && isHex(v)) out[role] = v.toUpperCase() as Hex;
  }
  return out;
};

/**
 * Complete dynamic role maps. System roles win; roles the platform omits come from a scheme
 * generated from the system primary (or seed), so the palette stays coherent. A generated
 * foreground whose system background was supplied is moved until it reaches AA against it.
 * A malformed seed fails with `theme.seed_invalid`.
 */
export const dynamicRoles = (input: DynamicColorInput): Result.Result<DynamicRoles, Invalid> => {
  if (input._tag === "Seed") {
    if (!isHex(input.seed)) return Result.fail(seedInvalid());
    const recipe = seedRecipe(input.seed);
    return Result.succeed({
      light: schemeRoles(recipe, "light"),
      dark: schemeRoles(recipe, "dark"),
    });
  }
  const light = pickValid(input.light);
  const dark = pickValid(input.dark);
  const seed = light.primary ?? dark.primary ?? KvitbitDefaultTheme.schemes.light.roles.primary;
  const recipe = seedRecipe(seed);
  const complete = (variant: "light" | "dark", system: Partial<Record<M3ColorRole, Hex>>) => {
    const roles: Record<M3ColorRole, Hex> = { ...schemeRoles(recipe, variant), ...system };
    for (const pair of CHECKED_ROLE_PAIRS)
      if (system[pair.foreground] === undefined && system[pair.background] !== undefined)
        roles[pair.foreground] = withContrast(
          roles[pair.foreground],
          roles[pair.background],
          pair.required,
        ) as Hex;
    return roles;
  };
  return Result.succeed({ light: complete("light", light), dark: complete("dark", dark) });
};

/**
 * Roles for any variant of a dynamic scheme. The system supplies only standard light and dark;
 * medium and high move each system colour by the tone step the generated scheme takes, keeping
 * its hue and chroma.
 */
export const dynamicSchemeRoles = (dynamic: DynamicRoles, variant: SchemeVariant): RoleMap =>
  schemeRoles(
    { seed: dynamic.light.primary, overrides: { light: dynamic.light, dark: dynamic.dark } },
    variant,
  );

// ThemeEngine seam -----------------------------------------------------------------------------

/**
 * Spec 4.4 port. The default layer is the pure local engine; a server-backed layer
 * (`POST /api/v1/themes/resolve`) can replace it without touching callers.
 */
export class ThemeEngine extends Context.Service<
  ThemeEngine,
  {
    /** Seeds, presets and Theme Builder files to a full `ResolvedTheme` (all six schemes). */
    readonly resolve: (
      source: ThemeSource,
      contrast: ThemeContrast,
    ) => Effect.Effect<ResolvedTheme, Invalid>;
    /** Harmonized extended colours against an arbitrary primary (Android dynamic colour). */
    readonly harmonizeExtended: (
      primary: { readonly light: Hex; readonly dark: Hex },
      contrast: ThemeContrast,
    ) => Effect.Effect<ExtendedPair>;
  }
>()("ui-port/ThemeEngine") {}

/**
 * The pure engine as a layer. `contrast` does not change `resolve`'s result: a `ResolvedTheme`
 * always carries all six schemes, and `effectiveTheme` picks the variant.
 */
export const LocalThemeEngine: Layer.Layer<ThemeEngine> = Layer.succeed(ThemeEngine, {
  resolve: (source) =>
    Result.match(resolveSource(source), { onSuccess: Effect.succeed, onFailure: Effect.fail }),
  harmonizeExtended: (primary, contrast) => Effect.sync(() => harmonizeExtended(primary, contrast)),
});

// ThemeState and effectiveTheme -----------------------------------------------------------------

/**
 * An editor preview. Appearance previews an account theme and/or a style; Branding previews a
 * Workspace theme and never carries a style (Workspace branding has none).
 */
export type ThemeDraft =
  | {
      readonly _tag: "Appearance";
      /** None previews only the style over the current colour source. */
      readonly theme: Option.Option<ResolvedTheme>;
      readonly style: ThemeStyle;
    }
  | { readonly _tag: "Branding"; readonly theme: ResolvedTheme };

/**
 * Spec 4.2, with one simplification: the spec's `dynamicExtended: Remote<...>` is not stored,
 * because the local engine harmonizes the dynamic primary synchronously inside `effectiveTheme`.
 */
export interface ThemeState {
  readonly preference: {
    readonly mode: ThemeMode;
    readonly style: ThemeStyle;
    readonly contrast: ThemeContrast;
    readonly dynamicColor: boolean;
    readonly source: Option.Option<ThemeSource>;
  };
  readonly system: {
    readonly scheme: "light" | "dark";
    readonly highContrast: boolean;
    readonly dynamic: Option.Option<DynamicRoles>;
  };
  readonly account: Option.Option<ResolvedTheme>;
  readonly workspace: Option.Option<ResolvedTheme>;
  readonly draft: Option.Option<ThemeDraft>;
}

export type ThemeOrigin = "dynamic" | "account" | "workspace" | "default" | "draft";

export interface EffectiveTheme {
  readonly scheme: "light" | "dark";
  readonly contrast: ThemeContrast;
  readonly origin: ThemeOrigin;
  readonly roles: RoleMap;
  readonly extended: ExtendedScheme;
  readonly style: ThemeStyle;
  readonly tokens: StyleTokens;
  /** The resolved theme behind `roles` (None for dynamic colour). */
  readonly theme: Option.Option<ResolvedTheme>;
}

const CONTRAST_RANK: Readonly<Record<ThemeContrast, number>> = { standard: 0, medium: 1, high: 2 };

/** `preference.contrast`, raised to at least `medium` when the OS asks for more contrast. */
export const effectiveContrast = (
  preferred: ThemeContrast,
  systemHighContrast: boolean,
): ThemeContrast =>
  systemHighContrast && CONTRAST_RANK[preferred] < CONTRAST_RANK.medium ? "medium" : preferred;

/** Which source wins: draft > dynamic colour (when on and available) > account > workspace > default. */
export const pickThemeSource = (
  state: ThemeState,
):
  | { readonly origin: "dynamic"; readonly dynamic: DynamicRoles }
  | { readonly origin: Exclude<ThemeOrigin, "dynamic">; readonly theme: ResolvedTheme } => {
  const draft = Option.getOrUndefined(state.draft);
  const draftTheme =
    draft === undefined
      ? undefined
      : draft._tag === "Branding"
        ? draft.theme
        : Option.getOrUndefined(draft.theme);
  if (draftTheme !== undefined) return { origin: "draft", theme: draftTheme };
  const dynamic = Option.getOrUndefined(state.system.dynamic);
  if (state.preference.dynamicColor && dynamic !== undefined) return { origin: "dynamic", dynamic };
  const account = Option.getOrUndefined(state.account);
  if (account !== undefined) return { origin: "account", theme: account };
  const workspace = Option.getOrUndefined(state.workspace);
  if (workspace !== undefined) return { origin: "workspace", theme: workspace };
  return { origin: "default", theme: KvitbitDefaultTheme };
};

/** Pure. Adapters apply the result: CSS variables on web, a theme object on mobile. */
export const effectiveTheme = (state: ThemeState): EffectiveTheme => {
  const scheme = state.preference.mode === "system" ? state.system.scheme : state.preference.mode;
  const contrast = effectiveContrast(state.preference.contrast, state.system.highContrast);
  const draft = Option.getOrUndefined(state.draft);
  const style = draft?._tag === "Appearance" ? draft.style : state.preference.style;
  const tokens = StyleTokens[style];
  const picked = pickThemeSource(state);
  if (picked.origin === "dynamic") {
    const variant = variantOf(scheme, contrast);
    const roles = dynamicSchemeRoles(picked.dynamic, variant);
    return {
      scheme,
      contrast,
      origin: "dynamic",
      roles,
      extended: extendedScheme(roles.primary, variant),
      style,
      tokens,
      theme: Option.none(),
    };
  }
  const resolved = picked.theme.schemes[variantOf(scheme, contrast)];
  return {
    scheme,
    contrast,
    origin: picked.origin,
    roles: resolved.roles,
    extended: resolved.extended,
    style,
    tokens,
    theme: Option.some(picked.theme),
  };
};

/** A `ThemeState` with defaults: system mode, elegant, standard contrast, dynamic colour on. */
export const initialThemeState = (system: Partial<ThemeState["system"]> = {}): ThemeState => ({
  preference: {
    mode: "system",
    style: "elegant",
    contrast: "standard",
    dynamicColor: true,
    source: Option.none(),
  },
  system: { scheme: "light", highContrast: false, dynamic: Option.none(), ...system },
  account: Option.none(),
  workspace: Option.none(),
  draft: Option.none(),
});
