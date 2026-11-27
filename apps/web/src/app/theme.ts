import type { Html } from "@effect/ui/html";
/**
 * Live Material 3 theme injection. The resolved HCT tonal schemes (light, dark, medium and high
 * contrast) are serialized by @kvitbit/ui-port into `--md-sys-color-*`, `--kb-color-*` and the
 * style variables, scoped to `.kb-root`; the view renders the stylesheet inline, so a server
 * render and the hydrated client paint the same theme with no DOM command.
 */
import { Theme } from "@kvitbit/ui-port";
import * as Fn from "effect/Function";
import type { Markup } from "../ui/html";

import type { Prefs, ThemeChoice } from "./prefs";

export const THEME_ROOT = ".kb-root";

export const resolveChoice = (choice: ThemeChoice) =>
  choice._tag === "Preset" ? Theme.resolvePreset(choice.id) : Theme.resolveSeed(choice.hex);

const cache = new Map<string, string>();

/** The full stylesheet for a theme choice and style (memoized: the view runs on every Message). */
const themeCssImpl = (choice: ThemeChoice, style: Prefs["style"]): string => {
  const key = `${choice._tag === "Preset" ? choice.id : choice.hex}|${style}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const css = Theme.themeStylesheet(resolveChoice(choice), style, THEME_ROOT);
  if (cache.size > 32) cache.clear();
  cache.set(key, css);
  return css;
};

export const themeCss: {
  (style: Prefs["style"]): (choice: ThemeChoice) => string;
  (choice: ThemeChoice, style: Prefs["style"]): string;
} = Fn.dual(2, themeCssImpl);

/** Attributes for the `.kb-root` element: `data-theme` only when the viewer forces a mode. */
const rootNodeImpl = <M>(prefs: Prefs, h: Html.H<M>) =>
  h.div
    .class("kb-root")
    .attr("data-style", prefs.style)
    .attr("data-contrast", prefs.contrast)
    .attr("data-theme", prefs.mode === "system" ? undefined : prefs.mode)
    .attr("lang", prefs.locale);

export const rootNode: {
  <M>(h: Html.H<M>): (prefs: Prefs) => ReturnType<typeof rootNodeImpl<M>>;
  <M>(prefs: Prefs, h: Html.H<M>): ReturnType<typeof rootNodeImpl<M>>;
} = Fn.dual(2, rootNodeImpl);

const themeStyleImpl = <M>(prefs: Prefs, h: Html.H<M>): Markup<M> =>
  h
    .el("style")
    .attr("id", "kb-theme-vars")
    .children([themeCss(prefs.theme, prefs.style)]);

export const themeStyle: {
  <M>(h: Html.H<M>): (prefs: Prefs) => Markup<M>;
  <M>(prefs: Prefs, h: Html.H<M>): Markup<M>;
} = Fn.dual(2, themeStyleImpl);
