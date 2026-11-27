import { describe, expect, test } from "bun:test";
import { M3_COLOR_ROLES } from "@kvitbit/api-contract";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import {
  cssVariables,
  effectiveTheme,
  initialThemeState,
  KvitbitDefaultTheme,
  nativeTheme,
  StyleTokens,
  styleVariables,
  type ThemeState,
  themeStylesheet,
} from "../../src/theme";

const withStyle = (style: "elegant" | "cozy", scheme: "light" | "dark" = "light"): ThemeState => {
  const base = initialThemeState({ scheme });
  return { ...base, preference: { ...base.preference, style } };
};

describe("style tokens", () => {
  test("elegant: Erode 600 / Recia 400, lining tabular numerals, sharp 4/4/3 radii, flat", () => {
    const t = StyleTokens.elegant;
    expect([t.font.display, t.font.body.family, t.font.body.weights]).toEqual([
      { family: "Erode", weight: 600 },
      "Recia",
      [400, 500, 600],
    ]);
    expect([t.font.tabularNumerals, t.font.numericFeatureSettings]).toEqual([
      true,
      '"lnum" 1, "tnum" 1',
    ]);
    expect(t.shape).toEqual({ panel: 4, control: 4, badge: 3 });
    expect([t.surface, t.panelBorder]).toEqual(["flat", 1]);
  });

  test("cozy: Chillax 600 / Synonym 400, native lining figures, soft 12/8/pill radii, tonal", () => {
    const t = StyleTokens.cozy;
    expect([t.font.display, t.font.body.family]).toEqual([
      { family: "Chillax", weight: 600 },
      "Synonym",
    ]);
    expect([t.font.tabularNumerals, t.font.numericFeatureSettings]).toEqual([false, "normal"]);
    expect(t.shape).toEqual({ panel: 12, control: 8, badge: 9999 });
    expect([t.surface, t.panelBorder]).toEqual(["tonal", 0]);
  });

  test("both use JetBrains Mono and the M3 type scale", () => {
    for (const t of Rec.values(StyleTokens)) {
      expect(t.font.mono).toEqual({ family: "JetBrains Mono", weights: [400, 500] });
      expect(t.typeScale.bodyMedium).toEqual({
        font: "body",
        weight: 400,
        size: 14,
        lineHeight: 20,
        letterSpacing: 0.25,
      });
      expect(t.typeScale.displayLarge).toMatchObject({
        font: "display",
        weight: 600,
        size: 57,
        lineHeight: 64,
      });
      expect(t.operateScale.pageTitle.size / 16).toBe(1.125);
    }
  });
});

describe("CSS variables", () => {
  const vars = cssVariables(effectiveTheme(withStyle("elegant")));

  test("one --md-sys-color-* per role, kebab-cased", () => {
    const roleVars = Arr.filter(Rec.keys(vars), Str.startsWith("--md-sys-color-"));
    expect(roleVars).toHaveLength(M3_COLOR_ROLES.length);
    expect(vars["--md-sys-color-surface-container-high"]).toBe("#DCDCE0");
    expect(vars["--md-sys-color-on-primary"]).toBe("#FAFAFA");
  });

  test("extended colours as --kb-color-*", () => {
    const ext = KvitbitDefaultTheme.schemes.light.extended;
    expect(vars["--kb-color-paid"]).toBe(ext.paid.color);
    expect(vars["--kb-color-on-paid"]).toBe(ext.paid.onColor);
    expect(vars["--kb-color-overdue-container"]).toBe(ext.overdue.colorContainer);
    expect(vars["--kb-color-on-draft-container"]).toBe(ext.draft.onColorContainer);
  });

  test("elegant and cozy differ only in style variables", () => {
    const elegant = styleVariables("elegant");
    const cozy = styleVariables("cozy");
    expect(elegant["--kb-font-display"]).toBe('Erode, Georgia, "Times New Roman", serif');
    expect(cozy["--kb-font-display"]).toStartWith("Chillax, system-ui");
    expect(elegant["--kb-font-mono"]).toStartWith('"JetBrains Mono", ');
    expect([
      elegant["--kb-shape-panel"],
      elegant["--kb-shape-control"],
      elegant["--kb-shape-badge"],
    ]).toEqual(["4px", "4px", "3px"]);
    expect([
      cozy["--kb-shape-panel"],
      cozy["--kb-shape-control"],
      cozy["--kb-shape-badge"],
    ]).toEqual(["12px", "8px", "9999px"]);
    expect(elegant["--kb-font-numeric-settings"]).toBe('"lnum" 1, "tnum" 1');
    expect(elegant["--kb-type-body-medium-size"]).toBe("0.875rem");
    expect(elegant["--kb-operate-row-size"]).toBe("0.8125rem");
    const cozyVars = cssVariables(effectiveTheme(withStyle("cozy")));
    const colourKeys = Arr.filter(Rec.keys(vars), Str.includes("-color-"));
    for (const k of colourKeys) expect(cozyVars[k]).toBe(vars[k]);
  });

  test("variables snapshot (default theme, elegant, light)", () => {
    expect(vars).toMatchSnapshot();
  });
});

