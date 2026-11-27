/**
 * Turns a `DocumentRenderModel` into display strings and visibility flags shared by both
 * templates. Every string here is plain text: templates escape at interpolation.
 */

import { CurrencyCode, type Locale, type VatTreatment } from "@kvitbit/domain";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Base64 from "effect/encoding/Base64";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { toSvg } from "../qr/svg";
import {
  escapeHtml,
  formatDate,
  formatMoney,
  formatPercent,
  formatQuantity,
  formatRate,
  groupIban,
} from "./format";
import { LABELS, type Labels } from "./labels";
import { HORIZONTAL_LOCKUP_LIGHT_SVG } from "./lockup";
import type { DocumentRenderModel, RenderBranding, RenderImage, RenderLine } from "./model";
import { type PrintedNote, statutoryNotes, statutoryTitle } from "./statutory";

interface LineRow {
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly vat: string;
  readonly total: string;
  readonly deduction: boolean;
  readonly negative: boolean;
}

export interface Prepared {
  readonly lang: Locale;
  readonly t: Labels;
  readonly title: string;
  readonly number: string;
  readonly draft: boolean;
  readonly final: boolean;
  readonly showVat: boolean;
  readonly showRecap: boolean;
  readonly lines: ReadonlyArray<LineRow>;
  readonly recap: ReadonlyArray<{
    readonly label: string;
    readonly base: string;
    readonly vat: string;
    readonly gross: string;
  }>;
  readonly recapTotal: null | {
    readonly base: string;
    readonly vat: string;
    readonly gross: string;
  };
  readonly subtotals: ReadonlyArray<{
    readonly label: string;
    readonly value: string;
    readonly tone?: "deduction";
  }>;
  /** Modern Minimal splits VAT per rate. */
  readonly vatPerRate: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  readonly grandLabel: string;
  readonly grandLabelShort: string;
  readonly grand: string;
  readonly czkEquivalent: string | null;
  readonly notes: ReadonlyArray<PrintedNote>;
  readonly registerEntry: string | null;
  readonly fxNote: string | null;
  readonly referenceText: string | null;
  readonly meta: {
    readonly issuedOn: string;
    readonly taxPoint: string | null;
    readonly dueOn: string | null;
    readonly paymentMethod: string;
    readonly accountNumber: string | null;
    readonly ibanBic: string | null;
    readonly variableSymbol: string | null;
    readonly orderNumber: string | null;
  };
  readonly issuerIds: string;
  readonly customerIds: string;
  /** Trusted markup (generated SVG), never user text. */
  readonly qrSvg: string | null;
  readonly qrCaption: string;
  readonly accent: string;
  readonly tint: string;
  readonly logo: string | null;
  readonly stamp: string | null;
  readonly initials: string;
  readonly footer: string;
  readonly brandMark: string;
}

const DEFAULT_ACCENT = "#18181B";
const ACCENT_COLOR = /^#[0-9a-fA-F]{6}$/;
const WORD_SEPARATOR = /\s+/;
const LEADING_LETTER = /^\p{L}/u;
const CZK = CurrencyCode.make("CZK");

/** Accent as `#RRGGBB`; anything else falls back so branding can never inject CSS. */
const safeAccent = (color: string): string =>
  ACCENT_COLOR.test(color) ? Str.toUpperCase(color) : DEFAULT_ACCENT;

/** The accent mixed 7 % into white, matching the mockups' tint swatches. */
const tintOf = (accent: string): string => {
  const n = Number.parseInt(Str.slice(1)(accent), 16);
  const mix = (c: number) => Str.padStart(2, "0")(Math.round(255 - (255 - c) * 0.07).toString(16));
  return Str.toUpperCase(`#${mix((n >> 16) & 255)}${mix((n >> 8) & 255)}${mix(n & 255)}`);
};

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);

