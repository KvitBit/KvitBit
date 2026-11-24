import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  ContactId,
  DocumentId,
  WorkspaceId,
  WorkspaceSlug,
  WorkspaceSummary,
} from "@kvitbit/domain/contract";
import { act } from "react";
import {
  fakeTransfer,
  useFakeTransfer as registerFakeTransfer,
} from "../../platform/transfer/testing";
import { ApiProvider } from "../../runtime/api-runtime";
import { clientRoot } from "../../testing/client-root";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import { recordedOverlay, TestProviders } from "../../testing/providers";
import { WorkspaceProvider } from "../../workspace/workspace-provider";
import { uiShim } from "./test-ui-shim";

const pushed: string[] = [];
const replaced: string[] = [];
let mockParams: Record<string, string> = {};
const copiedStrings: string[] = [];
const overlay = recordedOverlay();

mock.module("expo-router", () => ({
  ...expoRouterStandIn({
    useLocalSearchParams: () => mockParams,
  }),
  router: {
    push: (href: string) => pushed.push(href),
    replace: (href: string) => replaced.push(href),
    back: () => undefined,
    canGoBack: () => true,
  },
}));

mock.module("expo-clipboard", () => ({
  setStringAsync: async (value: string) => {
    copiedStrings.push(value);
  },
}));

const realUi = { ...(await import("../../ui")) };
const transferFake = fakeTransfer();
registerFakeTransfer(transferFake);

const { DocumentDetailScreen } = await import("./detail-screen");
const { DocumentEditorScreen } = await import("./editor-screen");

const reactPropsOf = (el: Element | null): Record<string, unknown> => {
  if (el === null) throw new Error("Element not found");
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  if (key === undefined) throw new Error("React props not found on element");
  const record = (el as unknown as Record<string, Record<string, unknown>>)[key];
  if (record === undefined) throw new Error("React props object missing");
  return record;
};

