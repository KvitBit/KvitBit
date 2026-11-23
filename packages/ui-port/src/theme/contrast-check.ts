/**
 * WCAG 2.x contrast audit over the role pairs that carry text or UI meaning. A failing theme is
 * still accepted (an imported theme is the user's choice); the result feeds
 * `ResolvedTheme.warnings` and the Appearance screen's list of failing pairs.
 */
import type {
  ExtendedRole,
  M3ColorRole,
  ResolvedScheme,
  ResolvedTheme,
} from "@kvitbit/api-contract";
import { EXTENDED_ROLES } from "@kvitbit/api-contract";
import { type Text, text } from "../text";
import { contrastRatio } from "./color/contrast";
import { rgbFromHex } from "./color/utils";
import { SCHEME_VARIANTS, type SchemeVariant } from "./scheme";

/** WCAG 2.x AA: 4.5:1 for body text, 3:1 for large text and UI components (1.4.11). */
export const AA_TEXT = 4.5;
export const AA_UI = 3;

export interface RolePair {
  readonly foreground: M3ColorRole;
  readonly background: M3ColorRole;
  readonly required: number;
}

const text45 = (foreground: M3ColorRole, background: M3ColorRole): RolePair => ({
  foreground,
  background,
  required: AA_TEXT,
});

const SURFACES: ReadonlyArray<M3ColorRole> = [
  "surface",
  "surfaceDim",
  "surfaceBright",
  "surfaceContainerLowest",
  "surfaceContainerLow",
  "surfaceContainer",
  "surfaceContainerHigh",
  "surfaceContainerHighest",
];

/**
 * Pairs checked per scheme. `outline` is left out on purpose: DESIGN.md fixes Graphite Atelier's
 * hairline outline below 3:1, and borders never carry meaning alone in Kvitbit components.
 */
export const CHECKED_ROLE_PAIRS: ReadonlyArray<RolePair> = [
  text45("onPrimary", "primary"),
  text45("onPrimaryContainer", "primaryContainer"),
  text45("onSecondary", "secondary"),
  text45("onSecondaryContainer", "secondaryContainer"),
  text45("onTertiary", "tertiary"),
  text45("onTertiaryContainer", "tertiaryContainer"),
  text45("onError", "error"),
  text45("onErrorContainer", "errorContainer"),
  text45("onBackground", "background"),
  ...SURFACES.map((s) => text45("onSurface", s)),
  ...SURFACES.map((s) => text45("onSurfaceVariant", s)),
  text45("onSurfaceVariant", "surfaceVariant"),
  text45("inverseOnSurface", "inverseSurface"),
  text45("inversePrimary", "inverseSurface"),
  text45("onPrimaryFixed", "primaryFixed"),
  text45("onPrimaryFixedVariant", "primaryFixed"),
  text45("onSecondaryFixed", "secondaryFixed"),
  text45("onSecondaryFixedVariant", "secondaryFixed"),
  text45("onTertiaryFixed", "tertiaryFixed"),
  text45("onTertiaryFixedVariant", "tertiaryFixed"),
  { foreground: "primary", background: "surface", required: AA_UI },
  { foreground: "error", background: "surface", required: AA_UI },
];

export interface ContrastIssue {
  readonly variant: SchemeVariant;
  /** An `M3ColorRole`, or `<extendedRole>.<field>` for extended colours, e.g. `paid.onColor`. */
  readonly foreground: string;
  readonly background: string;
  readonly ratio: number;
  readonly required: number;
}

const ratioOf = (fg: string, bg: string) => contrastRatio(rgbFromHex(fg), rgbFromHex(bg));

/** Failing pairs of one scheme, extended colours included. */
export const auditScheme = (scheme: ResolvedScheme, variant: SchemeVariant): ContrastIssue[] => {
  const issues: ContrastIssue[] = [];
  for (const pair of CHECKED_ROLE_PAIRS) {
    const ratio = ratioOf(scheme.roles[pair.foreground], scheme.roles[pair.background]);
    if (ratio < pair.required) issues.push({ variant, ...pair, ratio });
  }
  const ext = (role: ExtendedRole, fg: string, bg: string, a: string, b: string) => {
    const ratio = ratioOf(a, b);
    if (ratio < AA_TEXT)
      issues.push({
        variant,
        foreground: `${role}.${fg}`,
        background: `${role}.${bg}`,
        ratio,
        required: AA_TEXT,
      });
  };
  for (const role of EXTENDED_ROLES) {
    const e = scheme.extended[role];
    ext(role, "onColor", "color", e.onColor, e.color);
    ext(role, "onColorContainer", "colorContainer", e.onColorContainer, e.colorContainer);
  }
  return issues;
};

/** Failing pairs across all six schemes. */
export const auditTheme = (schemes: ResolvedTheme["schemes"]): ContrastIssue[] =>
  SCHEME_VARIANTS.flatMap((v) => auditScheme(schemes[v], v));

/** `theme.warning.low_contrast_pair` copy for one failing pair. */
export const contrastIssueText = (issue: ContrastIssue): Text =>
  text("theme.warning.low_contrast_pair", {
    foreground: issue.foreground,
    background: issue.background,
    ratio: issue.ratio.toFixed(2),
    required: issue.required.toFixed(1),
  });
