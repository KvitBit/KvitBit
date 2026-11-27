import type { ExportFormat, ReportGroupBy } from "@kvitbit/api-contract";
import type { ReportKind } from "@kvitbit/domain/contract";
import { describeError } from "@kvitbit/ui-port/api";
import { formatDate, formatMoney } from "@kvitbit/ui-port/format";
import type { Period } from "@kvitbit/ui-port/view-models";
import { ChevronLeft, ChevronRight, FileSpreadsheet, FileText } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { navigate } from "../../navigation/routes";
import { useTransfer } from "../../platform/transfer";
import { useRemote } from "../../runtime/api-runtime";
import {
  Badge,
  type BadgeTone,
  Banner,
  Button,
  Card,
  type Choice,
  EmptyState,
  IconButton,
  ListRow,
  RemoteView,
  Screen,
  Section,
  SegmentedChoice,
  space,
  Text,
  useOverlay,
} from "../../ui";
import { useWorkspace } from "../../workspace/workspace-provider";
import {
  type AgingBucketKey,
  buildReportExportRequest,
  currentMonthPeriod,
  type DecodedReport,
  decodeReportView,
  periodPresets,
  periodToRange,
  REPORT_TABS,
  shiftPeriod,
} from "./model";

const agingTone = (bucket: AgingBucketKey): BadgeTone => {
  if (bucket === "not_due") return "info";
  if (bucket === "1_30") return "warning";
  return "danger";
};

