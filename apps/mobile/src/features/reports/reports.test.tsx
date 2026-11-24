import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type {
  DocumentId,
  IsoDate,
  WorkspaceId,
  WorkspaceSlug,
  WorkspaceSummary,
} from "@kvitbit/domain/contract";
import type { Period } from "@kvitbit/ui-port/view-models";
import { Effect } from "effect";
import type { ReactElement } from "react";
import {
  fakeTransfer,
  useFakeTransfer as installFakeTransfer,
} from "../../platform/transfer/testing";
import { ApiProvider, type ApiRunner, useApi, useRemote } from "../../runtime/api-runtime";
import { clientRoot } from "../../testing/client-root";
import { allText, hostTree } from "../../testing/element-tree";
import { eventually } from "../../testing/eventually";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import { recordedOverlay, TestProviders } from "../../testing/providers";
import { WorkspaceProvider } from "../../workspace/workspace-provider";
import {
  buildReportExportRequest,
  decodeReportView,
  isValidPeriod,
  parseReportKind,
  periodPresets,
  periodToRange,
  shiftPeriod,
} from "./model";

const transferFake = fakeTransfer();

mock.module("expo-router", () => ({
  ...expoRouterStandIn(),
  router: {
    back: () => undefined,
    canGoBack: () => true,
    push: () => undefined,
    replace: () => undefined,
  },
}));
installFakeTransfer(transferFake);

const { ReportsScreen } = await import("./reports-screen");
const { useTransfer } = await import("../../platform/transfer");

const WS_ID = "01937c7a-0000-7000-8000-000000000001" as WorkspaceId;
const DOC_1 = "01937c7a-0000-7000-8000-000000000801" as DocumentId;

const WORKSPACE: WorkspaceSummary = {
  id: WS_ID,
  slug: "acme" as WorkspaceSlug,
  name: "Acme s.r.o.",
  role: "owner",
  memberCount: 1,
  taxRegime: "vat_payer",
  closed: false,
};

describe("reports model", () => {
  test("parses report segments and computes inclusive period ranges", () => {
    expect(parseReportKind("vat-summary")).toBe("vat_summary");
    expect(parseReportKind("receivables")).toBe("receivables");
    expect(parseReportKind("unknown")).toBe("vat_summary");

    expect(isValidPeriod("2026-11")).toBe(true);
    expect(isValidPeriod("2026-Q4")).toBe(true);
    expect(isValidPeriod("2026")).toBe(true);
    expect(isValidPeriod("2026-13")).toBe(false);

    expect(periodToRange("2024-02" as Period)).toEqual({
      from: "2024-02-01" as IsoDate,
      to: "2024-02-29" as IsoDate,
    });
    expect(periodToRange("2026-02" as Period)).toEqual({
      from: "2026-02-01" as IsoDate,
      to: "2026-02-28" as IsoDate,
    });
    expect(periodToRange("2026-Q4" as Period)).toEqual({
      from: "2026-10-01" as IsoDate,
      to: "2026-12-31" as IsoDate,
    });
    expect(periodToRange("2026" as Period)).toEqual({
      from: "2026-01-01" as IsoDate,
      to: "2026-12-31" as IsoDate,
    });
  });

  test("shifts periods across year boundaries and computes presets", () => {
    expect(shiftPeriod("2026-01" as Period, -1)).toBe("2025-12" as Period);
    expect(shiftPeriod("2026-12" as Period, 1)).toBe("2027-01" as Period);
    expect(shiftPeriod("2026-Q1" as Period, -1)).toBe("2025-Q4" as Period);
    expect(shiftPeriod("2026-Q4" as Period, 1)).toBe("2027-Q1" as Period);
    expect(shiftPeriod("2026" as Period, 1)).toBe("2027" as Period);

    const presets = periodPresets(new Date("2026-01-15T12:00:00Z"));
    expect(presets.thisMonth).toBe("2026-01" as Period);
    expect(presets.lastMonth).toBe("2025-12" as Period);
    expect(presets.thisQuarter).toBe("2026-Q1" as Period);
    expect(presets.thisYear).toBe("2026" as Period);
  });

  test("builds CSV and PDF export download requests", () => {
    const csv = buildReportExportRequest({
      workspaceId: WS_ID,
      report: "vat_summary",
      period: "2026-11" as Period,
      format: "csv",
    });
    expect(csv.path).toBe(`/workspaces/${WS_ID}/reports/vat_summary/export`);
    expect(csv.query).toEqual({
      format: "csv",
      from: "2026-11-01",
      to: "2026-11-30",
      groupBy: undefined,
    });
    expect(csv.filename).toBe("kvitbit-vat_summary-2026-11.csv");
    expect(csv.contentType).toContain("text/csv");

    const pdf = buildReportExportRequest({
      workspaceId: WS_ID,
      report: "receivables",
      period: "2026-Q4" as Period,
      format: "pdf",
    });
    expect(pdf.filename).toBe("kvitbit-receivables-2026-Q4.pdf");
    expect(pdf.contentType).toBe("application/pdf");
  });

  test("decodes VAT summary and receivables reports", () => {
    const vat = decodeReportView(
      {
        report: "vat_summary",
        period: { from: "2026-11-01", to: "2026-11-30" },
        output: [
          {
            month: "2026-11",
            treatment: "standard",
            ratePercent: "21",
            base: { amount: "10000.00", currency: "CZK" },
            vat: { amount: "2100.00", currency: "CZK" },
            documents: [{ _tag: "Document", id: DOC_1 }],
          },
        ],
        input: [],
        totals: {
          output: { amount: "2100.00", currency: "CZK" },
          input: { amount: "500.00", currency: "CZK" },
          payable: { amount: "1600.00", currency: "CZK" },
        },
      },
      "vat_summary",
    );
    expect(vat.report).toBe("vat_summary");
    if (vat.report === "vat_summary") {
      expect(vat.totals.payable.amount).toBe("1600.00");
      expect(vat.output).toHaveLength(1);
    }
  });
});

