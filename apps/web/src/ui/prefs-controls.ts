import type { Html } from "@effect/ui/html";
/**
 * Viewer preference controls: language (cs/en), colour mode, style (Elegant/Cozy), contrast and
 * built-in theme preset. Compact form sits in the top bar and public header; the full form is
 * reused by the Account appearance tab and the Branding theme customizer.
 */
import { Theme } from "@kvitbit/ui-port";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import type { Translator } from "../app/i18n";
import type { Prefs } from "../app/prefs";
import type { Markup } from "./html";
import { select } from "./kit";

const LOCALE_LABEL = { cs: "Čeština", en: "English" } as const;

const localeSelect = <M>(
  h: Html.H<M>,
  prefs: Prefs,
  onChange: (p: Prefs) => M,
  id = "kb-locale",
): Markup<M> =>
  select(h, {
    id,
    label: prefs.locale === "cs" ? "Jazyk" : "Language",
    value: prefs.locale,
    options: [
      { value: "cs", label: LOCALE_LABEL.cs },
      { value: "en", label: LOCALE_LABEL.en },
    ],
    onChange: (v) => onChange({ ...prefs, locale: v === "en" ? "en" : "cs" }),
  });

const modeSelect = <M>(
  h: Html.H<M>,
  t: Translator,
  prefs: Prefs,
  onChange: (p: Prefs) => M,
  id = "kb-mode",
): Markup<M> =>
  select(h, {
    id,
    label: t.t("account.appearance.mode"),
    value: prefs.mode,
    options: Arr.map(["system", "light", "dark"] as const, (m) => ({
      value: m,
      label: t.translate(Theme.modeNameText(m)),
    })),
    onChange: (v) => onChange({ ...prefs, mode: v === "light" || v === "dark" ? v : "system" }),
  });

/** Top-bar cluster: language + mode. */
const compactPrefsImpl = <M>(
  h: Html.H<M>,
  t: Translator,
  prefs: Prefs,
  onChange: (p: Prefs) => M,
): Markup<M> =>
  h.div
    .class("kb-prefs")
    .children([localeSelect(h, prefs, onChange), modeSelect(h, t, prefs, onChange)]);

export const compactPrefs: {
  <M>(t: Translator, prefs: Prefs, onChange: (p: Prefs) => M): (h: Html.H<M>) => Markup<M>;
  <M>(h: Html.H<M>, t: Translator, prefs: Prefs, onChange: (p: Prefs) => M): Markup<M>;
} = Fn.dual(4, compactPrefsImpl);