export function ReportsScreen(props: {
  readonly report: ReportKind;
  readonly initialPeriod?: Period;
}) {
  const { workspace } = useWorkspace();
  const { t, text, locale, local } = useI18n();
  const transfer = useTransfer();
  const overlay = useOverlay();

  const [period, setPeriod] = useState<Period>(() => props.initialPeriod ?? currentMonthPeriod());
  const [groupBy, setGroupBy] = useState<ReportGroupBy>("month");
  const [exportBusy, setExportBusy] = useState<ExportFormat | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const range = useMemo(() => periodToRange(period), [period]);
  const presets = useMemo(() => periodPresets(), []);

  const supportsGroupBy = props.report === "revenue" || props.report === "expenses";
  const effectiveGroupBy: ReportGroupBy | undefined = supportsGroupBy
    ? props.report === "revenue" && groupBy === "category"
      ? "month"
      : groupBy
    : undefined;

  const remote = useRemote(
    (client) =>
      client.reports.run({
        params: { workspaceId: workspace.id, report: props.report },
        query: {
          from: range.from,
          to: range.to,
          ...(effectiveGroupBy !== undefined ? { groupBy: effectiveGroupBy } : {}),
        },
      }),
    [workspace.id, props.report, range.from, range.to, effectiveGroupBy],
  );

  const selectReport = useCallback(
    (next: ReportKind) => {
      navigate({ _tag: "Reports", ws: workspace.slug, report: next, period }, { replace: true });
    },
    [period, workspace.slug],
  );

  const handleExport = useCallback(
    async (format: ExportFormat) => {
      setExportError(null);
      setExportBusy(format);
      const req = buildReportExportRequest({
        workspaceId: workspace.id,
        report: props.report,
        period,
        format,
        ...(effectiveGroupBy !== undefined ? { groupBy: effectiveGroupBy } : {}),
      });
      const dl = await transfer.download(req);
      if (dl._tag === "Err") {
        setExportBusy(null);
        setExportError(text(describeError(dl.error).text));
        return;
      }
      const shared = await transfer.share(dl.value);
      setExportBusy(null);
      if (shared._tag === "Err") {
        setExportError(text(describeError(shared.error).text));
      } else {
        overlay.toast(t("reports.export.ready"));
      }
    },
    [effectiveGroupBy, overlay, period, props.report, t, text, transfer, workspace.id],
  );

  const agingLabel = (bucket: AgingBucketKey): string => {
    switch (bucket) {
      case "not_due":
        return local({ cs: "Před splatností", en: "Not due" });
      case "1_30":
        return local({ cs: "1–30 dní po splatnosti", en: "1–30 days overdue" });
      case "31_60":
        return local({ cs: "31–60 dní po splatnosti", en: "31–60 days overdue" });
      case "61_90":
        return local({ cs: "61–90 dní po splatnosti", en: "61–90 days overdue" });
      case "over_90":
        return local({ cs: "Nad 90 dní po splatnosti", en: "Over 90 days overdue" });
    }
  };

  const reportChoices: ReadonlyArray<Choice<ReportKind>> = useMemo(
    () => REPORT_TABS.map((kind) => ({ value: kind, label: t(`enum.reportKind.${kind}`) })),
    [t],
  );

  const groupChoices: ReadonlyArray<Choice<ReportGroupBy>> = useMemo(() => {
    const base: Array<ReportGroupBy> = ["month", "contact", "currency"];
    if (props.report === "expenses") base.push("category");
    return base.map((g) => ({ value: g, label: t(`enum.reportGroupBy.${g}`) }));
  }, [props.report, t]);

  const presetChoices: ReadonlyArray<Choice<Period>> = useMemo(
    () => [
      { value: presets.thisMonth, label: t("common.time.thisMonth") },
      { value: presets.lastMonth, label: t("common.time.lastMonth") },
      { value: presets.thisQuarter, label: t("common.time.thisQuarter") },
      { value: presets.thisYear, label: t("common.time.thisYear") },
    ],
    [presets, t],
  );

  const renderBody = (data: DecodedReport) => {
    switch (data.report) {
      case "vat_summary":
        return (
          <>
            <Banner
              tone="info"
              text={local({
                cs: "Orientační souhrn DPH v CZK. Nenahrazuje daňové přiznání.",
                en: "Informational VAT summary in CZK. Not a tax filing.",
              })}
            />
            <View style={styles.kpiRow}>
              <Card style={styles.kpiCard}>
                <Text variant="labelMedium" color="onSurfaceVariant">
                  {t("reports.suite.vat.output")}
                </Text>
                <Text variant="titleMedium" numeric>
                  {formatMoney(locale, data.totals.output)}
                </Text>
              </Card>
              <Card style={styles.kpiCard}>
                <Text variant="labelMedium" color="onSurfaceVariant">
                  {t("reports.suite.vat.input")}
                </Text>
                <Text variant="titleMedium" numeric>
                  {formatMoney(locale, data.totals.input)}
                </Text>
              </Card>
              <Card style={styles.kpiCard}>
                <Text variant="labelMedium" color="onSurfaceVariant">
                  {t("reports.suite.vat.balance")}
                </Text>
                <Text variant="titleMedium" numeric>
                  {formatMoney(locale, data.totals.payable)}
                </Text>
              </Card>
            </View>

            <Section title={t("reports.suite.vat.output")}>
              {data.output.length === 0 ? (
                <Text variant="meta" color="onSurfaceVariant">
                  {t("reports.suite.empty")}
                </Text>
              ) : (
                data.output.map((line) => (
                  <ListRow
                    key={`out-${line.month}-${line.treatment}-${line.ratePercent}`}
                    title={`${line.month} · ${t(`enum.vatTreatment.${line.treatment}`)} (${line.ratePercent} %)`}
                    subtitle={`${t("expenses.editor.base")}: ${formatMoney(locale, line.base)} · ${line.documents.length}×`}
                    trailing={formatMoney(locale, line.vat)}
                  />
                ))
              )}
            </Section>

            <Section title={t("reports.suite.vat.input")}>
              {data.input.length === 0 ? (
                <Text variant="meta" color="onSurfaceVariant">
                  {t("reports.suite.empty")}
                </Text>
              ) : (
                data.input.map((line) => (
                  <ListRow
                    key={`in-${line.month}-${line.treatment}-${line.ratePercent}`}
                    title={`${line.month} · ${t(`enum.vatTreatment.${line.treatment}`)} (${line.ratePercent} %)`}
                    subtitle={`${t("expenses.editor.base")}: ${formatMoney(locale, line.base)} · ${line.documents.length}×`}
                    trailing={formatMoney(locale, line.vat)}
                  />
                ))
              )}
            </Section>
          </>
        );

      case "profit":
        return (
          <>
            <View style={styles.kpiRow}>
              <Card style={styles.kpiCard}>
                <Text variant="labelMedium" color="onSurfaceVariant">
                  {t("reports.suite.profit.revenue")}
                </Text>
                <Text variant="titleMedium" numeric>
                  {formatMoney(locale, data.totals.revenue)}
                </Text>
              </Card>
              <Card style={styles.kpiCard}>
                <Text variant="labelMedium" color="onSurfaceVariant">
                  {t("reports.suite.profit.expenses")}
                </Text>
                <Text variant="titleMedium" numeric>
                  {formatMoney(locale, data.totals.expenses)}
                </Text>
              </Card>
              <Card style={styles.kpiCard}>
                <Text variant="labelMedium" color="onSurfaceVariant">
                  {t("reports.suite.profit.result")}
                </Text>
                <Text variant="titleMedium" numeric>
                  {formatMoney(locale, data.totals.profit)}
                </Text>
              </Card>
            </View>
            {data.rows.length === 0 ? (
              <EmptyState title={t("reports.suite.empty")} />
            ) : (
              <Section title={t("enum.reportKind.profit")}>
                {data.rows.map((row) => (
                  <ListRow
                    key={row.month}
                    title={row.month}
                    subtitle={`${t("reports.suite.profit.revenue")}: ${formatMoney(locale, row.revenue)} · ${t("reports.suite.profit.expenses")}: ${formatMoney(locale, row.expenses)}`}
                    trailing={formatMoney(locale, row.profit)}
                  />
                ))}
              </Section>
            )}
          </>
        );

      case "receivables":
        return (
          <>
            <View style={styles.kpiRow}>
              <Card style={styles.kpiCard}>
                <Text variant="labelMedium" color="onSurfaceVariant">
                  {t("reports.suite.receivables.unpaid")}
                </Text>
                <Text variant="titleMedium" numeric>
                  {formatMoney(locale, data.total)}
                </Text>
              </Card>
              <Card style={styles.kpiCard}>
                <Text variant="labelMedium" color="onSurfaceVariant">
                  {t("reports.suite.receivables.overdue")}
                </Text>
                <Text variant="titleMedium" numeric>
                  {formatMoney(locale, data.overdue.total)}
                </Text>
                <Text variant="meta" color="onSurfaceVariant">
                  {data.overdue.count}×
                </Text>
              </Card>
            </View>

            {data.buckets.every((b) => b.documents.length === 0) ? (
              <EmptyState title={t("reports.suite.empty")} />
            ) : (
              data.buckets
                .filter((b) => b.count > 0)
                .map((b) => (
                  <Section
                    key={b.bucket}
                    title={`${agingLabel(b.bucket)} (${b.count})`}
                    action={
                      <Badge label={formatMoney(locale, b.total)} tone={agingTone(b.bucket)} />
                    }
                  >
                    {b.documents.map((doc) => (
                      <ListRow
                        key={doc.id}
                        title={doc.number ?? doc.id}
                        subtitle={`${doc.contact.name}${doc.dueOn !== null ? ` · ${formatDate(locale, doc.dueOn)}` : ""}`}
                        trailing={formatMoney(locale, doc.outstandingCzk)}
                        {...(doc.currency !== "CZK"
                          ? { trailingSub: formatMoney(locale, doc.outstanding) }
                          : {})}
                        onPress={() =>
                          navigate({
                            _tag: "Document",
                            ws: workspace.slug,
                            id: doc.id,
                            tab: "preview",
                          })
                        }
                      />
                    ))}
                  </Section>
                ))
            )}
          </>
        );

      case "revenue":
      case "expenses":
        return (
          <>
            {data.report === "expenses" && data.incomplete > 0 ? (
              <Banner
                tone="warning"
                text={local({
                  cs: `Neúplné náklady mimo součet: ${data.incomplete}`,
                  en: `Incomplete expenses excluded: ${data.incomplete}`,
                })}
              />
            ) : null}
            <View style={styles.kpiRow}>
              <Card style={styles.kpiCard}>
                <Text variant="labelMedium" color="onSurfaceVariant">
                  {t("expenses.editor.base")}
                </Text>
                <Text variant="titleMedium" numeric>
                  {formatMoney(locale, data.totals.net)}
                </Text>
              </Card>
              <Card style={styles.kpiCard}>
                <Text variant="labelMedium" color="onSurfaceVariant">
                  {t("common.field.vat")}
                </Text>
                <Text variant="titleMedium" numeric>
                  {formatMoney(locale, data.totals.vat)}
                </Text>
              </Card>
              <Card style={styles.kpiCard}>
                <Text variant="labelMedium" color="onSurfaceVariant">
                  {t("common.field.total")}
                </Text>
                <Text variant="titleMedium" numeric>
                  {formatMoney(locale, data.totals.gross)}
                </Text>
              </Card>
            </View>
            {data.rows.length === 0 ? (
              <EmptyState title={t("reports.suite.empty")} />
            ) : (
              <Section title={t(`enum.reportKind.${data.report}`)}>
                {data.rows.map((row) => (
                  <ListRow
                    key={row.key}
                    title={row.label ?? (row.key === "" ? t("common.state.none") : row.key)}
                    subtitle={`${row.count}× · ${t("expenses.editor.base")}: ${formatMoney(locale, row.net)}`}
                    trailing={formatMoney(locale, row.gross)}
                    {...(row.original !== null
                      ? { trailingSub: formatMoney(locale, row.original) }
                      : {})}
                  />
                ))}
              </Section>
            )}
          </>
        );

      case "cashflow":
        return (
          <>
            <View style={styles.kpiRow}>
              <Card style={styles.kpiCard}>
                <Text variant="labelMedium" color="onSurfaceVariant">
                  {t("reports.suite.cashflow.in")}
                </Text>
                <Text variant="titleMedium" numeric>
                  {formatMoney(locale, data.totals.in)}
                </Text>
              </Card>
              <Card style={styles.kpiCard}>
                <Text variant="labelMedium" color="onSurfaceVariant">
                  {t("reports.suite.cashflow.out")}
                </Text>
                <Text variant="titleMedium" numeric>
                  {formatMoney(locale, data.totals.out)}
                </Text>
              </Card>
              <Card style={styles.kpiCard}>
                <Text variant="labelMedium" color="onSurfaceVariant">
                  {t("reports.suite.cashflow.net")}
                </Text>
                <Text variant="titleMedium" numeric>
                  {formatMoney(locale, data.totals.net)}
                </Text>
              </Card>
            </View>
            {data.points.length === 0 ? (
              <EmptyState title={t("reports.suite.empty")} />
            ) : (
              <Section title={t("enum.reportKind.cashflow")}>
                {data.points.map((pt) => (
                  <ListRow
                    key={pt.month}
                    title={pt.month}
                    subtitle={`+ ${formatMoney(locale, pt.in)} / − ${formatMoney(locale, pt.out)}`}
                    trailing={formatMoney(locale, pt.net)}
                  />
                ))}
              </Section>
            )}
          </>
        );
    }
  };

  return (
    <Screen
      title={t("reports.suite.title")}
      back
      onRefresh={remote.reload}
      refreshing={remote.state._tag === "Loading"}
    >
      <SegmentedChoice value={props.report} choices={reportChoices} onChange={selectReport} />

      <Card>
        <View style={styles.periodBar}>
          <IconButton
            icon={ChevronLeft}
            label={t("common.action.back")}
            onPress={() => setPeriod((p) => shiftPeriod(p, -1))}
          />
          <View style={styles.periodCenter}>
            <Text variant="titleMedium" numeric>
              {period}
            </Text>
            <Text variant="meta" color="onSurfaceVariant" numeric>
              {formatDate(locale, range.from)} – {formatDate(locale, range.to)}
            </Text>
          </View>
          <IconButton
            icon={ChevronRight}
            label={t("common.action.next")}
            onPress={() => setPeriod((p) => shiftPeriod(p, 1))}
          />
        </View>
        <SegmentedChoice value={period} choices={presetChoices} onChange={setPeriod} />
        {!supportsGroupBy ? null : (
          <SegmentedChoice
            label={t("reports.suite.groupBy")}
            value={effectiveGroupBy ?? "month"}
            choices={groupChoices}
            onChange={setGroupBy}
          />
        )}
      </Card>

      {exportError === null ? null : <Banner text={exportError} />}

      <View style={styles.exportRow}>
        <Button
          kind="tonal"
          icon={FileSpreadsheet}
          label={`${t("reports.suite.export")} ${t("enum.exportFormat.csv")}`}
          busy={exportBusy === "csv"}
          disabled={exportBusy !== null && exportBusy !== "csv"}
          onPress={() => void handleExport("csv")}
          testID="report-export-csv"
        />
        <Button
          kind="outlined"
          icon={FileText}
          label={`${t("reports.suite.export")} ${t("enum.exportFormat.pdf")}`}
          busy={exportBusy === "pdf"}
          disabled={exportBusy !== null && exportBusy !== "pdf"}
          onPress={() => void handleExport("pdf")}
          testID="report-export-pdf"
        />
      </View>

      <RemoteView state={remote.state} onRetry={remote.reload}>
        {(raw) => renderBody(decodeReportView(raw, props.report))}
      </RemoteView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  periodBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  periodCenter: { alignItems: "center", flex: 1 },
  exportRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  kpiRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  kpiCard: { flex: 1, minWidth: 140 },
});