describe("themeStylesheet", () => {
  const css = themeStylesheet(KvitbitDefaultTheme, "elegant");

  test("inlines every scheme behind data-theme, data-contrast and media queries", () => {
    for (const selector of [
      ":root {",
      // biome-ignore lint/security/noSecrets: This is an expected CSS selector.
      ':root[data-contrast="medium"] {',
      ':root[data-contrast="high"] {',
      ':root[data-theme="dark"] {',
      ':root[data-theme="dark"][data-contrast="high"] {',
      "@media (prefers-color-scheme: dark) {",
      ':root:not([data-theme="light"]) {',
      "@media (prefers-contrast: more) {",
      "@media (prefers-color-scheme: dark) and (prefers-contrast: more) {",
    ])
      expect(css).toContain(selector);
    expect(css).toContain(
      `--md-sys-color-surface: ${KvitbitDefaultTheme.schemes.dark.roles.surface};`,
    );
    expect(css).toContain(
      `--md-sys-color-surface: ${KvitbitDefaultTheme.schemes.lightHigh.roles.surface};`,
    );
    expect(Str.split(css, "{").length).toBe(Str.split(css, "}").length);
  });

  test("stylesheet snapshot", () => {
    expect(css).toMatchSnapshot();
  });
});

describe("React Native theme object", () => {
  test("shape for the Expo M3 kit", () => {
    const t = nativeTheme(effectiveTheme(withStyle("cozy", "dark")));
    expect([t.dark, t.style, t.roundness, t.shape.badge, t.surface]).toEqual([
      true,
      "cozy",
      8,
      9999,
      "tonal",
    ]);
    expect(t.colors).toEqual(KvitbitDefaultTheme.schemes.dark.roles);
    expect(t.extended.paid).toEqual(KvitbitDefaultTheme.schemes.dark.extended.paid);
    expect(t.fonts.titleLarge).toEqual({
      fontFamily: "Chillax",
      fontWeight: "600",
      fontSize: 22,
      lineHeight: 28,
      letterSpacing: 0,
    });
    expect(t.numeric.fontVariant).toBeUndefined();
  });

  test("elegant numerals use lining tabular figures", () => {
    const t = nativeTheme(effectiveTheme(withStyle("elegant")));
    expect(t.numeric).toEqual({
      fontFamily: "Recia",
      fontWeight: "400",
      fontSize: 13,
      lineHeight: 18,
      letterSpacing: 0,
      fontVariant: ["lining-nums", "tabular-nums"],
    });
    expect(t.roundness).toBe(4);
  });

  test("snapshot (default theme, elegant, light)", () => {
    const base = withStyle("elegant");
    expect(nativeTheme(effectiveTheme({ ...base, account: Option.none() }))).toMatchSnapshot();
  });
});
