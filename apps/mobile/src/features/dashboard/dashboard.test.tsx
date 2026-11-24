import { describe, expect, mock, test } from "bun:test";
import type {
  CurrencyCode,
  DashboardView,
  DocumentId,
  IsoDate,
  WorkspaceId,
  WorkspaceSlug,
  WorkspaceSummary,
} from "@kvitbit/domain/contract";
import { Remote as RemoteOps, UiError } from "@kvitbit/ui-port/api";
import type { Period, Route } from "@kvitbit/ui-port/view-models";
import { BigDecimal } from "effect";
import type { ReactElement } from "react";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import {
  canWriteWorkspace,
  cashflowBarRatio,
  type DashboardDocument,
  isWorkspaceEmpty,
  maxCashflowAmount,
  parseDocumentSummaries,
  periodRange,
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
  cashflow: [
    { month: "2026-10", in: money(80000), out: money(30000), net: money(50000) },
    { month: "2026-11", in: money(125000), out: money(41200), net: money(83800) },
  ],
};

const sampleDoc: DashboardDocument = {
  id: "doc_1" as DocumentId,
  kind: "invoice",
  number: "2026-0042",
  status: "issued",
  locked: false,
  settlement: "unpaid",
  overdue: true,
  contactName: "Novák s.r.o.",
  issuedOn: "2026-10-15" as IsoDate,
  dueOn: "2026-10-29" as IsoDate,
  total: money(14500),
};

const within = (node: ReactElement) => <TestProviders>{node}</TestProviders>;

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

  test("computes cashflow bar ratios safely and detects empty workspaces", () => {
    const max = maxCashflowAmount(sampleDashboard.cashflow);
    expect(cashflowBarRatio(BigDecimal.fromNumberUnsafe(125000), max)).toBe(1);
    expect(cashflowBarRatio(BigDecimal.fromNumberUnsafe(0), BigDecimal.fromNumberUnsafe(0))).toBe(
      0,
    );

    expect(isWorkspaceEmpty(sampleDashboard, 1)).toBe(false);
    expect(
      isWorkspaceEmpty(
        {
          ...sampleDashboard,
          revenue: money(0),
          expenses: money(0),
          unpaid: money(0),
          overdue: { total: money(0), count: 0 },
          incompleteExpenses: 0,
        },
        0,
      ),
    ).toBe(true);
  });

  test("restricts writes for closed workspaces and accountants", () => {
    expect(canWriteWorkspace(baseWorkspace)).toBe(true);
    expect(canWriteWorkspace({ ...baseWorkspace, closed: true })).toBe(false);
    expect(canWriteWorkspace({ ...baseWorkspace, role: "accountant" })).toBe(false);
  });
});

describe("DashboardContent", () => {
  test("renders KPIs, incomplete expenses, overdue/recent docs and navigates on press", () => {
    const visited: Route[] = [];
    const tree = hostTree(
      <DashboardContent
        workspace={baseWorkspace}
        userName="Filip"
        preset="this_month"
        reportPeriod={"2026-11" as Period}
        onSelectPreset={() => undefined}
        dashboard={RemoteOps.ready(sampleDashboard)}
        onRetryDashboard={() => undefined}
        overdueDocs={RemoteOps.ready([sampleDoc])}
        onRetryOverdue={() => undefined}
        recentDocs={RemoteOps.ready([sampleDoc])}
        onRetryRecent={() => undefined}
        onNavigate={(r) => visited.push(r)}
      />,
      within,
    ) as ReactElement<HostProps>;

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

    const pressables = findAll<{ testID?: string; onPress?: () => void }>(tree, "Pressable");
    pressables.find((p) => p.props.testID === "dashboard-action-new-invoice")?.props.onPress?.();
    pressables
      .find((p) => p.props.testID === "dashboard-action-capture-expense")
      ?.props.onPress?.();
    pressables.find((p) => p.props.testID === "dashboard-action-add-contact")?.props.onPress?.();

    expect(visited.map((r) => r._tag)).toEqual(["DocumentNew", "ExpenseCapture", "Contact"]);
  });

  test("hides quick actions and shows closed banner for a closed workspace", () => {
    const tree = hostTree(
      <DashboardContent
        workspace={{ ...baseWorkspace, closed: true }}
        preset="this_month"
        reportPeriod={"2026-11" as Period}
        onSelectPreset={() => undefined}
        dashboard={RemoteOps.ready(sampleDashboard)}
        onRetryDashboard={() => undefined}
        overdueDocs={RemoteOps.ready([])}
        onRetryOverdue={() => undefined}
        recentDocs={RemoteOps.ready([])}
        onRetryRecent={() => undefined}
        onNavigate={() => undefined}
      />,
      within,
    ) as ReactElement<HostProps>;

    const text = allText(tree);
    expect(text).toContain("This workspace is closed. Everything is read only.");
    expect(text).not.toContain("Quick actions");
    expect(text).toContain("Nothing is overdue. Nice.");
  });

  test("shows retryable error banner when dashboard fails offline", () => {
    let retried = 0;
    const tree = hostTree(
      <DashboardContent
        workspace={baseWorkspace}
        preset="this_month"
        reportPeriod={"2026-11" as Period}
        onSelectPreset={() => undefined}
        dashboard={RemoteOps.fail(RemoteOps.idle, UiError.offline)}
        onRetryDashboard={() => retried++}
        overdueDocs={RemoteOps.ready([])}
        onRetryOverdue={() => undefined}
        recentDocs={RemoteOps.ready([])}
        onRetryRecent={() => undefined}
        onNavigate={() => undefined}
      />,
      within,
    ) as ReactElement<HostProps>;

    expect(allText(tree)).toContain("Try again");
    const retryBtn = findAll<{ onPress?: () => void; children?: unknown }>(tree, "Pressable").find(
      (p) => allText(p).includes("Try again"),
    );
    retryBtn?.props.onPress?.();
    expect(retried).toBe(1);
  });
});
