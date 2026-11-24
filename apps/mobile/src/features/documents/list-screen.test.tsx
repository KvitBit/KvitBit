import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { WorkspaceId, WorkspaceSlug, WorkspaceSummary } from "@kvitbit/domain/contract";
import { act } from "react";
import { ApiProvider } from "../../runtime/api-runtime";
import { clientRoot } from "../../testing/client-root";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import { recordedOverlay, TestProviders } from "../../testing/providers";
import { WorkspaceProvider } from "../../workspace/workspace-provider";
import { uiShim } from "./test-ui-shim";

const pushed: string[] = [];
const replaced: string[] = [];
let mockParams: Record<string, string> = {};
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

const realUi = { ...(await import("../../ui")) };
const { DocumentsListScreen } = await import("./list-screen");

const reactPropsOf = (el: Element | null): Record<string, unknown> => {
  if (el === null) throw new Error("Element not found");
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  if (key === undefined) throw new Error("React props not found on element");
  const record = (el as unknown as Record<string, Record<string, unknown>>)[key];
  if (record === undefined) throw new Error("React props object missing");
  return record;
};

const waitFor = async (check: () => boolean, label = "condition"): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const WS_ID = "01930000-0000-7000-8000-000000000001" as WorkspaceId;
const WS_SLUG = "acme" as WorkspaceSlug;

const makeWorkspace = (role: WorkspaceSummary["role"] = "member"): WorkspaceSummary => ({
  id: WS_ID,
  slug: WS_SLUG,
  name: "Acme s.r.o.",
  role,
  memberCount: 2,
  taxRegime: "vat_payer",
  closed: false,
});

describe("DocumentsListScreen", () => {
  const root = clientRoot({ keepFetch: true });
  let server: ReturnType<typeof Bun.serve>;
  let requests: string[] = [];
  let listItems: unknown[] = [];

  beforeAll(() => {
    mock.module("../../ui", () => uiShim);
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        requests.push(`${req.method} ${url.pathname}${url.search}`);
        if (url.pathname.endsWith("/documents")) {
          return Response.json({ items: listItems, nextCursor: null });
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
    overlay.toasts.length = 0;
    requests = [];
    mockParams = {};
    listItems = [
      {
        id: "01930000-0000-7000-8000-000000000101",
        kind: "invoice",
        number: "2026-0001",
        status: "issued",
        locked: false,
        settlement: "unpaid",
        overdue: true,
        revision: 1,
        contact: { id: "01930000-0000-7000-8000-000000000201", name: "Beta s.r.o." },
        issuedOn: "2026-10-01",
        dueOn: "2026-10-15",
        total: { amount: "12100.00", currency: "CZK" },
      },
      {
        id: "01930000-0000-7000-8000-000000000102",
        kind: "proforma",
        number: null,
        status: "draft",
        locked: false,
        settlement: "unpaid",
        overdue: false,
        revision: 1,
        contact: { id: "01930000-0000-7000-8000-000000000202", name: "Gamma a.s." },
        issuedOn: "2026-11-20",
        dueOn: "2026-12-04",
        total: { amount: "500.00", currency: "EUR" },
      },
    ];
  });

  const renderScreen = (role: WorkspaceSummary["role"] = "member") => {
    const ws = makeWorkspace(role);
    return root.render(
      <TestProviders locale="en" overlay={overlay}>
        <ApiProvider token="test-token" origin={server.url.origin}>
          <WorkspaceProvider workspace={ws} workspaces={[ws]} reload={() => undefined}>
            <DocumentsListScreen />
          </WorkspaceProvider>
        </ApiProvider>
      </TestProviders>,
    );
  };

  test("renders documents with formatted amounts, badges and quick create actions", async () => {
    await renderScreen("member");
    await waitFor(
      () => (root.container().textContent ?? "").includes("2026-0001"),
      "document list loaded",
    );

    const text = root.container().textContent ?? "";
    expect(text).toContain("2026-0001");
    expect(text).toContain("Beta s.r.o.");
    expect(text).toContain("Overdue");
    expect(text).toContain("Draft");
    expect(text).toContain("Gamma a.s.");
    expect(text).toContain("€500.00");

    const createInv = root.container().querySelector('[data-testid="documents-create-invoice"]');
    const createPro = root.container().querySelector('[data-testid="documents-create-proforma"]');
    const createCn = root.container().querySelector('[data-testid="documents-create-credit-note"]');
    await act(async () => {
      (reactPropsOf(createInv).onClick as () => void)();
      (reactPropsOf(createPro).onClick as () => void)();
      (reactPropsOf(createCn).onClick as () => void)();
    });
    expect(pushed).toEqual([
      "/w/acme/documents/new/invoice",
      "/w/acme/documents/new/proforma",
      "/w/acme/documents/new/credit_note",
    ]);
  });

  test("search input refetches with text query param", async () => {
    await renderScreen("member");
    await waitFor(() => requests.length >= 1, "initial request");

    const searchInput = root.container().querySelector('[data-testid="documents-search-input"]');
    await act(async () => {
      (reactPropsOf(searchInput).onChange as (e: { target: { value: string } }) => void)({
        target: { value: "Beta" },
      });
    });

    await waitFor(() => requests.some((r) => r.includes("text=Beta")), "search query request");
    expect(requests.some((r) => r.includes("text=Beta"))).toBe(true);
  });

  test("accountant role sees read-only banner and no quick-create controls", async () => {
    await renderScreen("accountant");
    await waitFor(
      () => (root.container().textContent ?? "").includes("2026-0001"),
      "accountant list loaded",
    );
    expect(root.container().querySelector('[data-testid="documents-create-invoice"]')).toBeNull();
    expect(root.container().textContent ?? "").toContain("not change it");
  });
});
