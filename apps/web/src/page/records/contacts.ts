import { UiSchema } from "@effect/ui";
import type { Html } from "@effect/ui/html";
/**
 * Contacts screen (Screen 15, routes `Contacts` | `Contact`).
 * - List with live search, role filters (customer/supplier), archived toggle, zero-CLS shimmer
 * - Detail with billing/VAT particulars, override defaults chain (Document -> Contact -> Workspace),
 *   linked document & expense history, Refresh from ARES, New invoice shortcut, Archive
 * - Create/Edit form with IČO-first ARES lookup, duplicate IČO handling, billing emails list,
 *   and per-field billing override editor
 */
import {
  type ContactDefaults,
  ContactId,
  ContactInput,
  CurrencyCode,
  DocumentId,
  ExpenseId,
  PaymentMethod,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Format, ViewModels } from "@kvitbit/ui-port";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { Failure, request } from "../../app/api";
import type { PageCommand } from "../../app/commands";
import { copy, textOf, translator } from "../../app/i18n";
import { Intent_ } from "../../app/intent";
import {
  type MessageHandlers,
  type PageContext,
  type PageReturn,
  RouteCases,
} from "../../app/page";
import * as Remote from "../../app/remote";
import { href } from "../../app/routing";
import type { Markup } from "../../ui/html";
import { icon } from "../../ui/icons";
import {
  badge,
  banner,
  button,
  card,
  cardTitle,
  checkbox,
  dialog,
  dl,
  emptyState,
  linkButton,
  mono,
  page,
  pageHeader,
  selectField,
  skeleton,
  skeletonTable,
  table,
  textArea,
  textField,
} from "../../ui/kit";
import {
  apiCommand,
  ContactRecord,
  type ContactRoleLiteral,
  CURRENCIES,
  canWrite,
  dateText,
  decimalToString,
  ExpenseSummaryRecord,
  enumLabel,
  moneyText,
  newIdempotencyKey,
  normalizeContact,
  normalizeExpenseSummary,
  optInt,
  PAYMENT_METHODS,
  settlementTone,
  toDomainContactDefaults,
} from "./shared";

export const Route = Schema.Union([RouteCases.Contacts, RouteCases.Contact]);
export type Route = typeof Route.Type;

const tLocal = copy({
  cs: {
    subtitle:
      "Odběratelé a dodavatelé s automatickým načítáním z ARES a vlastními fakturačními pravidly.",
    colName: "Název",
    colRoles: "Role",
    colIds: "IČO / DIČ",
    colLocation: "Sídlo",
    colEmail: "Fakturační e-mail",
    allRoles: "Vše",
    customers: "Odběratelé",
    suppliers: "Dodavatelé",
    legalForm: "Právní forma",
    registrySynced: "Načteno z ARES",
    backToList: "Zpět na kontakty",
    archiveTitle: "Archivovat kontakt?",
    archiveBody:
      "Kontakt {name} se skryje z aktivního výběru. Vystavené doklady zůstanou nedotčeny.",
    noDocuments: "Pro tento kontakt zatím nejsou žádné doklady.",
    noExpenses: "Pro tento kontakt zatím nejsou žádné náklady.",
    docNumber: "Číslo",
    docDate: "Datum",
    docTotal: "Celkem",
    docStatus: "Stav",
    nameRequired: "Zadejte název kontaktu.",
    roleRequired: "Vyberte alespoň jednu roli (odběratel nebo dodavatel).",
    icoInvalid: "Zadejte platné 8místné IČO.",
    aresFound: "Údaje načteny z ARES.",
    staleNotice: "Kontakt byl mezitím upraven. Načtěte aktuální verzi.",
    overrideClear: "Výchozí prostoru",
    daysUnit: "{days} dní",
    remindersDisabled: "Vypnuto",
    remindersCustom: "Po {offsets} dnech",
    remindersInherit: "Dle prostoru (7, 14 dní)",
    reminderOffsetsPlaceholder: "např. 7, 14, 30",
    countLabel: "{count} kontaktů",
  },
  en: {
    subtitle: "Customers and suppliers with ARES registry lookup and per-contact billing defaults.",
    colName: "Name",
    colRoles: "Roles",
    colIds: "IČO / VAT ID",
    colLocation: "Location",
    colEmail: "Billing email",
    allRoles: "All",
    customers: "Customers",
    suppliers: "Suppliers",
    legalForm: "Legal form",
    registrySynced: "Synced from ARES",
    backToList: "Back to contacts",
    archiveTitle: "Archive contact?",
    archiveBody: "{name} will be hidden from active pickers. Existing documents remain intact.",
    noDocuments: "No documents for this contact yet.",
    noExpenses: "No expenses for this contact yet.",
    docNumber: "Number",
    docDate: "Date",
    docTotal: "Total",
    docStatus: "Status",
    nameRequired: "Enter a contact name.",
    roleRequired: "Select at least one role (customer or supplier).",
    icoInvalid: "Enter a valid 8-digit Czech IČO.",
    aresFound: "Particulars loaded from ARES.",
    staleNotice: "This contact changed elsewhere. Reload to get the latest version.",
    overrideClear: "Use workspace default",
    daysUnit: "{days} days",
    remindersDisabled: "Disabled",
    remindersCustom: "After {offsets} days",
    remindersInherit: "Workspace default (7, 14 days)",
    reminderOffsetsPlaceholder: "e.g. 7, 14, 30",
    countLabel: "{count} contacts",
  },
});

const RelatedDocumentRecord = Schema.Struct({
  id: Schema.String,
  number: Schema.NullOr(Schema.String),
  kind: Schema.String,
  status: Schema.String,
  settlement: Schema.String,
  issuedOn: Schema.NullOr(Schema.String),
  totalAmount: Schema.String,
  currency: Schema.String,
});
type RelatedDocumentRecord = typeof RelatedDocumentRecord.Type;

const ContactEditor = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  revision: Schema.NullOr(Schema.Int),
  icoLookup: Schema.String,
  aresBusy: Schema.Boolean,
  aresSeq: Schema.Int,
  aresError: Schema.NullOr(Schema.String),
  isCustomer: Schema.Boolean,
  isSupplier: Schema.Boolean,
  name: Schema.String,
  ico: Schema.String,
  dic: Schema.String,
  legalForm: Schema.String,
  street: Schema.String,
  city: Schema.String,
  postalCode: Schema.String,
  country: Schema.String,
  billingEmails: Schema.Array(Schema.String),
  phone: Schema.String,
  note: Schema.String,
  // Billing overrides (empty string = inherit from Workspace)
  currencyOverride: Schema.String,
  languageOverride: Schema.String,
  dueDaysOverride: Schema.String,
  paymentMethodOverride: Schema.String,
  defaultNoteOverride: Schema.String,
  reminderMode: Schema.Literals(["inherit", "disabled", "custom"]),
  reminderOffsets: Schema.String,
  idempotencyKey: Schema.String,
  saving: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
type ContactEditor = typeof ContactEditor.Type;

export const Model = Schema.Struct({
  route: Route,
  search: Schema.String,
  roleFilter: Schema.NullOr(Schema.Literals(["customer", "supplier"])),
  showArchived: Schema.Boolean,
  list: ContactRecord.pipe(Schema.Array, Remote.remoteSchema),
  detail: Remote.remoteSchema(ContactRecord),
  relatedDocs: RelatedDocumentRecord.pipe(Schema.Array, Remote.remoteSchema),
  relatedExpenses: ExpenseSummaryRecord.pipe(Schema.Array, Remote.remoteSchema),
  editor: Schema.NullOr(ContactEditor),
  refreshingAres: Schema.Boolean,
  confirmArchive: Schema.Boolean,
  archiving: Schema.Boolean,
});
export type Model = typeof Model.Type;