const waitFor = async (check: () => boolean, label = "condition"): Promise<void> => {
  for (let i = 0; i < 250; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const WS_ID = "01930000-0000-7000-8000-000000000001" as WorkspaceId;
const WS_SLUG = "acme" as WorkspaceSlug;
const DOC_ID = "01930000-0000-7000-8000-000000000101" as DocumentId;
const FINAL_ID = "01930000-0000-7000-8000-000000000199" as DocumentId;
const CON_ID = "01930000-0000-7000-8000-000000000201" as ContactId;

const WORKSPACE: WorkspaceSummary = {
  id: WS_ID,
  slug: WS_SLUG,
  name: "Acme s.r.o.",
  role: "admin",
  memberCount: 2,
  taxRegime: "vat_payer",
  closed: false,
};

const makeWireDoc = (overrides: Record<string, unknown> = {}) => ({
  id: DOC_ID,
  kind: "proforma",
  number: "ZF-2026-001",
  status: "issued",
  locked: false,
  settlement: "paid",
  overdue: false,
  revision: 3,
  taxDocument: false,
  contact: {
    contactId: CON_ID,
    name: "Beta s.r.o.",
    ico: "12345678",
    dic: "CZ12345678",
    legalForm: "s.r.o.",
    address: { street: "Ulice 1", city: "Praha", postalCode: "11000", country: "CZ" },
    billingEmails: ["billing@beta.cz"],
  },
  issuer: {
    workspaceId: WS_ID,
    name: "Acme s.r.o.",
    ico: "87654321",
    dic: "CZ87654321",
    address: { street: "Hlavní 2", city: "Brno", postalCode: "60200", country: "CZ" },
    registerEntry: null,
    email: "info@acme.cz",
    phone: null,
    web: null,
    regime: "vat_payer",
    bankAccount: {
      id: "01930000-0000-7000-8000-000000000301",
      name: "EUR",
      currency: "EUR",
      accountNumber: null,
      iban: "CZ6508000000192000145399",
      bic: "GIBACZPX",
    },
  },
  dates: {
    issuedOn: "2026-11-20",
    taxableSupplyOn: "2026-11-20",
    dueOn: "2026-12-04",
  },
  paymentMethod: "bank_transfer",
  lines: [
    {
      id: "01930000-0000-7000-8000-000000000401",
      item: null,
      description: "Development sprint",
      quantity: "10",
      unit: "h",
      unitPrice: "100",
      treatment: "standard",
      ratePercent: "21",
      amount: "1000",
      deducts: null,
    },
  ],
  totals: {
    buckets: [
      {
        treatment: "standard",
        ratePercent: "21",
        base: "1000",
        vat: "210",
        gross: "1210",
        vatCzk: "5292",
      },
    ],
    net: { amount: "1000", currency: "EUR" },
    vat: { amount: "210", currency: "EUR" },
    roundingAdjustment: { amount: "0", currency: "EUR" },
    gross: { amount: "1210", currency: "EUR" },
    vatCzk: { amount: "5292", currency: "CZK" },
  },
  fx: {
    rate: "25.20",
    quantity: 1,
    fixingDate: "2026-11-20",
    source: "cnb",
  },
  statutoryNotes: [],
  paymentQr: null,
  related: [
    {
      relation: "tax_document_for",
      id: "01930000-0000-7000-8000-000000000155",
      kind: "payment_tax_document",
      number: "DD-2026-001",
    },
  ],
  share: {
    url: "https://kvitbit.cz/i/tok123",
    views: 2,
    lastViewedAt: "2026-11-21T14:00:00.000Z",
  },
  deliveries: [],
  ...overrides,
});

describe("DocumentDetailScreen and DocumentEditorScreen", () => {
  const root = clientRoot({ keepFetch: true });
  let server: ReturnType<typeof Bun.serve>;
  let wireDoc = makeWireDoc();
  let calls: Array<{ method: string; path: string; body?: unknown }> = [];

  beforeAll(() => {
    mock.module("../../ui", () => uiShim);
    registerFakeTransfer(transferFake);
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body =
          req.method !== "GET" && req.method !== "DELETE"
            ? await req.json().catch(() => undefined)
            : undefined;
        calls.push({ method: req.method, path: url.pathname, body });

        if (req.method === "GET" && url.pathname.endsWith(`/documents/${DOC_ID}`)) {
          return Response.json(wireDoc);
        }
        if (req.method === "GET" && url.pathname.endsWith(`/documents/${DOC_ID}/payments`)) {
          return Response.json([
            {
              id: "01930000-0000-7000-8000-000000000501",
              revision: 1,
              target: { document: DOC_ID },
              amount: { amount: "1210", currency: "EUR" },
              paidOn: "2026-11-21",
              method: "bank_transfer",
              note: "Wire",
              taxDocument: "01930000-0000-7000-8000-000000000155",
              createdAt: "2026-11-21T10:00:00.000Z",
            },
          ]);
        }
        if (req.method === "POST" && url.pathname.endsWith(`/documents/${DOC_ID}/final-invoice`)) {
          return Response.json(
            makeWireDoc({ id: FINAL_ID, kind: "invoice", number: "2026-0099" }),
            { status: 201 },
          );
        }
        if (req.method === "DELETE" && url.pathname.endsWith(`/documents/${DOC_ID}/share-link`)) {
          wireDoc = makeWireDoc({ share: null });
          return new Response(null, { status: 204 });
        }
        if (
          req.method === "GET" &&
          url.pathname.endsWith(`/documents/${DOC_ID}/share-link/views`)
        ) {
          return Response.json({ items: [], nextCursor: null });
        }
        if (req.method === "GET" && url.pathname.endsWith(`/workspaces/${WS_ID}`)) {
          return Response.json({
            slug: WS_SLUG,
            revision: 1,
            taxRegime: "vat_payer",
            defaults: {
              currency: "CZK",
              language: "cs",
              dueDays: 14,
              paymentMethod: "bank_transfer",
              paymentRounding: "none",
              note: null,
              preferredSeriesByKind: {},
            },
            branding: {
              pdfTemplate: "classic",
              accentColor: "#1B4332",
              footerText: null,
              theme: null,
              logo: null,
              stamp: null,
            },
          });
        }
        if (req.method === "GET" && url.pathname.endsWith("/contacts")) {
          return Response.json({
            items: [
              {
                id: CON_ID,
                name: "Beta s.r.o.",
                ico: "12345678",
                dic: "CZ12345678",
                billingEmails: ["billing@beta.cz"],
                archived: false,
                defaults: {},
                revision: 1,
              },
            ],
            nextCursor: null,
          });
        }
        if (req.method === "GET" && url.pathname.endsWith("/price-list-items")) {
          return Response.json([]);
        }
        if (req.method === "GET" && url.pathname.endsWith("/bank-accounts")) {
          return Response.json([
            {
              id: "01930000-0000-7000-8000-000000000302",
              name: "CZK",
              iban: "CZ6508000000192000145399",
              bic: "GIBACZPX",
              currency: "CZK",
              isDefault: true,
              revision: 1,
            },
          ]);
        }
        if (req.method === "GET" && url.pathname.endsWith("/numbering-series")) {
          return Response.json([
            {
              id: "01930000-0000-7000-8000-000000000601",
              kind: "invoice",
              name: "Invoices",
              pattern: "YYYY-NNNN",
              isDefault: true,
              periodKey: "2026",
              nextCounter: 1,
              nextNumber: "2026-0001",
            },
          ]);
        }
        if (req.method === "POST" && url.pathname.endsWith("/documents")) {
          return Response.json(
            makeWireDoc({ id: FINAL_ID, kind: "invoice", number: null, status: "draft" }),
            { status: 201 },
          );
        }
        return new Response("Not Found", { status: 404 });
      },
    });
  });

  afterAll(() => {
    server.stop(true);
    mock.module("../../ui", () => realUi);
  });

  afterEach(async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
    await root.render(null);
  });

  beforeEach(() => {
    pushed.length = 0;
    replaced.length = 0;
    copiedStrings.length = 0;
    overlay.toasts.length = 0;
    overlay.answer = true;
    transferFake.downloads.length = 0;
    transferFake.opened.length = 0;
    transferFake.shared.length = 0;
    calls = [];
    wireDoc = makeWireDoc();
    mockParams = { id: DOC_ID };
  });

  test("detail screen renders VAT/CZK breakdown, chain links, PDF transfer and final invoice", async () => {
    await root.render(
      <TestProviders locale="en" overlay={overlay}>
        <ApiProvider token="tok" origin={server.url.origin}>
          <WorkspaceProvider
            workspace={WORKSPACE}
            workspaces={[WORKSPACE]}
            reload={() => undefined}
          >
            <DocumentDetailScreen />
          </WorkspaceProvider>
        </ApiProvider>
      </TestProviders>,
    );

    await waitFor(
      () => (root.container().textContent ?? "").includes("ZF-2026-001"),
      "detail loaded",
    );

    const text = (root.container().textContent ?? "").replace(/\u00a0/g, " ");
    expect(text).toContain("Development sprint");
    expect(text).toContain("DD-2026-001");
    expect(text).toContain("CZK 5,292.00");
    expect(text).toContain("1 EUR = 25.2 CZK");
    expect(text).not.toContain("Rounding");

    const pdfOpenBtn = root.container().querySelector('[data-testid="detail-pdf-download"]');
    const pdfShareBtn = root.container().querySelector('[data-testid="detail-pdf-share"]');
    await act(async () => {
      (reactPropsOf(pdfOpenBtn).onClick as () => void)();
    });
    await waitFor(() => transferFake.opened.length === 1, "pdf opened");
    expect(transferFake.downloads[0]?.path).toBe(`/workspaces/${WS_ID}/documents/${DOC_ID}/pdf`);
    expect(transferFake.downloads[0]?.filename).toBe("ZF-2026-001.pdf");

    await act(async () => {
      (reactPropsOf(pdfShareBtn).onClick as () => void)();
    });
    await waitFor(() => transferFake.shared.length === 1, "pdf shared");

    const finalBtn = root.container().querySelector('[data-testid="detail-action-final"]');
    await act(async () => {
      (reactPropsOf(finalBtn).onClick as () => void)();
    });
    await waitFor(
      () =>
        calls.some((c) => c.path.endsWith(`/documents/${DOC_ID}/final-invoice`)) &&
        pushed.some((href) => href.includes(FINAL_ID)),
      "final invoice issued and navigated",
    );
    expect(pushed.some((href) => href.includes(FINAL_ID))).toBe(true);
  });

  test("detail share tab copies and revokes public share link", async () => {
    mockParams = { id: DOC_ID, tab: "share" };
    await root.render(
      <TestProviders locale="en" overlay={overlay}>
        <ApiProvider token="tok" origin={server.url.origin}>
          <WorkspaceProvider
            workspace={WORKSPACE}
            workspaces={[WORKSPACE]}
            reload={() => undefined}
          >
            <DocumentDetailScreen />
          </WorkspaceProvider>
        </ApiProvider>
      </TestProviders>,
    );

    await waitFor(
      () => (root.container().textContent ?? "").includes("https://kvitbit.cz/i/tok123"),
      "share link shown",
    );

    const copyBtn = root.container().querySelector('[data-testid="share-link-copy"]');
    await act(async () => {
      (reactPropsOf(copyBtn).onClick as () => void)();
    });
    await waitFor(() => copiedStrings.length === 1, "copied");
    expect(copiedStrings[0]).toBe("https://kvitbit.cz/i/tok123");

    const revokeBtn = root.container().querySelector('[data-testid="share-link-revoke"]');
    await act(async () => {
      (reactPropsOf(revokeBtn).onClick as () => void)();
    });
    await waitFor(
      () =>
        calls.some((c) => c.method === "DELETE" && c.path.endsWith("/share-link")) &&
        calls.filter((c) => c.method === "GET" && c.path.endsWith(`/documents/${DOC_ID}`)).length >=
          2,
      "share link revoked and document reloaded",
    );
  });

  test("editor screen shows live VAT preview and saves draft", async () => {
    await root.render(
      <TestProviders locale="en" overlay={overlay}>
        <ApiProvider token="tok" origin={server.url.origin}>
          <WorkspaceProvider
            workspace={WORKSPACE}
            workspaces={[WORKSPACE]}
            reload={() => undefined}
          >
            <DocumentEditorScreen mode="new" kind="invoice" contactId={CON_ID} />
          </WorkspaceProvider>
        </ApiProvider>
      </TestProviders>,
    );

    await waitFor(
      () => root.container().querySelector('[data-testid="editor-line-desc-0"]') !== null,
      "editor loaded",
    );

    const descInput = root.container().querySelector('[data-testid="editor-line-desc-0"]');
    const priceInput = root.container().querySelector('[data-testid="editor-line-price-0"]');
    await act(async () => {
      (reactPropsOf(descInput).onChange as (e: { target: { value: string } }) => void)({
        target: { value: "Audit work" },
      });
      (reactPropsOf(priceInput).onChange as (e: { target: { value: string } }) => void)({
        target: { value: "1000" },
      });
    });

    await waitFor(
      () =>
        (
          root.container().querySelector('[data-testid="editor-preview-total"]')?.textContent ?? ""
        ).includes("1,210.00"),
      "live preview updated",
    );

    const saveBtn = root.container().querySelector('[data-testid="editor-save-button"]');
    await act(async () => {
      (reactPropsOf(saveBtn).onClick as () => void)();
    });
    await waitFor(
      () =>
        calls.some((c) => c.method === "POST" && c.path.endsWith("/documents")) &&
        replaced.some((href) => href.includes(FINAL_ID)),
      "draft saved and navigated",
    );
    expect(replaced.some((href) => href.includes(FINAL_ID))).toBe(true);
  });
});
