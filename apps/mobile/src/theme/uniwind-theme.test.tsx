import { describe, expect, test } from "bun:test";
import {
  TAILWIND_COLOR_TOKENS,
  TAILWIND_RADIUS_TOKENS,
  uniwindThemeVariables,
} from "@kvitbit/ui-port/style";
import { effectiveTheme, initialThemeState } from "@kvitbit/ui-port/theme";
import * as Option from "effect/Option";
import * as EffectRecord from "effect/Record";
import { uniwindState as state } from "../testing/native-modules.preload";
import { syncUniwindTheme } from "./theme-provider";
import { appTheme, themeStateOf } from "./theme-state";

describe("Uniwind theme contract", () => {
  test("global.css declares @theme, --color-*: initial, and every shared color & radius token for light and dark", async () => {
    const css = await Bun.file(new URL("../../global.css", import.meta.url)).text();
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
    const lightTheme = appTheme(
      themeStateOf(
        { scheme: "light", highContrast: false, dynamic: null },
        { mode: "light", style: "elegant", contrast: "standard", dynamicColor: false },
      ),
    );
    syncUniwindTheme(lightTheme);
    const expectedLight = uniwindThemeVariables(
      effectiveTheme(initialThemeState({ scheme: "light" })),
    );
    expect(state.currentTheme).toBe("light");
    expect(Option.getOrUndefined(EffectRecord.get(state.vars, "light"))?.["--color-primary"]).toBe(
      expectedLight["--color-primary"],
    );
    expect(Option.getOrUndefined(EffectRecord.get(state.vars, "light"))?.["--radius-panel"]).toBe(
      "4px",
    );

    const cozyDark = appTheme(
      themeStateOf(
        { scheme: "dark", highContrast: false, dynamic: null },
        { mode: "dark", style: "cozy", contrast: "standard", dynamicColor: false },
      ),
    );
    syncUniwindTheme(cozyDark);
    const expectedDark = uniwindThemeVariables(cozyDark.effective);
    expect(state.currentTheme).toBe("dark");
    expect(Option.getOrUndefined(EffectRecord.get(state.vars, "dark"))?.["--color-primary"]).toBe(
      expectedDark["--color-primary"],
    );
    expect(Option.getOrUndefined(EffectRecord.get(state.vars, "dark"))?.["--radius-panel"]).toBe(
      `${cozyDark.effective.tokens.shape.panel}px`,
    );
  });
});
