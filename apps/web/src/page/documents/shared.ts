import type { Html } from "@effect/ui/html";
/**
 * Private shared schemas, decoders, formatting and Command helpers for src/page/documents/*.
 * Mirrors the concrete wire shapes produced by @kvitbit/core behind @kvitbit/domain placeholders.
 */
import {
  BankAccountId,
  ContactDefaults,
  ContactId,
  CurrencyCode,
  DocumentId,
  DocumentKind,
  DocumentSettlement,
  DocumentStatus,
  type DocumentView,
  IsoDate,
  IssueCode,
  LineId,
  Locale,
  Money,
  PaymentId,
  PaymentMethod,
  PriceListItemId,
  type Role,
  ScheduleId,
  TaxRegime,
  TemplateId,
  TemplateInput,
  VatTreatment,
  WorkspaceId,
} from "@kvitbit/domain";
import { Api, Format, I18n, type ViewModels } from "@kvitbit/ui-port";
import { BigDecimal, Effect, Option, Schema } from "effect";
import { type Client, type Failure, request } from "../../app/api";
import { browserCommand, type PageCommand, apiCommand as runApi } from "../../app/commands";
import { type Copy, copy, textOf, translator } from "../../app/i18n";
import type { Locale as AppLocale } from "../../app/prefs";
import type { Markup } from "../../ui/html";
import { type BadgeTone, badge } from "../../ui/kit";

// --- Concrete wire schemas for domain placeholders -----------------------------------------------

const NullableText = Schema.NullOr(Schema.String);

export const AddressData = Schema.Struct({
  street: NullableText,
  city: NullableText,
  postalCode: NullableText,
  country: Schema.String,
});
export type AddressData = typeof AddressData.Type;

export const ContactSnapshotData = Schema.Struct({
  contactId: ContactId,
  name: Schema.String,
  ico: NullableText,
  dic: NullableText,
  legalForm: NullableText,
  address: AddressData,
  billingEmails: Schema.Array(Schema.String),
});
export type ContactSnapshotData = typeof ContactSnapshotData.Type;

export const BankAccountData = Schema.Struct({
  id: BankAccountId,
  name: NullableText,
  currency: CurrencyCode,
  accountNumber: NullableText,
  iban: NullableText,
  bic: NullableText,
  isDefault: Schema.optionalKey(Schema.Boolean),
});
export type BankAccountData = typeof BankAccountData.Type;

export const IssuerSnapshotData = Schema.Struct({
  workspaceId: WorkspaceId,
  name: Schema.String,
  ico: NullableText,
  dic: NullableText,
  address: AddressData,
  registerEntry: NullableText,
  email: NullableText,
  phone: NullableText,
  web: NullableText,
  regime: TaxRegime,
  bankAccount: Schema.NullOr(BankAccountData),
});
export type IssuerSnapshotData = typeof IssuerSnapshotData.Type;

export const LineViewData = Schema.Struct({
  id: LineId,
  item: Schema.NullOr(PriceListItemId),
  description: Schema.String,
  quantity: Schema.BigDecimal,
  unit: NullableText,
  unitPrice: Schema.BigDecimal,
  treatment: VatTreatment,
  ratePercent: Schema.BigDecimal,
  amount: Schema.BigDecimal,
  deducts: Schema.NullOr(DocumentId),
});
export type LineViewData = typeof LineViewData.Type;

export const DocumentSummaryData = Schema.Struct({
  id: DocumentId,
  kind: DocumentKind,
  number: NullableText,
  status: DocumentStatus,
  locked: Schema.Boolean,
  settlement: DocumentSettlement,
  overdue: Schema.Boolean,
  revision: Schema.Int,
  contact: Schema.Struct({ id: ContactId, name: Schema.String }),
  issuedOn: IsoDate,
  dueOn: IsoDate,
  total: Money,
});
export type DocumentSummaryData = typeof DocumentSummaryData.Type;

