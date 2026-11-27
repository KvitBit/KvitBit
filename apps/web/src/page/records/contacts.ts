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
import type {
  ContactId,
  ContactInput,
  CurrencyCode,
  PaymentMethod,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Format, ViewModels } from "@kvitbit/ui-port";
import { Option, Result, Schema } from "effect";
import { Failure, request } from "../../app/api";
import type { PageCommand } from "../../app/commands";
import { copy, textOf, translator } from "../../app/i18n";
import { Intent_ } from "../../app/intent";
import type { MessageHandlers, PageContext, PageReturn, RouteOf } from "../../app/page";
import * as Remote from "../../app/remote";
import { href } from "../../app/routing";
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
  searchInput,
  selectField,
  skeleton,
  skeletonTable,
  table,
  textArea,
  textField,
  toggleChip,
} from "../../ui/kit";
import { cn, ui } from "../../ui/styles";
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

export type Route = RouteOf<"Contacts" | "Contact">;

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
  route: ViewModels.Route,
  search: Schema.String,
  roleFilter: Schema.NullOr(Schema.Literals(["customer", "supplier"])),
  showArchived: Schema.Boolean,
  list: Remote.remoteSchema(Schema.Array(ContactRecord)),
  detail: Remote.remoteSchema(ContactRecord),
  relatedDocs: Remote.remoteSchema(Schema.Array(RelatedDocumentRecord)),
  relatedExpenses: Remote.remoteSchema(Schema.Array(ExpenseSummaryRecord)),
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
  PastedEditorAddress: {
    street: Schema.String,
    city: Schema.String,
    postalCode: Schema.String,
    country: Schema.String,
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
    "ContactsSearch",
    request(
      (client) =>
        client.contacts.search({
          params: { workspaceId: workspaceId as WorkspaceId },
          query: {
            ...(text.trim() === "" ? {} : { text: text.trim() }),
            ...(role === null ? {} : { role }),
          },
        }),
      (pageRes): Message =>
        Message.LoadedList({ seq, contacts: pageRes.items.map(normalizeContact) }),
      (failure): Message => Message.FailedList({ seq, failure }),
    ),
  );

const loadDetailCommand = (
  workspaceId: string,
  contactId: string,
  seq: number,
): PageCommand<Message> =>
  apiCommand(
    "ContactsGet",
    request(
      (client) =>
        client.contacts.get({
          params: {
            workspaceId: workspaceId as WorkspaceId,
            contactId: contactId as ContactId,
          },
        }),
      (raw): Message => Message.LoadedDetail({ seq, contact: normalizeContact(raw) }),
      (failure): Message => Message.FailedDetail({ seq, failure }),
    ),
  );

const loadRelatedDocsCommand = (
  workspaceId: string,
  contactId: string,
  seq: number,
): PageCommand<Message> =>
  apiCommand(
    "ContactsRelatedDocs",
    request(
      (client) =>
        client.documents.list({
          params: { workspaceId: workspaceId as WorkspaceId },
          query: { contact: contactId as ContactId, limit: 10 },
        }),
      (pageRes): Message =>
        Message.LoadedRelatedDocs({
          seq,
          docs: pageRes.items.map((item) => {
            const r = item as unknown as Record<string, unknown>;
            const totals = (r.totals as Record<string, unknown> | undefined) ?? {};
            const gross = (totals.gross as Record<string, unknown> | undefined) ?? {};
            const dates = (r.dates as Record<string, unknown> | undefined) ?? {};
            return {
              id: typeof r.id === "string" ? r.id : "",
              number: typeof r.number === "string" ? r.number : null,
              kind: typeof r.kind === "string" ? r.kind : "invoice",
              status: typeof r.status === "string" ? r.status : "issued",
              settlement: typeof r.settlement === "string" ? r.settlement : "unpaid",
              issuedOn: typeof dates.issuedOn === "string" ? dates.issuedOn : null,
              totalAmount: decimalToString(gross.amount),
              currency: typeof gross.currency === "string" ? gross.currency : "CZK",
            };
          }),
        }),
      (failure): Message => Message.FailedRelatedDocs({ seq, failure }),
    ),
  );