function ReportsProbe(props: {
  readonly onReady: (
    api: ApiRunner,
    transfer: ReturnType<typeof useTransfer>,
    vatLoaded: boolean,
  ) => void;
}) {
  const api = useApi();
  const transfer = useTransfer();
  const vat = useRemote(
    (c) =>
      c.reports.run({
        params: { workspaceId: WS_ID, report: "vat_summary" },
        query: { from: "2026-11-01" as IsoDate, to: "2026-11-30" as IsoDate },
      }),
    [],
  );
  if (vat.state._tag === "Ready") {
    const decoded = decodeReportView(vat.state.value, "vat_summary");
    props.onReady(
      api,
      transfer,
      decoded.report === "vat_summary" && decoded.totals.payable.amount === "1600.00",
    );
  }
  return <span>{vat.state._tag}</span>;
}

describe("reports screen and API/export integration", () => {
  const root = clientRoot({ keepFetch: true });
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/reports/vat_summary")) {
          return Response.json({
            report: "vat_summary",
            period: { from: "2026-11-01", to: "2026-11-30" },
            output: [
              {
                month: "2026-11",
                treatment: "standard",
                ratePercent: "21",
                base: { amount: "10000.00", currency: "CZK" },
                vat: { amount: "2100.00", currency: "CZK" },
                documents: [{ _tag: "Document", id: DOC_1 }],
              },
            ],
            input: [],
            totals: {
              output: { amount: "2100.00", currency: "CZK" },
              input: { amount: "500.00", currency: "CZK" },
              payable: { amount: "1600.00", currency: "CZK" },
            },
          });
        }
        if (url.pathname.endsWith("/reports/profit")) {
          return Response.json({
            report: "profit",
            period: { from: "2026-11-01", to: "2026-11-30" },
            rows: [
              {
                month: "2026-11",
                revenue: { amount: "50000.00", currency: "CZK" },
                expenses: { amount: "12000.00", currency: "CZK" },
                profit: { amount: "38000.00", currency: "CZK" },
              },
            ],
            totals: {
              revenue: { amount: "50000.00", currency: "CZK" },
              expenses: { amount: "12000.00", currency: "CZK" },
              profit: { amount: "38000.00", currency: "CZK" },
            },
          });
        }
        if (url.pathname.endsWith("/reports/receivables")) {
          return Response.json({
            report: "receivables",
            period: { from: "2026-11-01", to: "2026-11-30" },
            asOf: "2026-11-30",
            buckets: [
              {
                bucket: "1_30",
                count: 1,
                total: { amount: "9500.00", currency: "CZK" },
                documents: [
                  {
                    id: DOC_1,
                    kind: "invoice",
                    number: "2026-0077",
                    contact: { id: null, name: "Late Payer s.r.o." },
                    currency: "CZK",
                    dueOn: "2026-11-10",
                    daysOverdue: 20,
                    outstanding: { amount: "9500.00", currency: "CZK" },
                    outstandingCzk: { amount: "9500.00", currency: "CZK" },
                  },
                ],
              },
            ],
            total: { amount: "9500.00", currency: "CZK" },
            overdue: { total: { amount: "9500.00", currency: "CZK" }, count: 1 },
          });
        }
        return Response.json({ _tag: "NotFound", entity: "Report" }, { status: 404 });
      },
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  const within = (node: ReactElement) => (
    <TestProviders overlay={recordedOverlay()}>
      <ApiProvider token="tok" origin={server.url.origin}>
        <WorkspaceProvider workspace={WORKSPACE} workspaces={[WORKSPACE]} reload={() => undefined}>
          {node}
        </WorkspaceProvider>
      </ApiProvider>
    </TestProviders>
  );

  test("ReportsScreen renders selector, period picker and CSV/PDF export actions via hostTree", () => {
    const text = allText(
      hostTree(<ReportsScreen report="vat_summary" initialPeriod={"2026-11" as Period} />, within),
    );
    expect(text).toContain("Reports");
    expect(text).toContain("VAT summary");
    expect(text).toContain("Profit");
    expect(text).toContain("Receivables");
    expect(text).toContain("2026-11");
    expect(text).toContain("Export CSV");
    expect(text).toContain("Export PDF");
  });

  test("end-to-end API + Transfer runtime runs VAT, profit, receivables and exports CSV/PDF", async () => {
    installFakeTransfer(transferFake);
    transferFake.downloads.length = 0;
    transferFake.shared.length = 0;

    let apiRef: ApiRunner | null = null;
    let transferRef: ReturnType<typeof useTransfer> | null = null;
    let vatLoaded = false;

    await root.render(
      within(
        <ReportsProbe
          onReady={(a, tr, ok) => {
            apiRef = a;
            transferRef = tr;
            vatLoaded = ok;
          }}
        />,
      ),
    );
    await Effect.runPromise(eventually(() => vatLoaded && apiRef !== null && transferRef !== null));
    expect(vatLoaded).toBe(true);

    const api = apiRef as unknown as ApiRunner;
    const transfer = transferRef as unknown as ReturnType<typeof useTransfer>;

    const profitRes = await api.run((c) =>
      c.reports.run({
        params: { workspaceId: WS_ID, report: "profit" },
        query: { from: "2026-11-01" as IsoDate, to: "2026-11-30" as IsoDate },
      }),
    );
    expect(profitRes._tag).toBe("Ok");
    if (profitRes._tag === "Ok") {
      const decoded = decodeReportView(profitRes.value, "profit");
      expect(decoded.report).toBe("profit");
      if (decoded.report === "profit") expect(decoded.totals.profit.amount).toBe("38000.00");
    }

    const recRes = await api.run((c) =>
      c.reports.run({
        params: { workspaceId: WS_ID, report: "receivables" },
        query: { from: "2026-11-01" as IsoDate, to: "2026-11-30" as IsoDate },
      }),
    );
    expect(recRes._tag).toBe("Ok");
    if (recRes._tag === "Ok") {
      const decoded = decodeReportView(recRes.value, "receivables");
      expect(decoded.report).toBe("receivables");
      if (decoded.report === "receivables") {
        expect(decoded.overdue.count).toBe(1);
        expect(decoded.buckets[0]?.documents[0]?.number).toBe("2026-0077");
      }
    }

    // Export CSV & PDF via Transfer
    const csvReq = buildReportExportRequest({
      workspaceId: WS_ID,
      report: "vat_summary",
      period: "2026-11" as Period,
      format: "csv",
    });
    const csvDl = await transfer.download(csvReq);
    expect(csvDl._tag).toBe("Ok");
    if (csvDl._tag === "Ok") await transfer.share(csvDl.value);

    const pdfReq = buildReportExportRequest({
      workspaceId: WS_ID,
      report: "receivables",
      period: "2026-11" as Period,
      format: "pdf",
    });
    const pdfDl = await transfer.download(pdfReq);
    expect(pdfDl._tag).toBe("Ok");
    if (pdfDl._tag === "Ok") await transfer.share(pdfDl.value);

    expect(transferFake.downloads).toHaveLength(2);
    expect(transferFake.shared).toHaveLength(2);
  });
});
