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
  type RenderImage,
  type RenderLine,
  type RenderReference,
  type ReportCell,
  type ReportRenderModel,
  renderDocumentPdf,
  renderReportPdf,
} from "@kvitbit/adapters/pdf";
import {
  BrandingPreview,
  CoreStore,
  DocumentRenderer,
  DocumentsModule,
  DocumentsRepo,
  ReportPdfRenderer,
  type ReportsModule,
  ShareLinksRepo,
  type WorkspacesModule,
  WorkspacesRepo,
} from "@kvitbit/core";
import {
  CurrencyCode,
  CurrentCaller,
  type DocumentView,
  type ImageRef,
  IsoDate,
  type Money,
  type WorkspaceId,
} from "@kvitbit/domain/contract";
import { BlobKey, BlobStorage } from "@kvitbit/domain/ports";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import type * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import * as SqlClient from "effect/sql/SqlClient";
import {
  computeDocumentPaymentQr,
  documentPdfCacheKey,
  ExplicitPdfTemplate,
  readDeliverySnapshot,
  readLegacyDeliveryInfo,
  resolveDocumentFieldsAtRevision,
  resolveVariableSymbol,
  sha256HexSync,
} from "../projections/documents";
import { PdfWiringConfigSchema } from "./config";

const DEFAULT_ACCENT = "#18181B";
const MAX_PDF_CACHE_BYTES = 25 * 1024 * 1024;
const isAllowedImageType = Schema.is(
  Schema.Literals(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]),
);

const concatBytes = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

interface LoadedBrandingImage {
  readonly image: RenderImage | null;
  /** False when a referenced image failed to load (e.g. transient storage error); blocks caching. */
  readonly complete: boolean;
}

const loadBrandingImage = Effect.fn("loadBrandingImage")(
  (
    blobs: BlobStorage["Service"],
    workspaceId: WorkspaceId,
    image: "logo" | "stamp",
    ref: ImageRef | null,
  ): Effect.Effect<LoadedBrandingImage> => {
    const mediaType = ref?.contentType;
    if (ref === null || !isAllowedImageType(mediaType)) {
      return Effect.succeed({ image: null, complete: true });
    }
    const key = BlobKey.make(`branding/${workspaceId}/${image}/${ref.sha256}`);
    return blobs.get(key).pipe(
      Effect.flatMap((stream) => Stream.runCollect(stream)),
      Effect.map(
        (chunks): LoadedBrandingImage => ({
          image: {
            mediaType,
            bytes: concatBytes(chunks),
          },
          complete: true,
        }),
      ),
      Effect.orElseSucceed(() => ({ image: null, complete: false })),
    );
  },
);

interface DocumentRenderContext {
  readonly branding?: RenderBranding | undefined;
  readonly variableSymbol?: string | null | undefined;
  readonly orderNumber?: string | null | undefined;
  readonly note?: string | null | undefined;
  readonly amountDue?: BigDecimal.BigDecimal | undefined;
  readonly paymentQr?: DocumentRenderModel["paymentQr"] | undefined;
  readonly correction?:
    | {
        readonly originalNumber: string;
        readonly originalIssuedOn: IsoDate;
        readonly reason: string;
      }
    | undefined;
}

interface ReportRenderContext {
  readonly workspace?: ReportRenderModel["workspace"] | undefined;
  readonly branding?: RenderBranding | undefined;
}

const formatAddressLines = (address: {
  readonly street?: string | null;
  readonly city?: string | null;
  readonly postalCode?: string | null;
  readonly country?: string | null;
}): ReadonlyArray<string> => {
  const cityLine = Fn.pipe(
    [address.postalCode ?? "", address.city ?? ""],
    Arr.map(Str.trim),
    Arr.filter(Str.isNonEmpty),
    Arr.join(" "),
  );
  return Arr.filter(
    [Str.trim(address.street ?? ""), cityLine, Str.trim(address.country ?? "")],
    Str.isNonEmpty,
  );
};

