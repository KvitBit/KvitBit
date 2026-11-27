import type { CurrencyCode, ExpenseId } from "@kvitbit/domain/contract";
import { formatDate, formatMoney } from "@kvitbit/ui-port/format";
import { Camera, Paperclip, Plus, Receipt } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { navigate } from "../../navigation/routes";
import { useApi, useRemote } from "../../runtime/api-runtime";
import {
  Badge,
  type BadgeTone,
  Button,
  type Choice,
  EmptyState,
  IconButton,
  ListRow,
  RemoteView,
  Screen,
  Section,
  SegmentedChoice,
  Text,
  TextField,
} from "../../ui";
import { useWorkspace } from "../../workspace/workspace-provider";
import { canWriteWorkspace } from "../dashboard/model";
import {
  decodeExpenseSummary,
  type ExpenseSettlement,
  type ExpenseStatusFilter,
  type ExpenseSummaryData,
  extractCategories,
  filterExpenses,
} from "./model";

const settlementTone = (s: ExpenseSettlement): BadgeTone => {
  switch (s) {
    case "paid":
      return "success";
    case "partially_paid":
      return "warning";
    case "overpaid":
      return "info";
    case "unpaid":
      return "neutral";
  }
};

export function ExpensesListScreen(props: {
  readonly initialIncomplete?: boolean;
  readonly initialSearch?: string;
}) {
  const { workspace } = useWorkspace();
  const writable = canWriteWorkspace(workspace);
  const { t, locale, local } = useI18n();
  const api = useApi();

  const [statusFilter, setStatusFilter] = useState<ExpenseStatusFilter>(
    props.initialIncomplete === true ? "incomplete" : "all",
  );
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [search, setSearch] = useState(props.initialSearch ?? "");
  const [extraPages, setExtraPages] = useState<ReadonlyArray<ExpenseSummaryData>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const remote = useRemote(
    (client) =>
      client.expenses.list({
        params: { workspaceId: workspace.id },
        query: statusFilter === "incomplete" ? { incomplete: true } : {},
      }),
    [workspace.id, statusFilter],
  );

  const handleRefresh = useCallback(() => {
    setExtraPages([]);
    setNextCursor(null);
    remote.reload();
  }, [remote]);

  const handleStatusChange = useCallback((next: ExpenseStatusFilter) => {
    setStatusFilter(next);
    setExtraPages([]);
    setNextCursor(null);
  }, []);

  const openCapture = useCallback(() => {
    if (!writable) return;
    navigate({ _tag: "ExpenseCapture", ws: workspace.slug });
  }, [workspace.slug, writable]);

  const openNew = useCallback(() => {
    if (!writable) return;
    navigate({ _tag: "Expense", ws: workspace.slug, id: "new", mode: "edit" });
  }, [workspace.slug, writable]);

  const openDetail = useCallback(
    (id: ExpenseId) => {
      navigate({ _tag: "Expense", ws: workspace.slug, id, mode: "view" });
    },
    [workspace.slug],
  );

  const statusChoices: ReadonlyArray<Choice<ExpenseStatusFilter>> = useMemo(
    () => [
      { value: "all", label: t("common.state.all") },
      { value: "complete", label: t("enum.expenseStatus.complete") },
      { value: "incomplete", label: t("enum.expenseStatus.incomplete") },
    ],
    [t],
  );

  const loadMore = useCallback(
    async (cursor: string) => {
      setLoadingMore(true);
      const result = await api.run((client) =>
        client.expenses.list({
          params: { workspaceId: workspace.id },
          query: {
            ...(statusFilter === "incomplete" ? { incomplete: true } : {}),
            cursor,
          },
        }),
      );
      setLoadingMore(false);
      if (result._tag === "Ok") {
        setExtraPages((prev) => [...prev, ...result.value.items.map(decodeExpenseSummary)]);
        setNextCursor(result.value.nextCursor);
      }
    },
    [api, workspace.id, statusFilter],
  );

  return (
    <Screen
      title={t("expenses.list.title")}
      onRefresh={handleRefresh}
      refreshing={remote.state._tag === "Loading"}
      actions={
        writable ? (
          <>
            <IconButton icon={Camera} label={t("expenses.capture.title")} onPress={openCapture} />
            <IconButton icon={Plus} label={t("expenses.list.new")} onPress={openNew} />
          </>
        ) : null
      }
    >
      <View className="gap-3">
        <TextField
          label={t("common.field.search")}
          placeholder={t("expenses.list.search")}
          value={search}
          onChangeText={setSearch}
          testID="expenses-search"
        />
        <SegmentedChoice
          value={statusFilter}
          choices={statusChoices}
          onChange={handleStatusChange}
        />
      </View>

      <RemoteView state={remote.state} onRetry={handleRefresh}>
        {(page) => {
          const decodedFirst = page.items.map(decodeExpenseSummary);
          const allItems = [...decodedFirst, ...extraPages];
          const effectiveCursor = extraPages.length > 0 ? nextCursor : page.nextCursor;
          const categories = extractCategories(allItems);
          const filtered = filterExpenses(allItems, {
            status: statusFilter,
            category: categoryFilter,
            search,
          });

          if (allItems.length === 0 && search.trim() === "" && categoryFilter === null) {
            return (
              <EmptyState
                title={t("expenses.list.empty.title")}
                body={t("expenses.list.empty.mobile")}
                {...(writable
                  ? { action: { label: t("expenses.capture.title"), onPress: openCapture } }
                  : {})}
              />
            );
          }

          return (
            <>
              {categories.length === 0 ? null : (
                <SegmentedChoice<string>
                  label={t("common.field.category")}
                  value={categoryFilter ?? "__all__"}
                  choices={[
                    { value: "__all__", label: t("common.state.all") },
                    ...categories.map((cat) => ({ value: cat, label: cat })),
                  ]}
                  onChange={(next) => setCategoryFilter(next === "__all__" ? null : next)}
                />
              )}

              {filtered.length === 0 ? (
                <EmptyState
                  title={t("common.state.noMatches")}
                  body={t("common.state.noMatchesHint")}
                  action={{
                    label: t("common.action.clearFilters"),
                    onPress: () => {
                      setSearch("");
                      setCategoryFilter(null);
                      handleStatusChange("all");
                    },
                  }}
                />
              ) : (
                <Section>
                  {filtered.map((item) => {
                    const title =
                      item.supplierName ??
                      item.supplierDocumentNumber ??
                      local({ cs: "Neúplný náklad", en: "Incomplete expense" });
                    const metaParts: Array<string> = [];
                    if (item.supplierDocumentNumber !== null && item.supplierName !== null) {
                      metaParts.push(item.supplierDocumentNumber);
                    }
                    if (item.issuedOn !== null) {
                      try {
                        metaParts.push(formatDate(locale, item.issuedOn));
                      } catch {
                        metaParts.push(item.issuedOn);
                      }
                    }
                    if (item.category !== null) metaParts.push(item.category);
                    if (item.attachments > 0) metaParts.push(`📎 ${item.attachments}`);

                    const amountText =
                      item.total !== null && item.currency !== null
                        ? formatMoney(locale, {
                            amount: item.total,
                            currency: item.currency as CurrencyCode,
                          })
                        : item.total !== null
                          ? item.total
                          : "—";

                    const badge =
                      item.status === "incomplete" ? (
                        <Badge label={t("enum.badge.incomplete")} tone="warning" />
                      ) : (
                        <Badge
                          label={t(`enum.settlement.${item.settlement}`)}
                          tone={settlementTone(item.settlement)}
                        />
                      );

                    return (
                      <ListRow
                        key={item.id}
                        testID={`expense-row-${item.id}`}
                        leading={item.attachments > 0 ? Paperclip : Receipt}
                        title={title}
                        {...(metaParts.length > 0 ? { subtitle: metaParts.join(" · ") } : {})}
                        trailing={amountText}
                        badge={badge}
                        onPress={() => openDetail(item.id)}
                      />
                    );
                  })}
                </Section>
              )}

              {effectiveCursor === null ? null : (
                <View className="items-center py-2">
                  <Button
                    kind="outlined"
                    label={t("common.action.loadMore")}
                    busy={loadingMore}
                    onPress={() => void loadMore(effectiveCursor)}
                  />
                </View>
              )}
            </>
          );
        }}
      </RemoteView>

      <View className="flex-row flex-wrap gap-2">
        <Button
          kind="tonal"
          icon={Camera}
          label={t("expenses.capture.title")}
          onPress={openCapture}
        />
        <Button kind="outlined" icon={Plus} label={t("expenses.list.new")} onPress={openNew} />
      </View>
      {search.trim() !== "" ? (
        <Text variant="meta" color="onSurfaceVariant">
          {t("common.field.search")}: {search.trim()}
        </Text>
      ) : null}
    </Screen>
  );
}
