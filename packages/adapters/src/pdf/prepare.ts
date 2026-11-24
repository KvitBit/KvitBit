/**
 * Turns a `DocumentRenderModel` into display strings and visibility flags shared by both
 * templates. Every string here is plain text: templates escape at interpolation.
 */

import type { Locale, VatTreatment } from "@kvitbit/domain";
import { BigDecimal } from "effect";
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

export interface LineRow {
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly vat: string;
  readonly total: string;
  readonly deduction: boolean;
  readonly negative: boolean;
}

export interface KeyValue {
  readonly label: string;
  readonly value: string;
  readonly mono: boolean;
  readonly accent?: boolean;
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

/** Accent as `#RRGGBB`; anything else falls back so branding can never inject CSS. */
export const safeAccent = (color: string): string =>
  /^#[0-9a-fA-F]{6}$/.test(color) ? color.toUpperCase() : DEFAULT_ACCENT;

/** The accent mixed 7 % into white, matching the mockups' tint swatches. */
export const tintOf = (accent: string): string => {
  const n = Number.parseInt(accent.slice(1), 16);
  const mix = (c: number) =>
    Math.round(255 - (255 - c) * 0.07)
      .toString(16)
      .padStart(2, "0");
  return `#${mix((n >> 16) & 255)}${mix((n >> 8) & 255)}${mix(n & 255)}`.toUpperCase();
};

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);

/** A data-URI `<img>`; other media types are dropped. */
export const imageTag = (image: RenderImage | null, cls: string, alt: string): string | null => {
  if (image === null || !IMAGE_TYPES.has(image.mediaType)) return null;
  const b64 = Buffer.from(image.bytes).toString("base64");
  return `<img class="${cls}" alt="${escapeHtml(alt)}" src="data:${image.mediaType};base64,${b64}">`;
};

export const initialsOf = (name: string): string => {
  const words = name
    .split(/\s+/)
    .filter((w) => /^\p{L}/u.test(w) && !w.includes("."))
    .slice(0, 2);
  const letters = words.map((w) => [...w][0]?.toUpperCase() ?? "").join("");
  return letters === "" ? ([...name.trim()][0]?.toUpperCase() ?? "") : letters;
};

export interface BrandingView {
  readonly accent: string;
  readonly tint: string;
  readonly logo: string | null;
  readonly initials: string;
  readonly brandMark: string;
}

export const brandingView = (branding: RenderBranding, issuerName: string): BrandingView => {
  const accent = safeAccent(branding.accentColor);
  return {
    accent,
    tint: tintOf(accent),
    logo: imageTag(branding.logo, "logo-img", issuerName),
    initials: initialsOf(issuerName),
    // The title id is made unique so the artwork never collides with page ids.
    brandMark: HORIZONTAL_LOCKUP_LIGHT_SVG.replace(/\s*\n\s*/g, "").replace(
      /"title"/g,
      '"kvitbit-lockup-title"',
    ),
  };
};

const RATED = new Set<VatTreatment>(["standard", "reduced"]);

const treatmentShort = (line: RenderLine, lang: Locale, t: Labels): string =>
  RATED.has(line.treatment)
    ? formatPercent(line.ratePercent, lang)
    : t.treatments[line.treatment as Exclude<VatTreatment, "standard" | "reduced">];

const sumOf = (xs: ReadonlyArray<BigDecimal.BigDecimal>): BigDecimal.BigDecimal =>
  xs.reduce((a, b) => BigDecimal.sum(a, b), BigDecimal.fromBigInt(0n));

export const prepare = (model: DocumentRenderModel, lang: Locale): Prepared => {
  const t = LABELS[lang];
  const cur = model.currency;
  const money = (x: BigDecimal.BigDecimal) => formatMoney(x, cur, lang);
  const czk = (x: BigDecimal.BigDecimal) => formatMoney(x, "CZK" as typeof cur, lang);
  const date = (d: Parameters<typeof formatDate>[0]) => formatDate(d, lang);

  const deductions = model.lines.filter((l) => l.role === "deduction");
  const final =
    model.kind === "invoice" && (model.reference?.kind === "settlement" || deductions.length > 0);
  const treatments = new Set(model.lines.map((l) => l.treatment));
  const showVat =
    model.regime === "vat_payer" || [...treatments].some((tr) => tr !== "outside_scope");
  const showRecap = showVat && model.taxDocument && model.totals.buckets.length > 0;

  const lines: Array<LineRow> = model.lines.map((l) => ({
    description: l.description,
    quantity: `${formatQuantity(l.quantity, lang)}${l.unit ? ` ${l.unit}` : ""}`,
    unitPrice: money(l.unitPrice),
    vat: treatmentShort(l, lang, t),
    total: money(l.total),
    deduction: l.role === "deduction",
    negative: l.role === "item" && BigDecimal.isNegative(l.total),
  }));

  const bucketLabel = (b: (typeof model.totals.buckets)[number]) =>
    RATED.has(b.treatment)
      ? formatPercent(b.ratePercent, lang)
      : t.treatmentsLong[b.treatment as Exclude<VatTreatment, "standard" | "reduced">];
  const recap = model.totals.buckets.map((b) => ({
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
          gross: money(sumOf(model.totals.buckets.map((b) => b.gross))),
        }
      : null;
  const vatPerRate = model.totals.buckets
    .filter((b) => RATED.has(b.treatment))
    .map((b) => ({
      label: `${t.vatAt} ${formatPercent(b.ratePercent, lang)}`,
      value: money(b.vat),
    }));

  const subtotals: Array<{ label: string; value: string; tone?: "deduction" }> = [];
  const deducted = sumOf(deductions.map((l) => l.total));
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
    const perBucket = model.totals.buckets
      .filter((b) => b.vatCzk !== null)
      .map((b) => `${bucketLabel(b)}: ${czk(b.vatCzk ?? BigDecimal.fromBigInt(0n))}`);
    const totalVatCzk = model.totals.vatCzk === null ? null : czk(model.totals.vatCzk.amount);
    const parts = [...perBucket];
    if (totalVatCzk !== null && perBucket.length !== 1) {
      parts.push(perBucket.length === 0 ? totalVatCzk : `${t.vatSum} ${totalVatCzk}`);
    }
    const vatLine =
      !vatDisclosure || parts.length === 0 ? "" : ` ${t.vatInCzk}: ${parts.join("; ")}.`;
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
    allNotes.find((n) => n.code === "register_entry")?.text ?? model.issuer.registerEntry ?? null;
  const notes = allNotes.filter((n) => n.code !== "register_entry");

  const ref = model.reference;
  const referenceText =
    ref === null
      ? null
      : ref.kind === "payment"
        ? t.refPayment(date(ref.receivedOn), ref.proformaNumber)
        : ref.kind === "correction"
          ? t.refCorrection(ref.originalNumber, date(ref.originalIssuedOn), ref.reason)
          : t.refSettlement(
              ref.proformaNumbers.join(", "),
              ref.paymentTaxDocumentNumbers.join(", "),
            );

  const bank = model.bankAccount;
  const ibanBic =
    bank?.iban == null
      ? null
      : bank.bic
        ? `${groupIban(bank.iban)} / ${bank.bic}`
        : groupIban(bank.iban);

  const ids = (p: { companyId: string | null; vatId: string | null }, sep: string) =>
    [
      p.companyId ? `${t.companyId}${sep}${p.companyId}` : null,
      p.vatId ? `${t.vatId}${sep}${p.vatId}` : null,
    ]
      .filter((x) => x !== null)
      .join(" · ");

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
};
