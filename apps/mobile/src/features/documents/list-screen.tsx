/**
 * Documents list screen (`app/w/[ws]/documents/index.tsx`): search, kind/status/settlement/overdue
 * filters, quick create (invoice, proforma, credit note), badges, and tabular currency amounts.
 */

import type {
  DocumentKind,
  DocumentSettlement,
  DocumentStatus,
  WorkspaceSummary,
} from "@kvitbit/domain/contract";
import { cleanFilters, describeError, filterHash } from "@kvitbit/ui-port/api";
import { formatDate, formatMoney } from "@kvitbit/ui-port/format";
import { enumKey } from "@kvitbit/ui-port/i18n";
import { DocumentListQuery } from "@kvitbit/ui-port/view-models";
import * as Arr from "effect/Array";
import * as EffectRecord from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { router, useLocalSearchParams } from "expo-router";
import { FilePlus2, Lock, Plus, Search } from "lucide-react-native";
import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { navigate, param } from "../../navigation/routes";
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
import { useDocumentPages } from "./list-pages";

type FilterValue<T extends string> = T | "all";
type DocumentListParams = Partial<Record<keyof DocumentListQuery, string | string[]>>;

const readFilter = <S extends Schema.Constraint>(schema: S, raw: string | string[] | undefined) => {
  const value = param(raw);
  return Schema.is(schema)(value) ? value : undefined;
};

export function DocumentsListScreen() {
  const { workspace } = useWorkspace();
  const params = useLocalSearchParams<DocumentListParams>();
  const overdue = param(params.overdue);
  const initialQuery = cleanFilters({
    text: param(params.text),
    kind: readFilter(DocumentListQuery.fields.kind, params.kind),
    status: readFilter(DocumentListQuery.fields.status, params.status),
    settlement: readFilter(DocumentListQuery.fields.settlement, params.settlement),
    overdue: overdue === "true" ? true : overdue === "false" ? false : undefined,
    contact: readFilter(DocumentListQuery.fields.contact, params.contact),
    from: readFilter(DocumentListQuery.fields.from, params.from),
    to: readFilter(DocumentListQuery.fields.to, params.to),
  });
  return (
    <DocumentsList
      key={filterHash(initialQuery)}
      workspace={workspace}
      initialQuery={initialQuery}
    />
  );
}

function DocumentsList({
  workspace,
  initialQuery,
}: {
  readonly workspace: WorkspaceSummary;
  readonly initialQuery: DocumentListQuery;
}) {
  const { t, locale, local, text: resolveText } = useI18n();
  const overlay = useOverlay();
  const [search, setSearch] = useState(initialQuery.text ?? "");
  const [kind, setKind] = useState<FilterValue<DocumentKind>>(initialQuery.kind ?? "all");
  const [status, setStatus] = useState<FilterValue<DocumentStatus>>(initialQuery.status ?? "all");
  const [settlement, setSettlement] = useState<FilterValue<DocumentSettlement>>(
    initialQuery.settlement ?? "all",
  );
  const [overdue, setOverdue] = useState(initialQuery.overdue);
  const [routeFilters, setRouteFilters] = useState(() =>
    cleanFilters({ contact: initialQuery.contact, from: initialQuery.from, to: initialQuery.to }),
  );

  const canWrite = workspace.role !== "accountant";
  const trimmedSearch = Str.trim(search);

  const query = useMemo<DocumentListQuery>(
    () =>
      cleanFilters({
        ...routeFilters,
        text: trimmedSearch,
        kind: kind === "all" ? undefined : kind,
        status: status === "all" ? undefined : status,
        settlement: settlement === "all" ? undefined : settlement,
        overdue,
      }),
    [routeFilters, trimmedSearch, kind, status, settlement, overdue],
  );
  const list = useDocumentPages({ workspaceId: workspace.id, query });
  const hasFilters =
    EffectRecord.keys<string, DocumentListQuery[keyof DocumentListQuery]>(query).length > 0;

  const clearFilters = () => {
    setSearch("");
    setKind("all");
    setStatus("all");
    setSettlement("all");
    setOverdue(undefined);
    setRouteFilters({});
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
      router.push(`/w/${workspace.slug}/documents/new/credit_note`);
      return;
    }
    navigate({ _tag: "DocumentNew", ws: workspace.slug, kind: newKind });
  };

  return (
    <Screen
      title={t("documents.list.title")}
      onRefresh={list.reload}
      refreshing={list.refreshing}
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
          value={overdue === true}
          onChange={(checked) => setOverdue(checked ? true : undefined)}
        />
        {hasFilters ? (
          <View style={styles.filterActions}>
            <Button kind="text" label={t("common.action.clearFilters")} onPress={clearFilters} />
          </View>
        ) : null}
      </Card>

      <RemoteView state={list.state} onRetry={list.reload}>
        {(items) => {
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
                {Arr.map(items, (doc) => {
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
              {list.hasMore ? (
                <Button
                  kind="outlined"
                  label={t("common.action.loadMore")}
                  busy={list.loadingMore}
                  disabled={list.refreshing}
                  onPress={() =>
                    list.loadMore((error) => overlay.toast(resolveText(describeError(error).text)))
                  }
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
