import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import {
  ExpenseId,
  Invalid,
  WorkspaceId,
  WorkspaceSlug,
  type WorkspaceSummary,
} from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import type { ReactElement } from "react";
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
import { RedirectMock, TabsMock } from "./capture-shell-fixture";

interface TabBadgeOptions {
  readonly tabBarBadge?: number | string;
  readonly tabBarBadgeStyle?: { readonly backgroundColor?: string };
}
const capturedTabOptions = new Map<string, TabBadgeOptions>();
let layoutWsSlug = "acme";
let activeUserId = "user-shell-1";

const recordTabOptions = (props: { readonly name: string; readonly options?: TabBadgeOptions }) => {
  if (props.options !== undefined) capturedTabOptions.set(props.name, props.options);
  return null;
};

mock.module("expo-router", () => ({
  ...expoRouterStandIn({
    useLocalSearchParams: () => ({ ws: layoutWsSlug }),
  }),
  Tabs: Object.assign(TabsMock, { Screen: recordTabOptions }),
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

const WS_1 = WorkspaceId.make("01937c7a-0000-7000-8000-000000000011");
const WS_2 = WorkspaceId.make("01937c7a-0000-7000-8000-000000000012");
const EXP_1 = ExpenseId.make("01937c7a-0000-7000-8000-000000000201");

const WORKSPACE_1: WorkspaceSummary = {
  id: WS_1,
  slug: WorkspaceSlug.make("acme"),
  name: "Acme s.r.o.",
  role: "owner",
  memberCount: 1,
  taxRegime: "vat_payer",
  closed: false,
};
const WORKSPACE_2: WorkspaceSummary = {
  id: WS_2,
  slug: WorkspaceSlug.make("beta"),
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

const stringifyFixture = Fn.flow(
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown)),
  Effect.runSync,
);
let server: ReturnType<typeof Bun.serve>;
let origin = "";

beforeAll(() => {
  mock.module("../../ui", () => uiShim);
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const reqOrigin = req.headers.get("origin") ?? "*";
      const corsHeaders = {
        "access-control-allow-origin": reqOrigin,
        "access-control-allow-credentials": "true",
        "access-control-allow-headers":
          "authorization, content-type, accept, accept-language, idempotency-key, if-match",
        "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
      };
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      const url = new URL(req.url);
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
      } else if (Str.endsWith(`/expenses/${EXP_1}/payments`)(url.pathname)) {
        body = [];
      } else if (Str.endsWith(`/expenses/${EXP_1}`)(url.pathname)) {
        body = sampleExpenseView;
      }
      return Response.json(body, { headers: corsHeaders });
    },
  });
  origin = server.url.origin;
});

afterEach(async () => {
  capturedTabOptions.clear();
  await tokenStore.clear();
});

afterAll(() => {
  mock.module("../../ui", () => realUi);
  server.stop(true);
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
    const key1 = `expense-capture:v1:${stringifyFixture([scope1.principalId, scope1.workspaceId])}`;
    const key2 = `expense-capture:v1:${stringifyFixture([scope2.principalId, scope2.workspaceId])}`;
    const keyOther = `expense-capture:v1:${stringifyFixture([otherUserScope.principalId, otherUserScope.workspaceId])}`;

    await AsyncStorage.setItem(
      key1,
      stringifyFixture([
        { key: "job-1", scope: scope1, targetExpenseId: null, expenseId: null, files: [] },
      ]),
    );
    await AsyncStorage.setItem(
      key2,
      stringifyFixture([
        { key: "job-2", scope: scope2, targetExpenseId: null, expenseId: null, files: [] },
      ]),
    );
    // Another account's job must not be counted for user-shell-1.
    await AsyncStorage.setItem(
      keyOther,
      stringifyFixture([
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
      const nonBlockedStyle = capturedTabOptions.get("expenses")?.tabBarBadgeStyle;
      expect(nonBlockedStyle?.backgroundColor).toBeDefined();

      // Mark job-2 in workspace 2 as blocked, then remount cleanly to verify blocked error tone.
      await AsyncStorage.setItem(
        key2,
        stringifyFixture([
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
                error: Invalid.make({ issues: [{ path: ["total"], code: "expense.incomplete" }] }),
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
          const style = opts?.tabBarBadgeStyle;
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
    const rejectedStorageKey = `expense-capture:v1:${stringifyFixture(["rejected", "user-rejected-1", WS_1, EXP_1])}`;
    await AsyncStorage.setItem(
      rejectedStorageKey,
      stringifyFixture([
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
      await root.render(wrap(<ExpenseDetailScreen expenseId={EXP_1} initialMode="edit" />));
      await Effect.runPromise(
        eventually(
          () => Str.includes("bad-mime-receipt.pdf")(root.container().textContent ?? ""),
          () => `edit text: ${root.container().textContent ?? ""}`,
        ),
      );

      // Reopened in view mode
      await root.render(null);
      await root.render(wrap(<ExpenseDetailScreen expenseId={EXP_1} initialMode="view" />));
      await Effect.runPromise(
        eventually(
          () => Str.includes("bad-mime-receipt.pdf")(root.container().textContent ?? ""),
          () => `view text: ${root.container().textContent ?? ""}`,
        ),
      );
      expect(root.container().textContent).toContain("bad-mime-receipt.pdf");
    } finally {
      await AsyncStorage.removeItem(rejectedStorageKey);
    }
  });
});
