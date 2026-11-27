import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  ContactId,
  IsoDate,
  WorkspaceId,
  WorkspaceSlug,
  type WorkspaceSummary,
} from "@kvitbit/domain/contract";
import { Routes } from "@kvitbit/ui-port/view-models";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as EffectRecord from "effect/Record";
import * as Str from "effect/String";
import { act } from "react";
import { ApiProvider } from "../../runtime/api-runtime";
import { clientRoot, waitForRender } from "../../testing/client-root";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import { recordedOverlay, TestProviders } from "../../testing/providers";
import { WorkspaceProvider } from "../../workspace/workspace-provider";
import { reactEventHandler } from "./react-event.test-utils";
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

const waitFor = (check: () => boolean, label?: string): Promise<void> =>
  waitForRender({ check, label, attempts: 200 });

const WS_ID = WorkspaceId.make("01930000-0000-7000-8000-000000000001");
const WS_SLUG = WorkspaceSlug.make("acme");
const OTHER_WS_ID = WorkspaceId.make("01930000-0000-7000-8000-000000000002");
const OTHER_WS_SLUG = WorkspaceSlug.make("beta");
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
    kind: string;
    number: string | null;
    status: string;
    locked: boolean;
    settlement: string;
    overdue: boolean;
    revision: number;
    dueOn: string;
    total: { amount: string; currency: string };
  }> = [];
  let handleList: ((url: URL) => Promise<Response>) | undefined;

  const row = (id: string) => root.container().querySelector(`[data-testid="document-row-${id}"]`);
  const button = (label: string) =>
    Option.getOrUndefined(
      Arr.findFirst(
        [...root.container().querySelectorAll("button")],
        (node) => node.textContent === label,
      ),
    );
  const click = (node: HTMLButtonElement | undefined) =>
    act(async () => reactEventHandler(node ?? null, "onClick")());

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
          await Effect.runPromise(Effect.sleep(25));
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
        if (Str.endsWith("/documents")(url.pathname)) {
          if (handleList !== undefined) return handleList(url);
          const contact = url.searchParams.get("contact");
          const from = url.searchParams.get("from");
          const to = url.searchParams.get("to");
          const items = Arr.filter(
            listItems,
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

  afterEach(async () => {
    await act(async () => {
      await Effect.runPromise(Effect.sleep(25));
    });
    await root.render(null);
  });

  afterAll(() => {
    server.stop(true);
    mock.module("../../ui", () => realUi);
  });

  const renderScreen = (ws = makeWorkspace()) =>
    root.render(
      <TestProviders locale="en" overlay={overlay}>
        <ApiProvider token="test-token" origin={server.url.origin}>
          <WorkspaceProvider workspace={ws} workspaces={[ws]} reload={() => undefined}>
            <DocumentsRoute />
          </WorkspaceProvider>
        </ApiProvider>
      </TestProviders>,
    );

  test("renders documents with formatted amounts, badges and quick create actions", async () => {
    await renderScreen();
    await waitFor(
      () => Str.includes("2026-0001")(root.container().textContent ?? ""),
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
    await act(() => {
      reactEventHandler(createInv, "onClick")();
      reactEventHandler(createPro, "onClick")();
      reactEventHandler(createCn, "onClick")();
    });
    expect(pushed).toEqual([
      "/w/acme/documents/new/invoice",
      "/w/acme/documents/new/proforma",
      "/w/acme/documents/new/credit_note",
    ]);
  });

  test("search input refetches with text query param", async () => {
    await renderScreen();
    await waitFor(() => requests.length > 0, "initial request");

    const searchInput = root.container().querySelector('[data-testid="documents-search-input"]');
    await act(() => {
      reactEventHandler(
        searchInput,
        "onChange",
      )({
        target: { value: "Beta" },
      });
    });

    await waitFor(
      () => Arr.some(requests, (r) => Str.includes("text=Beta")(r)),
      "search query request",
    );
    expect(Arr.some(requests, (r) => Str.includes("text=Beta")(r))).toBe(true);
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
          contact: ContactId.make(SECOND_CONTACT_ID),
          from: IsoDate.make("2026-11-01"),
          to: IsoDate.make("2026-11-30"),
        },
      },
      "/",
    );
    mockParams = EffectRecord.fromEntries(new URL(href, server.url).searchParams);
    mockParams.contact = [SECOND_CONTACT_ID, "ignored-duplicate"];

    await renderScreen();
    await waitFor(() => row(SECOND_ROW_ID) !== null, "scoped document list");
    expect(row(FIRST_ROW_ID)).toBeNull();
    const query = new URL(Str.slice(4)(requests[0] ?? ""), server.url).searchParams;
    expect(EffectRecord.fromEntries(query)).toEqual({
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
    const cleared = new URL(Str.slice(4)(requests.at(-1) ?? ""), server.url).searchParams;
    expect(EffectRecord.fromEntries(cleared)).toEqual({ limit: "50" });
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
        await act(() => {
          reactEventHandler(
            search,
            "onChange",
          )({
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
      () => Str.includes("2026-0001")(root.container().textContent ?? ""),
      "accountant list loaded",
    );
    expect(root.container().querySelector('[data-testid="documents-create-invoice"]')).toBeNull();
    expect(root.container().textContent ?? "").toContain("not change it");
  });
});
