import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import {
  ContactId,
  DocumentId,
  type DocumentView,
  WorkspaceId,
  WorkspaceSlug,
  type WorkspaceSummary,
} from "@kvitbit/domain/contract";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { act, type ReactNode } from "react";
import {
  fakeTransfer,
  useFakeTransfer as registerFakeTransfer,
} from "../../platform/transfer/testing";
import { ApiProvider } from "../../runtime/api-runtime";
import { SessionProvider } from "../../session/session-provider";
import { tokenStore } from "../../session/token-store";
import { clientRoot, waitForRender } from "../../testing/client-root";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import { SignedInFixture, TestProviders } from "../../testing/providers";
import { recordedOverlay } from "../../testing/recorded-overlay";
import { WorkspaceProvider } from "../../workspace/workspace-provider";
import { reactEventHandler } from "./react-event.test-utils";
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
  setStringAsync: (value: string) =>
    Effect.sync(() => {
      copiedStrings.push(value);
    }).pipe(Effect.runPromise),
}));

const realUi = { ...(await import("../../ui")) };
const transferFake = fakeTransfer();
registerFakeTransfer(transferFake);

const { DocumentDetailScreen } = await import("./detail-screen");
const { DocumentEditorScreen } = await import("./editor-screen");
const { default: DocumentNewRoute } = await import("../../../app/w/[ws]/documents/new/[kind]");
const { default: DocumentEditRoute } = await import("../../../app/w/[ws]/documents/[id]/edit");

const waitFor = (check: () => boolean, label?: string): Promise<void> =>
  waitForRender({ check, label, attempts: 250 });

const uuidV7Pattern = /^[0-9a-f-]{14}7[0-9a-f-]{21}$/;
const WS_ID = WorkspaceId.make("01930000-0000-7000-8000-000000000001");
const WS_SLUG = WorkspaceSlug.make("acme");
const DOC_ID = DocumentId.make("01930000-0000-7000-8000-000000000101");
const FINAL_ID = DocumentId.make("01930000-0000-7000-8000-000000000199");
const CON_ID = ContactId.make("01930000-0000-7000-8000-000000000201");
const TEMPLATE_ID = "01930000-0000-7000-8000-000000000901";
const CONTACT_SERIES = "01930000-0000-7000-8000-000000000602";

const WORKSPACE: WorkspaceSummary = {
  id: WS_ID,
  slug: WS_SLUG,
  name: "Acme s.r.o.",
  role: "admin",
  memberCount: 2,
  taxRegime: "vat_payer",
  closed: false,
};

type WireDocOverrides = Partial<
  Pick<DocumentView, "id" | "kind" | "number" | "status" | "settlement" | "revision" | "share">
