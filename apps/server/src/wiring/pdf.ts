/**
 * Live PDF renderers (`DocumentRenderer`, `ReportPdfRenderer`, `BrandingPreview`) backed by
 * `@kvitbit/adapters/pdf` (templates D01-D11), `@kvitbit/adapters/qr` (SPAYD/EPC QR), and
 * Chromium at `KVITBIT_CHROMIUM_PATH` (default `/usr/bin/chromium`).
 */
import {
  type DocumentRenderModel,
  makeChromiumPdfEngine,
  PdfEngine,
  type RenderBranding,
  type RenderLine,
  type RenderReference,
  type ReportCell,
  type ReportRenderModel,
  renderDocumentPdf,
  renderReportPdf,
} from "@kvitbit/adapters/pdf";
import { forDocument as qrForDocument } from "@kvitbit/adapters/qr";
import {
  BrandingPreview,
  DocumentRenderer,
  type DocumentsModule,
  ReportPdfRenderer,
  type ReportsModule,
  type WorkspacesModule,
} from "@kvitbit/core";
import type { CurrencyCode, DocumentView, IsoDate, Money } from "@kvitbit/domain/contract";
import { BigDecimal, type Config, Effect, Layer, Result, Stream } from "effect";
import { PdfWiringConfigSchema } from "./config";

const DEFAULT_ACCENT = "#18181B";

const formatAddressLines = (address: {
  readonly street?: string | null;
  readonly city?: string | null;
  readonly postalCode?: string | null;
  readonly country?: string | null;
}): ReadonlyArray<string> => {
  const lines: Array<string> = [];
  if (address.street && address.street.trim() !== "") lines.push(address.street.trim());
  const cityLine = [address.postalCode?.trim(), address.city?.trim()]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  if (cityLine !== "") lines.push(cityLine);
  if (address.country && address.country.trim() !== "") lines.push(address.country.trim());
  return lines;
};

const computePaymentQr = (
  view: DocumentView,
  issuer: DocumentsModule.IssuerSnapshotRecord,
): DocumentRenderModel["paymentQr"] => {
  if (view.paymentQr !== null) return view.paymentQr;
  const amount = view.totals.gross.amount;
  const res = qrForDocument({
    kind: view.kind,
    status: view.status,
    currency: view.totals.gross.currency,
    amount,
    bankAccount: issuer.bankAccount,
    recipientName: issuer.name,
    message: view.number ? `${view.kind} ${view.number}` : view.kind,
    variableSymbol: view.number ? view.number.replace(/\D/g, "").slice(0, 10) : null,
    dueOn: view.dates.dueOn,
  });
  return Result.isSuccess(res) ? res.success : null;
};

const buildReference = (view: DocumentView): RenderReference | null => {
  if (view.kind === "payment_tax_document") {
    const proforma = view.related.find((r) => r.relation === "advance_of");
    return {
      kind: "payment",
      receivedOn: view.dates.taxableSupplyOn ?? view.dates.issuedOn,
      proformaNumber: proforma?.number ?? null,
    };
  }
  if (view.kind === "credit_note") {
    const original = view.related.find((r) => r.relation === "corrects");
    if (original !== undefined) {
      return {
        kind: "correction",
        originalNumber: original.number,
        originalIssuedOn: view.dates.issuedOn,
        reason: "",
      };
    }
  }
  if (view.kind === "invoice") {
    const proformas = view.related
      .filter((r) => r.relation === "advance_of" || r.relation === "final_invoice_for")
      .map((r) => r.number);
    const ptds = view.related.filter((r) => r.relation === "deducts").map((r) => r.number);
    if (proformas.length > 0 || ptds.length > 0) {
      return {
        kind: "settlement",
        proformaNumbers: proformas,
        paymentTaxDocumentNumbers: ptds,
      };
    }
  }
  return null;
};