export const PaymentViewData = Schema.Struct({
  id: PaymentId,
  revision: Schema.Int,
  target: Schema.Union([
    Schema.Struct({ document: DocumentId }),
    Schema.Struct({ expense: Schema.String }),
  ]),
  amount: Money,
  paidOn: IsoDate,
  method: PaymentMethod,
  note: NullableText,
  taxDocument: Schema.NullOr(DocumentId),
  createdAt: Schema.String,
});
export type PaymentViewData = typeof PaymentViewData.Type;

export const ContactOptionData = Schema.Struct({
  id: ContactId,
  roles: Schema.Array(Schema.Literals(["customer", "supplier"])),
  name: Schema.String,
  ico: NullableText,
  dic: NullableText,
  legalForm: NullableText,
  address: AddressData,
  billingEmails: Schema.Array(Schema.String),
  phone: NullableText,
  note: NullableText,
  defaults: ContactDefaults,
  archived: Schema.Boolean,
  revision: Schema.Int,
});
export type ContactOptionData = typeof ContactOptionData.Type;

export const PriceListOptionData = Schema.Struct({
  id: PriceListItemId,
  name: Schema.String,
  description: NullableText,
  unit: NullableText,
  unitPrice: Schema.BigDecimal,
  currency: CurrencyCode,
  vat: Schema.NullOr(VatTreatment),
  archived: Schema.Boolean,
  revision: Schema.Int,
});
export type PriceListOptionData = typeof PriceListOptionData.Type;

export const ScheduleViewData = Schema.Struct({
  id: ScheduleId,
  every: Schema.Union([
    Schema.Struct({ weeks: Schema.Int }),
    Schema.Struct({ months: Schema.Int }),
    Schema.Struct({ years: Schema.Int }),
  ]),
  startOn: IsoDate,
  endOn: Schema.NullOr(IsoDate),
  issueAs: Schema.Literals(["invoice", "proforma"]),
  autoSend: Schema.Boolean,
  nextOccurrence: Schema.NullOr(IsoDate),
  paused: Schema.Boolean,
  pausedReason: Schema.NullOr(IssueCode),
  pausedError: NullableText,
});
export type ScheduleViewData = typeof ScheduleViewData.Type;

export const TemplateViewData = Schema.Struct({
  id: TemplateId,
  name: Schema.String,
  revision: Schema.Int,
  archived: Schema.Boolean,
  input: TemplateInput,
  schedule: Schema.NullOr(ScheduleViewData),
});
export type TemplateViewData = typeof TemplateViewData.Type;

export const WorkspaceDefaultsData = Schema.Struct({
  currency: CurrencyCode,
  language: Locale,
  dueDays: Schema.Int,
  paymentMethod: PaymentMethod,
  defaultNote: NullableText,
  paymentRounding: Schema.Literals(["none", "whole_unit"]),
  paymentTaxDocumentAutoSend: Schema.Boolean,
});
export type WorkspaceDefaultsData = typeof WorkspaceDefaultsData.Type;

export const WorkspaceInfoData = Schema.Struct({
  slug: Schema.String,
  name: Schema.optionalKey(Schema.String),
  revision: Schema.Int,
  defaults: Schema.optionalKey(WorkspaceDefaultsData),
});
export type WorkspaceInfoData = typeof WorkspaceInfoData.Type;

// --- Safe runtime decoders for opaque domain placeholders ----------------------------------------

const decodeSummary = Schema.decodeUnknownOption(DocumentSummaryData);
const decodeContactSnapshot = Schema.decodeUnknownOption(ContactSnapshotData);
const decodeIssuerSnapshot = Schema.decodeUnknownOption(IssuerSnapshotData);
const decodeLineView = Schema.decodeUnknownOption(LineViewData);
const decodePayment = Schema.decodeUnknownOption(PaymentViewData);
const decodeContactOption = Schema.decodeUnknownOption(ContactOptionData);
const decodePriceListOption = Schema.decodeUnknownOption(PriceListOptionData);
const decodeBankAccount = Schema.decodeUnknownOption(BankAccountData);
const decodeTemplate = Schema.decodeUnknownOption(TemplateViewData);
const decodeWorkspaceInfo = Schema.decodeUnknownOption(WorkspaceInfoData);

