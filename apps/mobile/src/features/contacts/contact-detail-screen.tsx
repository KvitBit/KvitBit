import type {
  ContactId,
  ContactRole,
  CurrencyCode,
  Locale,
  PaymentMethod,
  RegistryResult,
  WorkspaceSummary,
} from "@kvitbit/domain/contract";
import {
  describeError,
  ensureRequestKey,
  type FieldIssue,
  idempotencyHeaders,
  ifMatchHeaders,
  inWorkspace,
  issuesAt,
  keyAfter,
  partitionIssues,
  type Remote,
} from "@kvitbit/ui-port/api";
import {
  formatDate,
  formatDateTime,
  formatMoney,
  normalizeIco,
  validateIco,
} from "@kvitbit/ui-port/format";
import { enumKey } from "@kvitbit/ui-port/i18n";
import { OverrideForm, type Route } from "@kvitbit/ui-port/view-models";
import { Effect, Option, Result } from "effect";
import { useLocalSearchParams } from "expo-router";
import {
  Archive,
  Building2,
  FilePlus2,
  FileText,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  canWriteWorkspace,
  type DashboardDocument,
  parseDocumentSummaries,
} from "../dashboard/model";
import {
  applyRegistryToForm,
  buildContactInput,
  COMMON_COUNTRIES,
  CONTACT_CURRENCIES,
  CONTACT_LANGUAGES,
  CONTACT_PAYMENT_METHODS,
  type ContactFormErrorCode,
  type ContactFormState,
  type ContactRecord,
  contactFormFromRecord,
  diffContactWithRegistry,
  emptyContactForm,
  isValidEmail,
  parseContactView,
  type RegistryDiffItem,
  summarizeContactDocuments,
  validateContactForm,
} from "./model";

const INHERIT = "__inherit__";

const formatAddress = (contact: ContactRecord): string =>
  [
    contact.address.street,
    contact.address.postalCode,
    contact.address.city,
    contact.address.country,
  ]
    .filter((p): p is string => p !== null && p !== "")
    .join(", ");

export interface ContactDetailViewProps {
  readonly workspace: WorkspaceSummary;
  readonly contact: ContactRecord;
  readonly documents: Remote<ReadonlyArray<DashboardDocument>>;
  readonly onRetryDocuments: () => void;
  readonly onEdit: () => void;
  readonly onArchive: () => void;
  readonly archiving: boolean;
  readonly onRefreshAres: () => void;
  readonly refreshingAres: boolean;
  readonly aresDiff: {
    readonly result: RegistryResult;
    readonly items: ReadonlyArray<RegistryDiffItem>;
  } | null;
  readonly onApplyAresDiff: () => void;
  readonly onDismissAresDiff: () => void;
  readonly applyingAres: boolean;
  readonly onNavigate: (route: Route) => void;
}