/** Maps a `DocumentView` to `@kvitbit/adapters/pdf`'s `DocumentRenderModel`. */
export const documentViewToRenderModel = (view: DocumentView): DocumentRenderModel => {
  const issuer = view.issuer as unknown as DocumentsModule.IssuerSnapshotRecord;
  const contact = view.contact as unknown as DocumentsModule.ContactSnapshotRecord;
  const rawLines = view.lines as unknown as ReadonlyArray<DocumentsModule.LineViewData>;

  const lines: ReadonlyArray<RenderLine> = rawLines.map((line) => ({
    description: line.description,
    quantity: line.quantity,
    unit: line.unit,
    unitPrice: line.unitPrice,
    treatment: line.treatment,
    ratePercent: line.ratePercent,
    total: line.amount,
    role: line.deducts !== null ? "deduction" : "item",
  }));

  const branding: RenderBranding = {
    accentColor: DEFAULT_ACCENT,
    footerText: null,
    logo: null,
    stamp: null,
  };

  return {
    kind: view.kind,
    status: view.status,
    number: view.number,
    regime: issuer.regime,
    taxDocument: view.taxDocument,
    currency: view.totals.gross.currency,
    issuer: {
      name: issuer.name,
      addressLines: formatAddressLines(issuer.address),
      companyId: issuer.ico,
      vatId: issuer.dic,
      registerEntry: issuer.registerEntry,
      email: issuer.email,
      phone: issuer.phone,
    },
    customer: {
      name: contact.name,
      addressLines: formatAddressLines(contact.address),
      companyId: contact.ico,
      vatId: contact.dic,
    },
    dates: {
      issuedOn: view.dates.issuedOn,
      taxableSupplyOn: view.dates.taxableSupplyOn,
      dueOn: view.dates.dueOn,
    },
    paymentMethod: view.paymentMethod,
    bankAccount: issuer.bankAccount
      ? {
          accountNumber: issuer.bankAccount.accountNumber,
          iban: issuer.bankAccount.iban,
          bic: issuer.bankAccount.bic,
        }
      : null,
    variableSymbol: view.number ? view.number.replace(/\D/g, "").slice(0, 10) : null,
    orderNumber: null,
    note: null,
    reference: buildReference(view),
    lines,
    totals: view.totals,
    fx: view.fx,
    ...(view.statutoryNotes.length > 0
      ? {
          statutoryNotes: view.statutoryNotes.map((n) => ({
            code: String(n.code),
            text: n.text,
          })),
        }
      : {}),
    paymentQr: computePaymentQr(view, issuer),
    branding,
  };
};

const czk = (n: string): Money => ({
  amount: BigDecimal.fromStringUnsafe(n),
  currency: "CZK" as CurrencyCode,
});

