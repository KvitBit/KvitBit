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
import { defaultPrefs, type Prefs } from "../../src/app/prefs";
import { resolveChoice, THEME_ROOT, themeCss } from "../../src/app/theme";

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
  ...SURFACE_ROLES.map((role): RolePair => ["onSurface", role]),
  ...SURFACE_ROLES.map((role): RolePair => ["onSurfaceVariant", role]),
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
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(`Invalid #RRGGBB hex color: ${hex}`);
  }
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
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

const assertPairContrast = (
  label: string,
  fgHex: string,
  bgHex: string,
  required: number,
): void => {
  const ratio = wcagContrastRatio(fgHex, bgHex);
  expect(
    ratio,
    `${label}: ${fgHex} on ${bgHex} has contrast ${ratio.toFixed(2)} < ${required}`,
  ).toBeGreaterThanOrEqual(required);
  const engineRatio = Theme.contrastRatio(Theme.rgbFromHex(fgHex), Theme.rgbFromHex(bgHex));
  expect(Math.abs(ratio - engineRatio)).toBeLessThan(0.02);
};

const assertSchemeAccessible = (
  presetLabel: string,
  variant: Theme.SchemeVariant,
  scheme: ResolvedScheme,
): number => {
  let checked = 0;

  for (const [pairs, minimum] of [
    [TEXT_PAIRS, TEXT_AA],
    [NON_TEXT_PAIRS, NON_TEXT_AA],
  ] as const) {
    for (const [foreground, background] of pairs) {
      assertPairContrast(
        `${presetLabel}/${variant} ${foreground}/${background}`,
        scheme.roles[foreground],
        scheme.roles[background],
        minimum,
      );
      checked += 1;
    }
  }

  // All 4 extended financial status roles (paid, proforma, overdue, draft) × 2 pairs = 8 pairs
  for (const role of EXPECTED_EXTENDED) {
    const ext = scheme.extended[role];
    assertPairContrast(
      `${presetLabel}/${variant} ${role}.onColor/${role}.color`,
      ext.onColor,
      ext.color,
      TEXT_AA,
    );
    assertPairContrast(
      `${presetLabel}/${variant} ${role}.onColorContainer/${role}.colorContainer`,
      ext.onColorContainer,
      ext.colorContainer,
      TEXT_AA,
    );
    checked += 2;
  }

  expect(Theme.auditScheme(scheme, variant)).toEqual([]);
  return checked;
};

describe("WCAG 2.1 AA contrast — exhaustive preset × mode × contrast matrix", () => {
  test("domain bounds match expected 6 presets, 6 scheme variants, 4 extended roles", () => {
    expect([...Theme.PRESET_IDS]).toEqual([...EXPECTED_PRESETS]);
    expect([...Theme.SCHEME_VARIANTS]).toEqual([...EXPECTED_VARIANTS]);
    expect([...EXTENDED_ROLES]).toEqual([...EXPECTED_EXTENDED]);
    expect(
      new Set(
        Theme.CHECKED_ROLE_PAIRS.map(
          ({ foreground, background, required }) => `${foreground}/${background}/${required}`,
        ),
      ),
    ).toEqual(
      new Set([
        ...TEXT_PAIRS.map(([fg, bg]) => `${fg}/${bg}/${TEXT_AA}`),
        ...NON_TEXT_PAIRS.map(([fg, bg]) => `${fg}/${bg}/${NON_TEXT_AA}`),
      ]),
    );
  });

  test("all 6 presets × 6 scheme variants × 50 pairs (1,800 pairs) pass WCAG 2.1 AA", () => {
    let totalSchemes = 0;
    let totalPairs = 0;

    for (const presetId of EXPECTED_PRESETS) {
      const resolved = resolveChoice({ _tag: "Preset", id: presetId });
      expect((resolved.warnings ?? []).filter((w) => w === "theme.low_contrast")).toEqual([]);
      expect(Theme.auditTheme(resolved.schemes)).toEqual([]);

      for (const variant of EXPECTED_VARIANTS) {
        totalSchemes += 1;
        totalPairs += assertSchemeAccessible(presetId, variant, resolved.schemes[variant]);
      }
    }

    expect(totalSchemes).toBe(36);
    expect(totalPairs).toBe(36 * (42 + 8));
  });

  test("representative custom seeds across luminance extremes pass WCAG 2.1 AA", () => {
    const seeds: ReadonlyArray<Hex> = [
      "#000000" as Hex,
      "#FFFFFF" as Hex,
      "#1D4ED8" as Hex,
      "#0F5D42" as Hex,
      "#DC2626" as Hex,
      "#F59E0B" as Hex,
      "#7C3AED" as Hex,
    ];

    for (const hex of seeds) {
      const resolved = resolveChoice({ _tag: "Seed", hex });
      expect(Theme.auditTheme(resolved.schemes)).toEqual([]);
      for (const variant of EXPECTED_VARIANTS) {
        assertSchemeAccessible(`seed(${hex})`, variant, resolved.schemes[variant]);
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
