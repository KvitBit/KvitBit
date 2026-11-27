import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  ContactId,
  IsoDate,
  type WorkspaceId,
  type WorkspaceSlug,
  type WorkspaceSummary,
} from "@kvitbit/domain/contract";
import { Routes } from "@kvitbit/ui-port/view-models";
import { Schema } from "effect";
import { act } from "react";
import { ApiProvider } from "../../runtime/api-runtime";
import { clientRoot } from "../../testing/client-root";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import { recordedOverlay, TestProviders } from "../../testing/providers";
import { WorkspaceProvider } from "../../workspace/workspace-provider";
import { uiShim } from "./test-ui-shim";

const pushed: string[] = [];
const replaced: string[] = [];
let mockParams: Record<string, string | string[]> = {};
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
const { default: DocumentsRoute } = await import("../../../app/w/[ws]/documents/index");

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
const OTHER_WS_ID = "01930000-0000-7000-8000-000000000002" as WorkspaceId;
const OTHER_WS_SLUG = "beta" as WorkspaceSlug;
const FIRST_ROW_ID = "01930000-0000-7000-8000-000000000101";
const SECOND_ROW_ID = "01930000-0000-7000-8000-000000000102";
const SECOND_CONTACT_ID = "01930000-0000-7000-8000-000000000202";

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
  let listItems: Array<{
    id: string;
    contact: { id: string; name: string };
    issuedOn: string;
    [field: string]: unknown;
  }> = [];
  let handleList: ((url: URL) => Promise<Response>) | undefined;

  const row = (id: string) => root.container().querySelector(`[data-testid="document-row-${id}"]`);
  const button = (label: string) =>
    [...root.container().querySelectorAll("button")].find((node) => node.textContent === label);
  const click = (node: HTMLButtonElement | undefined) =>
    act(async () => (reactPropsOf(node ?? null).onClick as () => void)());

  const holdRequests = () => {
    const held: Array<{ url: URL; respond: (response: Response) => void }> = [];
    handleList = (url) => {
      const response = Promise.withResolvers<Response>();
      held.push({ url, respond: response.resolve });
      return response.promise;
    };
    return async (index: number) => {
      await waitFor(() => held[index] !== undefined, `held request ${index}`);
      const request = held[index];
      if (request === undefined) throw new Error(`Missing request ${index}`);
      const send = (response: Response) =>
        act(async () => {
          request.respond(response);
          // Give the loopback HTTP client and React a turn to process even ignored responses.
          await new Promise((resolve) => setTimeout(resolve, 25));
        });
      return {
        url: request.url,
        respond: (items: ReadonlyArray<unknown>, nextCursor: string | null = null) =>
          send(Response.json({ items, nextCursor })),
        fail: () => send(new Response(null, { status: 500 })),
      };
    };
  };

  beforeAll(() => {
    mock.module("../../ui", () => uiShim);
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        requests.push(`${req.method} ${url.pathname}${url.search}`);
        if (url.pathname.endsWith("/documents")) {
          if (handleList !== undefined) return handleList(url);
          const contact = url.searchParams.get("contact");
          const from = url.searchParams.get("from");
          const to = url.searchParams.get("to");
          const items = listItems.filter(
            (item) =>
              (contact === null || item.contact.id === contact) &&
              (from === null || item.issuedOn >= from) &&
              (to === null || item.issuedOn <= to),
          );
          return Response.json({ items, nextCursor: null });
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
    handleList = undefined;
    mockParams = {};
    listItems = [
      {
        id: FIRST_ROW_ID,
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
        id: SECOND_ROW_ID,
        kind: "proforma",
        number: null,
        status: "draft",
        locked: false,
        settlement: "unpaid",
        overdue: false,
        revision: 1,
        contact: { id: SECOND_CONTACT_ID, name: "Gamma a.s." },
        issuedOn: "2026-11-20",
        dueOn: "2026-12-04",
        total: { amount: "500.00", currency: "EUR" },
      },
    ];
  });

  const renderScreen = (ws = makeWorkspace()) => {
    return root.render(
      <TestProviders locale="en" overlay={overlay}>
        <ApiProvider token="test-token" origin={server.url.origin}>
          <WorkspaceProvider workspace={ws} workspaces={[ws]} reload={() => undefined}>
            <DocumentsRoute />
          </WorkspaceProvider>
        </ApiProvider>
      </TestProviders>,
    );
  };

  test("renders documents with formatted amounts, badges and quick create actions", async () => {
    await renderScreen();
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
    await renderScreen();
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

  test("uses all filters from a document route and clears them together", async () => {
    const href = Routes.toPath(
      {
        _tag: "Documents",
        ws: WS_SLUG,
        query: {
          text: "Gamma + Co",
          kind: "proforma",
          status: "draft",
          settlement: "unpaid",
          overdue: false,
          contact: Schema.decodeUnknownSync(ContactId)(SECOND_CONTACT_ID),
          from: Schema.decodeUnknownSync(IsoDate)("2026-11-01"),
          to: Schema.decodeUnknownSync(IsoDate)("2026-11-30"),
        },
      },
      "/",
    );
    mockParams = Object.fromEntries(new URL(href, server.url).searchParams);
    mockParams.contact = [SECOND_CONTACT_ID, "ignored-duplicate"];

    await renderScreen();
    await waitFor(() => row(SECOND_ROW_ID) !== null, "scoped document list");
    expect(row(FIRST_ROW_ID)).toBeNull();
    const query = new URL(requests[0]?.slice(4) ?? "", server.url).searchParams;
    expect(Object.fromEntries(query)).toEqual({
      text: "Gamma + Co",
      kind: "proforma",
      status: "draft",
      settlement: "unpaid",
      overdue: "false",
      contact: SECOND_CONTACT_ID,
      from: "2026-11-01",
      to: "2026-11-30",
      limit: "50",
    });

    await click(button("Clear filters"));
    await waitFor(() => row(FIRST_ROW_ID) !== null, "unfiltered document list");
    const cleared = new URL(requests.at(-1)?.slice(4) ?? "", server.url).searchParams;
    expect(Object.fromEntries(cleared)).toEqual({ limit: "50" });
  });

  test.each(["route query", "workspace"] as const)(
    "a late first page cannot replace results after a %s change",
    async (change) => {
      const request = holdRequests();
      mockParams = { text: "Beta" };
      await renderScreen();
      const earlier = await request(0);

      if (change === "route query") {
        mockParams = { contact: SECOND_CONTACT_ID };
        await renderScreen();
      } else {
        await renderScreen({ ...makeWorkspace(), id: OTHER_WS_ID, slug: OTHER_WS_SLUG });
      }
      const current = await request(1);
      expect(current.url.pathname).toContain(change === "workspace" ? OTHER_WS_ID : WS_ID);
      expect(current.url.searchParams.get("contact")).toBe(
        change === "route query" ? SECOND_CONTACT_ID : null,
      );
      await current.respond(listItems.slice(1));
      await waitFor(() => row(SECOND_ROW_ID) !== null, "new list results");

      await earlier.respond(listItems.slice(0, 1), "old-cursor");
      expect(row(FIRST_ROW_ID)).toBeNull();
      expect(row(SECOND_ROW_ID)).not.toBeNull();
      expect(button("Load more")).toBeUndefined();
    },
  );

  test.each(["filter", "workspace"] as const)(
    "drops a pending continuation when the %s changes",
    async (change) => {
      const request = holdRequests();
      await renderScreen();
      const first = await request(0);
      await first.respond(listItems.slice(0, 1), "old-cursor");
      await waitFor(() => row(FIRST_ROW_ID) !== null, "initial document page");
      await click(button("Load more"));
      const earlier = await request(1);
      expect(earlier.url.searchParams.get("cursor")).toBe("old-cursor");

      if (change === "workspace") {
        await renderScreen({ ...makeWorkspace(), id: OTHER_WS_ID, slug: OTHER_WS_SLUG });
      } else {
        const search = root.container().querySelector('[data-testid="documents-search-input"]');
        await act(async () => {
          (reactPropsOf(search).onChange as (e: { target: { value: string } }) => void)({
            target: { value: "Gamma" },
          });
        });
      }

      expect(row(FIRST_ROW_ID)).toBeNull();
      const current = await request(2);
      expect(current.url.pathname).toContain(change === "workspace" ? OTHER_WS_ID : WS_ID);
      expect(current.url.searchParams.get("text")).toBe(change === "filter" ? "Gamma" : null);
      expect(current.url.searchParams.has("cursor")).toBe(false);
      await current.respond(listItems.slice(1), "current-cursor");
      await waitFor(() => row(SECOND_ROW_ID) !== null, "current document page");
      await click(button("Load more"));
      const next = await request(3);
      expect(next.url.searchParams.get("cursor")).toBe("current-cursor");

      if (change === "workspace") await earlier.fail();
      else await earlier.respond(listItems.slice(0, 1), "stale-cursor");
      expect(button("Load more")?.disabled).toBe(true);
      expect(overlay.toasts).toEqual([]);
      expect(row(FIRST_ROW_ID)).toBeNull();

      await next.respond([]);
      await waitFor(() => button("Load more") === undefined, "current last page");
      expect(row(SECOND_ROW_ID)).not.toBeNull();
    },
  );

  test("a failed current continuation can retry the same cursor", async () => {
    const request = holdRequests();
    await renderScreen();
    const first = await request(0);
    await first.respond(listItems.slice(0, 1), "retry-cursor");
    await waitFor(() => row(FIRST_ROW_ID) !== null, "initial document page");

    await click(button("Load more"));
    const failed = await request(1);
    await failed.fail();
    await waitFor(() => overlay.toasts.length === 1, "load-more error toast");
    expect(row(FIRST_ROW_ID)).not.toBeNull();
    expect(button("Load more")?.disabled).toBe(false);

    await click(button("Load more"));
    const retry = await request(2);
    expect(retry.url.searchParams.get("cursor")).toBe("retry-cursor");
    await retry.respond(listItems.slice(1));
    await waitFor(() => row(SECOND_ROW_ID) !== null, "retried continuation");
    expect(row(FIRST_ROW_ID)).not.toBeNull();
    expect(button("Load more")).toBeUndefined();
  });

  test("accountant role sees read-only banner and no quick-create controls", async () => {
    await renderScreen(makeWorkspace("accountant"));
    await waitFor(
      () => (root.container().textContent ?? "").includes("2026-0001"),
      "accountant list loaded",
    );
    expect(root.container().querySelector('[data-testid="documents-create-invoice"]')).toBeNull();
    expect(root.container().textContent ?? "").toContain("not change it");
  });
});