export function ContactDetailView(props: ContactDetailViewProps) {
  const { t, locale, local } = useI18n();
  const { contact, workspace } = props;
  const ws = workspace.slug;
  const writable = canWriteWorkspace(workspace);

  const fieldLabel = (field: RegistryDiffItem["field"]): string => {
    switch (field) {
      case "name":
        return t("common.field.name");
      case "dic":
        return t("common.field.dic");
      case "legalForm":
        return local({ cs: "Právní forma", en: "Legal form" });
      case "street":
        return t("common.field.street");
      case "city":
        return t("common.field.city");
      case "postalCode":
        return t("common.field.postalCode");
      case "country":
        return t("common.field.country");
    }
  };

  const defaults = contact.defaults;
  const reminderLabel =
    defaults.reminderPolicy === undefined || defaults.reminderPolicy.mode === "inherit"
      ? t("contacts.override.workspaceDefault")
      : defaults.reminderPolicy.mode === "disabled"
        ? t(enumKey("reminderMode", "disabled"))
        : `${t(enumKey("reminderMode", "custom"))} (${defaults.reminderPolicy.offsetsDays.join(", ")})`;

  return (
    <View style={styles.stack}>
      {workspace.closed ? <Banner tone="warning" text={t("shell.closedWorkspace")} /> : null}
      {contact.archived ? (
        <Banner
          tone="info"
          text={local({
            cs: "Tento kontakt je archivovaný a nezobrazuje se ve výběrech. Jeho doklady zůstávají zachovány.",
            en: "This contact is archived and hidden from pickers. Its documents remain intact.",
          })}
        />
      ) : null}

      <Card>
        <View style={styles.headerRow}>
          <Text variant="titleLarge" style={styles.flex}>
            {contact.name}
          </Text>
          <View style={styles.badges}>
            {contact.roles.map((role) => (
              <Badge
                key={role}
                tone={role === "customer" ? "info" : "neutral"}
                label={t(enumKey("contactRole", role))}
              />
            ))}
            {contact.archived ? <Badge tone="draft" label={t("common.action.archive")} /> : null}
          </View>
        </View>

        {contact.legalForm !== null ? (
          <Text variant="bodyMedium" color="onSurfaceVariant">
            {contact.legalForm}
          </Text>
        ) : null}

        {contact.registryFetchedAt !== null ? (
          <Text variant="meta" color="onSurfaceVariant">
            {local({
              cs: `Z ARES (${formatDateTime(locale, contact.registryFetchedAt)})`,
              en: `From ARES (${formatDateTime(locale, contact.registryFetchedAt)})`,
            })}
          </Text>
        ) : null}

        {writable && !contact.archived ? (
          <View style={styles.actionRow}>
            <Button
              label={t("contacts.detail.newInvoice")}
              icon={FilePlus2}
              onPress={() =>
                props.onNavigate({
                  _tag: "DocumentNew",
                  ws,
                  kind: "invoice",
                  from: { _tag: "Contact", id: contact.id },
                })
              }
            />
            {contact.ico !== null ? (
              <Button
                kind="tonal"
                label={t("contacts.detail.refreshAres")}
                icon={RefreshCw}
                busy={props.refreshingAres}
                onPress={props.onRefreshAres}
              />
            ) : null}
          </View>
        ) : null}
      </Card>

      {props.aresDiff !== null ? (
        <Card>
          <Text variant="titleMedium">
            {local({ cs: "Změny z ARES", en: "Changes from ARES" })}
          </Text>
          {props.aresDiff.result.terminatedOn !== null ? (
            <Banner
              tone="warning"
              text={local({
                cs: `Subjekt byl ukončen dne ${formatDate(locale, props.aresDiff.result.terminatedOn)}.`,
                en: `Entity was terminated on ${formatDate(locale, props.aresDiff.result.terminatedOn)}.`,
              })}
            />
          ) : null}
          {props.aresDiff.items.map((item) => (
            <ListRow
              key={item.field}
              title={fieldLabel(item.field)}
              subtitle={`${item.before ?? t("common.state.notSet")} → ${item.after ?? t("common.state.notSet")}`}
            />
          ))}
          <View style={styles.actionRow}>
            <Button
              label={t("common.action.apply")}
              busy={props.applyingAres}
              onPress={props.onApplyAresDiff}
            />
            <Button
              kind="outlined"
              label={t("common.action.cancel")}
              onPress={props.onDismissAresDiff}
            />
          </View>
        </Card>
      ) : null}

      <Section title={t("contacts.detail.particulars")}>
        <Card style={styles.listCard}>
          <ListRow
            title={t("common.field.ico")}
            trailing={contact.ico ?? t("common.state.notSet")}
          />
          <ListRow
            title={t("common.field.dic")}
            trailing={contact.dic ?? t("common.state.notSet")}
          />
          <ListRow title={t("common.field.address")} subtitle={formatAddress(contact)} />
          {contact.phone !== null ? (
            <ListRow title={t("common.field.phone")} trailing={contact.phone} />
          ) : null}
          <ListRow
            title={t("contacts.editor.invoicingEmails")}
            subtitle={
              contact.billingEmails.length > 0
                ? contact.billingEmails.join(", ")
                : t("common.state.notSet")
            }
          />
          {contact.note !== null ? (
            <ListRow title={t("common.field.note")} subtitle={contact.note} />
          ) : null}
        </Card>
      </Section>

      <Section title={t("contacts.detail.billingDefaults")}>
        <Card style={styles.listCard}>
          <ListRow
            title={t("contacts.editor.defaults.currency")}
            trailing={defaults.currency ?? t("contacts.override.workspaceDefault")}
            badge={
              defaults.currency !== undefined ? (
                <Badge tone="info" label={t("contacts.override.overridden")} />
              ) : undefined
            }
          />
          <ListRow
            title={t("contacts.editor.defaults.language")}
            trailing={
              defaults.language !== undefined
                ? t(enumKey("locale", defaults.language))
                : t("contacts.override.workspaceDefault")
            }
            badge={
              defaults.language !== undefined ? (
                <Badge tone="info" label={t("contacts.override.overridden")} />
              ) : undefined
            }
          />
          <ListRow
            title={t("contacts.editor.defaults.dueDays")}
            trailing={
              defaults.dueDays !== undefined
                ? t("common.time.days", { count: defaults.dueDays })
                : t("contacts.override.workspaceDefault")
            }
            badge={
              defaults.dueDays !== undefined ? (
                <Badge tone="info" label={t("contacts.override.overridden")} />
              ) : undefined
            }
          />
          <ListRow
            title={t("contacts.editor.defaults.paymentMethod")}
            trailing={
              defaults.paymentMethod !== undefined
                ? t(enumKey("paymentMethod", defaults.paymentMethod))
                : t("contacts.override.workspaceDefault")
            }
            badge={
              defaults.paymentMethod !== undefined ? (
                <Badge tone="info" label={t("contacts.override.overridden")} />
              ) : undefined
            }
          />
          <ListRow title={t("contacts.editor.defaults.reminders")} subtitle={reminderLabel} />
          {defaults.defaultNote !== undefined && defaults.defaultNote !== "" ? (
            <ListRow title={t("contacts.editor.defaults.note")} subtitle={defaults.defaultNote} />
          ) : null}
        </Card>
      </Section>

      <Section
        title={t("contacts.detail.documents")}
        action={
          <Button
            kind="text"
            label={t("common.action.view")}
            onPress={() =>
              props.onNavigate({ _tag: "Documents", ws, query: { contact: contact.id } })
            }
          />
        }
      >
        <RemoteView state={props.documents} onRetry={props.onRetryDocuments}>
          {(docs) => {
            const summary = summarizeContactDocuments(docs);
            return docs.length === 0 ? (
              <Card>
                <EmptyState title={t("common.state.empty")} />
              </Card>
            ) : (
              <View style={styles.stackSm}>
                {summary.overdueCount > 0 || summary.unpaidCount > 0 ? (
                  <View style={styles.badges}>
                    {summary.unpaidCount > 0 ? (
                      <Badge
                        tone="info"
                        label={`${t("reports.suite.receivables.unpaid")}: ${summary.unpaidCount}`}
                      />
                    ) : null}
                    {summary.overdueCount > 0 ? (
                      <Badge
                        tone="warning"
                        label={`${t("reports.suite.receivables.overdue")}: ${summary.overdueCount}`}
                      />
                    ) : null}
                  </View>
                ) : null}
                <Card style={styles.listCard}>
                  {docs.map((doc) => (
                    <ListRow
                      key={doc.id}
                      leading={FileText}
                      title={doc.number ?? t(enumKey("documentKind", doc.kind))}
                      subtitle={formatDate(locale, doc.issuedOn)}
                      trailing={formatMoney(locale, doc.total)}
                      badge={
                        doc.overdue ? (
                          <Badge tone="warning" label={t("enum.badge.overdue")} />
                        ) : undefined
                      }
                      onPress={() =>
                        props.onNavigate({ _tag: "Document", ws, id: doc.id, tab: "preview" })
                      }
                    />
                  ))}
                </Card>
              </View>
            );
          }}
        </RemoteView>
      </Section>

      {writable && !contact.archived ? (
        <View style={styles.actionRow}>
          <Button
            kind="outlined"
            icon={Pencil}
            label={t("common.action.edit")}
            onPress={props.onEdit}
          />
          <Button
            kind="danger"
            icon={Archive}
            label={t("common.action.archive")}
            busy={props.archiving}
            onPress={props.onArchive}
          />
        </View>
      ) : null}
    </View>
  );
}

