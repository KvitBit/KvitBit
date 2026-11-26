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
import type {
  ContactId,
  DocumentId,
  WorkspaceId,
  WorkspaceSlug,
  WorkspaceSummary,
} from "@kvitbit/domain/contract";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, type ReactNode } from "react";
import {
  fakeTransfer,
  useFakeTransfer as registerFakeTransfer,
} from "../../platform/transfer/testing";
import { ApiProvider } from "../../runtime/api-runtime";
import { SessionProvider, useSession } from "../../session/session-provider";
import { tokenStore } from "../../session/token-store";
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
const { default: DocumentNewRoute } = await import("../../../app/w/[ws]/documents/new/[kind]");
const { default: DocumentEditRoute } = await import("../../../app/w/[ws]/documents/[id]/edit");

function SignedInFixture({ children }: { readonly children: ReactNode }) {
  return useSession().state.status === "signed-in" ? children : null;
}

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
  let calls: Array<{
    method: string;
    path: string;
    body?: unknown;
    key: string | null;
    ifMatch: string | null;
  }> = [];
  let dropNext: string | null = null;
  let dropIssueBeforeCommit = false;
  let committed: Map<string, ReturnType<typeof makeWireDoc>>;

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

        if (url.pathname.endsWith("/get-session")) {
          return Response.json({
            user: { id: "documents-test-user", email: "documents@example.test" },
          });
        }

        if (req.method === "GET" && url.pathname.endsWith(`/documents/${DOC_ID}`)) {
          return Response.json(wireDoc);
        }
        if (req.method === "PATCH" && url.pathname.endsWith(`/documents/${DOC_ID}`)) {
          if (req.headers.get("If-Match") !== `"${wireDoc.revision}"`) {
            return new Response(null, { status: 412 });
          }
          wireDoc = { ...wireDoc, revision: wireDoc.revision + 1 };
          return Response.json(wireDoc);
        }
        if (req.method === "POST" && url.pathname.endsWith("/issue") && key !== null) {
          const earlier = committed.get(key);
          if (earlier !== undefined)
            return Response.json(earlier, {
              status: url.pathname.endsWith(`/documents/${DOC_ID}/issue`) ? 200 : 201,
            });
          const fromDraft = url.pathname.endsWith(`/documents/${DOC_ID}/issue`);
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
        if (req.method === "POST" && url.pathname.endsWith(`/templates/${TEMPLATE_ID}/documents`)) {
          if (dropNext === url.pathname) {
            dropNext = null;
            return new Response("{", {
              status: 201,
              headers: { "content-type": "application/json" },
            });
          }
          return Response.json(wireDoc, { status: 201 });
        }
        if (req.method === "GET" && url.pathname.endsWith(`/templates/${TEMPLATE_ID}`)) {
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
        if (req.method === "GET" && url.pathname.endsWith(`/contacts/${CON_ID}`)) {
          return Response.json({
            id: CON_ID,
            name: "Beta s.r.o.",
            archived: false,
            revision: 1,
            defaults: { language: "en", preferredSeriesByKind: { invoice: CONTACT_SERIES } },
          });
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
        if (req.method === "POST" && url.pathname.endsWith("/payments")) {
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
    await tokenStore.clear();
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
    wireDoc = makeWireDoc();
    mockParams = { id: DOC_ID };
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
    act(async () => {
      (
        reactPropsOf(root.container().querySelector(`[data-testid="${testId}"]`))
          .onClick as () => void
      )();
    });

  const change = (testId: string, value: string) =>
    act(async () => {
      const input = root.container().querySelector(`[data-testid="${testId}"]`);
      (reactPropsOf(input).onChange as (event: { target: { value: string } }) => void)({
        target: { value },
      });
    });

  test("detail screen renders VAT/CZK breakdown, chain links, PDF transfer and final invoice", async () => {
    await show(<DocumentDetailScreen />);

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
    await show(<DocumentDetailScreen />);

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
    await show(<DocumentEditorScreen mode="new" kind="invoice" contactId={CON_ID} />);

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

  test("retries a committed issue-from-input with the same key after the response is lost", async () => {
    const path = `/api/v1/workspaces/${WS_ID}/documents/issue`;
    dropNext = path;
    await show(<DocumentEditorScreen mode="new" kind="invoice" contactId={CON_ID} />);
    await waitFor(
      () => root.container().querySelector('[data-testid="editor-line-desc-0"]') !== null,
    );
    await act(async () => {
      for (const [testId, value] of [
        ["editor-line-desc-0", "Audit work"],
        ["editor-line-price-0", "1000"],
      ] as const) {
        const input = root.container().querySelector(`[data-testid="${testId}"]`);
        (reactPropsOf(input).onChange as (event: { target: { value: string } }) => void)({
          target: { value },
        });
      }
    });
    await click("editor-issue-button");
    await waitFor(
      () =>
        calls.some((c) => c.path === path) &&
        root.container().textContent?.includes("Please try again") === true,
      "failed issue response",
    );
    expect(replaced).toEqual([]);
    await click("editor-issue-button");
    await waitFor(() => replaced.some((href) => href.includes(FINAL_ID)), "retried issue");

    const attempts = calls.filter((c) => c.path === path);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.key).toMatch(/^[0-9a-f-]{14}7[0-9a-f-]{21}$/);
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
        calls.some((c) => c.path === path) &&
        root.container().textContent?.includes("Please try again") === true,
      "failed issue after PATCH",
    );
    await click("editor-issue-button");
    await waitFor(() => replaced.some((href) => href.includes(DOC_ID)), "retried draft issue");

    const edits = calls.filter((c) => c.method === "PATCH");
    expect(edits).toHaveLength(1);
    expect(edits[0]?.ifMatch).toBe('"3"');
    const attempts = calls.filter((c) => c.path === path);
    expect(attempts.map((c) => c.ifMatch)).toEqual(['"4"', '"4"']);
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
    await waitFor(() => root.container().textContent?.includes("Please try again") === true);

    await root.render(null);
    await show(<DocumentEditorScreen mode="edit" documentId={DOC_ID} />);
    await waitFor(editorReady);
    await click("editor-issue-button");
    await waitFor(() => replaced.some((href) => href.includes(DOC_ID)), "retried after reopening");

    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.ifMatch)).toEqual(['"3"']);
    const attempts = calls.filter((c) => c.path === path);
    expect(attempts.map((c) => c.ifMatch)).toEqual(['"4"', '"4"']);
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
    await act(async () => {
      const amount = root.container().querySelector('[data-testid="payment-amount-input"]');
      (reactPropsOf(amount).onChange as (event: { target: { value: string } }) => void)({
        target: { value: "100" },
      });
    });
    await click("payment-modal-submit");
    await waitFor(
      () => overlay.toasts.some((message) => message.includes("Please try again")),
      "first payment response lost",
    );
    await click("payment-modal-submit");
    await waitFor(() => overlay.toasts.includes("Payment recorded"), "payment retry confirmed");

    const attempts = calls.filter((c) => c.method === "POST" && c.path.endsWith("/payments"));
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
      root.container().textContent?.includes("Wire") === true;

    await show(<DocumentDetailScreen />);
    await waitFor(paymentReady);
    await change("payment-amount-input", "100");
    await click("payment-modal-submit");
    await waitFor(() => overlay.toasts.some((message) => message.includes("Please try again")));

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
      () => overlay.toasts.filter((message) => message.includes("Please try again")).length === 2,
    );

    await root.render(null);
    await show(<DocumentDetailScreen />);
    await waitFor(paymentReady);
    await change("payment-amount-input", "100");
    await click("payment-modal-submit");
    await waitFor(
      () => overlay.toasts.filter((message) => message === "Payment recorded").length === 2,
    );

    const attempts = calls.filter((c) => c.method === "POST" && c.path.endsWith("/payments"));
    expect(attempts).toHaveLength(4);
    expect(attempts[2]?.body).toEqual(attempts[0]?.body);
    expect(attempts[3]?.body).toEqual(attempts[2]?.body);
    expect(attempts[3]?.key).toBe(attempts[2]?.key);
    expect(new Set(attempts.map(({ key }) => key)).size).toBe(3);
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
    const attempts = calls.filter((call) => call.path === path);
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
      calls.filter(
        ({ method, path }) => method === "GET" && path.endsWith(`/templates/${TEMPLATE_ID}`),
      ),
    ).toHaveLength(1);
    await change("editor-line-desc-0", "Edited development sprint");
    await click("editor-save-button");
    await waitFor(() => calls.some((call) => call.method === "PATCH"), "template draft saved");
    expect(calls.find((call) => call.method === "PATCH")?.body).toMatchObject({
      note: "Imported template note",
      language: "en",
      series: CONTACT_SERIES,
      pricesIncludeVat: true,
    });
  });
  const paymentPath = `/api/v1/workspaces/${WS_ID}/payments`;
  const paymentAttempts = () =>
    calls.filter((c) => c.method === "POST" && c.path.endsWith("/payments"));
  const paymentReady = () =>
    root.container().querySelector('[data-testid="payment-amount-input"]') !== null &&
    root.container().textContent?.includes("Wire") === true;
  const lostToasts = () => overlay.toasts.filter((m) => m.includes("Please try again")).length;
  const recordedToasts = () => overlay.toasts.filter((m) => m === "Payment recorded").length;
  // Let reloads started by the previous screen settle before it unmounts.
  const settle = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 25));
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
    expect(new Set(attempts.map(({ key }) => key)).size).toBe(3);
  });

  test("a confirmed payment keeps its key when the next form scope cannot be stored", async () => {
    mockParams = { id: DOC_ID, tab: "payments", dialog: "payment" };
    const setItem = AsyncStorage.setItem;
    let failScope = true;
    AsyncStorage.setItem = async (slot: string, value: string) => {
      if (failScope && slot.startsWith("kvitbit.payment-form.v1.")) {
        failScope = false;
        throw new Error("storage full");
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
    setSystemTime(new Date(Date.now() + 25 * 60 * 60 * 1000));
    try {
      await submitPayment("400");
      await waitFor(
        () => overlay.toasts.some((m) => m.includes("may already have been saved")),
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
    const before = calls.filter((call) => call.method === "PATCH").length;
    replaced.length = 0;
    await change("editor-line-desc-0", description);
    await click("editor-save-button");
    await waitFor(() => replaced.length === 1, "saved");
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(before + 1);
    return calls.filter((call) => call.method === "PATCH").at(-1);
  };

  test("imported template fields survive saving and reopening the draft", async () => {
    await importTemplateDraft();
    await openEditor();
    await waitFor(() => noteValue() === "Newer template note", "imported note loaded");
    await change("editor-note", "Edited note");
    const first = await saveEdit("First edit");
    expect(first?.ifMatch).toBe('"3"');

    await openEditor();
    await waitFor(() => noteValue() === "Edited note", "saved note reopened");
    const second = await saveEdit("Second edit");
    expect(second?.ifMatch).toBe('"4"');
    expect(second?.body).toMatchObject({
      note: "Edited note",
      language: "en",
      series: CONTACT_SERIES,
      pricesIncludeVat: true,
    });
  });

  test("a revision this client did not write does not reuse the imported snapshot", async () => {
    await importTemplateDraft();
    wireDoc = { ...wireDoc, revision: wireDoc.revision + 1 };
    await show(<DocumentEditRoute />);
    await waitFor(() => root.container().textContent?.includes("Editing is paused") === true);
    expect(noteValue()).toBeUndefined();
    expect(root.container().querySelector('[data-testid="editor-save-button"]')).toBeNull();
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
  });

  test("an acknowledged template draft edit recovers after its snapshot write fails", async () => {
    await importTemplateDraft();
    await openEditor();
    await change("editor-note", "Recover this edited note");
    replaced.length = 0;
    const setItem = AsyncStorage.setItem.bind(AsyncStorage);
    const storage = spyOn(AsyncStorage, "setItem").mockImplementation(async (key, value) => {
      if (key.startsWith("kvitbit.template-draft.v1.")) throw new Error("Test storage is full");
      await setItem(key, value);
    });
    try {
      await click("editor-save-button");
      await waitFor(
        () => root.container().textContent?.includes("The document was saved, but") === true,
        "local checkpoint failure shown",
      );
      expect(wireDoc.revision).toBe(4);
      expect(replaced).toHaveLength(0);
      expect(root.container().querySelector('[data-testid="editor-save-button"]')).toBeNull();
      await click("editor-template-checkpoint-retry");
      expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
    } finally {
      storage.mockRestore();
    }

    await openEditor();
    expect(noteValue()).toBe("Recover this edited note");
    const second = await saveEdit("Update just the description");
    expect(second?.ifMatch).toBe('"4"');
    expect(second?.body).toMatchObject({
      note: "Recover this edited note",
      language: "en",
      series: CONTACT_SERIES,
      pricesIncludeVat: true,
    });
  });

  test("an editor refresh cannot submit a template draft against an unrelated newer revision", async () => {
    await importTemplateDraft();
    await openEditor();
    await change("editor-line-desc-0", "Local edit before refresh");
    wireDoc = { ...wireDoc, revision: wireDoc.revision + 1 };
    const reads = () =>
      calls.filter((call) => call.method === "GET" && call.path.endsWith(`/documents/${DOC_ID}`))
        .length;
    const before = reads();
    await show(<DocumentEditRoute />, "refreshed");
    await waitFor(() => reads() > before, "document reloaded");
    await settle();
    await click("editor-save-button");
    await waitFor(
      () => root.container().textContent?.includes("changed while you were editing") === true,
    );
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
  });

  test("issuing an imported draft from detail carries its known template settings forward", async () => {
    await importTemplateDraft();
    await openEditor();
    await show(<DocumentDetailScreen />);
    await waitFor(
      () => root.container().querySelector('[data-testid="detail-action-issue"]') !== null,
    );
    await click("detail-action-issue");
    await waitFor(() => overlay.toasts.some((message) => message.includes("2026-0099")));
    await openEditor();
    expect(noteValue()).toBe("Newer template note");
  });

  test("an expired template import starts fresh only after explicit reconciliation confirmation", async () => {
    const path = `/api/v1/workspaces/${WS_ID}/templates/${TEMPLATE_ID}/documents`;
    dropNext = path;
    wireDoc = makeWireDoc({ status: "draft", kind: "invoice", number: null, settlement: "unpaid" });
    mockParams = { kind: "invoice", template: TEMPLATE_ID };
    await show(<DocumentNewRoute />);
    await waitFor(
      () => root.container().querySelector('[data-testid="template-import-retry"]') !== null,
    );
    setSystemTime(new Date(Date.now() + 25 * 60 * 60 * 1000));
    try {
      await root.render(null);
      await show(<DocumentNewRoute />);
      await waitFor(
        () => root.container().textContent?.includes("may already have been saved") === true,
        "reconciliation shown",
      );
      expect(root.container().querySelector('[data-testid="template-import-retry"]')).toBeNull();
      expect(calls.filter((call) => call.path === path)).toHaveLength(1);
      expect(replaced).toHaveLength(0);

      await click("template-import-review-documents");
      expect(replaced).toHaveLength(1);
      replaced.length = 0;
      await root.render(null);
      await show(<DocumentNewRoute />);
      await waitFor(
        () => root.container().querySelector('[data-testid="template-import-start-new"]') !== null,
        "reconciliation remains available after viewing documents",
      );

      overlay.answer = false;
      await click("template-import-start-new");
      expect(calls.filter((call) => call.path === path)).toHaveLength(1);

      overlay.answer = true;
      await click("template-import-start-new");
      await waitFor(() => replaced.length === 1, "new import opens its draft");
      const attempts = calls.filter((call) => call.path === path);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]?.key).not.toBe(attempts[0]?.key);
      expect(attempts[1]?.body).toMatchObject({ patch: { note: "Newer template note" } });
    } finally {
      setSystemTime();
    }
  });
});
