import { describe, expect, mock, test } from "bun:test";
import {
  CurrencyCode,
  type DashboardView,
  DeliveryId,
  DocumentId,
  IsoDate,
  ShareViewId,
  WorkspaceId,
  WorkspaceSlug,
  type WorkspaceSummary,
} from "@kvitbit/domain/contract";
import { Remote as RemoteOps, sessionCookie, UiError } from "@kvitbit/ui-port/api";
import { formatMoney, formatMonth } from "@kvitbit/ui-port/format";
import { Period, type Route } from "@kvitbit/ui-port/view-models";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import type { ReactElement } from "react";
import { makeApiRunner } from "../../runtime/api-runtime";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import type { ReceivableDocumentRow } from "../reports/model";
import type { DashboardContentProps } from "./dashboard-screen";
import { loadWorkspaceActivity } from "./data";
import {
  canWriteWorkspace,
  cashflowBarRatio,
  type DashboardDocument,
  documentActivity,
  isWorkspaceEmpty,
  maxCashflowAmount,
  mostOverdueDocuments,
  parseDocumentSummaries,
  periodRange,
} from "./model";

mock.module("expo-router", () => expoRouterStandIn());

const { allText, findAll, hostTree } = await import("../../testing/element-tree");
const { TestProviders } = await import("../../testing/providers");
const { DashboardContent } = await import("./dashboard-screen");

const CZK = CurrencyCode.make("CZK");
const money = (n: number) => ({ amount: BigDecimal.fromNumberUnsafe(n), currency: CZK });

const baseWorkspace: WorkspaceSummary = {
  id: WorkspaceId.make("01937c7a-0000-7000-8000-ee92e8791c13"),
  slug: WorkspaceSlug.make("acme"),
  name: "Acme s.r.o.",
  role: "owner",
  memberCount: 2,
  taxRegime: "vat_payer",
  closed: false,
};

const sampleDashboard: DashboardView = {
  period: { from: IsoDate.make("2026-11-01"), to: IsoDate.make("2026-11-30") },
  revenue: money(125000),
  unpaid: money(32000),
  overdue: { total: money(14500), count: 2 },
  expenses: money(41200),
  incompleteExpenses: 3,
  cashflow: Array.from({ length: 12 }, (_, index) => ({
    month: index === 0 ? "2025-12" : `2026-${Str.padStart(2, "0")(String(index))}`,
    in: money(125000),
    out: money(41200),
    net: money(83800),
  })),
};

const sampleDoc: DashboardDocument = {
  id: DocumentId.make("01937c7a-0000-7000-8000-dcee443a501c"),
  kind: "invoice",
  number: "2026-0042",
  status: "issued",
  locked: false,
  settlement: "partially_paid",
  overdue: true,
  contactName: "Novák s.r.o.",
  issuedOn: IsoDate.make("2026-10-15"),
  dueOn: IsoDate.make("2026-10-29"),
  total: money(14500),
};

const activityId = (n: number) => `01937c7a-0000-7000-8000-${Str.padStart(12, "0")(String(n))}`;

