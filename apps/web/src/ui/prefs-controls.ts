import type { Html } from "@effect/ui/html";
/**
 * Language and colour mode controls shared by the top bar and public header.
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
    compact: true,
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
    compact: true,
  });

/** Top-bar cluster: language + mode. */
const compactPrefsImpl = <M>(
  h: Html.H<M>,
  t: Translator,
  prefs: Prefs,
  onChange: (p: Prefs) => M,
): Markup<M> =>
  h.div
    .class("flex items-center gap-1.5")
    .children([localeSelect(h, prefs, onChange), modeSelect(h, t, prefs, onChange)]);

export const compactPrefs: {
  <M>(t: Translator, prefs: Prefs, onChange: (p: Prefs) => M): (h: Html.H<M>) => Markup<M>;
  <M>(h: Html.H<M>, t: Translator, prefs: Prefs, onChange: (p: Prefs) => M): Markup<M>;
} = Fn.dual(4, compactPrefsImpl);
