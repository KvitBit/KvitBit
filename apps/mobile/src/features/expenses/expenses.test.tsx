import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import {
  ExpenseId,
  WorkspaceId,
  WorkspaceSlug,
  type WorkspaceSummary,
} from "@kvitbit/domain/contract";
import { idempotencyHeaders, ifMatchHeaders, UiError, uuidV7 } from "@kvitbit/ui-port/api";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { act, type ReactElement } from "react";
import {
  fakeTransfer,
  useFakeTransfer as installFakeTransfer,
} from "../../platform/transfer/testing";
import { ApiProvider, type ApiRunner } from "../../runtime/api-runtime";
import { SessionProvider } from "../../session/session-provider";
import { tokenStore } from "../../session/token-store";
import { clientRoot, waitForRender } from "../../testing/client-root";
import { allText, hostTree } from "../../testing/element-tree";
import { eventually } from "../../testing/eventually";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import { SignedInFixture, TestProviders } from "../../testing/providers";
import { recordedOverlay } from "../../testing/recorded-overlay";
import { WorkspaceProvider } from "../../workspace/workspace-provider";
import { uiShim } from "../documents/test-ui-shim";
import type { ReceiptPicker } from "./capture-picker";
import {
  buildExpensePayload,
  decodeExpenseDetail,
  decodeExpenseSummary,
  decodePayment,
  emptyExpenseForm,
  extractCategories,
  filterExpenses,
  remainingAmount,
  validateAttachmentFile,
  vatBreakdownDifference,
} from "./model";

const transferFake = fakeTransfer();
let expenseRouteParams: Record<string, string> = {};

