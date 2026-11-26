import type {
  IsoDate,
  Locale,
  PaymentMethod,
  TemplateId,
  VatTreatment,
} from "@kvitbit/domain/contract";
import { describeError, idempotencyHeaders, ifMatchHeaders } from "@kvitbit/ui-port/api";
import { formatDate } from "@kvitbit/ui-port/format";
import { Archive, Play, Plus, RefreshCw, Send, Trash2 } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { navigate } from "../../navigation/routes";
import { useApi, useRemote } from "../../runtime/api-runtime";
import { runRequestIntent } from "../../runtime/request-intent";
import { useSession } from "../../session/session-provider";
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
  SwitchRow,
  space,
  Text,
  TextField,
  useOverlay,
} from "../../ui";
import { useWorkspace } from "../../workspace/workspace-provider";
import {
  COMMON_CURRENCIES,
  EXPENSE_VAT_TREATMENTS,
  PAYMENT_METHODS,
  todayIsoDate,
} from "../expenses/model";
import {
  buildScheduleEvery,
  buildTemplateInput,
  type CadenceUnit,
  decodeTemplate,
  emptyTemplateForm,
  previewOccurrences,
  type ScheduleFormState,
  scheduleFormFromView,
  scheduleStateOf,
  type TemplateFormState,
  type TemplateViewData,
  templateFormFromView,
} from "./model";

export type TemplateDetailTab = "template" | "schedule" | "runs";

const runTone = (outcome: "issued" | "failed" | "skipped_missed"): BadgeTone => {
  if (outcome === "issued") return "success";
  if (outcome === "failed") return "danger";
  return "warning";
};

