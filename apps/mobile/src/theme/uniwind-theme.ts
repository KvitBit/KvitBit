import { uniwindThemeVariables } from "@kvitbit/ui-port/style";
import { Uniwind } from "uniwind";
import type { AppTheme } from "./theme-state";

export const syncUniwindTheme = (theme: AppTheme): void => {
  const themeName = theme.native.dark ? "dark" : "light";
  Uniwind.setTheme(themeName);
  Uniwind.updateCSSVariables(themeName, uniwindThemeVariables(theme.effective));
};