export interface ContactEditorViewProps {
  readonly isNew: boolean;
  readonly form: ContactFormState;
  readonly onChangeForm: (updater: (prev: ContactFormState) => ContactFormState) => void;
  readonly clientErrors: Readonly<Partial<Record<string, ContactFormErrorCode>>>;
  readonly serverIssues: ReadonlyArray<FieldIssue>;
  readonly bannerError: string | null;
  readonly staleRevision: boolean;
  readonly duplicateIco: boolean;
  readonly onReloadLatest: () => void;
  readonly onOpenContactsSearch: () => void;
  readonly onLookupAres: () => void;
  readonly lookingUpAres: boolean;
  readonly aresNotice: {
    readonly tone: "info" | "warning" | "error";
    readonly text: string;
  } | null;
  readonly onSave: () => void;
  readonly onCancel: () => void;
  readonly saving: boolean;
}

export function ContactEditorView(props: ContactEditorViewProps) {
  const { t, text, local } = useI18n();
  const { form, onChangeForm } = props;
  const [newEmail, setNewEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);

  const ownedPaths = useMemo(
    () =>
      new Set([
        "name",
        "roles",
        "ico",
        "dic",
        "legalForm",
        "address.street",
        "address.city",
        "address.postalCode",
        "address.country",
        "billingEmails",
        "phone",
        "note",
        "defaults.dueDays",
        "defaults.reminderPolicy",
      ]),
    [],
  );

  const partitioned = useMemo(
    () => partitionIssues(props.serverIssues, (path) => ownedPaths.has(path.join("."))),
    [props.serverIssues, ownedPaths],
  );

  const clientErrorMessage = (code: ContactFormErrorCode | undefined): string | null => {
    if (code === undefined) return null;
    switch (code) {
      case "name_required":
        return local({ cs: "Zadejte název kontaktu.", en: "Enter a contact name." });
      case "roles_required":
        return local({ cs: "Vyberte alespoň jednu roli.", en: "Select at least one role." });
      case "ico_format":
        return t("issue.form.ico_format");
      case "ico_checksum":
        return t("issue.ico.checksum");
      case "country_invalid":
        return local({
          cs: "Zadejte dvoupísmenný kód země (např. CZ).",
          en: "Enter a 2-letter ISO country code (e.g. CZ).",
        });
      case "due_days_invalid":
        return local({
          cs: "Splatnost musí být nezáporné celé číslo.",
          en: "Due days must be a non-negative whole number.",
        });
      case "reminder_offsets_invalid":
        return local({
          cs: "Zadejte dny oddělené čárkou (např. 3, 7, 14).",
          en: "Enter comma-separated whole days (e.g. 3, 7, 14).",
        });
    }
  };

  const fieldError = (path: ReadonlyArray<string>): string | null => {
    const key = path.join(".");
    const localMsg = clientErrorMessage(props.clientErrors[key]);
    if (localMsg !== null) return localMsg;
    const server = issuesAt(props.serverIssues, path)[0];
    return server !== undefined ? text(server.text) : null;
  };

  const toggleRole = (role: ContactRole, enabled: boolean) => {
    onChangeForm((prev) => {
      const next = enabled
        ? [...new Set([...prev.roles, role])]
        : prev.roles.filter((r) => r !== role);
      return { ...prev, roles: next };
    });
  };

  const addEmail = () => {
    const trimmed = newEmail.trim();
    if (!isValidEmail(trimmed)) {
      setEmailError(local({ cs: "Zadejte platný e-mail.", en: "Enter a valid email address." }));
      return;
    }
    if (form.billingEmails.includes(trimmed)) {
      setNewEmail("");
      setEmailError(null);
      return;
    }
    onChangeForm((prev) => ({ ...prev, billingEmails: [...prev.billingEmails, trimmed] }));
    setNewEmail("");
    setEmailError(null);
  };

  const removeEmail = (email: string) => {
    onChangeForm((prev) => ({
      ...prev,
      billingEmails: prev.billingEmails.filter((e) => e !== email),
    }));
  };

  const currencyChoices: ReadonlyArray<Choice<string>> = useMemo(
    () => [
      { value: INHERIT, label: t("contacts.override.workspaceDefault") },
      ...CONTACT_CURRENCIES.map((c) => ({ value: c, label: c })),
    ],
    [t],
  );

  const languageChoices: ReadonlyArray<Choice<string>> = useMemo(
    () => [
      { value: INHERIT, label: t("contacts.override.workspaceDefault") },
      ...CONTACT_LANGUAGES.map((lang) => ({ value: lang, label: t(enumKey("locale", lang)) })),
    ],
    [t],
  );

  const paymentMethodChoices: ReadonlyArray<Choice<string>> = useMemo(
    () => [
      { value: INHERIT, label: t("contacts.override.workspaceDefault") },
      ...CONTACT_PAYMENT_METHODS.map((method) => ({
        value: method,
        label: t(enumKey("paymentMethod", method)),
      })),
    ],
    [t],
  );

  const reminderChoices: ReadonlyArray<Choice<"inherit" | "disabled" | "custom">> = useMemo(
    () => [
      { value: "inherit", label: t(enumKey("reminderMode", "inherit")) },
      { value: "disabled", label: t(enumKey("reminderMode", "disabled")) },
      { value: "custom", label: t(enumKey("reminderMode", "custom")) },
    ],
    [t],
  );

  const countryChoices: ReadonlyArray<Choice<string>> = useMemo(
    () => COMMON_COUNTRIES.map((code) => ({ value: code, label: code })),
    [],
  );

  const currentReminderMode = form.overrides.current.reminderPolicy?.mode ?? "inherit";

  return (
    <View style={styles.stack}>
      {!props.isNew ? (
        <Banner
          tone="info"
          text={local({
            cs: "Úprava kontaktu nemění již vystavené doklady.",
            en: "Editing a contact does not change already issued documents.",
          })}
        />
      ) : null}

      {props.staleRevision ? (
        <Banner
          tone="warning"
          text={t("error.conflict.revision_changed")}
          action={{ label: t("common.action.reload"), onPress: props.onReloadLatest }}
        />
      ) : null}

      {props.duplicateIco ? (
        <Banner
          tone="error"
          text={t("contacts.editor.duplicate")}
          action={{ label: t("contacts.editor.openExisting"), onPress: props.onOpenContactsSearch }}
        />
      ) : null}

      {props.bannerError !== null && !props.staleRevision && !props.duplicateIco ? (
        <Banner tone="error" text={props.bannerError} />
      ) : null}

      {partitioned.summary.length > 0 ? (
        <Banner tone="error" text={partitioned.summary.map((i) => text(i.text)).join(" ")} />
      ) : null}

      <Card>
        <View style={styles.headerRow}>
          <Building2 size={20} color="#666" />
          <Text variant="titleMedium" style={styles.flex}>
            {t("contacts.editor.icoFirst")}
          </Text>
        </View>
        <TextField
          label={t("common.field.ico")}
          value={form.ico}
          onChangeText={(ico) => onChangeForm((prev) => ({ ...prev, ico }))}
          keyboardType="number-pad"
          placeholder="27074358"
          error={fieldError(["ico"])}
          testID="contact-ico-input"
        />
        <Button
          kind="tonal"
          icon={Search}
          label={t("contacts.editor.lookup")}
          busy={props.lookingUpAres}
          onPress={props.onLookupAres}
          testID="contact-ares-lookup"
        />
        {props.aresNotice !== null ? (
          <Banner tone={props.aresNotice.tone} text={props.aresNotice.text} />
        ) : null}
      </Card>

      <Section title={t("contacts.detail.particulars")}>
        <Card>
          <TextField
            label={t("contacts.editor.companyName")}
            value={form.name}
            onChangeText={(name) => onChangeForm((prev) => ({ ...prev, name }))}
            error={fieldError(["name"])}
            testID="contact-name-input"
          />
          <TextField
            label={t("common.field.dic")}
            value={form.dic}
            onChangeText={(dic) => onChangeForm((prev) => ({ ...prev, dic }))}
            autoCapitalize="characters"
            placeholder="CZ27074358"
            error={fieldError(["dic"])}
          />
          <TextField
            label={local({ cs: "Právní forma", en: "Legal form" })}
            value={form.legalForm}
            onChangeText={(legalForm) => onChangeForm((prev) => ({ ...prev, legalForm }))}
            error={fieldError(["legalForm"])}
          />
          <SwitchRow
            label={t(enumKey("contactRole", "customer"))}
            value={form.roles.includes("customer")}
            onChange={(v) => toggleRole("customer", v)}
          />
          <SwitchRow
            label={t(enumKey("contactRole", "supplier"))}
            value={form.roles.includes("supplier")}
            onChange={(v) => toggleRole("supplier", v)}
          />
          {fieldError(["roles"]) !== null ? (
            <Text variant="bodySmall" color="error">
              {fieldError(["roles"])}
            </Text>
          ) : null}
          <TextField
            label={t("common.field.phone")}
            value={form.phone}
            onChangeText={(phone) => onChangeForm((prev) => ({ ...prev, phone }))}
            keyboardType="phone-pad"
          />
          <TextField
            label={t("common.field.note")}
            value={form.note}
            onChangeText={(note) => onChangeForm((prev) => ({ ...prev, note }))}
            multiline
          />
        </Card>
      </Section>

      <Section title={t("common.field.address")}>
        <Card>
          <SegmentedChoice
            label={t("common.field.country")}
            value={
              COMMON_COUNTRIES.includes(
                form.country.toUpperCase() as (typeof COMMON_COUNTRIES)[number],
              )
                ? form.country.toUpperCase()
                : null
            }
            choices={countryChoices}
            onChange={(country) => onChangeForm((prev) => ({ ...prev, country }))}
          />
          <TextField
            label={t("common.field.country")}
            value={form.country}
            onChangeText={(country) =>
              onChangeForm((prev) => ({ ...prev, country: country.toUpperCase().slice(0, 2) }))
            }
            autoCapitalize="characters"
            maxLength={2}
            error={fieldError(["address", "country"])}
          />
          <TextField
            label={t("common.field.street")}
            value={form.street}
            onChangeText={(street) => onChangeForm((prev) => ({ ...prev, street }))}
          />
          <TextField
            label={t("common.field.city")}
            value={form.city}
            onChangeText={(city) => onChangeForm((prev) => ({ ...prev, city }))}
          />
          <TextField
            label={t("common.field.postalCode")}
            value={form.postalCode}
            onChangeText={(postalCode) => onChangeForm((prev) => ({ ...prev, postalCode }))}
          />
        </Card>
      </Section>

      <Section title={t("contacts.editor.invoicingEmails")}>
        <Card>
          {form.billingEmails.map((email) => (
            <View key={email} style={styles.emailRow}>
              <Text variant="bodyMedium" style={styles.flex}>
                {email}
              </Text>
              <IconButton
                icon={Trash2}
                label={t("common.action.remove")}
                onPress={() => removeEmail(email)}
              />
            </View>
          ))}
          <TextField
            label={t("common.field.email")}
            value={newEmail}
            onChangeText={(v) => {
              setNewEmail(v);
              setEmailError(null);
            }}
            keyboardType="email-address"
            autoCapitalize="none"
            placeholder="billing@example.com"
            error={emailError}
          />
          <Button
            kind="outlined"
            icon={Plus}
            label={t("contacts.editor.addEmail")}
            onPress={addEmail}
          />
        </Card>
      </Section>

      <Section title={t("contacts.editor.defaults.title")}>
        <Card>
          <Text variant="bodySmall" color="onSurfaceVariant">
            {t("contacts.editor.defaults.intro")}
          </Text>

          <SegmentedChoice
            label={t("contacts.editor.defaults.currency")}
            value={form.overrides.current.currency ?? INHERIT}
            choices={currencyChoices}
            onChange={(val) =>
              onChangeForm((prev) => ({
                ...prev,
                overrides:
                  val === INHERIT
                    ? OverrideForm.clear(prev.overrides, "currency")
                    : OverrideForm.set(prev.overrides, "currency", val as CurrencyCode),
              }))
            }
          />

          <SegmentedChoice
            label={t("contacts.editor.defaults.language")}
            value={form.overrides.current.language ?? INHERIT}
            choices={languageChoices}
            onChange={(val) =>
              onChangeForm((prev) => ({
                ...prev,
                overrides:
                  val === INHERIT
                    ? OverrideForm.clear(prev.overrides, "language")
                    : OverrideForm.set(prev.overrides, "language", val as Locale),
              }))
            }
          />

          <TextField
            label={t("contacts.editor.defaults.dueDays")}
            value={form.dueDaysText}
            onChangeText={(dueDaysText) => onChangeForm((prev) => ({ ...prev, dueDaysText }))}
            keyboardType="number-pad"
            placeholder={t("contacts.override.workspaceDefault")}
            error={fieldError(["defaults", "dueDays"])}
          />

          <SegmentedChoice
            label={t("contacts.editor.defaults.paymentMethod")}
            value={form.overrides.current.paymentMethod ?? INHERIT}
            choices={paymentMethodChoices}
            onChange={(val) =>
              onChangeForm((prev) => ({
                ...prev,
                overrides:
                  val === INHERIT
                    ? OverrideForm.clear(prev.overrides, "paymentMethod")
                    : OverrideForm.set(prev.overrides, "paymentMethod", val as PaymentMethod),
              }))
            }
          />

          <TextField
            label={t("contacts.editor.defaults.note")}
            value={form.overrides.current.defaultNote ?? ""}
            onChangeText={(val) =>
              onChangeForm((prev) => ({
                ...prev,
                overrides:
                  val.trim() === ""
                    ? OverrideForm.clear(prev.overrides, "defaultNote")
                    : OverrideForm.set(prev.overrides, "defaultNote", val),
              }))
            }
            placeholder={t("contacts.override.workspaceDefault")}
            multiline
          />

          <SegmentedChoice
            label={t("contacts.editor.defaults.reminders")}
            value={currentReminderMode}
            choices={reminderChoices}
            onChange={(mode) =>
              onChangeForm((prev) => ({
                ...prev,
                overrides:
                  mode === "inherit"
                    ? OverrideForm.setReminderPolicy(prev.overrides, { mode: "inherit" })
                    : mode === "disabled"
                      ? OverrideForm.setReminderPolicy(prev.overrides, { mode: "disabled" })
                      : OverrideForm.setReminderPolicy(prev.overrides, {
                          mode: "custom",
                          offsetsDays: [3, 7, 14],
                        }),
                reminderOffsetsText:
                  mode === "custom" && prev.reminderOffsetsText.trim() === ""
                    ? "3, 7, 14"
                    : prev.reminderOffsetsText,
              }))
            }
          />

          {currentReminderMode === "custom" ? (
            <TextField
              label={t("contacts.editor.defaults.reminderOffsets")}
              value={form.reminderOffsetsText}
              onChangeText={(reminderOffsetsText) =>
                onChangeForm((prev) => ({ ...prev, reminderOffsetsText }))
              }
              placeholder="3, 7, 14"
              error={fieldError(["defaults", "reminderPolicy"])}
            />
          ) : null}
        </Card>
      </Section>

      <View style={styles.actionRow}>
        <Button
          label={t("common.action.save")}
          busy={props.saving}
          onPress={props.onSave}
          testID="contact-save-button"
        />
        <Button kind="outlined" label={t("common.action.cancel")} onPress={props.onCancel} />
      </View>
    </View>
  );
}