export const readSummary = (raw: unknown): DocumentSummaryData | undefined =>
  Option.getOrUndefined(decodeSummary(raw));

export const readSummaries = (raw: ReadonlyArray<unknown>): ReadonlyArray<DocumentSummaryData> =>
  raw.flatMap((item) => {
    const decoded = readSummary(item);
    return decoded === undefined ? [] : [decoded];
  });

export const readContactSnapshot = (raw: unknown): ContactSnapshotData | undefined =>
  Option.getOrUndefined(decodeContactSnapshot(raw));

export const readIssuerSnapshot = (raw: unknown): IssuerSnapshotData | undefined =>
  Option.getOrUndefined(decodeIssuerSnapshot(raw));

export const readLines = (raw: ReadonlyArray<unknown>): ReadonlyArray<LineViewData> =>
  raw.flatMap((item) => {
    const decoded = Option.getOrUndefined(decodeLineView(item));
    return decoded === undefined ? [] : [decoded];
  });

export const readPayments = (raw: ReadonlyArray<unknown>): ReadonlyArray<PaymentViewData> =>
  raw.flatMap((item) => {
    const decoded = Option.getOrUndefined(decodePayment(item));
    return decoded === undefined ? [] : [decoded];
  });

export const readContacts = (raw: ReadonlyArray<unknown>): ReadonlyArray<ContactOptionData> =>
  raw.flatMap((item) => {
    const decoded = Option.getOrUndefined(decodeContactOption(item));
    return decoded === undefined ? [] : [decoded];
  });

export const readContact = (raw: unknown): ContactOptionData | undefined =>
  Option.getOrUndefined(decodeContactOption(raw));

export const readPriceList = (raw: ReadonlyArray<unknown>): ReadonlyArray<PriceListOptionData> =>
  raw.flatMap((item) => {
    const decoded = Option.getOrUndefined(decodePriceListOption(item));
    return decoded === undefined ? [] : [decoded];
  });

export const readBankAccounts = (raw: ReadonlyArray<unknown>): ReadonlyArray<BankAccountData> =>
  raw.flatMap((item) => {
    const decoded = Option.getOrUndefined(decodeBankAccount(item));
    return decoded === undefined ? [] : [decoded];
  });

export const readTemplate = (raw: unknown): TemplateViewData | undefined =>
  Option.getOrUndefined(decodeTemplate(raw));

export const readTemplates = (raw: ReadonlyArray<unknown>): ReadonlyArray<TemplateViewData> =>
  raw.flatMap((item) => {
    const decoded = readTemplate(item);
    return decoded === undefined ? [] : [decoded];
  });

export const readWorkspaceInfo = (raw: unknown): WorkspaceInfoData | undefined =>
  Option.getOrUndefined(decodeWorkspaceInfo(raw));

// --- Dates & Decimals ----------------------------------------------------------------------------

const isoDateCodec = Schema.decodeUnknownSync(IsoDate);

export const todayPrague = (): IsoDate => {
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Prague",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return isoDateCodec(formatted);
};

export const addDaysIso = (iso: IsoDate, days: number): IsoDate => {
  const parts = iso.split("-").map(Number);
  const d = new Date(Date.UTC(parts[0] ?? 2026, (parts[1] ?? 1) - 1, (parts[2] ?? 1) + days));
  const y = String(d.getUTCFullYear()).padStart(4, "0");
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return isoDateCodec(`${y}-${m}-${day}`);
};

export const yearPeriodOf = (today: IsoDate): { readonly from: IsoDate; readonly to: IsoDate } => {
  const year = today.slice(0, 4);
  return { from: isoDateCodec(`${year}-01-01`), to: today };
};

export const isIsoDateString = (s: string): s is IsoDate =>
  Option.isSome(Schema.decodeUnknownOption(IsoDate)(s));

