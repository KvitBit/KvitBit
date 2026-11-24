/**
 * Live Material 3 theme injection. The resolved HCT tonal schemes (light, dark, medium and high
 * contrast) are serialized by @kvitbit/ui-port into `--md-sys-color-*`, `--kb-color-*` and the
 * style variables, scoped to `.kb-root`; the view renders the stylesheet inline, so a server
 * render and the hydrated client paint the same theme with no DOM command.
 */
import { Theme } from "@kvitbit/ui-port";
import type { Html, HtmlBuilder } from "foldkit/html";
import type { Prefs, ThemeChoice } from "./prefs";

export const THEME_ROOT = ".kb-root";

export const resolveChoice = (choice: ThemeChoice) =>
  choice._tag === "Preset" ? Theme.resolvePreset(choice.id) : Theme.resolveSeed(choice.hex);

const cache = new Map<string, string>();

/** The full stylesheet for a theme choice and style (memoized: the view runs on every Message). */
export const themeCss = (choice: ThemeChoice, style: Prefs["style"]): string => {
  const key = `${choice._tag === "Preset" ? choice.id : choice.hex}|${style}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const css = Theme.themeStylesheet(resolveChoice(choice), style, THEME_ROOT);
  if (cache.size > 32) cache.clear();
  cache.set(key, css);
  return css;
};

/** Attributes for the `.kb-root` element: `data-theme` only when the viewer forces a mode. */
export const rootAttributes = <M>(prefs: Prefs, h: HtmlBuilder<M>) => [
  h.Class("kb-root"),
  h.DataAttribute("style", prefs.style),
  h.DataAttribute("contrast", prefs.contrast),
  ...(prefs.mode === "system" ? [] : [h.DataAttribute("theme", prefs.mode)]),
  h.Lang(prefs.locale),
];

export const themeStyle = <M>(prefs: Prefs, h: HtmlBuilder<M>): Html =>
  h.style([h.Id("kb-theme-vars")], [themeCss(prefs.theme, prefs.style)]);