export const Message = UiSchema.TaggedEnum({
  LoadedList: { seq: Schema.Int, contacts: Schema.Array(ContactRecord) },
  FailedList: { seq: Schema.Int, failure: Failure },
  ChangedSearch: { value: Schema.String },
  SelectedRoleFilter: { role: Schema.NullOr(Schema.Literals(["customer", "supplier"])) },
  ToggledShowArchived: { checked: Schema.Boolean },
  ClickedRetryList: {},

  LoadedDetail: { seq: Schema.Int, contact: ContactRecord },
  FailedDetail: { seq: Schema.Int, failure: Failure },
  LoadedRelatedDocs: { seq: Schema.Int, docs: Schema.Array(RelatedDocumentRecord) },
  FailedRelatedDocs: { seq: Schema.Int, failure: Failure },
  LoadedRelatedExpenses: { seq: Schema.Int, expenses: Schema.Array(ExpenseSummaryRecord) },
  FailedRelatedExpenses: { seq: Schema.Int, failure: Failure },
  ClickedRetryDetail: {},

  ClickedRefreshAres: {},
  RefreshedAres: { contact: ContactRecord },
  FailedRefreshAres: { failure: Failure },

  ChangedEditorField: {
    field: Schema.Literals([
      "icoLookup",
      "name",
      "ico",
      "dic",
      "legalForm",
      "street",
      "city",
      "postalCode",
      "country",
      "phone",
      "note",
      "currencyOverride",
      "languageOverride",
      "dueDaysOverride",
      "paymentMethodOverride",
      "defaultNoteOverride",
      "reminderOffsets",
    ]),
    value: Schema.String,
  },
  ToggledRole: { role: Schema.Literals(["customer", "supplier"]), checked: Schema.Boolean },
  ChangedReminderMode: { mode: Schema.Literals(["inherit", "disabled", "custom"]) },
  ChangedEmail: { index: Schema.Int, value: Schema.String },
  ClickedAddEmail: {},
  ClickedRemoveEmail: { index: Schema.Int },
  ClearedOverride: {
    field: Schema.Literals([
      "currencyOverride",
      "languageOverride",
      "dueDaysOverride",
      "paymentMethodOverride",
      "defaultNoteOverride",
    ]),
  },
  ClickedLookupAres: {},
  LoadedAresLookup: { seq: Schema.Int, contact: ContactRecord },
  FailedAresLookup: { seq: Schema.Int, failure: Failure },

  SubmittedEditor: {},
  SavedContact: { contact: ContactRecord },
  FailedSave: { failure: Failure },

  RequestedArchive: {},
  CancelledArchive: {},
  ConfirmedArchive: {},
  ArchivedContact: {},
  FailedArchive: { failure: Failure },
});
export type Message = typeof Message.Type;

// --- Commands ------------------------------------------------------------------------------------

const loadListCommand = (
  workspaceId: string,
  seq: number,
  text: string,
  role: "customer" | "supplier" | null,
): PageCommand<Message> =>
  apiCommand(
    Message,
    "ContactsSearch",
    request(
      (client) => {
        const trimmed = Str.trim(text);
        const textFilter = trimmed === "" ? undefined : { text: trimmed };
        const roleFilter = role === null ? undefined : { role };
        return client.contacts.search({
          params: { workspaceId: WorkspaceId.make(workspaceId) },
          query: { ...textFilter, ...roleFilter },
        });
      },
      (pageRes): Message =>
        Message.LoadedList({ seq, contacts: Arr.map(pageRes.items, normalizeContact) }),
      (failure): Message => Message.FailedList({ seq, failure }),
    ),
  );

const loadDetailCommand = (
  workspaceId: string,
  contactId: string,
  seq: number,
): PageCommand<Message> =>
  apiCommand(
    Message,
    "ContactsGet",
    request(
      (client) =>
        client.contacts.get({
          params: {
            workspaceId: WorkspaceId.make(workspaceId),
            contactId: ContactId.make(contactId),
          },
        }),
      (raw): Message => Message.LoadedDetail({ seq, contact: normalizeContact(raw) }),
      (failure): Message => Message.FailedDetail({ seq, failure }),
    ),
  );