/** Builds a deterministic sample `DocumentRenderModel` for `Workspaces.previewBranding`. */
export const brandingPreviewToRenderModel = (
  input: WorkspacesModule.BrandingPreviewInput,
): DocumentRenderModel => {
  const isCs = input.language === "cs";
  const unitPrice = BigDecimal.fromStringUnsafe("10000");
  const qty = BigDecimal.fromStringUnsafe("1");
  const rate = BigDecimal.fromStringUnsafe("21");
  const vatAmount = BigDecimal.fromStringUnsafe("2100");
  const grossAmount = BigDecimal.fromStringUnsafe("12100");

  return {
    kind: input.kind,
    status: "issued",
    number: "2026-0001",
    regime: "vat_payer",
    taxDocument: input.kind !== "proforma",
    currency: "CZK" as CurrencyCode,
    issuer: {
      name: input.issuingEntity.name,
      addressLines: formatAddressLines(input.issuingEntity.address),
      companyId: input.issuingEntity.ico,
      vatId: input.issuingEntity.dic,
      registerEntry: input.issuingEntity.registerEntry,
      email: input.issuingEntity.email,
      phone: input.issuingEntity.phone,
    },
    customer: {
      name: isCs ? "Ukázkový odběratel s.r.o." : "Sample Customer Ltd.",
      addressLines: isCs
        ? ["Křižíkova 185/35", "186 00 Praha 8", "CZ"]
        : ["123 Sample Street", "110 00 Prague", "CZ"],
      companyId: "12345678",
      vatId: "CZ12345678",
    },
    dates: {
      issuedOn: "2026-01-15" as IsoDate,
      taxableSupplyOn: input.kind === "proforma" ? null : ("2026-01-15" as IsoDate),
      dueOn: "2026-01-29" as IsoDate,
    },
    paymentMethod: "bank_transfer",
    bankAccount: {
      accountNumber: "123456789/0100",
      iban: "CZ6508000000192000145399",
      bic: "GIBACZPX",
    },
    variableSymbol: "20260001",
    orderNumber: null,
    note: input.branding.footerText,
    reference: null,
    lines: [
      {
        description: isCs ? "Konzultační služby (ukázka)" : "Consulting services (sample)",
        quantity: qty,
        unit: isCs ? "ks" : "pcs",
        unitPrice,
        treatment: "standard",
        ratePercent: rate,
        total: grossAmount,
        role: "item",
      },
    ],
    totals: {
      buckets: [
        {
          treatment: "standard",
          ratePercent: rate,
          base: unitPrice,
          vat: vatAmount,
          gross: grossAmount,
          vatCzk: null,
        },
      ],
      net: czk("10000"),
      vat: czk("2100"),
      gross: czk("12100"),
      roundingAdjustment: czk("0"),
      vatCzk: null,
    },
    fx: null,
    paymentQr: null,
    branding: {
      accentColor: input.branding.accentColor,
      footerText: input.branding.footerText,
      logo: null,
      stamp: null,
    },
  };
};

