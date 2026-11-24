import { describe, expect, test } from "bun:test";
import {
  EXTENDED_ROLES,
  M3_COLOR_ROLES,
  type M3ColorRole,
  ThemePresets,
} from "@kvitbit/api-contract";
import {
  auditTheme,
  contrastRatio,
  EXTENDED_SOURCE_COLORS,
  Hct,
  KvitbitDefaultTheme,
  PRESET_IDS,
  PresetDefinitions,
  resolvePreset,
  resolveSeed,
  rgbFromHex,
  SCHEME_VARIANTS,
} from "../../src/theme";
import { labFromRgb } from "../../src/theme/color/utils";

const ratio = (a: string, b: string) => contrastRatio(rgbFromHex(a), rgbFromHex(b));
const HEX = /^#[0-9A-F]{6}$/;

/** CIELAB chroma and hue: sRGB greys sit at chroma 0, so any chroma is a real tint. */
const labLch = (hex: string) => {
  const [, a, b] = labFromRgb(rgbFromHex(hex));
  return { chroma: Math.hypot(a, b), hue: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
};
const hueDistance = (a: number, b: number) => 180 - Math.abs(Math.abs(a - b) - 180);

const themes = PRESET_IDS.map((id) => [id, resolvePreset(id)] as const);

describe("preset schemes", () => {
  test("cover the six canonical preset ids", () => {
    expect<string[]>([...PRESET_IDS].sort()).toEqual(Object.keys(ThemePresets).sort());
  });

  test.each(themes)("%s: every variant has every role as #RRGGBB", (_, theme) => {
    for (const v of SCHEME_VARIANTS) {
      const s = theme.schemes[v];
      expect(Object.keys(s.roles).sort()).toEqual([...M3_COLOR_ROLES].sort());
      for (const role of M3_COLOR_ROLES) expect(s.roles[role]).toMatch(HEX);
      for (const e of EXTENDED_ROLES)
        for (const value of Object.values(s.extended[e])) expect(value).toMatch(HEX);
    }
  });

  test.each(themes)("%s: all six variants meet WCAG AA on every checked pair", (_, theme) => {
    expect(auditTheme(theme.schemes)).toEqual([]);
    expect(theme.warnings).toBeUndefined();
  });

  const TEXT_PAIRS: ReadonlyArray<readonly [M3ColorRole, M3ColorRole]> = [
    ["onPrimary", "primary"],
    ["onPrimaryContainer", "primaryContainer"],
    ["onSurface", "surface"],
    ["onSurface", "surfaceContainerLowest"],
    ["onSurface", "surfaceContainerLow"],
    ["onSurface", "surfaceContainer"],
    ["onSurface", "surfaceContainerHigh"],
    ["onSurface", "surfaceContainerHighest"],
    ["onSurfaceVariant", "surfaceContainerHighest"],
    ["onError", "error"],
    ["onErrorContainer", "errorContainer"],
  ];
  test.each(themes)("%s light + dark: explicit AA text pairs", (_, theme) => {
    for (const v of ["light", "dark"] as const) {
      const { roles, extended } = theme.schemes[v];
      for (const [fg, bg] of TEXT_PAIRS)
        expect(ratio(roles[fg], roles[bg])).toBeGreaterThanOrEqual(4.5);
      for (const e of EXTENDED_ROLES) {
        expect(ratio(extended[e].onColor, extended[e].color)).toBeGreaterThanOrEqual(4.5);
        expect(
          ratio(extended[e].onColorContainer, extended[e].colorContainer),
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test.each(themes)("%s: contrast rises from standard to medium to high", (_, theme) => {
    for (const side of ["light", "dark"] as const) {
      const std = theme.schemes[side].roles;
      const med = theme.schemes[`${side}Medium`].roles;
      const high = theme.schemes[`${side}High`].roles;
      const r = (m: typeof std) => ratio(m.onSurfaceVariant, m.surfaceContainerHighest);
      expect(r(med)).toBeGreaterThanOrEqual(r(std));
      expect(r(high)).toBeGreaterThan(r(med));
      expect(ratio(high.onSurface, high.surface)).toBeGreaterThanOrEqual(
        ratio(std.onSurface, std.surface),
      );
    }
  });
});

describe("tonal neutrals", () => {
  const TINTED: ReadonlyArray<M3ColorRole> = [
    "surface",
    "surfaceContainerLowest",
    "surfaceContainer",
    "surfaceContainerHighest",
    "onSurface",
    "onSurfaceVariant",
    "outline",
    "outlineVariant",
  ];
  const tinted = themes.filter(([id]) => id !== "graphite_atelier");

  test.each(tinted)("%s: neutral roles carry the seed's undertone", (id, theme) => {
    const seedHue = labLch(PresetDefinitions[id].seed).hue;
    for (const v of ["light", "dark"] as const) {
      for (const role of TINTED.filter((r) => r !== "surfaceContainerLowest" || v === "dark")) {
        const c = labLch(theme.schemes[v].roles[role]);
        expect({ id, v, role, tinted: c.chroma >= 1.5 }).toEqual({ id, v, role, tinted: true });
        expect(hueDistance(c.hue, seedHue)).toBeLessThanOrEqual(40);
      }
    }
  });

  test("presets have distinct undertones (surfaces differ between presets)", () => {
    const surfaces = new Set(themes.map(([, t]) => t.schemes.light.roles.surfaceContainer));
    expect(surfaces.size).toBe(themes.length);
  });

  test("Graphite Atelier stays achromatic zinc", () => {
    for (const v of ["light", "dark"] as const)
      for (const role of [
        "surface",
        "surfaceContainerLow",
        "surfaceContainer",
        "onSurface",
      ] as const)
        expect(labLch(KvitbitDefaultTheme.schemes[v].roles[role]).chroma).toBeLessThan(3.5);
  });
});

describe("Graphite Atelier (KvitbitDefaultTheme)", () => {
  test("is the graphite_atelier preset", () => {
    expect(KvitbitDefaultTheme.source).toEqual({ _tag: "Preset", id: "graphite_atelier" });
  });

  test("uses DESIGN.md's exact light and dark roles", () => {
    const l = KvitbitDefaultTheme.schemes.light.roles;
    const d = KvitbitDefaultTheme.schemes.dark.roles;
    expect([
      l.surface,
      l.surfaceContainerLowest,
      l.surfaceContainerLow,
      l.surfaceContainer,
    ]).toEqual(["#F4F4F5", "#FFFFFF", "#EFEFF1", "#E8E8EC"]);
    expect([l.primary, l.onPrimary, l.onSurface, l.onSurfaceVariant, l.outline, l.error]).toEqual([
      "#18181B",
      "#FAFAFA",
      "#09090B",
      "#52525B",
      "#A1A1AA",
      "#B91C1C",
    ]);
    expect([d.surface, d.surfaceContainerHigh, d.primary, d.onPrimary, d.errorContainer]).toEqual([
      "#09090B",
      "#232329",
      "#FAFAFA",
      "#09090B",
      "#351517",
    ]);
  });

  test("more contrast never lowers contrast of DESIGN.md's exact pairs", () => {
    const s = KvitbitDefaultTheme.schemes;
    for (const side of ["light", "dark"] as const) {
      const steps = [s[side], s[`${side}Medium`], s[`${side}High`]].map((x) => x.roles);
      for (const [fg, bg] of [
        ["onPrimary", "primary"],
        ["onSurface", "surface"],
        ["onSurfaceVariant", "surfaceContainerHigh"],
        ["onErrorContainer", "errorContainer"],
      ] as const) {
        const r = steps.map((m) => ratio(m[fg], m[bg]));
        expect(r[1] ?? 0).toBeGreaterThanOrEqual((r[0] ?? 0) - 0.01);
        expect(r[2] ?? 0).toBeGreaterThanOrEqual((r[1] ?? 0) - 0.01);
      }
    }
  });

  test("light surface containers step down from lowest to highest", () => {
    for (const v of ["light", "lightMedium", "lightHigh"] as const) {
      const r = KvitbitDefaultTheme.schemes[v].roles;
      const tones = [
        r.surfaceContainerLowest,
        r.surfaceContainerLow,
        r.surfaceContainer,
        r.surfaceContainerHigh,
        r.surfaceContainerHighest,
      ].map((h) => Hct.fromRgb(rgbFromHex(h)).tone);
      for (let i = 1; i < tones.length; i++) expect(tones[i] ?? 0).toBeLessThan(tones[i - 1] ?? 0);
    }
  });

  test("extended colours are not pulled toward the achromatic primary", () => {
    const paid = Hct.fromRgb(rgbFromHex(KvitbitDefaultTheme.schemes.light.extended.paid.color));
    const source = Hct.fromRgb(rgbFromHex(EXTENDED_SOURCE_COLORS.paid));
    expect(Math.abs(paid.hue - source.hue)).toBeLessThan(2);
  });
});

describe("seeds", () => {
  test.each(["forest", "ocean", "plum", "sand"] as const)(
    "%s: light primary renders the seed itself (fidelity)",
    (id) => {
      const primary = resolvePreset(id).schemes.light.roles.primary;
      const seed = PresetDefinitions[id].seed;
      expect(ratio(primary, seed)).toBeLessThan(1.05);
    },
  );

  test("records where tuned seeds differ from api-contract's placeholder ThemePresets", () => {
    const diff = PRESET_IDS.filter((id) => PresetDefinitions[id].seed !== ThemePresets[id].seed);
    expect(diff).toEqual(["ocean", "sand"]);
  });

  test.each([
    "#FFD600",
    "#FF0000",
    "#00FFFF",
    "#FFFFFF",
    "#000000",
    "#F59E0B",
    "#EC4899",
    "#7FFFD4",
  ])("custom seed %s resolves to an AA-clean theme", (seed) => {
    const theme = resolveSeed(seed);
    expect(theme.source).toEqual({ _tag: "Seed", seed });
    expect(auditTheme(theme.schemes)).toEqual([]);
  });

  test("extended colours harmonize toward the primary by at most 15 degrees", () => {
    const theme = resolveSeed("#1D4ED8");
    for (const role of EXTENDED_ROLES) {
      const source = Hct.fromRgb(rgbFromHex(EXTENDED_SOURCE_COLORS[role]));
      const out = Hct.fromRgb(rgbFromHex(theme.schemes.light.extended[role].color));
      expect(hueDistance(out.hue, source.hue)).toBeLessThanOrEqual(15.5);
    }
    const overdue = Hct.fromRgb(rgbFromHex(theme.schemes.light.extended.overdue.color));
    const overdueSource = Hct.fromRgb(rgbFromHex(EXTENDED_SOURCE_COLORS.overdue));
    const primaryHue = Hct.fromRgb(rgbFromHex("#1D4ED8")).hue;
    expect(hueDistance(overdue.hue, primaryHue)).toBeLessThan(
      hueDistance(overdueSource.hue, primaryHue),
    );
  });
});