/** A data-URI `<img>`; other media types are dropped. */
const imageTag = (image: RenderImage | null, cls: string, alt: string): string | null => {
  if (image === null || !IMAGE_TYPES.has(image.mediaType)) return null;
  const b64 = Base64.encode(image.bytes);
  return `<img class="${cls}" alt="${escapeHtml(alt)}" src="data:${image.mediaType};base64,${b64}">`;
};

const initialsOf = (name: string): string => {
  const words = Arr.filter(
    Str.split(name, WORD_SEPARATOR),
    (w) => LEADING_LETTER.test(w) && !Str.includes(".")(w),
  ).slice(0, 2);
  const letters = Arr.join(
    Arr.map(words, (w) => Str.toUpperCase(Array.from(w)[0] ?? "")),
    "",
  );
  return letters === "" ? Str.toUpperCase(Array.from(Str.trim(name))[0] ?? "") : letters;
};

export interface BrandingView {
  readonly accent: string;
  readonly tint: string;
  readonly logo: string | null;
  readonly initials: string;
  readonly brandMark: string;
}

export const brandingView: {
  (issuerName: string): (branding: RenderBranding) => BrandingView;
  (branding: RenderBranding, issuerName: string): BrandingView;
} = Fn.dual(2, (branding: RenderBranding, issuerName: string): BrandingView => {
  const accent = safeAccent(branding.accentColor);
  return {
    accent,
    tint: tintOf(accent),
    logo: imageTag(branding.logo, "logo-img", issuerName),
    initials: initialsOf(issuerName),
    // The title id is made unique so the artwork never collides with page ids.
    brandMark: Fn.pipe(
      HORIZONTAL_LOCKUP_LIGHT_SVG,
      Str.replace(/\s*\n\s*/g, ""),
      Str.replaceAll('"title"', '"kvitbit-lockup-title"'),
    ),
  };
});

const isRated = (treatment: VatTreatment): treatment is "standard" | "reduced" =>
  treatment === "standard" || treatment === "reduced";

const treatmentShort = (line: RenderLine, lang: Locale, t: Labels): string =>
  isRated(line.treatment) ? formatPercent(line.ratePercent, lang) : t.treatments[line.treatment];

const sumOf = (xs: ReadonlyArray<BigDecimal.BigDecimal>): BigDecimal.BigDecimal =>
  Arr.reduce(xs, BigDecimal.fromBigInt(0n), BigDecimal.sum);

