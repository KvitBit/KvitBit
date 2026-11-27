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
import { EXTENDED_ROLES, M3_COLOR_ROLES } from "@kvitbit/api-contract";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import { type Text, text } from "../text";
import { contrastRatio, relativeLuminance } from "./color/contrast";
import { Hct } from "./color/hct";
import {
  clamp,
  hexFromRgb,
  linearized,
  lstarFromRgb,
  lstarFromY,
  rgbFromComponents,
  rgbFromHex,
} from "./color/utils";
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
  ...Arr.map(SURFACES, (s) => text45("onSurface", s)),
  ...Arr.map(SURFACES, (s) => text45("onSurfaceVariant", s)),
  text45("onSurfaceVariant", "surfaceVariant"),
  text45("inverseOnSurface", "inverseSurface"),
  text45("inversePrimary", "inverseSurface"),
  text45("onPrimaryFixed", "primaryFixed"),
  text45("onPrimaryFixedVariant", "primaryFixed"),
  text45("onSecondaryFixed", "secondaryFixed"),
  text45("onSecondaryFixedVariant", "secondaryFixed"),
  text45("onTertiaryFixed", "tertiaryFixed"),
  text45("onTertiaryFixedVariant", "tertiaryFixed"),
  text45("onPrimaryFixed", "primaryFixedDim"),
  text45("onPrimaryFixedVariant", "primaryFixedDim"),
  text45("onSecondaryFixed", "secondaryFixedDim"),
  text45("onSecondaryFixedVariant", "secondaryFixedDim"),
  text45("onTertiaryFixed", "tertiaryFixedDim"),
  text45("onTertiaryFixedVariant", "tertiaryFixedDim"),
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
export const auditScheme: {
  (variant: SchemeVariant): (scheme: ResolvedScheme) => ContrastIssue[];
  (scheme: ResolvedScheme, variant: SchemeVariant): ContrastIssue[];
} = Fn.dual(2, (scheme: ResolvedScheme, variant: SchemeVariant): ContrastIssue[] => {
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
});

/** Failing pairs across all six schemes. */
export const auditTheme = (schemes: ResolvedTheme["schemes"]): ContrastIssue[] =>
  Arr.flatMap(SCHEME_VARIANTS, (v) => auditScheme(schemes[v], v));

/**
 * The colour of `color`'s hue and chroma (any tone 0..100, or black / white) closest in tone to
 * `color` that reaches each requirement against its partner. When no candidate satisfies all of
 * them, the one with the best worst-case margin.
 */
export const nearestPassing: {
  (
    partners: ReadonlyArray<{ readonly color: string; readonly required: number }>,
  ): (color: string) => string;
  (
    color: string,
    partners: ReadonlyArray<{ readonly color: string; readonly required: number }>,
  ): string;
} = Fn.dual(
  2,
  (
    color: string,
    partners: ReadonlyArray<{ readonly color: string; readonly required: number }>,
  ): string => {
    const margin = (c: string) =>
      Math.min(...Arr.map(partners, (p) => ratioOf(c, p.color) / p.required));
    if (partners.length === 0 || margin(color) >= 1) return color;
    const own = Hct.fromRgb(rgbFromHex(color));
    const candidates: Array<{ hex: string; distance: number }> = [
      { hex: "#000000", distance: own.tone },
      { hex: "#FFFFFF", distance: 100 - own.tone },
    ];
    for (let tone = 0; tone <= 100; tone++)
      candidates.push({
        hex: hexFromRgb(Hct.from(own.hue, own.chroma, tone).rgb),
        distance: Math.abs(tone - own.tone),
      });
    let best: { hex: string; distance: number; margin: number } | undefined;
    for (const c of candidates) {
      const m = margin(c.hex);
      const better =
        best === undefined ||
        (m >= 1 && (best.margin < 1 || c.distance < best.distance)) ||
        (m < 1 && best.margin < 1 && m > best.margin);
      if (better) best = { ...c, margin: m };
    }
    if (best !== undefined && best.margin >= 1) return best.hex;
    return feasibleColor(own, partners) ?? best?.hex ?? color;
  },
);

type Interval = readonly [number, number];

/**
 * WCAG luminance ranges (0..1) a colour may take to reach every partner's requirement: each
 * partner allows "dark enough" or "light enough", and the ranges intersect.
 */
