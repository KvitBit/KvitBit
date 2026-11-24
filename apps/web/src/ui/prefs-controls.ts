/**
 * Viewer preference controls: language (cs/en), colour mode, style (Elegant/Cozy), contrast and
 * built-in theme preset. Compact form sits in the top bar and public header; the full form is
 * reused by the Account appearance tab and the Branding theme customizer.
 */
import { DEFAULT_THEME_PRESET } from "@kvitbit/domain";
import { Theme } from "@kvitbit/ui-port";
import type { Html, HtmlBuilder } from "foldkit/html";
import type { Translator } from "../app/i18n";
import type { Prefs } from "../app/prefs";
import { select, selectField } from "./kit";

const LOCALE_LABEL = { cs: "Čeština", en: "English" } as const;

export const localeSelect = <M>(
  h: HtmlBuilder<M>,
  prefs: Prefs,
  onChange: (p: Prefs) => M,
  id = "kb-locale",
): Html =>
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

export const modeSelect = <M>(
  h: HtmlBuilder<M>,
  t: Translator,
  prefs: Prefs,
  onChange: (p: Prefs) => M,
  id = "kb-mode",
): Html =>
  select(h, {
    id,
    label: t.t("account.appearance.mode"),
    value: prefs.mode,
    options: (["system", "light", "dark"] as const).map((m) => ({
      value: m,
      label: t.translate(Theme.modeNameText(m)),
    })),
    onChange: (v) => onChange({ ...prefs, mode: v === "light" || v === "dark" ? v : "system" }),
  });

/** Top-bar cluster: language + mode. */
export const compactPrefs = <M>(
  h: HtmlBuilder<M>,
  t: Translator,
  prefs: Prefs,
  onChange: (p: Prefs) => M,
): Html =>
  h.div(
    [h.Class("kb-prefs")],
    [localeSelect(h, prefs, onChange), modeSelect(h, t, prefs, onChange)],
  );

/** Full appearance form: mode, style, contrast, preset. */
export const appearanceForm = <M>(
  h: HtmlBuilder<M>,
  t: Translator,
  prefs: Prefs,
  onChange: (p: Prefs) => M,
): Html =>
  h.div(
    [h.Class("kb-grid"), h.Style({ "--kb-grid-min": "200px" })],
    [
      selectField(h, {
        id: "kb-appearance-mode",
        label: t.t("account.appearance.mode"),
        value: prefs.mode,
        options: (["system", "light", "dark"] as const).map((m) => ({
          value: m,
          label: t.translate(Theme.modeNameText(m)),
        })),
        onChange: (v) => onChange({ ...prefs, mode: v === "light" || v === "dark" ? v : "system" }),
      }),
      selectField(h, {
        id: "kb-appearance-style",
        label: t.t("account.appearance.style"),
        value: prefs.style,
        options: (["elegant", "cozy"] as const).map((s) => ({
          value: s,
          label: t.translate(Theme.styleNameText(s)),
        })),
        onChange: (v) => onChange({ ...prefs, style: v === "cozy" ? "cozy" : "elegant" }),
      }),
      selectField(h, {
        id: "kb-appearance-contrast",
        label: t.t("account.appearance.contrast"),
        value: prefs.contrast,
        options: (["standard", "medium", "high"] as const).map((c) => ({
          value: c,
          label: t.translate(Theme.contrastNameText(c)),
        })),
        onChange: (v) =>
          onChange({ ...prefs, contrast: v === "medium" || v === "high" ? v : "standard" }),
      }),
      selectField(h, {
        id: "kb-appearance-preset",
        label: t.t("account.appearance.presets"),
        value: prefs.theme._tag === "Preset" ? prefs.theme.id : "",
        options: [
          ...(prefs.theme._tag === "Seed"
            ? [{ value: "", label: t.t("account.appearance.seed") }]
            : []),
          ...Theme.PRESET_IDS.map((id) => ({
            value: id,
            label: t.translate(Theme.presetNameText(id)),
          })),
        ],
        onChange: (v) =>
          onChange({
            ...prefs,
            theme: {
              _tag: "Preset",
              id: Theme.PRESET_IDS.find((id) => id === v) ?? DEFAULT_THEME_PRESET,
            },
          }),
      }),
      localeSelectField(h, prefs, onChange),
    ],
  );

const localeSelectField = <M>(h: HtmlBuilder<M>, prefs: Prefs, onChange: (p: Prefs) => M): Html =>
  selectField(h, {
    id: "kb-appearance-locale",
    label: prefs.locale === "cs" ? "Jazyk" : "Language",
    value: prefs.locale,
    options: [
      { value: "cs", label: LOCALE_LABEL.cs },
      { value: "en", label: LOCALE_LABEL.en },
    ],
    onChange: (v) => onChange({ ...prefs, locale: v === "en" ? "en" : "cs" }),
  });
