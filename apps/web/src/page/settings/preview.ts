import type { Html } from "@effect/ui/html";
/**
 * Shared visual components private to Settings:
 * - Distinct Classic Czech vs Modern Minimal miniature invoice preview cards (Screen 18)
 * - Granular 10-area Read/Write scope matrix (Screen 21)
 */
import type { Scope, ScopeArea } from "@kvitbit/api-contract";
import type { PdfTemplate } from "@kvitbit/domain";
import { I18n, ViewModels } from "@kvitbit/ui-port";
import type { Locale } from "../../app/prefs";
import { type Markup, withAttributes } from "../../ui/html";
import { badge, segmented } from "../../ui/kit";
import { sCopy } from "./copy";

export interface BrandingPreviewProps {
  readonly template: PdfTemplate;
  readonly accentColor: string;
  readonly companyName: string;
  readonly ico: string;
  readonly dic: string;
  readonly registerEntry: string;
  readonly footerText: string;
  readonly hasLogo: boolean;
  readonly hasStamp: boolean;
  readonly previewLocale: Locale;
}

/**
 * Renders a distinct miniature invoice preview for either `classic` (Classic Czech ledger grid)
 * or `modern_minimal` (Modern Minimal airy layout with accent stripe).
 */
export const brandingMiniPreview = <M>(h: Html.H<M>, p: BrandingPreviewProps): Markup<M> => {
  const loc = p.previewLocale;
  const company = p.companyName.trim() || "Novák Design s.r.o.";
  const ico = p.ico.trim() || "27082440";
  const dic = p.dic.trim() || "CZ27082440";
  const reg = p.registerEntry.trim() || "C 123456, Městský soud v Praze";
  const isClassic = p.template === "classic";

  if (isClassic) {
    return h.div
      .class("kb-pdf-mini kb-pdf-mini--classic")
      .attr("data-template", "classic")
      .style({ "--kb-preview-accent": p.accentColor })
      .children([
        h.div
          .class("kb-pdf-mini__head")
          .children([
            h.div
              .class("kb-pdf-mini__brand")
              .children([
                ...(p.hasLogo
                  ? [h.span.class("kb-pdf-mini__logo").children([sCopy(loc, "preview.logo")])]
                  : []),
                h.strong.children([sCopy(loc, "preview.invoiceLabel")]),
              ]),
            h.span.class("kb-mono kb-pdf-mini__num").children(["2026-0042"]),
          ]),
        h.div
          .class("kb-pdf-mini__parties")
          .children([
            h.div
              .class("kb-pdf-mini__party")
              .children([
                h.span.class("kb-pdf-mini__label").children([sCopy(loc, "preview.supplier")]),
                h.strong.children([company]),
                h.span.class("kb-mono").children([`IČO ${ico} · DIČ ${dic}`]),
                h.span.class("kb-pdf-mini__reg").children([reg]),
              ]),
            h.div
              .class("kb-pdf-mini__party")
              .children([
                h.span.class("kb-pdf-mini__label").children([sCopy(loc, "preview.customer")]),
                h.strong.children(["Alza.cz a.s."]),
                h.span.class("kb-mono").children(["IČO 27082440"]),
                h.span.class("kb-pdf-mini__reg").children(["Jankovcova 1522/53, Praha 7"]),
              ]),
          ]),
        h.table
          .class("kb-pdf-mini__table")
          .children([
            h.thead.children([
              h.tr.children([
                h.th.children([sCopy(loc, "preview.item")]),
                h.th.class("kb-end").children([sCopy(loc, "preview.qty")]),
                h.th.class("kb-end").children([sCopy(loc, "preview.vat")]),
                h.th.class("kb-end").children([sCopy(loc, "preview.total")]),
              ]),
            ]),
            h.tbody.children([
              h.tr.children([
                h.td.children([sCopy(loc, "preview.sampleItem1")]),
                h.td.class("kb-end kb-num").children(["1"]),
                h.td.class("kb-end kb-num").children(["21 %"]),
                h.td.class("kb-end kb-num").children(["36 300 Kč"]),
              ]),
              h.tr.children([
                h.td.children([sCopy(loc, "preview.sampleItem2")]),
                h.td.class("kb-end kb-num").children(["4 h"]),
                h.td.class("kb-end kb-num").children(["21 %"]),
                h.td.class("kb-end kb-num").children(["12 100 Kč"]),
              ]),
            ]),
          ]),
        h.div
          .class("kb-pdf-mini__bottom")
          .children([
            h.div
              .class("kb-pdf-mini__qr-box")
              .children([
                h.span.class("kb-pdf-mini__qr").children(["QR"]),
                h.div.children([
                  h.div.class("kb-pdf-mini__label").children([sCopy(loc, "preview.qr")]),
                  h.div.class("kb-mono").children([`${sCopy(loc, "preview.vs")}: 20260042`]),
                ]),
              ]),
            h.div
              .class("kb-pdf-mini__total-box")
              .children([
                h.span.class("kb-pdf-mini__label").children([sCopy(loc, "preview.totalDue")]),
                h.strong.class("kb-num").children(["48 400,00 Kč"]),
                ...(p.hasStamp
                  ? [h.span.class("kb-pdf-mini__stamp").children([sCopy(loc, "preview.stamp")])]
                  : []),
              ]),
          ]),
        ...(p.footerText.trim() !== ""
          ? [h.div.class("kb-pdf-mini__footer").children([p.footerText.trim()])]
          : []),
      ]);
  }

  return h.div
    .class("kb-pdf-mini kb-pdf-mini--modern")
    .attr("data-template", "modern_minimal")
    .style({ "--kb-preview-accent": p.accentColor })
    .children([
      h.div.class("kb-pdf-mini__stripe").children([]),
      h.div
        .class("kb-pdf-mini__modern-head")
        .children([
          h.div
            .class("kb-pdf-mini__brand")
            .children([
              ...(p.hasLogo
                ? [h.span.class("kb-pdf-mini__logo").children([sCopy(loc, "preview.logo")])]
                : []),
              h.span.class("kb-pdf-mini__company").children([company]),
            ]),
          h.div
            .class("kb-pdf-mini__modern-id")
            .children([
              h.span
                .class("kb-pdf-mini__accent-pill")
                .children([sCopy(loc, "preview.modernLabel")]),
              h.span.class("kb-mono").children(["2026-0042"]),
            ]),
        ]),
      h.div
        .class("kb-pdf-mini__modern-parties")
        .children([
          h.div.children([
            h.span.class("kb-pdf-mini__label").children([sCopy(loc, "preview.supplier")]),
            h.div.class("kb-mono").children([`${ico} · ${dic}`]),
          ]),
          h.div.children([
            h.span.class("kb-pdf-mini__label").children([sCopy(loc, "preview.customer")]),
            h.div.children(["Alza.cz a.s."]),
          ]),
        ]),
      h.div
        .class("kb-pdf-mini__modern-lines")
        .children([
          h.div
            .class("kb-pdf-mini__modern-row")
            .children([
              h.span.children([sCopy(loc, "preview.sampleItem1")]),
              h.span.class("kb-num").children(["36 300 Kč"]),
            ]),
          h.div
            .class("kb-pdf-mini__modern-row")
            .children([
              h.span.children([sCopy(loc, "preview.sampleItem2")]),
              h.span.class("kb-num").children(["12 100 Kč"]),
            ]),
        ]),
      h.div
        .class("kb-pdf-mini__modern-summary")
        .children([
          h.div
            .class("kb-pdf-mini__qr-box")
            .children([
              h.span.class("kb-pdf-mini__qr").children(["QR"]),
              h.span.class("kb-mono").children(["20260042"]),
            ]),
          h.div
            .class("kb-pdf-mini__total-pill")
            .children([
              h.span.children([sCopy(loc, "preview.totalDue")]),
              h.strong.class("kb-num").children(["48 400,00 Kč"]),
            ]),
        ]),
      h.div
        .class("kb-pdf-mini__footer")
        .children([p.footerText.trim() !== "" ? p.footerText.trim() : reg]),
    ]);
};