export function ContactDetailScreen() {
  const { workspace } = useWorkspace();
  const api = useApi();
  const overlay = useOverlay();
  const { t, text, locale, local } = useI18n();
  const params = useLocalSearchParams<{ id?: string; mode?: string }>();
  const rawId = param(params.id) ?? "new";
  const initialMode = param(params.mode) === "edit" || rawId === "new" ? "edit" : "view";
  const isNew = rawId === "new";
  const contactId = isNew ? null : (rawId as ContactId);

  const [mode, setMode] = useState<"view" | "edit">(initialMode);
  const [form, setForm] = useState<ContactFormState>(emptyContactForm);
  const [clientErrors, setClientErrors] = useState<
    Readonly<Partial<Record<string, ContactFormErrorCode>>>
  >({});
  const [serverIssues, setServerIssues] = useState<ReadonlyArray<FieldIssue>>([]);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [staleRevision, setStaleRevision] = useState(false);
  const [duplicateIco, setDuplicateIco] = useState(false);
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [lookingUpAres, setLookingUpAres] = useState(false);
  const [aresNotice, setAresNotice] = useState<{
    readonly tone: "info" | "warning" | "error";
    readonly text: string;
  } | null>(null);
  const [refreshingAres, setRefreshingAres] = useState(false);
  const [applyingAres, setApplyingAres] = useState(false);
  const [aresDiff, setAresDiff] = useState<{
    readonly result: RegistryResult;
    readonly items: ReadonlyArray<RegistryDiffItem>;
  } | null>(null);

  const requestKeyRef = useRef<Option.Option<string>>(Option.none());
  const loadedRevisionRef = useRef<number | null>(null);

  const contactRemote = useRemote(
    contactId === null
      ? null
      : (client) =>
          Effect.map(
            client.contacts.get({ params: inWorkspace(workspace.id, { contactId }) }),
            (view) => parseContactView(view),
          ),
    [workspace.id, contactId],
  );

  const documentsRemote = useRemote(
    contactId === null
      ? null
      : (client) =>
          Effect.map(
            client.documents.list({
              params: inWorkspace(workspace.id),
              query: { contact: contactId, limit: 10 },
            }),
            (page) => parseDocumentSummaries(page.items),
          ),
    [workspace.id, contactId],
  );

  // Sync loaded contact into editor when entering edit mode or after reload.
  useEffect(() => {
    if (contactRemote.state._tag === "Ready" && contactRemote.state.value !== null) {
      const record = contactRemote.state.value;
      if (loadedRevisionRef.current !== record.revision) {
        loadedRevisionRef.current = record.revision;
        setForm(contactFormFromRecord(record));
      }
    }
  }, [contactRemote.state]);

  const handleChangeForm = useCallback((updater: (prev: ContactFormState) => ContactFormState) => {
    requestKeyRef.current = Option.none();
    setForm(updater);
    setClientErrors({});
    setServerIssues([]);
    setDuplicateIco(false);
  }, []);

  const handleLookupAres = useCallback(async () => {
    const check = validateIco(form.ico);
    if (Result.isFailure(check)) {
      setClientErrors({
        ico: check.failure.code === "ico.checksum" ? "ico_checksum" : "ico_format",
      });
      return;
    }
    const ico = normalizeIco(check.success);
    setLookingUpAres(true);
    setAresNotice(null);
    setClientErrors({});
    const res = await api.run((client) => client.registry.lookupCompany({ params: { ico } }));
    setLookingUpAres(false);
    if (res._tag === "Ok") {
      setForm((prev) => applyRegistryToForm(prev, res.value));
      requestKeyRef.current = Option.none();
      if (res.value.terminatedOn !== null) {
        setAresNotice({
          tone: "warning",
          text: local({
            cs: `Subjekt byl ukončen dne ${formatDate(locale, res.value.terminatedOn)}. Kontakt přesto můžete uložit.`,
            en: `Entity was terminated on ${formatDate(locale, res.value.terminatedOn)}. You can still save.`,
          }),
        });
      } else {
        setAresNotice({ tone: "info", text: t("onboarding.wizard.entity.found") });
      }
      return;
    }
    if (res.error._tag === "NotFound") {
      setAresNotice({ tone: "warning", text: t("onboarding.wizard.entity.notFound") });
    } else if (res.error._tag === "Unavailable") {
      setAresNotice({ tone: "warning", text: t("onboarding.wizard.entity.aresDown") });
    } else {
      setAresNotice({ tone: "error", text: text(describeError(res.error).text) });
    }
  }, [api, form.ico, local, locale, t, text]);

  const handleSave = useCallback(async () => {
    const validation = validateContactForm(form);
    if (Object.keys(validation).length > 0) {
      setClientErrors(validation);
      return;
    }
    setSaving(true);
    setBannerError(null);
    setServerIssues([]);
    setStaleRevision(false);
    setDuplicateIco(false);

    const payload = buildContactInput(form);
    const result = isNew
      ? await (async () => {
          const key = await Effect.runPromise(ensureRequestKey(requestKeyRef.current));
          requestKeyRef.current = Option.some(key);
          return api.run((client) =>
            client.contacts.create({
              params: inWorkspace(workspace.id),
              headers: idempotencyHeaders(key),
              payload,
            }),
          );
        })()
      : await api.run((client) =>
          client.contacts.update({
            params: inWorkspace(workspace.id, { contactId: contactId as ContactId }),
            headers: ifMatchHeaders(loadedRevisionRef.current ?? 0),
            payload,
          }),
        );

    setSaving(false);
    if (isNew) {
      requestKeyRef.current = keyAfter(requestKeyRef.current, result);
    }

    if (result._tag === "Ok") {
      const saved = parseContactView(result.value);
      overlay.toast(t("common.toast.saved"));
      if (isNew && saved !== null) {
        navigate(
          { _tag: "Contact", ws: workspace.slug, id: saved.id, mode: "view" },
          { replace: true },
        );
      } else if (saved !== null) {
        loadedRevisionRef.current = saved.revision;
        contactRemote.set(saved);
        setForm(contactFormFromRecord(saved));
        setMode("view");
      }
      return;
    }

    const view = describeError(result.error);
    if (view.staleRevision) {
      setStaleRevision(true);
      return;
    }
    if (result.error._tag === "Conflict" && result.error.reason === "duplicate") {
      setDuplicateIco(true);
      return;
    }
    if (view.issues.length > 0) {
      setServerIssues(view.issues);
      return;
    }
    setBannerError(text(view.text));
  }, [api, contactId, contactRemote, form, isNew, overlay, t, text, workspace.id, workspace.slug]);

  const handleReloadLatest = useCallback(() => {
    loadedRevisionRef.current = null;
    setStaleRevision(false);
    setBannerError(null);
    contactRemote.reload();
  }, [contactRemote]);

  const handleArchive = useCallback(async () => {
    if (
      contactId === null ||
      contactRemote.state._tag !== "Ready" ||
      contactRemote.state.value === null
    ) {
      return;
    }
    const record = contactRemote.state.value;
    const confirmed = await overlay.confirm({
      title: `${t("common.action.archive")} ${record.name}?`,
      body: local({
        cs: "Kontakt se skryje z výběrů. Již vystavené doklady zůstanou zachovány.",
        en: "The contact will be hidden from pickers. Existing documents stay intact.",
      }),
      confirmLabel: t("common.action.archive"),
      cancelLabel: t("common.action.cancel"),
      destructive: true,
    });
    if (!confirmed) return;
    setArchiving(true);
    const res = await api.run((client) =>
      client.contacts.archive({ params: inWorkspace(workspace.id, { contactId }) }),
    );
    setArchiving(false);
    if (res._tag === "Ok") {
      overlay.toast(t("common.toast.archived", { name: record.name }));
      navigate({ _tag: "Contacts", ws: workspace.slug, query: {} }, { replace: true });
    } else {
      overlay.toast(text(describeError(res.error).text));
    }
  }, [api, contactId, contactRemote.state, local, overlay, t, text, workspace.id, workspace.slug]);

  const handleRefreshAres = useCallback(async () => {
    if (contactRemote.state._tag !== "Ready" || contactRemote.state.value === null) return;
    const record = contactRemote.state.value;
    if (record.ico === null) return;
    setRefreshingAres(true);
    const res = await api.run((client) =>
      client.registry.lookupCompany({ params: { ico: record.ico as string } }),
    );
    setRefreshingAres(false);
    if (res._tag === "Err") {
      overlay.toast(text(describeError(res.error).text));
      return;
    }
    const items = diffContactWithRegistry(record, res.value);
    if (items.length === 0) {
      overlay.toast(
        local({
          cs: "Údaje z ARES jsou aktuální.",
          en: "Details are already up to date with ARES.",
        }),
      );
      return;
    }
    setAresDiff({ result: res.value, items });
  }, [api, contactRemote.state, local, overlay, text]);

  const handleApplyAresDiff = useCallback(async () => {
    if (contactRemote.state._tag !== "Ready" || contactRemote.state.value === null) return;
    const record = contactRemote.state.value;
    if (record.ico === null) return;
    setApplyingAres(true);
    const res = await api.run((client) =>
      client.contacts.fromIco({
        params: inWorkspace(workspace.id),
        payload: { ico: record.ico as string },
      }),
    );
    setApplyingAres(false);
    if (res._tag === "Ok") {
      const updated = parseContactView(res.value);
      if (updated !== null) {
        loadedRevisionRef.current = updated.revision;
        contactRemote.set(updated);
        setForm(contactFormFromRecord(updated));
      }
      setAresDiff(null);
      overlay.toast(t("contacts.detail.refreshed"));
    } else {
      overlay.toast(text(describeError(res.error).text));
    }
  }, [api, contactRemote, overlay, t, text, workspace.id]);

  if (isNew) {
    return (
      <Screen title={t("contacts.list.new")} back>
        <ContactEditorView
          isNew
          form={form}
          onChangeForm={handleChangeForm}
          clientErrors={clientErrors}
          serverIssues={serverIssues}
          bannerError={bannerError}
          staleRevision={false}
          duplicateIco={duplicateIco}
          onReloadLatest={handleReloadLatest}
          onOpenContactsSearch={() =>
            navigate({
              _tag: "Contacts",
              ws: workspace.slug,
              query: form.ico.trim() !== "" ? { text: form.ico.trim() } : {},
            })
          }
          onLookupAres={handleLookupAres}
          lookingUpAres={lookingUpAres}
          aresNotice={aresNotice}
          onSave={handleSave}
          onCancel={() => navigate({ _tag: "Contacts", ws: workspace.slug, query: {} })}
          saving={saving}
        />
      </Screen>
    );
  }

  return (
    <Screen
      title={
        contactRemote.state._tag === "Ready" && contactRemote.state.value !== null
          ? contactRemote.state.value.name
          : t("contacts.editor.title")
      }
      back
      onRefresh={() => {
        contactRemote.reload();
        documentsRemote.reload();
      }}
      refreshing={contactRemote.state._tag === "Loading"}
    >
      <RemoteView state={contactRemote.state} onRetry={contactRemote.reload}>
        {(record) => {
          if (record === null) {
            return <EmptyState title={t("error.notFound")} />;
          }
          if (mode === "edit") {
            return (
              <ContactEditorView
                isNew={false}
                form={form}
                onChangeForm={handleChangeForm}
                clientErrors={clientErrors}
                serverIssues={serverIssues}
                bannerError={bannerError}
                staleRevision={staleRevision}
                duplicateIco={duplicateIco}
                onReloadLatest={handleReloadLatest}
                onOpenContactsSearch={() =>
                  navigate({
                    _tag: "Contacts",
                    ws: workspace.slug,
                    query: form.ico.trim() !== "" ? { text: form.ico.trim() } : {},
                  })
                }
                onLookupAres={handleLookupAres}
                lookingUpAres={lookingUpAres}
                aresNotice={aresNotice}
                onSave={handleSave}
                onCancel={() => {
                  setForm(contactFormFromRecord(record));
                  setClientErrors({});
                  setServerIssues([]);
                  setBannerError(null);
                  setStaleRevision(false);
                  setMode("view");
                }}
                saving={saving}
              />
            );
          }
          return (
            <ContactDetailView
              workspace={workspace}
              contact={record}
              documents={documentsRemote.state}
              onRetryDocuments={documentsRemote.reload}
              onEdit={() => {
                setForm(contactFormFromRecord(record));
                setMode("edit");
              }}
              onArchive={handleArchive}
              archiving={archiving}
              onRefreshAres={handleRefreshAres}
              refreshingAres={refreshingAres}
              aresDiff={aresDiff}
              onApplyAresDiff={handleApplyAresDiff}
              onDismissAresDiff={() => setAresDiff(null)}
              applyingAres={applyingAres}
              onNavigate={(route) => navigate(route)}
            />
          );
        }}
      </RemoteView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  stack: { gap: space.lg },
  stackSm: { gap: space.sm },
  headerRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.xs },
  listCard: { padding: space.xs, gap: 0 },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  emailRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
});