export const prepare: {
  (lang: Locale): (model: DocumentRenderModel) => Prepared;
  (model: DocumentRenderModel, lang: Locale): Prepared;
} = Fn.dual(2, (model: DocumentRenderModel, lang: Locale): Prepared => {
  const t = LABELS[lang];
  const cur = model.currency;
  const money = (x: BigDecimal.BigDecimal) => formatMoney(x, cur, lang);
  const czk = (x: BigDecimal.BigDecimal) => formatMoney(x, CZK, lang);
  const date = (d: Parameters<typeof formatDate>[0]) => formatDate(d, lang);

  const deductions = Arr.filter(model.lines, (l) => l.role === "deduction");
  const final =
    model.kind === "invoice" && (model.reference?.kind === "settlement" || deductions.length > 0);
  const treatments = new Set(Arr.map(model.lines, (l) => l.treatment));
  const showVat =
    model.regime === "vat_payer" || Arr.some([...treatments], (tr) => tr !== "outside_scope");
  const showRecap = showVat && model.taxDocument && model.totals.buckets.length > 0;

  const lines: Array<LineRow> = Arr.map(model.lines, (l) => ({
    description: l.description,
    quantity: `${formatQuantity(l.quantity, lang)}${l.unit !== null && l.unit !== "" ? ` ${l.unit}` : ""}`,
    unitPrice: money(l.unitPrice),
    vat: treatmentShort(l, lang, t),
    total: money(l.total),
    deduction: l.role === "deduction",
    negative: l.role === "item" && BigDecimal.isNegative(l.total),
  }));

  const bucketLabel = (b: (typeof model.totals.buckets)[number]) =>
    isRated(b.treatment) ? formatPercent(b.ratePercent, lang) : t.treatmentsLong[b.treatment];
  const recap = Arr.map(model.totals.buckets, (b) => ({
    label: bucketLabel(b),
    base: money(b.base),
    vat: money(b.vat),
    gross: money(b.gross),
  }));
  const recapTotal =
    recap.length > 1
      ? {
          base: money(model.totals.net.amount),
          vat: money(model.totals.vat.amount),
          gross: money(sumOf(Arr.map(model.totals.buckets, (b) => b.gross))),
        }
      : null;
  const vatPerRate = Arr.map(
    Arr.filter(model.totals.buckets, (b) => isRated(b.treatment)),
    (b) => ({
      label: `${t.vatAt} ${formatPercent(b.ratePercent, lang)}`,
      value: money(b.vat),
    }),
  );

  const subtotals: Array<{ label: string; value: string; tone?: "deduction" }> = [];
  const deducted = sumOf(Arr.map(deductions, (l) => l.total));
  if (final && deductions.length > 0) {
    subtotals.push({
      label: t.suppliesTotal,
      // Gross already includes payment rounding, which prints as its own row below.
      value: money(
        BigDecimal.subtract(
          BigDecimal.subtract(model.totals.gross.amount, model.totals.roundingAdjustment.amount),
          deducted,
        ),
      ),
    });
    subtotals.push({ label: t.lessDeposit, value: money(deducted), tone: "deduction" });
  } else if (showVat) {
    subtotals.push({ label: t.subtotal, value: money(model.totals.net.amount) });
    subtotals.push({ label: t.vatTotal, value: money(model.totals.vat.amount) });
  }
  if (!BigDecimal.isZero(model.totals.roundingAdjustment.amount)) {
    subtotals.push({ label: t.rounding, value: money(model.totals.roundingAdjustment.amount) });
  }

  const [grandLabel, grandLabelShort] =
    model.kind === "payment_tax_document"
      ? [t.grandPaid, t.grandPaid]
      : model.kind === "credit_note"
        ? [t.grandCredit, t.grandCreditShort]
        : final
          ? [t.grandRemaining, t.grandRemainingShort]
          : [t.grandDue, t.grandDue];

  const foreign = cur !== "CZK" && model.fx !== null;
  let czkEquivalent: string | null = null;
  let fxNote: string | null = null;
  if (foreign && model.fx !== null) {
    const perUnit = BigDecimal.divideUnsafe(
      model.fx.rate,
      BigDecimal.fromBigInt(BigInt(model.fx.quantity)),
    );
    const source = model.fx.source === "cnb" ? t.cnb : t.manualRate;
    czkEquivalent = `≈ ${czk(BigDecimal.multiply(model.totals.gross.amount, perUnit))} (${source})`;
    const pair = `${model.fx.quantity} ${cur} = ${formatRate(model.fx.rate, lang)} ${
      lang === "cs" ? "Kč" : "CZK"
    }`;
    // VAT-specific wording and CZK VAT only on VAT tax documents; others get the plain rate.
    const vatDisclosure = showVat && model.taxDocument;
    const perBucket = Arr.map(
      Arr.filter(model.totals.buckets, (b) => b.vatCzk !== null),
      (b) => `${bucketLabel(b)}: ${czk(b.vatCzk ?? BigDecimal.fromBigInt(0n))}`,
    );
    const totalVatCzk = model.totals.vatCzk === null ? null : czk(model.totals.vatCzk.amount);
    const parts = [...perBucket];
    if (totalVatCzk !== null && perBucket.length !== 1) {
      parts.push(perBucket.length === 0 ? totalVatCzk : `${t.vatSum} ${totalVatCzk}`);
    }
    const vatLine =
      !vatDisclosure || parts.length === 0 ? "" : ` ${t.vatInCzk}: ${Arr.join(parts, "; ")}.`;
    const fixingDate =
      model.fx.source === "cnb" && model.fx.fixingDate !== null ? date(model.fx.fixingDate) : null;
    fxNote =
      (vatDisclosure ? t.fxDisclosure(fixingDate, pair) : t.fxRate(fixingDate, pair)) + vatLine;
  }

  const allNotes =
    model.statutoryNotes ??
    statutoryNotes({
      kind: model.kind,
      regime: model.regime,
      treatments,
      issuerRegisterEntry: model.issuer.registerEntry,
      language: lang,
    });
  const registerEntry =
    Option.getOrUndefined(Arr.findFirst(allNotes, (n) => n.code === "register_entry"))?.text ??
    model.issuer.registerEntry ??
    null;
  const notes = Arr.filter(allNotes, (n) => n.code !== "register_entry");

  const ref = model.reference;
  const referenceText =
    ref === null
      ? null
      : ref.kind === "payment"
        ? t.refPayment(date(ref.receivedOn), ref.proformaNumber)
        : ref.kind === "correction"
          ? t.refCorrection(ref.originalNumber, date(ref.originalIssuedOn), ref.reason)
          : t.refSettlement(
              Arr.join(ref.proformaNumbers, ", "),
              Arr.join(ref.paymentTaxDocumentNumbers, ", "),
            );

  const bank = model.bankAccount;
  const ibanBic =
    bank === null || bank.iban === null
      ? null
      : bank.bic !== null && bank.bic !== ""
        ? `${groupIban(bank.iban)} / ${bank.bic}`
        : groupIban(bank.iban);

  const ids = (p: { companyId: string | null; vatId: string | null }, sep: string) =>
    Arr.join(
      Arr.filter(
        [
          p.companyId !== null && p.companyId !== "" ? `${t.companyId}${sep}${p.companyId}` : null,
          p.vatId !== null && p.vatId !== "" ? `${t.vatId}${sep}${p.vatId}` : null,
        ],
        (x) => x !== null,
      ),
      " · ",
    );

  const qr = model.paymentQr;
  const brand = brandingView(model.branding, model.issuer.name);

  return {
    lang,
    t,
    title: statutoryTitle({
      kind: model.kind,
      taxDocument: model.taxDocument,
      final,
      language: lang,
    }),
    number: model.number ?? t.draftNumber,
    draft: model.status === "draft",
    final,
    showVat,
    showRecap,
    lines,
    recap,
    recapTotal,
    subtotals,
    vatPerRate,
    grandLabel,
    grandLabelShort,
    grand: money(model.totals.gross.amount),
    czkEquivalent,
    notes,
    registerEntry,
    fxNote,
    referenceText,
    meta: {
      issuedOn: date(model.dates.issuedOn),
      taxPoint:
        model.taxDocument && model.dates.taxableSupplyOn !== null
          ? date(model.dates.taxableSupplyOn)
          : null,
      dueOn:
        model.kind === "payment_tax_document" || model.dates.dueOn === null
          ? null
          : date(model.dates.dueOn),
      paymentMethod: t.paymentMethods[model.paymentMethod],
      accountNumber: bank?.accountNumber ?? null,
      ibanBic,
      variableSymbol: model.variableSymbol,
      orderNumber: model.orderNumber,
    },
    issuerIds: ids(model.issuer, ": "),
    customerIds: ids(model.customer, ": "),
    qrSvg: qr === null ? null : toSvg(qr.payload, { margin: 4, color: "#09090B" }),
    qrCaption: qr?.format === "epc" ? t.qrEpc : t.qrSpayd,
    accent: brand.accent,
    tint: brand.tint,
    logo: brand.logo,
    stamp: imageTag(model.branding.stamp, "stamp-img", model.issuer.name),
    initials: brand.initials,
    footer: model.branding.footerText ?? t.thanks,
    brandMark: brand.brandMark,
  };
});