const buildReference = (
  view: DocumentView,
  context?: DocumentRenderContext,
): RenderReference | null => {
  if (view.kind === "payment_tax_document") {
    const proforma = Option.getOrUndefined(
      Arr.findFirst(view.related, (r) => r.relation === "advance_of"),
    );
    return {
      kind: "payment",
      receivedOn: view.dates.taxableSupplyOn ?? view.dates.issuedOn,
      proformaNumber: proforma?.number ?? null,
    };
  }
  if (view.kind === "credit_note" && context?.correction !== undefined) {
    return { kind: "correction", ...context.correction };
  }
  if (view.kind === "invoice") {
    const proformas = Arr.map(
      Arr.filter(
        view.related,
        (r) => r.relation === "advance_of" || r.relation === "final_invoice_for",
      ),
      (r) => r.number,
    );
    const ptds = Arr.map(
      Arr.filter(view.related, (r) => r.relation === "deducts"),
      (r) => r.number,
    );
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
export const documentViewToRenderModel: {
  (context?: DocumentRenderContext): (view: DocumentView) => DocumentRenderModel;
  (view: DocumentView, context?: DocumentRenderContext): DocumentRenderModel;
} = Fn.dual(
  (args) => Predicate.hasProperty(args[0], "issuer"),
  (view: DocumentView, context?: DocumentRenderContext): DocumentRenderModel => {
    const { issuer, contact, lines: rawLines } = view;
    const { fields } = DocumentsModule.DocumentViewData;
    Schema.asserts(fields.issuer, issuer);
    Schema.asserts(fields.contact, contact);
    Schema.asserts(fields.lines, rawLines);

    const lines: ReadonlyArray<RenderLine> = Arr.map(rawLines, (line) => ({
      description: line.description,
      quantity: line.quantity,
      unit: line.unit,
      unitPrice: line.unitPrice,
      treatment: line.treatment,
      ratePercent: line.ratePercent,
      total: line.amount,
      role: line.deducts !== null ? "deduction" : "item",
    }));

    const branding: RenderBranding = context?.branding ?? {
      accentColor: DEFAULT_ACCENT,
      footerText: null,
      logo: null,
      stamp: null,
    };

    const variableSymbol = resolveVariableSymbol(context?.variableSymbol, view.number);
    const qrAmount =
      context?.amountDue !== undefined
        ? context.amountDue
        : view.settlement === "paid" ||
            view.settlement === "overpaid" ||
            view.settlement === "credited"
          ? BigDecimal.fromStringUnsafe("0")
          : view.totals.gross.amount;
    const paymentQr =
      context?.paymentQr !== undefined
        ? context.paymentQr
        : (view.paymentQr ??
          computeDocumentPaymentQr({
            kind: view.kind,
            status: view.status,
            number: view.number,
            currency: view.totals.gross.currency,
            amount: qrAmount,
            issuer,
            variableSymbol,
            dueOn: view.dates.dueOn,
          }));

    const model: DocumentRenderModel = {
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
      bankAccount:
        issuer.bankAccount !== null
          ? {
              accountNumber: issuer.bankAccount.accountNumber,
              iban: issuer.bankAccount.iban,
              bic: issuer.bankAccount.bic,
            }
          : null,
      variableSymbol,
      orderNumber: context?.orderNumber ?? null,
      note: context?.note ?? null,
      reference: buildReference(view, context),
      lines,
      totals: view.totals,
      fx: view.fx,
      paymentQr,
      branding,
    };
    return view.statutoryNotes.length === 0
      ? model
      : {
          ...model,
          statutoryNotes: Arr.map(view.statutoryNotes, (note) => ({
            code: String(note.code),
            text: note.text,
          })),
        };
  },
);

const czk = (n: string): Money => ({
  amount: BigDecimal.fromStringUnsafe(n),
  currency: CurrencyCode.make("CZK"),
});

/** Builds a deterministic sample `DocumentRenderModel` for `Workspaces.previewBranding`. */
const brandingPreviewToRenderModel = (
  input: WorkspacesModule.BrandingPreviewInput,
  images?: {
    readonly logo?: RenderImage | null | undefined;
    readonly stamp?: RenderImage | null | undefined;
  },
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
    currency: CurrencyCode.make("CZK"),
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
      issuedOn: IsoDate.make("2026-01-15"),
      taxableSupplyOn: input.kind === "proforma" ? null : IsoDate.make("2026-01-15"),
      dueOn: IsoDate.make("2026-01-29"),
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
      logo: images?.logo ?? null,
      stamp: images?.stamp ?? null,
    },
  };
};

