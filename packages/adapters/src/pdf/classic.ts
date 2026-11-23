/** Classic Czech template (D01-D05), after the approved mockup screen 23. */
import { escapeHtml as e } from "./format";
import type { DocumentRenderModel } from "./model";
import type { Prepared } from "./prepare";
import { page, watermark } from "./shell";

const CSS = `
.sheet { padding: 26px 28px 20px; font-family: 'Recia', Georgia, 'Times New Roman', 'DejaVu Serif', serif; font-size: 10.5px; line-height: 1.38; }
.hd, .watermark span { font-family: 'Erode', Georgia, 'Times New Roman', serif; font-weight: 600; }
.watermark span { letter-spacing: 0.18em; }
.doc-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; padding-bottom: 11px; margin-bottom: 12px; border-bottom: 2px solid var(--p-accent); }
.brand-mark-row { display: inline-flex; align-items: center; gap: 9px; }
.logo-box { width: 30px; height: 30px; border-radius: 3px; background: var(--p-accent); color: #FFFFFF; display: inline-flex; align-items: center; justify-content: center; font-family: 'Erode', Georgia, serif; font-weight: 600; font-size: 14px; flex-shrink: 0; }
.doc-title { font-size: 9.5px; font-weight: 600; letter-spacing: 0.05em; color: #52525B; text-transform: uppercase; }
.doc-num { font-size: 15px; font-weight: 600; color: var(--p-accent); }
.parties { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid #D4D4D8; margin-bottom: 11px; }
.party { padding: 9px 11px; }
.party + .party { border-left: 1px solid #D4D4D8; }
.sec-k { font-size: 8.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #52525B; margin-bottom: 3px; }
.party-name { font-family: 'Erode', Georgia, serif; font-weight: 600; font-size: 12.5px; margin-bottom: 2px; }
.party-ids { font-size: 9.2px; margin-top: 4px; }
.party-reg { font-size: 8.5px; color: #52525B; margin-top: 5px; padding-top: 4px; border-top: 1px dotted #E4E4E7; }
.pay-strip { display: grid; grid-template-columns: 1fr auto; gap: 14px; align-items: center; background: #FAFAFA; border: 1px solid #D4D4D8; padding: 9px 11px; margin-bottom: 12px; }
.meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px; font-size: 9.8px; }
.meta-kv { display: flex; justify-content: space-between; gap: 8px; border-bottom: 1px dotted #E4E4E7; padding-bottom: 2px; }
.meta-kv > span:first-child { color: #52525B; white-space: nowrap; }
.meta-kv > :last-child { text-align: right; }
.meta-kv .accent { color: var(--p-accent); }
.qr-frame { display: flex; flex-direction: column; align-items: center; gap: 2px; border: 1px solid #D4D4D8; background: #FFFFFF; padding: 4px 5px 3px; }
.qr-frame .qr { width: 76px; height: 76px; }
.qr-cap { font-size: 7.5px; font-weight: 600; color: #18181B; }
.ref-banner { padding: 6px 9px; margin-bottom: 10px; background: var(--p-tint); border-left: 3px solid var(--p-accent); font-size: 9.5px; color: #27272A; }
table.items { width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: 10px; }
table.items th { background: var(--p-tint); color: #18181B; font-weight: 600; text-align: left; padding: 5px 7px; border-top: 1.5px solid var(--p-accent); border-bottom: 1px solid #D4D4D8; font-size: 9px; text-transform: uppercase; letter-spacing: 0.03em; }
table.items th.r { text-align: right; }
table.items td { padding: 6px 7px; border-bottom: 1px solid #E4E4E7; vertical-align: top; }
table.items tr.deduct td { color: #15803D; background: #F0FDF4; }
.bottom-grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr); gap: 14px; align-items: start; margin-bottom: 14px; break-inside: avoid; }
table.vat-tbl { width: 100%; border-collapse: collapse; font-size: 9px; margin-bottom: 8px; }
table.vat-tbl th { text-align: right; color: #52525B; font-weight: 600; padding: 3px 5px; border-bottom: 1px solid #D4D4D8; }
table.vat-tbl th:first-child, table.vat-tbl td:first-child { text-align: left; }
table.vat-tbl td { text-align: right; padding: 3.5px 5px; border-bottom: 1px solid #F0F0F3; white-space: nowrap; }
table.vat-tbl tr.sum td { font-weight: 600; border-top: 1px solid #D4D4D8; border-bottom: 0; }
.stat-note { font-size: 9.2px; color: #27272A; background: #FAFAFA; border: 1px solid #E4E4E7; padding: 5px 8px; margin-bottom: 8px; }
.doc-note { font-size: 9.2px; color: #27272A; margin-bottom: 8px; white-space: pre-line; }
.total-box { border: 1.5px solid var(--p-accent); background: var(--p-tint); padding: 10px 12px; text-align: right; }
.total-sub { display: flex; justify-content: space-between; font-size: 9.5px; color: #52525B; margin-bottom: 3px; }
.total-sub.deduct { color: #15803D; }
.total-grand { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding-top: 6px; margin-top: 5px; border-top: 1px solid #D4D4D8; }
.grand-lbl { font-size: 10px; font-weight: 600; color: #27272A; }
.grand-val { font-size: 17px; color: var(--p-accent); white-space: nowrap; }
.czk-eq { font-size: 8.5px; color: #52525B; margin-top: 4px; }
.doc-footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding-top: 8px; border-top: 1px solid #E4E4E7; font-size: 8.5px; color: #71717A; break-inside: avoid; }
`;