>;
const makeWireDoc = (overrides: WireDocOverrides = {}) => ({
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
  let calls: Array<{
    method: string;
    path: string;
    body?: unknown;
    key: string | null;
    ifMatch: string | null;
  }> = [];
  let dropNext: string | null = null;
  let dropIssueBeforeCommit = false;
  let holdFxResponse: Promise<void> | null = null;
  let committed: Map<string, ReturnType<typeof makeWireDoc>>;
  let templateTerms: { language: string; series: string; pricesIncludeVat: boolean } | null = null;

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
        const key = req.headers.get("Idempotency-Key");
        calls.push({
          method: req.method,
          path: url.pathname,
          body,
          key,
          ifMatch: req.headers.get("If-Match"),
        });

        if (Str.endsWith("/get-session")(url.pathname)) {
          return Response.json({
            user: { id: "documents-test-user", email: "documents@example.test" },
          });
        }

        if (req.method === "GET" && Str.endsWith(`/documents/${wireDoc.id}`)(url.pathname)) {
          return Response.json(wireDoc);
        }
        if (req.method === "PATCH" && Str.endsWith(`/documents/${wireDoc.id}`)(url.pathname)) {
          if (req.headers.get("If-Match") !== `"${wireDoc.revision}"`) {
            return new Response(null, { status: 412 });
          }
          if (templateTerms !== null) {
            templateTerms = {
              language: body.language ?? templateTerms.language,
              series: body.series ?? templateTerms.series,
              pricesIncludeVat: body.pricesIncludeVat ?? templateTerms.pricesIncludeVat,
            };
          }
          wireDoc = { ...wireDoc, revision: wireDoc.revision + 1 };
          return Response.json(wireDoc);
        }
        if (req.method === "POST" && Str.endsWith("/issue")(url.pathname) && key !== null) {
          const earlier = committed.get(key);
          if (earlier !== undefined)
            return Response.json(earlier, {
              status: Str.endsWith(`/documents/${DOC_ID}/issue`)(url.pathname) ? 200 : 201,
            });
          const fromDraft = Str.endsWith(`/documents/${DOC_ID}/issue`)(url.pathname);
          if (dropNext === url.pathname && dropIssueBeforeCommit) {
            dropNext = null;
            return new Response("{", {
              status: fromDraft ? 200 : 201,
              headers: { "content-type": "application/json" },
            });
          }
          const issued = makeWireDoc({
            id: fromDraft ? DOC_ID : FINAL_ID,
            revision: wireDoc.revision + 1,
            kind: "invoice",
            number: "2026-0099",
          });
          committed.set(key, issued);
          if (fromDraft) wireDoc = issued;
          if (dropNext === url.pathname) {
            dropNext = null;
            return new Response("{", {
              status: fromDraft ? 200 : 201,
              headers: { "content-type": "application/json" },
            });
          }
          return Response.json(issued, { status: fromDraft ? 200 : 201 });
        }
        if (
          req.method === "POST" &&
          Str.endsWith(`/templates/${TEMPLATE_ID}/documents`)(url.pathname)
        ) {
          templateTerms = {
            language: body.patch.language,
            series: body.patch.series,
            pricesIncludeVat: body.patch.pricesIncludeVat,
          };
          if (dropNext === url.pathname) {
            dropNext = null;
            return new Response("{", {
              status: 201,
              headers: { "content-type": "application/json" },
            });
          }
          return Response.json(wireDoc, { status: 201 });
        }
        if (req.method === "GET" && Str.endsWith(`/templates/${TEMPLATE_ID}`)(url.pathname)) {
          return Response.json({
            revision: 9,
            schedule: null,
            input: {
              contact: CON_ID,
              kind: "invoice",
              pricesIncludeVat: true,
              note: dropNext === null ? "Newer template note" : "Imported template note",
            },
          });
        }
        if (req.method === "GET" && Str.endsWith(`/contacts/${CON_ID}`)(url.pathname)) {
          return Response.json({
            id: CON_ID,
            name: "Beta s.r.o.",
            archived: false,
            revision: 1,
            defaults: { language: "en", preferredSeriesByKind: { invoice: CONTACT_SERIES } },
          });
        }
        if (req.method === "GET" && Str.endsWith(`/documents/${DOC_ID}/payments`)(url.pathname)) {
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
        if (req.method === "POST" && Str.endsWith("/payments")(url.pathname)) {
          if (dropNext === url.pathname) {
            dropNext = null;
            return new Response("{", {
              status: 201,
              headers: { "content-type": "application/json" },
            });
          }
          return Response.json(
            {
              payment: {
                id: "01930000-0000-7000-8000-000000000502",
                revision: 1,
                target: { document: DOC_ID },
                amount: { amount: "100", currency: "EUR" },
                paidOn: "2026-11-21",
                method: "bank_transfer",
                note: null,
                taxDocument: null,
                createdAt: "2026-11-21T10:00:00.000Z",
              },
              settlement: "partially_paid",
              issued: [],
            },
            { status: 201 },
          );
        }
        if (
          req.method === "POST" &&
          Str.endsWith(`/documents/${DOC_ID}/final-invoice`)(url.pathname)
        ) {
          return Response.json(
            makeWireDoc({ id: FINAL_ID, kind: "invoice", number: "2026-0099" }),
            { status: 201 },
          );
        }
        if (
          req.method === "DELETE" &&
          Str.endsWith(`/documents/${DOC_ID}/share-link`)(url.pathname)
        ) {
          wireDoc = makeWireDoc({ share: null });
          return new Response(null, { status: 204 });
        }
        if (
          req.method === "GET" &&
          Str.endsWith(`/documents/${DOC_ID}/share-link/views`)(url.pathname)
        ) {
          return Response.json({ items: [], nextCursor: null });
        }
        if (req.method === "GET" && Str.endsWith(`/workspaces/${WS_ID}`)(url.pathname)) {
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
        if (req.method === "GET" && Str.endsWith("/contacts")(url.pathname)) {
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
        if (req.method === "GET" && Str.endsWith("/price-list-items")(url.pathname)) {
          return Response.json([]);
        }
        if (req.method === "GET" && Str.endsWith("/bank-accounts")(url.pathname)) {
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
        if (req.method === "GET" && Str.endsWith("/numbering-series")(url.pathname)) {
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
        if (
          req.method === "GET" &&
          Str.endsWith("/fx-rates/EUR")(url.pathname) &&
          holdFxResponse !== null
        ) {
          const held = holdFxResponse;
          holdFxResponse = null;
          await held;
        }
        if (req.method === "POST" && Str.endsWith("/documents")(url.pathname)) {
          return Response.json(
            makeWireDoc({ id: FINAL_ID, kind: "invoice", number: null, status: "draft" }),
            { status: 201 },
          );
        }
        return new Response("Not Found", { status: 404 });
      },
    });
  });

  beforeEach(async () => {
    await tokenStore.write("docs-test-session");
    pushed.length = 0;
    replaced.length = 0;
    copiedStrings.length = 0;
    overlay.toasts.length = 0;
    overlay.answer = true;
    transferFake.downloads.length = 0;
    transferFake.opened.length = 0;
    transferFake.shared.length = 0;
    calls = [];
    committed = new Map();
    dropNext = null;
    dropIssueBeforeCommit = false;
    holdFxResponse = null;
    templateTerms = null;
    wireDoc = makeWireDoc();
    mockParams = { id: DOC_ID };
  });

  afterEach(async () => {
    await act(async () => {
      await Effect.runPromise(Effect.sleep(25));
    });
    await root.render(null);
    await tokenStore.clear();
  });

  afterAll(() => {
    server.stop(true);
    mock.module("../../ui", () => realUi);
  });

  const show = (node: ReactNode, token = "tok") =>
    root.render(
      <TestProviders locale="en" overlay={overlay}>
        <SessionProvider origin={server.url.origin}>
          <SignedInFixture>
            <ApiProvider token={token} origin={server.url.origin}>
              <WorkspaceProvider
                workspace={WORKSPACE}
                workspaces={[WORKSPACE]}
                reload={() => undefined}
              >
                {node}
              </WorkspaceProvider>
            </ApiProvider>
          </SignedInFixture>
        </SessionProvider>
      </TestProviders>,
    );

  const click = (testId: string) =>
    act(() => {
      reactEventHandler(root.container().querySelector(`[data-testid="${testId}"]`), "onClick")();
    });

  const change = (testId: string, value: string) =>
    act(() => {
      const input = root.container().querySelector(`[data-testid="${testId}"]`);
      reactEventHandler(
        input,
        "onChange",
      )({
        target: { value },
      });
    });

  test("detail screen renders VAT/CZK breakdown, chain links, PDF transfer and final invoice", async () => {
    await show(<DocumentDetailScreen />);

    await waitFor(
      () => Str.includes("ZF-2026-001")(root.container().textContent ?? ""),
      "detail loaded",
    );

    const text = Str.replace(/\u00a0/g, " ")(root.container().textContent ?? "");
    expect(text).toContain("Development sprint");
    expect(text).toContain("DD-2026-001");
    expect(text).toContain("CZK 5,292.00");
    expect(text).toContain("1 EUR = 25.2 CZK");
    expect(text).not.toContain("Rounding");

    const pdfOpenBtn = root.container().querySelector('[data-testid="detail-pdf-download"]');
    const pdfShareBtn = root.container().querySelector('[data-testid="detail-pdf-share"]');
    await act(() => {
      reactEventHandler(pdfOpenBtn, "onClick")();
    });
    await waitFor(() => transferFake.opened.length === 1, "pdf opened");
    expect(transferFake.downloads[0]?.path).toBe(`/workspaces/${WS_ID}/documents/${DOC_ID}/pdf`);
    expect(transferFake.downloads[0]?.filename).toBe("ZF-2026-001.pdf");

    await act(() => {
      reactEventHandler(pdfShareBtn, "onClick")();
    });
    await waitFor(() => transferFake.shared.length === 1, "pdf shared");

    const finalBtn = root.container().querySelector('[data-testid="detail-action-final"]');
    await act(() => {
      reactEventHandler(finalBtn, "onClick")();
    });
    await waitFor(
      () =>
        Arr.some(calls, (c) => Str.endsWith(`/documents/${DOC_ID}/final-invoice`)(c.path)) &&
        Arr.some(pushed, (href) => Str.includes(FINAL_ID)(href)),
      "final invoice issued and navigated",
    );
    expect(Arr.some(pushed, (href) => Str.includes(FINAL_ID)(href))).toBe(true);
  });

  test("detail share tab copies and revokes public share link", async () => {
    mockParams = { id: DOC_ID, tab: "share" };
    await show(<DocumentDetailScreen />);

    await waitFor(
      () => Str.includes("https://kvitbit.cz/i/tok123")(root.container().textContent ?? ""),
      "share link shown",
    );

    const copyBtn = root.container().querySelector('[data-testid="share-link-copy"]');
    await act(() => {
      reactEventHandler(copyBtn, "onClick")();
    });
    await waitFor(() => copiedStrings.length === 1, "copied");
    expect(copiedStrings[0]).toBe("https://kvitbit.cz/i/tok123");

    const revokeBtn = root.container().querySelector('[data-testid="share-link-revoke"]');
    await act(() => {
      reactEventHandler(revokeBtn, "onClick")();
    });
    await waitFor(
      () =>
        Arr.some(calls, (c) => c.method === "DELETE" && Str.endsWith("/share-link")(c.path)) &&
        Arr.filter(calls, (c) => c.method === "GET" && Str.endsWith(`/documents/${DOC_ID}`)(c.path))
          .length >= 2,
      "share link revoked and document reloaded",
    );
  });

  test("editor screen shows live VAT preview and saves draft", async () => {
    await show(<DocumentEditorScreen mode="new" kind="invoice" contactId={CON_ID} />);

    await waitFor(
      () => root.container().querySelector('[data-testid="editor-line-desc-0"]') !== null,
      "editor loaded",
    );

    const descInput = root.container().querySelector('[data-testid="editor-line-desc-0"]');
    const priceInput = root.container().querySelector('[data-testid="editor-line-price-0"]');
    await act(() => {
      reactEventHandler(
        descInput,
        "onChange",
      )({
        target: { value: "Audit work" },
      });
      reactEventHandler(
        priceInput,
        "onChange",
      )({
        target: { value: "1000" },
      });
    });

    await waitFor(
      () =>
        Str.includes("1,210.00")(
          root.container().querySelector('[data-testid="editor-preview-total"]')?.textContent ?? "",
        ),
      "live preview updated",
    );

    const saveBtn = root.container().querySelector('[data-testid="editor-save-button"]');
    await act(() => {
      reactEventHandler(saveBtn, "onClick")();
    });
    await waitFor(
      () =>
        Arr.some(calls, (c) => c.method === "POST" && Str.endsWith("/documents")(c.path)) &&
        Arr.some(replaced, (href) => Str.includes(FINAL_ID)(href)),
      "draft saved and navigated",
    );
    expect(Arr.some(replaced, (href) => Str.includes(FINAL_ID)(href))).toBe(true);
  });

  test("retries a committed issue-from-input with the same key after the response is lost", async () => {
    const path = `/api/v1/workspaces/${WS_ID}/documents/issue`;
    dropNext = path;
    await show(<DocumentEditorScreen mode="new" kind="invoice" contactId={CON_ID} />);
    await waitFor(
      () => root.container().querySelector('[data-testid="editor-line-desc-0"]') !== null,
    );
    await act(() => {
      for (const [testId, value] of [
        ["editor-line-desc-0", "Audit work"],
        ["editor-line-price-0", "1000"],
      ] as const) {
        const input = root.container().querySelector(`[data-testid="${testId}"]`);
        reactEventHandler(
          input,
          "onChange",
        )({
          target: { value },
        });
      }
    });
    await click("editor-issue-button");
    await waitFor(
      () =>
        Arr.some(calls, (c) => c.path === path) &&
        Str.includes("Please try again")(root.container().textContent ?? ""),
      "failed issue response",
    );
    expect(replaced).toEqual([]);
    await click("editor-issue-button");
    await waitFor(
      () => Arr.some(replaced, (href) => Str.includes(FINAL_ID)(href)),
      "retried issue",
    );

    const attempts = Arr.filter(calls, (c) => c.path === path);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.key).toMatch(uuidV7Pattern);
    expect(attempts[1]?.key).toBe(attempts[0]?.key);
    expect(committed.size).toBe(1);
  });

  test("issue retry keeps the successful PATCH revision and skips the already applied edit", async () => {
    const path = `/api/v1/workspaces/${WS_ID}/documents/${DOC_ID}/issue`;
    wireDoc = makeWireDoc({ kind: "invoice", status: "draft", number: null, settlement: "unpaid" });
    dropNext = path;
    await show(<DocumentEditorScreen mode="edit" documentId={DOC_ID} />);
    await waitFor(
      () => root.container().querySelector('[data-testid="editor-issue-button"]') !== null,
    );

    await change("editor-note", "Saved before issue");
    await click("editor-issue-button");
    await waitFor(
      () =>
        Arr.some(calls, (c) => c.path === path) &&
        Str.includes("Please try again")(root.container().textContent ?? ""),
      "failed issue after PATCH",
    );
    await click("editor-issue-button");
    await waitFor(
      () => Arr.some(replaced, (href) => Str.includes(DOC_ID)(href)),
      "retried draft issue",
    );

    const edits = Arr.filter(calls, (c) => c.method === "PATCH");
    expect(edits).toHaveLength(1);
    expect(edits[0]?.ifMatch).toBe('"3"');
    const attempts = Arr.filter(calls, (c) => c.path === path);
    expect(Arr.map(attempts, (c) => c.ifMatch)).toEqual(['"4"', '"4"']);
    expect(attempts[1]?.key).toBe(attempts[0]?.key);
    expect(committed.size).toBe(1);
  });

  test("reopening a patched draft retries issue at the saved revision and key", async () => {
    const path = `/api/v1/workspaces/${WS_ID}/documents/${DOC_ID}/issue`;
    wireDoc = makeWireDoc({ kind: "invoice", status: "draft", number: null, settlement: "unpaid" });
    dropNext = path;
    dropIssueBeforeCommit = true;
    await show(<DocumentEditorScreen mode="edit" documentId={DOC_ID} />);
    const editorReady = () =>
      root.container().querySelector('[data-testid="editor-issue-button"]') !== null;
    await waitFor(editorReady);
    await change("editor-note", "Saved before issue");
    await click("editor-issue-button");
    await waitFor(() => Str.includes("Please try again")(root.container().textContent ?? ""));

    await root.render(null);
    await show(<DocumentEditorScreen mode="edit" documentId={DOC_ID} />);
    await waitFor(editorReady);
    await click("editor-issue-button");
    await waitFor(
      () => Arr.some(replaced, (href) => Str.includes(DOC_ID)(href)),
      "retried after reopening",
    );

    expect(
      Arr.map(
        Arr.filter(calls, (c) => c.method === "PATCH"),
        (c) => c.ifMatch,
      ),
    ).toEqual(['"3"']);
    const attempts = Arr.filter(calls, (c) => c.path === path);
    expect(Arr.map(attempts, (c) => c.ifMatch)).toEqual(['"4"', '"4"']);
    expect(attempts[1]?.key).toBe(attempts[0]?.key);
    expect(committed.size).toBe(1);
  });

  test("document payment retries keep the key after the response body is lost", async () => {
    dropNext = `/api/v1/workspaces/${WS_ID}/payments`;
    mockParams = { id: DOC_ID, dialog: "payment" };
    await show(<DocumentDetailScreen />);
    await waitFor(
      () => root.container().querySelector('[data-testid="payment-amount-input"]') !== null,
    );
    await act(() => {
      const amount = root.container().querySelector('[data-testid="payment-amount-input"]');
      reactEventHandler(
        amount,
        "onChange",
      )({
        target: { value: "100" },
      });
    });
    await click("payment-modal-submit");
    await waitFor(
      () => Arr.some(overlay.toasts, (message) => Str.includes("Please try again")(message)),
      "first payment response lost",
    );
    await click("payment-modal-submit");
    await waitFor(() => overlay.toasts.includes("Payment recorded"), "payment retry confirmed");

    const attempts = Arr.filter(
      calls,
      (c) => c.method === "POST" && Str.endsWith("/payments")(c.path),
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.key).toBeTruthy();
    expect(attempts[1]?.key).toBe(attempts[0]?.key);
    expect(attempts[1]?.body).toEqual(attempts[0]?.body);
  });

  test("a new payment gets its own key when its details match an earlier ambiguous write", async () => {
    const path = `/api/v1/workspaces/${WS_ID}/payments`;
    dropNext = path;
    mockParams = { id: DOC_ID, tab: "payments", dialog: "payment" };
    const paymentReady = () =>
      root.container().querySelector('[data-testid="payment-amount-input"]') !== null &&
      Str.includes("Wire")(root.container().textContent ?? "");

    await show(<DocumentDetailScreen />);
    await waitFor(paymentReady);
    await change("payment-amount-input", "100");
    await click("payment-modal-submit");
    await waitFor(() =>
      Arr.some(overlay.toasts, (message) => Str.includes("Please try again")(message)),
    );

    await change("payment-amount-input", "200");
    await click("payment-modal-submit");
    await waitFor(() => overlay.toasts.includes("Payment recorded"));
    await waitFor(paymentReady);
    await settle();
    await click("payments-tab-record");
    await waitFor(paymentReady);
    dropNext = path;
    await change("payment-amount-input", "100");
    await click("payment-modal-submit");
    await waitFor(
      () =>
        Arr.filter(overlay.toasts, (message) => Str.includes("Please try again")(message))
          .length === 2,
    );

    await root.render(null);
    await show(<DocumentDetailScreen />);
    await waitFor(paymentReady);
    await change("payment-amount-input", "100");
    await click("payment-modal-submit");
    await waitFor(
      () => Arr.filter(overlay.toasts, (message) => message === "Payment recorded").length === 2,
    );

    const attempts = Arr.filter(
      calls,
      (c) => c.method === "POST" && Str.endsWith("/payments")(c.path),
    );
    expect(attempts).toHaveLength(4);
    expect(attempts[2]?.body).toEqual(attempts[0]?.body);
    expect(attempts[3]?.body).toEqual(attempts[2]?.body);
    expect(attempts[3]?.key).toBe(attempts[2]?.key);
    expect(new Set(Arr.map(attempts, ({ key }) => key)).size).toBe(3);
  });

  test("a replayed template import opens the created draft's effective fields", async () => {
    const path = `/api/v1/workspaces/${WS_ID}/templates/${TEMPLATE_ID}/documents`;
    dropNext = path;
    wireDoc = makeWireDoc({
      status: "draft",
      kind: "invoice",
      number: null,
      settlement: "unpaid",
    });
    mockParams = { kind: "invoice", template: TEMPLATE_ID };
    await show(<DocumentNewRoute />);
    await waitFor(
      () => root.container().querySelector('[data-testid="template-import-retry"]') !== null,
    );
    await root.render(null);
    await show(<DocumentNewRoute />);
    await waitFor(() => replaced.length === 1, "template draft opened");
    const attempts = Arr.filter(calls, (call) => call.path === path);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.body).toEqual({
      as: "draft",
      patch: {
        contact: CON_ID,
        language: "en",
        series: CONTACT_SERIES,
        note: "Imported template note",
        pricesIncludeVat: true,
      },
    });
    expect(attempts[0]?.key).toBeTruthy();
    expect(attempts[1]?.key).toBe(attempts[0]?.key);
    expect(attempts[1]?.body).toEqual(attempts[0]?.body);
    expect(replaced[0]).toBe(`/w/${WS_SLUG}/documents/${DOC_ID}/edit`);

    mockParams = { id: DOC_ID };
    await show(<DocumentEditRoute />);
    await waitFor(
      () =>
        root.container().querySelector<HTMLInputElement>('[data-testid="editor-note"]')?.value ===
        "Imported template note",
      "template note loaded",
    );
    const line = root
      .container()
      .querySelector<HTMLInputElement>('[data-testid="editor-line-desc-0"]');
    expect(line?.value).toBe("Development sprint");
    expect(
      Arr.filter(
        calls,
        (call) => call.method === "GET" && Str.endsWith(`/templates/${TEMPLATE_ID}`)(call.path),
      ),
    ).toHaveLength(1);
    await change("editor-line-desc-0", "Edited development sprint");
    await click("editor-save-button");
    await waitFor(() => Arr.some(calls, (call) => call.method === "PATCH"), "template draft saved");
    expect(
      Option.getOrUndefined(Arr.findFirst(calls, (call) => call.method === "PATCH"))?.body,
    ).toEqual({
      lines: [expect.objectContaining({ description: "Edited development sprint" })],
    });
    expect(templateTerms).toEqual({
      language: "en",
      series: CONTACT_SERIES,
      pricesIncludeVat: true,
    });
  });
  const paymentPath = `/api/v1/workspaces/${WS_ID}/payments`;
  const paymentAttempts = () =>
    Arr.filter(calls, (c) => c.method === "POST" && Str.endsWith("/payments")(c.path));
  const paymentReady = () =>
    root.container().querySelector('[data-testid="payment-amount-input"]') !== null &&
    Str.includes("Wire")(root.container().textContent ?? "");
  const lostToasts = () =>
    Arr.filter(overlay.toasts, (m) => Str.includes("Please try again")(m)).length;
  const recordedToasts = () => Arr.filter(overlay.toasts, (m) => m === "Payment recorded").length;
  // Let reloads started by the previous screen settle before it unmounts.
  const settle = () =>
    act(async () => {
      await Effect.runPromise(Effect.sleep(25));
    });
  const openPaymentForm = async () => {
    await settle();
    await root.render(null);
    await show(<DocumentDetailScreen />);
    await waitFor(paymentReady, "payment form open");
  };
  const submitPayment = async (amount: string) => {
    await change("payment-amount-input", amount);
    await click("payment-modal-submit");
  };

  test("a reopened payment form retries an unresolved payment with its exact key", async () => {
    mockParams = { id: DOC_ID, tab: "payments", dialog: "payment" };
    dropNext = paymentPath;
    await openPaymentForm();
    await submitPayment("100");
    await waitFor(() => lostToasts() === 1, "first response lost");

    await openPaymentForm();
    await submitPayment("100");
    await waitFor(() => recordedToasts() === 1, "retry after reopening confirmed");

    const attempts = paymentAttempts();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.body).toEqual(attempts[0]?.body);
    expect(attempts[1]?.key).toBe(attempts[0]?.key);
  });

  test("a payment form reopened after a confirmed payment does not reuse an older unresolved key", async () => {
    mockParams = { id: DOC_ID, tab: "payments", dialog: "payment" };
    dropNext = paymentPath;
    await openPaymentForm();
    await submitPayment("100");
    await waitFor(() => lostToasts() === 1, "payment A response lost");
    await submitPayment("200");
    await waitFor(() => recordedToasts() === 1, "payment B confirmed");

    await openPaymentForm();
    await submitPayment("100");
    await waitFor(() => recordedToasts() === 2, "new payment confirmed");

    const attempts = paymentAttempts();
    expect(attempts).toHaveLength(3);
    expect(attempts[2]?.body).toEqual(attempts[0]?.body);
    expect(new Set(Arr.map(attempts, ({ key }) => key)).size).toBe(3);
  });

  test("a confirmed payment keeps its key when the next form scope cannot be stored", async () => {
    mockParams = { id: DOC_ID, tab: "payments", dialog: "payment" };
    const setItem = AsyncStorage.setItem;
    let failScope = true;
    AsyncStorage.setItem = (slot: string, value: string) => {
      if (failScope && Str.startsWith("kvitbit.payment-form.v1.")(slot)) {
        failScope = false;
        return Promise.reject(new Error("storage full"));
      }
      return setItem(slot, value);
    };
    try {
      await openPaymentForm();
      await submitPayment("300");
      // The payment committed, but the client could not record that. It reports an unknown outcome.
      await waitFor(
        () => overlay.toasts.includes("You are offline."),
        "scope commit failure reported",
      );
      await openPaymentForm();
      await submitPayment("300");
      await waitFor(() => recordedToasts() === 1, "replayed payment confirmed");
      await openPaymentForm();
      await submitPayment("300");
      await waitFor(() => recordedToasts() === 2, "next payment confirmed");
    } finally {
      AsyncStorage.setItem = setItem;
    }

    const attempts = paymentAttempts();
    expect(attempts).toHaveLength(3);
    expect(attempts[1]?.key).toBe(attempts[0]?.key);
    expect(attempts[2]?.key).not.toBe(attempts[0]?.key);
  });

  test("an unresolved payment past the replay window asks for reconciliation instead of resending", async () => {
    mockParams = { id: DOC_ID, tab: "payments", dialog: "payment" };
    dropNext = paymentPath;
    await openPaymentForm();
    await submitPayment("400");
    await waitFor(() => lostToasts() === 1, "payment response lost");
    DateTime.now.pipe(
      Effect.map(DateTime.add({ hours: 25 })),
      Effect.map(DateTime.toDateUtc),
      Effect.runSync,
      setSystemTime,
    );
    try {
      await submitPayment("400");
      await waitFor(
        () => Arr.some(overlay.toasts, (m) => Str.includes("may already have been saved")(m)),
        "reconciliation shown",
      );
    } finally {
      setSystemTime();
    }
    expect(paymentAttempts()).toHaveLength(1);
  });

  const importTemplateDraft = async () => {
    wireDoc = makeWireDoc({ status: "draft", kind: "invoice", number: null, settlement: "unpaid" });
    mockParams = { kind: "invoice", template: TEMPLATE_ID };
    await show(<DocumentNewRoute />);
    await waitFor(() => replaced.length === 1, "template draft opened");
    mockParams = { id: DOC_ID };
  };
  const noteValue = () =>
    root.container().querySelector<HTMLInputElement>('[data-testid="editor-note"]')?.value;
  const openEditor = async () => {
    await settle();
    await root.render(null);
    await show(<DocumentEditRoute />);
    await waitFor(
      () => root.container().querySelector('[data-testid="editor-save-button"]') !== null,
      "editor open",
    );
  };
  const saveEdit = async (description: string) => {
    const before = Arr.filter(calls, (call) => call.method === "PATCH").length;
    replaced.length = 0;
    await change("editor-line-desc-0", description);
    await click("editor-save-button");
    await waitFor(() => replaced.length === 1, "saved");
    const writes = Arr.filter(calls, (call) => call.method === "PATCH");
    if (writes.length !== before + 1) {
      throw new Error(`Expected one document write, got ${writes.length - before}`);
    }
    return writes.at(-1);
  };

  test("imported template fields survive saving and reopening the draft", async () => {
    await importTemplateDraft();
    await openEditor();
    await waitFor(() => noteValue() === "Newer template note", "imported note loaded");
    await change("editor-note", "Edited note");
    const first = await saveEdit("First edit");
    expect(first?.ifMatch).toBe('"3"');
    expect(first?.body).toMatchObject({ note: "Edited note" });

    await openEditor();
    await waitFor(() => noteValue() === "Edited note", "saved note reopened");
    const second = await saveEdit("Second edit");
    expect(second?.ifMatch).toBe('"4"');
    expect(second?.body).toEqual({
      lines: [expect.objectContaining({ description: "Second edit" })],
    });
    expect(templateTerms).toEqual({
      language: "en",
      series: CONTACT_SERIES,
      pricesIncludeVat: true,
    });
  });

  test("a revision this client did not write does not reuse the imported snapshot", async () => {
    await importTemplateDraft();
    wireDoc = { ...wireDoc, revision: wireDoc.revision + 1 };
    await show(<DocumentEditRoute />);
    await waitFor(() => Str.includes("Editing is paused")(root.container().textContent ?? ""));
    expect(noteValue()).toBeUndefined();
    expect(root.container().querySelector('[data-testid="editor-save-button"]')).toBeNull();
    expect(Arr.filter(calls, (call) => call.method === "PATCH")).toHaveLength(0);
  });

  test("an acknowledged template draft edit recovers after its snapshot write fails", async () => {
    await importTemplateDraft();
    await openEditor();
    await change("editor-note", "Recover this edited note");
    replaced.length = 0;
    const setItem = AsyncStorage.setItem.bind(AsyncStorage);
    const storage = spyOn(AsyncStorage, "setItem").mockImplementation(async (key, value) => {
      if (Str.startsWith("kvitbit.template-draft.v1.")(key))
        throw new Error("Test storage is full");
      await setItem(key, value);
    });
    try {
      await click("editor-save-button");
      await waitFor(
        () => Str.includes("The document was saved, but")(root.container().textContent ?? ""),
        "local checkpoint failure shown",
      );
      expect(wireDoc.revision).toBe(4);
      expect(replaced).toHaveLength(0);
      expect(root.container().querySelector('[data-testid="editor-save-button"]')).toBeNull();
      await click("editor-template-checkpoint-retry");
      expect(Arr.filter(calls, (call) => call.method === "PATCH")).toHaveLength(1);
    } finally {
      storage.mockRestore();
    }

    await openEditor();
    expect(noteValue()).toBe("Recover this edited note");
    const second = await saveEdit("Update just the description");
    expect(second?.ifMatch).toBe('"4"');
    expect(second?.body).toEqual({
      lines: [expect.objectContaining({ description: "Update just the description" })],
    });
    expect(templateTerms).toEqual({
      language: "en",
      series: CONTACT_SERIES,
      pricesIncludeVat: true,
    });
  });

  test("an editor refresh cannot submit a template draft against an unrelated newer revision", async () => {
    await importTemplateDraft();
    const fxResponse = Promise.withResolvers<void>();
    holdFxResponse = fxResponse.promise;
    try {
      await openEditor();
      await waitFor(() => holdFxResponse === null, "old session's FX request is in flight");
      await change("editor-line-desc-0", "Local edit before refresh");
      wireDoc = { ...wireDoc, revision: wireDoc.revision + 1 };
      const reads = () =>
        Arr.filter(
          calls,
          (call) => call.method === "GET" && Str.endsWith(`/documents/${DOC_ID}`)(call.path),
        ).length;
      const before = reads();
      await show(<DocumentEditRoute />, "refreshed");
      await waitFor(() => reads() > before, "document reloaded");
      await settle();
      await click("editor-save-button");
      await waitFor(() =>
        Str.includes("changed while you were editing")(root.container().textContent ?? ""),
      );
      expect(Arr.filter(calls, (call) => call.method === "PATCH")).toHaveLength(0);
    } finally {
      fxResponse.resolve();
    }
  });

  test("issuing an imported draft from detail carries its known template settings forward", async () => {
    await importTemplateDraft();
    await openEditor();
    await show(<DocumentDetailScreen />);
    await waitFor(
      () => root.container().querySelector('[data-testid="detail-action-issue"]') !== null,
    );
    await click("detail-action-issue");
    await waitFor(() => Arr.some(overlay.toasts, (message) => Str.includes("2026-0099")(message)));
    await openEditor();
    expect(noteValue()).toBe("Newer template note");
  });

  test("an expired template import starts fresh only after explicit reconciliation confirmation", async () => {
    const path = `/api/v1/workspaces/${WS_ID}/templates/${TEMPLATE_ID}/documents`;
    const recoveredId = DocumentId.make("01930000-0000-7000-8000-000000000199");
    dropNext = path;
    wireDoc = makeWireDoc({
      id: recoveredId,
      status: "draft",
      kind: "invoice",
      number: null,
      settlement: "unpaid",
    });
    mockParams = { kind: "invoice", template: TEMPLATE_ID };
    await show(<DocumentNewRoute />);
    await waitFor(
      () => root.container().querySelector('[data-testid="template-import-retry"]') !== null,
    );
    DateTime.now.pipe(
      Effect.map(DateTime.add({ hours: 25 })),
      Effect.map(DateTime.toDateUtc),
      Effect.runSync,
      setSystemTime,
    );
    try {
      await root.render(null);
      await show(<DocumentNewRoute />);
      await waitFor(
        () => Str.includes("may already have been saved")(root.container().textContent ?? ""),
        "reconciliation shown",
      );
      expect(root.container().querySelector('[data-testid="template-import-retry"]')).toBeNull();
      expect(Arr.filter(calls, (call) => call.path === path)).toHaveLength(1);
      expect(replaced).toHaveLength(0);

      await click("template-import-review-documents");
      expect(replaced).toHaveLength(1);
      expect(templateTerms).toEqual({
        language: "en",
        series: CONTACT_SERIES,
        pricesIncludeVat: true,
      });
      mockParams = { id: recoveredId };
      await openEditor();
      expect(root.container().textContent).toContain("Some saved settings are unavailable");
      expect(root.container().querySelector('[data-testid="editor-preview-total"]')).toBeNull();
      const edit = await saveEdit("Change only the description");
      expect(edit?.ifMatch).toBe('"3"');
      expect(edit?.body).toEqual({
        lines: [expect.objectContaining({ description: "Change only the description" })],
      });
      expect(templateTerms).toEqual({
        language: "en",
        series: CONTACT_SERIES,
        pricesIncludeVat: true,
      });

      mockParams = { kind: "invoice", template: TEMPLATE_ID };
      replaced.length = 0;
      await root.render(null);
      await show(<DocumentNewRoute />);
      await waitFor(
        () => root.container().querySelector('[data-testid="template-import-start-new"]') !== null,
        "reconciliation remains available after viewing documents",
      );

      overlay.answer = false;
      await click("template-import-start-new");
      expect(Arr.filter(calls, (call) => call.path === path)).toHaveLength(1);

      wireDoc = { ...wireDoc, id: FINAL_ID, revision: 1 };
      overlay.answer = true;
      await click("template-import-start-new");
      await waitFor(() => replaced.length === 1, "new import opens its draft");
      const attempts = Arr.filter(calls, (call) => call.path === path);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]?.key).not.toBe(attempts[0]?.key);
      expect(attempts[1]?.body).toMatchObject({ patch: { note: "Newer template note" } });
      expect(replaced[0]).toBe(`/w/${WS_SLUG}/documents/${FINAL_ID}/edit`);
    } finally {
      setSystemTime();
    }
  });
});