/** Maps `ReportPdfInput` (all 6 report kinds) to `ReportRenderModel` (D11). */
export const reportPdfInputToRenderModel = (
  input: ReportsModule.ReportPdfInput,
  generatedAtIso: string,
): ReportRenderModel => {
  const isCs = input.locale === "cs";
  const view = input.view;
  const periodLabel = `${view.period.from} – ${view.period.to}`;
  const base = {
    workspace: { name: input.workspaceId, companyId: null, vatId: null },
    branding: { accentColor: DEFAULT_ACCENT, footerText: null, logo: null, stamp: null },
    periodLabel,
    generatedAt: generatedAtIso,
    footerNote: null,
  };

  switch (view.report) {
    case "revenue":
      return {
        ...base,
        title: isCs ? "Přehled výnosů" : "Revenue report",
        kpis: [
          { label: isCs ? "Základ" : "Net", value: view.totals.net },
          { label: isCs ? "DPH" : "VAT", value: view.totals.vat },
          { label: isCs ? "Celkem" : "Gross", value: view.totals.gross, emphasis: true },
        ],
        table: {
          columns: [
            { label: isCs ? "Skupina" : "Group", align: "left" },
            { label: isCs ? "Počet" : "Count", align: "right" },
            { label: isCs ? "Základ" : "Net", align: "right" },
            { label: isCs ? "DPH" : "VAT", align: "right" },
            { label: isCs ? "Celkem" : "Gross", align: "right" },
          ],
          rows: view.rows.map((r) => ({
            cells: [
              { text: r.label ?? r.key },
              { count: r.count },
              { money: r.net },
              { money: r.vat },
              { money: r.gross },
            ] satisfies ReadonlyArray<ReportCell>,
          })),
        },
        total: { label: isCs ? "Celkem" : "Total", value: view.totals.gross },
      };

    case "expenses":
      return {
        ...base,
        title: isCs ? "Přehled nákladů" : "Expenses report",
        kpis: [
          { label: isCs ? "Základ" : "Net", value: view.totals.net },
          { label: isCs ? "DPH" : "VAT", value: view.totals.vat },
          { label: isCs ? "Celkem" : "Gross", value: view.totals.gross, emphasis: true },
        ],
        table: {
          columns: [
            { label: isCs ? "Skupina" : "Group", align: "left" },
            { label: isCs ? "Počet" : "Count", align: "right" },
            { label: isCs ? "Základ" : "Net", align: "right" },
            { label: isCs ? "DPH" : "VAT", align: "right" },
            { label: isCs ? "Celkem" : "Gross", align: "right" },
          ],
          rows: view.rows.map((r) => ({
            cells: [
              { text: r.label ?? r.key },
              { count: r.count },
              { money: r.net },
              { money: r.vat },
              { money: r.gross },
            ] satisfies ReadonlyArray<ReportCell>,
          })),
        },
        total: { label: isCs ? "Celkem" : "Total", value: view.totals.gross },
      };

    case "profit":
      return {
        ...base,
        title: isCs ? "Výsledovka" : "Profit report",
        kpis: [
          { label: isCs ? "Výnosy" : "Revenue", value: view.totals.revenue },
          { label: isCs ? "Náklady" : "Expenses", value: view.totals.expenses },
          { label: isCs ? "Zisk" : "Profit", value: view.totals.profit, emphasis: true },
        ],
        table: {
          columns: [
            { label: isCs ? "Měsíc" : "Month", align: "left" },
            { label: isCs ? "Výnosy" : "Revenue", align: "right" },
            { label: isCs ? "Náklady" : "Expenses", align: "right" },
            { label: isCs ? "Zisk" : "Profit", align: "right" },
          ],
          rows: view.rows.map((r) => ({
            cells: [
              { text: r.month },
              { money: r.revenue },
              { money: r.expenses },
              { money: r.profit },
            ] satisfies ReadonlyArray<ReportCell>,
          })),
        },
        total: { label: isCs ? "Zisk celkem" : "Total profit", value: view.totals.profit },
      };

    case "cashflow":
      return {
        ...base,
        title: isCs ? "Cashflow" : "Cashflow report",
        kpis: [
          { label: isCs ? "Příjmy" : "Inflow", value: view.totals.in },
          { label: isCs ? "Výdaje" : "Outflow", value: view.totals.out },
          { label: isCs ? "Čistý tok" : "Net", value: view.totals.net, emphasis: true },
        ],
        table: {
          columns: [
            { label: isCs ? "Období" : "Period", align: "left" },
            { label: isCs ? "Příjmy" : "Inflow", align: "right" },
            { label: isCs ? "Výdaje" : "Outflow", align: "right" },
            { label: isCs ? "Čistý tok" : "Net", align: "right" },
          ],
          rows: view.points.map((p) => ({
            cells: [
              { text: p.month },
              { money: p.in },
              { money: p.out },
              { money: p.net },
            ] satisfies ReadonlyArray<ReportCell>,
          })),
        },
        total: { label: isCs ? "Čistý tok celkem" : "Total net", value: view.totals.net },
      };

    case "receivables":
      return {
        ...base,
        title: isCs ? "Pohledávky" : "Receivables aging",
        kpis: [
          { label: isCs ? "Celkem" : "Total", value: view.total, emphasis: true },
          { label: isCs ? "Po splatnosti" : "Overdue", value: view.overdue.total },
        ],
        table: {
          columns: [
            { label: isCs ? "Pásmo" : "Bucket", align: "left" },
            { label: isCs ? "Počet" : "Count", align: "right" },
            { label: isCs ? "Částka" : "Amount", align: "right" },
          ],
          rows: view.buckets.map((b) => ({
            cells: [
              { text: b.bucket },
              { count: b.count },
              { money: b.total },
            ] satisfies ReadonlyArray<ReportCell>,
          })),
        },
        total: { label: isCs ? "Pohledávky celkem" : "Total receivables", value: view.total },
      };

    case "vat_summary":
      return {
        ...base,
        title: isCs ? "Podklady k DPH" : "VAT summary",
        kpis: [
          { label: isCs ? "DPH na výstupu" : "Output VAT", value: view.totals.output },
          { label: isCs ? "DPH na vstupu" : "Input VAT", value: view.totals.input },
          { label: isCs ? "K úhradě" : "Payable", value: view.totals.payable, emphasis: true },
        ],
        table: {
          columns: [
            { label: isCs ? "Typ" : "Direction", align: "left" },
            { label: isCs ? "Měsíc" : "Month", align: "left" },
            { label: isCs ? "Režim" : "Treatment", align: "left" },
            { label: isCs ? "Základ" : "Base", align: "right" },
            { label: isCs ? "DPH" : "VAT", align: "right" },
          ],
          rows: [
            ...view.output.map((l) => ({
              cells: [
                { text: isCs ? "Výstup" : "Output" },
                { text: l.month },
                { text: l.treatment },
                { money: l.base },
                { money: l.vat },
              ] satisfies ReadonlyArray<ReportCell>,
            })),
            ...view.input.map((l) => ({
              cells: [
                { text: isCs ? "Vstup" : "Input" },
                { text: l.month },
                { text: l.treatment },
                { money: l.base },
                { money: l.vat },
              ] satisfies ReadonlyArray<ReportCell>,
              tone: "deduction" as const,
            })),
          ],
        },
        total: { label: isCs ? "DPH k úhradě" : "VAT payable", value: view.totals.payable },
      };
  }
};