const kv = (
  label: string,
  value: string | null,
  opts: { mono?: boolean; strong?: boolean; accent?: boolean } = {},
) =>
  value === null
    ? ""
    : `<div class="meta-kv"><span>${e(label)}</span><${opts.strong === false ? "span" : "strong"} class="${opts.mono === false ? "" : "mono"}${opts.accent ? " accent" : ""}">${e(value)}</${opts.strong === false ? "span" : "strong"}></div>`;

export const renderClassic = (model: DocumentRenderModel, p: Prepared): string => {
  const { t } = p;
  const lineRows = p.lines
    .map(
      (l) =>
        `<tr${l.deduction ? ' class="deduct"' : ""}><td>${e(l.description)}</td><td class="r">${e(l.quantity)}</td><td class="r">${e(l.unitPrice)}</td>${p.showVat ? `<td class="r">${e(l.vat)}</td>` : ""}<td class="r${l.negative ? " neg" : ""}"><strong>${e(l.total)}</strong></td></tr>`,
    )
    .join("");

  const recap = p.showRecap
    ? `<table class="vat-tbl" data-section="vat-recap"><thead><tr><th>${e(t.vatRate)}</th><th>${e(t.vatBase)}</th><th>${e(t.vat)}</th><th>${e(t.vatGross)}</th></tr></thead><tbody>${p.recap
        .map(
          (r) =>
            `<tr><td>${e(r.label)}</td><td>${e(r.base)}</td><td>${e(r.vat)}</td><td>${e(r.gross)}</td></tr>`,
        )
        .join("")}${
        p.recapTotal === null
          ? ""
          : `<tr class="sum"><td>${e(t.vatSum)}</td><td>${e(p.recapTotal.base)}</td><td>${e(p.recapTotal.vat)}</td><td>${e(p.recapTotal.gross)}</td></tr>`
      }</tbody></table>`
    : "";

  const notes =
    p.notes.length === 0
      ? ""
      : `<div class="stat-note" data-section="statutory">${p.notes.map((n) => `<span data-note="${e(n.code)}">${e(n.text)}</span>`).join(" ")}</div>`;
  const fx =
    p.fxNote === null ? "" : `<div class="stat-note" data-section="fx">${e(p.fxNote)}</div>`;
  const note = model.note ? `<div class="doc-note">${e(model.note)}</div>` : "";

  const issuer = model.issuer;
  const customer = model.customer;
  const contact = [issuer.email, issuer.phone].filter((x) => x).join(" · ");

  const body = `${watermark(p.draft, t.watermark)}
<article class="sheet tnum" data-template="classic" data-kind="${e(model.kind)}">
<header class="doc-head">
  <div class="brand-mark-row">
    ${p.logo ?? `<span class="logo-box">${e(p.initials)}</span>`}
    <div>
      <div class="hd" style="font-size:14px;line-height:1.1;">${e(issuer.name)}</div>
      ${contact ? `<div style="font-size:9px;color:#52525B;">${e(contact)}</div>` : ""}
    </div>
  </div>
  <div style="text-align:right;">
    <div class="doc-title" data-section="title">${e(p.title)}</div>
    <div class="mono doc-num">${e(model.number === null ? p.number : `${t.number} ${p.number}`)}</div>
  </div>
</header>
<section class="parties">
  <div class="party">
    <div class="sec-k">${e(t.supplier)}</div>
    <div class="party-name">${e(issuer.name)}</div>
    ${issuer.addressLines.map((a) => `<div>${e(a)}</div>`).join("")}
    ${p.issuerIds ? `<div class="mono party-ids">${e(p.issuerIds)}</div>` : ""}
    ${p.registerEntry ? `<div class="party-reg" data-note="register_entry">${e(p.registerEntry)}</div>` : ""}
  </div>
  <div class="party">
    <div class="sec-k">${e(t.customer)}</div>
    <div class="party-name">${e(customer.name)}</div>
    ${customer.addressLines.map((a) => `<div>${e(a)}</div>`).join("")}
    ${p.customerIds ? `<div class="mono party-ids">${e(p.customerIds)}</div>` : ""}
  </div>
</section>
${p.referenceText === null ? "" : `<div class="ref-banner" data-section="reference">${e(p.referenceText)}</div>`}
<section class="pay-strip keep">
  <div class="meta-grid">
    ${kv(t.issuedOn, p.meta.issuedOn)}
    ${kv(t.paymentMethod, p.meta.paymentMethod, { mono: false })}
    ${kv(t.taxPoint, p.meta.taxPoint)}
    ${kv(t.bankAccount, p.meta.accountNumber)}
    ${kv(t.dueOn, p.meta.dueOn, { accent: true })}
    ${kv(t.ibanBic, p.meta.ibanBic, { strong: false })}
    ${kv(t.variableSymbol, p.meta.variableSymbol)}
    ${kv(t.orderNumber, p.meta.orderNumber, { strong: false })}
  </div>
  ${
    p.qrSvg === null
      ? ""
      : `<div class="qr-frame" data-section="qr"><div class="qr">${p.qrSvg}</div><span class="mono qr-cap">${e(p.qrCaption)}</span></div>`
  }
</section>
<table class="items">
  <thead><tr><th>${e(t.description)}</th><th class="r">${e(t.quantity)}</th><th class="r">${e(t.unitPrice)}</th>${p.showVat ? `<th class="r">${e(t.vat)}</th>` : ""}<th class="r">${e(t.total)}</th></tr></thead>
  <tbody>${lineRows}</tbody>
</table>
<section class="bottom-grid">
  <div>
    ${recap}
    ${notes}
    ${fx}
    ${note}
    ${p.stamp ?? ""}
  </div>
  <div class="total-box">
    ${p.subtotals.map((s) => `<div class="total-sub${s.tone === "deduction" ? " deduct" : ""}"><span>${e(s.label)}</span><span>${e(s.value)}</span></div>`).join("")}
    <div class="total-grand"><span class="grand-lbl">${e(p.grandLabel)}</span><span class="hd grand-val" data-section="grand-total">${e(p.grand)}</span></div>
    ${p.czkEquivalent === null ? "" : `<div class="mono czk-eq" data-section="czk-equivalent">${e(p.czkEquivalent)}</div>`}
  </div>
</section>
<footer class="doc-footer">
  <span>${e(p.footer)}</span>
  <span class="mono brand-mark">${p.brandMark}Kvitbit</span>
</footer>
</article>`;

  return page({
    lang: p.lang,
    title: `${p.title} ${p.number}`,
    css: CSS,
    accent: p.accent,
    tint: p.tint,
    body,
  });
};
