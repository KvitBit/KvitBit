import { UiSchema } from "@effect/ui";
import type { Html } from "@effect/ui/html";
/**
 * Screen 12 — Invoice Templates & Recurring Schedules: lists, Template editor, Recurring Schedule
 * editor with cadence/issueAs/autoSend, pause/resume, Run history & failed-run attention.
 */
import {
  ContactId,
  CurrencyCode,
  DocumentId,
  type LineInput,
  PaymentMethod,
  RecurringRunView,
  TemplateId,
  type TemplateInput,
  type VatTreatment,
  type WorkspaceId,
} from "@kvitbit/domain";
import { I18n } from "@kvitbit/ui-port";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import type * as Types from "effect/Types";
import { Failure } from "../../app/api";
import type { PageCommand } from "../../app/commands";
import { type Copy, copy, textOf, translator } from "../../app/i18n";
import { Intent_ } from "../../app/intent";
import {
  type MessageHandlers,
  type PageContext,
  type PageReturn,
  RouteCases,
} from "../../app/page";
import * as Remote from "../../app/remote";
import { href } from "../../app/routing";
import {
  badge,
  banner,
  button,
  card,
  cardTitle,
  checkbox,
  dialog,
  emptyState,
  linkButton,
  mono,
  page,
  pageHeader,
  selectField,
  skeleton,
  table,
  tabs,
  textArea,
  textField,
} from "../../ui/kit";
import {
  apiCommand,
  ContactOptionData,
  canRole,
  decimalToInput,
  fmtDate,
  fmtDateTime,
  idempotencyHeaders,
  ifMatch,
  isIsoDateString,
  kindBadge,
  mintRequestKeyCommand,
  parseDecimalText,
  preserveRequestKey,
  readContacts,
  readTemplate,
  readTemplates,
  type ScheduleViewData,
  sharedCopy,
  TemplateViewData,
  todayPrague,
  withIdempotencyKey,
} from "./shared";

export const Route = Schema.Union([RouteCases.Templates, RouteCases.Template]);
export type Route = typeof Route.Type;

const CopyTable: Copy<
  | "listTitle"
  | "listSubtitle"
  | "newTemplate"
  | "backToList"
  | "emptyTitle"
  | "emptyBody"
  | "attentionBanner"
  | "useDraft"
  | "openTemplate"
  | "scheduleActive"
  | "schedulePaused"
  | "scheduleEnded"
  | "scheduleNone"
  | "nextRun"
  | "tabTemplate"
  | "tabSchedule"
  | "tabRuns"
  | "tabsLabel"
  | "nameLabel"
  | "kindLabel"
  | "contactLabel"
  | "contactPlaceholder"
  | "currencyLabel"
  | "dueDaysLabel"
  | "paymentMethodLabel"
  | "pricesIncludeVat"
  | "noteLabel"
  | "linesTitle"
  | "addLine"
  | "lineDesc"
  | "lineQty"
  | "lineUnit"
  | "linePrice"
  | "lineVat"
  | "removeLine"
  | "saveTemplate"
  | "archiveTemplate"
  | "archiveDialogTitle"
  | "archiveDialogBody"
  | "archiveConfirm"
  | "scheduleTitle"
  | "cadenceCount"
  | "cadenceUnit"
  | "startOn"
  | "endOn"
  | "issueAs"
  | "autoSend"
  | "saveSchedule"
  | "removeSchedule"
  | "resumeSchedule"
  | "pausedAlert"
  | "saveFirstForSchedule"
  | "runsTitle"
  | "runsEmpty"
  | "runsCaption"
  | "runColOccurrence"
  | "runColOutcome"
  | "runColFinished"
  | "runColDocument"
  | "runColDelivery"
  | "runColFailure"
  | "toastSaved"
  | "toastArchived"
  | "toastScheduleSaved"
  | "toastScheduleRemoved"
  | "toastResumed"
  | "needNameAndContact"
