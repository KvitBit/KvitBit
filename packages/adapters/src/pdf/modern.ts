/** Modern Minimal template (D06-D10), after the approved mockup screen 24. */

import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import { escapeHtml as e } from "./format";
import type { DocumentRenderModel } from "./model";
import type { Prepared } from "./prepare";
import { page, watermark } from "./shell";

/** Shared with the D11 report, which uses the same chrome. */
export const MODERN_CSS = `
.sheet { display: grid; grid-template-columns: 5px 1fr; font-family: 'Synonym', 'Inter', 'Helvetica Neue', Arial, 'DejaVu Sans', sans-serif; font-size: 10.5px; line-height: 1.42; }
/* Fixed, so the accent rail runs the full height of every printed page. */
.rail { position: fixed; top: 0; bottom: 0; left: 0; width: 5px; background: var(--p-accent); }
.inner { grid-column: 2; padding: 26px 28px 20px; display: flex; flex-direction: column; gap: 15px; min-width: 0; }
.hd, .watermark span { font-family: 'Chillax', 'Inter', 'Helvetica Neue', Arial, sans-serif; font-weight: 600; }
.watermark span { letter-spacing: 0.16em; border-radius: 11px; }
.mo-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.eyebrow { font-family: 'JetBrains Mono', 'DejaVu Sans Mono', monospace; font-size: 8.5px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--p-accent); }
.big-num { font-family: 'Chillax', 'Inter', 'Helvetica Neue', Arial, sans-serif; font-weight: 600; font-size: 24px; line-height: 1.08; letter-spacing: -0.02em; color: #09090B; margin-top: 2px; }
.issuer-top { display: flex; align-items: center; gap: 9px; }
.issuer-top .name { font-weight: 600; font-size: 12px; text-align: right; }
.issuer-top .ids { font-size: 8.5px; color: #71717A; text-align: right; }
.logo-pill { width: 32px; height: 32px; border-radius: 7px; background: var(--p-accent); color: #FFFFFF; display: inline-flex; align-items: center; justify-content: center; font-family: 'Chillax', 'Inter', sans-serif; font-weight: 600; font-size: 13px; flex-shrink: 0; }
.hero-strip { display: grid; grid-template-columns: 1.25fr 0.9fr 0.9fr 0.95fr; gap: 10px; padding: 11px 14px; border-radius: 7px; background: var(--p-tint); }
.k-lbl { font-size: 8px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #71717A; margin-bottom: 2px; }
.hero-val { font-size: 10.5px; font-weight: 600; }
.mo-parties { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; }
.p-name { font-weight: 600; font-size: 11.5px; }
.p-addr { color: #52525B; }
.p-small { font-size: 8.5px; color: #71717A; margin-top: 3px; }
.ref-pill { padding: 7px 11px; border-radius: 6px; background: var(--p-tint); font-size: 9.5px; color: #27272A; }
table.mo-items { width: 100%; border-collapse: collapse; font-size: 10.2px; }
table.mo-items th { text-align: left; font-size: 8px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #71717A; padding: 0 4px 7px; border-bottom: 1.5px solid #E4E4E7; }
table.mo-items th.r { text-align: right; }
table.mo-items td { padding: 8px 4px; border-bottom: 1px solid #F0F0F3; vertical-align: top; }
table.mo-items tr:last-child td { border-bottom: 1px solid #E4E4E7; }
table.mo-items tr.deduct td { color: #15803D; }
.mo-bottom { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 0.95fr); gap: 18px; align-items: end; break-inside: avoid; }
.pay-card { display: flex; align-items: center; gap: 11px; padding: 9px 11px; border-radius: 7px; background: #FAFAFA; border: 1px solid #ECECEF; font-size: 9px; color: #52525B; line-height: 1.4; }
.pay-card .qr { width: 70px; height: 70px; flex-shrink: 0; }
table.mo-vat { width: 100%; border-collapse: collapse; font-size: 8.8px; margin-top: 9px; color: #52525B; }
table.mo-vat th { font-size: 7.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #71717A; text-align: right; padding: 0 4px 4px; border-bottom: 1px solid #ECECEF; }
table.mo-vat th:first-child, table.mo-vat td:first-child { text-align: left; }
table.mo-vat td { text-align: right; padding: 3px 4px; white-space: nowrap; border-bottom: 1px solid #F4F4F5; }
.pay-card .title { font-weight: 600; color: #09090B; }
.stat { font-size: 8.8px; color: #52525B; margin-top: 7px; }
.doc-note { font-size: 8.8px; color: #52525B; margin-top: 7px; white-space: pre-line; }
.sum-lines { display: flex; flex-direction: column; gap: 4px; font-size: 9.8px; }
.sum-row { display: flex; justify-content: space-between; gap: 8px; color: #52525B; }
.sum-row.deduct { color: #15803D; }
.sum-grand { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding-top: 7px; margin-top: 4px; border-top: 2px solid var(--p-accent); }
.sum-grand .lbl { font-weight: 600; color: #09090B; }
.sum-grand .val { font-size: 17px; color: var(--p-accent); white-space: nowrap; }
.czk-eq { text-align: right; font-size: 8.5px; color: #71717A; }
.doc-footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding-top: 10px; border-top: 1px solid #ECECEF; font-size: 8.5px; color: #71717A; break-inside: avoid; }
`;