/** Maps `ReportPdfInput` (all 6 report kinds) to `ReportRenderModel` (D11). */
const reportPdfInputToRenderModel = (
  input: ReportsModule.ReportPdfInput,
  generatedAtIso: string,
  context?: ReportRenderContext,
): ReportRenderModel => {
  const isCs = input.locale === "cs";
  const view = input.view;
  const periodLabel = `${view.period.from} – ${view.period.to}`;
  const base = {
    workspace: context?.workspace ?? { name: input.workspaceId, companyId: null, vatId: null },
    branding: context?.branding ?? {
      accentColor: DEFAULT_ACCENT,
      footerText: null,
      logo: null,
      stamp: null,
    },
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
          rows: Arr.map(view.rows, (r) => ({
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
          rows: Arr.map(view.rows, (r) => ({
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
          rows: Arr.map(view.rows, (r) => ({
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
          rows: Arr.map(view.points, (p) => ({
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
          rows: Arr.map(view.buckets, (b) => ({
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
            ...Arr.map(view.output, (l) => ({
              cells: [
                { text: isCs ? "Výstup" : "Output" },
                { text: l.month },
                { text: l.treatment },
                { money: l.base },
                { money: l.vat },
              ] satisfies ReadonlyArray<ReportCell>,
            })),
            ...Arr.map(view.input, (l) => ({
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
const PdfEngineLive: Layer.Layer<PdfEngine, Config.ConfigError> = Layer.effect(
  PdfEngine,
  Effect.flatMap(PdfWiringConfigSchema, ({ chromiumPath }) =>
    makeChromiumPdfEngine({ executablePath: chromiumPath }).pipe(Effect.orDie),
  ),
);

const DocumentRendererLive: Layer.Layer<DocumentRenderer, never, PdfEngine> = Layer.effect(
  DocumentRenderer,
  Effect.gen(function* () {
    const engine = yield* PdfEngine;
    const blobsOpt = yield* Effect.serviceOption(BlobStorage);
    const documentsRepoOpt = yield* Effect.serviceOption(DocumentsRepo);
    const workspacesRepoOpt = yield* Effect.serviceOption(WorkspacesRepo);
    const coreStoreOpt = yield* Effect.serviceOption(CoreStore);
    const shareLinksRepoOpt = yield* Effect.serviceOption(ShareLinksRepo);
    const sqlOpt = yield* Effect.serviceOption(SqlClient.SqlClient);

    const resolveWorkspaceId = Effect.fn("DocumentRenderer.resolveWorkspaceId")(function* (
      documentId: DocumentView["id"],
    ) {
      const callerOpt = yield* Effect.serviceOption(CurrentCaller);
      if (Option.isSome(callerOpt)) {
        const caller = callerOpt.value;
        if (caller._tag === "Member") return caller.workspaceId;
        if (
          caller._tag === "ShareLinkVisitor" &&
          Option.isSome(shareLinksRepoOpt) &&
          Option.isSome(coreStoreOpt)
        ) {
          const tokenHash = sha256HexSync(caller.token);
          const linkOpt = yield* coreStoreOpt.value
            .transaction(shareLinksRepoOpt.value.lockByTokenHash(tokenHash))
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isSome(linkOpt)) return linkOpt.value.workspaceId;
        }
      }
      if (Option.isSome(sqlOpt)) {
        const rows = yield* sqlOpt.value<{ readonly workspace_id: WorkspaceId }>`
            SELECT workspace_id FROM documents WHERE id = ${documentId} LIMIT 1
          `.pipe(
          Effect.orElseSucceed((): ReadonlyArray<{ readonly workspace_id: WorkspaceId }> => []),
        );
        if (rows[0] !== undefined) return rows[0].workspace_id;
      }
    });

    return DocumentRenderer.of({
      render: Effect.fn("DocumentRenderer.render")(function* (view, options) {
        // Legacy delivery rows without a frozen __snapshot cannot recover enqueue-time branding,
        // template, or balance; refuse before consulting cache (J3).
        const legacyDelivery = readLegacyDeliveryInfo(view);
        if (legacyDelivery !== undefined) {
          return yield* Effect.die(
            new Error("delivery.snapshot_missing: legacy queued delivery missing frozen snapshot"),
          );
        }

        const workspaceId = yield* resolveWorkspaceId(view.id);
        const deliverySnapshot = readDeliverySnapshot(view);
        const explicitOpt = yield* Effect.serviceOption(ExplicitPdfTemplate);
        const isExplicitTemplate = Option.getOrElse(explicitOpt, () => false);
        const workspace =
          workspaceId !== undefined && Option.isSome(workspacesRepoOpt)
            ? yield* workspacesRepoOpt.value
                .getWorkspace(workspaceId)
                .pipe(Effect.orElseSucceed(() => undefined))
            : undefined;

        const effectiveTemplate =
          deliverySnapshot !== undefined
            ? deliverySnapshot.template
            : isExplicitTemplate || options.template !== "classic" || workspace === undefined
              ? options.template
              : workspace.branding.pdfTemplate;

        const effectiveWorkspaceRevision =
          deliverySnapshot?.branding?.workspaceRevision ?? workspace?.revision;

        const loadRecord =
          workspaceId !== undefined && Option.isSome(documentsRepoOpt)
            ? documentsRepoOpt.value.get(workspaceId, view.id).pipe(
                Effect.catchTag("NotFound", () => Effect.undefined),
                Effect.orDie,
              )
            : Effect.undefined;
        const creditRecord = view.kind === "credit_note" ? yield* loadRecord : undefined;
        let correction: DocumentRenderContext["correction"];
        if (view.kind === "credit_note") {
          const originalLink = Arr.findFirst(
            creditRecord?.links ?? [],
            (link) => link.relation === "corrects",
          );
          const originalId = Option.getOrUndefined(originalLink)?.id;
          if (
            creditRecord === undefined ||
            workspaceId === undefined ||
            originalId === undefined ||
            Option.isNone(documentsRepoOpt)
          ) {
            return yield* Effect.die(new Error("Credit Note correction reference is unavailable"));
          }
          // An unavailable original cannot be replaced by the Credit Note's own date.
          const original = yield* documentsRepoOpt.value
            .get(workspaceId, originalId)
            .pipe(Effect.orDie);
          const originalNumber = creditRecord.correctedNumber ?? original.number;
          if (originalNumber === null) {
            return yield* Effect.die(new Error("Credit Note original document has no number"));
          }
          correction = {
            originalNumber,
            originalIssuedOn: original.issuedOn,
            reason: creditRecord.reason ?? "",
          };
        }

        const cacheKey =
          workspaceId !== undefined &&
          effectiveWorkspaceRevision !== undefined &&
          Option.isSome(blobsOpt)
            ? documentPdfCacheKey({
                workspaceId,
                documentId: view.id,
                documentRevision: view.revision,
                workspaceRevision: effectiveWorkspaceRevision,
                template: effectiveTemplate,
                language: options.language,
                correctionReference: correction?.originalIssuedOn,
              })
            : undefined;

        if (cacheKey !== undefined && Option.isSome(blobsOpt)) {
          const cached = yield* blobsOpt.value.get(cacheKey).pipe(
            Effect.flatMap((stream) => Stream.runCollect(stream)),
            Effect.map((chunks) => Option.some(concatBytes(chunks))),
            Effect.orElseSucceed(() => Option.none()),
          );
          if (Option.isSome(cached)) return cached.value;
        }

        const record = creditRecord ?? (yield* loadRecord);

        const resolvedFields =
          deliverySnapshot !== undefined
            ? {
                variableSymbol: deliverySnapshot.variableSymbol,
                orderNumber: deliverySnapshot.orderNumber,
                note: deliverySnapshot.note,
                amountDue: deliverySnapshot.amountDue,
              }
            : workspaceId !== undefined && record !== undefined && Option.isSome(documentsRepoOpt)
              ? yield* resolveDocumentFieldsAtRevision({
                  workspaceId,
                  view,
                  record,
                  documentsRepo: documentsRepoOpt.value,
                  coreStore: Option.getOrUndefined(coreStoreOpt),
                }).pipe(Effect.orDie)
              : undefined;

        let branding: RenderBranding | undefined;
        let brandingComplete = true;
        const brandingSource = deliverySnapshot?.branding ?? workspace?.branding;
        if (workspaceId !== undefined && brandingSource !== undefined) {
          const [logoResult, stampResult] = Option.isSome(blobsOpt)
            ? yield* Effect.all(
                [
                  loadBrandingImage(blobsOpt.value, workspaceId, "logo", brandingSource.logo),
                  loadBrandingImage(blobsOpt.value, workspaceId, "stamp", brandingSource.stamp),
                ],
                { concurrency: 1 },
              )
            : ([
                { image: null, complete: brandingSource.logo === null },
                { image: null, complete: brandingSource.stamp === null },
              ] as const);
          brandingComplete = logoResult.complete && stampResult.complete;
          branding = {
            accentColor: brandingSource.accentColor,
            footerText: brandingSource.footerText,
            logo: logoResult.image,
            stamp: stampResult.image,
          };
        }

        const model = documentViewToRenderModel(view, {
          branding,
          variableSymbol: resolvedFields?.variableSymbol,
          orderNumber: resolvedFields?.orderNumber,
          note: resolvedFields?.note,
          amountDue: resolvedFields?.amountDue,
          correction,
        });
        const bytes = yield* renderDocumentPdf(model, effectiveTemplate, options.language).pipe(
          Effect.provideService(PdfEngine, engine),
          Effect.orDie,
        );

        if (brandingComplete && cacheKey !== undefined && Option.isSome(blobsOpt)) {
          yield* blobsOpt.value
            .put(cacheKey, Stream.succeed(bytes), {
              contentType: "application/pdf",
              maxBytes: MAX_PDF_CACHE_BYTES,
            })
            .pipe(Effect.ignore);
        }

        return bytes;
      }),
    });
  }),
);

const ReportPdfRendererLive: Layer.Layer<ReportPdfRenderer, never, PdfEngine> = Layer.effect(
  ReportPdfRenderer,
  Effect.gen(function* () {
    const engine = yield* PdfEngine;
    const workspacesRepoOpt = yield* Effect.serviceOption(WorkspacesRepo);
    const blobsOpt = yield* Effect.serviceOption(BlobStorage);

    return ReportPdfRenderer.of({
      render: Effect.fn("ReportPdfRenderer.render")(function* (input) {
        const now = yield* DateTime.now;
        const nowIso = DateTime.formatIso(now);
        const workspace = Option.isSome(workspacesRepoOpt)
          ? yield* workspacesRepoOpt.value
              .getWorkspace(input.workspaceId)
              .pipe(Effect.orElseSucceed(() => undefined))
          : undefined;
        let context: ReportRenderContext | undefined;
        if (workspace !== undefined) {
          const [logoResult, stampResult] = Option.isSome(blobsOpt)
            ? yield* Effect.all(
                [
                  loadBrandingImage(
                    blobsOpt.value,
                    input.workspaceId,
                    "logo",
                    workspace.branding.logo,
                  ),
                  loadBrandingImage(
                    blobsOpt.value,
                    input.workspaceId,
                    "stamp",
                    workspace.branding.stamp,
                  ),
                ],
                { concurrency: 1 },
              )
            : ([
                { image: null, complete: true },
                { image: null, complete: true },
              ] as const);
          context = {
            workspace: {
              name: workspace.issuingEntity.name,
              companyId: workspace.issuingEntity.ico,
              vatId: workspace.issuingEntity.dic,
            },
            branding: {
              accentColor: workspace.branding.accentColor,
              footerText: workspace.branding.footerText,
              logo: logoResult.image,
              stamp: stampResult.image,
            },
          };
        }
        return yield* renderReportPdf(
          reportPdfInputToRenderModel(input, nowIso, context),
          input.locale,
        ).pipe(Effect.provideService(PdfEngine, engine), Effect.orDie);
      }),
    });
  }),
);

const BrandingPreviewLive: Layer.Layer<BrandingPreview, never, PdfEngine> = Layer.effect(
  BrandingPreview,
  Effect.gen(function* () {
    const engine = yield* PdfEngine;
    const blobsOpt = yield* Effect.serviceOption(BlobStorage);

    return BrandingPreview.of({
      render: Effect.fn("BrandingPreview.render")(function* (input) {
        const [logoResult, stampResult] = Option.isSome(blobsOpt)
          ? yield* Effect.all(
              [
                loadBrandingImage(blobsOpt.value, input.workspaceId, "logo", input.branding.logo),
                loadBrandingImage(blobsOpt.value, input.workspaceId, "stamp", input.branding.stamp),
              ],
              { concurrency: 1 },
            )
          : ([
              { image: null, complete: true },
              { image: null, complete: true },
            ] as const);
        const bytes = yield* renderDocumentPdf(
          brandingPreviewToRenderModel(input, {
            logo: logoResult.image,
            stamp: stampResult.image,
          }),
          input.branding.pdfTemplate,
          input.language,
        ).pipe(Effect.provideService(PdfEngine, engine), Effect.orDie);
        return {
          filename: `preview-${input.kind}.pdf`,
          contentType: "application/pdf",
          bytes: Stream.succeed(bytes),
        };
      }),
    });
  }),
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