> = {
  cs: {
    listTitle: "Šablony a pravidelná fakturace",
    listSubtitle: "Opakované šablony faktur, automatické rozvrhy a přehled běhů",
    newTemplate: "Nová šablona",
    backToList: "Zpět na šablony",
    emptyTitle: "Zatím nemáte žádné šablony",
    emptyBody: "Vytvořte šablonu pro opakovanou fakturaci stejným odběratelům.",
    attentionBanner: "{count} pravidelný rozvrh vyžaduje pozornost (pozastaveno po chybě).",
    useDraft: "Vytvořit doklad",
    openTemplate: "Upravit",
    scheduleActive: "Aktivní rozvrh",
    schedulePaused: "Pozastaveno",
    scheduleEnded: "Ukončeno",
    scheduleNone: "Bez rozvrhu",
    nextRun: "Další vystavení: {date}",
    tabTemplate: "Šablona",
    tabSchedule: "Pravidelný rozvrh",
    tabRuns: "Historie běhů",
    tabsLabel: "Sekce šablony",
    nameLabel: "Název šablony",
    kindLabel: "Druh dokladu",
    contactLabel: "Odběratel",
    contactPlaceholder: "— Vyberte kontakt —",
    currencyLabel: "Měna",
    dueDaysLabel: "Splatnost (dny)",
    paymentMethodLabel: "Způsob úhrady",
    pricesIncludeVat: "Ceny jsou včetně DPH",
    noteLabel: "Výchozí poznámka",
    linesTitle: "Položky šablony",
    addLine: "Přidat položku",
    lineDesc: "Popis",
    lineQty: "Množství",
    lineUnit: "Jedn.",
    linePrice: "Cena / ks",
    lineVat: "DPH",
    removeLine: "Odstranit",
    saveTemplate: "Uložit šablonu",
    archiveTemplate: "Archivovat",
    archiveDialogTitle: "Archivovat šablonu?",
    archiveDialogBody: "Archivovaná šablona přestane vystavovat doklady a zmizí ze seznamu.",
    archiveConfirm: "Archivovat šablonu",
    scheduleTitle: "Nastavení pravidelného rozvrhu",
    cadenceCount: "Každých",
    cadenceUnit: "Jednotka",
    startOn: "Datum začátku",
    endOn: "Datum konce (volitelné)",
    issueAs: "Vystavovat jako",
    autoSend: "Automaticky odesílat e-mailem po vystavení",
    saveSchedule: "Uložit rozvrh",
    removeSchedule: "Zrušit rozvrh",
    resumeSchedule: "Obnovit rozvrh",
    pausedAlert: "Rozvrh byl pozastaven kvůli chybě: {reason}",
    saveFirstForSchedule: "Nejprve uložte šablonu, poté lze nastavit pravidelný rozvrh.",
    runsTitle: "Historie běhů rozvrhu",
    runsEmpty: "Tento rozvrh zatím nemá žádné záznamy běhů.",
    runsCaption: "Historie běhů šablony",
    runColOccurrence: "Datum výskytu",
    runColOutcome: "Výsledek",
    runColFinished: "Dokončeno",
    runColDocument: "Doklad",
    runColDelivery: "Odeslání",
    runColFailure: "Chyba",
    toastSaved: "Šablona uložena.",
    toastArchived: "Šablona archivována.",
    toastScheduleSaved: "Rozvrh uložen.",
    toastScheduleRemoved: "Rozvrh odebrán.",
    toastResumed: "Rozvrh byl obnoven.",
    needNameAndContact: "Vyplňte název šablony, odběratele a alespoň jednu položku.",
  },
  en: {
    listTitle: "Templates & Recurring",
    listSubtitle: "Reusable invoice templates, recurring schedules, and run history",
    newTemplate: "New template",
    backToList: "Back to templates",
    emptyTitle: "No templates yet",
    emptyBody: "Create a template to speed up repeat invoicing for regular customers.",
    attentionBanner: "{count} recurring schedule needs attention (paused after a failure).",
    useDraft: "Create document",
    openTemplate: "Edit",
    scheduleActive: "Active schedule",
    schedulePaused: "Paused",
    scheduleEnded: "Ended",
    scheduleNone: "No schedule",
    nextRun: "Next issue: {date}",
    tabTemplate: "Template",
    tabSchedule: "Recurring schedule",
    tabRuns: "Run history",
    tabsLabel: "Template sections",
    nameLabel: "Template name",
    kindLabel: "Document kind",
    contactLabel: "Customer",
    contactPlaceholder: "— Select contact —",
    currencyLabel: "Currency",
    dueDaysLabel: "Due days",
    paymentMethodLabel: "Payment method",
    pricesIncludeVat: "Prices include VAT",
    noteLabel: "Default note",
    linesTitle: "Template line items",
    addLine: "Add line",
    lineDesc: "Description",
    lineQty: "Qty",
    lineUnit: "Unit",
    linePrice: "Unit price",
    lineVat: "VAT",
    removeLine: "Remove",
    saveTemplate: "Save template",
    archiveTemplate: "Archive",
    archiveDialogTitle: "Archive template?",
    archiveDialogBody: "An archived template stops issuing documents and is hidden from the list.",
    archiveConfirm: "Archive template",
    scheduleTitle: "Recurring schedule settings",
    cadenceCount: "Every",
    cadenceUnit: "Unit",
    startOn: "Start date",
    endOn: "End date (optional)",
    issueAs: "Issue as",
    autoSend: "Automatically email after issuing",
    saveSchedule: "Save schedule",
    removeSchedule: "Remove schedule",
    resumeSchedule: "Resume schedule",
    pausedAlert: "Schedule paused due to error: {reason}",
    saveFirstForSchedule: "Save the template first before configuring a recurring schedule.",
    runsTitle: "Schedule run history",
    runsEmpty: "No scheduled runs yet.",
    runsCaption: "Template run history",
    runColOccurrence: "Occurrence",
    runColOutcome: "Outcome",
    runColFinished: "Finished",
    runColDocument: "Document",
    runColDelivery: "Delivery",
    runColFailure: "Error",
    toastSaved: "Template saved.",
    toastArchived: "Template archived.",
    toastScheduleSaved: "Schedule saved.",
    toastScheduleRemoved: "Schedule removed.",
    toastResumed: "Schedule resumed.",
    needNameAndContact: "Enter a template name, customer, and at least one line item.",
  },
};

const txt = copy(CopyTable);

const TemplateLineForm = Schema.Struct({
  key: Schema.String,
  description: Schema.String,
  quantity: Schema.String,
  unit: Schema.String,
  unitPrice: Schema.String,
  vat: Schema.Literals([
    "standard",
    "reduced",
    "exempt_intra_eu_goods",
    "reverse_charge",
    "outside_scope",
  ]),
});
type TemplateLineForm = typeof TemplateLineForm.Type;

const TemplatesData = Schema.Struct({
  templates: Schema.Array(TemplateViewData),
  contacts: Schema.Array(ContactOptionData),
  activeTemplate: Schema.NullOr(TemplateViewData),
  runs: Schema.Array(RecurringRunView),
});

export const Model = Schema.Struct({
  route: Route,
  data: Remote.remoteSchema(TemplatesData),
  // Template form
  name: Schema.String,
  kind: Schema.Literals(["invoice", "proforma"]),
  contactId: Schema.String,
  currency: Schema.String,
  dueDays: Schema.String,
  paymentMethod: Schema.Literals(["bank_transfer", "cash", "card", "other"]),
  pricesIncludeVat: Schema.Boolean,
  note: Schema.String,
  lines: Schema.Array(TemplateLineForm),
  nextLineKey: Schema.Int,
  // Schedule form
  cadenceCount: Schema.String,
  cadenceUnit: Schema.Literals(["weeks", "months", "years"]),
  startOn: Schema.String,
  endOn: Schema.String,
  issueAs: Schema.Literals(["invoice", "proforma"]),
  autoSend: Schema.Boolean,
  // UI state
  archiveDialogOpen: Schema.Boolean,
  busy: Schema.Boolean,
  pendingUse: Schema.NullOr(
    Schema.Struct({ templateId: TemplateId, key: Schema.NullOr(Schema.String) }),
  ),
  formError: Schema.NullOr(Schema.String),
});
export type Model = typeof Model.Type;

