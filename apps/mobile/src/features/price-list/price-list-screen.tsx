import type { CurrencyCode, VatTreatment, WorkspaceSummary } from "@kvitbit/domain/contract";
import type { KvitbitApiClient } from "@kvitbit/ui-port/api";
import {
  describeError,
  type FieldIssue,
  idempotencyHeaders,
  ifMatchHeaders,
  inWorkspace,
  issuesAt,
  optimisticList,
  partitionIssues,
  type Remote,
} from "@kvitbit/ui-port/api";
import { formatMoney } from "@kvitbit/ui-port/format";
import { enumKey } from "@kvitbit/ui-port/i18n";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { Archive, Pencil, Plus, Tag, X } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { useApi, useRemote } from "../../runtime/api-runtime";
import {
  acquireRequestKey,
  completeRequestKey,
  isRequestIntentExpired,
  requestIntentFailure,
  requestIntentReconciliationCopy,
  settlesRequestIntent,
} from "../../runtime/request-intent";
import { useSession } from "../../session/session-provider";
import {
  Badge,
  Banner,
  Button,
  Card,
  type Choice,
  EmptyState,
  IconButton,
  ListRow,
  RemoteView,
  Screen,
  SegmentedChoice,
  SwitchRow,
  space,
  Text,
  TextField,
  useOverlay,
} from "../../ui";
import { useWorkspace } from "../../workspace/workspace-provider";
import { canWriteWorkspace } from "../dashboard/model";
import { requestOwner } from "../request-owner";
import { runFeatureEffect } from "../ui-effect";
import {
  buildPriceListInput,
  emptyPriceListForm,
  PRICE_LIST_CURRENCIES,
  type PriceListFormErrorCode,
  type PriceListFormState,
  type PriceListItemRecord,
  parsePriceListItem,
  parsePriceListItems,
  priceListFormFromItem,
  reloadPriceListItem,
  VAT_TREATMENTS,
  validatePriceListForm,
} from "./model";

const DEFAULT_VAT = "__default__";
const listOps = optimisticList<PriceListItemRecord>((item) => item.id);

interface PriceListEditorProps {
  readonly form: PriceListFormState;
  readonly onChangeForm: (updater: (prev: PriceListFormState) => PriceListFormState) => void;
  readonly clientErrors: Readonly<Partial<Record<string, PriceListFormErrorCode>>>;
  readonly serverIssues: ReadonlyArray<FieldIssue>;
  readonly bannerError: string | null;
  readonly staleRevision: boolean;
  readonly onReload: () => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
  readonly saving: boolean;
}

