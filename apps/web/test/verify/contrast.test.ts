/**
 * Tier 2 exhaustive WCAG 2.1 AA contrast & stylesheet verification for @kvitbit/web.
 *
 * Independently recomputes W3C WCAG 2.1 relative luminance and contrast ratio from hex colors
 * (never trusting the theme engine's own contrast function alone) across:
 *   - All 6 built-in theme presets (graphite_atelier, forest, ocean, plum, sand, graphite)
 *   - All 6 scheme variants (light/dark × standard/medium/high contrast) = 36 schemes
 *   - All 42 M3 color role pairs (primary, secondary, tertiary, error, surfaces, inverse, fixed)
 *     + all 8 extended financial status pairs (paid, proforma, overdue, draft) = 1,800 pairs
 *   - Elegant and Cozy stylesheet generation across all 6 presets (12 stylesheets)
 */
import { describe, expect, test } from "bun:test";
import {
  EXTENDED_ROLES,
  type ExtendedRole,
  type M3ColorRole,
  type ResolvedScheme,
} from "@kvitbit/api-contract";
import type { Hex, ThemePresetId, ThemeStyle } from "@kvitbit/domain";
import { Theme } from "@kvitbit/ui-port";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { defaultPrefs, type Prefs } from "../../src/app/prefs";
import { resolveChoice, THEME_ROOT, themeCss } from "../../src/app/theme";

const hexColorPattern = /^#[0-9a-fA-F]{6}$/;

const EXPECTED_PRESETS: ReadonlyArray<ThemePresetId> = [
  "graphite_atelier",
  "forest",
  "ocean",
  "plum",
  "sand",
  "graphite",
];

const EXPECTED_VARIANTS: ReadonlyArray<Theme.SchemeVariant> = [
  "light",
  "dark",
  "lightMedium",
  "lightHigh",
  "darkMedium",
  "darkHigh",
];

const EXPECTED_EXTENDED: ReadonlyArray<ExtendedRole> = ["paid", "proforma", "overdue", "draft"];

const STYLES: ReadonlyArray<ThemeStyle> = ["elegant", "cozy"];

const SURFACE_ROLES: ReadonlyArray<M3ColorRole> = [
  "surface",
  "surfaceDim",
  "surfaceBright",
  "surfaceContainerLowest",
  "surfaceContainerLow",
  "surfaceContainer",
  "surfaceContainerHigh",
  "surfaceContainerHighest",
];

const TEXT_AA = 4.5;
const NON_TEXT_AA = 3;

type RolePair = readonly [foreground: M3ColorRole, background: M3ColorRole];
const TEXT_PAIRS: ReadonlyArray<RolePair> = [
  ["onPrimary", "primary"],
  ["onPrimaryContainer", "primaryContainer"],
  ["onSecondary", "secondary"],
  ["onSecondaryContainer", "secondaryContainer"],
  ["onTertiary", "tertiary"],
  ["onTertiaryContainer", "tertiaryContainer"],
  ["onError", "error"],
  ["onErrorContainer", "errorContainer"],
  ["onBackground", "background"],
  ...Arr.map(SURFACE_ROLES, (role): RolePair => ["onSurface", role]),
  ...Arr.map(SURFACE_ROLES, (role): RolePair => ["onSurfaceVariant", role]),
  ["onSurfaceVariant", "surfaceVariant"],
  ["inverseOnSurface", "inverseSurface"],
  ["inversePrimary", "inverseSurface"],
  ["onPrimaryFixed", "primaryFixed"],
  ["onPrimaryFixedVariant", "primaryFixed"],
  ["onSecondaryFixed", "secondaryFixed"],
  ["onSecondaryFixedVariant", "secondaryFixed"],
  ["onTertiaryFixed", "tertiaryFixed"],
  ["onTertiaryFixedVariant", "tertiaryFixed"],
  ["onPrimaryFixed", "primaryFixedDim"],
  ["onPrimaryFixedVariant", "primaryFixedDim"],
  ["onSecondaryFixed", "secondaryFixedDim"],
  ["onSecondaryFixedVariant", "secondaryFixedDim"],
  ["onTertiaryFixed", "tertiaryFixedDim"],
  ["onTertiaryFixedVariant", "tertiaryFixedDim"],
];
const NON_TEXT_PAIRS: ReadonlyArray<RolePair> = [
  ["primary", "surface"],
  ["error", "surface"],
];

