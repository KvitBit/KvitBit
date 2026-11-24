import { describe, expect, test } from "bun:test";
import { Result } from "effect";
import {
  auditTheme,
  extendedScheme,
  fileWarningText,
  Hct,
  parseMaterialThemeFile,
  type RoleMap,
  resolveMaterialTheme,
  resolvePreset,
  resolveSource,
  rgbFromHex,
  SCHEME_VARIANTS,
} from "../../src/theme";

const MAX = 64 * 1024;
const ocean = resolvePreset("ocean").schemes;

/** A Theme Builder export shaped like the real file (lower-case keys, extra roles, palettes). */
const exportFile = (overrides: Record<string, unknown> = {}) => ({
  description: "TYPE: CUSTOM\nMaterial Theme Builder export 2026-11-20",
  seed: "#0E6B8C",
  coreColors: { primary: "#0E6B8C" },
  extendedColors: [
    { name: "Paid", color: "#1F8A4C", description: "", harmonized: true },
    { name: "overdue", color: "#C2410C", description: "", harmonized: false },
    { name: "Brand accent", color: "#FF00AA", description: "", harmonized: true },
  ],
  schemes: {
    light: { ...ocean.light.roles, surfaceContainerExtra: "#FFFFFF" },
    "light-medium-contrast": ocean.lightMedium.roles,
    "light-high-contrast": ocean.lightHigh.roles,
    dark: ocean.dark.roles,
    "dark-medium-contrast": ocean.darkMedium.roles,
    "dark-high-contrast": ocean.darkHigh.roles,
  },
  palettes: { primary: { "0": "#000000", "100": "#FFFFFF" } },
  ...overrides,
});

const codes = (r: Result.Result<unknown, { issues: ReadonlyArray<{ code: string }> }>) =>
  Result.isFailure(r) ? r.failure.issues.map((i) => i.code) : [];

describe("parseMaterialThemeFile", () => {
  test("accepts a complete export and previews its own schemes", () => {
    const r = parseMaterialThemeFile(JSON.stringify(exportFile()), MAX);
    if (!Result.isSuccess(r)) throw new Error("expected success");
    expect(r.success.seed).toBe("#0E6B8C");
    expect(r.success.preview.light).toEqual(ocean.light.roles);
    expect(r.success.preview.dark).toEqual(ocean.dark.roles);
    expect(r.success.extendedFound).toEqual(["paid", "overdue"]);
    expect(r.success.warnings).toEqual(["unknown_roles_ignored"]);
    expect(r.success.unknownRoles).toEqual(["surfaceContainerExtra"]);
    expect(fileWarningText("unknown_roles_ignored", r.success)).toEqual({
      key: "theme.warning.unknown_roles_ignored",
      params: { count: 1 },
    });
  });

  test("checks the byte limit before parsing (rule M1)", () => {
    const r = parseMaterialThemeFile(`{${" ".repeat(MAX)}}`, MAX);
    expect(codes(r)).toEqual(["theme.too_large"]);
    expect(Result.isFailure(r) && r.failure.issues[0]?.params).toEqual({ maxBytes: String(MAX) });
    // Multi-byte characters count as UTF-8 bytes, not UTF-16 units.
    expect(codes(parseMaterialThemeFile(`"${"č".repeat(40)}"`, 60))).toEqual(["theme.too_large"]);
  });

  test.each([
    "not json",
    "[]",
    "null",
    '{"seed":"#0E6B8C"}',
    JSON.stringify({ ...exportFile(), schemes: 1 }),
  ])("rejects %p as theme.json_invalid", (source) =>
    expect(codes(parseMaterialThemeFile(source, MAX))).toEqual(["theme.json_invalid"]),
  );

  test("rejects a malformed seed as theme.seed_invalid", () => {
    expect(
      codes(parseMaterialThemeFile(JSON.stringify(exportFile({ seed: "teal" })), MAX)),
    ).toEqual(["theme.seed_invalid"]);
  });

  test("names every role missing from light or dark (rule M2)", () => {
    const { primary: _p, onPrimary: _o, ...light } = ocean.light.roles;
    const file = exportFile();
    const r = parseMaterialThemeFile(
      JSON.stringify({ ...file, schemes: { ...file.schemes, light } }),
      MAX,
    );
    if (!Result.isFailure(r)) throw new Error("expected failure");
    expect(r.failure._tag).toBe("Invalid");
    expect(r.failure.issues.map((i) => [i.code, i.path.join("/")])).toEqual([
      ["theme.json_invalid", "schemes/light/primary"],
      ["theme.json_invalid", "schemes/light/onPrimary"],
    ]);
  });

  test("warns when contrast schemes or extended colours are absent", () => {
    const r = parseMaterialThemeFile(
      JSON.stringify({
        seed: "#0E6B8C",
        coreColors: { primary: "#0E6B8C" },
        schemes: { light: ocean.light.roles, dark: ocean.dark.roles },
      }),
      MAX,
    );
    if (!Result.isSuccess(r)) throw new Error("expected success");
    expect(r.success.warnings).toEqual(["missing_contrast_schemes", "no_extended_colours"]);
    expect(r.success.extendedFound).toEqual([]);
  });
});