function PriceListEditor(props: PriceListEditorProps) {
  const { t, text, local } = useI18n();
  const { form, onChangeForm } = props;

  const ownedPaths = useMemo(
    () => new Set(["name", "description", "unit", "unitPrice", "currency", "vat"]),
    [],
  );
  const partitioned = useMemo(
    () =>
      partitionIssues(props.serverIssues, (path) =>
        ownedPaths.has(Arr.join(Arr.map(path, String), ".")),
      ),
    [props.serverIssues, ownedPaths],
  );

  const clientErrorMessage = (code: PriceListFormErrorCode | undefined): string | null => {
    if (code === undefined) return null;
    switch (code) {
      case "name_required":
        return local({ cs: "Zadejte název položky.", en: "Enter an item name." });
      case "price_invalid":
        return local({
          cs: "Zadejte platnou cenu (např. 1500 nebo 49.90).",
          en: "Enter a valid unit price (e.g. 1500 or 49.90).",
        });
      case "currency_invalid":
        return local({ cs: "Vyberte platnou měnu.", en: "Select a valid currency." });
    }
  };

  const fieldError = (path: ReadonlyArray<string>): string | null => {
    const localMsg = clientErrorMessage(props.clientErrors[Arr.join(path, ".")]);
    if (localMsg !== null) return localMsg;
    const server = issuesAt(props.serverIssues, path)[0];
    return server !== undefined ? text(server.text) : null;
  };

  const currencyChoices: ReadonlyArray<Choice<CurrencyCode>> = useMemo(
    () => Arr.map(PRICE_LIST_CURRENCIES, (c) => ({ value: c, label: c })),
    [],
  );

  const vatChoices: ReadonlyArray<Choice<VatTreatment | typeof DEFAULT_VAT>> = useMemo(
    () => [
      { value: DEFAULT_VAT, label: t("contacts.override.workspaceDefault") },
      ...Arr.map(VAT_TREATMENTS, (vat) => ({
        value: vat,
        label: t(enumKey({ name: "vatTreatment", value: vat })),
      })),
    ],
    [t],
  );

  return (
    <Card>
      <Text variant="titleMedium">
        {form.editingId === null ? t("priceList.new") : `${t("common.action.edit")}: ${form.name}`}
      </Text>

      {props.staleRevision ? (
        <Banner
          tone="warning"
          text={t("error.conflict.revision_changed")}
          action={{ label: t("common.action.reload"), onPress: props.onReload }}
        />
      ) : null}

      {props.bannerError !== null && !props.staleRevision ? (
        <Banner tone="error" text={props.bannerError} />
      ) : null}

      {partitioned.summary.length > 0 ? (
        <Banner
          tone="error"
          text={Arr.join(
            Arr.map(partitioned.summary, (i) => text(i.text)),
            " ",
          )}
        />
      ) : null}

      <TextField
        label={t("priceList.column.name")}
        value={form.name}
        onChangeText={(name) => onChangeForm((prev) => ({ ...prev, name }))}
        error={fieldError(["name"])}
        testID="price-list-name-input"
      />

      <TextField
        label={t("common.field.description")}
        value={form.description}
        onChangeText={(description) => onChangeForm((prev) => ({ ...prev, description }))}
        multiline
      />

      <TextField
        label={t("priceList.column.unit")}
        value={form.unit}
        onChangeText={(unit) => onChangeForm((prev) => ({ ...prev, unit }))}
        placeholder={`${t("common.unit.hour")}, ${t("common.unit.piece")}, ${t("common.unit.day")}`}
      />

      <TextField
        label={t("common.field.unitPrice")}
        value={form.unitPrice}
        onChangeText={(unitPrice) => onChangeForm((prev) => ({ ...prev, unitPrice }))}
        keyboardType="decimal-pad"
        placeholder="1500"
        error={fieldError(["unitPrice"])}
        testID="price-list-price-input"
      />

      <SegmentedChoice
        label={t("common.field.currency")}
        value={form.currency}
        choices={currencyChoices}
        onChange={(currency) => onChangeForm((prev) => ({ ...prev, currency }))}
      />

      <SegmentedChoice
        label={t("priceList.column.vat")}
        value={form.vat ?? DEFAULT_VAT}
        choices={vatChoices}
        onChange={(val) =>
          onChangeForm((prev) => ({
            ...prev,
            vat: val === DEFAULT_VAT ? null : val,
          }))
        }
      />

      <View style={styles.actionRow}>
        <Button
          label={t("common.action.save")}
          busy={props.saving}
          disabled={props.staleRevision}
          onPress={props.onSave}
          testID="price-list-save-button"
        />
        <Button
          kind="outlined"
          label={t("common.action.cancel")}
          disabled={props.saving}
          onPress={props.onCancel}
        />
      </View>
    </Card>
  );
}

export interface PriceListContentProps {
  readonly workspace: WorkspaceSummary;
  readonly searchText: string;
  readonly onChangeSearchText: (text: string) => void;
  readonly includeArchived: boolean;
  readonly onChangeIncludeArchived: (value: boolean) => void;
  readonly itemsRemote: Remote<ReadonlyArray<PriceListItemRecord>>;
  readonly visibleItems: ReadonlyArray<PriceListItemRecord>;
  readonly onRetry: () => void;
  readonly editor: PriceListEditorProps | null;
  readonly onStartCreate: () => void;
  readonly onStartEdit: (item: PriceListItemRecord) => void;
  readonly onArchive: (item: PriceListItemRecord) => void;
  readonly onClearFilters: () => void;
}