export const Message = UiSchema.TaggedEnum({
  Loaded: { seq: Remote.Seq, data: TemplatesData },
  Failed: { seq: Remote.Seq, failure: Failure },
  ClickedRetry: {},
  ChangedName: { value: Schema.String },
  ChangedKind: { value: Schema.String },
  ChangedContact: { value: Schema.String },
  ChangedCurrency: { value: Schema.String },
  ChangedDueDays: { value: Schema.String },
  ChangedPaymentMethod: { value: Schema.String },
  ToggledPricesIncludeVat: { checked: Schema.Boolean },
  ChangedNote: { value: Schema.String },
  AddedLine: {},
  UpdatedLine: {
    key: Schema.String,
    field: Schema.Literals(["description", "quantity", "unit", "unitPrice", "vat"]),
    value: Schema.String,
  },
  RemovedLine: { key: Schema.String },
  SubmittedTemplate: {},
  OpenedArchiveDialog: {},
  ClosedArchiveDialog: {},
  ConfirmedArchive: {},
  ChangedCadenceCount: { value: Schema.String },
  ChangedCadenceUnit: { value: Schema.String },
  ChangedStartOn: { value: Schema.String },
  ChangedEndOn: { value: Schema.String },
  ChangedIssueAs: { value: Schema.String },
  ToggledAutoSend: { checked: Schema.Boolean },
  SubmittedSchedule: {},
  ClickedRemoveSchedule: {},
  ClickedResumeSchedule: { templateId: Schema.String },
  ClickedUseTemplate: { templateId: TemplateId },
  GotTemplateUseKey: { key: Schema.String },
  UsedTemplate: { id: DocumentId },
  FailedTemplateUse: { failure: Failure },
  MutationSucceeded: {
    toast: Schema.String,
    navigateTo: Schema.optionalKey(Schema.String),
    reload: Schema.Boolean,
  },
  MutationFailed: { failure: Failure },
});
export type Message = typeof Message.Type;

const emptyLine = (n: number): TemplateLineForm => ({
  key: `tl${n}`,
  description: "",
  quantity: "1",
  unit: "ks",
  unitPrice: "0",
  vat: "standard",
});

const loadCommand = (
  workspaceId: WorkspaceId,
  route: Route,
  seq: Remote.Seq,
): PageCommand<Message> =>
  apiCommand(
    Message,
    "LoadTemplates",
    (c) =>
      Effect.all(
        {
          templates: c.templates.list({ params: { workspaceId } }),
          contacts: c.contacts.search({ params: { workspaceId }, query: { limit: 100 } }),
          activeTemplate:
            route._tag === "Template" && route.id !== "new"
              ? c.templates.get({ params: { workspaceId, templateId: route.id } })
              : Effect.succeed(null),
          runs:
            route._tag === "Template" && route.id !== "new"
              ? c.templates
                  .runs({ params: { workspaceId, templateId: route.id }, query: { limit: 30 } })
                  .pipe(
                    Effect.map((p) => p.items),
                    Effect.orElseSucceed(() => []),
                  )
              : Effect.succeed([]),
        },
        { concurrency: 1 },
      ),
    (res): Message =>
      Message.Loaded({
        seq,
        data: {
          templates: readTemplates(res.templates),
          contacts: readContacts(res.contacts.items),
          activeTemplate:
            res.activeTemplate === null ? null : (readTemplate(res.activeTemplate) ?? null),
          runs: res.runs,
        },
      }),
    (failure): Message => Message.Failed({ seq, failure }),
  );

const scheduleCadence = (
  every: ScheduleViewData["every"],
): { readonly count: string; readonly unit: "weeks" | "months" | "years" } => {
  if ("weeks" in every) return { count: String(every.weeks), unit: "weeks" };
  if ("years" in every) return { count: String(every.years), unit: "years" };
  return { count: String(every.months), unit: "months" };
};

const hydrateTemplateForm = (model: Model, tpl: TemplateViewData): Model => {
  const lines: Array<TemplateLineForm> = Arr.map(tpl.input.lines, (l, idx) => ({
    key: `tl-${idx + 1}`,
    description: l.description ?? "",
    quantity: l.quantity !== undefined ? decimalToInput(l.quantity) : "1",
    unit: l.unit ?? "ks",
    unitPrice: l.unitPrice !== undefined ? decimalToInput(l.unitPrice) : "0",
    vat: l.vat ?? "standard",
  }));
  const cad = tpl.schedule !== null ? scheduleCadence(tpl.schedule.every) : null;
  return {
    ...model,
    name: tpl.name,
    kind: tpl.input.kind,
    contactId: tpl.input.contact,
    currency: tpl.input.currency ?? "CZK",
    dueDays: tpl.input.due !== undefined ? String(tpl.input.due.inDays) : "14",
    paymentMethod: tpl.input.paymentMethod ?? "bank_transfer",
    pricesIncludeVat: tpl.input.pricesIncludeVat ?? false,
    note: tpl.input.note ?? "",
    lines: lines.length > 0 ? lines : [emptyLine(1)],
    nextLineKey: lines.length + 1,
    cadenceCount: cad?.count ?? "1",
    cadenceUnit: cad?.unit ?? "months",
    startOn: tpl.schedule?.startOn ?? model.startOn,
    endOn: tpl.schedule?.endOn ?? "",
    issueAs: tpl.schedule?.issueAs ?? tpl.input.kind,
    autoSend: tpl.schedule?.autoSend ?? false,
  };
};

const initImpl = (route: Route, ctx: PageContext): PageReturn<Model, Message> => {
  const today = todayPrague();
  const base: Model = {
    route,
    data: Remote.idle,
    name: "",
    kind: "invoice",
    contactId: "",
    currency: "CZK",
    dueDays: "14",
    paymentMethod: "bank_transfer",
    pricesIncludeVat: false,
    note: "",
    lines: [emptyLine(1)],
    nextLineKey: 2,
    cadenceCount: "1",
    cadenceUnit: "months",
    startOn: today,
    endOn: "",
    issueAs: "invoice",
    autoSend: false,
    archiveDialogOpen: false,
    busy: false,
    pendingUse: null,
    formError: null,
  };
  if (ctx.workspace === null) return { model: base };
  const data = Remote.load(Remote.idle);
  return {
    model: { ...base, data },
    commands: [loadCommand(ctx.workspace.id, route, Remote.seqOf(data))],
  };
};

