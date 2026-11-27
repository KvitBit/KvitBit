import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  TAILWIND_COLOR_TOKENS,
  TAILWIND_RADIUS_TOKENS,
  uniwindThemeVariables,
} from "@kvitbit/ui-port/style";
import { effectiveTheme, initialThemeState } from "@kvitbit/ui-port/theme";
import { syncUniwindTheme } from "./theme-provider";
import { appTheme, themeStateOf } from "./theme-state";

const MOBILE_ROOT = resolve(import.meta.dirname, "../..");

describe("Uniwind theme contract", () => {
  test("global.css declares @theme, --color-*: initial, and every shared color & radius token for light and dark", () => {
    const css = readFileSync(resolve(MOBILE_ROOT, "global.css"), "utf8");
    expect(css).toContain('@import "tailwindcss";');
    expect(css).toContain('@import "uniwind";');
    expect(css).toContain("--color-*: initial;");
    expect(css).toContain("@variant light");
    expect(css).toContain("@variant dark");

    for (const { tailwindVar } of [...TAILWIND_COLOR_TOKENS, ...TAILWIND_RADIUS_TOKENS]) {
      expect(css).toContain(`${tailwindVar}:`);
    }
  });

  test("syncUniwindTheme pushes active theme and CSS variables into Uniwind", () => {
    const state = (
      globalThis as {
        __UNIWIND_TEST_STATE__?: {
          currentTheme: string;
          vars: Record<string, Record<string, string | number>>;
        };
      }
    ).__UNIWIND_TEST_STATE__;
    expect(state).toBeDefined();

    const lightTheme = appTheme(
      themeStateOf(
        { scheme: "light", highContrast: false, dynamic: null },
        { mode: "light", style: "elegant", contrast: "standard", dynamicColor: false },
      ),
    );
    syncUniwindTheme(lightTheme);
    const expectedLight = uniwindThemeVariables(effectiveTheme(initialThemeState("light")));
    expect(state?.currentTheme).toBe("light");
    expect(state?.vars.light?.["--color-primary"]).toBe(expectedLight["--color-primary"]);
    expect(state?.vars.light?.["--radius-panel"]).toBe("4px");

    const cozyDark = appTheme(
      themeStateOf(
        { scheme: "dark", highContrast: false, dynamic: null },
        { mode: "dark", style: "cozy", contrast: "standard", dynamicColor: false },
      ),
    );
    syncUniwindTheme(cozyDark);
    const expectedDark = uniwindThemeVariables(cozyDark.effective);
    expect(state?.currentTheme).toBe("dark");
    expect(state?.vars.dark?.["--color-primary"]).toBe(expectedDark["--color-primary"]);
    expect(state?.vars.dark?.["--radius-panel"]).toBe(`${cozyDark.effective.tokens.shape.panel}px`);
  });
});