export const feasibleLuminance = (
  partners: ReadonlyArray<{ readonly color: string; readonly required: number }>,
): Interval[] => {
  let ranges: Interval[] = [[0, 1]];
  for (const p of partners) {
    const l = relativeLuminance(rgbFromHex(p.color));
    const allowed: Interval[] = [
      [0, (l + 0.05) / p.required - 0.05],
      [p.required * (l + 0.05) - 0.05, 1],
    ];
    ranges = Arr.flatMap(ranges, ([a, b]) => {
      const intersections = Arr.map(
        allowed,
        ([c, d]): Interval => [Math.max(a, c), Math.min(b, d)],
      );
      return Arr.filter(intersections, ([c, d]) => c <= d);
    });
  }
  return ranges;
};

/**
 * Exact fallback when tone sampling misses a narrow feasible band: aim at the middle of each
 * feasible luminance range, then nudge 8-bit channels until one candidate passes. Prefers the
 * candidate closest in tone to `own`.
 */
const feasibleColor = (
  own: Hct,
  partners: ReadonlyArray<{ readonly color: string; readonly required: number }>,
): string | undefined => {
  const passes = (rgb: number) =>
    Arr.every(partners, (p) => contrastRatio(rgb, rgbFromHex(p.color)) >= p.required);
  const ranges = feasibleLuminance(partners);
  if (ranges.length === 0) return undefined;
  let best: { rgb: number; distance: number } | undefined;
  for (const [lo, hi] of ranges) {
    const tone = lstarFromY(((lo + hi) / 2) * 100);
    for (const base of [Hct.from(own.hue, own.chroma, tone).rgb, Hct.from(0, 0, tone).rgb]) {
      const [r, g, b] = [(base >> 16) & 0xff, (base >> 8) & 0xff, base & 0xff];
      for (let dr = -4; dr <= 4; dr++)
        for (let dg = -2; dg <= 2; dg++)
          for (let db = -4; db <= 4; db++) {
            const rgb = rgbFromComponents(
              clamp(0, 255, r + dr),
              clamp(0, 255, g + dg),
              clamp(0, 255, b + db),
            );
            if (!passes(rgb)) continue;
            const distance = Math.abs(lstarFromRgb(rgb) - own.tone);
            if (best === undefined || distance < best.distance) best = { rgb, distance };
          }
    }
  }
  if (best !== undefined) return hexFromRgb(best.rgb);
  return exhaustiveColor(own, partners);
};

/** Linear sRGB channel (0..1) per 8-bit value, for the exhaustive search. */
const LINEAR = Array.from({ length: 256 }, (_, v) => linearized(v) / 100);

/**
 * Complete fallback: every red / green pair, with the blue channel binary-searched into each
 * feasible luminance range (luminance grows with blue). Finds a passing 8-bit colour whenever one
 * exists; returns the one closest in tone to `own`.
 */
export const exhaustiveColor: {
  (
    partners: ReadonlyArray<{ readonly color: string; readonly required: number }>,
    probe?: { visited: number },
  ): (own: Hct) => string | undefined;
  (
    own: Hct,
    partners: ReadonlyArray<{ readonly color: string; readonly required: number }>,
    probe?: { visited: number },
  ): string | undefined;
} = Fn.dual(
  (args) => args.length > 0 && !Arr.isArray(args[0]),
  (
    own: Hct,
    partners: ReadonlyArray<{ readonly color: string; readonly required: number }>,
    /** Test probe: counts the red / green pairs visited. */
    probe?: { visited: number },
  ): string | undefined => {
    const ranges = feasibleLuminance(partners);
    // No luminance can satisfy every partner: nothing to search.
    if (ranges.length === 0) return undefined;
    const passes = (rgb: number) =>
      Arr.every(partners, (p) => contrastRatio(rgb, rgbFromHex(p.color)) >= p.required);
    let best: { rgb: number; distance: number } | undefined;
    for (let r = 0; r < 256; r++)
      for (let g = 0; g < 256; g++) {
        if (probe !== undefined) probe.visited++;
        const base = 0.2126 * (LINEAR[r] ?? 0) + 0.7152 * (LINEAR[g] ?? 0);
        for (const [lo, hi] of ranges) {
          const need = (lo - base) / 0.0722;
          if ((hi - base) / 0.0722 < 0 || need > 1) continue;
          let a = 0;
          let z = 255;
          while (a < z) {
            const m = (a + z) >> 1;
            if ((LINEAR[m] ?? 0) < need) a = m + 1;
            else z = m;
          }
          for (const b of [a, a + 1]) {
            if (b > 255) continue;
            const rgb = rgbFromComponents(r, g, b);
            if (!passes(rgb)) continue;
            const y = base + 0.0722 * (LINEAR[b] ?? 0);
            const distance = Math.abs(lstarFromY(y * 100) - own.tone);
            if (best === undefined || distance < best.distance) best = { rgb, distance };
          }
        }
      }
    return best === undefined ? undefined : hexFromRgb(best.rgb);
  },
);

