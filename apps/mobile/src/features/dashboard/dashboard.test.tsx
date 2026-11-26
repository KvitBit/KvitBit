import { describe, expect, mock, test } from "bun:test";
import type {
  CurrencyCode,
  DashboardView,
  DeliveryId,
  DocumentId,
  IsoDate,
  WorkspaceId,
  WorkspaceSlug,
  WorkspaceSummary,
} from "@kvitbit/domain/contract";
import { Remote as RemoteOps, UiError } from "@kvitbit/ui-port/api";
import { formatMoney, formatMonth } from "@kvitbit/ui-port/format";
import type { Period, Route } from "@kvitbit/ui-port/view-models";
import { BigDecimal } from "effect";
import type { ReactElement } from "react";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import type { ReceivableDocumentRow } from "../reports/model";
import type { DashboardContentProps } from "./dashboard-screen";
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
  recentActivityDocuments,
} from "./model";

mock.module("expo-router", () => expoRouterStandIn());

const { allText, findAll, hostTree } = await import("../../testing/element-tree");
type HostProps = import("../../testing/element-tree").HostProps;
const { TestProviders } = await import("../../testing/providers");
const { DashboardContent } = await import("./dashboard-screen");

const CZK = "CZK" as CurrencyCode;
const money = (n: number) => ({ amount: BigDecimal.fromNumberUnsafe(n), currency: CZK });

const baseWorkspace: WorkspaceSummary = {
  id: "ws_1" as WorkspaceId,
  slug: "acme" as WorkspaceSlug,
  name: "Acme s.r.o.",
  role: "owner",
  memberCount: 2,
  taxRegime: "vat_payer",
  closed: false,
};

const sampleDashboard: DashboardView = {
  period: { from: "2026-11-01" as IsoDate, to: "2026-11-30" as IsoDate },
  revenue: money(125000),
  unpaid: money(32000),
  overdue: { total: money(14500), count: 2 },
  expenses: money(41200),
  incompleteExpenses: 3,
  cashflow: Array.from({ length: 12 }, (_, index) => ({
    month: index === 0 ? "2025-12" : `2026-${String(index).padStart(2, "0")}`,
    in: money(125000),
    out: money(41200),
    net: money(83800),
  })),
};

const sampleDoc: DashboardDocument = {
  id: "doc_1" as DocumentId,
  kind: "invoice",
  number: "2026-0042",
  status: "issued",
  locked: false,
  settlement: "partially_paid",
  overdue: true,
  contactName: "Novák s.r.o.",
  issuedOn: "2026-10-15" as IsoDate,
  dueOn: "2026-10-29" as IsoDate,
  total: money(14500),
};

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
      reportPeriod={"2026-11" as Period}
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
  ) as ReactElement<HostProps>;

describe("dashboard model", () => {
  test("computes period ranges including January -> December rollover", () => {
    expect(periodRange("this_month", "2026-11-24" as IsoDate)).toEqual({
      from: "2026-11-01" as IsoDate,
      to: "2026-11-30" as IsoDate,
      reportPeriod: "2026-11" as Period,
    });
    expect(periodRange("last_month", "2026-01-10" as IsoDate)).toEqual({
      from: "2025-12-01" as IsoDate,
      to: "2025-12-31" as IsoDate,
      reportPeriod: "2025-12" as Period,
    });
    expect(periodRange("this_quarter", "2026-11-24" as IsoDate)).toEqual({
      from: "2026-10-01" as IsoDate,
      to: "2026-12-31" as IsoDate,
      reportPeriod: "2026-Q4" as Period,
    });
    expect(periodRange("this_year", "2026-11-24" as IsoDate)).toEqual({
      from: "2026-01-01" as IsoDate,
      to: "2026-12-31" as IsoDate,
      reportPeriod: "2026" as Period,
    });
  });

  test("parses valid DocumentSummary objects and drops malformed entries", () => {
    const parsed = parseDocumentSummaries([
      {
        id: "doc_1",
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
    expect(BigDecimal.format(parsed[0]?.total.amount ?? BigDecimal.fromNumberUnsafe(0))).toBe(
      "12100.5",
    );
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

  test("keeps the activity request tied to the last successful document page when refresh fails", () => {
    const refreshing = RemoteOps.load(recentDocuments);
    const failed = RemoteOps.fail(refreshing, UiError.offline);
    expect(recentActivityDocuments(failed)).toBe(recentActivityDocuments(recentDocuments));
    expect(recentActivityDocuments(failed)).toEqual([sampleDoc]);
    expect(recentActivityDocuments(RemoteOps.fail(RemoteOps.idle, UiError.offline))).toBeNull();
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
      buckets: buckets.map(({ bucket, days }) => ({
        bucket,
        count: days.length,
        total: overdueBalance,
        documents: days.map((daysOverdue) => ({ ...sampleReceivable, daysOverdue })),
      })),
      total: overdueBalance,
      overdue: { count: 9, total: overdueBalance },
    });
    expect(result.map(({ daysOverdue }) => daysOverdue)).toEqual([154, 91, 46, 39, 30]);
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
    pressables.find((p) => p.props.testID === "dashboard-action-new-invoice")?.props.onPress?.();
    pressables
      .find((p) => p.props.testID === "dashboard-action-capture-expense")
      ?.props.onPress?.();
    pressables.find((p) => p.props.testID === "dashboard-action-add-contact")?.props.onPress?.();
    pressables.find((p) => p.props.accessibilityLabel === "Unpaid")?.props.onPress?.();
    pressables.find((p) => p.props.accessibilityLabel === "Overdue")?.props.onPress?.();

    expect(visited.map((r) => r._tag)).toEqual([
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
      period: "2026-11" as Period,
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
      findAll<{ onPress?: () => void }>(tree, "Pressable")
        .find((p) => allText(p) === label)
        ?.props.onPress?.();
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

  test("labels activity as recent-document activity and only renders actual document events", () => {
    const events = documentActivity(
      sampleDoc,
      {
        deliveries: [
          {
            id: "sent_1" as DeliveryId,
            to: [],
            purpose: "document",
            status: "sent",
            at: "2026-11-08T09:00:00Z",
          },
          {
            id: "failed_1" as DeliveryId,
            to: [],
            purpose: "document",
            status: "failed",
            at: "2026-11-09T09:00:00Z",
          },
          {
            id: "reminder_1" as DeliveryId,
            to: [],
            purpose: "reminder",
            status: "sent",
            at: "2026-11-09T09:00:00Z",
          },
        ],
        share: { url: "https://example.com/share", views: 1, lastViewedAt: "2026-11-09T11:00:00Z" },
      },
      [
        { id: "partial_1", createdAt: "2026-11-10T09:00:00Z" },
        { id: "malformed_1", createdAt: "invalid" },
      ],
    );
    expect(events.map(({ id }) => id)).toEqual(["sent:sent_1", "viewed:doc_1", "paid:partial_1"]);
    const text = allText(
      renderDashboard({ activity: RemoteOps.ready(events), recentDocs: recentDocuments }),
    );
    expect(text).toContain("Activity on recent documents");
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
    const retryBtn = findAll<{ onPress?: () => void; children?: unknown }>(tree, "Pressable").find(
      (p) => allText(p).includes("Try again"),
    );
    retryBtn?.props.onPress?.();
    expect(retried).toBe(1);
  });
});