mock.module("expo-router", () => ({
  ...expoRouterStandIn({ useLocalSearchParams: () => expenseRouteParams }),
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
installFakeTransfer(transferFake);

const realUi = { ...(await import("../../ui")) };
const { ExpensesListScreen } = await import("./expenses-list-screen");
const { ExpenseDetailScreen } = await import("./expense-detail-screen");
const { ExpenseCaptureScreen } = await import("./expense-capture-screen");
const { useTransfer } = await import("../../platform/transfer");
const { ExpensesProbe } = await import("./expenses-probe");
const { default: ExpenseRoute } = await import("../../../app/w/[ws]/expenses/[id]");

const WS_ID = WorkspaceId.make("01937c7a-0000-7000-8000-000000000001");
const EXP_1 = ExpenseId.make("01937c7a-0000-7000-8000-000000000101");
const EXP_2 = ExpenseId.make("01937c7a-0000-7000-8000-000000000102");
const ATT_1 = "01937c7a-0000-7000-8000-000000000201";
const PAY_1 = "01937c7a-0000-7000-8000-000000000301";

const WORKSPACE: WorkspaceSummary = {
  id: WS_ID,
  slug: WorkspaceSlug.make("acme"),
  name: "Acme s.r.o.",
  role: "owner",
  memberCount: 1,
  taxRegime: "vat_payer",
  closed: false,
};

const sampleExpenseView = {
  id: EXP_1,
  revision: 3,
  status: "complete" as const,
  supplier: { contactId: null, name: "CloudHost s.r.o.", ico: "12345678", dic: "CZ12345678" },
  supplierDocumentNumber: "INV-2026-99",
  issuedOn: "2026-11-10",
  taxableSupplyOn: "2026-11-10",
  dueOn: "2026-11-24",
  currency: "CZK",
  total: "1210.00",
  vat: [{ treatment: "standard", base: "1000.00", vat: "210.00", selfAssessed: null }],
  totals: {
    buckets: [
      {
        treatment: "standard",
        ratePercent: "21",
        base: "1000.00",
        vat: "210.00",
        gross: "1210.00",
        vatCzk: null,
      },
    ],
  },
  selfAssessed: [],
  fx: null,
  totalCzk: "1210.00",
  deductibility: { partial: 80 },
  deductibleVat: { amount: "168.00", currency: "CZK" },
  deductibleVatCzk: "168.00",
  category: "Hosting",
  tags: ["infra", "monthly"],
  note: "November server bill",
  attachments: [
    {
      id: ATT_1,
      expenseId: EXP_1,
      name: "receipt-nov.pdf",
      contentType: "application/pdf",
      bytes: 42000,
      sha256: "abc123",
      createdAt: "2026-11-10T10:00:00Z",
    },
  ],
  payment: {
    settlement: "partially_paid",
    paid: { amount: "500.00", currency: "CZK" },
    payments: 1,
  },
  createdAt: "2026-11-10T10:00:00Z",
  updatedAt: "2026-11-10T10:00:00Z",
};

describe("expenses model", () => {
  test("filters by status, category and search text", () => {
    const items = Arr.filter(
      [
        decodeExpenseSummary({
          id: EXP_1,
          revision: 1,
          status: "complete",
          supplierName: "CloudHost s.r.o.",
          supplierDocumentNumber: "INV-99",
          issuedOn: "2026-11-10",
          total: "1210.00",
          currency: "CZK",
          category: "Hosting",
          tags: ["infra"],
          attachments: 1,
          settlement: "unpaid",
        }),
        decodeExpenseSummary({
          id: EXP_2,
          revision: 1,
          status: "incomplete",
          supplierName: "Cafe Praha",
          supplierDocumentNumber: null,
          issuedOn: null,
          total: "145.00",
          currency: "CZK",
          category: "Travel",
          tags: [],
          attachments: 1,
          settlement: "unpaid",
        }),
      ],
      (item) => item !== null,
    );

    expect(extractCategories(items)).toEqual(["Hosting", "Travel"]);
    expect(
      filterExpenses(items, { status: "incomplete", category: null, search: "" }),
    ).toHaveLength(1);
    expect(filterExpenses(items, { status: "all", category: "Hosting", search: "" })).toHaveLength(
      1,
    );
    expect(filterExpenses(items, { status: "all", category: null, search: "inv-99" })).toHaveLength(
      1,
    );
  });

  test("validates complete expense form and builds strict ExpenseFields payload", () => {
    const invalid = buildExpensePayload(emptyExpenseForm());
    expect(invalid.errors["total"]).toBe("required");

    const valid = buildExpensePayload({
      ...emptyExpenseForm(),
      supplierName: "CloudHost",
      supplierIco: "12345678",
      issuedOn: "2026-11-10",
      total: "1210,00",
      deductibilityMode: "partial",
      deductiblePercent: "80",
      vatRows: [{ id: "v1", treatment: "standard", base: "1000", vat: "210" }],
      tags: "infra, monthly",
    });
    expect(Rec.keys(valid.errors)).toHaveLength(0);
    expect(valid.payload.total).toBe("1210.00");
    expect(valid.payload.deductibility).toEqual({ partial: 80 });
    expect(valid.payload.tags).toEqual(["infra", "monthly"]);

    const incomplete = buildExpensePayload({
      ...emptyExpenseForm(),
      status: "incomplete",
      issuedOn: "",
      total: "",
    });
    expect(Rec.keys(incomplete.errors)).toHaveLength(0);
  });

  test("computes VAT breakdown difference, remaining amount, and attachment validation", () => {
    expect(
      vatBreakdownDifference("1210", [
        { id: "1", treatment: "standard", base: "1000", vat: "200" },
      ]),
    ).toBe(10);
    const expense = decodeExpenseDetail(sampleExpenseView);
    expect(expense === null ? null : remainingAmount(expense)).toBe("710.00");
    expect(validateAttachmentFile({ contentType: "application/pdf", size: 1024 })).toBeNull();
    expect(validateAttachmentFile({ contentType: "text/plain", size: 1024 })).toBe(
      "unsupported_type",
    );
    expect(validateAttachmentFile({ contentType: "image/jpeg", size: 25 * 1024 * 1024 })).toBe(
      "too_large",
    );
  });
});

describe("expenses screens and API/transfer integration", () => {
  const root = clientRoot({ keepFetch: true });
  let server: ReturnType<typeof Bun.serve>;
  let losePaymentResponse = false;
  let paymentConfirmed = false;
  const requests: Array<{
    readonly method: string;
    readonly path: string;
    readonly idempotencyKey: string | null;
    readonly ifMatch: string | null;
  }> = [];

  beforeAll(() => {
    mock.module("../../ui", () => uiShim);
    server = Bun.serve({
      port: 0,
      fetch: (req) =>
        Effect.sync(() => {
          const url = new URL(req.url);
          requests.push({
            method: req.method,
            path: url.pathname + url.search,
            idempotencyKey: req.headers.get("idempotency-key"),
            ifMatch: req.headers.get("if-match"),
          });
          if (Str.endsWith("/get-session")(url.pathname)) {
            return Response.json({
              user: { id: "expenses-test-user", email: "expenses@example.test" },
            });
          }
          if (Str.endsWith("/expenses")(url.pathname) && req.method === "GET") {
            return Response.json({
              items: [
                {
                  id: EXP_1,
                  revision: 3,
                  status: "complete",
                  supplierName: "CloudHost s.r.o.",
                  supplierDocumentNumber: "INV-2026-99",
                  issuedOn: "2026-11-10",
                  total: "1210.00",
                  currency: "CZK",
                  category: "Hosting",
                  tags: ["infra"],
                  attachments: 1,
                  settlement: "partially_paid",
                },
              ],
              nextCursor: null,
            });
          }
          if (Str.endsWith("/expenses")(url.pathname) && req.method === "POST") {
            return Response.json({ ...sampleExpenseView, id: EXP_2 }, { status: 201 });
          }
          if (Str.endsWith(`/expenses/${EXP_1}`)(url.pathname) && req.method === "GET") {
            return Response.json(
              paymentConfirmed
                ? {
                    ...sampleExpenseView,
                    supplier: { ...sampleExpenseView.supplier, name: "Refreshed supplier" },
                  }
                : sampleExpenseView,
            );
          }
          if (Str.endsWith(`/expenses/${EXP_1}`)(url.pathname) && req.method === "PATCH") {
            return Response.json({ ...sampleExpenseView, revision: 4, note: "Updated note" });
          }
          if (Str.endsWith(`/expenses/${EXP_1}/payments`)(url.pathname) && req.method === "GET") {
            return Response.json([
              {
                id: PAY_1,
                revision: 1,
                target: { expense: EXP_1 },
                amount: { amount: "500.00", currency: "CZK" },
                paidOn: "2026-11-12",
                method: "bank_transfer",
                note: paymentConfirmed ? "Refreshed payments" : "Deposit",
                taxDocument: null,
                createdAt: "2026-11-12T09:00:00Z",
              },
            ]);
          }
          if (Str.endsWith("/payments")(url.pathname) && req.method === "POST") {
            if (losePaymentResponse) {
              losePaymentResponse = false;
              return new Response("{", {
                status: 201,
                headers: { "content-type": "application/json" },
              });
            }
            paymentConfirmed = true;
            return Response.json(
              {
                payment: {
                  id: "01937c7a-0000-7000-8000-000000000302",
                  revision: 1,
                  target: { expense: EXP_1 },
                  amount: { amount: "710.00", currency: "CZK" },
                  paidOn: "2026-11-24",
                  method: "bank_transfer",
                  note: null,
                  taxDocument: null,
                  createdAt: "2026-11-24T10:00:00Z",
                },
                settlement: "paid",
                issued: [],
              },
              { status: 201 },
            );
          }
          return Response.json({ _tag: "NotFound", entity: "Expense" }, { status: 404 });
        }).pipe(Effect.runPromise),
    });
  });

  afterEach(async () => {
    expenseRouteParams = {};
    losePaymentResponse = false;
    paymentConfirmed = false;
    await root.render(null);
    await tokenStore.clear();
  });

  afterAll(() => {
    server.stop(true);
    mock.module("../../ui", () => realUi);
  });

  const within = (node: ReactElement, workspace = WORKSPACE, signIn = false) => {
    const content = signIn ? <SignedInFixture>{node}</SignedInFixture> : node;
    return (
      <TestProviders overlay={recordedOverlay()}>
        <SessionProvider origin={server.url.origin}>
          <ApiProvider token="tok" origin={server.url.origin}>
            <WorkspaceProvider
              workspace={workspace}
              workspaces={[workspace]}
              reload={() => undefined}
            >
              {content}
            </WorkspaceProvider>
          </ApiProvider>
        </SessionProvider>
      </TestProviders>
    );
  };

  const waitForScreen = (check: () => boolean) => waitForRender({ check, attempts: 100 });

  const element = (id: string) =>
    root.container().querySelector<HTMLElement>(`[data-testid="${id}"]`);

  const press = async (id: string) => {
    const target = element(id);
    if (target === null) throw new Error(`Missing interactive element ${id}`);
    await act(async () => target.click());
  };

  test("screens render expected controls and copy via hostTree", () => {
    const listText = allText(hostTree(<ExpensesListScreen />, within));
    expect(listText).toContain("Expenses");
    expect(listText).toContain("Complete");
    expect(listText).toContain("Incomplete");

    const editorText = allText(
      hostTree(<ExpenseDetailScreen expenseId="new" initialMode="edit" />, within),
    );
    expect(editorText).toContain("New expense");
    expect(editorText).toContain("VAT deductibility");
    expect(editorText).toContain("VAT breakdown");
  });

  test("a signed-in writer can open the capture pickers", async () => {
    const fakePicker: ReceiptPicker = {
      takePhoto: async () => ({ _tag: "Cancelled" }),
      pickFromGallery: async () => ({ _tag: "Cancelled" }),
      pickDocument: async () => ({ _tag: "Cancelled" }),
    };
    await tokenStore.write("expenses-test-session");
    await root.render(within(<ExpenseCaptureScreen picker={fakePicker} />, WORKSPACE, true));
    await waitForScreen(() => Str.includes("Choose file")(root.container().textContent ?? ""));
    const captureText = root.container().textContent ?? "";
    expect(captureText).toContain("Capture receipt");
    expect(captureText).toContain("Take photo");
    expect(captureText).toContain("Choose from gallery");
    expect(captureText).toContain("Choose file");
  });

  test("the edit deep link keeps accountants in read mode with attachment access", async () => {
    const readOnly = { ...WORKSPACE, role: "accountant" } as const;
    expenseRouteParams = { id: EXP_1, mode: "edit" };
    await root.render(within(<ExpenseRoute />, readOnly));
    await waitForScreen(() => element(`attachment-open-${ATT_1}`) !== null);
    expect(element(`attachment-share-${ATT_1}`)).not.toBeNull();
    expect(element("expense-save")).toBeNull();
    expect(element("expense-add-attachment")).toBeNull();
    expect(element("expense-record-payment-toggle")).toBeNull();
    expect(root.container().querySelector('[aria-label="Edit"]')).toBeNull();
    expect(root.container().querySelector('[aria-label="Delete"]')).toBeNull();

    expenseRouteParams = { id: "new", mode: "edit" };
    await root.render(within(<ExpenseRoute />, readOnly));
    expect(root.container().textContent).toContain("Your role does not allow this action.");
    expect(element("expense-save")).toBeNull();
  });

  test("retries expense payment submission with the same request key", async () => {
    requests.length = 0;
    losePaymentResponse = true;
    await tokenStore.write("expenses-test-session");
    await root.render(within(<ExpenseDetailScreen expenseId={EXP_1} />, WORKSPACE, true));
    await waitForScreen(() => element("expense-record-payment-toggle") !== null);
    await press("expense-record-payment-toggle");
    await press("expense-record-payment-submit");
    await waitForScreen(() => Str.includes("Please try again")(root.container().textContent ?? ""));
    await press("expense-record-payment-submit");
    await waitForScreen(() => {
      const content = root.container().textContent ?? "";
      return (
        Str.includes("Refreshed supplier")(content) && Str.includes("Refreshed payments")(content)
      );
    });
    expect(element("expense-record-payment-submit")).toBeNull();

    const attempts = Arr.filter(
      requests,
      ({ path, method }) => Str.endsWith("/payments")(path) && method === "POST",
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.idempotencyKey).toBeTruthy();
    expect(attempts[1]?.idempotencyKey).toBe(attempts[0]?.idempotencyKey);
  });

  test("end-to-end API + Transfer runtime loads, edits, pays, uploads and downloads attachments", async () => {
    installFakeTransfer(transferFake);
    transferFake.uploads.length = 0;
    transferFake.downloads.length = 0;
    transferFake.opened.length = 0;
    requests.length = 0;

    interface ClientRefs {
      current?: { readonly api: ApiRunner; readonly transfer: ReturnType<typeof useTransfer> };
    }
    const clients: ClientRefs = {};
    let loadedCount = 0;

    await root.render(
      within(
        <ExpensesProbe
          workspaceId={WS_ID}
          onReady={(a, tr, count) => {
            clients.current = { api: a, transfer: tr };
            loadedCount = count;
          }}
        />,
      ),
    );
    await Effect.runPromise(eventually(() => loadedCount === 1 && clients.current !== undefined));
    expect(loadedCount).toBe(1);

    if (clients.current === undefined) throw new Error("Expense client did not mount");
    const { api, transfer } = clients.current;

    // Edit with If-Match
    const editPayload = buildExpensePayload({
      ...emptyExpenseForm(),
      supplierName: "CloudHost s.r.o.",
      issuedOn: "2026-11-10",
      total: "1210.00",
      note: "Updated note",
    });
    const edited = await api.run((c) =>
      c.expenses.edit({
        params: { workspaceId: WS_ID, expenseId: EXP_1 },
        headers: ifMatchHeaders(3),
        payload: editPayload.payload,
      }),
    );
    expect(edited._tag).toBe("Ok");
    expect(edited._tag === "Ok" ? decodeExpenseDetail(edited.value)?.revision : undefined).toBe(4);
    expect(Arr.some(requests, (r) => r.method === "PATCH" && r.ifMatch === '"3"')).toBe(true);

    // Record expense & upload receipt via Transfer
    const key = await Effect.runPromise(uuidV7);
    const created = await api.run((c) =>
      c.expenses.record({
        params: { workspaceId: WS_ID },
        headers: idempotencyHeaders(key),
        payload: { status: "incomplete", currency: "CZK" },
      }),
    );
    expect(created._tag).toBe("Ok");
    expect(Arr.some(requests, (r) => r.method === "POST" && r.idempotencyKey === key)).toBe(true);

    const up = await transfer.upload({
      path: `/workspaces/${WS_ID}/expenses/${EXP_2}/attachments`,
      file: {
        ref: "file:///tmp/receipt.jpg",
        name: "receipt.jpg",
        contentType: "image/jpeg",
        size: 4096,
        sha256: "abc",
      },
    });
    expect(up._tag).toBe("Ok");
    expect(transferFake.uploads).toHaveLength(1);

    // Download & open attachment via Transfer
    const dl = await transfer.download({
      path: `/workspaces/${WS_ID}/expenses/${EXP_1}/attachments/${ATT_1}`,
      filename: "receipt-nov.pdf",
      contentType: "application/pdf",
    });
    expect(dl._tag).toBe("Ok");
    if (dl._tag === "Ok") {
      await transfer.open(dl.value);
    }
    expect(transferFake.downloads).toHaveLength(1);
    expect(transferFake.opened).toHaveLength(1);

    // List payments & record payment
    const paymentsRes = await api.run((c) =>
      c.payments.listForExpense({ params: { workspaceId: WS_ID, expenseId: EXP_1 } }),
    );
    expect(paymentsRes._tag).toBe("Ok");
    expect(paymentsRes._tag === "Ok" ? decodePayment(paymentsRes.value[0])?.note : undefined).toBe(
      "Deposit",
    );

    const failTransfer = fakeTransfer({
      upload: () => ({ _tag: "Err", error: UiError.offline }),
    });
    const failedUp = await failTransfer.upload({
      path: `/workspaces/${WS_ID}/expenses/${EXP_2}/attachments`,
      file: {
        ref: "file:///tmp/receipt.jpg",
        name: "receipt.jpg",
        contentType: "image/jpeg",
        size: 100,
        sha256: "abc",
      },
    });
    expect(failedUp._tag).toBe("Err");
  });
});
