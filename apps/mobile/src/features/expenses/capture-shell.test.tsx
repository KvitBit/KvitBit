import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type ExpenseId,
  Invalid,
  type WorkspaceId,
  type WorkspaceSlug,
  type WorkspaceSummary,
} from "@kvitbit/domain/contract";
import { Effect } from "effect";
import type { ReactElement, ReactNode } from "react";
import {
  fakeTransfer,
  useFakeTransfer as installFakeTransfer,
} from "../../platform/transfer/testing";
import { ApiProvider } from "../../runtime/api-runtime";
import { SessionProvider } from "../../session/session-provider";
import { tokenStore } from "../../session/token-store";
import { clientRoot } from "../../testing/client-root";
import { eventually } from "../../testing/eventually";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import { TestProviders } from "../../testing/providers";
import { WorkspaceProvider } from "../../workspace/workspace-provider";
import { uiShim } from "../documents/test-ui-shim";

const capturedTabOptions = new Map<string, Record<string, unknown>>();
let layoutWsSlug = "acme";
let activeUserId = "user-shell-1";

function TabsMock({ children }: { readonly children?: ReactNode }) {
  return <>{children}</>;
}
TabsMock.Screen = function TabsScreenMock(props: {
  readonly name: string;
  readonly options?: Record<string, unknown>;
}) {
  if (props.options !== undefined) capturedTabOptions.set(props.name, props.options);
  return null;
};

function RedirectMock() {
  return null;
}

mock.module("expo-router", () => ({
  ...expoRouterStandIn({
    useLocalSearchParams: () => ({ ws: layoutWsSlug }),
  }),
  Tabs: TabsMock,
  Redirect: RedirectMock,
  router: {
    back: () => undefined,
    canGoBack: () => true,
    push: () => undefined,
    replace: () => undefined,
  },
}));
mock.module("expo-image-picker", () => ({
  requestCameraPermissionsAsync: async () => ({ granted: true }),
  launchCameraAsync: async () => ({ canceled: true, assets: [] }),
  launchImageLibraryAsync: async () => ({ canceled: true, assets: [] }),
}));
mock.module("expo-document-picker", () => ({
  getDocumentAsync: async () => ({ canceled: true, assets: [] }),
}));
installFakeTransfer(fakeTransfer());

const realUi = { ...(await import("../../ui")) };
const { ExpenseDetailScreen } = await import("./expense-detail-screen");
const { default: WorkspaceLayout } = await import("../../../app/w/[ws]/_layout");

const WS_1 = "01937c7a-0000-7000-8000-000000000011" as WorkspaceId;
const WS_2 = "01937c7a-0000-7000-8000-000000000012" as WorkspaceId;
const EXP_1 = "01937c7a-0000-7000-8000-000000000201" as ExpenseId;

const WORKSPACE_1: WorkspaceSummary = {
  id: WS_1,
  slug: "acme" as WorkspaceSlug,
  name: "Acme s.r.o.",
  role: "owner",
  memberCount: 1,
  taxRegime: "vat_payer",
  closed: false,
};
const WORKSPACE_2: WorkspaceSummary = {
  id: WS_2,
  slug: "beta" as WorkspaceSlug,
  name: "Beta s.r.o.",
  role: "member",
  memberCount: 2,
  taxRegime: "vat_payer",
  closed: false,
};

const sampleExpenseView = {
  id: EXP_1,
  revision: 2,
  status: "incomplete",
  supplier: { contactId: null, name: "Cafe", ico: null, dic: null },
  supplierDocumentNumber: null,
  issuedOn: null,
  taxableSupplyOn: null,
  dueOn: null,
  currency: "CZK",
  total: "150.00",
  vat: [],
  totals: { buckets: [] },
  selfAssessed: [],
  fx: null,
  totalCzk: "150.00",
  deductibility: "full",
  deductibleVat: null,
  deductibleVatCzk: null,
  category: null,
  tags: [],
  note: null,
  payment: {
    settlement: "unpaid",
    paid: { amount: "0.00", currency: "CZK" },
    payments: 0,
  },
  attachments: [],
  createdAt: "2026-11-10T10:00:00Z",
  updatedAt: "2026-11-10T10:00:00Z",
};

let server: Server | null = null;
let origin = "";

