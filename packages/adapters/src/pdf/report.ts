/** Report export PDF (D11), in the Modern Minimal chrome of mockup screen 24. */
import type { Locale } from "@kvitbit/domain";
import { escapeHtml as e, formatDateTime, formatMoney } from "./format";
import { LABELS } from "./labels";
import type { ReportCell, ReportRenderModel } from "./model";
import { MODERN_CSS } from "./modern";
import { brandingView } from "./prepare";
import { page } from "./shell";

const REPORT_CSS = `
.rep-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.rk { padding: 9px 11px; border-radius: 6px; background: var(--p-tint); }
.rk-v { font-family: 'Chillax', 'Inter', 'Helvetica Neue', Arial, sans-serif; font-weight: 600; font-size: 14px; color: #09090B; margin-top: 2px; white-space: nowrap; }
.rk-v.accent { color: var(--p-accent); }
.rep-total { max-width: 290px; margin-left: auto; width: 100%; }
`;

const cell = (c: ReportCell, align: "left" | "right", lang: Locale): string => {
  const cls = align === "right" ? ' class="r"' : "";
  if ("text" in c) return `<td${cls}>${e(c.text)}</td>`;
  if ("count" in c) return `<td class="r mono">${e(String(c.count))}</td>`;
  return `<td${cls}>${e(formatMoney(c.money.amount, c.money.currency, lang))}</td>`;
};

export const renderReportHtml = (model: ReportRenderModel, lang: Locale): string => {
  const t = LABELS[lang];
  const brand = brandingView(model.branding, model.workspace.name);
  const ids = [
    model.workspace.companyId ? `${t.companyId} ${model.workspace.companyId}` : null,
    model.workspace.vatId ? `${t.vatId} ${model.workspace.vatId}` : null,
  ]
    .filter((x) => x !== null)
    .join(" · ");
  const columns = model.table.columns;
  const rows = model.table.rows
    .map(
      (row) =>
        `<tr${row.tone === "deduction" ? ' class="deduct"' : ""}>${row.cells
          .map((c, i) => cell(c, columns[i]?.align ?? "left", lang))
          .join("")}</tr>`,
    )
    .join("");
  const footer = [model.footerNote, `${t.generated} ${formatDateTime(model.generatedAt, lang)}`]
    .filter((x) => x !== null)
    .join(" · ");

  const body = `<article class="sheet tnum" data-template="report">
<div class="rail"></div>
<div class="inner">
<header class="mo-top">
  <div>
    <div class="eyebrow">${e(model.periodLabel)}</div>
    <div class="big-num" style="font-size:21px;">${e(model.title)}</div>
  </div>
  <div class="issuer-top">
    <div><div class="name">${e(model.workspace.name)}</div>${ids ? `<div class="mono ids">${e(ids)}</div>` : ""}</div>
    ${brand.logo ?? `<span class="logo-pill">${e(brand.initials)}</span>`}
  </div>
</header>
${
  model.kpis.length === 0
    ? ""
    : `<div class="rep-kpis keep">${model.kpis
        .map(
          (k) =>
            `<div class="rk"><div class="k-lbl">${e(k.label)}</div><div class="rk-v${k.emphasis ? " accent" : ""}">${e(formatMoney(k.value.amount, k.value.currency, lang))}</div></div>`,
        )
        .join("")}</div>`
}
<table class="mo-items">
  <thead><tr>${columns.map((c) => `<th${c.align === "right" ? ' class="r"' : ""}>${e(c.label)}</th>`).join("")}</tr></thead>
  <tbody>${rows}</tbody>
</table>
${
  model.total === null
    ? ""
    : `<div class="sum-grand rep-total keep"><span class="lbl" style="font-size:10px;">${e(model.total.label)}</span><span class="hd val" style="font-size:16px;" data-section="grand-total">${e(formatMoney(model.total.value.amount, model.total.value.currency, lang))}</span></div>`
}
<footer class="doc-footer">
  <span>${e(footer)}</span>
  <span class="mono brand-mark">${brand.brandMark}Kvitbit</span>
</footer>
</div>
</article>`;

  return page({
    lang,
    title: `${model.title} ${model.periodLabel}`,
    css: MODERN_CSS + REPORT_CSS,
    accent: brand.accent,
    tint: brand.tint,
    body,
  });
};
