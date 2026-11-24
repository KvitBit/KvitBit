/**
 * Shared visual components private to Settings:
 * - Distinct Classic Czech vs Modern Minimal miniature invoice preview cards (Screen 18)
 * - Granular 10-area Read/Write scope matrix (Screen 21)
 */
import type { Scope, ScopeArea } from "@kvitbit/api-contract";
import type { PdfTemplate } from "@kvitbit/domain";
import { I18n, ViewModels } from "@kvitbit/ui-port";
import type { Html, HtmlBuilder } from "foldkit/html";
import type { Locale } from "../../app/prefs";
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
export const brandingMiniPreview = <M>(h: HtmlBuilder<M>, p: BrandingPreviewProps): Html => {
  const loc = p.previewLocale;
  const company = p.companyName.trim() || "Novák Design s.r.o.";
  const ico = p.ico.trim() || "27082440";
  const dic = p.dic.trim() || "CZ27082440";
  const reg = p.registerEntry.trim() || "C 123456, Městský soud v Praze";
  const isClassic = p.template === "classic";

  if (isClassic) {
    return h.div(
      [
        h.Class("kb-pdf-mini kb-pdf-mini--classic"),
        h.DataAttribute("template", "classic"),
        h.Style({ "--kb-preview-accent": p.accentColor }),
      ],
      [
        h.div(
          [h.Class("kb-pdf-mini__head")],
          [
            h.div(
              [h.Class("kb-pdf-mini__brand")],
              [
                ...(p.hasLogo
                  ? [h.span([h.Class("kb-pdf-mini__logo")], [sCopy(loc, "preview.logo")])]
                  : []),
                h.strong([], [sCopy(loc, "preview.invoiceLabel")]),
              ],
            ),
            h.span([h.Class("kb-mono kb-pdf-mini__num")], ["2026-0042"]),
          ],
        ),
        h.div(
          [h.Class("kb-pdf-mini__parties")],
          [
            h.div(
              [h.Class("kb-pdf-mini__party")],
              [
                h.span([h.Class("kb-pdf-mini__label")], [sCopy(loc, "preview.supplier")]),
                h.strong([], [company]),
                h.span([h.Class("kb-mono")], [`IČO ${ico} · DIČ ${dic}`]),
                h.span([h.Class("kb-pdf-mini__reg")], [reg]),
              ],
            ),
            h.div(
              [h.Class("kb-pdf-mini__party")],
              [
                h.span([h.Class("kb-pdf-mini__label")], [sCopy(loc, "preview.customer")]),
                h.strong([], ["Alza.cz a.s."]),
                h.span([h.Class("kb-mono")], ["IČO 27082440"]),
                h.span([h.Class("kb-pdf-mini__reg")], ["Jankovcova 1522/53, Praha 7"]),
              ],
            ),
          ],
        ),
        h.table(
          [h.Class("kb-pdf-mini__table")],
          [
            h.thead(
              [],
              [
                h.tr(
                  [],
                  [
                    h.th([], [sCopy(loc, "preview.item")]),
                    h.th([h.Class("kb-end")], [sCopy(loc, "preview.qty")]),
                    h.th([h.Class("kb-end")], [sCopy(loc, "preview.vat")]),
                    h.th([h.Class("kb-end")], [sCopy(loc, "preview.total")]),
                  ],
                ),
              ],
            ),
            h.tbody(
              [],
              [
                h.tr(
                  [],
                  [
                    h.td([], [sCopy(loc, "preview.sampleItem1")]),
                    h.td([h.Class("kb-end kb-num")], ["1"]),
                    h.td([h.Class("kb-end kb-num")], ["21 %"]),
                    h.td([h.Class("kb-end kb-num")], ["36 300 Kč"]),
                  ],
                ),
                h.tr(
                  [],
                  [
                    h.td([], [sCopy(loc, "preview.sampleItem2")]),
                    h.td([h.Class("kb-end kb-num")], ["4 h"]),
                    h.td([h.Class("kb-end kb-num")], ["21 %"]),
                    h.td([h.Class("kb-end kb-num")], ["12 100 Kč"]),
                  ],
                ),
              ],
            ),
          ],
        ),
        h.div(
          [h.Class("kb-pdf-mini__bottom")],
          [
            h.div(
              [h.Class("kb-pdf-mini__qr-box")],
              [
                h.span([h.Class("kb-pdf-mini__qr")], ["QR"]),
                h.div(
                  [],
                  [
                    h.div([h.Class("kb-pdf-mini__label")], [sCopy(loc, "preview.qr")]),
                    h.div([h.Class("kb-mono")], [`${sCopy(loc, "preview.vs")}: 20260042`]),
                  ],
                ),
              ],
            ),
            h.div(
              [h.Class("kb-pdf-mini__total-box")],
              [
                h.span([h.Class("kb-pdf-mini__label")], [sCopy(loc, "preview.totalDue")]),
                h.strong([h.Class("kb-num")], ["48 400,00 Kč"]),
                ...(p.hasStamp
                  ? [h.span([h.Class("kb-pdf-mini__stamp")], [sCopy(loc, "preview.stamp")])]
                  : []),
              ],
            ),
          ],
        ),
        ...(p.footerText.trim() !== ""
          ? [h.div([h.Class("kb-pdf-mini__footer")], [p.footerText.trim()])]
          : []),
      ],
    );
  }

  return h.div(
    [
      h.Class("kb-pdf-mini kb-pdf-mini--modern"),
      h.DataAttribute("template", "modern_minimal"),
      h.Style({ "--kb-preview-accent": p.accentColor }),
    ],
    [
      h.div([h.Class("kb-pdf-mini__stripe")], []),
      h.div(
        [h.Class("kb-pdf-mini__modern-head")],
        [
          h.div(
            [h.Class("kb-pdf-mini__brand")],
            [
              ...(p.hasLogo
                ? [h.span([h.Class("kb-pdf-mini__logo")], [sCopy(loc, "preview.logo")])]
                : []),
              h.span([h.Class("kb-pdf-mini__company")], [company]),
            ],
          ),
          h.div(
            [h.Class("kb-pdf-mini__modern-id")],
            [
              h.span([h.Class("kb-pdf-mini__accent-pill")], [sCopy(loc, "preview.modernLabel")]),
              h.span([h.Class("kb-mono")], ["2026-0042"]),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("kb-pdf-mini__modern-parties")],
        [
          h.div(
            [],
            [
              h.span([h.Class("kb-pdf-mini__label")], [sCopy(loc, "preview.supplier")]),
              h.div([h.Class("kb-mono")], [`${ico} · ${dic}`]),
            ],
          ),
          h.div(
            [],
            [
              h.span([h.Class("kb-pdf-mini__label")], [sCopy(loc, "preview.customer")]),
              h.div([], ["Alza.cz a.s."]),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("kb-pdf-mini__modern-lines")],
        [
          h.div(
            [h.Class("kb-pdf-mini__modern-row")],
            [
              h.span([], [sCopy(loc, "preview.sampleItem1")]),
              h.span([h.Class("kb-num")], ["36 300 Kč"]),
            ],
          ),
          h.div(
            [h.Class("kb-pdf-mini__modern-row")],
            [
              h.span([], [sCopy(loc, "preview.sampleItem2")]),
              h.span([h.Class("kb-num")], ["12 100 Kč"]),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("kb-pdf-mini__modern-summary")],
        [
          h.div(
            [h.Class("kb-pdf-mini__qr-box")],
            [
              h.span([h.Class("kb-pdf-mini__qr")], ["QR"]),
              h.span([h.Class("kb-mono")], ["20260042"]),
            ],
          ),
          h.div(
            [h.Class("kb-pdf-mini__total-pill")],
            [
              h.span([], [sCopy(loc, "preview.totalDue")]),
              h.strong([h.Class("kb-num")], ["48 400,00 Kč"]),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("kb-pdf-mini__footer")],
        [p.footerText.trim() !== "" ? p.footerText.trim() : reg],
      ),
    ],
  );
};

export interface ScopeMatrixProps<M> {
  readonly state: ViewModels.ScopePickerState;
  readonly t: I18n.Translator;
  readonly onPreset: (preset: "read" | "read_write") => M;
  readonly onCustom: M;
  readonly onToggle: (scope: Scope) => M;
}

/** Interactive 10-area Read/Write scope picker (API key creation). */
export const scopeMatrixEditor = <M>(h: HtmlBuilder<M>, o: ScopeMatrixProps<M>): Html => {
  const rows = ViewModels.ScopePicker.rows(o.state);
  const canRead = ViewModels.presetAvailable(o.state, "read");
  const canWrite = ViewModels.presetAvailable(o.state, "read_write");

  return h.div(
    [h.Class("kb-stack")],
    [
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
      h.p([h.Class("kb-small kb-muted")], [o.t.t("scopePicker.writeImpliesRead")]),
      h.div(
        [h.Class("kb-table-wrap")],
        [
          h.table(
            [h.Class("kb-table kb-scope-matrix")],
            [
              h.thead(
                [],
                [
                  h.tr(
                    [],
                    [
                      h.th([h.Scope("col")], [o.t.t("scopePicker.area")]),
                      h.th([h.Scope("col"), h.Class("kb-end")], [o.t.t("scopePicker.read")]),
                      h.th([h.Scope("col"), h.Class("kb-end")], [o.t.t("scopePicker.write")]),
                    ],
                  ),
                ],
              ),
              h.tbody(
                [],
                rows.map((row) => {
                  const readChecked = row.level === "read" || row.level === "write";
                  const writeChecked = row.level === "write";
                  const areaLabel = o.t.translate(I18n.enumText("scopeArea", row.area));
                  return h.keyed("tr")(
                    row.area,
                    [],
                    [
                      h.td([], [areaLabel]),
                      h.td(
                        [h.Class("kb-end")],
                        [
                          h.input([
                            h.Type("checkbox"),
                            h.AriaLabel(`${areaLabel} — ${o.t.t("scopePicker.read")}`),
                            h.Checked(readChecked),
                            ...(row.readEnabled
                              ? [h.OnChange(() => o.onToggle(`${row.area}:read`))]
                              : [h.Disabled(true)]),
                          ]),
                        ],
                      ),
                      h.td(
                        [h.Class("kb-end")],
                        [
                          h.input([
                            h.Type("checkbox"),
                            h.AriaLabel(`${areaLabel} — ${o.t.t("scopePicker.write")}`),
                            h.Checked(writeChecked),
                            ...(row.writeEnabled
                              ? [h.OnChange(() => o.onToggle(`${row.area}:write`))]
                              : [h.Disabled(true)]),
                          ]),
                        ],
                      ),
                    ],
                  );
                }),
              ),
            ],
          ),
        ],
      ),
    ],
  );
};

/** Compact read-only scope badges for an existing API Key or Connected MCP App. */
export const scopeSummaryBadges = <M>(
  h: HtmlBuilder<M>,
  t: I18n.Translator,
  areas: ReadonlyArray<{ readonly area: ScopeArea; readonly level: ViewModels.AreaLevel }>,
): Html => {
  const active = areas.filter((a) => a.level !== "none");
  if (active.length === 0) return badge(h, t.translate(I18n.enumText("scopeLevel", "none")));
  return h.div(
    [h.Class("kb-scope-pills")],
    active.map((a) =>
      badge(
        h,
        `${t.translate(I18n.enumText("scopeArea", a.area))}: ${t.translate(I18n.enumText("scopeLevel", a.level))}`,
        a.level === "write" ? "proforma" : "outline",
      ),
    ),
  );
};