test("finds the latest workspace activity across pages, including historical link views", async () => {
  const recent = activityId(11);
  const old = activityId(12);
  const draft = activityId(13);
  const other = activityId(14);
  const workspaceId = WorkspaceId.make(activityId(1));
  const doc = (id: string, status: "issued" | "draft" = "issued") => ({
    ...sampleDoc,
    id,
    status,
    issuedOn: id === old ? "2024-01-01" : sampleDoc.issuedOn,
    contact: { name: sampleDoc.contactName },
    total: { amount: "14500", currency: "CZK" },
  });
  const at = (day: number) => `2026-11-${day}T10:00:00Z`;
  const activityRequests: string[] = [];
  const docCursors: Array<string | null> = [];
  const viewCursors: Array<string | null> = [];
  let active = 0;
  let peak = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const { pathname, searchParams } = new URL(request.url);
      const path = Str.split("/documents")(pathname)[1] ?? "";
      const cursor = searchParams.get("cursor");
      if (path === "") {
        docCursors.push(cursor);
        return Response.json({
          items:
            cursor === null
              ? [doc(recent), doc(other), doc(draft, "draft")]
              : [doc(recent), doc(old)],
          nextCursor: cursor === null ? "doc-next" : null,
        });
      }
      activityRequests.push(path);
      peak = Math.max(peak, ++active);
      await Bun.sleep(5);
      active -= 1;
      if (Str.endsWith("/payments")(path)) {
        const payment = { id: activityId(21), createdAt: at(24) };
        return Response.json(Str.includes(old)(path) ? [payment, payment] : []);
      }
      if (Str.endsWith("/views")(path)) {
        if (!Str.includes(old)(path)) return Response.json({ items: [], nextCursor: null });
        viewCursors.push(cursor);
        return Response.json({
          items:
            cursor === null
              ? [{ id: activityId(31), kind: "download", at: at(27), device: "mobile" }]
              : [
                  { id: activityId(32), kind: "view", at: at(26), device: "mobile" },
                  { id: activityId(33), kind: "view", at: at(25), device: "desktop" },
                ],
          nextCursor: cursor === null ? "views-next" : null,
        });
      }
      const id = Str.slice(1)(path);
      const sentOn = id === old ? 23 : id === recent ? 22 : 21;
      const amount = { amount: "0", currency: "CZK" };
      return Response.json({
        ...doc(id),
        revision: 1,
        taxDocument: false,
        contact: {
          id: null,
          name: "Contact",
          ico: null,
          dic: null,
          legalForm: null,
          address: {},
          billingEmails: [],
        },
        issuer: {
          workspaceId,
          name: "Issuer",
          ico: null,
          dic: null,
          address: {},
          registerEntry: null,
          email: null,
          phone: null,
          web: null,
          regime: "non_payer",
          bankAccount: null,
        },
        dates: { issuedOn: sampleDoc.issuedOn, dueOn: sampleDoc.dueOn, taxableSupplyOn: null },
        paymentMethod: "bank_transfer",
        lines: [],
        totals: {
          buckets: [],
          net: amount,
          vat: amount,
          roundingAdjustment: amount,
          gross: amount,
          vatCzk: null,
        },
        fx: null,
        statutoryNotes: [],
        paymentQr: null,
        related: [],
        share: null,
        deliveries: [
          {
            id: activityId(sentOn + 20),
            purpose: "document",
            status: "sent",
            to: [],
            at: at(sentOn),
          },
        ],
      });
    },
  });
  const runner = makeApiRunner(server.url.origin, sessionCookie, () => "en");
  try {
    const client = await runner.run(Effect.succeed);
    if (client._tag === "Err") throw new Error("Could not get the API client");
    const events = await Effect.runPromise(
      loadWorkspaceActivity({ api: client.value, workspaceId }),
    );
    expect(Arr.map(events, ({ id, document }) => [id, document.id])).toEqual([
      [`viewed:${activityId(32)}`, old],
      [`viewed:${activityId(33)}`, old],
      [`paid:${activityId(21)}`, old],
      [`sent:${activityId(43)}`, old],
      [`sent:${activityId(42)}`, recent],
    ]);
    expect(docCursors).toEqual([null, "doc-next"]);
    expect(viewCursors).toEqual([null, "views-next"]);
    expect(Arr.filter(activityRequests, (path) => path === `/${recent}`)).toHaveLength(1);
    expect(Arr.some(activityRequests, (path) => Str.includes(draft)(path))).toBe(false);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  } finally {
    await runner.dispose();
    await server.stop(true);
  }
});

const within = (node: ReactElement) => <TestProviders>{node}</TestProviders>;

const overdueBalance = { amount: "4500.00", currency: CZK };
const sampleReceivable: ReceivableDocumentRow = {
  id: sampleDoc.id,
  kind: sampleDoc.kind,
  number: sampleDoc.number,
  contact: { id: null, name: sampleDoc.contactName },
  currency: CZK,
  dueOn: sampleDoc.dueOn,
  daysOverdue: 30,
  outstanding: overdueBalance,
  outstandingCzk: overdueBalance,
};

