/**
 * Platform adapters' input (spec 4.6): CSS custom properties for Foldkit Web and a plain token
 * object for the Expo M3 kit. Both are data; applying them is the app's job.
 */

import {
  EXTENDED_ROLES,
  type ExtendedRole,
  M3_COLOR_ROLES,
  type ResolvedTheme,
  type ThemeStyle,
} from "@kvitbit/api-contract";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import type { EffectiveTheme } from "./engine";
import type { ExtendedScheme } from "./extended";
import type { RoleMap, SchemeVariant } from "./scheme";
import {
  FONT_FALLBACKS,
  familyOf,
  OPERATE_SCALE_NAMES,
  type StyleTokens,
  StyleTokens as StyleTokensByStyle,
  TYPE_SCALE_NAMES,
  type TypeStyle,
} from "./style-tokens";

export type CssVariables = Readonly<Record<`--${string}`, string>>;

const kebab = (s: string): string => {
  let result = "";
  for (const char of s) {
    result += char >= "A" && char <= "Z" ? `-${Str.toLowerCase(char)}` : char;
  }
  return result;
};

/** `--md-sys-color-<role-kebab>` for every M3 role (spec 4.6, DESIGN.md). */
export const roleVariables = (roles: RoleMap): CssVariables => {
  const out: Record<`--${string}`, string> = {};
  for (const role of M3_COLOR_ROLES) out[`--md-sys-color-${kebab(role)}`] = roles[role];
  return out;
};

/** `--kb-color-paid`, `--kb-color-on-paid`, `--kb-color-paid-container`, `--kb-color-on-paid-container`, ... */
export const extendedVariables = (extended: ExtendedScheme): CssVariables => {
  const out: Record<`--${string}`, string> = {};
  for (const role of EXTENDED_ROLES) {
    const e = extended[role];
    out[`--kb-color-${role}`] = e.color;
    out[`--kb-color-on-${role}`] = e.onColor;
    out[`--kb-color-${role}-container`] = e.colorContainer;
    out[`--kb-color-on-${role}-container`] = e.onColorContainer;
  }
  return out;
};

export const colorVariables = (scheme: {
  readonly roles: RoleMap;
  readonly extended: ExtendedScheme;
}): CssVariables => ({ ...roleVariables(scheme.roles), ...extendedVariables(scheme.extended) });

const px = (n: number): string => (n === 0 ? "0" : `${n}px`);
const rem = (n: number): string => `${n / 16}rem`;
const WHITESPACE = /\s/;
const quoted = (family: string): string => (WHITESPACE.test(family) ? `"${family}"` : family);

/** Fonts, numerals, shape and both type scales as `--kb-*` variables. */
export const styleVariables: {
  (tokens?: StyleTokens): (style: ThemeStyle) => CssVariables;
  (style: ThemeStyle, tokens?: StyleTokens): CssVariables;
} = Fn.dual(
  (args) => Predicate.isString(args[0]),
  (style: ThemeStyle, tokens: StyleTokens = StyleTokensByStyle[style]): CssVariables => {
    const fallback = FONT_FALLBACKS[style];
    const baseVariables = {
      "--kb-font-display": `${quoted(tokens.font.display.family)}, ${fallback.display}`,
      "--kb-font-body": `${quoted(tokens.font.body.family)}, ${fallback.body}`,
      "--kb-font-mono": `${quoted(tokens.font.mono.family)}, ${fallback.mono}`,
      "--kb-font-display-weight": String(tokens.font.display.weight),
      "--kb-font-numeric-settings": tokens.font.numericFeatureSettings,
      "--kb-font-numeric-variant": tokens.font.tabularNumerals
        ? "lining-nums tabular-nums"
        : "normal",
      "--kb-shape-panel": px(tokens.shape.panel),
      "--kb-shape-control": px(tokens.shape.control),
      "--kb-shape-badge": px(tokens.shape.badge),
      "--kb-panel-border-width": px(tokens.panelBorder),
    };
    const typeVariables: Record<`--${string}`, string> = {};
    const typeVars = (prefix: string, name: string, s: TypeStyle) => {
      const base: `--${string}` = `--kb-${prefix}-${kebab(name)}`;
      typeVariables[`${base}-font`] = `var(--kb-font-${s.font})`;
      typeVariables[`${base}-weight`] = String(s.weight);
      typeVariables[`${base}-size`] = rem(s.size);
      typeVariables[`${base}-line-height`] = rem(s.lineHeight);
      typeVariables[`${base}-tracking`] = px(s.letterSpacing);
    };
    for (const name of TYPE_SCALE_NAMES) typeVars("type", name, tokens.typeScale[name]);
    for (const name of OPERATE_SCALE_NAMES) typeVars("operate", name, tokens.operateScale[name]);
    return { ...baseVariables, ...typeVariables };
  },
);

/** All variables for an effective theme (one scheme + its style). */
export const cssVariables = (theme: EffectiveTheme): CssVariables => ({
  ...colorVariables(theme),
  ...styleVariables(theme.style, theme.tokens),
});

export const cssDeclarations: {
  (indent?: string): (vars: CssVariables) => string;
  (vars: CssVariables, indent?: string): string;
} = Fn.dual(
  (args) => Predicate.isObjectOrArray(args[0]),
  (vars: CssVariables, indent = "  "): string =>
    Arr.join(
      Arr.map(Rec.toEntries(vars), ([k, v]) => `${indent}${k}: ${v};`),
      "\n",
    ),
);

