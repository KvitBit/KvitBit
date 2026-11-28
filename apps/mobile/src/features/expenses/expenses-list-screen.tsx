import type { ExpenseId } from "@kvitbit/domain/contract";
import type { KvitbitApiClient } from "@kvitbit/ui-port/api";
import { formatDate, formatMoney, parseIsoDate } from "@kvitbit/ui-port/format";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import { Camera, Paperclip, Plus, Receipt } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { navigate } from "../../navigation/routes";
import { useApi, useRemote } from "../../runtime/api-runtime";
import { fromMobilePromise } from "../../runtime/request-intent";
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
  space,
  Text,
  TextField,
} from "../../ui";
import { useWorkspace } from "../../workspace/workspace-provider";
import { canWriteWorkspace } from "../dashboard/model";
import { runFeatureEffect } from "../ui-effect";
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
    useCallback(
      (client: KvitbitApiClient) =>
        client.expenses.list({
          params: { workspaceId: workspace.id },
          query: statusFilter === "incomplete" ? { incomplete: true } : {},
        }),
      [workspace.id, statusFilter],
    ),
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
    (cursor: string) =>
      runFeatureEffect(
        Effect.gen(function* () {
          setLoadingMore(true);
          const result = yield* fromMobilePromise(() =>
            api.run((client) =>
              client.expenses.list({
                params: { workspaceId: workspace.id },
                query: statusFilter === "incomplete" ? { incomplete: true, cursor } : { cursor },
              }),
            ),
          );
          setLoadingMore(false);
          if (result._tag === "Ok") {
            setExtraPages((prev) => [
              ...prev,
              ...Arr.filterMap(result.value.items, (item) =>
                Result.fromNullishOr(decodeExpenseSummary(item), () => undefined),
              ),
            ]);
            setNextCursor(result.value.nextCursor);
          }
        }),
      ),
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
      <View style={styles.filters}>
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
          const decodedFirst = Arr.filterMap(page.items, (item) =>
            Result.fromNullishOr(decodeExpenseSummary(item), () => undefined),
          );
          const allItems = [...decodedFirst, ...extraPages];
          const effectiveCursor = extraPages.length > 0 ? nextCursor : page.nextCursor;
          const categories = extractCategories(allItems);
          const filtered = filterExpenses(allItems, {
            status: statusFilter,
            category: categoryFilter,
            search,
          });

          if (allItems.length === 0 && Str.trim(search) === "" && categoryFilter === null) {
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
                    ...Arr.map(categories, (cat) => ({ value: cat, label: cat })),
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
                  {Arr.map(filtered, (item) => {
                    const title =
                      item.supplierName ??
                      item.supplierDocumentNumber ??
                      local({ cs: "Neúplný náklad", en: "Incomplete expense" });
                    const metaParts: Array<string> = [];
                    if (item.supplierDocumentNumber !== null && item.supplierName !== null) {
                      metaParts.push(item.supplierDocumentNumber);
                    }
                    if (item.issuedOn !== null) {
                      const date = parseIsoDate(item.issuedOn);
                      metaParts.push(
                        date === undefined ? item.issuedOn : formatDate({ locale, date }),
                      );
                    }
                    if (item.category !== null) metaParts.push(item.category);
                    if (item.attachments > 0) metaParts.push(`📎 ${item.attachments}`);

                    const amountText =
                      item.total !== null && item.currency !== null
                        ? formatMoney(locale, {
                            amount: item.total,
                            currency: item.currency,
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
                        {...(metaParts.length > 0 ? { subtitle: Arr.join(metaParts, " · ") } : {})}
                        trailing={amountText}
                        badge={badge}
                        onPress={() => openDetail(item.id)}
                      />
                    );
                  })}
                </Section>
              )}

              {effectiveCursor === null ? null : (
                <View style={styles.more}>
                  <Button
                    kind="outlined"
                    label={t("common.action.loadMore")}
                    busy={loadingMore}
                    onPress={() => loadMore(effectiveCursor)}
                  />
                </View>
              )}
            </>
          );
        }}
      </RemoteView>

      <View style={styles.quickBar}>
        <Button
          kind="tonal"
          icon={Camera}
          label={t("expenses.capture.title")}
          onPress={openCapture}
        />
        <Button kind="outlined" icon={Plus} label={t("expenses.list.new")} onPress={openNew} />
      </View>
      {Str.trim(search) !== "" ? (
        <Text variant="meta" color="onSurfaceVariant">
          {t("common.field.search")}: {Str.trim(search)}
        </Text>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  filters: { gap: space.md },
  more: { alignItems: "center", paddingVertical: space.sm },
  quickBar: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
});