/** Live `PdfEngine` using Chromium at `KVITBIT_CHROMIUM_PATH` (default `/usr/bin/chromium`). */
export const PdfEngineLive: Layer.Layer<PdfEngine, Config.ConfigError> = Layer.effect(
  PdfEngine,
  Effect.flatMap(PdfWiringConfigSchema, ({ chromiumPath }) =>
    makeChromiumPdfEngine({ executablePath: chromiumPath }).pipe(Effect.orDie),
  ),
);

export const DocumentRendererLive: Layer.Layer<DocumentRenderer, never, PdfEngine> = Layer.effect(
  DocumentRenderer,
  Effect.map(PdfEngine, (engine) =>
    DocumentRenderer.of({
      render: (view, options) =>
        renderDocumentPdf(documentViewToRenderModel(view), options.template, options.language).pipe(
          Effect.provideService(PdfEngine, engine),
          Effect.orDie,
        ),
    }),
  ),
);

export const ReportPdfRendererLive: Layer.Layer<ReportPdfRenderer, never, PdfEngine> = Layer.effect(
  ReportPdfRenderer,
  Effect.map(PdfEngine, (engine) =>
    ReportPdfRenderer.of({
      render: (input) =>
        Effect.sync(() => new Date().toISOString()).pipe(
          Effect.flatMap((nowIso) =>
            renderReportPdf(reportPdfInputToRenderModel(input, nowIso), input.locale),
          ),
          Effect.provideService(PdfEngine, engine),
          Effect.orDie,
        ),
    }),
  ),
);

export const BrandingPreviewLive: Layer.Layer<BrandingPreview, never, PdfEngine> = Layer.effect(
  BrandingPreview,
  Effect.map(PdfEngine, (engine) =>
    BrandingPreview.of({
      render: (input) =>
        renderDocumentPdf(
          brandingPreviewToRenderModel(input),
          input.branding.pdfTemplate,
          input.language,
        ).pipe(
          Effect.provideService(PdfEngine, engine),
          Effect.orDie,
          Effect.map((bytes) => ({
            filename: `preview-${input.kind}.pdf`,
            contentType: "application/pdf",
            bytes: Stream.succeed(bytes),
          })),
        ),
    }),
  ),
);

/** Builds all three PDF renderer ports over a supplied `PdfEngine` layer (useful in tests). */
export const makePdfRenderersLayer = <E, R>(
  engineLayer: Layer.Layer<PdfEngine, E, R>,
): Layer.Layer<DocumentRenderer | ReportPdfRenderer | BrandingPreview, E, R> =>
  Layer.mergeAll(DocumentRendererLive, ReportPdfRendererLive, BrandingPreviewLive).pipe(
    Layer.provide(engineLayer),
  );

/** Live PDF renderer ports over Chromium (`KVITBIT_CHROMIUM_PATH`). */
export const PdfRenderersLive: Layer.Layer<
  DocumentRenderer | ReportPdfRenderer | BrandingPreview,
  Config.ConfigError
> = makePdfRenderersLayer(PdfEngineLive);
