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
import { cn, ui } from "../../ui/styles";
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
      .attr("data-slot", "pdf-mini-classic")
      .class(
        "flex flex-col gap-3 rounded-panel border border-outline-variant bg-surface-container-lowest p-4 text-[0.75rem] leading-[1.35] text-on-surface",
      )
      .attr("data-template", "classic")
      .style({ "--kb-preview-accent": p.accentColor })
      .children([
        h.div
          .class(
            "flex items-center justify-between border-b-2 border-[var(--kb-preview-accent,var(--md-sys-color-primary))] pb-2",
          )
          .children([
            h.div
              .class("flex items-center gap-2")
              .children([
                ...(p.hasLogo
                  ? [
                      h.span
                        .class(
                          "inline-flex items-center justify-center border border-[var(--kb-preview-accent,var(--md-sys-color-primary))] px-1.5 py-0.5 text-[0.625rem] font-bold tracking-[0.06em] text-[var(--kb-preview-accent,var(--md-sys-color-primary))]",
                        )
                        .children([sCopy(loc, "preview.logo")]),
                    ]
                  : []),
                h.strong.children([sCopy(loc, "preview.invoiceLabel")]),
              ]),
            h.span.class(cn(ui.mono, "font-semibold")).children(["2026-0042"]),
          ]),
        h.div
          .class("grid grid-cols-2 gap-2")
          .children([
            h.div
              .class("flex flex-col gap-0.5 border border-outline-variant p-2")
              .children([
                h.span
                  .class("text-[0.625rem] uppercase tracking-[0.05em] text-on-surface-variant")
                  .children([sCopy(loc, "preview.supplier")]),
                h.strong.children([company]),
                h.span.class(ui.mono).children([`IČO ${ico} · DIČ ${dic}`]),
                h.span.class("text-[0.6875rem] text-on-surface-variant").children([reg]),
              ]),
            h.div
              .class("flex flex-col gap-0.5 border border-outline-variant p-2")
              .children([
                h.span
                  .class("text-[0.625rem] uppercase tracking-[0.05em] text-on-surface-variant")
                  .children([sCopy(loc, "preview.customer")]),
                h.strong.children(["Alza.cz a.s."]),
                h.span.class(ui.mono).children(["IČO 27082440"]),
                h.span
                  .class("text-[0.6875rem] text-on-surface-variant")
                  .children(["Jankovcova 1522/53, Praha 7"]),
              ]),
          ]),
        h.table
          .class(
            "w-full border-collapse text-[0.75rem] [&_td]:border [&_td]:border-outline-variant [&_td]:px-1.5 [&_td]:py-[5px] [&_th]:border [&_th]:border-outline-variant [&_th]:bg-surface-container-low [&_th]:px-1.5 [&_th]:py-[5px] [&_th]:font-semibold",
          )
          .children([
            h.thead.children([
              h.tr.children([
                h.th.class("text-left").children([sCopy(loc, "preview.item")]),
                h.th.class("text-right").children([sCopy(loc, "preview.qty")]),
                h.th.class("text-right").children([sCopy(loc, "preview.vat")]),
                h.th.class("text-right").children([sCopy(loc, "preview.total")]),
              ]),
            ]),
            h.tbody.children([
              h.tr.children([
                h.td.class("text-left").children([sCopy(loc, "preview.sampleItem1")]),
                h.td.class(cn("text-right", ui.num)).children(["1"]),
                h.td.class(cn("text-right", ui.num)).children(["21 %"]),
                h.td.class(cn("text-right", ui.num)).children(["36 300 Kč"]),
              ]),
              h.tr.children([
                h.td.class("text-left").children([sCopy(loc, "preview.sampleItem2")]),
                h.td.class(cn("text-right", ui.num)).children(["4 h"]),
                h.td.class(cn("text-right", ui.num)).children(["21 %"]),
                h.td.class(cn("text-right", ui.num)).children(["12 100 Kč"]),
              ]),
            ]),
          ]),
        h.div
          .class("flex items-end justify-between gap-3 border-t border-outline-variant pt-2")
          .children([
            h.div
              .class("flex items-center gap-2")
              .children([
                h.span
                  .class(
                    "inline-flex h-9 w-9 items-center justify-center border border-outline font-mono text-[0.625rem] font-bold",
                  )
                  .children(["QR"]),
                h.div.children([
                  h.div
                    .class("text-[0.625rem] uppercase tracking-[0.05em] text-on-surface-variant")
                    .children([sCopy(loc, "preview.qr")]),
                  h.div.class(ui.mono).children([`${sCopy(loc, "preview.vs")}: 20260042`]),
                ]),
              ]),
            h.div
              .class("flex flex-col items-end gap-[3px]")
              .children([
                h.span
                  .class("text-[0.625rem] uppercase tracking-[0.05em] text-on-surface-variant")
                  .children([sCopy(loc, "preview.totalDue")]),
                h.strong.class(ui.num).children(["48 400,00 Kč"]),
                ...(p.hasStamp
                  ? [
                      h.span
                        .class(
                          "mt-1 border border-dashed border-[var(--kb-preview-accent,var(--md-sys-color-primary))] px-2 py-0.5 text-[0.625rem] uppercase text-[var(--kb-preview-accent,var(--md-sys-color-primary))]",
                        )
                        .children([sCopy(loc, "preview.stamp")]),
                    ]
                  : []),
              ]),
          ]),
        ...(p.footerText.trim() !== ""
          ? [
              h.div
                .class(
                  "border-t border-outline-variant pt-1.5 text-[0.6875rem] text-on-surface-variant",
                )
                .children([p.footerText.trim()]),
            ]
          : []),
      ]);
  }

  return h.div
    .attr("data-slot", "pdf-mini-modern")
    .class(
      "flex flex-col gap-3 overflow-hidden rounded-panel border border-outline-variant bg-surface-container-lowest px-4 pb-4 pt-0 text-[0.75rem] leading-[1.35] text-on-surface",
    )
    .attr("data-template", "modern_minimal")
    .style({ "--kb-preview-accent": p.accentColor })
    .children([
      h.div
        .class("-mx-4 mb-1 h-[5px] bg-[var(--kb-preview-accent,var(--md-sys-color-primary))]")
        .children([]),
      h.div
        .class("flex items-baseline justify-between gap-2")
        .children([
          h.div
            .class("flex items-center gap-2")
            .children([
              ...(p.hasLogo
                ? [
                    h.span
                      .class(
                        "inline-flex items-center justify-center border border-[var(--kb-preview-accent,var(--md-sys-color-primary))] px-1.5 py-0.5 text-[0.625rem] font-bold tracking-[0.06em] text-[var(--kb-preview-accent,var(--md-sys-color-primary))]",
                      )
                      .children([sCopy(loc, "preview.logo")]),
                  ]
                : []),
              h.span.class("text-[0.875rem] font-semibold").children([company]),
            ]),
          h.div
            .class("flex items-center gap-1.5")
            .children([
              h.span
                .class(
                  "rounded-badge bg-surface-container-high px-1.5 py-0.5 text-[0.625rem] font-semibold tracking-[0.05em] text-[var(--kb-preview-accent,var(--md-sys-color-primary))]",
                )
                .children([sCopy(loc, "preview.modernLabel")]),
              h.span.class(ui.mono).children(["2026-0042"]),
            ]),
        ]),
      h.div
        .class("grid grid-cols-2 gap-3 border-b border-outline-variant py-2")
        .children([
          h.div.children([
            h.span
              .class("text-[0.625rem] uppercase tracking-[0.05em] text-on-surface-variant")
              .children([sCopy(loc, "preview.supplier")]),
            h.div.class(ui.mono).children([`${ico} · ${dic}`]),
          ]),
          h.div.children([
            h.span
              .class("text-[0.625rem] uppercase tracking-[0.05em] text-on-surface-variant")
              .children([sCopy(loc, "preview.customer")]),
            h.div.children(["Alza.cz a.s."]),
          ]),
        ]),
      h.div
        .class("flex flex-col gap-1.5")
        .children([
          h.div
            .class("flex justify-between gap-2 border-b border-outline-variant pb-1.5")
            .children([
              h.span.children([sCopy(loc, "preview.sampleItem1")]),
              h.span.class(ui.num).children(["36 300 Kč"]),
            ]),
          h.div
            .class("flex justify-between gap-2 border-b border-outline-variant pb-1.5")
            .children([
              h.span.children([sCopy(loc, "preview.sampleItem2")]),
              h.span.class(ui.num).children(["12 100 Kč"]),
            ]),
        ]),
      h.div
        .class("flex items-center justify-between gap-3")
        .children([
          h.div
            .class("flex items-center gap-2")
            .children([
              h.span
                .class(
                  "inline-flex h-9 w-9 items-center justify-center border border-outline font-mono text-[0.625rem] font-bold",
                )
                .children(["QR"]),
              h.span.class(ui.mono).children(["20260042"]),
            ]),
          h.div
            .class(
              "flex flex-col items-end border-l-[3px] border-[var(--kb-preview-accent,var(--md-sys-color-primary))] bg-surface-container-low px-2.5 py-1.5",
            )
            .children([
              h.span.children([sCopy(loc, "preview.totalDue")]),
              h.strong.class(ui.num).children(["48 400,00 Kč"]),
            ]),
        ]),
      h.div
        .class("border-t border-outline-variant pt-1.5 text-[0.6875rem] text-on-surface-variant")
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

  return h.div.class(ui.stack).children([
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
    h.p.class(cn(ui.small, ui.muted)).children([o.t.t("scopePicker.writeImpliesRead")]),
    h.div
      .class(
        "overflow-x-auto rounded-panel border border-outline-variant bg-surface-container-lowest",
      )
      .children([
        h.table
          .attr("data-slot", "scope-matrix")
          .class(
            "w-full border-collapse [&_input[type=checkbox]]:h-4 [&_input[type=checkbox]]:w-4 [&_input[type=checkbox]]:accent-primary [&_td]:border-b [&_td]:border-outline-variant [&_td]:px-3 [&_td]:py-2.5 [&_td]:align-middle [&_th]:border-b [&_th]:border-outline-variant [&_th]:bg-surface-container-low [&_th]:px-3 [&_th]:py-2.5 [&_th]:text-[0.75rem] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.04em] [&_th]:text-on-surface-variant [&_tr:last-child_td]:border-b-0",
          )
          .children([
            h.thead.children([
              h.tr.children([
                h.th
                  .attr("scope", "col")
                  .class("text-left")
                  .children([o.t.t("scopePicker.area")]),
                h.th
                  .attr("scope", "col")
                  .class("text-right")
                  .children([o.t.t("scopePicker.read")]),
                h.th
                  .attr("scope", "col")
                  .class("text-right")
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
                      .class("text-right")
                      .children([
                        withAttributes(h.input.class(), [
                          (element) => element.attr("type", "checkbox"),
                          (element) =>
                            element.attr(
                              "aria-label",
                              `${areaLabel} — ${o.t.t("scopePicker.read")}`,
                            ),
                          (element) => element.checked(readChecked),
                          (node) =>
                            row.readEnabled
                              ? node.on("change", () => o.onToggle(`${row.area}:read`))
                              : node.disabled(true),
                        ]),
                      ]),
                    h.td
                      .class("text-right")
                      .children([
                        withAttributes(h.input.class(), [
                          (element) => element.attr("type", "checkbox"),
                          (element) =>
                            element.attr(
                              "aria-label",
                              `${areaLabel} — ${o.t.t("scopePicker.write")}`,
                            ),
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
    .class("flex flex-wrap gap-1")
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
