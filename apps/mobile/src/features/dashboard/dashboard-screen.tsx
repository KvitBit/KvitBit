import type { DashboardView, WorkspaceSummary } from "@kvitbit/domain/contract";
import {
  inWorkspace,
  type KvitbitApiClient,
  type Remote,
  Remote as RemoteOps,
} from "@kvitbit/ui-port/api";
import { formatDate, formatDateTime, formatMoney, formatMonth } from "@kvitbit/ui-port/format";
import { type EnumKey, enumKey } from "@kvitbit/ui-port/i18n";
import type { Period, Route } from "@kvitbit/ui-port/view-models";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { useFocusEffect } from "expo-router";
import { AlertCircle, Camera, FilePlus2, FileText, MailPlus, UserPlus } from "lucide-react-native";
import { useCallback, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { navigate } from "../../navigation/routes";
import { useRemote } from "../../runtime/api-runtime";
import { useSession } from "../../session/session-provider";
import { useTheme } from "../../theme/theme-provider";
import {
  Badge,
  type BadgeTone,
  Banner,
  Button,
  Card,
  type Choice,
  EmptyState,
  ListRow,
  RemoteView,
  Screen,
  Section,
  SegmentedChoice,
  space,
  Text,
} from "../../ui";
import { useWorkspace } from "../../workspace/workspace-provider";
import type { ReceivableDocumentRow } from "../reports/model";
import { canManageInvitations } from "../settings/permissions";
import { loadOverdueDocuments, loadRecentDocuments, loadWorkspaceActivity } from "./data";
import {
  canWriteWorkspace,
  cashflowBarRatio,
  type DashboardActivity,
  type DashboardDocument,
  type DashboardPeriodPreset,
  isWorkspaceEmpty,
  maxCashflowAmount,
  periodRange,
  pragueToday,
  type RecentDashboardDocuments,
} from "./model";
import { usePagedFeed } from "./paged-feed";

const badgeForDocument = (
  doc: DashboardDocument,
): { readonly key: EnumKey<"badge">; readonly tone: BadgeTone } => {
  if (doc.status === "draft") return { key: "enum.badge.draft", tone: "draft" };
  if (doc.status === "cancelled") return { key: "enum.badge.cancelled", tone: "neutral" };
  if (doc.overdue) return { key: "enum.badge.overdue", tone: "warning" };
  if (doc.settlement === "paid") return { key: "enum.badge.paid", tone: "success" };
  if (doc.settlement === "partially_paid") {
    return { key: "enum.badge.partially_paid", tone: "info" };
  }
  if (doc.settlement === "credited") return { key: "enum.badge.credited", tone: "neutral" };
  if (doc.kind === "proforma") return { key: "enum.badge.proforma", tone: "proforma" };
  return { key: "enum.badge.issued", tone: "info" };
};

export interface DashboardContentProps {
  readonly workspace: WorkspaceSummary;
  readonly userName?: string | null;
  readonly preset: DashboardPeriodPreset;
  readonly reportPeriod: Period;
  readonly onSelectPreset: (preset: DashboardPeriodPreset) => void;
  readonly dashboard: Remote<DashboardView>;
  readonly onRetryDashboard: () => void;
  readonly overdueDocs: Remote<ReadonlyArray<ReceivableDocumentRow>>;
  readonly onRetryOverdue: () => void;
  readonly recentDocs: Remote<RecentDashboardDocuments>;
  readonly onRetryRecent: () => void;
  readonly activity: Remote<ReadonlyArray<DashboardActivity>>;
  readonly onRetryActivity: () => void;
  readonly hasExpenses: Remote<boolean>;
  readonly onNavigate: (route: Route) => void;
}

export function DashboardContent(props: DashboardContentProps) {
  const { t, locale, local } = useI18n();
  const theme = useTheme();
  const { workspace } = props;
  const ws = workspace.slug;
  const writable = canWriteWorkspace(workspace);
  const empty = writable && isWorkspaceEmpty(props.recentDocs, props.hasExpenses);
  const openReceivables = () =>
    props.onNavigate({ _tag: "Reports", ws, report: "receivables", period: props.reportPeriod });

  const periodChoices: ReadonlyArray<Choice<DashboardPeriodPreset>> = useMemo(
    () => [
      { value: "this_month", label: t("common.time.thisMonth") },
      { value: "last_month", label: t("common.time.lastMonth") },
      { value: "this_quarter", label: t("common.time.thisQuarter") },
      { value: "this_year", label: t("common.time.thisYear") },
    ],
    [t],
  );

  const header = (
    <>
      {props.userName !== null && props.userName !== undefined && props.userName !== "" ? (
        <Text variant="titleMedium" color="onSurfaceVariant">
          {t("dashboard.greeting", { name: props.userName })}
        </Text>
      ) : null}

      {workspace.closed ? <Banner tone="warning" text={t("shell.closedWorkspace")} /> : null}
    </>
  );

  if (empty) {
    return (
      <View style={styles.stack}>
        {header}
        <Section title={t("dashboard.quick.title")}>
          <Card style={styles.listCard}>
            <ListRow
              leading={UserPlus}
              title={t("dashboard.quick.addContact")}
              onPress={() => props.onNavigate({ _tag: "Contact", ws, id: "new", mode: "edit" })}
            />
            <ListRow
              leading={FilePlus2}
              title={t("dashboard.quick.firstInvoice")}
              onPress={() => props.onNavigate({ _tag: "DocumentNew", ws, kind: "invoice" })}
            />
            {canManageInvitations(workspace.role, workspace.closed) ? (
              <ListRow
                leading={MailPlus}
                title={local({
                  cs: "Pozvěte svou účetní nebo účetního",
                  en: "Invite your accountant",
                })}
                onPress={() => props.onNavigate({ _tag: "Settings", ws, section: "team" })}
              />
            ) : null}
          </Card>
        </Section>
      </View>
    );
  }

  return (
    <View style={styles.stack}>
      {header}

      <SegmentedChoice
        label={t("reports.suite.period")}
        value={props.preset}
        choices={periodChoices}
        onChange={props.onSelectPreset}
      />

      {writable ? (
        <Section title={local({ cs: "Rychlé akce", en: "Quick actions" })}>
          <View style={styles.quickActions}>
            <Button
              label={t("shell.fab.newInvoice")}
              icon={FilePlus2}
              onPress={() => props.onNavigate({ _tag: "DocumentNew", ws, kind: "invoice" })}
              testID="dashboard-action-new-invoice"
            />
            <Button
              kind="tonal"
              label={t("shell.fab.snapReceipt")}
              icon={Camera}
              onPress={() => props.onNavigate({ _tag: "ExpenseCapture", ws })}
              testID="dashboard-action-capture-expense"
            />
            <Button
              kind="outlined"
              label={t("dashboard.quick.addContact")}
              icon={UserPlus}
              onPress={() => props.onNavigate({ _tag: "Contact", ws, id: "new", mode: "edit" })}
              testID="dashboard-action-add-contact"
            />
          </View>
        </Section>
      ) : null}

      <RemoteView state={props.dashboard} onRetry={props.onRetryDashboard}>
        {(data) => {
          const cashflowMax = maxCashflowAmount(data.cashflow);
          return (
            <View style={styles.stack}>
              <View style={styles.kpiGrid}>
                <Card
                  style={styles.kpiCard}
                  accessibilityLabel={t("dashboard.tile.revenue")}
                  onPress={() =>
                    props.onNavigate({
                      _tag: "Reports",
                      ws,
                      report: "revenue",
                      period: props.reportPeriod,
                    })
                  }
                >
                  <Text variant="labelMedium" color="onSurfaceVariant">
                    {t("dashboard.tile.revenue")}
                  </Text>
                  <Text variant="headlineSmall" numeric>
                    {formatMoney(locale, data.revenue)}
                  </Text>
                </Card>

                <Card
                  style={styles.kpiCard}
                  accessibilityLabel={t("dashboard.tile.expenses")}
                  onPress={() =>
                    props.onNavigate({
                      _tag: "Reports",
                      ws,
                      report: "expenses",
                      period: props.reportPeriod,
                    })
                  }
                >
                  <Text variant="labelMedium" color="onSurfaceVariant">
                    {t("dashboard.tile.expenses")}
                  </Text>
                  <Text variant="headlineSmall" numeric>
                    {formatMoney(locale, data.expenses)}
                  </Text>
                </Card>

                <Card
                  style={styles.kpiCard}
                  accessibilityLabel={t("dashboard.tile.unpaid")}
                  onPress={openReceivables}
                >
                  <Text variant="labelMedium" color="onSurfaceVariant">
                    {t("dashboard.tile.unpaid")}
                  </Text>
                  <Text variant="headlineSmall" numeric>
                    {formatMoney(locale, data.unpaid)}
                  </Text>
                </Card>

                <Card
                  style={styles.kpiCard}
                  accessibilityLabel={t("dashboard.tile.overdue")}
                  onPress={openReceivables}
                >
                  <View style={styles.kpiHead}>
                    <Text variant="labelMedium" color="onSurfaceVariant">
                      {t("dashboard.tile.overdue")}
                    </Text>
                    {data.overdue.count > 0 ? (
                      <Badge
                        tone="warning"
                        label={t("dashboard.tile.countInvoices", { count: data.overdue.count })}
                      />
                    ) : null}
                  </View>
                  <Text variant="headlineSmall" numeric>
                    {formatMoney(locale, data.overdue.total)}
                  </Text>
                </Card>
              </View>

              {data.incompleteExpenses > 0 ? (
                <Card
                  accessibilityLabel={local({
                    cs: "Nedokončené náklady",
                    en: "Incomplete expenses",
                  })}
                  onPress={() =>
                    props.onNavigate({
                      _tag: "Expenses",
                      ws,
                      query: { incomplete: true },
                    })
                  }
                >
                  <ListRow
                    leading={AlertCircle}
                    title={local({
                      cs: "Nedokončené náklady",
                      en: "Incomplete expenses",
                    })}
                    subtitle={local({
                      cs: "Doplňte chybějící údaje pro účetnictví",
                      en: "Finish missing details for your books",
                    })}
                    badge={<Badge tone="warning" label={String(data.incompleteExpenses)} />}
                  />
                </Card>
              ) : null}

              {data.cashflow.length > 0 ? (
                <Section
                  title={t("dashboard.cashflow.title")}
                  action={
                    <Button
                      kind="text"
                      label={t("common.action.view")}
                      onPress={() =>
                        props.onNavigate({
                          _tag: "Reports",
                          ws,
                          report: "cashflow",
                          period: props.reportPeriod,
                        })
                      }
                    />
                  }
                >
                  <Card>
                    <View style={styles.legend}>
                      <View style={styles.legendItem}>
                        <View
                          style={[styles.legendDot, { backgroundColor: theme.colors.primary }]}
                        />
                        <Text variant="labelSmall" color="onSurfaceVariant">
                          {t("dashboard.cashflow.income")}
                        </Text>
                      </View>
                      <View style={styles.legendItem}>
                        <View
                          style={[styles.legendDot, { backgroundColor: theme.colors.tertiary }]}
                        />
                        <Text variant="labelSmall" color="onSurfaceVariant">
                          {t("dashboard.cashflow.outgoing")}
                        </Text>
                      </View>
                    </View>
                    <View style={styles.bars}>
                      {Arr.map(data.cashflow, (point) => {
                        const inPct = Math.round(
                          cashflowBarRatio(point.in.amount, cashflowMax) * 100,
                        );
                        const outPct = Math.round(
                          cashflowBarRatio(point.out.amount, cashflowMax) * 100,
                        );
                        return (
                          <View key={point.month} style={styles.barRow}>
                            <View style={styles.barLabelRow}>
                              <Text variant="meta" color="onSurfaceVariant">
                                {formatMonth(locale, point.month)}
                              </Text>
                              <Text variant="meta" numeric>
                                {formatMoney(locale, point.net, { signed: true })}
                              </Text>
                            </View>
                            <View style={styles.barTracks}>
                              <View
                                style={[
                                  styles.barFill,
                                  {
                                    width: `${Math.max(inPct, 2)}%`,
                                    backgroundColor: theme.colors.primary,
                                  },
                                ]}
                              />
                              <View
                                style={[
                                  styles.barFill,
                                  {
                                    width: `${Math.max(outPct, 2)}%`,
                                    backgroundColor: theme.colors.tertiary,
                                  },
                                ]}
                              />
                            </View>
                          </View>
                        );
                      })}
                    </View>
                  </Card>
                </Section>
              ) : null}
            </View>
          );
        }}
      </RemoteView>

      <Section
        title={t("dashboard.overdue.title")}
        action={<Button kind="text" label={t("common.action.view")} onPress={openReceivables} />}
      >
        <RemoteView state={props.overdueDocs} onRetry={props.onRetryOverdue}>
          {(docs) =>
            docs.length === 0 ? (
              <Card>
                <EmptyState title={t("dashboard.overdue.empty")} />
              </Card>
            ) : (
              <Card style={styles.listCard}>
                {Arr.map(docs, (doc) => (
                  <ListRow
                    key={doc.id}
                    leading={FileText}
                    title={doc.number ?? t(enumKey("documentKind", doc.kind))}
                    subtitle={`${doc.contact.name}${doc.dueOn === null ? "" : ` · ${formatDate(locale, doc.dueOn)}`}`}
                    trailing={formatMoney(locale, doc.outstanding)}
                    badge={<Badge tone="warning" label={t("enum.badge.overdue")} />}
                    onPress={() =>
                      props.onNavigate({ _tag: "Document", ws, id: doc.id, tab: "preview" })
                    }
                  />
                ))}
              </Card>
            )
          }
        </RemoteView>
      </Section>

      <Section title={t("dashboard.recent.title")}>
        <RemoteView state={props.activity} onRetry={props.onRetryActivity}>
          {(events) =>
            events.length === 0 ? (
              <Card>
                <EmptyState title={t("dashboard.recent.empty")} />
              </Card>
            ) : (
              <Card style={styles.listCard}>
                {Arr.map(events, ({ id, document, kind, at }) => (
                  <ListRow
                    key={id}
                    leading={FileText}
                    title={document.number ?? t(enumKey("documentKind", document.kind))}
                    subtitle={formatDateTime(locale, at)}
                    badge={
                      <Badge
                        tone={kind === "paid" ? "success" : "info"}
                        label={
                          kind === "paid"
                            ? local({ cs: "Platba zaznamenána", en: "Payment recorded" })
                            : t(enumKey("badge", kind))
                        }
                      />
                    }
                    onPress={() =>
                      props.onNavigate({ _tag: "Document", ws, id: document.id, tab: "preview" })
                    }
                  />
                ))}
              </Card>
            )
          }
        </RemoteView>
      </Section>

      <Section
        title={local({ cs: "Poslední doklady", en: "Recent documents" })}
        action={
          <Button
            kind="text"
            label={t("common.action.view")}
            onPress={() => props.onNavigate({ _tag: "Documents", ws, query: {} })}
          />
        }
      >
        <RemoteView state={props.recentDocs} onRetry={props.onRetryRecent}>
          {({ items: docs }) =>
            docs.length === 0 ? (
              <Card>
                <EmptyState title={local({ cs: "Zatím žádné doklady", en: "No documents yet" })} />
              </Card>
            ) : (
              <Card style={styles.listCard}>
                {Arr.map(docs, (doc) => {
                  const badge = badgeForDocument(doc);
                  return (
                    <ListRow
                      key={doc.id}
                      leading={FileText}
                      title={doc.number ?? t(enumKey("documentKind", doc.kind))}
                      subtitle={`${doc.contactName} · ${formatDate(locale, doc.issuedOn)}`}
                      trailing={formatMoney(locale, doc.total)}
                      badge={<Badge tone={badge.tone} label={t(badge.key)} />}
                      onPress={() =>
                        props.onNavigate({ _tag: "Document", ws, id: doc.id, tab: "preview" })
                      }
                    />
                  );
                })}
              </Card>
            )
          }
        </RemoteView>
      </Section>
    </View>
  );
}

export function DashboardScreen() {
  const { workspace } = useWorkspace();
  return <WorkspaceDashboard key={workspace.id} workspace={workspace} />;
}

function WorkspaceDashboard({ workspace }: { readonly workspace: WorkspaceSummary }) {
  const session = useSession();
  const { t } = useI18n();
  const [preset, setPreset] = useState<DashboardPeriodPreset>("this_month");
  const visited = useRef<boolean>(false);
  const today = useMemo(() => pragueToday(), []);
  const range = useMemo(() => periodRange(preset, today), [preset, today]);

  const dashboard = useRemote(
    (api) =>
      api.reports.dashboard({
        params: inWorkspace(workspace.id),
        query: { from: range.from, to: range.to },
      }),
    [workspace.id, range.from, range.to],
  );

  const overdueDocs = useRemote(
    (api) =>
      loadOverdueDocuments({ api, workspaceId: workspace.id, query: { from: today, to: today } }),
    [workspace.id, today],
  );

  const recentDocs = useRemote(
    (api) => loadRecentDocuments({ api, workspaceId: workspace.id }),
    [workspace.id],
  );

  const loadActivity = useCallback(
    (api: KvitbitApiClient) => loadWorkspaceActivity({ api, workspaceId: workspace.id }),
    [workspace.id],
  );
  const activity = usePagedFeed(loadActivity);

  const hasExpenses = useRemote(
    canWriteWorkspace(workspace)
      ? (api) =>
          Effect.map(
            api.expenses.list({ params: inWorkspace(workspace.id), query: { limit: 1 } }),
            (page) => page.items.length > 0 || page.nextCursor !== null,
          )
      : null,
    [workspace.id, workspace.role, workspace.closed],
  );

  const refreshing = Arr.some(
    [dashboard.state, overdueDocs.state, recentDocs.state, hasExpenses.state],
    (state) => RemoteOps.isBusy<unknown, unknown>(state),
  );

  const reloadDashboard = dashboard.reload;
  const reloadOverdue = overdueDocs.reload;
  const reloadRecent = recentDocs.reload;
  const reloadActivity = activity.reload;
  const reloadExpenses = hasExpenses.reload;
  const onRefresh = useCallback(() => {
    reloadDashboard();
    reloadOverdue();
    reloadRecent();
    reloadExpenses();
    reloadActivity();
  }, [reloadDashboard, reloadOverdue, reloadRecent, reloadExpenses, reloadActivity]);

  useFocusEffect(
    useCallback(() => {
      if (visited.current) onRefresh();
      visited.current = true;
    }, [onRefresh]),
  );

  const userName = session.state.status === "signed-in" ? session.state.user.name : null;

  return (
    <Screen
      title={workspace.name || t("dashboard.title")}
      onRefresh={onRefresh}
      refreshing={refreshing}
    >
      <DashboardContent
        workspace={workspace}
        userName={userName}
        preset={preset}
        reportPeriod={range.reportPeriod}
        onSelectPreset={setPreset}
        dashboard={dashboard.state}
        onRetryDashboard={reloadDashboard}
        overdueDocs={overdueDocs.state}
        onRetryOverdue={reloadOverdue}
        recentDocs={recentDocs.state}
        onRetryRecent={reloadRecent}
        activity={activity.state}
        onRetryActivity={reloadActivity}
        hasExpenses={hasExpenses.state}
        onNavigate={(route) => navigate(route)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.lg },
  quickActions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  kpiGrid: { flexDirection: "row", flexWrap: "wrap", gap: space.md },
  kpiCard: { flexGrow: 1, flexBasis: "45%", minWidth: 148 },
  kpiHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.xs,
  },
  listCard: { padding: space.xs, gap: 0 },
  legend: { flexDirection: "row", gap: space.lg },
  legendItem: { flexDirection: "row", alignItems: "center", gap: space.xs },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  bars: { gap: space.md },
  barRow: { gap: space.xs },
  barLabelRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  barTracks: { gap: 4 },
  barFill: { height: 6, borderRadius: 3 },
});