export const renderModern: {
  (p: Prepared): (model: DocumentRenderModel) => string;
  (model: DocumentRenderModel, p: Prepared): string;
} = Fn.dual(2, (model: DocumentRenderModel, p: Prepared): string => {
  const { t } = p;
  const issuer = model.issuer;
  const customer = model.customer;
  const sep = " ";
  const idsCompact = Arr.join(
    Arr.filter(
      [
        issuer.companyId !== null && issuer.companyId !== ""
          ? `${t.companyId}${sep}${issuer.companyId}`
          : null,
        issuer.vatId !== null && issuer.vatId !== "" ? `${t.vatId}${sep}${issuer.vatId}` : null,
      ],
      (x) => x !== null,
    ),
    " · ",
  );
  const customerIds = Arr.join(
    Arr.filter(
      [
        customer.companyId !== null && customer.companyId !== ""
          ? `${t.companyId}${sep}${customer.companyId}`
          : null,
        customer.vatId !== null && customer.vatId !== ""
          ? `${t.vatId}${sep}${customer.vatId}`
          : null,
      ],
      (x) => x !== null,
    ),
    " · ",
  );

  const issuedLabel = p.meta.taxPoint === null ? t.issuedOn : t.issuedTaxPoint;
  const issuedValue =
    p.meta.taxPoint === null || p.meta.taxPoint === p.meta.issuedOn
      ? p.meta.issuedOn
      : `${p.meta.issuedOn} / ${p.meta.taxPoint}`;
  const dueValue = model.kind === "payment_tax_document" ? t.paid : (p.meta.dueOn ?? "–");

  const lineRows = Arr.join(
    Arr.map(
      p.lines,
      (l) =>
        `<tr${l.deduction ? ' class="deduct"' : ""}><td>${e(l.description)}</td><td class="r">${e(l.quantity)}</td><td class="r">${e(l.unitPrice)}</td>${p.showVat ? `<td class="r">${e(l.vat)}</td>` : ""}<td class="r${l.negative ? " neg" : ""}"><strong>${e(l.total)}</strong></td></tr>`,
    ),
    "",
  );

  const sums: Array<string> = [];
  if (p.final) {
    for (const s of p.subtotals) {
      sums.push(
        `<div class="sum-row${s.tone === "deduction" ? " deduct" : ""}"><span>${e(s.label)}</span><span>${e(s.value)}</span></div>`,
      );
    }
  } else if (p.showVat) {
    const net = p.subtotals[0];
    if (net !== undefined) {
      sums.push(
        `<div class="sum-row"><span>${e(t.netSubtotal)}</span><span>${e(net.value)}</span></div>`,
      );
    }
    const vatTotal = p.subtotals[1];
    const vatRows =
      p.vatPerRate.length > 0 || vatTotal === undefined
        ? p.vatPerRate
        : [{ label: t.vatTotal, value: vatTotal.value }];
    for (const v of vatRows) {
      sums.push(`<div class="sum-row"><span>${e(v.label)}</span><span>${e(v.value)}</span></div>`);
    }
    for (const s of p.subtotals.slice(2)) {
      sums.push(`<div class="sum-row"><span>${e(s.label)}</span><span>${e(s.value)}</span></div>`);
    }
  } else {
    for (const s of p.subtotals) {
      sums.push(`<div class="sum-row"><span>${e(s.label)}</span><span>${e(s.value)}</span></div>`);
    }
  }

  // §29(1): base and VAT per rate. The mockup's sum lines cover a single rate; a Final Invoice
  // or several rates get the per-rate recap.
  const recap =
    p.showRecap && (p.final || p.recap.length > 1)
      ? `<table class="mo-vat" data-section="vat-recap"><thead><tr><th>${e(t.vatRate)}</th><th>${e(t.vatBase)}</th><th>${e(t.vat)}</th><th>${e(t.vatGross)}</th></tr></thead><tbody>${Arr.join(
          Arr.map(
            p.recap,
            (r) =>
              `<tr><td>${e(r.label)}</td><td>${e(r.base)}</td><td>${e(r.vat)}</td><td>${e(r.gross)}</td></tr>`,
          ),
          "",
        )}</tbody></table>`
      : "";

  const statText = Arr.join(
    Arr.map(p.notes, (n) => `<span data-note="${e(n.code)}">${e(n.text)}</span>`),
    " ",
  );
  const accountLines = Arr.filter([p.meta.accountNumber, p.meta.ibanBic], (x) => x !== null);
  // The payment method always prints (core-ports 1, PaymentMethod), with or without QR or account.
  const payTitle =
    p.qrSvg === null ? p.meta.paymentMethod : `${p.qrCaption} · ${p.meta.paymentMethod}`;
  const payCard = `<div class="pay-card"${p.qrSvg === null ? "" : ' data-section="qr"'}>${p.qrSvg === null ? "" : `<div class="qr">${p.qrSvg}</div>`}<div><div class="title" data-section="payment-method">${e(payTitle)}</div>${Arr.join(
    Arr.map(
      accountLines,
      (a, i) => `<div class="mono"${i > 0 ? ' style="font-size:8px;"' : ""}>${e(a)}</div>`,
    ),
    "",
  )}</div></div>`;

  const body = `${watermark(p.draft, t.watermark)}
<article class="sheet tnum" data-template="modern_minimal" data-kind="${e(model.kind)}">
<div class="rail"></div>
<div class="inner">
<header class="mo-top">
  <div>
    <div class="eyebrow" data-section="title">${e(p.title)}</div>
    <div class="big-num">${e(p.number)}</div>
  </div>
  <div class="issuer-top">
    <div><div class="name">${e(issuer.name)}</div>${idsCompact !== "" ? `<div class="mono ids">${e(idsCompact)}</div>` : ""}</div>
    ${p.logo ?? `<span class="logo-pill">${e(p.initials)}</span>`}
  </div>
</header>
<section class="hero-strip keep">
  <div><div class="k-lbl">${e(p.grandLabel)}</div><div class="hd" style="font-size:16px;color:var(--p-accent);white-space:nowrap;">${e(p.grand)}</div></div>
  <div><div class="k-lbl">${e(t.due)}</div><div class="mono hero-val">${e(dueValue)}</div></div>
  <div><div class="k-lbl">${e(t.variableSymbol)}</div><div class="mono hero-val">${e(p.meta.variableSymbol ?? "–")}</div></div>
  <div><div class="k-lbl">${e(issuedLabel)}</div><div class="mono" style="font-size:10.5px;">${e(issuedValue)}</div></div>
</section>
${p.referenceText === null ? "" : `<div class="ref-pill" data-section="reference">${e(p.referenceText)}</div>`}
<section class="mo-parties keep">
  <div>
    <div class="k-lbl">${e(t.from)}</div>
    <div class="p-name">${e(issuer.name)}</div>
    <div class="p-addr">${e(Arr.join(issuer.addressLines, ", "))}</div>
    ${p.registerEntry !== null && p.registerEntry !== "" ? `<div class="p-small" data-note="register_entry">${e(p.registerEntry)}</div>` : ""}
  </div>
  <div>
    <div class="k-lbl">${e(t.billedTo)}</div>
    <div class="p-name">${e(customer.name)}</div>
    <div class="p-addr">${e(Arr.join(customer.addressLines, ", "))}</div>
    ${customerIds !== "" ? `<div class="mono p-small">${e(customerIds)}</div>` : ""}
  </div>
</section>
<table class="mo-items">
  <thead><tr><th>${e(t.descriptionShort)}</th><th class="r">${e(t.quantityShort)}</th><th class="r">${e(t.unitPrice)}</th>${p.showVat ? `<th class="r">${e(t.vat)}</th>` : ""}<th class="r">${e(t.total)}</th></tr></thead>
  <tbody>${lineRows}</tbody>
</table>
<section class="mo-bottom">
  <div>
    ${payCard}
    ${recap}
    ${statText === "" ? "" : `<div class="stat" data-section="statutory">${statText}</div>`}
    ${p.fxNote === null ? "" : `<div class="stat" data-section="fx">${e(p.fxNote)}</div>`}
    ${model.note !== null && model.note !== "" ? `<div class="doc-note">${e(model.note)}</div>` : ""}
    ${p.stamp ?? ""}
  </div>
  <div class="sum-lines">
    ${Arr.join(sums, "")}
    <div class="sum-grand"><span class="lbl">${e(p.grandLabelShort)}</span><span class="hd val" data-section="grand-total">${e(p.grand)}</span></div>
    ${p.czkEquivalent === null ? "" : `<div class="mono czk-eq" data-section="czk-equivalent">${e(p.czkEquivalent)}</div>`}
  </div>
</section>
<footer class="doc-footer">
  <span>${e(p.footer)}</span>
  <span class="brand-lockup" data-section="brand">${p.brandMark}</span>
</footer>
</div>
</article>`;

  return page({
    lang: p.lang,
    title: `${p.title} ${p.number}`,
    css: MODERN_CSS,
    accent: p.accent,
    tint: p.tint,
    body,
  });
});