export const init: {
  (ctx: PageContext): (route: Route) => PageReturn<Model, Message>;
  (route: Route, ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(2, initImpl);

const buildTemplateInput = (model: Model): TemplateInput | null => {
  if (Str.trim(model.name) === "" || model.contactId === "") return null;
  const lines: Array<LineInput> = [];
  for (const l of model.lines) {
    if (Str.trim(l.description) === "") continue;
    const qty = parseDecimalText(l.quantity);
    const price = parseDecimalText(l.unitPrice);
    if (qty === undefined || price === undefined) continue;
    const entry: Types.Mutable<LineInput> = {
      description: Str.trim(l.description),
      quantity: qty,
      unitPrice: price,
      vat: l.vat,
    };
    const unit = Str.trim(l.unit);
    if (unit !== "") entry.unit = unit;
    lines.push(entry);
  }
  if (!Arr.isArrayNonEmpty(lines)) return null;
  const dueInt = Number.parseInt(model.dueDays, 10);
  const input: Types.Mutable<TemplateInput> = {
    name: Str.trim(model.name),
    kind: model.kind,
    contact: ContactId.make(model.contactId),
    lines,
    currency: CurrencyCode.make(model.currency),
    paymentMethod: PaymentMethod.make(model.paymentMethod),
    pricesIncludeVat: model.pricesIncludeVat,
  };
  if (Number.isInteger(dueInt) && dueInt >= 0) input.due = { inDays: dueInt };
  const note = Str.trim(model.note);
  if (note !== "") input.note = note;
  return input;
};

const useTemplate = (
  model: Model,
  workspaceId: WorkspaceId,
  templateId: TemplateId,
  key: string,
): PageReturn<Model, Message> => ({
  model: { ...model, busy: true, formError: null, pendingUse: { templateId, key } },
  commands: [
    apiCommand(
      Message,
      "UseTemplate",
      (c) =>
        c.templates.use({
          params: { workspaceId, templateId },
          headers: idempotencyHeaders(key),
          payload: { as: "draft" },
        }),
      (doc): Message => Message.UsedTemplate({ id: doc.id }),
      (failure): Message => Message.FailedTemplateUse({ failure }),
    ),
  ],
});

const updateImpl = (
  model: Model,
  message: Message,
  ctx: PageContext,
): PageReturn<Model, Message> => {
  const ws = ctx.workspace;
  const route = model.route;
  const loaded = Remote.dataOf(model.data);

  return Message.match(message, {
    Loaded: ({ seq, data }) => {
      const nextData = Remote.succeed(model.data, seq, data);
      let next: Model = { ...model, data: nextData };
      if (data.activeTemplate !== null) {
        next = hydrateTemplateForm(next, data.activeTemplate);
      }
      return { model: next };
    },
    Failed: ({ seq, failure }) => ({
      model: { ...model, data: Remote.fail(model.data, seq, failure) },
    }),
    ClickedRetry: () => {
      if (ws === null) return { model };
      const data = Remote.load(model.data);
      return {
        model: { ...model, data },
        commands: [loadCommand(ws.id, route, Remote.seqOf(data))],
      };
    },
    ChangedName: ({ value }) => ({ model: { ...model, name: value, formError: null } }),
    ChangedKind: ({ value }) => ({
      model: { ...model, kind: value === "proforma" ? "proforma" : "invoice" },
    }),
    ChangedContact: ({ value }) => ({ model: { ...model, contactId: value, formError: null } }),
    ChangedCurrency: ({ value }) => ({ model: { ...model, currency: value } }),
    ChangedDueDays: ({ value }) => ({ model: { ...model, dueDays: value } }),
    ChangedPaymentMethod: ({ value }) => ({
      model: {
        ...model,
        paymentMethod:
          value === "cash" || value === "card" || value === "other" ? value : "bank_transfer",
      },
    }),
    ToggledPricesIncludeVat: ({ checked }) => ({ model: { ...model, pricesIncludeVat: checked } }),
    ChangedNote: ({ value }) => ({ model: { ...model, note: value } }),
    AddedLine: () => ({
      model: {
        ...model,
        lines: [...model.lines, emptyLine(model.nextLineKey)],
        nextLineKey: model.nextLineKey + 1,
      },
    }),
    UpdatedLine: ({ key, field, value }) => ({
      model: {
        ...model,
        lines: Arr.map(model.lines, (l) => (l.key === key ? { ...l, [field]: value } : l)),
      },
    }),
    RemovedLine: ({ key }) => ({
      model: {
        ...model,
        lines:
          model.lines.length <= 1
            ? [emptyLine(model.nextLineKey)]
            : Arr.filter(model.lines, (l) => l.key !== key),
        nextLineKey: model.lines.length <= 1 ? model.nextLineKey + 1 : model.nextLineKey,
      },
    }),
    SubmittedTemplate: () => {
      if (ws === null || model.busy) return { model };
      const payload = buildTemplateInput(model);
      if (payload === null) {
        return { model: { ...model, formError: txt(ctx.locale, "needNameAndContact") } };
      }
      const existing = loaded?.activeTemplate ?? null;
      return {
        model: { ...model, busy: true, formError: null },
        commands: [
          apiCommand(
            Message,
            "SaveTemplate",
            (c) =>
              existing !== null
                ? c.templates.update({
                    params: { workspaceId: ws.id, templateId: existing.id },
                    headers: ifMatch(existing.revision),
                    payload,
                  })
                : withIdempotencyKey((headers) =>
                    c.templates.create({
                      params: { workspaceId: ws.id },
                      headers,
                      payload,
                    }),
                  ),
            (savedRaw): Message => {
              const saved = readTemplate(savedRaw);
              const nav =
                existing === null && saved !== undefined
                  ? href({ _tag: "Template", ws: route.ws, id: saved.id, tab: "template" })
                  : undefined;
              const result = { toast: txt(ctx.locale, "toastSaved"), reload: existing !== null };
              return Message.MutationSucceeded(
                nav === undefined ? result : { ...result, navigateTo: nav },
              );
            },
            (failure): Message => Message.MutationFailed({ failure }),
          ),
        ],
      };
    },
    OpenedArchiveDialog: () => ({ model: { ...model, archiveDialogOpen: true } }),
    ClosedArchiveDialog: () => ({ model: { ...model, archiveDialogOpen: false } }),
    ConfirmedArchive: () => {
      const existing = loaded?.activeTemplate ?? null;
      if (ws === null || existing === null || model.busy) return { model };
      return {
        model: { ...model, busy: true, archiveDialogOpen: false },
        commands: [
          apiCommand(
            Message,
            "ArchiveTemplate",
            (c) => c.templates.archive({ params: { workspaceId: ws.id, templateId: existing.id } }),
            (): Message =>
              Message.MutationSucceeded({
                toast: txt(ctx.locale, "toastArchived"),
                navigateTo: href({ _tag: "Templates", ws: route.ws }),
                reload: false,
              }),
            (failure): Message => Message.MutationFailed({ failure }),
          ),
        ],
      };
    },
    ChangedCadenceCount: ({ value }) => ({ model: { ...model, cadenceCount: value } }),
    ChangedCadenceUnit: ({ value }) => ({
      model: {
        ...model,
        cadenceUnit: value === "weeks" || value === "years" ? value : "months",
      },
    }),
    ChangedStartOn: ({ value }) => ({ model: { ...model, startOn: value } }),
    ChangedEndOn: ({ value }) => ({ model: { ...model, endOn: value } }),
    ChangedIssueAs: ({ value }) => ({
      model: { ...model, issueAs: value === "proforma" ? "proforma" : "invoice" },
    }),
    ToggledAutoSend: ({ checked }) => ({ model: { ...model, autoSend: checked } }),
    SubmittedSchedule: () => {
      const existing = loaded?.activeTemplate ?? null;
      if (ws === null || existing === null || model.busy) return { model };
      const count = Math.max(1, Number.parseInt(model.cadenceCount, 10) || 1);
      const every =
        model.cadenceUnit === "weeks"
          ? ({ weeks: count } as const)
          : model.cadenceUnit === "years"
            ? ({ years: count } as const)
            : ({ months: count } as const);
      const startOn = isIsoDateString(model.startOn) ? model.startOn : todayPrague();
      const endOn = isIsoDateString(model.endOn) ? model.endOn : undefined;
      return {
        model: { ...model, busy: true, formError: null },
        commands: [
          apiCommand(
            Message,
            "SaveSchedule",
            (client) => {
              const schedule = { every, startOn, issueAs: model.issueAs, autoSend: model.autoSend };
              return client.templates.setSchedule({
                params: { workspaceId: ws.id, templateId: existing.id },
                headers: ifMatch(existing.revision),
                payload: endOn === undefined ? schedule : { ...schedule, endOn },
              });
            },
            (): Message =>
              Message.MutationSucceeded({
                toast: txt(ctx.locale, "toastScheduleSaved"),
                reload: true,
              }),
            (failure): Message => Message.MutationFailed({ failure }),
          ),
        ],
      };
    },
    ClickedRemoveSchedule: () => {
      const existing = loaded?.activeTemplate ?? null;
      if (ws === null || existing === null || model.busy) return { model };
      return {
        model: { ...model, busy: true, formError: null },
        commands: [
          apiCommand(
            Message,
            "RemoveSchedule",
            (c) =>
              c.templates.removeSchedule({
                params: { workspaceId: ws.id, templateId: existing.id },
                headers: ifMatch(existing.revision),
              }),
            (): Message =>
              Message.MutationSucceeded({
                toast: txt(ctx.locale, "toastScheduleRemoved"),
                reload: true,
              }),
            (failure): Message => Message.MutationFailed({ failure }),
          ),
        ],
      };
    },
    ClickedResumeSchedule: ({ templateId }) => {
      if (ws === null || model.busy) return { model };
      return {
        model: { ...model, busy: true, formError: null },
        commands: [
          apiCommand(
            Message,
            "ResumeSchedule",
            (c) =>
              c.templates.resume({
                params: { workspaceId: ws.id, templateId: TemplateId.make(templateId) },
              }),
            (): Message =>
              Message.MutationSucceeded({
                toast: txt(ctx.locale, "toastResumed"),
                reload: true,
              }),
            (failure): Message => Message.MutationFailed({ failure }),
          ),
        ],
      };
    },
    ClickedUseTemplate: ({ templateId }) => {
      if (ws === null || model.busy || !canRole(ws.role, "document.draft")) return { model };
      if (model.pendingUse !== null && model.pendingUse.templateId !== templateId) return { model };
      const key = model.pendingUse?.key ?? null;
      return key === null
        ? {
            model: { ...model, busy: true, formError: null, pendingUse: { templateId, key } },
            commands: [
              // biome-ignore lint/security/noSecrets: This is a statically declared UI command or message name.
              mintRequestKeyCommand("MintTemplateUseKey", (requestKey) =>
                Message.GotTemplateUseKey({ key: requestKey }),
              ),
            ],
          }
        : useTemplate(model, ws.id, templateId, key);
    },
    GotTemplateUseKey: ({ key }) => {
      if (!model.busy || model.pendingUse === null || model.pendingUse.key !== null)
        return { model };
      if (ws === null || !canRole(ws.role, "document.draft")) {
        return { model: { ...model, busy: false, pendingUse: null } };
      }
      return useTemplate(model, ws.id, model.pendingUse.templateId, key);
    },
    UsedTemplate: ({ id }) => ({
      model: { ...model, busy: false, pendingUse: null, formError: null },
      outMessage: Intent_.navigate(href({ _tag: "DocumentEdit", ws: route.ws, id })),
    }),
    FailedTemplateUse: ({ failure }) => ({
      model: {
        ...model,
        busy: false,
        pendingUse: preserveRequestKey(failure) ? model.pendingUse : null,
        formError: textOf(translator(ctx.locale), failure.text),
      },
    }),
    MutationSucceeded: ({ toast, navigateTo, reload }) => {
      const nextBase: Model = { ...model, busy: false, formError: null };
      if (navigateTo !== undefined) {
        return { model: nextBase, outMessage: Intent_.navigate(navigateTo) };
      }
      if (reload && ws !== null) {
        const nextData = Remote.load(model.data);
        return {
          model: { ...nextBase, data: nextData },
          commands: [loadCommand(ws.id, route, Remote.seqOf(nextData))],
          outMessage: Intent_.toast(toast),
        };
      }
      return { model: nextBase, outMessage: Intent_.toast(toast) };
    },
    MutationFailed: ({ failure }) => ({
      model: {
        ...model,
        busy: false,
        formError: textOf(translator(ctx.locale), failure.text),
      },
    }),
  } satisfies MessageHandlers<Message, PageReturn<Model, Message>>);
};

export const update: {
  (message: Message, ctx: PageContext): (model: Model) => PageReturn<Model, Message>;
  (model: Model, message: Message, ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(3, updateImpl);

const titleImpl = (model: Model, ctx: PageContext): string => {
  const route = model.route;
  if (route._tag === "Template") {
    return model.name || txt(ctx.locale, "newTemplate");
  }
  return txt(ctx.locale, "listTitle");
};

export const title: {
  (ctx: PageContext): (model: Model) => string;
  (model: Model, ctx: PageContext): string;
} = Fn.dual(2, titleImpl);

const viewImpl = (model: Model, ctx: PageContext, h: Html.H<Message>) => {
  const { locale } = ctx;
  const t = translator(locale);
  const ws = ctx.workspace;
  const route = model.route;
  if (ws === null) {
    return page(h, [banner(h, { text: sharedCopy(locale, "noWorkspace"), tone: "error" })]);
  }
  const slug = ws.slug;
  const loaded = Remote.dataOf(model.data);

  if (model.data._tag === "Failed") {
    return page(h, [
      pageHeader(h, { title: txt(locale, "listTitle") }),
      banner(h, {
        text: textOf(t, model.data.failure.text),
        tone: "error",
        action: button(h, {
          label: sharedCopy(locale, "retry"),
          onClick: Message.ClickedRetry(),
          small: true,
        }),
      }),
    ]);
  }

  // --- List view (/w/:ws/templates) ---
  if (route._tag === "Templates") {
    const templates = loaded?.templates ?? [];
    const pausedTemplates = Arr.filter(templates, (tpl) => tpl.schedule?.paused === true);

    return page(h, [
      pageHeader(h, {
        title: txt(locale, "listTitle"),
        subtitle: txt(locale, "listSubtitle"),
        actions: [
          linkButton(h, {
            label: txt(locale, "newTemplate"),
            href: href({ _tag: "Template", ws: slug, id: "new", tab: "template" }),
            variant: "primary",
          }),
        ],
      }),
      ...(model.formError === null
        ? []
        : [
            banner(h, {
              text: model.formError,
              tone: "error",
              action:
                model.pendingUse !== null && canRole(ws.role, "document.draft")
                  ? button(h, {
                      label: sharedCopy(locale, "retry"),
                      onClick: Message.ClickedUseTemplate({
                        templateId: model.pendingUse.templateId,
                      }),
                      small: true,
                    })
                  : undefined,
            }),
          ]),
      ...(pausedTemplates.length > 0
        ? [
            banner(h, {
              text: txt(locale, "attentionBanner", { count: pausedTemplates.length }),
              tone: "error",
            }),
          ]
        : []),
      loaded === undefined
        ? h.div
            .class("kb-templates-grid")
            .attr("aria-busy", String(true))
            .children([
              card(h, [skeleton(h, "60%", "1.2rem"), skeleton(h, "90%", "1rem")]),
              card(h, [skeleton(h, "60%", "1.2rem"), skeleton(h, "90%", "1rem")]),
            ])
        : templates.length === 0
          ? emptyState(h, {
              title: txt(locale, "emptyTitle"),
              body: txt(locale, "emptyBody"),
              action: linkButton(h, {
                label: txt(locale, "newTemplate"),
                href: href({ _tag: "Template", ws: slug, id: "new", tab: "template" }),
                variant: "primary",
              }),
            })
          : h.div.class("kb-templates-grid").children(
              Arr.map(templates, (tpl) => {
                const contactName =
                  Arr.findFirst(loaded.contacts, (c) => c.id === tpl.input.contact).pipe(
                    Option.getOrUndefined,
                  )?.name ?? "—";
                const sched = tpl.schedule;
                const schedBadge =
                  sched === null
                    ? badge(h, txt(locale, "scheduleNone"), "outline")
                    : sched.paused
                      ? badge(h, txt(locale, "schedulePaused"), "error")
                      : sched.nextOccurrence === null
                        ? badge(h, txt(locale, "scheduleEnded"), "neutral")
                        : badge(h, txt(locale, "scheduleActive"), "paid");

                return card(h, [
                  h.div.class("kb-template-card").children([
                    h.div
                      .class("kb-spread")
                      .children([
                        h.strong.children([tpl.name]),
                        h.div
                          .class("kb-row")
                          .children([kindBadge(h, locale, tpl.input.kind), schedBadge]),
                      ]),
                    h.span.class("kb-small kb-muted").children([contactName]),
                    ...(sched !== null && sched.nextOccurrence !== null
                      ? [
                          h.span.class("kb-small kb-num").children([
                            txt(locale, "nextRun", {
                              date: fmtDate(locale, sched.nextOccurrence),
                            }),
                          ]),
                        ]
                      : []),
                    ...(sched?.paused === true
                      ? [
                          banner(h, {
                            text: txt(locale, "pausedAlert", {
                              reason: sched.pausedReason ?? sched.pausedError ?? "error",
                            }),
                            tone: "error",
                            action: button(h, {
                              label: txt(locale, "resumeSchedule"),
                              onClick: Message.ClickedResumeSchedule({ templateId: tpl.id }),
                              small: true,
                              busy: model.busy,
                            }),
                          }),
                        ]
                      : []),
                    h.div.class("kb-row").children([
                      button(h, {
                        label: txt(locale, "useDraft"),
                        onClick: Message.ClickedUseTemplate({ templateId: tpl.id }),
                        disabled:
                          !canRole(ws.role, "document.draft") ||
                          (model.pendingUse !== null && model.pendingUse.templateId !== tpl.id),
                        variant: "primary",
                        small: true,
                        busy: model.busy,
                      }),
                      linkButton(h, {
                        label: txt(locale, "openTemplate"),
                        href: href({ _tag: "Template", ws: slug, id: tpl.id, tab: "template" }),
                        small: true,
                      }),
                    ]),
                  ]),
                ]);
              }),
            ),
    ]);
  }

  // --- Detail/Editor view (/w/:ws/templates/:id) ---
  const isNew = route.id === "new";
  const existing = loaded?.activeTemplate ?? null;
  const runs = loaded?.runs ?? [];

  const vatOptions: ReadonlyArray<{ readonly value: VatTreatment; readonly label: string }> = [
    { value: "standard", label: textOf(t, I18n.enumText("vatTreatment", "standard")) },
    { value: "reduced", label: textOf(t, I18n.enumText("vatTreatment", "reduced")) },
    { value: "reverse_charge", label: textOf(t, I18n.enumText("vatTreatment", "reverse_charge")) },
    {
      value: "exempt_intra_eu_goods",
      label: textOf(t, I18n.enumText("vatTreatment", "exempt_intra_eu_goods")),
    },
    { value: "outside_scope", label: textOf(t, I18n.enumText("vatTreatment", "outside_scope")) },
  ];

  const tabBar = isNew
    ? []
    : [
        tabs(h, {
          label: txt(locale, "tabsLabel"),
          selected: route.tab,
          items: [
            {
              id: "template",
              label: txt(locale, "tabTemplate"),
              href: href({ _tag: "Template", ws: slug, id: route.id, tab: "template" }),
            },
            {
              id: "schedule",
              label: txt(locale, "tabSchedule"),
              href: href({ _tag: "Template", ws: slug, id: route.id, tab: "schedule" }),
            },
            {
              id: "runs",
              label: `${txt(locale, "tabRuns")} (${runs.length})`,
              href: href({ _tag: "Template", ws: slug, id: route.id, tab: "runs" }),
            },
          ],
        }),
      ];

  const templateTab = card(h, [
    h.div.class("kb-stack").children([
      h.div.class("kb-editor-form-grid").children([
        textField(h, {
          id: "tpl-name",
          label: txt(locale, "nameLabel"),
          value: model.name,
          onInput: (value) => Message.ChangedName({ value }),
          required: true,
        }),
        selectField(h, {
          id: "tpl-kind",
          label: txt(locale, "kindLabel"),
          value: model.kind,
          onChange: (value) => Message.ChangedKind({ value }),
          options: [
            { value: "invoice", label: textOf(t, I18n.enumText("documentKind", "invoice")) },
            { value: "proforma", label: textOf(t, I18n.enumText("documentKind", "proforma")) },
          ],
        }),
        selectField(h, {
          id: "tpl-contact",
          label: txt(locale, "contactLabel"),
          value: model.contactId,
          onChange: (value) => Message.ChangedContact({ value }),
          options: [
            { value: "", label: txt(locale, "contactPlaceholder") },
            ...Arr.map(loaded?.contacts ?? [], (c) => ({ value: c.id, label: c.name })),
          ],
        }),
        selectField(h, {
          id: "tpl-currency",
          label: txt(locale, "currencyLabel"),
          value: model.currency,
          onChange: (value) => Message.ChangedCurrency({ value }),
          options: [
            { value: "CZK", label: "CZK" },
            { value: "EUR", label: "EUR" },
            { value: "USD", label: "USD" },
          ],
        }),
        textField(h, {
          id: "tpl-due-days",
          label: txt(locale, "dueDaysLabel"),
          type: "number",
          value: model.dueDays,
          onInput: (value) => Message.ChangedDueDays({ value }),
          mono: true,
        }),
        selectField(h, {
          id: "tpl-pm",
          label: txt(locale, "paymentMethodLabel"),
          value: model.paymentMethod,
          onChange: (value) => Message.ChangedPaymentMethod({ value }),
          options: [
            {
              value: "bank_transfer",
              label: textOf(t, I18n.enumText("paymentMethod", "bank_transfer")),
            },
            { value: "cash", label: textOf(t, I18n.enumText("paymentMethod", "cash")) },
            { value: "card", label: textOf(t, I18n.enumText("paymentMethod", "card")) },
            { value: "other", label: textOf(t, I18n.enumText("paymentMethod", "other")) },
          ],
        }),
      ]),
      checkbox(h, {
        id: "tpl-incl-vat",
        label: txt(locale, "pricesIncludeVat"),
        checked: model.pricesIncludeVat,
        onToggle: (checked) => Message.ToggledPricesIncludeVat({ checked }),
      }),
      h.hr.class("kb-divider"),
      cardTitle(h, txt(locale, "linesTitle"), [
        button(h, { label: txt(locale, "addLine"), onClick: Message.AddedLine(), small: true }),
      ]),
      ...Arr.map(model.lines, (line) =>
        h.div
          .key(line.key)
          .class("kb-line-row")
          .children([
            textField(h, {
              id: `tl-desc-${line.key}`,
              label: txt(locale, "lineDesc"),
              value: line.description,
              onInput: (value) =>
                Message.UpdatedLine({ key: line.key, field: "description", value }),
            }),
            textField(h, {
              id: `tl-qty-${line.key}`,
              label: txt(locale, "lineQty"),
              value: line.quantity,
              onInput: (value) => Message.UpdatedLine({ key: line.key, field: "quantity", value }),
              mono: true,
            }),
            textField(h, {
              id: `tl-unit-${line.key}`,
              label: txt(locale, "lineUnit"),
              value: line.unit,
              onInput: (value) => Message.UpdatedLine({ key: line.key, field: "unit", value }),
            }),
            textField(h, {
              id: `tl-price-${line.key}`,
              label: txt(locale, "linePrice"),
              value: line.unitPrice,
              onInput: (value) => Message.UpdatedLine({ key: line.key, field: "unitPrice", value }),
              mono: true,
            }),
            selectField(h, {
              id: `tl-vat-${line.key}`,
              label: txt(locale, "lineVat"),
              value: line.vat,
              onChange: (value) => Message.UpdatedLine({ key: line.key, field: "vat", value }),
              options: vatOptions,
            }),
            h.div.class("kb-line-actions").children([
              button(h, {
                label: "×",
                ariaLabel: txt(locale, "removeLine"),
                onClick: Message.RemovedLine({ key: line.key }),
                variant: "ghost",
                small: true,
              }),
            ]),
          ]),
      ),
      textArea(h, {
        id: "tpl-note",
        label: txt(locale, "noteLabel"),
        value: model.note,
        onInput: (value) => Message.ChangedNote({ value }),
      }),
      h.div.class("kb-spread").children([
        isNew
          ? h.span.children([])
          : button(h, {
              label: txt(locale, "archiveTemplate"),
              onClick: Message.OpenedArchiveDialog(),
              variant: "danger",
            }),
        button(h, {
          label: txt(locale, "saveTemplate"),
          onClick: Message.SubmittedTemplate(),
          variant: "primary",
          busy: model.busy,
        }),
      ]),
    ]),
  ]);

  const scheduleTab =
    existing === null
      ? banner(h, { text: txt(locale, "saveFirstForSchedule"), tone: "info" })
      : card(h, [
          cardTitle(h, txt(locale, "scheduleTitle")),
          ...(existing.schedule?.paused === true
            ? [
                banner(h, {
                  text: txt(locale, "pausedAlert", {
                    reason:
                      existing.schedule.pausedReason ?? existing.schedule.pausedError ?? "error",
                  }),
                  tone: "error",
                  action: button(h, {
                    label: txt(locale, "resumeSchedule"),
                    onClick: Message.ClickedResumeSchedule({ templateId: existing.id }),
                    variant: "primary",
                    small: true,
                    busy: model.busy,
                  }),
                }),
              ]
            : []),
          h.div.class("kb-stack").children([
            h.div.class("kb-schedule-cadence").children([
              textField(h, {
                id: "sched-count",
                label: txt(locale, "cadenceCount"),
                type: "number",
                value: model.cadenceCount,
                onInput: (value) => Message.ChangedCadenceCount({ value }),
                mono: true,
              }),
              selectField(h, {
                id: "sched-unit",
                label: txt(locale, "cadenceUnit"),
                value: model.cadenceUnit,
                onChange: (value) => Message.ChangedCadenceUnit({ value }),
                options: [
                  { value: "weeks", label: textOf(t, I18n.enumText("cadenceUnit", "weeks")) },
                  { value: "months", label: textOf(t, I18n.enumText("cadenceUnit", "months")) },
                  { value: "years", label: textOf(t, I18n.enumText("cadenceUnit", "years")) },
                ],
              }),
            ]),
            h.div.class("kb-editor-form-grid").children([
              textField(h, {
                id: "sched-start",
                label: txt(locale, "startOn"),
                type: "date",
                value: model.startOn,
                onInput: (value) => Message.ChangedStartOn({ value }),
              }),
              textField(h, {
                id: "sched-end",
                label: txt(locale, "endOn"),
                type: "date",
                value: model.endOn,
                onInput: (value) => Message.ChangedEndOn({ value }),
              }),
              selectField(h, {
                id: "sched-issue-as",
                label: txt(locale, "issueAs"),
                value: model.issueAs,
                onChange: (value) => Message.ChangedIssueAs({ value }),
                options: [
                  { value: "invoice", label: textOf(t, I18n.enumText("issueAs", "invoice")) },
                  { value: "proforma", label: textOf(t, I18n.enumText("issueAs", "proforma")) },
                ],
              }),
            ]),
            checkbox(h, {
              id: "sched-autosend",
              label: txt(locale, "autoSend"),
              checked: model.autoSend,
              onToggle: (checked) => Message.ToggledAutoSend({ checked }),
            }),
            h.div.class("kb-spread").children([
              existing.schedule !== null
                ? button(h, {
                    label: txt(locale, "removeSchedule"),
                    onClick: Message.ClickedRemoveSchedule(),
                    variant: "danger",
                    busy: model.busy,
                  })
                : h.span.children([]),
              button(h, {
                label: txt(locale, "saveSchedule"),
                onClick: Message.SubmittedSchedule(),
                variant: "primary",
                busy: model.busy,
              }),
            ]),
          ]),
        ]);

  const runsTab = card(h, [
    cardTitle(h, txt(locale, "runsTitle")),
    runs.length === 0
      ? emptyState(h, { title: txt(locale, "runsEmpty") })
      : table(h, {
          caption: txt(locale, "runsCaption"),
          rows: runs,
          rowKey: (r) => `${r.occurrence}-${r.at}`,
          columns: [
            {
              header: txt(locale, "runColOccurrence"),
              numeric: true,
              cell: (r) => fmtDate(locale, r.occurrence),
            },
            {
              header: txt(locale, "runColOutcome"),
              cell: (r) =>
                badge(
                  h,
                  textOf(t, I18n.enumText("scheduleRunOutcome", r.outcome)),
                  r.outcome === "issued" ? "paid" : r.outcome === "failed" ? "error" : "outline",
                ),
            },
            {
              header: txt(locale, "runColFinished"),
              numeric: true,
              cell: (r) => fmtDateTime(locale, r.at),
            },
            {
              header: txt(locale, "runColDocument"),
              cell: (r) =>
                r.document === null
                  ? "—"
                  : h.a
                      .class("kb-queue-item__link")
                      .attr(
                        "href",
                        href({ _tag: "Document", ws: slug, id: r.document.id, tab: "preview" }),
                      )
                      .children([mono(h, r.document.number)]),
            },
            {
              header: txt(locale, "runColDelivery"),
              cell: (r) =>
                r.delivery === null
                  ? "—"
                  : badge(
                      h,
                      textOf(t, I18n.enumText("deliveryStatus", r.delivery.status)),
                      "outline",
                    ),
            },
            {
              header: txt(locale, "runColFailure"),
              cell: (r) => (r.failure === null ? "—" : mono(h, r.failure)),
            },
          ],
        }),
  ]);

  const activeTab =
    route.tab === "schedule" ? scheduleTab : route.tab === "runs" ? runsTab : templateTab;

  return page(h, [
    pageHeader(h, {
      title: isNew
        ? txt(locale, "newTemplate")
        : model.name === ""
          ? txt(locale, "listTitle")
          : model.name,
      actions: [
        linkButton(h, {
          label: txt(locale, "backToList"),
          href: href({ _tag: "Templates", ws: slug }),
          variant: "ghost",
        }),
      ],
    }),
    ...(model.formError !== null ? [banner(h, { text: model.formError, tone: "error" })] : []),
    ...tabBar,
    activeTab,
    ...(model.archiveDialogOpen
      ? [
          dialog(h, {
            id: "dlg-archive-template",
            title: txt(locale, "archiveDialogTitle"),
            onClose: Message.ClosedArchiveDialog(),
            body: [h.p.children([txt(locale, "archiveDialogBody")])],
            actions: [
              button(h, {
                label: sharedCopy(locale, "cancel"),
                onClick: Message.ClosedArchiveDialog(),
              }),
              button(h, {
                label: txt(locale, "archiveConfirm"),
                onClick: Message.ConfirmedArchive(),
                variant: "danger",
                busy: model.busy,
              }),
            ],
          }),
        ]
      : []),
  ]);
};

export const view: {
  (ctx: PageContext, h: Html.H<Message>): (model: Model) => ReturnType<typeof viewImpl>;
  (model: Model, ctx: PageContext, h: Html.H<Message>): ReturnType<typeof viewImpl>;
} = Fn.dual(3, viewImpl);