const rule = (selector: string, vars: CssVariables, indent = ""): string =>
  `${indent}${selector} {\n${cssDeclarations(vars, `${indent}  `)}\n${indent}}`;

/**
 * SSR stylesheet with every scheme of a resolved theme, so first paint never flashes:
 * `data-theme="light|dark"` forces a mode (absent follows `prefers-color-scheme`),
 * `data-contrast="medium|high"` picks a contrast set and `prefers-contrast: more` raises
 * standard to medium. Selectors are ordered and weighted so the most specific choice wins.
 */
export const themeStylesheet: {
  (style: ThemeStyle, root?: string): (theme: ResolvedTheme) => string;
  (theme: ResolvedTheme, style: ThemeStyle, root?: string): string;
} = Fn.dual(
  (args) => Predicate.isObjectOrArray(args[0]),
  (theme: ResolvedTheme, style: ThemeStyle, root = ":root"): string => {
    const c = (v: SchemeVariant) => colorVariables(theme.schemes[v]);
    const styleVars: CssVariables = styleVariables(style);
    const sysDark = `${root}:not([data-theme="light"])`;
    const dark = `${root}[data-theme="dark"]`;
    const notHigh = ':not([data-contrast="high"])';
    return Arr.join(
      [
        rule(root, { ...c("light"), ...styleVars }),
        rule(`${root}[data-contrast="medium"]`, c("lightMedium")),
        rule(`${root}[data-contrast="high"]`, c("lightHigh")),
        rule(dark, c("dark")),
        rule(`${dark}[data-contrast="medium"]`, c("darkMedium")),
        rule(`${dark}[data-contrast="high"]`, c("darkHigh")),
        `@media (prefers-color-scheme: dark) {\n${Arr.join(
          [
            rule(sysDark, c("dark"), "  "),
            rule(`${sysDark}[data-contrast="medium"]`, c("darkMedium"), "  "),
            rule(`${sysDark}[data-contrast="high"]`, c("darkHigh"), "  "),
          ],
          "\n",
        )}\n}`,
        `@media (prefers-contrast: more) {\n${Arr.join(
          [
            rule(`${root}${notHigh}`, c("lightMedium"), "  "),
            rule(`${dark}${notHigh}`, c("darkMedium"), "  "),
          ],
          "\n",
        )}\n}`,
        `@media (prefers-color-scheme: dark) and (prefers-contrast: more) {\n${rule(
          `${sysDark}${notHigh}`,
          c("darkMedium"),
          "  ",
        )}\n}`,
      ],
      "\n",
    );
  },
);

// React Native / Expo --------------------------------------------------------------------------

export interface NativeTextStyle {
  readonly fontFamily: string;
  readonly fontWeight: "400" | "500" | "600";
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly letterSpacing: number;
  readonly fontVariant?: ReadonlyArray<"lining-nums" | "tabular-nums">;
}

export interface NativeTheme {
  readonly dark: boolean;
  readonly contrast: EffectiveTheme["contrast"];
  readonly style: ThemeStyle;
  readonly colors: RoleMap;
  readonly extended: Readonly<
    Record<
      ExtendedRole,
      {
        readonly color: string;
        readonly onColor: string;
        readonly colorContainer: string;
        readonly onColorContainer: string;
      }
    >
  >;
  /** M3 kit `roundness`: the control radius. */
  readonly roundness: number;
  readonly shape: StyleTokens["shape"];
  readonly surface: StyleTokens["surface"];
  readonly panelBorder: number;
  readonly fonts: Readonly<Record<(typeof TYPE_SCALE_NAMES)[number], NativeTextStyle>>;
  readonly operateFonts: Readonly<Record<(typeof OPERATE_SCALE_NAMES)[number], NativeTextStyle>>;
  /** Text style for amounts, dates and table figures. */
  readonly numeric: NativeTextStyle;
}

const nativeText = (tokens: StyleTokens, s: TypeStyle, numeric = false): NativeTextStyle => {
  const base: NativeTextStyle = {
    fontFamily: familyOf(tokens, s.font),
    fontWeight: `${s.weight}`,
    fontSize: s.size,
    lineHeight: s.lineHeight,
    letterSpacing: s.letterSpacing,
  };
  return numeric && tokens.font.tabularNumerals
    ? { ...base, fontVariant: ["lining-nums", "tabular-nums"] }
    : base;
};

/** Plain object for the Expo M3 kit and Kvitbit primitives (`colors`, `fonts`, `roundness`). */
export const nativeTheme = (theme: EffectiveTheme): NativeTheme => {
  const tokens = theme.tokens;
  const defaultTokens = StyleTokensByStyle[theme.style];
  const fonts = Rec.map(defaultTokens.typeScale, (_, name) =>
    nativeText(tokens, tokens.typeScale[name]),
  );
  const operateFonts = Rec.map(defaultTokens.operateScale, (_, name) =>
    nativeText(tokens, tokens.operateScale[name]),
  );
  return {
    dark: theme.scheme === "dark",
    contrast: theme.contrast,
    style: theme.style,
    colors: theme.roles,
    extended: theme.extended,
    roundness: tokens.shape.control,
    shape: tokens.shape,
    surface: tokens.surface,
    panelBorder: tokens.panelBorder,
    fonts,
    operateFonts,
    numeric: nativeText(tokens, tokens.operateScale.row, true),
  };
};