/**
 * Constraint propagation pass of `repairContrast`, changing only roles outside `fixed` (colours the
 * platform supplied). Contrast is symmetric, so a role is solved against every pair it takes part
 * in, as foreground or background. Constraint propagation: failing pairs touching an already
 * settled role go first; a moved role is solved against all its partners when possible, else
 * against its settled partners, and is then settled itself. Each role moves at most once, so the
 * loop ends; a pair whose two roles are both supplied stays as the platform gave it.
 */
const propagate = (
  roles: Readonly<Record<M3ColorRole, string>>,
  fixed: ReadonlySet<M3ColorRole> = new Set(),
): Record<M3ColorRole, string> => {
  const out: Record<M3ColorRole, string> = { ...roles };
  const settled = new Set<M3ColorRole>(fixed);
  const pairsOf = new Map<M3ColorRole, RolePair[]>();
  for (const pair of CHECKED_ROLE_PAIRS)
    for (const role of [pair.foreground, pair.background])
      pairsOf.set(role, [...(pairsOf.get(role) ?? []), pair]);
  const other = (p: RolePair, role: M3ColorRole) =>
    p.foreground === role ? p.background : p.foreground;
  const partners = (role: M3ColorRole, onlySettled: boolean) =>
    Arr.map(
      Arr.filter(pairsOf.get(role) ?? [], (p) => !onlySettled || settled.has(other(p, role))),
      (p) => ({ color: out[other(p, role)], required: p.required }),
    );
  const passes = (color: string, ps: ReturnType<typeof partners>) =>
    Arr.every(ps, (p) => ratioOf(color, p.color) >= p.required);
  const failing = (p: RolePair) => ratioOf(out[p.foreground], out[p.background]) < p.required;
  while (settled.size < M3_COLOR_ROLES.length) {
    const open = Arr.filter(
      CHECKED_ROLE_PAIRS,
      (p) => failing(p) && !(settled.has(p.foreground) && settled.has(p.background)),
    );
    const pair =
      Option.getOrUndefined(
        Arr.findFirst(open, (p) => settled.has(p.foreground) || settled.has(p.background)),
      ) ?? open[0];
    if (pair === undefined) return out;
    const movable = Arr.filter([pair.foreground, pair.background], (r) => !settled.has(r));
    const full = Option.getOrUndefined(
      Arr.findFirst(
        Arr.map(movable, (candidateRole) => ({
          role: candidateRole,
          color: nearestPassing(out[candidateRole], partners(candidateRole, false)),
        })),
        (c) => passes(c.color, partners(c.role, false)),
      ),
    );
    const role = full?.role ?? movable[0];
    if (role === undefined) return out;
    out[role] =
      full?.color ??
      nearestPassing(out[role], [
        ...partners(role, true),
        { color: out[other(pair, role)], required: pair.required },
      ]);
    settled.add(role);
  }
  return out;
};

/**
 * Relaxation: generated roles may move again on every pass. Each failing pair moves the first of
 * its adjustable roles that can satisfy all its pairs, else the adjustable role solved against its
 * fixed partners and this pair. Returns the best map seen.
 */