export interface ScopeMatrixProps<M> {
  readonly state: ViewModels.ScopePickerState;
  readonly t: I18n.Translator;
  readonly onPreset: (preset: "read" | "read_write") => M;
  readonly onCustom: M;
  readonly onToggle: (scope: Scope) => M;
}

/** Interactive 10-area Read/Write scope picker (API key creation). */
export const scopeMatrixEditor = <M>(h: Html.H<M>, o: ScopeMatrixProps<M>): Markup<M> => {
  const rows = ViewModels.ScopePicker.rows(o.state);
  const canRead = ViewModels.presetAvailable(o.state, "read");
  const canWrite = ViewModels.presetAvailable(o.state, "read_write");

  return h.div.class("kb-stack").children([
    segmented(h, {
      label: o.t.t("scopePicker.title"),
      selected: o.state.mode,
      items: [
        ...(canRead ? [{ id: "read", label: o.t.t("scopePicker.presetRead") }] : []),
        ...(canWrite ? [{ id: "read_write", label: o.t.t("scopePicker.presetReadWrite") }] : []),
        { id: "custom", label: o.t.t("scopePicker.custom") },
      ],
      onSelect: (id) => (id === "read" || id === "read_write" ? o.onPreset(id) : o.onCustom),
    }),
    h.p.class("kb-small kb-muted").children([o.t.t("scopePicker.writeImpliesRead")]),
    h.div.class("kb-table-wrap").children([
      h.table.class("kb-table kb-scope-matrix").children([
        h.thead.children([
          h.tr.children([
            h.th.attr("scope", "col").children([o.t.t("scopePicker.area")]),
            h.th
              .attr("scope", "col")
              .class("kb-end")
              .children([o.t.t("scopePicker.read")]),
            h.th
              .attr("scope", "col")
              .class("kb-end")
              .children([o.t.t("scopePicker.write")]),
          ]),
        ]),
        h.tbody.children(
          rows.map((row) => {
            const readChecked = row.level === "read" || row.level === "write";
            const writeChecked = row.level === "write";
            const areaLabel = o.t.translate(I18n.enumText("scopeArea", row.area));
            return h.tr
              .key(row.area)
              .children([
                h.td.children([areaLabel]),
                h.td
                  .class("kb-end")
                  .children([
                    withAttributes(h.input.class(), [
                      (element) => element.attr("type", "checkbox"),
                      (element) =>
                        element.attr("aria-label", `${areaLabel} — ${o.t.t("scopePicker.read")}`),
                      (element) => element.checked(readChecked),
                      (node) =>
                        row.readEnabled
                          ? node.on("change", () => o.onToggle(`${row.area}:read`))
                          : node.disabled(true),
                    ]),
                  ]),
                h.td
                  .class("kb-end")
                  .children([
                    withAttributes(h.input.class(), [
                      (element) => element.attr("type", "checkbox"),
                      (element) =>
                        element.attr("aria-label", `${areaLabel} — ${o.t.t("scopePicker.write")}`),
                      (element) => element.checked(writeChecked),
                      (node) =>
                        row.writeEnabled
                          ? node.on("change", () => o.onToggle(`${row.area}:write`))
                          : node.disabled(true),
                    ]),
                  ]),
              ]);
          }),
        ),
      ]),
    ]),
  ]);
};

/** Compact read-only scope badges for an existing API Key or Connected MCP App. */
export const scopeSummaryBadges = <M>(
  h: Html.H<M>,
  t: I18n.Translator,
  areas: ReadonlyArray<{ readonly area: ScopeArea; readonly level: ViewModels.AreaLevel }>,
): Markup<M> => {
  const active = areas.filter((a) => a.level !== "none");
  if (active.length === 0) return badge(h, t.translate(I18n.enumText("scopeLevel", "none")));
  return h.div
    .class("kb-scope-pills")
    .children(
      active.map((a) =>
        badge(
          h,
          `${t.translate(I18n.enumText("scopeArea", a.area))}: ${t.translate(I18n.enumText("scopeLevel", a.level))}`,
          a.level === "write" ? "proforma" : "outline",
        ),
      ),
    );
};