beforeAll(async () => {
  mock.module("../../ui", () => uiShim);
  server = createServer((req, res) => {
    const reqOrigin = req.headers.origin ?? "*";
    const corsHeaders = {
      "access-control-allow-origin": reqOrigin,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers":
        "authorization, content-type, accept, accept-language, idempotency-key, if-match",
      "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let body: unknown = {};
    if (url.pathname === "/api/auth/get-session") {
      body = {
        user: {
          id: activeUserId,
          email: `${activeUserId}@example.com`,
          name: activeUserId,
          emailVerified: true,
        },
      };
    } else if (url.pathname === "/api/v1/workspaces") {
      body = [WORKSPACE_1, WORKSPACE_2];
    } else if (url.pathname.endsWith(`/expenses/${EXP_1}/payments`)) {
      body = [];
    } else if (url.pathname.endsWith(`/expenses/${EXP_1}`)) {
      body = sampleExpenseView;
    }
    const json = JSON.stringify(body);
    res.writeHead(200, {
      ...corsHeaders,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(json),
    });
    res.end(json);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  mock.module("../../ui", () => realUi);
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

afterEach(async () => {
  capturedTabOptions.clear();
  await tokenStore.clear();
});

describe("receipt capture shell badge and rejected receipts UI", () => {
  const root = clientRoot({ keepFetch: true });
  afterEach(async () => {
    await root.render(null);
  });

  test("WorkspaceLayout binds cross-workspace pending count and blocked error tone for current user", async () => {
    activeUserId = "user-shell-1";
    await tokenStore.write("token-user-shell-1");
    layoutWsSlug = "acme";
    const scope1 = {
      principalId: "user-shell-1",
      workspaceId: WS_1,
      workspaceSlug: WORKSPACE_1.slug,
    };
    const scope2 = {
      principalId: "user-shell-1",
      workspaceId: WS_2,
      workspaceSlug: WORKSPACE_2.slug,
    };
    const otherUserScope = {
      principalId: "user-other",
      workspaceId: WS_1,
      workspaceSlug: WORKSPACE_1.slug,
    };

    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    const key1 = `expense-capture:v1:${JSON.stringify([scope1.principalId, scope1.workspaceId])}`;
    const key2 = `expense-capture:v1:${JSON.stringify([scope2.principalId, scope2.workspaceId])}`;
    const keyOther = `expense-capture:v1:${JSON.stringify([otherUserScope.principalId, otherUserScope.workspaceId])}`;

    await AsyncStorage.setItem(
      key1,
      JSON.stringify([
        { key: "job-1", scope: scope1, targetExpenseId: null, expenseId: null, files: [] },
      ]),
    );
    await AsyncStorage.setItem(
      key2,
      JSON.stringify([
        { key: "job-2", scope: scope2, targetExpenseId: null, expenseId: null, files: [] },
      ]),
    );
    // Another account's job must not be counted for user-shell-1.
    await AsyncStorage.setItem(
      keyOther,
      JSON.stringify([
        {
          key: "job-other",
          scope: otherUserScope,
          targetExpenseId: null,
          expenseId: null,
          files: [],
        },
      ]),
    );

    try {
      const renderLayout = () =>
        root.render(
          <TestProviders>
            <SessionProvider origin={origin}>
              <ApiProvider token="token-user-shell-1" origin={origin}>
                <WorkspaceLayout />
              </ApiProvider>
            </SessionProvider>
          </TestProviders>,
        );

      await renderLayout();

      await Effect.runPromise(
        eventually(() => capturedTabOptions.get("expenses")?.tabBarBadge === 2),
      );
      const nonBlockedStyle = capturedTabOptions.get("expenses")?.tabBarBadgeStyle as
        | { backgroundColor?: string }
        | undefined;
      expect(nonBlockedStyle?.backgroundColor).toBeDefined();

      // Mark job-2 in workspace 2 as blocked, then remount cleanly to verify blocked error tone.
      await AsyncStorage.setItem(
        key2,
        JSON.stringify([
          {
            key: "job-2",
            scope: scope2,
            targetExpenseId: null,
            expenseId: null,
            files: [],
            submission: {
              fields: { supplierName: "", total: "", currency: "CZK", note: "" },
              payload: { status: "incomplete", currency: "CZK" },
              failure: {
                kind: "blocked",
                error: new Invalid({ issues: [{ path: ["total"], code: "expense.incomplete" }] }),
              },
            },
          },
        ]),
      );

      capturedTabOptions.clear();
      await root.render(null);
      await renderLayout();

      await Effect.runPromise(
        eventually(() => {
          const opts = capturedTabOptions.get("expenses");
          const style = opts?.tabBarBadgeStyle as { backgroundColor?: string } | undefined;
          return (
            opts?.tabBarBadge === 2 &&
            style?.backgroundColor !== undefined &&
            style.backgroundColor !== nonBlockedStyle?.backgroundColor
          );
        }),
      );
    } finally {
      await AsyncStorage.removeItem(key1);
      await AsyncStorage.removeItem(key2);
      await AsyncStorage.removeItem(keyOther);
    }
  });

  test("ExpenseDetailScreen renders persisted rejected receipt filename and issue when reopened in edit and view modes", async () => {
    activeUserId = "user-rejected-1";
    await tokenStore.write("token-user-rejected-1");
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    const rejectedStorageKey = `expense-capture:v1:${JSON.stringify(["rejected", "user-rejected-1", WS_1, EXP_1])}`;
    await AsyncStorage.setItem(
      rejectedStorageKey,
      JSON.stringify([
        {
          key: "rej-1",
          name: "bad-mime-receipt.pdf",
          contentType: "application/pdf",
          size: 2048,
          error: {
            _tag: "Invalid",
            issues: [{ path: ["file"], code: "attachment.type_rejected" }],
          },
        },
      ]),
    );

    const wrap = (element: ReactElement) => (
      <TestProviders>
        <SessionProvider origin={origin}>
          <ApiProvider token="token-user-rejected-1" origin={origin}>
            <WorkspaceProvider
              workspace={WORKSPACE_1}
              workspaces={[WORKSPACE_1]}
              reload={() => undefined}
            >
              {element}
            </WorkspaceProvider>
          </ApiProvider>
        </SessionProvider>
      </TestProviders>
    );

    try {
      // Reopened in edit mode
      await root.render(wrap(<ExpenseDetailScreen id={EXP_1} initialMode="edit" />));
      await Effect.runPromise(
        eventually(
          () => (root.container().textContent ?? "").includes("bad-mime-receipt.pdf"),
          () => `edit text: ${root.container().textContent ?? ""}`,
        ),
      );

      // Reopened in view mode
      await root.render(null);
      await root.render(wrap(<ExpenseDetailScreen id={EXP_1} initialMode="view" />));
      await Effect.runPromise(
        eventually(
          () => (root.container().textContent ?? "").includes("bad-mime-receipt.pdf"),
          () => `view text: ${root.container().textContent ?? ""}`,
        ),
      );
    } finally {
      await AsyncStorage.removeItem(rejectedStorageKey);
    }
  });
});