const relax = (
  roles: Readonly<Record<M3ColorRole, string>>,
  fixed: ReadonlySet<M3ColorRole>,
): Record<M3ColorRole, string> => {
  const out: Record<M3ColorRole, string> = { ...roles };
  const pairsOf = new Map<M3ColorRole, RolePair[]>();
  for (const pair of CHECKED_ROLE_PAIRS)
    for (const role of [pair.foreground, pair.background])
      pairsOf.set(role, [...(pairsOf.get(role) ?? []), pair]);
  const other = (p: RolePair, role: M3ColorRole) =>
    p.foreground === role ? p.background : p.foreground;
  const partners = (role: M3ColorRole, onlyFixed: boolean) =>
    Arr.map(
      Arr.filter(pairsOf.get(role) ?? [], (p) => !onlyFixed || fixed.has(other(p, role))),
      (p) => ({ color: out[other(p, role)], required: p.required }),
    );
  const open = () => repairable(out, fixed);
  let best = { ...out };
  let bestCount = open().length;
  for (let pass = 0; pass < 24 && bestCount > 0; pass++) {
    for (const pair of open()) {
      if (ratioOf(out[pair.foreground], out[pair.background]) >= pair.required) continue;
      const movable = Arr.filter([pair.foreground, pair.background], (r) => !fixed.has(r));
      const full = Option.getOrUndefined(
        Arr.findFirst(
          Arr.map(movable, (candidateRole) => ({
            role: candidateRole,
            color: nearestPassing(out[candidateRole], partners(candidateRole, false)),
          })),
          (c) => Arr.every(partners(c.role, false), (p) => ratioOf(c.color, p.color) >= p.required),
        ),
      );
      const role = full?.role ?? movable[0];
      if (role === undefined) continue;
      out[role] =
        full?.color ??
        nearestPassing(out[role], [
          ...partners(role, true),
          { color: out[other(pair, role)], required: pair.required },
        ]);
    }
    const count = open().length;
    if (count < bestCount) {
      best = { ...out };
      bestCount = count;
    }
  }
  return best;
};

/** Failing pairs with at least one role outside `fixed`. */
const repairable = (
  roles: Readonly<Record<M3ColorRole, string>>,
  fixed: ReadonlySet<M3ColorRole>,
): RolePair[] =>
  Arr.filter(failingPairs(roles), (p) => !(fixed.has(p.foreground) && fixed.has(p.background)));

/**
 * Make every checked pair of a role map pass, changing only roles outside `fixed` (colours the
 * platform supplied). Runs constraint propagation (each role moves once), then relaxation from
 * both the input and the propagated map (roles may move repeatedly), and returns the map with the
 * fewest repairable failures; a pair whose two roles are both supplied stays as supplied.
 */
export const repairContrast: {
  (
    fixed?: ReadonlySet<M3ColorRole>,
  ): (roles: Readonly<Record<M3ColorRole, string>>) => Record<M3ColorRole, string>;
  (
    roles: Readonly<Record<M3ColorRole, string>>,
    fixed?: ReadonlySet<M3ColorRole>,
  ): Record<M3ColorRole, string>;
} = Fn.dual(
  (args) => typeof args[0] === "object" && args[0] !== null && "primary" in args[0],
  (
    roles: Readonly<Record<M3ColorRole, string>>,
    fixed: ReadonlySet<M3ColorRole> = new Set(),
  ): Record<M3ColorRole, string> => {
    if (repairable(roles, fixed).length === 0) return { ...roles };
    const propagated = propagate(roles, fixed);
    if (repairable(propagated, fixed).length === 0) return propagated;
    const candidates = [propagated, relax(propagated, fixed), relax(roles, fixed)];
    let best = propagated;
    for (const c of candidates)
      if (repairable(c, fixed).length < repairable(best, fixed).length) best = c;
    return best;
  },
);

/** Checked pairs of a role map below their requirement. */
export const failingPairs = (roles: Readonly<Record<M3ColorRole, string>>): RolePair[] =>
  Arr.filter(
    CHECKED_ROLE_PAIRS,
    (p) => ratioOf(roles[p.foreground], roles[p.background]) < p.required,
  );

/** Render-ready descriptor for a failing contrast pair. */
export const contrastIssueText = (issue: ContrastIssue): Text =>
  text("theme.warning.low_contrast_pair", {
    foreground: issue.foreground,
    background: issue.background,
    ratio: issue.ratio.toFixed(2),
    required: issue.required.toFixed(1),
  });

/** Finds a foreground colour that contrasts with one background. */
export const withContrast: {
  (background: string, required: number): (foreground: string) => string;
  (foreground: string, background: string, required: number): string;
} = Fn.dual(3, (foreground: string, background: string, required: number): string =>
  nearestPassing(foreground, [{ color: background, required }]),
);