export function TemplateDetailScreen(props: {
  readonly id: TemplateId | "new";
  readonly initialTab?: TemplateDetailTab;
}) {
  const isNew = props.id === "new";
  const templateId = isNew ? null : props.id;

  const { workspace } = useWorkspace();
  const { t, text, locale, local } = useI18n();
  const api = useApi();
  const { state: session } = useSession();
  const owner =
    session.status === "signed-in"
      ? JSON.stringify([api.origin, session.user.id, workspace.id])
      : null;
  const overlay = useOverlay();

  const [tab, setTab] = useState<TemplateDetailTab>(
    isNew ? "template" : (props.initialTab ?? "template"),
  );
  const [form, setForm] = useState<TemplateFormState>(() => emptyTemplateForm());
  const [scheduleForm, setScheduleForm] = useState<ScheduleFormState>(() =>
    scheduleFormFromView(null, "invoice", todayIsoDate()),
  );
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  const templateRemote = useRemote(
    templateId === null
      ? null
      : (client) => client.templates.get({ params: { workspaceId: workspace.id, templateId } }),
    [workspace.id, templateId],
  );

  const contactsRemote = useRemote(
    (client) =>
      client.contacts.search({ params: { workspaceId: workspace.id }, query: { limit: 50 } }),
    [workspace.id],
  );

  const runsRemote = useRemote(
    templateId === null || tab !== "runs"
      ? null
      : (client) =>
          client.templates.runs({
            params: { workspaceId: workspace.id, templateId },
            query: { limit: 30 },
          }),
    [workspace.id, templateId, tab],
  );

  const loaded: TemplateViewData | null =
    templateRemote.state._tag === "Ready" ? decodeTemplate(templateRemote.state.value) : null;

  useEffect(() => {
    if (loaded !== null) {
      setForm(templateFormFromView(loaded));
      setScheduleForm(scheduleFormFromView(loaded.schedule, loaded.kind, todayIsoDate()));
    }
  }, [loaded]);

  const handleSaveTemplate = useCallback(async () => {
    if (owner === null || saving) return;
    setBannerError(null);
    const { input, errors } = buildTemplateInput(form);
    if (input === null || Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    setSaving(true);
    if (isNew) {
      const res = await runRequestIntent(owner, "templates/create", input, (key) =>
        api.run((client) =>
          client.templates.create({
            params: { workspaceId: workspace.id },
            headers: idempotencyHeaders(key),
            payload: input,
          }),
        ),
      );
      setSaving(false);
      if (res._tag === "Ok") {
        const created = decodeTemplate(res.value);
        overlay.toast(t("common.toast.saved"));
        navigate(
          { _tag: "Template", ws: workspace.slug, id: created.id, tab: "template" },
          { replace: true },
        );
      } else {
        setBannerError(text(describeError(res.error).text));
      }
      return;
    }

    if (templateId === null || loaded === null) {
      setSaving(false);
      return;
    }
    const res = await api.run((client) =>
      client.templates.update({
        params: { workspaceId: workspace.id, templateId },
        headers: ifMatchHeaders(loaded.revision),
        payload: input,
      }),
    );
    setSaving(false);
    if (res._tag === "Ok") {
      templateRemote.set(res.value);
      overlay.toast(t("common.toast.saved"));
    } else {
      const view = describeError(res.error);
      setBannerError(text(view.text));
      if (view.staleRevision) templateRemote.reload();
    }
  }, [
    api,
    form,
    isNew,
    loaded,
    overlay,
    owner,
    saving,
    t,
    templateId,
    templateRemote,
    text,
    workspace,
  ]);

  const handleUseTemplate = useCallback(
    async (as: "draft" | "issued") => {
      if (templateId === null || owner === null || actionBusy) return;
      setBannerError(null);
      setActionBusy(true);
      const payload = { as };
      const res = await runRequestIntent(owner, `templates/use/${templateId}`, payload, (key) =>
        api.run((client) =>
          client.templates.use({
            params: { workspaceId: workspace.id, templateId },
            headers: idempotencyHeaders(key),
            payload,
          }),
        ),
      );
      setActionBusy(false);
      if (res._tag === "Ok") {
        overlay.toast(
          as === "issued"
            ? local({ cs: "Doklad vystaven", en: "Document issued" })
            : local({ cs: "Koncept vytvořen", en: "Draft created" }),
        );
        navigate({
          _tag: "Document",
          ws: workspace.slug,
          id: res.value.id,
          tab: "preview",
        });
      } else {
        setBannerError(text(describeError(res.error).text));
      }
    },
    [actionBusy, api, local, overlay, owner, templateId, text, workspace],
  );

  const handleArchive = useCallback(async () => {
    if (templateId === null || loaded === null) return;
    const confirmed = await overlay.confirm({
      title: `${t("common.action.archive")} ${loaded.name}?`,
      confirmLabel: t("common.action.archive"),
      cancelLabel: t("common.action.cancel"),
      destructive: true,
    });
    if (!confirmed) return;
    const res = await api.run((client) =>
      client.templates.archive({ params: { workspaceId: workspace.id, templateId } }),
    );
    if (res._tag === "Ok") {
      overlay.toast(t("common.toast.archived", { name: loaded.name }));
      navigate({ _tag: "Templates", ws: workspace.slug }, { replace: true });
    } else {
      setBannerError(text(describeError(res.error).text));
    }
  }, [api, loaded, overlay, t, templateId, text, workspace]);

  const handleSaveSchedule = useCallback(async () => {
    if (templateId === null || loaded === null) return;
    setBannerError(null);
    const every = buildScheduleEvery(scheduleForm.unit, scheduleForm.count);
    if (every === null) {
      setBannerError(local({ cs: "Zadejte interval 1 až 99.", en: "Enter interval 1 to 99." }));
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduleForm.startOn.trim())) {
      setBannerError(local({ cs: "Datum začátku: RRRR-MM-DD", en: "Start date: YYYY-MM-DD" }));
      return;
    }
    const endRaw = scheduleForm.endOn.trim();
    if (endRaw !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(endRaw)) {
      setBannerError(local({ cs: "Datum konce: RRRR-MM-DD", en: "End date: YYYY-MM-DD" }));
      return;
    }

    setSaving(true);
    const res = await api.run((client) =>
      client.templates.setSchedule({
        params: { workspaceId: workspace.id, templateId },
        headers: ifMatchHeaders(loaded.revision),
        payload: {
          every,
          startOn: scheduleForm.startOn.trim() as IsoDate,
          ...(endRaw === "" ? {} : { endOn: endRaw as IsoDate }),
          issueAs: scheduleForm.issueAs,
          autoSend: scheduleForm.autoSend,
        },
      }),
    );
    setSaving(false);
    if (res._tag === "Ok") {
      templateRemote.set(res.value);
      overlay.toast(t("common.toast.saved"));
    } else {
      const view = describeError(res.error);
      setBannerError(text(view.text));
      if (view.staleRevision) templateRemote.reload();
    }
  }, [
    api,
    loaded,
    local,
    overlay,
    scheduleForm,
    t,
    templateId,
    templateRemote,
    text,
    workspace.id,
  ]);

  const handleRemoveSchedule = useCallback(async () => {
    if (templateId === null || loaded === null) return;
    const confirmed = await overlay.confirm({
      title: t("templates.schedule.detach"),
      confirmLabel: t("common.action.confirm"),
      cancelLabel: t("common.action.cancel"),
      destructive: true,
    });
    if (!confirmed) return;
    setActionBusy(true);
    const res = await api.run((client) =>
      client.templates.removeSchedule({
        params: { workspaceId: workspace.id, templateId },
        headers: ifMatchHeaders(loaded.revision),
      }),
    );
    setActionBusy(false);
    if (res._tag === "Ok") {
      templateRemote.set(res.value);
      overlay.toast(t("common.toast.saved"));
    } else {
      setBannerError(text(describeError(res.error).text));
    }
  }, [api, loaded, overlay, t, templateId, templateRemote, text, workspace.id]);

  const handleResumeSchedule = useCallback(async () => {
    if (templateId === null) return;
    setActionBusy(true);
    const res = await api.run((client) =>
      client.templates.resume({ params: { workspaceId: workspace.id, templateId } }),
    );
    setActionBusy(false);
    if (res._tag === "Ok") {
      templateRemote.set(res.value);
      overlay.toast(t("templates.runs.resumed"));
    } else {
      setBannerError(text(describeError(res.error).text));
    }
  }, [api, overlay, t, templateId, templateRemote, text, workspace.id]);

  const tabChoices: ReadonlyArray<Choice<TemplateDetailTab>> = useMemo(
    () => [
      { value: "template", label: t("templates.editor.title") },
      { value: "schedule", label: t("templates.schedule.title") },
      { value: "runs", label: t("templates.runs.title") },
    ],
    [t],
  );

  const previewDates = useMemo(() => {
    const every = buildScheduleEvery(scheduleForm.unit, scheduleForm.count);
    if (every === null) return [];
    return previewOccurrences(scheduleForm.startOn.trim(), every, scheduleForm.endOn.trim(), 3);
  }, [scheduleForm.count, scheduleForm.endOn, scheduleForm.startOn, scheduleForm.unit]);

  const errMsg = (key: string): string | null => {
    const code = fieldErrors[key];
    if (code === undefined) return null;
    if (code === "required") return t("common.state.required");
    if (code === "invalid_days") return local({ cs: "0 až 365 dní", en: "0 to 365 days" });
    if (code === "invalid_number") return local({ cs: "Neplatné číslo", en: "Invalid number" });
    return code;
  };

  const contactChoices: ReadonlyArray<Choice<string>> = useMemo(() => {
    if (contactsRemote.state._tag !== "Ready") return [];
    return contactsRemote.state.value.items.map((c) => {
      const rec = c as unknown as { id?: string; name?: string };
      return { value: rec.id ?? "", label: rec.name ?? rec.id ?? "" };
    });
  }, [contactsRemote.state]);

  const renderTemplateForm = () => (
    <>
      {isNew || loaded === null ? null : (
        <Card>
          <View style={styles.quickActions}>
            <Button
              kind="tonal"
              icon={Send}
              label={local({ cs: "Vystavit nyní", en: "Issue now" })}
              busy={actionBusy}
              onPress={() => void handleUseTemplate("issued")}
              testID="template-issue-now"
            />
            <Button
              kind="outlined"
              icon={Play}
              label={local({ cs: "Vytvořit koncept", en: "Create draft" })}
              disabled={actionBusy}
              onPress={() => void handleUseTemplate("draft")}
              testID="template-create-draft"
            />
          </View>
        </Card>
      )}

      <Section title={t("templates.editor.title")}>
        <TextField
          label={t("templates.editor.name")}
          value={form.name}
          onChangeText={(name) => setForm((f) => ({ ...f, name }))}
          error={errMsg("name")}
          testID="template-name"
        />
        <SegmentedChoice<"invoice" | "proforma">
          label={t("common.field.type")}
          value={form.kind}
          choices={[
            { value: "invoice", label: t("enum.issueAs.invoice") },
            { value: "proforma", label: t("enum.issueAs.proforma") },
          ]}
          onChange={(kind) => setForm((f) => ({ ...f, kind }))}
        />
        {contactChoices.length > 0 ? (
          <SegmentedChoice<string>
            label={t("enum.entity.Contact")}
            value={form.contact || null}
            choices={contactChoices}
            onChange={(contact) => setForm((f) => ({ ...f, contact }))}
          />
        ) : (
          <TextField
            label={t("enum.entity.Contact")}
            placeholder="Contact ID"
            value={form.contact}
            onChangeText={(contact) => setForm((f) => ({ ...f, contact }))}
            error={errMsg("contact")}
          />
        )}
        <SegmentedChoice
          label={t("common.field.currency")}
          value={form.currency}
          choices={COMMON_CURRENCIES.map((c) => ({ value: c, label: c }))}
          onChange={(currency) => setForm((f) => ({ ...f, currency }))}
        />
        <SegmentedChoice<Locale>
          label={t("common.field.language")}
          value={form.language}
          choices={[
            { value: "cs", label: t("enum.locale.cs") },
            { value: "en", label: t("enum.locale.en") },
          ]}
          onChange={(language) => setForm((f) => ({ ...f, language }))}
        />
        <TextField
          label={t("templates.editor.dueInDays")}
          keyboardType="number-pad"
          value={form.dueInDays}
          onChangeText={(dueInDays) => setForm((f) => ({ ...f, dueInDays }))}
          error={errMsg("dueInDays")}
        />
        <SegmentedChoice<PaymentMethod>
          label={t("contacts.editor.defaults.paymentMethod")}
          value={form.paymentMethod}
          choices={PAYMENT_METHODS.map((m) => ({ value: m, label: t(`enum.paymentMethod.${m}`) }))}
          onChange={(paymentMethod) => setForm((f) => ({ ...f, paymentMethod }))}
        />
        <TextField
          label={t("common.field.note")}
          multiline
          value={form.note}
          onChangeText={(note) => setForm((f) => ({ ...f, note }))}
        />
      </Section>

      <Section
        title={local({ cs: "Položky", en: "Lines" })}
        action={
          <Button
            kind="text"
            icon={Plus}
            label={t("common.action.add")}
            onPress={() =>
              setForm((f) => ({
                ...f,
                lines: [
                  ...f.lines,
                  {
                    id: `line-${Date.now()}-${f.lines.length}`,
                    description: "",
                    quantity: "1",
                    unit: "ks",
                    unitPrice: "",
                    vat: "standard",
                  },
                ],
              }))
            }
          />
        }
      >
        {form.lines.map((line, idx) => (
          <Card key={line.id}>
            <TextField
              label={t("common.field.description")}
              value={line.description}
              onChangeText={(description) =>
                setForm((f) => ({
                  ...f,
                  lines: f.lines.map((l, i) => (i === idx ? { ...l, description } : l)),
                }))
              }
              error={errMsg(`lines.${idx}.description`)}
            />
            <View style={styles.rowFields}>
              <View style={styles.flex}>
                <TextField
                  label={t("common.field.quantity")}
                  keyboardType="decimal-pad"
                  value={line.quantity}
                  onChangeText={(quantity) =>
                    setForm((f) => ({
                      ...f,
                      lines: f.lines.map((l, i) => (i === idx ? { ...l, quantity } : l)),
                    }))
                  }
                  error={errMsg(`lines.${idx}.quantity`)}
                />
              </View>
              <View style={styles.flex}>
                <TextField
                  label={t("common.field.unit")}
                  value={line.unit}
                  onChangeText={(unit) =>
                    setForm((f) => ({
                      ...f,
                      lines: f.lines.map((l, i) => (i === idx ? { ...l, unit } : l)),
                    }))
                  }
                />
              </View>
              <View style={styles.flex}>
                <TextField
                  label={t("common.field.unitPrice")}
                  keyboardType="decimal-pad"
                  value={line.unitPrice}
                  onChangeText={(unitPrice) =>
                    setForm((f) => ({
                      ...f,
                      lines: f.lines.map((l, i) => (i === idx ? { ...l, unitPrice } : l)),
                    }))
                  }
                  error={errMsg(`lines.${idx}.unitPrice`)}
                />
              </View>
            </View>
            <SegmentedChoice<VatTreatment>
              value={line.vat}
              choices={EXPENSE_VAT_TREATMENTS.map((tr) => ({
                value: tr,
                label: t(`enum.vatTreatment.${tr}`),
              }))}
              onChange={(vat) =>
                setForm((f) => ({
                  ...f,
                  lines: f.lines.map((l, i) => (i === idx ? { ...l, vat } : l)),
                }))
              }
            />
            {form.lines.length <= 1 ? null : (
              <Button
                kind="text"
                icon={Trash2}
                label={t("common.action.remove")}
                onPress={() =>
                  setForm((f) => ({ ...f, lines: f.lines.filter((_, i) => i !== idx) }))
                }
              />
            )}
          </Card>
        ))}
      </Section>
    </>
  );

  const renderScheduleTab = (tpl: TemplateViewData) => {
    const state = scheduleStateOf(tpl.schedule);
    return (
      <>
        {tpl.schedule?.paused ? (
          <Banner
            tone="warning"
            text={
              tpl.schedule.pausedReason !== null
                ? `${t("templates.runs.paused")} (${tpl.schedule.pausedReason})`
                : t("templates.runs.paused")
            }
            action={{
              label: t("templates.runs.resume"),
              onPress: () => void handleResumeSchedule(),
            }}
          />
        ) : null}

        <Card>
          <View style={styles.headerRow}>
            <Text variant="titleMedium" style={styles.flex}>
              {t("templates.schedule.title")}
            </Text>
            <Badge
              label={state === "none" ? t("common.state.none") : t(`enum.scheduleState.${state}`)}
              tone={state === "active" ? "success" : state === "paused" ? "warning" : "neutral"}
            />
          </View>
          {tpl.schedule?.nextOccurrence !== undefined && tpl.schedule?.nextOccurrence !== null ? (
            <Text variant="meta" color="onSurfaceVariant">
              {t("templates.list.nextRun", {
                date: formatDate(locale, tpl.schedule.nextOccurrence),
              })}
            </Text>
          ) : null}
        </Card>

        <Section title={t("templates.schedule.every")}>
          <View style={styles.rowFields}>
            <View style={styles.countField}>
              <TextField
                label="#"
                keyboardType="number-pad"
                value={scheduleForm.count}
                onChangeText={(count) => setScheduleForm((s) => ({ ...s, count }))}
                testID="schedule-count"
              />
            </View>
            <View style={styles.flex}>
              <SegmentedChoice<CadenceUnit>
                value={scheduleForm.unit}
                choices={[
                  { value: "weeks", label: t("enum.cadenceUnit.weeks") },
                  { value: "months", label: t("enum.cadenceUnit.months") },
                  { value: "years", label: t("enum.cadenceUnit.years") },
                ]}
                onChange={(unit) => setScheduleForm((s) => ({ ...s, unit }))}
              />
            </View>
          </View>
          <TextField
            label={t("templates.schedule.start")}
            placeholder="YYYY-MM-DD"
            value={scheduleForm.startOn}
            onChangeText={(startOn) => setScheduleForm((s) => ({ ...s, startOn }))}
          />
          <TextField
            label={t("templates.schedule.end")}
            placeholder="YYYY-MM-DD"
            value={scheduleForm.endOn}
            onChangeText={(endOn) => setScheduleForm((s) => ({ ...s, endOn }))}
          />
          <SegmentedChoice<"invoice" | "proforma">
            label={t("templates.schedule.issueAs")}
            value={scheduleForm.issueAs}
            choices={[
              { value: "invoice", label: t("enum.issueAs.invoice") },
              { value: "proforma", label: t("enum.issueAs.proforma") },
            ]}
            onChange={(issueAs) => setScheduleForm((s) => ({ ...s, issueAs }))}
          />
          <SwitchRow
            label={t("templates.schedule.autoSend")}
            value={scheduleForm.autoSend}
            onChange={(autoSend) => setScheduleForm((s) => ({ ...s, autoSend }))}
          />
        </Section>

        {previewDates.length === 0 ? null : (
          <Card>
            <Text variant="labelMedium" color="onSurfaceVariant">
              {t("templates.schedule.nextDates")}
            </Text>
            {previewDates.map((d) => (
              <Text key={d} variant="bodyMedium" numeric>
                {formatDate(locale, d)}
              </Text>
            ))}
          </Card>
        )}

        <View style={styles.quickActions}>
          <Button
            label={t("common.action.save")}
            busy={saving}
            onPress={() => void handleSaveSchedule()}
            testID="schedule-save"
          />
          {tpl.schedule === null ? null : (
            <Button
              kind="danger"
              label={t("templates.schedule.detach")}
              busy={actionBusy}
              onPress={() => void handleRemoveSchedule()}
              testID="schedule-detach"
            />
          )}
        </View>
      </>
    );
  };

  const renderRunsTab = () => (
    <RemoteView state={runsRemote.state} onRetry={runsRemote.reload}>
      {(page) => {
        if (page.items.length === 0) {
          return <EmptyState title={t("templates.runs.empty")} />;
        }
        return (
          <Section
            title={t("templates.runs.title")}
            action={
              <IconButton
                icon={RefreshCw}
                label={t("common.action.refresh")}
                onPress={runsRemote.reload}
              />
            }
          >
            {page.items.map((run) => {
              const doc = run.document;
              return (
                <ListRow
                  key={`${run.occurrence}-${run.at}`}
                  title={formatDate(locale, run.occurrence)}
                  subtitle={
                    doc !== null
                      ? t("templates.runs.issued", { number: doc.number })
                      : run.failure !== null
                        ? t("templates.runs.failed", { reason: run.failure })
                        : run.at
                  }
                  badge={
                    <Badge
                      label={t(`enum.scheduleRunOutcome.${run.outcome}`)}
                      tone={runTone(run.outcome)}
                    />
                  }
                  {...(doc !== null
                    ? {
                        onPress: () =>
                          navigate({
                            _tag: "Document",
                            ws: workspace.slug,
                            id: doc.id,
                            tab: "preview",
                          }),
                      }
                    : {})}
                />
              );
            })}
          </Section>
        );
      }}
    </RemoteView>
  );

  return (
    <Screen
      title={isNew ? t("templates.list.new") : (loaded?.name ?? t("templates.editor.title"))}
      back
      actions={
        isNew || loaded === null ? null : (
          <IconButton
            icon={Archive}
            label={t("common.action.archive")}
            onPress={() => void handleArchive()}
          />
        )
      }
      footer={
        tab === "template" ? (
          <Button
            label={t("common.action.save")}
            busy={saving}
            onPress={() => void handleSaveTemplate()}
            testID="template-save"
          />
        ) : undefined
      }
    >
      {bannerError === null ? null : <Banner text={bannerError} />}

      {isNew ? null : <SegmentedChoice value={tab} choices={tabChoices} onChange={setTab} />}

      {isNew ? (
        renderTemplateForm()
      ) : (
        <RemoteView state={templateRemote.state} onRetry={templateRemote.reload}>
          {(raw) => {
            const tpl = decodeTemplate(raw);
            if (tab === "schedule") return renderScheduleTab(tpl);
            if (tab === "runs") return renderRunsTab();
            return renderTemplateForm();
          }}
        </RemoteView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  rowFields: { flexDirection: "row", gap: space.sm, alignItems: "flex-end" },
  countField: { width: 84 },
  quickActions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
});