export const parseDecimalText = (raw: string): BigDecimal.BigDecimal | undefined => {
  const cleaned = raw.trim().replace(/\s+/g, "").replace(",", ".");
  if (cleaned === "" || !/^-?\d+(?:\.\d+)?$/.test(cleaned)) return undefined;
  return Option.getOrUndefined(BigDecimal.fromString(cleaned));
};

export const decimalToInput = (bd: BigDecimal.BigDecimal): string =>
  BigDecimal.format(BigDecimal.normalize(bd));

export const fmtMoney = (locale: AppLocale, money: Money): string =>
  Format.moneyDisplay(locale, money).text;

export const fmtDate = (locale: AppLocale, iso: IsoDate): string => Format.formatDate(locale, iso);

export const fmtDateTime = (locale: AppLocale, iso: string): string =>
  Format.formatDateTime(locale, iso);

export const fmtNum = (locale: AppLocale, bd: BigDecimal.BigDecimal, maxFrac = 2): string =>
  Format.formatNumber(locale, bd, { minFractionDigits: 0, maxFractionDigits: maxFrac });

export const fmtVatRate = (locale: AppLocale, rate: BigDecimal.BigDecimal): string =>
  Format.formatVatRate(locale, Number(BigDecimal.format(rate)));

export const formatAddress = (addr: AddressData): string =>
  [addr.street, [addr.postalCode, addr.city].filter(Boolean).join(" "), addr.country]
    .filter((p) => p !== null && p !== "")
    .join(", ");

// --- Status & kind badges ------------------------------------------------------------------------

export const kindBadge = <M>(h: Html.H<M>, locale: AppLocale, kind: DocumentKind): Markup<M> => {
  const t = translator(locale);
  const label = textOf(t, I18n.enumText("documentKind", kind));
  const tone: BadgeTone = kind === "proforma" ? "proforma" : "outline";
  return badge(h, label, tone);
};

export const documentBadges = <M>(
  h: Html.H<M>,
  locale: AppLocale,
  doc: {
    readonly status: DocumentStatus;
    readonly settlement: DocumentSettlement;
    readonly overdue: boolean;
    readonly locked: boolean;
    readonly kind: DocumentKind;
  },
): ReadonlyArray<Markup<M>> => {
  const t = translator(locale);
  const out: Array<Markup<M>> = [];
  if (doc.status === "draft") {
    out.push(badge(h, textOf(t, I18n.enumText("badge", "draft")), "draft"));
  } else if (doc.status === "cancelled") {
    out.push(badge(h, textOf(t, I18n.enumText("badge", "cancelled")), "error"));
  } else if (doc.overdue) {
    out.push(badge(h, textOf(t, I18n.enumText("badge", "overdue")), "overdue"));
  } else if (doc.settlement === "paid" || doc.settlement === "overpaid") {
    out.push(badge(h, textOf(t, I18n.enumText("badge", "paid")), "paid"));
  } else if (doc.settlement === "partially_paid") {
    out.push(badge(h, textOf(t, I18n.enumText("badge", "partially_paid")), "proforma"));
  } else if (doc.settlement === "credited") {
    out.push(badge(h, textOf(t, I18n.enumText("badge", "credited")), "neutral"));
  } else {
    out.push(badge(h, textOf(t, I18n.enumText("badge", "issued")), "neutral"));
  }
  if (doc.locked) {
    out.push(badge(h, textOf(t, I18n.enumText("badge", "locked")), "outline"));
  }
  return out;
};

export const sourceBadge = <M>(
  h: Html.H<M>,
  locale: AppLocale,
  source: ViewModels.SettingSource,
): Markup<M> => {
  const t = translator(locale);
  const label = textOf(t, I18n.enumText("settingSource", source));
  const tone: BadgeTone =
    source === "document" ? "proforma" : source === "contact" ? "paid" : "outline";
  return badge(h, label, tone);
};

// --- Commands for browser-only side effects & idempotent writes ----------------------------------