export function PriceListContent(props: PriceListContentProps) {
  const { t, locale } = useI18n();
  const writable = canWriteWorkspace(props.workspace);
  const hasFilters = Str.trim(props.searchText) !== "" || props.includeArchived;

  return (
    <View style={styles.stack}>
      {props.workspace.closed ? <Banner tone="warning" text={t("shell.closedWorkspace")} /> : null}

      {props.editor !== null ? <PriceListEditor {...props.editor} /> : null}

      <TextField
        label={t("common.field.search")}
        placeholder={t("priceList.search")}
        value={props.searchText}
        onChangeText={props.onChangeSearchText}
        returnKeyType="search"
        trailing={
          props.searchText !== "" ? (
            <IconButton
              icon={X}
              label={t("common.action.clear")}
              onPress={() => props.onChangeSearchText("")}
            />
          ) : undefined
        }
      />

      <SwitchRow
        label={t("priceList.showArchived")}
        value={props.includeArchived}
        onChange={props.onChangeIncludeArchived}
      />

      <RemoteView state={props.itemsRemote} onRetry={props.onRetry}>
        {() =>
          props.visibleItems.length === 0 ? (
            <Card>
              {hasFilters ? (
                <EmptyState
                  title={t("common.state.noMatches")}
                  body={t("common.state.noMatchesHint")}
                  action={{ label: t("common.action.clearFilters"), onPress: props.onClearFilters }}
                />
              ) : (
                <EmptyState
                  title={t("priceList.empty.title")}
                  {...(writable
                    ? { action: { label: t("priceList.empty.cta"), onPress: props.onStartCreate } }
                    : {})}
                />
              )}
            </Card>
          ) : (
            <Card style={styles.listCard}>
              {Arr.map(props.visibleItems, (item) => {
                const vatLabel =
                  item.vat !== null
                    ? t(enumKey({ name: "vatTreatment", value: item.vat }))
                    : t("contacts.override.workspaceDefault");
                const subtitleParts = Arr.filter(
                  [item.description, vatLabel],
                  (p): p is string => p !== null && p !== "",
                );
                const priceText = formatMoney(locale, {
                  amount: item.unitPrice,
                  currency: item.currency,
                });
                return (
                  <View key={item.id} style={styles.itemWrap}>
                    <ListRow
                      testID={`price-list-row-${item.id}`}
                      leading={Tag}
                      title={item.name}
                      subtitle={Arr.join(subtitleParts, " · ")}
                      trailing={priceText}
                      {...(item.unit !== null ? { trailingSub: `/ ${item.unit}` } : {})}
                      badge={
                        item.archived ? (
                          <Badge tone="draft" label={t("common.action.archive")} />
                        ) : undefined
                      }
                      {...(writable && !item.archived
                        ? { onPress: () => props.onStartEdit(item) }
                        : {})}
                    />
                    {writable && !item.archived ? (
                      <View style={styles.rowActions}>
                        <Button
                          kind="text"
                          icon={Pencil}
                          label={t("common.action.edit")}
                          onPress={() => props.onStartEdit(item)}
                        />
                        <Button
                          kind="text"
                          icon={Archive}
                          label={t("common.action.archive")}
                          onPress={() => props.onArchive(item)}
                        />
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </Card>
          )
        }
      </RemoteView>
    </View>
  );
}

export function PriceListScreen() {
  const { workspace } = useWorkspace();
  const api = useApi();
  const session = useSession();
  const overlay = useOverlay();
  const { t, text, local } = useI18n();
  const writable = canWriteWorkspace(workspace);
  const owner =
    session.state.status === "signed-in"
      ? requestOwner([api.origin, session.state.user.id, workspace.id])
      : null;

  const [searchText, setSearchText] = useState("");
  const [includeArchived, setIncludeArchived] = useState<boolean>(false);

  const itemsRemote = useRemote(
    useCallback(
      (client: KvitbitApiClient) =>
        Effect.map(
          client.priceList.list({
            params: inWorkspace(workspace.id),
            query: {
              text: Str.trim(searchText) || undefined,
              includeArchived,
            },
          }),
          parsePriceListItems,
        ),
      [workspace.id, searchText, includeArchived],
    ),
  );

  const [optimistic, setOptimistic] = useState(() => listOps.init([]));
  const optimisticRef = useRef(optimistic);
  optimisticRef.current = optimistic;

  useEffect(() => {
    if (itemsRemote.state._tag === "Ready") {
      const next = listOps.rebase(optimisticRef.current, itemsRemote.state.value);
      setOptimistic(next);
      optimisticRef.current = next;
    }
  }, [itemsRemote.state]);

  const [form, setForm] = useState<PriceListFormState | null>(null);
  const [clientErrors, setClientErrors] = useState<
    Readonly<Partial<Record<string, PriceListFormErrorCode>>>
  >({});
  const [serverIssues, setServerIssues] = useState<ReadonlyArray<FieldIssue>>([]);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [staleRevision, setStaleRevision] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const savingRef = useRef<boolean>(false);

  const openCreate = useCallback(() => {
    if (savingRef.current) return;
    setForm(emptyPriceListForm());
    setClientErrors({});
    setServerIssues([]);
    setBannerError(null);
    setStaleRevision(false);
  }, []);

  const openEdit = useCallback((item: PriceListItemRecord) => {
    if (savingRef.current || item.archived) return;
    setForm(priceListFormFromItem(item));
    setClientErrors({});
    setServerIssues([]);
    setBannerError(null);
    setStaleRevision(false);
  }, []);

  const closeEditor = useCallback(() => {
    if (savingRef.current) return;
    setForm(null);
    setClientErrors({});
    setServerIssues([]);
    setBannerError(null);
    setStaleRevision(false);
  }, []);

  const handleChangeForm = useCallback(
    (updater: (prev: PriceListFormState) => PriceListFormState) => {
      if (savingRef.current) return;
      setForm((prev) => (prev === null ? null : updater(prev)));
      setClientErrors({});
      setServerIssues([]);
    },
    [],
  );

  const handleSave = useCallback(
    () =>
      runFeatureEffect(
        Effect.gen(function* () {
          if (!writable || form === null || staleRevision || savingRef.current) return;
          const validation = validatePriceListForm(form);
          if (Rec.keys(validation).length > 0) {
            setClientErrors(validation);
            return;
          }
          savingRef.current = true;
          setSaving(true);
          setBannerError(null);
          setServerIssues([]);
          setStaleRevision(false);

          const payload = buildPriceListInput(form);
          const editingId = form.editingId;
          const isCreate = editingId === null;
          const result = yield* Effect.gen(function* () {
            if (editingId !== null) {
              const revision = form.editingRevision;
              if (revision === null) return null;
              return yield* Effect.promise(() =>
                api.run((client) =>
                  client.priceList.update({
                    params: inWorkspace(workspace.id, { itemId: editingId }),
                    headers: ifMatchHeaders(revision),
                    payload,
                  }),
                ),
              );
            }
            if (owner === null) return null;
            const operation = "priceList.create";
            const key = yield* Effect.promise(() => acquireRequestKey(owner, operation, payload));
            const created = yield* Effect.promise(() =>
              api.run((client) =>
                client.priceList.create({
                  params: inWorkspace(workspace.id),
                  headers: idempotencyHeaders(key),
                  payload,
                }),
              ),
            );
            if (settlesRequestIntent(created)) {
              yield* Effect.promise(() => completeRequestKey(owner, operation, key)).pipe(
                Effect.catchCause(() => Effect.sync(() => overlay.toast(t("error.unknown")))),
              );
            }
            return created;
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                setBannerError(
                  cause.pipe(Cause.squash, requestIntentFailure, isRequestIntentExpired)
                    ? local(requestIntentReconciliationCopy)
                    : t("error.unknown"),
                );
                return null;
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                savingRef.current = false;
                setSaving(false);
              }),
            ),
          );
          if (result === null) return;

          if (result._tag === "Ok") {
            const saved = parsePriceListItem(result.value);
            overlay.toast(t("common.toast.saved"));
            closeEditor();
            if (saved !== null && !isCreate) {
              const next = listOps.rebase(
                optimisticRef.current,
                Arr.map(optimisticRef.current.base, (i) => (i.id === saved.id ? saved : i)),
              );
              setOptimistic(next);
              optimisticRef.current = next;
            }
            itemsRemote.reload();
            return;
          }

          const view = describeError(result.error);
          if (view.staleRevision) {
            setStaleRevision(true);
            return;
          }
          if (view.issues.length > 0) {
            setServerIssues(view.issues);
            return;
          }
          setBannerError(text(view.text));
        }),
      ),
    [
      api,
      closeEditor,
      form,
      itemsRemote,
      local,
      overlay,
      owner,
      staleRevision,
      t,
      text,
      workspace.id,
      writable,
    ],
  );

  const handleArchive = useCallback(
    (item: PriceListItemRecord) =>
      runFeatureEffect(
        Effect.gen(function* () {
          const confirmed = yield* Effect.promise(() =>
            overlay.confirm({
              title: `${t("common.action.archive")} ${item.name}?`,
              body: local({
                cs: "Položka se skryje z výběru v editoru dokladů.",
                en: "The item will be hidden from document line pickers.",
              }),
              confirmLabel: t("common.action.archive"),
              cancelLabel: t("common.action.cancel"),
              destructive: true,
            }),
          );
          if (!confirmed) return;

          const op = includeArchived
            ? ({ _tag: "Replace", item: { ...item, archived: true } } as const)
            : ({ _tag: "Remove", id: item.id } as const);
          const applied = listOps.apply(optimisticRef.current, item.id, op);
          setOptimistic(applied.state);
          optimisticRef.current = applied.state;

          const res = yield* Effect.promise(() =>
            api.run((client) =>
              client.priceList.archive({ params: inWorkspace(workspace.id, { itemId: item.id }) }),
            ),
          );
          if (res._tag === "Ok") {
            const confirmedState = listOps.confirm(optimisticRef.current, applied.seq);
            setOptimistic(confirmedState);
            optimisticRef.current = confirmedState;
            overlay.toast(t("common.toast.archived", { name: item.name }));
            if (form?.editingId === item.id) closeEditor();
          } else {
            const rolledBack = listOps.rollback(optimisticRef.current, applied.seq);
            setOptimistic(rolledBack);
            optimisticRef.current = rolledBack;
            overlay.toast(text(describeError(res.error).text));
          }
        }),
      ),
    [api, closeEditor, form?.editingId, includeArchived, local, overlay, t, text, workspace.id],
  );

  const handleReload = useCallback(
    () =>
      runFeatureEffect(
        Effect.gen(function* () {
          const editingId = form?.editingId;
          if (editingId === null || editingId === undefined || savingRef.current) return;
          savingRef.current = true;
          setSaving(true);
          setBannerError(null);
          const result = yield* Effect.promise(() =>
            api
              .run((client) =>
                reloadPriceListItem({
                  priceList: client.priceList,
                  workspaceId: workspace.id,
                  editingId,
                }),
              )
              .finally(() => {
                savingRef.current = false;
                setSaving(false);
              }),
          );
          if (result._tag === "Err") {
            overlay.toast(text(describeError(result.error).text));
            return;
          }
          if (result.value === undefined) closeEditor();
          else openEdit(result.value);
          itemsRemote.reload();
        }),
      ),
    [api, closeEditor, form?.editingId, itemsRemote, openEdit, overlay, text, workspace.id],
  );

  return (
    <Screen
      title={t("priceList.title")}
      back
      onRefresh={itemsRemote.reload}
      refreshing={itemsRemote.state._tag === "Loading"}
      actions={
        writable ? (
          <IconButton icon={Plus} label={t("priceList.new")} onPress={openCreate} />
        ) : undefined
      }
    >
      <PriceListContent
        workspace={workspace}
        searchText={searchText}
        onChangeSearchText={setSearchText}
        includeArchived={includeArchived}
        onChangeIncludeArchived={setIncludeArchived}
        itemsRemote={itemsRemote.state}
        visibleItems={optimistic.value}
        onRetry={itemsRemote.reload}
        editor={
          form === null
            ? null
            : {
                form,
                onChangeForm: handleChangeForm,
                clientErrors,
                serverIssues,
                bannerError,
                staleRevision,
                onReload: handleReload,
                onSave: handleSave,
                onCancel: closeEditor,
                saving,
              }
        }
        onStartCreate={openCreate}
        onStartEdit={openEdit}
        onArchive={handleArchive}
        onClearFilters={() => {
          setSearchText("");
          setIncludeArchived(false);
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.lg },
  listCard: { padding: space.xs, gap: 0 },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.xs },
  itemWrap: { gap: 0 },
  rowActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: space.xs,
    paddingHorizontal: space.xs,
  },
});
