/**
 * Documents list screen (`app/w/[ws]/documents/index.tsx`): search, kind/status/settlement/overdue
 * filters, quick create (invoice, proforma, credit note), badges, and tabular currency amounts.
 */
import type { DocumentKind, DocumentSettlement, DocumentStatus } from "@kvitbit/domain/contract";
import { describeError } from "@kvitbit/ui-port/api";
import { formatDate, formatMoney } from "@kvitbit/ui-port/format";
import { enumKey } from "@kvitbit/ui-port/i18n";
import { router, useLocalSearchParams } from "expo-router";
import { FilePlus2, Lock, Plus, Search } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { navigate, param } from "../../navigation/routes";
import { useApi, useRemote } from "../../runtime/api-runtime";
import {
  Badge,
  Banner,
  Button,
  Card,
  type Choice,
  EmptyState,
  ListRow,
  RemoteView,
  Screen,
  SegmentedChoice,
  SwitchRow,
  space,
  TextField,
  useOverlay,
} from "../../ui";
import { useWorkspace } from "../../workspace/workspace-provider";
import { documentStatusBadge, kindBadge, settlementBadge } from "./badges";
import { type DocumentSummaryView, parseDocumentSummary } from "./codecs";

type FilterValue<T extends string> = T | "all";

export function DocumentsListScreen() {
  const { workspace } = useWorkspace();
  const { t, locale, local, text: resolveText } = useI18n();
  const { run } = useApi();
  const overlay = useOverlay();
  const params = useLocalSearchParams<{
    text?: string | string[];
    kind?: string | string[];
    status?: string | string[];
    settlement?: string | string[];
    overdue?: string | string[];
  }>();

  const [search, setSearch] = useState(() => param(params.text) ?? "");
  const [kind, setKind] = useState<FilterValue<DocumentKind>>(
    () => (param(params.kind) as DocumentKind | undefined) ?? "all",
  );
  const [status, setStatus] = useState<FilterValue<DocumentStatus>>(
    () => (param(params.status) as DocumentStatus | undefined) ?? "all",
  );
  const [settlement, setSettlement] = useState<FilterValue<DocumentSettlement>>(
    () => (param(params.settlement) as DocumentSettlement | undefined) ?? "all",
  );
  const [overdueOnly, setOverdueOnly] = useState(() => param(params.overdue) === "true");
  const [extraItems, setExtraItems] = useState<ReadonlyArray<DocumentSummaryView>>([]);
  const [extraCursor, setExtraCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const canWrite = workspace.role !== "accountant";
  const trimmedSearch = search.trim();

  const query = useMemo(
    () => ({
      ...(trimmedSearch !== "" ? { text: trimmedSearch } : {}),
      ...(kind !== "all" ? { kind } : {}),
      ...(status !== "all" ? { status } : {}),
      ...(settlement !== "all" ? { settlement } : {}),
      ...(overdueOnly ? { overdue: true } : {}),
      limit: 50,
    }),
    [trimmedSearch, kind, status, settlement, overdueOnly],
  );

  const list = useRemote(
    (api) =>
      api.documents.list({
        params: { workspaceId: workspace.id },
        query,
      }),
    [workspace.id, query],
  );

  // Reset appended pages whenever the filter query changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset pagination on filter change
  useEffect(() => {
    setExtraItems([]);
    setExtraCursor(null);
  }, [query]);

  const hasFilters =
    trimmedSearch !== "" ||
    kind !== "all" ||
    status !== "all" ||
    settlement !== "all" ||
    overdueOnly;

  const clearFilters = useCallback(() => {
    setSearch("");
    setKind("all");
    setStatus("all");
    setSettlement("all");
    setOverdueOnly(false);
  }, []);

  const loadMore = async (cursor: string) => {
    if (loadingMore) return;
    setLoadingMore(true);
    const result = await run((api) =>
      api.documents.list({
        params: { workspaceId: workspace.id },
        query: { ...query, cursor },
      }),
    );
    setLoadingMore(false);
    if (result._tag === "Err") {
      overlay.toast(resolveText(describeError(result.error).text));
      return;
    }
    const next = result.value.items.map(parseDocumentSummary);
    setExtraItems((prev) => [...prev, ...next]);
    setExtraCursor(result.value.nextCursor);
  };

  const kindChoices: ReadonlyArray<Choice<FilterValue<DocumentKind>>> = [
    { value: "all", label: t("common.state.all") },
    { value: "invoice", label: t(enumKey("documentKindPlural", "invoice")) },
    { value: "proforma", label: t(enumKey("documentKindPlural", "proforma")) },
    {
      value: "payment_tax_document",
      label: t(enumKey("documentKindPlural", "payment_tax_document")),
    },
    { value: "credit_note", label: t(enumKey("documentKindPlural", "credit_note")) },
  ];

  const statusChoices: ReadonlyArray<Choice<FilterValue<DocumentStatus>>> = [
    { value: "all", label: t("common.state.all") },
    { value: "draft", label: t(enumKey("documentStatus", "draft")) },
    { value: "issued", label: t(enumKey("documentStatus", "issued")) },
    { value: "cancelled", label: t(enumKey("documentStatus", "cancelled")) },
  ];

  const settlementChoices: ReadonlyArray<Choice<FilterValue<DocumentSettlement>>> = [
    { value: "all", label: t("common.state.all") },
    { value: "unpaid", label: t(enumKey("settlement", "unpaid")) },
    { value: "partially_paid", label: t(enumKey("settlement", "partially_paid")) },
    { value: "paid", label: t(enumKey("settlement", "paid")) },
    { value: "overpaid", label: t(enumKey("settlement", "overpaid")) },
    { value: "credited", label: t(enumKey("settlement", "credited")) },
  ];

  const openNew = (newKind: "invoice" | "proforma" | "credit_note") => {
    if (newKind === "credit_note") {
      router.push(`/w/${workspace.slug}/documents/new/credit_note` as never);
      return;
    }
    navigate({ _tag: "DocumentNew", ws: workspace.slug, kind: newKind });
  };

  return (
    <Screen
      title={t("documents.list.title")}
      onRefresh={list.reload}
      refreshing={list.state._tag === "Loading"}
      actions={
        canWrite ? (
          <Button
            kind="filled"
            icon={Plus}
            label={t("documents.list.new")}
            testID="documents-quick-create-invoice"
            onPress={() => openNew("invoice")}
          />
        ) : null
      }
    >
      {canWrite ? (
        <View style={styles.quickCreate}>
          <Button
            kind="tonal"
            icon={FilePlus2}
            label={t("documents.list.new")}
            testID="documents-create-invoice"
            onPress={() => openNew("invoice")}
          />
          <Button
            kind="outlined"
            icon={FilePlus2}
            label={t("documents.list.newProforma")}
            testID="documents-create-proforma"
            onPress={() => openNew("proforma")}
          />
          <Button
            kind="outlined"
            icon={FilePlus2}
            label={local({ cs: "Nový dobropis", en: "New credit note" })}
            testID="documents-create-credit-note"
            onPress={() => openNew("credit_note")}
          />
        </View>
      ) : (
        <Banner tone="info" text={t("common.state.readOnlyHint")} />
      )}

      <Card>
        <TextField
          label={t("common.action.search")}
          placeholder={t("documents.list.search")}
          value={search}
          onChangeText={setSearch}
          testID="documents-search-input"
          trailing={
            search !== "" ? (
              <Button kind="text" label={t("common.action.clear")} onPress={() => setSearch("")} />
            ) : null
          }
        />
        <SegmentedChoice
          label={t("common.field.type")}
          value={kind}
          choices={kindChoices}
          onChange={setKind}
        />
        <SegmentedChoice
          label={t("documents.list.filter.status")}
          value={status}
          choices={statusChoices}
          onChange={setStatus}
        />
        <SegmentedChoice
          label={t("documents.list.filter.settlement")}
          value={settlement}
          choices={settlementChoices}
          onChange={setSettlement}
        />
        <SwitchRow
          label={t("documents.list.filter.overdue")}
          value={overdueOnly}
          onChange={setOverdueOnly}
        />
        {hasFilters ? (
          <View style={styles.filterActions}>
            <Button kind="text" label={t("common.action.clearFilters")} onPress={clearFilters} />
          </View>
        ) : null}
      </Card>

      <RemoteView state={list.state} onRetry={list.reload}>
        {(page) => {
          const baseItems = page.items.map(parseDocumentSummary);
          const items = [...baseItems, ...extraItems];
          const nextCursor = extraItems.length > 0 ? extraCursor : page.nextCursor;

          if (items.length === 0) {
            return hasFilters ? (
              <EmptyState
                title={t("common.state.noMatches")}
                body={t("common.state.noMatchesHint")}
                action={{ label: t("common.action.clearFilters"), onPress: clearFilters }}
              />
            ) : (
              <EmptyState
                title={t("documents.list.empty.title")}
                body={t("documents.list.empty.body")}
                {...(canWrite
                  ? {
                      action: {
                        label: t("documents.list.empty.cta"),
                        onPress: () => openNew("invoice"),
                      },
                    }
                  : {})}
              />
            );
          }

          return (
            <View style={styles.list}>
              <Card style={styles.listCard}>
                {items.map((doc) => {
                  const statusB = documentStatusBadge(doc.status, t);
                  const settleB = settlementBadge(doc.settlement, doc.overdue, t);
                  const kindB = kindBadge(doc.kind, t);
                  const numberLabel = doc.number ?? t("documents.list.draftNumber");
                  const datePart = `${formatDate(locale, doc.issuedOn)} · ${t("documents.list.column.due")} ${formatDate(locale, doc.dueOn)}`;
                  return (
                    <ListRow
                      key={doc.id}
                      testID={`document-row-${doc.id}`}
                      title={numberLabel}
                      subtitle={`${doc.contact.name} · ${datePart}`}
                      trailing={formatMoney(locale, doc.total)}
                      leading={doc.locked ? Lock : Search}
                      badge={
                        <View style={styles.badges}>
                          {doc.kind !== "invoice" ? (
                            <Badge label={kindB.label} tone={kindB.tone} />
                          ) : null}
                          <Badge label={statusB.label} tone={statusB.tone} />
                          {doc.status === "issued" ? (
                            <Badge label={settleB.label} tone={settleB.tone} />
                          ) : null}
                          {doc.locked ? (
                            <Badge label={t("enum.badge.locked")} tone="neutral" />
                          ) : null}
                        </View>
                      }
                      onPress={() =>
                        navigate({
                          _tag: "Document",
                          ws: workspace.slug,
                          id: doc.id,
                          tab: "preview",
                        })
                      }
                    />
                  );
                })}
              </Card>
              {nextCursor !== null ? (
                <Button
                  kind="outlined"
                  label={t("common.action.loadMore")}
                  busy={loadingMore}
                  onPress={() => void loadMore(nextCursor)}
                />
              ) : null}
            </View>
          );
        }}
      </RemoteView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  quickCreate: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  filterActions: { alignItems: "flex-end" },
  list: { gap: space.md },
  listCard: { paddingHorizontal: space.sm, paddingVertical: space.xs },
  badges: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: space.xs },
});