export const apiCommand = <A, E, M>(
  name: string,
  call: (client: Client) => Effect.Effect<A, E>,
  onSuccess: (a: A) => M,
  onFailure: (f: Failure) => M,
): PageCommand<M> => runApi(name, request(call, onSuccess, onFailure));

export const copyTextCommand = <M>(text: string, onResult: (ok: boolean) => M): PageCommand<M> =>
  browserCommand(
    "CopyText",
    Effect.tryPromise({
      try: async () => {
        if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
          await navigator.clipboard.writeText(text);
          return true;
        }
        return false;
      },
      catch: () => false,
    }).pipe(
      Effect.map(onResult),
      Effect.catch(() => Effect.succeed(onResult(false))),
    ),
  );

export const withIdempotencyKey = <A, E, R>(
  fn: (headers: { readonly "idempotency-key": string }) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => Effect.flatMap(Api.uuidV7, (key) => fn(Api.idempotencyHeaders(key)));

export const idempotencyHeaders = (key: string): { readonly "idempotency-key": string } =>
  Api.idempotencyHeaders(key);

export const mintRequestKeyCommand = <M>(name: string, onKey: (key: string) => M): PageCommand<M> =>
  browserCommand(name, Api.uuidV7.pipe(Effect.map(onKey)));

export const delayCommand = <M>(name: string, ms: number, message: M): PageCommand<M> =>
  browserCommand(name, Effect.as(Effect.sleep(ms), message));

export type DocumentAction =
  | "document.read"
  | "document.pdf"
  | "document.history"
  | "document.draft"
  | "document.issue"
  | "document.edit"
  | "document.cancel"
  | "document.correct"
  | "document.finalInvoice"
  | "document.send"
  | "document.lock"
  | "document.unlock"
  | "document.overrideNumber"
  | "payment.write"
  | "share.write";

const WRITER_ROLES: ReadonlyArray<Role> = ["owner", "admin", "member"];
const MANAGER_ROLES: ReadonlyArray<Role> = ["owner", "admin"];
const ALL_ROLES: ReadonlyArray<Role> = ["owner", "admin", "member", "accountant"];

/** Canonical role × action policy matching core-ports 2.3 (packages/core/src/policy/table.ts). */
export const canRole = (role: Role | undefined, action: DocumentAction): boolean => {
  if (role === undefined) return false;
  switch (action) {
    case "document.read":
    case "document.pdf":
    case "document.history":
      return ALL_ROLES.includes(role);
    case "document.unlock":
    case "document.overrideNumber":
      return MANAGER_ROLES.includes(role);
    case "document.draft":
    case "document.issue":
    case "document.edit":
    case "document.cancel":
    case "document.correct":
    case "document.finalInvoice":
    case "document.send":
    case "document.lock":
    case "payment.write":
    case "share.write":
      return WRITER_ROLES.includes(role);
  }
};

export const ifMatch = (revision: number) => Api.ifMatchHeaders(revision);

export const documentHasFinalInvoice = (doc: DocumentView): boolean =>
  doc.related.some((r) => r.relation === "final_invoice_for");

export const sharedCopyTable: Copy<
  | "retry"
  | "cancel"
  | "save"
  | "close"
  | "back"
  | "loading"
  | "noWorkspace"
  | "copied"
  | "copyFailed"
> = {
  cs: {
    retry: "Zkusit znovu",
    cancel: "Zrušit",
    save: "Uložit",
    close: "Zavřít",
    back: "Zpět",
    loading: "Načítání…",
    noWorkspace: "Pracovní prostor nebyl nalezen.",
    copied: "Zkopírováno do schránky",
    copyFailed: "Nepodařilo se zkopírovat odkaz",
  },
  en: {
    retry: "Retry",
    cancel: "Cancel",
    save: "Save",
    close: "Close",
    back: "Back",
    loading: "Loading…",
    noWorkspace: "Workspace not found.",
    copied: "Copied to clipboard",
    copyFailed: "Could not copy link",
  },
};

export const sharedCopy = copy(sharedCopyTable);