describe("resolveMaterialTheme", () => {
  test("uses the file's schemes and honours its extended colours", () => {
    const json = exportFile();
    const r = resolveMaterialTheme(json);
    if (!Result.isSuccess(r)) throw new Error("expected success");
    const theme = r.success;
    expect(theme.source).toEqual({ _tag: "MaterialThemeBuilder", json });
    expect(theme.schemes.lightHigh.roles).toEqual(ocean.lightHigh.roles);
    // "overdue" opts out of harmonization: its hue stays the file colour's hue.
    const hue = (hex: string) => Hct.fromRgb(rgbFromHex(hex)).hue;
    expect(Math.abs(hue(theme.schemes.light.extended.overdue.color) - hue("#C2410C"))).toBeLessThan(
      1.5,
    );
    // "Paid" opts in: its hue moves toward the seed.
    expect(Math.abs(hue(theme.schemes.light.extended.paid.color) - hue("#1F8A4C"))).toBeGreaterThan(
      5,
    );
    expect(theme.warnings).toBeUndefined();
  });

  test("generates missing contrast schemes from the seed", () => {
    const r = resolveMaterialTheme({
      seed: "#0E6B8C",
      coreColors: { primary: "#0E6B8C" },
      schemes: { light: ocean.light.roles, dark: ocean.dark.roles },
    });
    if (!Result.isSuccess(r)) throw new Error("expected success");
    expect(r.success.schemes.darkHigh.roles.primary).toMatch(/^#[0-9A-F]{6}$/);
    expect(auditTheme(r.success.schemes)).toEqual([]);
  });

  test("accepts a low-contrast file but flags it with theme.low_contrast", () => {
    const washed: RoleMap = { ...ocean.light.roles, onPrimary: "#3A87A8", onSurface: "#B0B0B0" };
    const r = resolveMaterialTheme(
      exportFile({ schemes: { light: washed, dark: ocean.dark.roles } }),
    );
    if (!Result.isSuccess(r)) throw new Error("expected success");
    expect(r.success.warnings).toEqual(["theme.low_contrast"]);
    const failing = auditTheme(r.success.schemes).map(
      (i) => `${i.variant}:${i.foreground}/${i.background}`,
    );
    expect(failing).toContain("light:onPrimary/primary");
    expect(failing).toContain("light:onSurface/surface");
    expect(failing.every((f) => f.startsWith("light:"))).toBe(true);
  });

  test("flags invisible text on a fixed-dim background", () => {
    const light: RoleMap = {
      ...ocean.light.roles,
      primaryFixedDim: ocean.light.roles.onPrimaryFixed,
    };
    const r = resolveMaterialTheme(exportFile({ schemes: { ...exportFile().schemes, light } }));
    if (!Result.isSuccess(r)) throw new Error("expected success");
    expect(r.success.warnings).toEqual(["theme.low_contrast"]);
    expect(auditTheme(r.success.schemes).map((i) => `${i.foreground}/${i.background}`)).toContain(
      "onPrimaryFixed/primaryFixedDim",
    );
  });

  test("generated contrast schemes harmonize toward their own primary", () => {
    const blue = resolvePreset("sand").schemes;
    const r = resolveMaterialTheme({
      seed: "#FF0000",
      coreColors: { primary: "#FF0000" },
      schemes: { light: blue.light.roles, dark: blue.dark.roles },
    });
    if (!Result.isSuccess(r)) throw new Error("expected success");
    for (const v of SCHEME_VARIANTS) {
      const s = r.success.schemes[v];
      expect(s.extended).toEqual(extendedScheme(s.roles.primary, v));
    }
  });

  test("the structured path enforces the byte limit too", () => {
    const big = exportFile({ description: "x".repeat(70 * 1024) });
    expect(codes(resolveMaterialTheme(big))).toEqual(["theme.too_large"]);
    expect(codes(resolveSource({ _tag: "MaterialThemeBuilder", json: big }))).toEqual([
      "theme.too_large",
    ]);
    expect(codes(resolveMaterialTheme({ seed: 1n }))).toEqual(["theme.json_invalid"]);
  });

  test("resolveSource routes each source tag", () => {
    expect(Result.isSuccess(resolveSource({ _tag: "Preset", id: "plum" }))).toBe(true);
    expect(Result.isSuccess(resolveSource({ _tag: "Seed", seed: "#123456" }))).toBe(true);
    expect(codes(resolveSource({ _tag: "MaterialThemeBuilder", json: { nope: true } }))).toEqual([
      "theme.json_invalid",
    ]);
  });
});