const noDocuments = RemoteOps.ready({ items: [], hasDocuments: false });
const recentDocuments = RemoteOps.ready({ items: [sampleDoc], hasDocuments: true });

const renderDashboard = (overrides: Partial<DashboardContentProps> = {}) =>
  hostTree(
    <DashboardContent
      workspace={baseWorkspace}
      preset="this_month"
      reportPeriod={Period.make("2026-11")}
      onSelectPreset={() => undefined}
      dashboard={RemoteOps.ready(sampleDashboard)}
      onRetryDashboard={() => undefined}
      overdueDocs={RemoteOps.ready([])}
      onRetryOverdue={() => undefined}
      recentDocs={noDocuments}
      onRetryRecent={() => undefined}
      activity={RemoteOps.ready([])}
      onRetryActivity={() => undefined}
      hasExpenses={RemoteOps.ready(true)}
      onNavigate={() => undefined}
      {...overrides}
    />,
    within,
  );

describe("dashboard model", () => {
  test("computes period ranges including January -> December rollover", () => {
    expect(periodRange("this_month", IsoDate.make("2026-11-24"))).toEqual({
      from: IsoDate.make("2026-11-01"),
      to: IsoDate.make("2026-11-30"),
      reportPeriod: Period.make("2026-11"),
    });
    expect(periodRange("last_month", IsoDate.make("2026-01-10"))).toEqual({
      from: IsoDate.make("2025-12-01"),
      to: IsoDate.make("2025-12-31"),
      reportPeriod: Period.make("2025-12"),
    });
    expect(periodRange("this_quarter", IsoDate.make("2026-11-24"))).toEqual({
      from: IsoDate.make("2026-10-01"),
      to: IsoDate.make("2026-12-31"),
      reportPeriod: Period.make("2026-Q4"),
    });
    expect(periodRange("this_year", IsoDate.make("2026-11-24"))).toEqual({
      from: IsoDate.make("2026-01-01"),
      to: IsoDate.make("2026-12-31"),
      reportPeriod: Period.make("2026"),
    });
  });

  test("parses valid DocumentSummary objects and drops malformed entries", () => {
    const parsed = parseDocumentSummaries([
      {
        id: "01937c7a-0000-7000-8000-dcee443a501c",
        kind: "invoice",
        number: "2026-0001",
        status: "issued",
        locked: true,
        settlement: "paid",
        overdue: false,
        contact: { id: "c_1", name: "Beta a.s." },
        issuedOn: "2026-11-01",
        dueOn: "2026-11-15",
        total: { amount: "12100.50", currency: "CZK" },
      },
      { id: "bad" },
      null,
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.number).toBe("2026-0001");
    expect(parsed[0]?.contactName).toBe("Beta a.s.");
    expect(
      (parsed[0]?.total.amount ?? BigDecimal.fromNumberUnsafe(0)).pipe(BigDecimal.format),
    ).toBe("12100.5");
  });

  test("computes cashflow bar ratios safely", () => {
    const max = maxCashflowAmount(sampleDashboard.cashflow);
    expect(cashflowBarRatio(BigDecimal.fromNumberUnsafe(125000), max)).toBe(1);
    expect(cashflowBarRatio(BigDecimal.fromNumberUnsafe(0), BigDecimal.fromNumberUnsafe(0))).toBe(
      0,
    );
  });

  test("requires successful unfiltered document and expense reads before showing the checklist", () => {
    const noExpenses = RemoteOps.ready(false);
    expect(isWorkspaceEmpty(noDocuments, noExpenses)).toBe(true);
    expect(isWorkspaceEmpty(recentDocuments, noExpenses)).toBe(false);
    expect(isWorkspaceEmpty(noDocuments, RemoteOps.ready(true))).toBe(false);
    expect(isWorkspaceEmpty(RemoteOps.load(noDocuments), noExpenses)).toBe(false);
    expect(isWorkspaceEmpty(noDocuments, RemoteOps.load(RemoteOps.idle))).toBe(false);
    expect(isWorkspaceEmpty(noDocuments, RemoteOps.fail(noExpenses, UiError.offline))).toBe(false);
  });

  test("ranks open receivables across all aging buckets before taking the oldest five", () => {
    const buckets = [
      { bucket: "not_due", days: [0] },
      { bucket: "1_30", days: [1, 6, 30, 16, 25] },
      { bucket: "31_60", days: [39, 46] },
      { bucket: "over_90", days: [91, 154] },
    ] as const;
    const result = mostOverdueDocuments({
      report: "receivables",
      period: sampleDashboard.period,
      asOf: sampleDashboard.period.to,
      buckets: Arr.map(buckets, ({ bucket, days }) => ({
        bucket,
        count: days.length,
        total: overdueBalance,
        documents: Arr.map(days, (daysOverdue) => ({ ...sampleReceivable, daysOverdue })),
      })),
      total: overdueBalance,
      overdue: { count: 9, total: overdueBalance },
    });
    expect(Arr.map(result, ({ daysOverdue }) => daysOverdue)).toEqual([154, 91, 46, 39, 30]);
    expect(result[0]?.outstanding).toEqual(overdueBalance);
  });

  test("restricts writes for closed workspaces and accountants", () => {
    expect(canWriteWorkspace(baseWorkspace)).toBe(true);
    expect(canWriteWorkspace({ ...baseWorkspace, closed: true })).toBe(false);
    expect(canWriteWorkspace({ ...baseWorkspace, role: "accountant" })).toBe(false);
  });
});

describe("DashboardContent", () => {
  test("renders all 12 cashflow months and opens receivables from both balance tiles", () => {
    const visited: Route[] = [];
    const tree = renderDashboard({
      userName: "Filip",
      overdueDocs: RemoteOps.ready([sampleReceivable]),
      recentDocs: recentDocuments,
      onNavigate: (route) => visited.push(route),
    });

    const text = allText(tree);
    expect(text).toContain("Hello, Filip");
    expect(text).toContain("Revenue");
    expect(text).toContain("Expenses");
    expect(text).toContain("Unpaid");
    expect(text).toContain("Overdue");
    expect(text).toContain("2 invoices");
    expect(text).toContain("Incomplete expenses");
    expect(text).toContain("2026-0042");
    expect(text).toContain("Novák s.r.o.");
    expect(text).toContain(formatMoney("en", overdueBalance));
    for (const point of sampleDashboard.cashflow) {
      expect(text).toContain(formatMonth("en", point.month));
    }

    const pressables = findAll<{
      testID?: string;
      accessibilityLabel?: string;
      onPress?: () => void;
    }>(tree, "Pressable");
    Option.getOrUndefined(
      Arr.findFirst(pressables, (p) => p.props.testID === "dashboard-action-new-invoice"),
    )?.props.onPress?.();
    Option.getOrUndefined(
      Arr.findFirst(pressables, (p) => p.props.testID === "dashboard-action-capture-expense"),
    )?.props.onPress?.();
    Option.getOrUndefined(
      Arr.findFirst(pressables, (p) => p.props.testID === "dashboard-action-add-contact"),
    )?.props.onPress?.();
    Option.getOrUndefined(
      Arr.findFirst(pressables, (p) => p.props.accessibilityLabel === "Unpaid"),
    )?.props.onPress?.();
    Option.getOrUndefined(
      Arr.findFirst(pressables, (p) => p.props.accessibilityLabel === "Overdue"),
    )?.props.onPress?.();

    expect(Arr.map(visited, (r) => r._tag)).toEqual([
      "DocumentNew",
      "ExpenseCapture",
      "Contact",
      "Reports",
      "Reports",
    ]);
    const report: Route = {
      _tag: "Reports",
      ws: baseWorkspace.slug,
      report: "receivables",
      period: Period.make("2026-11"),
    };
    expect(visited.slice(-2)).toEqual([report, report]);
  });

  test("shows the verified empty-workspace checklist in place of the tiles and opens Team", () => {
    const visited: Route[] = [];
    const tree = renderDashboard({
      hasExpenses: RemoteOps.ready(false),
      onNavigate: (route) => visited.push(route),
    });
    const labels = ["Add a contact", "Create your first invoice", "Invite your accountant"];
    const text = allText(tree);
    expect(text).toContain("Get started");
    expect(text).not.toContain("Revenue");
    expect(text).not.toContain("Quick actions");
    for (const label of labels) {
      expect(text).toContain(label);
      Option.getOrUndefined(
        Arr.findFirst(
          findAll<{ onPress?: () => void }>(tree, "Pressable"),
          (p) => allText(p) === label,
        ),
      )?.props.onPress?.();
    }
    const ws = baseWorkspace.slug;
    expect(visited).toEqual([
      { _tag: "Contact", ws, id: "new", mode: "edit" },
      { _tag: "DocumentNew", ws, kind: "invoice" },
      { _tag: "Settings", ws, section: "team" },
    ]);
    expect(allText(renderDashboard({ hasExpenses: RemoteOps.idle }))).not.toContain("Get started");
    expect(
      allText(
        renderDashboard({
          workspace: { ...baseWorkspace, role: "member" },
          hasExpenses: RemoteOps.ready(false),
        }),
      ),
    ).not.toContain("Invite your accountant");
  });

  test("shows workspace activity independently of the recent documents list", () => {
    const deliveryId = DeliveryId.make("01937c7a-0000-7000-8000-7632f070ecb7");
    const viewId = ShareViewId.make("01937c7a-0000-7000-8000-6ecac27ee677");
    const events = documentActivity(
      sampleDoc,
      {
        deliveries: [
          {
            id: deliveryId,
            to: [],
            purpose: "document",
            status: "sent",
            at: "2026-11-08T09:00:00Z",
          },
          {
            id: DeliveryId.make("01937c7a-0000-7000-8000-8bd4fbe392b0"),
            to: [],
            purpose: "document",
            status: "failed",
            at: "2026-11-09T09:00:00Z",
          },
          {
            id: DeliveryId.make("01937c7a-0000-7000-8000-fd21202fbc6c"),
            to: [],
            purpose: "reminder",
            status: "sent",
            at: "2026-11-09T09:00:00Z",
          },
        ],
      },
      [
        { id: "partial_1", createdAt: "2026-11-10T09:00:00Z" },
        { id: "malformed_1", createdAt: "invalid" },
      ],
      [
        {
          id: viewId,
          kind: "view",
          at: "2026-11-09T11:00:00Z",
          device: "mobile",
        },
      ],
    );
    expect(Arr.map(events, ({ id }) => id)).toEqual([
      `sent:${deliveryId}`,
      `viewed:${viewId}`,
      "paid:partial_1",
    ]);
    const text = allText(
      renderDashboard({
        activity: RemoteOps.ready(events),
        recentDocs: RemoteOps.fail(RemoteOps.idle, UiError.offline),
      }),
    );
    expect(text).toContain("Recent activity");
    expect(text).toContain("Recent documents");
    expect(text).toContain("Sent");
    expect(text).toContain("Viewed");
    expect(text).toContain("Payment recorded");
  });

  test("hides quick actions and shows closed banner for a closed workspace", () => {
    const tree = renderDashboard({ workspace: { ...baseWorkspace, closed: true } });

    const text = allText(tree);
    expect(text).toContain("This workspace is closed. Everything is read only.");
    expect(text).not.toContain("Quick actions");
    expect(text).toContain("Nothing is overdue. Nice.");
  });

  test("shows retryable error banner when dashboard fails offline", () => {
    let retried = 0;
    const tree = renderDashboard({
      dashboard: RemoteOps.fail(RemoteOps.idle, UiError.offline),
      onRetryDashboard: () => retried++,
    });

    expect(allText(tree)).toContain("Try again");
    const retryBtn = Option.getOrUndefined(
      Arr.findFirst(findAll<{ onPress?: () => void; children?: unknown }>(tree, "Pressable"), (p) =>
        Str.includes("Try again")(allText(p)),
      ),
    );
    retryBtn?.props.onPress?.();
    expect(retried).toBe(1);
  });
});