const loadRelatedExpensesCommand = (workspaceId: string, seq: number): PageCommand<Message> =>
  apiCommand(
    "ContactsRelatedExpenses",
    request(
      (client) =>
        client.expenses.list({
          params: { workspaceId: workspaceId as WorkspaceId },
          query: { limit: 25 },
        }),
      (pageRes): Message =>
        Message.LoadedRelatedExpenses({
          seq,
          expenses: pageRes.items.map(normalizeExpenseSummary),
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
    "ContactsLookupAres",
    request(
      (client) =>
        client.contacts.fromIco({
          params: { workspaceId: workspaceId as WorkspaceId },
          payload: { ico, ...(role !== undefined ? { role } : {}) },
        }),
      (raw): Message => Message.LoadedAresLookup({ seq, contact: normalizeContact(raw) }),
      (failure): Message => Message.FailedAresLookup({ seq, failure }),
    ),
  );

const refreshAresCommand = (workspaceId: string, ico: string): PageCommand<Message> =>
  apiCommand(
    "ContactsRefreshAres",
    request(
      (client) =>
        client.contacts.fromIco({
          params: { workspaceId: workspaceId as WorkspaceId },
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
  const offsets = ed.reminderOffsets
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0);

  const defaults: Record<string, unknown> = {
    ...(ed.currencyOverride !== "" ? { currency: ed.currencyOverride } : {}),
    ...(ed.languageOverride === "cs" || ed.languageOverride === "en"
      ? { language: ed.languageOverride }
      : {}),
    ...(Option.isSome(dueDaysOpt) ? { dueDays: dueDaysOpt.value } : {}),
    ...(ed.paymentMethodOverride !== "" ? { paymentMethod: ed.paymentMethodOverride } : {}),
    ...(ed.defaultNoteOverride.trim() !== "" ? { defaultNote: ed.defaultNoteOverride.trim() } : {}),
    reminderPolicy:
      ed.reminderMode === "disabled"
        ? { mode: "disabled" }
        : ed.reminderMode === "custom"
          ? { mode: "custom", offsetsDays: offsets }
          : { mode: "inherit" },
  };

  return {
    roles: roles.length > 0 ? roles : ["customer"],
    name: ed.name.trim(),
    ico: ed.ico.trim() === "" ? null : Format.normalizeIco(ed.ico),
    dic: ed.dic.trim() === "" ? null : Format.normalizeVatId(ed.dic),
    legalForm: ed.legalForm.trim() === "" ? null : ed.legalForm.trim(),
    address: {
      street: ed.street.trim() === "" ? null : ed.street.trim(),
      city: ed.city.trim() === "" ? null : ed.city.trim(),
      postalCode: ed.postalCode.trim() === "" ? null : ed.postalCode.trim(),
      country: (ed.country.trim() || "CZ").toUpperCase().slice(0, 2),
    },
    billingEmails: ed.billingEmails.map((e) => e.trim()).filter((e) => e !== ""),
    phone: ed.phone.trim() === "" ? null : ed.phone.trim(),
    note: ed.note.trim() === "" ? null : ed.note.trim(),
    defaults,
  } as unknown as ContactInput;
};

const saveContactCommand = (workspaceId: string, ed: ContactEditor): PageCommand<Message> => {
  const payload = buildContactPayload(ed);
  return apiCommand(
    "ContactsSave",
    request(
      (client) =>
        ed.id === null
          ? client.contacts.create({
              params: { workspaceId: workspaceId as WorkspaceId },
              headers: { "idempotency-key": ed.idempotencyKey },
              payload,
            })
          : client.contacts.update({
              params: {
                workspaceId: workspaceId as WorkspaceId,
                contactId: ed.id as ContactId,
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
    "ContactsArchive",
    request(
      (client) =>
        client.contacts.archive({
          params: {
            workspaceId: workspaceId as WorkspaceId,
            contactId: contactId as ContactId,
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
  const rp = c.defaults.reminderPolicy;
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
    reminderMode: rp?.mode ?? "inherit",
    reminderOffsets: rp?.mode === "custom" ? rp.offsetsDays.join(", ") : "7, 14",
    idempotencyKey: newIdempotencyKey("cnt"),
    saving: false,
    error: null,
  };
};

// --- Init & Update -------------------------------------------------------------------------------

export const init = (route: Route, ctx: PageContext): PageReturn<Model, Message> => {
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
};

export const update = (
  model: Model,
  message: Message,
  ctx: PageContext,
): PageReturn<Model, Message> => {
  const tr = translator(ctx.locale);
  const route = model.route as Route;
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

    PastedEditorAddress: ({ street, city, postalCode, country }) => {
      if (model.editor === null) return { model };
      return {
        model: {
          ...model,
          editor: {
            ...model.editor,
            street,
            city,
            postalCode,
            country,
            error: null,
            aresError: null,
          },
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
      const next = model.editor.billingEmails.map((e, i) => (i === index ? value : e));
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
      const next = model.editor.billingEmails.filter((_, i) => i !== index);
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
      if (model.editor.name.trim() === "") {
        return {
          model: {
            ...model,
            editor: { ...model.editor, error: tLocal(ctx.locale, "nameRequired") },
          },
        };
      }
      if (!model.editor.isCustomer && !model.editor.isSupplier) {
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
          id: contact.id as ContactId,
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
};

export const title = (model: Model, ctx: PageContext): string => {
  const tr = translator(ctx.locale);
  const route = model.route as Route;
  if (route._tag === "Contacts") return tr.t("contacts.list.title");
  if (route.id === "new") return tr.t("contacts.list.new");
  const detail = Remote.dataOf(model.detail);
  return detail?.name ?? tr.t("contacts.editor.title");
};

// --- View ----------------------------------------------------------------------------------------

export const view = (model: Model, ctx: PageContext, h: Html.H<Message>) => {
  const tr = translator(ctx.locale);
  const route = model.route as Route;
  const writable = canWrite(ctx);

  // --- List view ---
  if (route._tag === "Contacts") {
    const rawContacts = Remote.dataOf(model.list);
    const visibleContacts =
      rawContacts === undefined
        ? undefined
        : model.showArchived
          ? rawContacts
          : rawContacts.filter((c) => !c.archived);

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
        return emptyState(h, {
          title: tr.t("contacts.list.empty.title"),
          body: tr.t("contacts.list.empty.body"),
          ...(writable
            ? {
                action: linkButton(h, {
                  label: tr.t("contacts.list.empty.cta"),
                  href: href({ _tag: "Contact", ws: route.ws, id: "new", mode: "edit" }),
                  variant: "primary",
                }),
              }
            : {}),
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
                .class(cn(ui.stack, c.archived && "opacity-65"))
                .style({ "--kb-gap": "2px" })
                .children([
                  h.a
                    .attr(
                      "href",
                      href({
                        _tag: "Contact",
                        ws: route.ws,
                        id: c.id as ContactId,
                        mode: "view",
                      }),
                    )
                    .children([h.strong.children([c.name])]),
                  ...(c.legalForm !== null
                    ? [h.span.class(cn(ui.small, ui.muted)).children([c.legalForm])]
                    : []),
                ]),
          },
          {
            header: tLocal(ctx.locale, "colRoles"),
            cell: (c) =>
              h.div
                .class(ui.row)
                .children([
                  ...c.roles.map((r) =>
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
                .class(ui.stack)
                .style({ "--kb-gap": "2px" })
                .children([
                  c.ico !== null ? mono(h, c.ico) : h.span.class(ui.muted).children(["—"]),
                  ...(c.dic !== null
                    ? [h.span.class(cn(ui.small, ui.mono, ui.muted)).children([c.dic])]
                    : []),
                ]),
          },
          {
            header: tLocal(ctx.locale, "colLocation"),
            cell: (c) =>
              h.span
                .class(ui.muted)
                .children([
                  [c.address.city, c.address.country]
                    .filter((x) => x !== null && x !== "")
                    .join(", ") || "—",
                ]),
          },
          {
            header: tLocal(ctx.locale, "colEmail"),
            cell: (c) => h.span.class(ui.muted).children([c.billingEmails[0] ?? "—"]),
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
      h.div
        .attr("data-slot", "rec-toolbar")
        .class("flex flex-wrap items-center justify-between gap-3")
        .children([
          h.div.class("relative max-w-[380px] flex-[1_1_240px]").children([
            h.span
              .class(
                "pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant",
              )
              .children([icon(h, "search", 16)]),
            searchInput(h, {
              value: model.search,
              placeholder: tr.t("contacts.list.search"),
              ariaLabel: tr.t("contacts.list.search"),
              inputClassName: "pl-[34px]",
              onInput: (value) => Message.ChangedSearch({ value }),
            }),
          ]),
          h.div.class("flex flex-wrap items-center gap-1.5").children([
            toggleChip(h, {
              label: tLocal(ctx.locale, "allRoles"),
              pressed: model.roleFilter === null,
              onPress: Message.SelectedRoleFilter({ role: null }),
            }),
            toggleChip(h, {
              label: tLocal(ctx.locale, "customers"),
              pressed: model.roleFilter === "customer",
              onPress: Message.SelectedRoleFilter({ role: "customer" }),
            }),
            toggleChip(h, {
              label: tLocal(ctx.locale, "suppliers"),
              pressed: model.roleFilter === "supplier",
              onPress: Message.SelectedRoleFilter({ role: "supplier" }),
            }),
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
    const pasteAddress = (field: Format.AddressField) => (text: string) => {
      const next = Format.applyAddressPaste(
        { street: ed.street, city: ed.city, postalCode: ed.postalCode, country: ed.country },
        field,
        text,
        { defaultCountry: "CZ" },
      );
      return next === undefined ? undefined : Message.PastedEditorAddress(next);
    };

    return page(h, [
      pageHeader(h, {
        title:
          route.id === "new" ? tr.t("contacts.list.new") : ed.name || tr.t("contacts.editor.title"),
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
        h.p.class(cn(ui.small, ui.muted)).children([tr.t("contacts.editor.icoFirst")]),
        ...(ed.aresError !== null ? [banner(h, { text: ed.aresError, tone: "error" })] : []),
        h.div.class("flex items-end gap-2 [&>[data-slot=field]]:flex-1").children([
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
        .class(ui.stack)
        .on("submit", Message.SubmittedEditor(), { preventDefault: true })
        .children([
          ...(ed.error !== null ? [banner(h, { text: ed.error, tone: "error" })] : []),
          card(h, [
            cardTitle(h, tr.t("contacts.detail.particulars")),
            h.div.class(ui.row).children([
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
            h.div
              .attr("data-slot", "form-grid")
              .class(ui.formGrid)
              .children([
                h.div.class("col-span-full").children([
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
                  onPaste: pasteAddress("street"),
                }),
                textField(h, {
                  id: "contact-city",
                  label: tr.t("common.field.city"),
                  value: ed.city,
                  onInput: (value) => Message.ChangedEditorField({ field: "city", value }),
                  onPaste: pasteAddress("city"),
                }),
                textField(h, {
                  id: "contact-postal",
                  label: tr.t("common.field.postalCode"),
                  value: ed.postalCode,
                  mono: true,
                  onInput: (value) => Message.ChangedEditorField({ field: "postalCode", value }),
                  onPaste: pasteAddress("postalCode"),
                }),
                textField(h, {
                  id: "contact-country",
                  label: tr.t("common.field.country"),
                  value: ed.country,
                  mono: true,
                  onInput: (value) => Message.ChangedEditorField({ field: "country", value }),
                  onPaste: pasteAddress("country"),
                }),
              ]),
            h.div.class(ui.stack).children([
              h.span.class(ui.fieldLabel).children([tr.t("contacts.editor.invoicingEmails")]),
              h.div.class("flex flex-col gap-2").children(
                ed.billingEmails.map((email, idx) =>
                  h.div.class("flex items-end gap-2 [&>[data-slot=field]]:flex-1").children([
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
              h.div.class(ui.row).children([
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
            h.p.class(cn(ui.small, ui.muted)).children([tr.t("contacts.editor.defaults.intro")]),
            h.div
              .class(
                "grid grid-cols-1 items-center gap-2.5 border-b border-outline-variant py-2.5 last:border-b-0 sm:grid-cols-[minmax(140px,1fr)_minmax(0,1.4fr)_auto]",
              )
              .children([
                h.div
                  .class("flex flex-col gap-0.5")
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
                    ...CURRENCIES.map((c) => ({ value: c, label: c })),
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
            h.div
              .class(
                "grid grid-cols-1 items-center gap-2.5 border-b border-outline-variant py-2.5 last:border-b-0 sm:grid-cols-[minmax(140px,1fr)_minmax(0,1.4fr)_auto]",
              )
              .children([
                h.div
                  .class("flex flex-col gap-0.5")
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
            h.div
              .class(
                "grid grid-cols-1 items-center gap-2.5 border-b border-outline-variant py-2.5 last:border-b-0 sm:grid-cols-[minmax(140px,1fr)_minmax(0,1.4fr)_auto]",
              )
              .children([
                h.div
                  .class("flex flex-col gap-0.5")
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
                  onInput: (value) =>
                    Message.ChangedEditorField({ field: "dueDaysOverride", value }),
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
            h.div
              .class(
                "grid grid-cols-1 items-center gap-2.5 border-b border-outline-variant py-2.5 last:border-b-0 sm:grid-cols-[minmax(140px,1fr)_minmax(0,1.4fr)_auto]",
              )
              .children([
                h.div
                  .class("flex flex-col gap-0.5")
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
                    ...PAYMENT_METHODS.map((pm) => ({
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
            h.div
              .class(
                "grid grid-cols-1 items-center gap-2.5 border-b border-outline-variant py-2.5 last:border-b-0 sm:grid-cols-[minmax(140px,1fr)_minmax(0,1.4fr)_auto]",
              )
              .children([
                h.div
                  .class("flex flex-col gap-0.5")
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
                h.div.class(ui.stack).children([
                  selectField(h, {
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
                        mode: value as "inherit" | "disabled" | "custom",
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
      currency: "CZK" as CurrencyCode,
      language: "cs",
      dueDays: 14,
      paymentMethod: "bank_transfer" as PaymentMethod,
    },
  });
  const resolvedReminders = ViewModels.resolveReminders(
    toDomainContactDefaults(contact.defaults).reminderPolicy,
    [7, 14],
  );

  const docs = Remote.dataOf(model.relatedDocs) ?? [];
  const expenses = (Remote.dataOf(model.relatedExpenses) ?? []).filter(
    (ex) =>
      ex.supplierName !== null && ex.supplierName.toLowerCase() === contact.name.toLowerCase(),
  );

  const sourceBadge = (source: ViewModels.SettingSource) =>
    badge(h, enumLabel(tr, "settingSource", source), source === "contact" ? "proforma" : "neutral");

  const addressLine = [
    contact.address.street,
    [contact.address.postalCode, contact.address.city].filter(Boolean).join(" "),
    contact.address.country,
  ]
    .filter((p) => p !== null && p !== "")
    .join(", ");

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
                  from: { _tag: "Contact", id: contact.id as ContactId },
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
                  id: contact.id as ContactId,
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
      .class(ui.row)
      .children([
        ...contact.roles.map((r) =>
          badge(h, enumLabel(tr, "contactRole", r), r === "customer" ? "proforma" : "neutral"),
        ),
        ...(contact.archived
          ? [badge(h, ctx.locale === "cs" ? "Archivovaný" : "Archived", "outline")]
          : []),
      ]),
    h.div
      .class("grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(280px,1fr)]")
      .children([
        card(h, [
          cardTitle(h, tr.t("contacts.detail.particulars")),
          dl(h, [
            [tr.t("common.field.ico"), contact.ico !== null ? mono(h, contact.ico) : "—"],
            [tr.t("common.field.dic"), contact.dic !== null ? mono(h, contact.dic) : "—"],
            [tLocal(ctx.locale, "legalForm"), contact.legalForm ?? "—"],
            [tr.t("common.field.address"), addressLine || "—"],
            [
              tr.t("contacts.editor.invoicingEmails"),
              contact.billingEmails.length > 0 ? contact.billingEmails.join(", ") : "—",
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
                .class(ui.row)
                .children([
                  h.strong.children([resolvedBilling.currency.value]),
                  sourceBadge(resolvedBilling.currency.source),
                ]),
            ],
            [
              tr.t("contacts.editor.defaults.language"),
              h.div
                .class(ui.row)
                .children([
                  h.strong.children([enumLabel(tr, "locale", resolvedBilling.language.value)]),
                  sourceBadge(resolvedBilling.language.source),
                ]),
            ],
            [
              tr.t("contacts.editor.defaults.dueDays"),
              h.div
                .class(ui.row)
                .children([
                  h.strong
                    .class(ui.num)
                    .children([
                      tLocal(ctx.locale, "daysUnit", { days: resolvedBilling.dueDays.value }),
                    ]),
                  sourceBadge(resolvedBilling.dueDays.source),
                ]),
            ],
            [
              tr.t("contacts.editor.defaults.paymentMethod"),
              h.div
                .class(ui.row)
                .children([
                  h.strong.children([
                    enumLabel(tr, "paymentMethod", resolvedBilling.paymentMethod.value),
                  ]),
                  sourceBadge(resolvedBilling.paymentMethod.source),
                ]),
            ],
            [
              tr.t("contacts.editor.defaults.reminders"),
              h.div.class(ui.row).children([
                h.strong.children([
                  contact.defaults.reminderPolicy?.mode === "disabled"
                    ? tLocal(ctx.locale, "remindersDisabled")
                    : resolvedReminders.source === "contact"
                      ? tLocal(ctx.locale, "remindersCustom", {
                          offsets: resolvedReminders.value.join(", "),
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
        ? h.p.class(ui.muted).children([tLocal(ctx.locale, "noDocuments")])
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
                        id: d.id as never,
                        tab: "preview",
                      }),
                    )
                    .children([mono(h, d.number ?? d.id.slice(0, 8))]),
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
        ? h.p.class(ui.muted).children([tLocal(ctx.locale, "noExpenses")])
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
                        id: ex.id as never,
                        mode: "view",
                      }),
                    )
                    .children([mono(h, ex.supplierDocumentNumber ?? ex.id.slice(0, 8))]),
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
          alert: true,
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
};
