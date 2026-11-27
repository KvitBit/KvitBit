import { describe, expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Exit from "effect/Exit";
import * as Fn from "effect/Function";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import {
  auditTheme,
  decodeMaterialTheme,
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

const encodeJsonExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const encodeJson = (input: unknown): string => {
  const json = encodeJsonExit(input);
  if (Exit.isFailure(json))
    throw new Error("Could not encode theme fixture", { cause: json.cause });
  return json.value;
};
const UPPERCASE_HEX = /^#[0-9A-F]{6}$/;
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
  Result.isFailure(r) ? Arr.map(r.failure.issues, (i) => i.code) : [];

test("decodeMaterialTheme keeps the decoded file alongside the normalized seed", () => {
  const r = decodeMaterialTheme(exportFile({ seed: "#0e6b8c" }));
  if (Result.isFailure(r)) throw new Error("expected success");
  expect(r.success.file.seed).toBe("#0e6b8c");
  expect(r.success.file.palettes).toEqual({ primary: { "0": "#000000", "100": "#FFFFFF" } });
  expect(r.success.seed).toBe("#0E6B8C");
});

describe("parseMaterialThemeFile", () => {
  test("accepts a complete export and previews its own schemes", () => {
    const r = parseMaterialThemeFile(encodeJson(exportFile()), MAX);
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
    const r = parseMaterialThemeFile(`{${Fn.pipe(" ", Str.repeat(MAX))}}`, MAX);
    expect(r.pipe(codes)).toEqual(["theme.too_large"]);
    expect(Result.isFailure(r) && r.failure.issues[0]?.params).toEqual({ maxBytes: String(MAX) });
    // Multi-byte characters count as UTF-8 bytes, not UTF-16 units.
    expect(parseMaterialThemeFile(`"${Fn.pipe("č", Str.repeat(40))}"`, 60).pipe(codes)).toEqual([
      "theme.too_large",
    ]);
  });

  test.each([
    "not json",
    "[]",
    "null",
    '{"seed":"#0E6B8C"}',
    encodeJson({ ...exportFile(), schemes: 1 }),
  ])("rejects %p as theme.json_invalid", (source) =>
    expect(parseMaterialThemeFile(source, MAX).pipe(codes)).toEqual(["theme.json_invalid"]),
  );

  test("rejects a malformed seed as theme.seed_invalid", () => {
    expect(
      parseMaterialThemeFile(encodeJson(exportFile({ seed: "teal" })), MAX).pipe(codes),
    ).toEqual(["theme.seed_invalid"]);
  });

  test("names every role missing from light or dark (rule M2)", () => {
    const { primary: _p, onPrimary: _o, ...light } = ocean.light.roles;
    const file = exportFile();
    const r = parseMaterialThemeFile(
      encodeJson({ ...file, schemes: { ...file.schemes, light } }),
      MAX,
    );
    if (!Result.isFailure(r)) throw new Error("expected failure");
    expect(r.failure._tag).toBe("Invalid");
    expect(
      Arr.map(r.failure.issues, (i) => [i.code, Arr.join(Arr.map(i.path, String), "/")]),
    ).toEqual([
      ["theme.json_invalid", "schemes/light/primary"],
      ["theme.json_invalid", "schemes/light/onPrimary"],
    ]);
  });

  test("warns when contrast schemes or extended colours are absent", () => {
    const r = parseMaterialThemeFile(
      encodeJson({
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
    expect(r.success.schemes.darkHigh.roles.primary).toMatch(UPPERCASE_HEX);
    expect(auditTheme(r.success.schemes)).toEqual([]);
  });

  test("accepts a low-contrast file but flags it with theme.low_contrast", () => {
    const washed: RoleMap = { ...ocean.light.roles, onPrimary: "#3A87A8", onSurface: "#B0B0B0" };
    const r = resolveMaterialTheme(
      exportFile({ schemes: { light: washed, dark: ocean.dark.roles } }),
    );
    if (!Result.isSuccess(r)) throw new Error("expected success");
    expect(r.success.warnings).toEqual(["theme.low_contrast"]);
    const failing = Arr.map(
      auditTheme(r.success.schemes),
      (i) => `${i.variant}:${i.foreground}/${i.background}`,
    );
    expect(failing).toContain("light:onPrimary/primary");
    expect(failing).toContain("light:onSurface/surface");
    expect(Arr.every(failing, Str.startsWith("light:"))).toBe(true);
  });

  test("flags invisible text on a fixed-dim background", () => {
    const light: RoleMap = {
      ...ocean.light.roles,
      primaryFixedDim: ocean.light.roles.onPrimaryFixed,
    };
    const r = resolveMaterialTheme(exportFile({ schemes: { ...exportFile().schemes, light } }));
    if (!Result.isSuccess(r)) throw new Error("expected success");
    expect(r.success.warnings).toEqual(["theme.low_contrast"]);
    expect(
      Arr.map(auditTheme(r.success.schemes), (i) => `${i.foreground}/${i.background}`),
    ).toContain("onPrimaryFixed/primaryFixedDim");
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
    const big = exportFile({ description: Fn.pipe("x", Str.repeat(70 * 1024)) });
    expect(resolveMaterialTheme(big).pipe(codes)).toEqual(["theme.too_large"]);
    expect(resolveSource({ _tag: "MaterialThemeBuilder", json: big }).pipe(codes)).toEqual([
      "theme.too_large",
    ]);
    expect(resolveMaterialTheme({ seed: 1n }).pipe(codes)).toEqual(["theme.json_invalid"]);
  });

  test("resolveSource routes each source tag", () => {
    expect(resolveSource({ _tag: "Preset", id: "plum" }).pipe(Result.isSuccess)).toBe(true);
    expect(resolveSource({ _tag: "Seed", seed: "#123456" }).pipe(Result.isSuccess)).toBe(true);
    expect(
      resolveSource({ _tag: "MaterialThemeBuilder", json: { nope: true } }).pipe(codes),
    ).toEqual(["theme.json_invalid"]);
  });
});