const RelatedDocumentFields = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  number: Schema.String.pipe(Schema.NullOr, Schema.optionalKey),
  kind: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  settlement: Schema.optionalKey(Schema.String),
  dates: Schema.optionalKey(Schema.Struct({ issuedOn: Schema.optionalKey(Schema.String) })),
  totals: Schema.optionalKey(
    Schema.Struct({
      gross: Schema.optionalKey(
        Schema.Struct({
          amount: Schema.optionalKey(
            Schema.Union([Schema.String, Schema.Finite, Schema.BigDecimal]),
          ),
          currency: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
});
const decodeRelatedDocument = Schema.decodeUnknownOption(RelatedDocumentFields);

const loadRelatedDocsCommand = (
  workspaceId: string,
  contactId: string,
  seq: number,
): PageCommand<Message> =>
  apiCommand(
    Message,
    "ContactsRelatedDocs",
    request(
      (client) =>
        client.documents.list({
          params: { workspaceId: WorkspaceId.make(workspaceId) },
          query: { contact: ContactId.make(contactId), limit: 10 },
        }),
      (pageRes): Message =>
        Message.LoadedRelatedDocs({
          seq,
          docs: Arr.map(pageRes.items, (item) => {
            const r = Option.getOrUndefined(decodeRelatedDocument(item));
            return {
              id: r?.id ?? "",
              number: r?.number ?? null,
              kind: r?.kind ?? "invoice",
              status: r?.status ?? "issued",
              settlement: r?.settlement ?? "unpaid",
              issuedOn: r?.dates?.issuedOn ?? null,
              totalAmount: decimalToString(r?.totals?.gross?.amount),
              currency: r?.totals?.gross?.currency ?? "CZK",
            };
          }),
        }),
      (failure): Message => Message.FailedRelatedDocs({ seq, failure }),
    ),
  );

const loadRelatedExpensesCommand = (workspaceId: string, seq: number): PageCommand<Message> =>
  apiCommand(
    Message,
    "ContactsRelatedExpenses",
    request(
      (client) =>
        client.expenses.list({
          params: { workspaceId: WorkspaceId.make(workspaceId) },
          query: { limit: 25 },
        }),
      (pageRes): Message =>
        Message.LoadedRelatedExpenses({
          seq,
          expenses: Arr.map(pageRes.items, normalizeExpenseSummary),
        }),
      (failure): Message => Message.FailedRelatedExpenses({ seq, failure }),
    ),
  );

const lookupAresCommand = (
  workspaceId: string,
  ico: string,
  seq: number,
  role?: ContactRoleLiteral,
): PageCommand<Message> =>
  apiCommand(
    Message,
    "ContactsLookupAres",
    request(
      (client) =>
        client.contacts.fromIco({
          params: { workspaceId: WorkspaceId.make(workspaceId) },
          payload: role === undefined ? { ico } : { ico, role },
        }),
      (raw): Message => Message.LoadedAresLookup({ seq, contact: normalizeContact(raw) }),
      (failure): Message => Message.FailedAresLookup({ seq, failure }),
    ),
  );

const refreshAresCommand = (workspaceId: string, ico: string): PageCommand<Message> =>
  apiCommand(
    Message,
    "ContactsRefreshAres",
    request(
      (client) =>
        client.contacts.fromIco({
          params: { workspaceId: WorkspaceId.make(workspaceId) },
          payload: { ico },
        }),
      (raw): Message => Message.RefreshedAres({ contact: normalizeContact(raw) }),
      (failure): Message => Message.FailedRefreshAres({ failure }),
    ),
  );

const buildContactPayload = (ed: ContactEditor): ContactInput => {
  const roles: Array<ContactRoleLiteral> = [];
  if (ed.isCustomer) roles.push("customer");
  if (ed.isSupplier) roles.push("supplier");

  const dueDaysOpt = optInt(ed.dueDaysOverride);
  const offsets = Arr.filter(
    Arr.map(Str.split(ed.reminderOffsets, ","), (s) => Number(Str.trim(s))),
    (n) => Number.isInteger(n) && n >= 0,
  );

  const reminderPolicy: ContactDefaults["reminderPolicy"] =
    ed.reminderMode === "disabled"
      ? { mode: "disabled" }
      : ed.reminderMode === "custom"
        ? { mode: "custom", offsetsDays: offsets }
        : { mode: "inherit" };

  const currency =
    ed.currencyOverride === "" ? undefined : { currency: CurrencyCode.make(ed.currencyOverride) };
  const language =
    ed.languageOverride === "cs" || ed.languageOverride === "en"
      ? ({ language: ed.languageOverride } as const)
      : undefined;
  const dueDays = Option.isSome(dueDaysOpt) ? { dueDays: dueDaysOpt.value } : undefined;
  const method = Schema.is(PaymentMethod)(ed.paymentMethodOverride)
    ? { paymentMethod: ed.paymentMethodOverride }
    : undefined;
  const note = Str.trim(ed.defaultNoteOverride);
  const defaultNote = note === "" ? undefined : { defaultNote: note };
  const defaults = {
    ...currency,
    ...language,
    ...dueDays,
    ...method,
    ...defaultNote,
    reminderPolicy,
  } satisfies ContactDefaults;

  return ContactInput.make({
    roles: roles.length > 0 ? roles : ["customer"],
    name: Str.trim(ed.name),
    ico: Str.trim(ed.ico) === "" ? null : Format.normalizeIco(ed.ico),
    dic: Str.trim(ed.dic) === "" ? null : Format.normalizeVatId(ed.dic),
    legalForm: Str.trim(ed.legalForm) === "" ? null : Str.trim(ed.legalForm),
    address: {
      street: Str.trim(ed.street) === "" ? null : Str.trim(ed.street),
      city: Str.trim(ed.city) === "" ? null : Str.trim(ed.city),
      postalCode: Str.trim(ed.postalCode) === "" ? null : Str.trim(ed.postalCode),
      country: Str.slice(0, 2)(Str.toUpperCase(Str.trim(ed.country) || "CZ")),
    },
    billingEmails: Arr.filter(
      Arr.map(ed.billingEmails, (e) => Str.trim(e)),
      (e) => e !== "",
    ),
    phone: Str.trim(ed.phone) === "" ? null : Str.trim(ed.phone),
    note: Str.trim(ed.note) === "" ? null : Str.trim(ed.note),
    defaults,
  });
};

const saveContactCommand = (workspaceId: string, ed: ContactEditor): PageCommand<Message> => {
  const payload = buildContactPayload(ed);
  return apiCommand(
    Message,
    "ContactsSave",
    request(
      (client) =>
        ed.id === null
          ? client.contacts.create({
              params: { workspaceId: WorkspaceId.make(workspaceId) },
              headers: { "idempotency-key": ed.idempotencyKey },
              payload,
            })
          : client.contacts.update({
              params: {
                workspaceId: WorkspaceId.make(workspaceId),
                contactId: ContactId.make(ed.id),
              },
              headers: { "if-match": `"${ed.revision ?? 1}"` },
              payload,
            }),
      (raw): Message => Message.SavedContact({ contact: normalizeContact(raw) }),
      (failure): Message => Message.FailedSave({ failure }),
    ),
  );
};

const archiveContactCommand = (workspaceId: string, contactId: string): PageCommand<Message> =>
  apiCommand(
    Message,
    "ContactsArchive",
    request(
      (client) =>
        client.contacts.archive({
          params: {
            workspaceId: WorkspaceId.make(workspaceId),
            contactId: ContactId.make(contactId),
          },
        }),
      (): Message => Message.ArchivedContact(),
      (failure): Message => Message.FailedArchive({ failure }),
    ),
  );

// --- Editor state builders -----------------------------------------------------------------------

const emptyEditor = (): ContactEditor => ({
  id: null,
  revision: null,
  icoLookup: "",
  aresBusy: false,
  aresSeq: 0,
  aresError: null,
  isCustomer: true,
  isSupplier: false,
  name: "",
  ico: "",
  dic: "",
  legalForm: "",
  street: "",
  city: "",
  postalCode: "",
  country: "CZ",
  billingEmails: [""],
  phone: "",
  note: "",
  currencyOverride: "",
  languageOverride: "",
  dueDaysOverride: "",
  paymentMethodOverride: "",
  defaultNoteOverride: "",
  reminderMode: "inherit",
  reminderOffsets: "7, 14",
  idempotencyKey: newIdempotencyKey("cnt"),
  saving: false,
  error: null,
});

const editorFromContact = (c: ContactRecord): ContactEditor => {
  const rp = c.defaults.reminderPolicy ?? { mode: "inherit" as const };
  return {
    id: c.id,
    revision: c.revision,
    icoLookup: c.ico ?? "",
    aresBusy: false,
    aresSeq: 0,
    aresError: null,
    isCustomer: c.roles.includes("customer"),
    isSupplier: c.roles.includes("supplier"),
    name: c.name,
    ico: c.ico ?? "",
    dic: c.dic ?? "",
    legalForm: c.legalForm ?? "",
    street: c.address.street ?? "",
    city: c.address.city ?? "",
    postalCode: c.address.postalCode ?? "",
    country: c.address.country,
    billingEmails: c.billingEmails.length > 0 ? c.billingEmails : [""],
    phone: c.phone ?? "",
    note: c.note ?? "",
    currencyOverride: c.defaults.currency ?? "",
    languageOverride: c.defaults.language ?? "",
    dueDaysOverride: c.defaults.dueDays === undefined ? "" : String(c.defaults.dueDays),
    paymentMethodOverride: c.defaults.paymentMethod ?? "",
    defaultNoteOverride: c.defaults.defaultNote ?? "",
    reminderMode: rp.mode,
    reminderOffsets:
      rp.mode === "custom" ? Arr.join(Arr.map(rp.offsetsDays, String), ", ") : "7, 14",
    idempotencyKey: newIdempotencyKey("cnt"),
    saving: false,
    error: null,
  };
};

// --- Init & Update -------------------------------------------------------------------------------

export const init: {
  (ctx: PageContext): (route: Route) => PageReturn<Model, Message>;
  (route: Route, ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(2, (route: Route, ctx: PageContext): PageReturn<Model, Message> => {
  const wsId = ctx.workspace?.id;
  if (route._tag === "Contacts") {
    const search = route.query.text ?? "";
    const roleFilter = route.query.role ?? null;
    const showArchived = route.query.archived ?? false;
    const list = Remote.load<ReadonlyArray<ContactRecord>>(Remote.idle);
    return {
      model: {
        route,
        search,
        roleFilter,
        showArchived,
        list,
        detail: Remote.idle,
        relatedDocs: Remote.idle,
        relatedExpenses: Remote.idle,
        editor: null,
        refreshingAres: false,
        confirmArchive: false,
        archiving: false,
      },
      commands:
        wsId === undefined ? [] : [loadListCommand(wsId, Remote.seqOf(list), search, roleFilter)],
    };
  }

  if (route.id === "new") {
    return {
      model: {
        route,
        search: "",
        roleFilter: null,
        showArchived: false,
        list: Remote.idle,
        detail: Remote.idle,
        relatedDocs: Remote.idle,
        relatedExpenses: Remote.idle,
        editor: emptyEditor(),
        refreshingAres: false,
        confirmArchive: false,
        archiving: false,
      },
    };
  }

  const detail = Remote.load<ContactRecord>(Remote.idle);
  const relatedDocs = Remote.load<ReadonlyArray<RelatedDocumentRecord>>(Remote.idle);
  const relatedExpenses = Remote.load<ReadonlyArray<ExpenseSummaryRecord>>(Remote.idle);
  return {
    model: {
      route,
      search: "",
      roleFilter: null,
      showArchived: false,
      list: Remote.idle,
      detail,
      relatedDocs,
      relatedExpenses,
      editor: null,
      refreshingAres: false,
      confirmArchive: false,
      archiving: false,
    },
    commands:
      wsId === undefined
        ? []
        : [
            loadDetailCommand(wsId, route.id, Remote.seqOf(detail)),
            loadRelatedDocsCommand(wsId, route.id, Remote.seqOf(relatedDocs)),
            loadRelatedExpensesCommand(wsId, Remote.seqOf(relatedExpenses)),
          ],
  };
});

export const update: {
  (message: Message, ctx: PageContext): (model: Model) => PageReturn<Model, Message>;
  (model: Model, message: Message, ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(3, (model: Model, message: Message, ctx: PageContext): PageReturn<Model, Message> => {
  const tr = translator(ctx.locale);
  const route = model.route;
  const wsId = ctx.workspace?.id;

  return Message.match(message, {
    LoadedList: ({ seq, contacts }) => ({
      model: { ...model, list: Remote.succeed(model.list, seq, contacts) },
    }),

    FailedList: ({ seq, failure }) => ({
      model: { ...model, list: Remote.fail(model.list, seq, failure) },
    }),

    ChangedSearch: ({ value }) => {
      const nextList = Remote.load(model.list);
      return {
        model: { ...model, search: value, list: nextList },
        commands:
          wsId === undefined
            ? []
            : [loadListCommand(wsId, Remote.seqOf(nextList), value, model.roleFilter)],
      };
    },

    SelectedRoleFilter: ({ role }) => {
      const nextList = Remote.load(model.list);
      return {
        model: { ...model, roleFilter: role, list: nextList },
        commands:
          wsId === undefined
            ? []
            : [loadListCommand(wsId, Remote.seqOf(nextList), model.search, role)],
      };
    },

    ToggledShowArchived: ({ checked }) => ({
      model: { ...model, showArchived: checked },
    }),

    ClickedRetryList: () => {
      const nextList = Remote.load(model.list);
      return {
        model: { ...model, list: nextList },
        commands:
          wsId === undefined
            ? []
            : [loadListCommand(wsId, Remote.seqOf(nextList), model.search, model.roleFilter)],
      };
    },

    LoadedDetail: ({ seq, contact }) => {
      const nextDetail = Remote.succeed(model.detail, seq, contact);
      const shouldEdit = route._tag === "Contact" && route.mode === "edit";
      return {
        model: {
          ...model,
          detail: nextDetail,
          editor: shouldEdit ? editorFromContact(contact) : model.editor,
        },
      };
    },

    FailedDetail: ({ seq, failure }) => ({
      model: { ...model, detail: Remote.fail(model.detail, seq, failure) },
    }),

    LoadedRelatedDocs: ({ seq, docs }) => ({
      model: { ...model, relatedDocs: Remote.succeed(model.relatedDocs, seq, docs) },
    }),

    FailedRelatedDocs: ({ seq, failure }) => ({
      model: { ...model, relatedDocs: Remote.fail(model.relatedDocs, seq, failure) },
    }),

    LoadedRelatedExpenses: ({ seq, expenses }) => ({
      model: { ...model, relatedExpenses: Remote.succeed(model.relatedExpenses, seq, expenses) },
    }),

    FailedRelatedExpenses: ({ seq, failure }) => ({
      model: { ...model, relatedExpenses: Remote.fail(model.relatedExpenses, seq, failure) },
    }),

    ClickedRetryDetail: () => {
      if (route._tag !== "Contact" || route.id === "new" || wsId === undefined) return { model };
      const nextDetail = Remote.load(model.detail);
      return {
        model: { ...model, detail: nextDetail },
        commands: [loadDetailCommand(wsId, route.id, Remote.seqOf(nextDetail))],
      };
    },

    ClickedRefreshAres: () => {
      const contact = Remote.dataOf(model.detail);
      if (contact === undefined || contact.ico === null || wsId === undefined) return { model };
      return {
        model: { ...model, refreshingAres: true },
        commands: [refreshAresCommand(wsId, contact.ico)],
      };
    },

    RefreshedAres: ({ contact }) => ({
      model: {
        ...model,
        refreshingAres: false,
        detail: { _tag: "Loaded", seq: Remote.seqOf(model.detail), data: contact },
      },
      outMessage: Intent_.toast(tr.t("contacts.detail.refreshed"), "info"),
    }),

    FailedRefreshAres: ({ failure }) => ({
      model: { ...model, refreshingAres: false },
      outMessage: Intent_.toast(textOf(tr, failure.text), "error"),
    }),

    ChangedEditorField: ({ field, value }) => {
      if (model.editor === null) return { model };
      return {
        model: {
          ...model,
          editor: { ...model.editor, [field]: value, error: null, aresError: null },
        },
      };
    },

    ToggledRole: ({ role, checked }) => {
      if (model.editor === null) return { model };
      return {
        model: {
          ...model,
          editor: {
            ...model.editor,
            ...(role === "customer" ? { isCustomer: checked } : { isSupplier: checked }),
            error: null,
          },
        },
      };
    },

    ChangedReminderMode: ({ mode }) => {
      if (model.editor === null) return { model };
      return {
        model: { ...model, editor: { ...model.editor, reminderMode: mode } },
      };
    },

    ChangedEmail: ({ index, value }) => {
      if (model.editor === null) return { model };
      const next = Arr.map(model.editor.billingEmails, (e, i) => (i === index ? value : e));
      return {
        model: { ...model, editor: { ...model.editor, billingEmails: next } },
      };
    },

    ClickedAddEmail: () => {
      if (model.editor === null) return { model };
      return {
        model: {
          ...model,
          editor: { ...model.editor, billingEmails: [...model.editor.billingEmails, ""] },
        },
      };
    },

    ClickedRemoveEmail: ({ index }) => {
      if (model.editor === null) return { model };
      const next = Arr.filter(model.editor.billingEmails, (_, i) => i !== index);
      return {
        model: {
          ...model,
          editor: { ...model.editor, billingEmails: next.length > 0 ? next : [""] },
        },
      };
    },

    ClearedOverride: ({ field }) => {
      if (model.editor === null) return { model };
      return {
        model: { ...model, editor: { ...model.editor, [field]: "" } },
      };
    },

    ClickedLookupAres: () => {
      if (model.editor === null || wsId === undefined) return { model };
      const normalized = Format.normalizeIco(model.editor.icoLookup);
      if (Result.isFailure(Format.validateIco(normalized))) {
        return {
          model: {
            ...model,
            editor: { ...model.editor, aresError: tLocal(ctx.locale, "icoInvalid") },
          },
        };
      }
      const nextSeq = model.editor.aresSeq + 1;
      const role: ContactRoleLiteral | undefined =
        model.editor.isSupplier && !model.editor.isCustomer ? "supplier" : "customer";
      return {
        model: {
          ...model,
          editor: { ...model.editor, aresBusy: true, aresSeq: nextSeq, aresError: null },
        },
        commands: [lookupAresCommand(wsId, normalized, nextSeq, role)],
      };
    },

    LoadedAresLookup: ({ seq, contact }) => {
      if (model.editor === null || model.editor.aresSeq !== seq) return { model };
      return {
        model: {
          ...model,
          editor: {
            ...model.editor,
            id: model.editor.id ?? contact.id,
            revision: model.editor.revision ?? contact.revision,
            aresBusy: false,
            aresError: null,
            name: contact.name,
            ico: contact.ico ?? model.editor.icoLookup,
            dic: contact.dic ?? model.editor.dic,
            legalForm: contact.legalForm ?? model.editor.legalForm,
            street: contact.address.street ?? model.editor.street,
            city: contact.address.city ?? model.editor.city,
            postalCode: contact.address.postalCode ?? model.editor.postalCode,
            country: contact.address.country,
          },
        },
        outMessage: Intent_.toast(tLocal(ctx.locale, "aresFound"), "info"),
      };
    },

    FailedAresLookup: ({ seq, failure }) => {
      if (model.editor === null || model.editor.aresSeq !== seq) return { model };
      return {
        model: {
          ...model,
          editor: { ...model.editor, aresBusy: false, aresError: textOf(tr, failure.text) },
        },
      };
    },

    SubmittedEditor: () => {
      if (model.editor === null || model.editor.saving || wsId === undefined) return { model };
      if (Str.trim(model.editor.name) === "") {
        return {
          model: {
            ...model,
            editor: { ...model.editor, error: tLocal(ctx.locale, "nameRequired") },
          },
        };
      }
      if (!(model.editor.isCustomer || model.editor.isSupplier)) {
        return {
          model: {
            ...model,
            editor: { ...model.editor, error: tLocal(ctx.locale, "roleRequired") },
          },
        };
      }
      const nextEd: ContactEditor = { ...model.editor, saving: true, error: null };
      return {
        model: { ...model, editor: nextEd },
        commands: [saveContactCommand(wsId, nextEd)],
      };
    },

    SavedContact: ({ contact }) => ({
      model: {
        ...model,
        detail: { _tag: "Loaded", seq: Remote.seqOf(model.detail) + 1, data: contact },
        editor: null,
      },
      outMessage: Intent_.navigate(
        href({
          _tag: "Contact",
          ws: route.ws,
          id: ContactId.make(contact.id),
          mode: "view",
        }),
        false,
      ),
    }),

    FailedSave: ({ failure }) => {
      if (model.editor === null) return { model };
      const msg = failure.staleRevision
        ? tLocal(ctx.locale, "staleNotice")
        : textOf(tr, failure.text);
      return {
        model: { ...model, editor: { ...model.editor, saving: false, error: msg } },
      };
    },

    RequestedArchive: () => ({
      model: { ...model, confirmArchive: true },
    }),

    CancelledArchive: () => ({
      model: { ...model, confirmArchive: false },
    }),

    ConfirmedArchive: () => {
      if (route._tag !== "Contact" || route.id === "new" || wsId === undefined) return { model };
      return {
        model: { ...model, archiving: true },
        commands: [archiveContactCommand(wsId, route.id)],
      };
    },

    ArchivedContact: () => ({
      model: { ...model, archiving: false, confirmArchive: false },
      outMessage: Intent_.navigate(href({ _tag: "Contacts", ws: route.ws, query: {} }), false),
    }),

    FailedArchive: ({ failure }) => ({
      model: { ...model, archiving: false, confirmArchive: false },
      outMessage: Intent_.toast(textOf(tr, failure.text), "error"),
    }),
  } satisfies MessageHandlers<Message, PageReturn<Model, Message>>);
});

export const title: {
  (ctx: PageContext): (model: Model) => string;
  (model: Model, ctx: PageContext): string;
} = Fn.dual(2, (model: Model, ctx: PageContext): string => {
  const tr = translator(ctx.locale);
  const route = model.route;
  if (route._tag === "Contacts") return tr.t("contacts.list.title");
  if (route.id === "new") return tr.t("contacts.list.new");
  const detail = Remote.dataOf(model.detail);
  return detail?.name ?? tr.t("contacts.editor.title");
});

// --- View ----------------------------------------------------------------------------------------

export const view: {
  (ctx: PageContext, h: Html.H<Message>): (model: Model) => Markup<Message>;
  (model: Model, ctx: PageContext, h: Html.H<Message>): Markup<Message>;
} = Fn.dual(3, (model: Model, ctx: PageContext, h: Html.H<Message>): Markup<Message> => {
  const tr = translator(ctx.locale);
  const route = model.route;
  const writable = canWrite(ctx);

  // --- List view ---
  if (route._tag === "Contacts") {
    const rawContacts = Remote.dataOf(model.list);
    const visibleContacts =
      rawContacts === undefined
        ? undefined
        : model.showArchived
          ? rawContacts
          : Arr.filter(rawContacts, (c) => !c.archived);

    const headers = [
      tLocal(ctx.locale, "colName"),
      tLocal(ctx.locale, "colRoles"),
      tLocal(ctx.locale, "colIds"),
      tLocal(ctx.locale, "colLocation"),
      tLocal(ctx.locale, "colEmail"),
    ];

    const listBody = (() => {
      if (model.list._tag === "Loading" || model.list._tag === "Idle") {
        return skeletonTable(h, headers, 6);
      }
      if (model.list._tag === "Failed") {
        return banner(h, {
          text: textOf(tr, model.list.failure.text),
          tone: "error",
          action: button(h, {
            label: tr.t("common.action.retry"),
            small: true,
            onClick: Message.ClickedRetryList(),
          }),
        });
      }
      if (visibleContacts === undefined || visibleContacts.length === 0) {
        const action = writable
          ? {
              action: linkButton(h, {
                label: tr.t("contacts.list.empty.cta"),
                href: href({ _tag: "Contact", ws: route.ws, id: "new", mode: "edit" }),
                variant: "primary",
              }),
            }
          : undefined;
        return emptyState(h, {
          title: tr.t("contacts.list.empty.title"),
          body: tr.t("contacts.list.empty.body"),
          ...action,
        });
      }
      return table(h, {
        caption: tr.t("contacts.list.title"),
        rows: visibleContacts,
        rowKey: (c) => c.id,
        columns: [
          {
            header: tLocal(ctx.locale, "colName"),
            cell: (c) =>
              h.div
                .class(c.archived ? "kb-stack kb-row-archived" : "kb-stack")
                .style({ "--kb-gap": "2px" })
                .children([
                  h.a
                    .attr(
                      "href",
                      href({
                        _tag: "Contact",
                        ws: route.ws,
                        id: ContactId.make(c.id),
                        mode: "view",
                      }),
                    )
                    .children([h.strong.children([c.name])]),
                  ...(c.legalForm !== null
                    ? [h.span.class("kb-small kb-muted").children([c.legalForm])]
                    : []),
                ]),
          },
          {
            header: tLocal(ctx.locale, "colRoles"),
            cell: (c) =>
              h.div
                .class("kb-row")
                .children([
                  ...Arr.map(c.roles, (r) =>
                    badge(
                      h,
                      enumLabel(tr, "contactRole", r),
                      r === "customer" ? "proforma" : "neutral",
                    ),
                  ),
                  ...(c.archived
                    ? [badge(h, ctx.locale === "cs" ? "Archivovaný" : "Archived", "outline")]
                    : []),
                ]),
          },
          {
            header: tLocal(ctx.locale, "colIds"),
            cell: (c) =>
              h.div
                .class("kb-stack")
                .style({ "--kb-gap": "2px" })
                .children([
                  c.ico !== null ? mono(h, c.ico) : h.span.class("kb-muted").children(["—"]),
                  ...(c.dic !== null
                    ? [h.span.class("kb-small kb-mono kb-muted").children([c.dic])]
                    : []),
                ]),
          },
          {
            header: tLocal(ctx.locale, "colLocation"),
            cell: (c) =>
              h.span.class("kb-muted").children([
                Arr.join(
                  Arr.filter(
                    [c.address.city, c.address.country],
                    (x): x is string => x !== null && x !== "",
                  ),
                  ", ",
                ) || "—",
              ]),
          },
          {
            header: tLocal(ctx.locale, "colEmail"),
            cell: (c) => h.span.class("kb-muted").children([c.billingEmails[0] ?? "—"]),
          },
        ],
      });
    })();

    return page(h, [
      pageHeader(h, {
        title: tr.t("contacts.list.title"),
        subtitle: tLocal(ctx.locale, "subtitle"),
        actions: writable
          ? [
              linkButton(h, {
                label: tr.t("contacts.list.new"),
                href: href({ _tag: "Contact", ws: route.ws, id: "new", mode: "edit" }),
                variant: "primary",
              }),
            ]
          : [],
      }),
      h.div.class("kb-rec-toolbar").children([
        h.div.class("kb-rec-search").children([
          h.span.class("kb-rec-search__icon").children([icon(h, "search", 16)]),
          h.input
            .class("kb-input")
            .attr("type", "search")
            .attr("placeholder", tr.t("contacts.list.search"))
            .attr("aria-label", tr.t("contacts.list.search"))
            .value(model.search)
            .on("input", ({ value }) => Message.ChangedSearch({ value })),
        ]),
        h.div.class("kb-rec-chips").children([
          h.button
            .class("kb-chip")
            .attr("type", "button")
            .attr("aria-pressed", String(model.roleFilter === null ? "true" : "false"))
            .on("click", Message.SelectedRoleFilter({ role: null }))
            .children([tLocal(ctx.locale, "allRoles")]),
          h.button
            .class("kb-chip")
            .attr("type", "button")
            .attr("aria-pressed", String(model.roleFilter === "customer" ? "true" : "false"))
            .on("click", Message.SelectedRoleFilter({ role: "customer" }))
            .children([tLocal(ctx.locale, "customers")]),
          h.button
            .class("kb-chip")
            .attr("type", "button")
            .attr("aria-pressed", String(model.roleFilter === "supplier" ? "true" : "false"))
            .on("click", Message.SelectedRoleFilter({ role: "supplier" }))
            .children([tLocal(ctx.locale, "suppliers")]),
          checkbox(h, {
            id: "contacts-show-archived",
            label: tr.t("contacts.list.showArchived"),
            checked: model.showArchived,
            onToggle: (checked) => Message.ToggledShowArchived({ checked }),
          }),
        ]),
      ]),
      listBody,
    ]);
  }

  // --- Editor view (new or edit) ---
  if (route.id === "new" || route.mode === "edit") {
    const ed = model.editor;
    if (ed === null) {
      return page(h, [
        pageHeader(h, { title: tr.t("contacts.editor.title") }),
        card(h, [skeleton(h, "60%", "1.2rem"), skeleton(h, "100%", "10rem")]),
      ]);
    }
    const cancelHref =
      route.id === "new"
        ? href({ _tag: "Contacts", ws: route.ws, query: {} })
        : href({ _tag: "Contact", ws: route.ws, id: route.id, mode: "view" });

    return page(h, [
      pageHeader(h, {
        title:
          route.id === "new"
            ? tr.t("contacts.list.new")
            : ed.name === ""
              ? tr.t("contacts.editor.title")
              : ed.name,
        eyebrow: linkButton(h, {
          label: tLocal(ctx.locale, "backToList"),
          href: href({ _tag: "Contacts", ws: route.ws, query: {} }),
          variant: "ghost",
          small: true,
        }),
        actions: [
          linkButton(h, { label: tr.t("common.action.cancel"), href: cancelHref }),
          button(h, {
            label: tr.t("common.action.save"),
            variant: "primary",
            busy: ed.saving,
            onClick: Message.SubmittedEditor(),
          }),
        ],
      }),
      card(h, [
        cardTitle(h, "ARES"),
        h.p.class("kb-small kb-muted").children([tr.t("contacts.editor.icoFirst")]),
        ...(ed.aresError !== null ? [banner(h, { text: ed.aresError, tone: "error" })] : []),
        h.div.class("kb-inline-action").children([
          textField(h, {
            id: "contact-ares-ico",
            label: tr.t("common.field.ico"),
            value: ed.icoLookup,
            mono: true,
            placeholder: "27082440",
            onInput: (value) => Message.ChangedEditorField({ field: "icoLookup", value }),
          }),
          button(h, {
            label: tr.t("contacts.editor.lookup"),
            busy: ed.aresBusy,
            onClick: Message.ClickedLookupAres(),
          }),
        ]),
      ]),
      h.form
        .class("kb-stack")
        .on("submit", Message.SubmittedEditor(), { preventDefault: true })
        .children([
          ...(ed.error !== null ? [banner(h, { text: ed.error, tone: "error" })] : []),
          card(h, [
            cardTitle(h, tr.t("contacts.detail.particulars")),
            h.div.class("kb-row").children([
              checkbox(h, {
                id: "contact-role-customer",
                label: enumLabel(tr, "contactRole", "customer"),
                checked: ed.isCustomer,
                onToggle: (checked) => Message.ToggledRole({ role: "customer", checked }),
              }),
              checkbox(h, {
                id: "contact-role-supplier",
                label: enumLabel(tr, "contactRole", "supplier"),
                checked: ed.isSupplier,
                onToggle: (checked) => Message.ToggledRole({ role: "supplier", checked }),
              }),
            ]),
            h.div.class("kb-form-grid").children([
              h.div.class("kb-form-span-full").children([
                textField(h, {
                  id: "contact-name",
                  label: tr.t("contacts.editor.companyName"),
                  value: ed.name,
                  required: true,
                  onInput: (value) => Message.ChangedEditorField({ field: "name", value }),
                }),
              ]),
              textField(h, {
                id: "contact-ico",
                label: tr.t("common.field.ico"),
                value: ed.ico,
                mono: true,
                onInput: (value) => Message.ChangedEditorField({ field: "ico", value }),
              }),
              textField(h, {
                id: "contact-dic",
                label: tr.t("common.field.dic"),
                value: ed.dic,
                mono: true,
                onInput: (value) => Message.ChangedEditorField({ field: "dic", value }),
              }),
              textField(h, {
                id: "contact-legal-form",
                label: tLocal(ctx.locale, "legalForm"),
                value: ed.legalForm,
                onInput: (value) => Message.ChangedEditorField({ field: "legalForm", value }),
              }),
              textField(h, {
                id: "contact-phone",
                label: tr.t("common.field.phone"),
                value: ed.phone,
                onInput: (value) => Message.ChangedEditorField({ field: "phone", value }),
              }),
              textField(h, {
                id: "contact-street",
                label: tr.t("common.field.street"),
                value: ed.street,
                onInput: (value) => Message.ChangedEditorField({ field: "street", value }),
              }),
              textField(h, {
                id: "contact-city",
                label: tr.t("common.field.city"),
                value: ed.city,
                onInput: (value) => Message.ChangedEditorField({ field: "city", value }),
              }),
              textField(h, {
                id: "contact-postal",
                label: tr.t("common.field.postalCode"),
                value: ed.postalCode,
                mono: true,
                onInput: (value) => Message.ChangedEditorField({ field: "postalCode", value }),
              }),
              textField(h, {
                id: "contact-country",
                label: tr.t("common.field.country"),
                value: ed.country,
                mono: true,
                onInput: (value) => Message.ChangedEditorField({ field: "country", value }),
              }),
            ]),
            h.div.class("kb-stack").children([
              h.span.class("kb-field__label").children([tr.t("contacts.editor.invoicingEmails")]),
              h.div.class("kb-email-list").children(
                Arr.map(ed.billingEmails, (email, idx) =>
                  h.div.class("kb-inline-action").children([
                    textField(h, {
                      id: `contact-email-${idx}`,
                      label: `${tr.t("common.field.email")} #${idx + 1}`,
                      type: "email",
                      value: email,
                      onInput: (value) => Message.ChangedEmail({ index: idx, value }),
                    }),
                    ...(ed.billingEmails.length > 1
                      ? [
                          button(h, {
                            label: tr.t("common.action.remove"),
                            variant: "ghost",
                            small: true,
                            onClick: Message.ClickedRemoveEmail({ index: idx }),
                          }),
                        ]
                      : []),
                  ]),
                ),
              ),
              h.div.class("kb-row").children([
                button(h, {
                  label: tr.t("contacts.editor.addEmail"),
                  small: true,
                  icon: icon(h, "plus", 14),
                  onClick: Message.ClickedAddEmail(),
                }),
              ]),
            ]),
            textArea(h, {
              id: "contact-note",
              label: tr.t("common.field.note"),
              value: ed.note,
              onInput: (value) => Message.ChangedEditorField({ field: "note", value }),
            }),
          ]),
          card(h, [
            cardTitle(h, tr.t("contacts.editor.defaults.title")),
            h.p.class("kb-small kb-muted").children([tr.t("contacts.editor.defaults.intro")]),
            h.div.class("kb-override-row").children([
              h.div
                .class("kb-override-meta")
                .children([
                  h.strong.children([tr.t("contacts.editor.defaults.currency")]),
                  badge(
                    h,
                    ed.currencyOverride === ""
                      ? tr.t("contacts.override.inherited")
                      : tr.t("contacts.override.overridden"),
                    ed.currencyOverride === "" ? "neutral" : "proforma",
                  ),
                ]),
              selectField(h, {
                id: "contact-def-currency",
                label: tr.t("contacts.editor.defaults.currency"),
                value: ed.currencyOverride,
                options: [
                  { value: "", label: tr.t("contacts.override.workspaceDefault") },
                  ...Arr.map(CURRENCIES, (c) => ({ value: c, label: c })),
                ],
                onChange: (value) =>
                  Message.ChangedEditorField({ field: "currencyOverride", value }),
              }),
              ed.currencyOverride !== ""
                ? button(h, {
                    label: tLocal(ctx.locale, "overrideClear"),
                    variant: "ghost",
                    small: true,
                    onClick: Message.ClearedOverride({ field: "currencyOverride" }),
                  })
                : h.text(""),
            ]),
            h.div.class("kb-override-row").children([
              h.div
                .class("kb-override-meta")
                .children([
                  h.strong.children([tr.t("contacts.editor.defaults.language")]),
                  badge(
                    h,
                    ed.languageOverride === ""
                      ? tr.t("contacts.override.inherited")
                      : tr.t("contacts.override.overridden"),
                    ed.languageOverride === "" ? "neutral" : "proforma",
                  ),
                ]),
              selectField(h, {
                id: "contact-def-language",
                label: tr.t("contacts.editor.defaults.language"),
                value: ed.languageOverride,
                options: [
                  { value: "", label: tr.t("contacts.override.workspaceDefault") },
                  { value: "cs", label: enumLabel(tr, "locale", "cs") },
                  { value: "en", label: enumLabel(tr, "locale", "en") },
                ],
                onChange: (value) =>
                  Message.ChangedEditorField({ field: "languageOverride", value }),
              }),
              ed.languageOverride !== ""
                ? button(h, {
                    label: tLocal(ctx.locale, "overrideClear"),
                    variant: "ghost",
                    small: true,
                    onClick: Message.ClearedOverride({ field: "languageOverride" }),
                  })
                : h.text(""),
            ]),
            h.div.class("kb-override-row").children([
              h.div
                .class("kb-override-meta")
                .children([
                  h.strong.children([tr.t("contacts.editor.defaults.dueDays")]),
                  badge(
                    h,
                    ed.dueDaysOverride === ""
                      ? tr.t("contacts.override.inherited")
                      : tr.t("contacts.override.overridden"),
                    ed.dueDaysOverride === "" ? "neutral" : "proforma",
                  ),
                ]),
              textField(h, {
                id: "contact-def-due",
                label: tr.t("contacts.editor.defaults.dueDays"),
                type: "number",
                value: ed.dueDaysOverride,
                placeholder: "14",
                onInput: (value) => Message.ChangedEditorField({ field: "dueDaysOverride", value }),
              }),
              ed.dueDaysOverride !== ""
                ? button(h, {
                    label: tLocal(ctx.locale, "overrideClear"),
                    variant: "ghost",
                    small: true,
                    onClick: Message.ClearedOverride({ field: "dueDaysOverride" }),
                  })
                : h.text(""),
            ]),
            h.div.class("kb-override-row").children([
              h.div
                .class("kb-override-meta")
                .children([
                  h.strong.children([tr.t("contacts.editor.defaults.paymentMethod")]),
                  badge(
                    h,
                    ed.paymentMethodOverride === ""
                      ? tr.t("contacts.override.inherited")
                      : tr.t("contacts.override.overridden"),
                    ed.paymentMethodOverride === "" ? "neutral" : "proforma",
                  ),
                ]),
              selectField(h, {
                id: "contact-def-payment",
                label: tr.t("contacts.editor.defaults.paymentMethod"),
                value: ed.paymentMethodOverride,
                options: [
                  { value: "", label: tr.t("contacts.override.workspaceDefault") },
                  ...Arr.map(PAYMENT_METHODS, (pm) => ({
                    value: pm,
                    label: enumLabel(tr, "paymentMethod", pm),
                  })),
                ],
                onChange: (value) =>
                  Message.ChangedEditorField({ field: "paymentMethodOverride", value }),
              }),
              ed.paymentMethodOverride !== ""
                ? button(h, {
                    label: tLocal(ctx.locale, "overrideClear"),
                    variant: "ghost",
                    small: true,
                    onClick: Message.ClearedOverride({ field: "paymentMethodOverride" }),
                  })
                : h.text(""),
            ]),
            h.div.class("kb-override-row").children([
              h.div
                .class("kb-override-meta")
                .children([
                  h.strong.children([tr.t("contacts.editor.defaults.reminders")]),
                  badge(
                    h,
                    ed.reminderMode === "inherit"
                      ? tr.t("contacts.override.inherited")
                      : tr.t("contacts.override.overridden"),
                    ed.reminderMode === "inherit" ? "neutral" : "proforma",
                  ),
                ]),
              h.div.class("kb-stack").children([
                selectField<
                  Message,
                  ReadonlyArray<{ readonly value: typeof ed.reminderMode; readonly label: string }>
                >(h, {
                  id: "contact-def-reminders",
                  label: tr.t("contacts.editor.defaults.reminders"),
                  value: ed.reminderMode,
                  options: [
                    { value: "inherit", label: enumLabel(tr, "reminderMode", "inherit") },
                    { value: "disabled", label: enumLabel(tr, "reminderMode", "disabled") },
                    { value: "custom", label: enumLabel(tr, "reminderMode", "custom") },
                  ],
                  onChange: (value) =>
                    Message.ChangedReminderMode({
                      mode: value,
                    }),
                }),
                ...(ed.reminderMode === "custom"
                  ? [
                      textField(h, {
                        id: "contact-def-reminder-offsets",
                        label: tr.t("contacts.editor.defaults.reminderOffsets"),
                        value: ed.reminderOffsets,
                        placeholder: tLocal(ctx.locale, "reminderOffsetsPlaceholder"),
                        onInput: (value) =>
                          Message.ChangedEditorField({ field: "reminderOffsets", value }),
                      }),
                    ]
                  : []),
              ]),
              h.text(""),
            ]),
            textArea(h, {
              id: "contact-def-note",
              label: tr.t("contacts.editor.defaults.note"),
              value: ed.defaultNoteOverride,
              onInput: (value) =>
                Message.ChangedEditorField({ field: "defaultNoteOverride", value }),
            }),
          ]),
        ]),
    ]);
  }

  // --- Detail view ---
  const contact = Remote.dataOf(model.detail);
  if (model.detail._tag === "Loading" || model.detail._tag === "Idle") {
    return page(h, [
      pageHeader(h, { title: tr.t("contacts.editor.title") }),
      card(h, [skeleton(h, "45%", "1.4rem"), skeleton(h, "100%", "8rem")]),
    ]);
  }
  if (model.detail._tag === "Failed" || contact === undefined) {
    return page(h, [
      pageHeader(h, { title: tr.t("contacts.editor.title") }),
      banner(h, {
        text:
          model.detail._tag === "Failed"
            ? textOf(tr, model.detail.failure.text)
            : tr.t("common.state.error"),
        tone: "error",
        action: button(h, {
          label: tr.t("common.action.retry"),
          small: true,
          onClick: Message.ClickedRetryDetail(),
        }),
      }),
    ]);
  }

  const resolvedBilling = ViewModels.resolveBilling({
    kind: "invoice",
    contact: toDomainContactDefaults(contact.defaults),
    workspace: {
      currency: CurrencyCode.make("CZK"),
      language: "cs",
      dueDays: 14,
      paymentMethod: "bank_transfer",
    },
  });
  const resolvedReminders = ViewModels.resolveReminders(
    toDomainContactDefaults(contact.defaults).reminderPolicy,
    [7, 14],
  );

  const docs = Remote.dataOf(model.relatedDocs) ?? [];
  const expenses = Arr.filter(
    Remote.dataOf(model.relatedExpenses) ?? [],
    (ex) =>
      ex.supplierName !== null &&
      Str.toLowerCase(ex.supplierName) === Str.toLowerCase(contact.name),
  );

  const sourceBadge = (source: ViewModels.SettingSource) =>
    badge(h, enumLabel(tr, "settingSource", source), source === "contact" ? "proforma" : "neutral");

  const addressLine = Arr.join(
    Arr.filter(
      [
        contact.address.street,
        Arr.join(
          Arr.filter(
            [contact.address.postalCode, contact.address.city],
            (value): value is string => value !== null && value !== "",
          ),
          " ",
        ),
        contact.address.country,
      ],
      (p): p is string => p !== null && p !== "",
    ),
    ", ",
  );

  return page(h, [
    pageHeader(h, {
      title: contact.name,
      eyebrow: linkButton(h, {
        label: tLocal(ctx.locale, "backToList"),
        href: href({ _tag: "Contacts", ws: route.ws, query: {} }),
        variant: "ghost",
        small: true,
      }),
      actions: [
        ...(writable
          ? [
              linkButton(h, {
                label: tr.t("contacts.detail.newInvoice"),
                href: href({
                  _tag: "DocumentNew",
                  ws: route.ws,
                  kind: "invoice",
                  from: { _tag: "Contact", id: ContactId.make(contact.id) },
                }),
                variant: "primary",
              }),
              ...(contact.ico !== null
                ? [
                    button(h, {
                      label: tr.t("contacts.detail.refreshAres"),
                      busy: model.refreshingAres,
                      onClick: Message.ClickedRefreshAres(),
                    }),
                  ]
                : []),
              linkButton(h, {
                label: tr.t("common.action.edit"),
                href: href({
                  _tag: "Contact",
                  ws: route.ws,
                  id: ContactId.make(contact.id),
                  mode: "edit",
                }),
              }),
              ...(!contact.archived
                ? [
                    button(h, {
                      label: tr.t("common.action.archive"),
                      variant: "danger",
                      onClick: Message.RequestedArchive(),
                    }),
                  ]
                : []),
            ]
          : []),
      ],
    }),
    h.div
      .class("kb-row")
      .children([
        ...Arr.map(contact.roles, (r) =>
          badge(h, enumLabel(tr, "contactRole", r), r === "customer" ? "proforma" : "neutral"),
        ),
        ...(contact.archived
          ? [badge(h, ctx.locale === "cs" ? "Archivovaný" : "Archived", "outline")]
          : []),
      ]),
    h.div.class("kb-contact-grid").children([
      card(h, [
        cardTitle(h, tr.t("contacts.detail.particulars")),
        dl(h, [
          [tr.t("common.field.ico"), contact.ico !== null ? mono(h, contact.ico) : "—"],
          [tr.t("common.field.dic"), contact.dic !== null ? mono(h, contact.dic) : "—"],
          [tLocal(ctx.locale, "legalForm"), contact.legalForm ?? "—"],
          [tr.t("common.field.address"), addressLine || "—"],
          [
            tr.t("contacts.editor.invoicingEmails"),
            contact.billingEmails.length > 0 ? Arr.join(contact.billingEmails, ", ") : "—",
          ],
          [tr.t("common.field.phone"), contact.phone ?? "—"],
          [tr.t("common.field.note"), contact.note ?? "—"],
          [
            tLocal(ctx.locale, "registrySynced"),
            contact.registryFetchedAt !== null
              ? Format.formatDateTime(ctx.locale, contact.registryFetchedAt)
              : "—",
          ],
        ]),
      ]),
      card(h, [
        cardTitle(h, tr.t("contacts.detail.billingDefaults")),
        dl(h, [
          [
            tr.t("contacts.editor.defaults.currency"),
            h.div
              .class("kb-row")
              .children([
                h.strong.children([resolvedBilling.currency.value]),
                sourceBadge(resolvedBilling.currency.source),
              ]),
          ],
          [
            tr.t("contacts.editor.defaults.language"),
            h.div
              .class("kb-row")
              .children([
                h.strong.children([enumLabel(tr, "locale", resolvedBilling.language.value)]),
                sourceBadge(resolvedBilling.language.source),
              ]),
          ],
          [
            tr.t("contacts.editor.defaults.dueDays"),
            h.div
              .class("kb-row")
              .children([
                h.strong
                  .class("kb-num")
                  .children([
                    tLocal(ctx.locale, "daysUnit", { days: resolvedBilling.dueDays.value }),
                  ]),
                sourceBadge(resolvedBilling.dueDays.source),
              ]),
          ],
          [
            tr.t("contacts.editor.defaults.paymentMethod"),
            h.div
              .class("kb-row")
              .children([
                h.strong.children([
                  enumLabel(tr, "paymentMethod", resolvedBilling.paymentMethod.value),
                ]),
                sourceBadge(resolvedBilling.paymentMethod.source),
              ]),
          ],
          [
            tr.t("contacts.editor.defaults.reminders"),
            h.div.class("kb-row").children([
              h.strong.children([
                contact.defaults.reminderPolicy?.mode === "disabled"
                  ? tLocal(ctx.locale, "remindersDisabled")
                  : resolvedReminders.source === "contact"
                    ? tLocal(ctx.locale, "remindersCustom", {
                        offsets: Arr.join(Arr.map(resolvedReminders.value, String), ", "),
                      })
                    : tLocal(ctx.locale, "remindersInherit"),
              ]),
              sourceBadge(resolvedReminders.source),
            ]),
          ],
        ]),
      ]),
    ]),
    card(h, [
      cardTitle(h, tr.t("contacts.detail.documents")),
      docs.length === 0
        ? h.p.class("kb-muted").children([tLocal(ctx.locale, "noDocuments")])
        : table(h, {
            caption: tr.t("contacts.detail.documents"),
            rows: docs,
            rowKey: (d) => d.id,
            columns: [
              {
                header: tLocal(ctx.locale, "docNumber"),
                cell: (d) =>
                  h.a
                    .attr(
                      "href",
                      href({
                        _tag: "Document",
                        ws: route.ws,
                        id: DocumentId.make(d.id),
                        tab: "preview",
                      }),
                    )
                    .children([mono(h, d.number ?? Str.slice(0, 8)(d.id))]),
              },
              {
                header: tLocal(ctx.locale, "docDate"),
                cell: (d) => dateText(ctx.locale, d.issuedOn),
              },
              {
                header: tLocal(ctx.locale, "docStatus"),
                cell: (d) => badge(h, d.settlement, "neutral"),
              },
              {
                header: tLocal(ctx.locale, "docTotal"),
                align: "end",
                numeric: true,
                cell: (d) => moneyText(ctx.locale, d.totalAmount, d.currency),
              },
            ],
          }),
    ]),
    card(h, [
      cardTitle(h, tr.t("contacts.detail.expenses")),
      expenses.length === 0
        ? h.p.class("kb-muted").children([tLocal(ctx.locale, "noExpenses")])
        : table(h, {
            caption: tr.t("contacts.detail.expenses"),
            rows: expenses,
            rowKey: (ex) => ex.id,
            columns: [
              {
                header: tLocal(ctx.locale, "docNumber"),
                cell: (ex) =>
                  h.a
                    .attr(
                      "href",
                      href({
                        _tag: "Expense",
                        ws: route.ws,
                        id: ExpenseId.make(ex.id),
                        mode: "view",
                      }),
                    )
                    .children([mono(h, ex.supplierDocumentNumber ?? Str.slice(0, 8)(ex.id))]),
              },
              {
                header: tLocal(ctx.locale, "docDate"),
                cell: (ex) => dateText(ctx.locale, ex.issuedOn),
              },
              {
                header: tLocal(ctx.locale, "docStatus"),
                cell: (ex) =>
                  badge(
                    h,
                    enumLabel(tr, "settlement", ex.settlement),
                    settlementTone(ex.settlement),
                  ),
              },
              {
                header: tLocal(ctx.locale, "docTotal"),
                align: "end",
                numeric: true,
                cell: (ex) =>
                  ex.total !== null && ex.currency !== null
                    ? moneyText(ctx.locale, ex.total, ex.currency)
                    : "—",
              },
            ],
          }),
    ]),
    model.confirmArchive
      ? dialog(h, {
          id: "contact-archive-dialog",
          title: tLocal(ctx.locale, "archiveTitle"),
          onClose: Message.CancelledArchive(),
          body: [h.p.children([tLocal(ctx.locale, "archiveBody", { name: contact.name })])],
          actions: [
            button(h, {
              label: tr.t("common.action.cancel"),
              onClick: Message.CancelledArchive(),
            }),
            button(h, {
              label: tr.t("common.action.archive"),
              variant: "danger",
              busy: model.archiving,
              onClick: Message.ConfirmedArchive(),
            }),
          ],
        })
      : h.text(""),
  ]);
});