/** Independent WCAG 2.1 sRGB channel linearization (W3C WCAG 2.1 §1.4.3 / §1.4.6). */
const wcagLinearChannel = (byte: number): number => {
  const s = byte / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** Independent WCAG 2.1 relative luminance in [0, 1] from a #RRGGBB hex string. */
const wcagLuminance = (hex: string): number => {
  if (!hexColorPattern.test(hex)) {
    throw new Error(`Invalid #RRGGBB hex color: ${hex}`);
  }
  const r = Number.parseInt(Str.slice(1, 3)(hex), 16);
  const g = Number.parseInt(Str.slice(3, 5)(hex), 16);
  const b = Number.parseInt(Str.slice(5, 7)(hex), 16);
  return (
    0.2126 * wcagLinearChannel(r) + 0.7152 * wcagLinearChannel(g) + 0.0722 * wcagLinearChannel(b)
  );
};

/** Independent WCAG 2.1 contrast ratio in [1, 21]. */
const wcagContrastRatio = (fgHex: string, bgHex: string): number => {
  const l1 = wcagLuminance(fgHex);
  const l2 = wcagLuminance(bgHex);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

const measurePairContrast = (label: string, fgHex: string, bgHex: string, required: number) => {
  const ratio = wcagContrastRatio(fgHex, bgHex);
  const engineRatio = Theme.contrastRatio(Theme.rgbFromHex(fgHex), Theme.rgbFromHex(bgHex));
  return {
    label: `${label}: ${fgHex} on ${bgHex}`,
    ratio,
    required,
    engineDifference: Math.abs(ratio - engineRatio),
  };
};

const measureSchemeContrast = (
  presetLabel: string,
  variant: Theme.SchemeVariant,
  scheme: ResolvedScheme,
) => {
  const readings: ReturnType<typeof measurePairContrast>[] = [];

  for (const [pairs, minimum] of [
    [TEXT_PAIRS, TEXT_AA],
    [NON_TEXT_PAIRS, NON_TEXT_AA],
  ] as const) {
    for (const [foreground, background] of pairs) {
      readings.push(
        measurePairContrast(
          `${presetLabel}/${variant} ${foreground}/${background}`,
          scheme.roles[foreground],
          scheme.roles[background],
          minimum,
        ),
      );
    }
  }

  for (const role of EXPECTED_EXTENDED) {
    const ext = scheme.extended[role];
    readings.push(
      measurePairContrast(
        `${presetLabel}/${variant} ${role}.onColor/${role}.color`,
        ext.onColor,
        ext.color,
        TEXT_AA,
      ),
      measurePairContrast(
        `${presetLabel}/${variant} ${role}.onColorContainer/${role}.colorContainer`,
        ext.onColorContainer,
        ext.colorContainer,
        TEXT_AA,
      ),
    );
  }

  return readings;
};

describe("WCAG 2.1 AA contrast — exhaustive preset × mode × contrast matrix", () => {
  test("domain bounds match expected 6 presets, 6 scheme variants, 4 extended roles", () => {
    expect([...Theme.PRESET_IDS]).toEqual([...EXPECTED_PRESETS]);
    expect([...Theme.SCHEME_VARIANTS]).toEqual([...EXPECTED_VARIANTS]);
    expect([...EXTENDED_ROLES]).toEqual([...EXPECTED_EXTENDED]);
    expect(
      new Set(
        Arr.map(
          Theme.CHECKED_ROLE_PAIRS,
          ({ foreground, background, required }) => `${foreground}/${background}/${required}`,
        ),
      ),
    ).toEqual(
      new Set([
        ...Arr.map(TEXT_PAIRS, ([fg, bg]) => `${fg}/${bg}/${TEXT_AA}`),
        ...Arr.map(NON_TEXT_PAIRS, ([fg, bg]) => `${fg}/${bg}/${NON_TEXT_AA}`),
      ]),
    );
  });

  test("all 6 presets × 6 scheme variants × 50 pairs (1,800 pairs) pass WCAG 2.1 AA", () => {
    let totalSchemes = 0;
    let totalPairs = 0;

    for (const presetId of EXPECTED_PRESETS) {
      const resolved = resolveChoice({ _tag: "Preset", id: presetId });
      expect(Arr.filter(resolved.warnings ?? [], (w) => w === "theme.low_contrast")).toEqual([]);
      expect(Theme.auditTheme(resolved.schemes)).toEqual([]);

      for (const variant of EXPECTED_VARIANTS) {
        totalSchemes += 1;
        const scheme = resolved.schemes[variant];
        expect(Theme.auditScheme(scheme, variant)).toEqual([]);
        const readings = measureSchemeContrast(presetId, variant, scheme);
        totalPairs += readings.length;
        for (const { label, ratio, required, engineDifference } of readings) {
          expect(ratio, label).toBeGreaterThanOrEqual(required);
          expect(engineDifference, label).toBeLessThan(0.02);
        }
      }
    }

    expect(totalSchemes).toBe(36);
    expect(totalPairs).toBe(36 * (42 + 8));
  });

  test("representative custom seeds across luminance extremes pass WCAG 2.1 AA", () => {
    const seeds: ReadonlyArray<Hex> = [
      "#000000",
      "#FFFFFF",
      "#1D4ED8",
      "#0F5D42",
      "#DC2626",
      "#F59E0B",
      "#7C3AED",
    ];

    for (const hex of seeds) {
      const resolved = resolveChoice({ _tag: "Seed", hex });
      expect(Theme.auditTheme(resolved.schemes)).toEqual([]);
      for (const variant of EXPECTED_VARIANTS) {
        const scheme = resolved.schemes[variant];
        expect(Theme.auditScheme(scheme, variant)).toEqual([]);
        for (const { label, ratio, required, engineDifference } of measureSchemeContrast(
          hex,
          variant,
          scheme,
        )) {
          expect(ratio, label).toBeGreaterThanOrEqual(required);
          expect(engineDifference, label).toBeLessThan(0.02);
        }
      }
    }
  });
});

describe("Elegant and Cozy stylesheet generation", () => {
  test("all 6 presets × 2 styles emit scoped .kb-root CSS with M3, extended, dark & contrast rules", () => {
    let generated = 0;

    for (const presetId of EXPECTED_PRESETS) {
      const choice: Prefs["theme"] = { _tag: "Preset", id: presetId };
      const elegantCss = themeCss(choice, "elegant");
      const cozyCss = themeCss(choice, "cozy");

      expect(elegantCss).not.toBe(cozyCss);

      for (const [style, css] of [
        ["elegant", elegantCss],
        ["cozy", cozyCss],
      ] as const) {
        generated += 1;
        expect(css.length, `${presetId}/${style} stylesheet non-empty`).toBeGreaterThan(1000);
        expect(css).toContain(`${THEME_ROOT} {`);
        expect(css).toContain(`${THEME_ROOT}[data-theme="dark"]`);
        expect(css).toContain(`${THEME_ROOT}[data-contrast="medium"]`);
        expect(css).toContain(`${THEME_ROOT}[data-contrast="high"]`);
        expect(css).toContain("@media (prefers-color-scheme: dark)");
        expect(css).toContain("@media (prefers-contrast: more)");

        // Core M3 roles
        expect(css).toContain("--md-sys-color-primary:");
        expect(css).toContain("--md-sys-color-on-primary:");
        expect(css).toContain("--md-sys-color-surface:");
        expect(css).toContain("--md-sys-color-on-surface:");
        expect(css).toContain("--md-sys-color-error:");

        // Extended financial status variables
        for (const role of EXPECTED_EXTENDED) {
          expect(css).toContain(`--kb-color-${role}:`);
          expect(css).toContain(`--kb-color-on-${role}:`);
          expect(css).toContain(`--kb-color-${role}-container:`);
          expect(css).toContain(`--kb-color-on-${role}-container:`);
        }

        // Style tokens
        expect(css).toContain("--kb-font-display:");
        expect(css).toContain("--kb-font-body:");
        expect(css).toContain("--kb-shape-panel:");
        expect(css).toContain("--kb-shape-control:");
      }
    }

    expect(generated).toBe(EXPECTED_PRESETS.length * STYLES.length);
  });

  test("defaultPrefs produces valid stylesheets for both styles", () => {
    const prefs = defaultPrefs("cs");
    for (const style of STYLES) {
      const css = themeCss(prefs.theme, style);
      expect(css).toContain(`${THEME_ROOT} {`);
      expect(css).toContain("--md-sys-color-surface:");
    }
  });
});
