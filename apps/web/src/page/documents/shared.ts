import { Command } from "@effect/ui";
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
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { type Client, type Failure, request } from "../../app/api";
import { writeClipboard } from "../../app/browser";
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

const IssuerSnapshotData = Schema.Struct({
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

const WorkspaceDefaultsData = Schema.Struct({
  currency: CurrencyCode,
  language: Locale,
  dueDays: Schema.Int,
  paymentMethod: PaymentMethod,
  defaultNote: NullableText,
  paymentRounding: Schema.Literals(["none", "whole_unit"]),
  paymentTaxDocumentAutoSend: Schema.Boolean,
});

export const WorkspaceInfoData = Schema.Struct({
  slug: Schema.String,
  name: Schema.optionalKey(Schema.String),
  revision: Schema.Int,
  defaults: Schema.optionalKey(WorkspaceDefaultsData),
});
export type WorkspaceInfoData = typeof WorkspaceInfoData.Type;

// --- Safe runtime decoders for opaque domain placeholders ----------------------------------------

// Opaque API fields bypass nested schema decoding, so these amounts can still be wire strings.
const decodeWithWireAmounts = <A>(schema: Schema.Codec<A, unknown, never, never>) =>
  Schema.decodeUnknownOption(Schema.Union([schema, Schema.toCodecJson(schema)]));

const decodeSummary = decodeWithWireAmounts(DocumentSummaryData);
const decodeContactSnapshot = Schema.decodeUnknownOption(ContactSnapshotData);
const decodeIssuerSnapshot = Schema.decodeUnknownOption(IssuerSnapshotData);
const decodeLineView = decodeWithWireAmounts(LineViewData);
const decodePayment = decodeWithWireAmounts(PaymentViewData);
const decodeContactOption = Schema.decodeUnknownOption(ContactOptionData);
const decodePriceListOption = decodeWithWireAmounts(PriceListOptionData);
const decodeBankAccount = Schema.decodeUnknownOption(BankAccountData);
const decodeTemplate = decodeWithWireAmounts(TemplateViewData);
const decodeWorkspaceInfo = Schema.decodeUnknownOption(WorkspaceInfoData);

const readSummary = Fn.flow(decodeSummary, Option.getOrUndefined);

export const readSummaries = (raw: ReadonlyArray<unknown>): ReadonlyArray<DocumentSummaryData> =>
  Arr.flatMap(raw, (item) => {
    const decoded = readSummary(item);
    return decoded === undefined ? [] : [decoded];
  });

export const readContactSnapshot = Fn.flow(decodeContactSnapshot, Option.getOrUndefined);

export const readIssuerSnapshot = Fn.flow(decodeIssuerSnapshot, Option.getOrUndefined);

export const readLines = (raw: ReadonlyArray<unknown>): ReadonlyArray<LineViewData> =>
  Arr.flatMap(raw, (item) => {
    const decoded = Option.getOrUndefined(decodeLineView(item));
    return decoded === undefined ? [] : [decoded];
  });

export const readPayments = (raw: ReadonlyArray<unknown>): ReadonlyArray<PaymentViewData> =>
  Arr.flatMap(raw, (item) => {
    const decoded = Option.getOrUndefined(decodePayment(item));
    return decoded === undefined ? [] : [decoded];
  });

export const readContacts = (raw: ReadonlyArray<unknown>): ReadonlyArray<ContactOptionData> =>
  Arr.flatMap(raw, (item) => {
    const decoded = Option.getOrUndefined(decodeContactOption(item));
    return decoded === undefined ? [] : [decoded];
  });

export const readContact = Fn.flow(decodeContactOption, Option.getOrUndefined);

export const readPriceList = (raw: ReadonlyArray<unknown>): ReadonlyArray<PriceListOptionData> =>
  Arr.flatMap(raw, (item) => {
    const decoded = Option.getOrUndefined(decodePriceListOption(item));
    return decoded === undefined ? [] : [decoded];
  });

export const readBankAccounts = (raw: ReadonlyArray<unknown>): ReadonlyArray<BankAccountData> =>
  Arr.flatMap(raw, (item) => {
    const decoded = Option.getOrUndefined(decodeBankAccount(item));
    return decoded === undefined ? [] : [decoded];
  });

export const readTemplate = Fn.flow(decodeTemplate, Option.getOrUndefined);

export const readTemplates = (raw: ReadonlyArray<unknown>): ReadonlyArray<TemplateViewData> =>
  Arr.flatMap(raw, (item) => {
    const decoded = readTemplate(item);
    return decoded === undefined ? [] : [decoded];
  });

export const readWorkspaceInfo = Fn.flow(decodeWorkspaceInfo, Option.getOrUndefined);

// --- Dates & Decimals ----------------------------------------------------------------------------

const prague = DateTime.zoneMakeNamedUnsafe("Europe/Prague");

export const todayPrague = (): IsoDate =>
  IsoDate.make(
    DateTime.formatIsoDate(DateTime.makeZonedUnsafe(DateTime.nowUnsafe(), { timeZone: prague })),
  );

const addDaysIsoImpl = (iso: IsoDate, days: number): IsoDate =>
  IsoDate.make(DateTime.formatIsoDateUtc(DateTime.add(DateTime.makeUnsafe(iso), { days })));

export const addDaysIso: {
  (days: number): (iso: IsoDate) => IsoDate;
  (iso: IsoDate, days: number): IsoDate;
} = Fn.dual(2, addDaysIsoImpl);

export const yearPeriodOf = (today: IsoDate): { readonly from: IsoDate; readonly to: IsoDate } => {
  const year = Str.slice(0, 4)(today);
  return { from: IsoDate.make(`${year}-01-01`), to: today };
};

export const isIsoDateString = (s: string): s is IsoDate =>
  Option.isSome(Schema.decodeOption(IsoDate)(s));

export const parseDecimalText = (raw: string): BigDecimal.BigDecimal | undefined => {
  const cleaned = Str.replace(",", ".")(Str.replace(/\s+/g, "")(Str.trim(raw)));
  if (cleaned === "" || !decimalText.test(cleaned)) return undefined;
  return Option.getOrUndefined(BigDecimal.fromString(cleaned));
};

export const decimalToInput = (bd: BigDecimal.BigDecimal): string =>
  bd.pipe(BigDecimal.normalize, BigDecimal.format);

const fmtMoneyImpl = (locale: AppLocale, money: Money): string =>
  Format.moneyDisplay(locale, money).text;

export const fmtMoney: {
  (money: Money): (locale: AppLocale) => string;
  (locale: AppLocale, money: Money): string;
} = Fn.dual(2, fmtMoneyImpl);

const fmtDateImpl = (locale: AppLocale, iso: IsoDate): string => Format.formatDate(locale, iso);

export const fmtDate: {
  (iso: IsoDate): (locale: AppLocale) => string;
  (locale: AppLocale, iso: IsoDate): string;
} = Fn.dual(2, fmtDateImpl);

const fmtDateTimeImpl = (locale: AppLocale, iso: string): string =>
  Format.formatDateTime(locale, iso);

export const fmtDateTime: {
  (iso: string): (locale: AppLocale) => string;
  (locale: AppLocale, iso: string): string;
} = Fn.dual(2, fmtDateTimeImpl);

const fmtNumImpl = (locale: AppLocale, bd: BigDecimal.BigDecimal, maxFrac = 2): string =>
  Format.formatNumber(locale, bd, { minFractionDigits: 0, maxFractionDigits: maxFrac });

export const fmtNum: {
  (bd: BigDecimal.BigDecimal, maxFrac?: number): (locale: AppLocale) => string;
  (locale: AppLocale, bd: BigDecimal.BigDecimal, maxFrac?: number): string;
} = Fn.dual((args) => Predicate.isString(args[0]), fmtNumImpl);

const fmtVatRateImpl = (locale: AppLocale, rate: BigDecimal.BigDecimal): string =>
  Format.formatVatRate(locale, Number(BigDecimal.format(rate)));

export const fmtVatRate: {
  (rate: BigDecimal.BigDecimal): (locale: AppLocale) => string;
  (locale: AppLocale, rate: BigDecimal.BigDecimal): string;
} = Fn.dual(2, fmtVatRateImpl);

export const formatAddress = (addr: AddressData): string =>
  Arr.join(
    Arr.filter(
      [
        addr.street,
        Arr.join(
          Arr.filter(
            [addr.postalCode, addr.city],
            (part): part is string => part !== null && part !== "",
          ),
          " ",
        ),
        addr.country,
      ],
      (p): p is string => p !== null && p !== "",
    ),
    ", ",
  );

// --- Status & kind badges ------------------------------------------------------------------------

const kindBadgeImpl = <M>(h: Html.H<M>, locale: AppLocale, kind: DocumentKind): Markup<M> => {
  const t = translator(locale);
  const label = textOf(t, I18n.enumText("documentKind", kind));
  const tone: BadgeTone = kind === "proforma" ? "proforma" : "outline";
  return badge(h, label, tone);
};

export const kindBadge: {
  <M>(locale: AppLocale, kind: DocumentKind): (h: Html.H<M>) => Markup<M>;
  <M>(h: Html.H<M>, locale: AppLocale, kind: DocumentKind): Markup<M>;
} = Fn.dual(3, kindBadgeImpl);

const documentBadgesImpl = <M>(
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

export const documentBadges: {
  <M>(
    locale: AppLocale,
    doc: {
      readonly status: DocumentStatus;
      readonly settlement: DocumentSettlement;
      readonly overdue: boolean;
      readonly locked: boolean;
      readonly kind: DocumentKind;
    },
  ): (h: Html.H<M>) => ReadonlyArray<Markup<M>>;
  <M>(
    h: Html.H<M>,
    locale: AppLocale,
    doc: {
      readonly status: DocumentStatus;
      readonly settlement: DocumentSettlement;
      readonly overdue: boolean;
      readonly locked: boolean;
      readonly kind: DocumentKind;
    },
  ): ReadonlyArray<Markup<M>>;
} = Fn.dual(3, documentBadgesImpl);

const sourceBadgeImpl = <M>(
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

export const sourceBadge: {
  <M>(locale: AppLocale, source: ViewModels.SettingSource): (h: Html.H<M>) => Markup<M>;
  <M>(h: Html.H<M>, locale: AppLocale, source: ViewModels.SettingSource): Markup<M>;
} = Fn.dual(3, sourceBadgeImpl);

// --- Commands for browser-only side effects & idempotent writes ----------------------------------

const apiCommandImpl = <A, E, M>(
  message: Schema.Codec<M, unknown, never, never>,
  name: string,
  call: (client: Client) => Effect.Effect<A, E>,
  onSuccess: (a: A) => M,
  onFailure: (f: Failure) => M,
): PageCommand<M> => runApi(message, name, request(call, onSuccess, onFailure));

export const apiCommand: {
  <A, E, M>(
    name: string,
    call: (client: Client) => Effect.Effect<A, E>,
    onSuccess: (a: A) => M,
    onFailure: (f: Failure) => M,
  ): (message: Schema.Codec<M, unknown, never, never>) => PageCommand<M>;
  <A, E, M>(
    message: Schema.Codec<M, unknown, never, never>,
    name: string,
    call: (client: Client) => Effect.Effect<A, E>,
    onSuccess: (a: A) => M,
    onFailure: (f: Failure) => M,
  ): PageCommand<M>;
} = Fn.dual(5, apiCommandImpl);

const copyTextCommandImpl = <M>(text: string, onResult: (ok: boolean) => M): PageCommand<M> =>
  browserCommand("CopyText", writeClipboard(text).pipe(Effect.map(onResult)));

export const copyTextCommand: {
  <M>(onResult: (ok: boolean) => M): (text: string) => PageCommand<M>;
  <M>(text: string, onResult: (ok: boolean) => M): PageCommand<M>;
} = Fn.dual(2, copyTextCommandImpl);

export const withIdempotencyKey = <A, E, R>(
  fn: (headers: { readonly "idempotency-key": string }) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => Effect.flatMap(Api.uuidV7, (key) => fn(Api.idempotencyHeaders(key)));

export const idempotencyHeaders = (key: string): { readonly "idempotency-key": string } =>
  Api.idempotencyHeaders(key);

const mintRequestKeyCommandImpl = <M>(name: string, onKey: (key: string) => M): PageCommand<M> =>
  browserCommand(name, Api.uuidV7.pipe(Effect.map(onKey)));

export const mintRequestKeyCommand: {
  <M>(onKey: (key: string) => M): (name: string) => PageCommand<M>;
  <M>(name: string, onKey: (key: string) => M): PageCommand<M>;
} = Fn.dual(2, mintRequestKeyCommandImpl);

const delayCommandImpl = <M>(name: string, ms: number, message: M): PageCommand<M> =>
  Command.make(name, { args: {}, mode: "switch" }, () =>
    Effect.as(Effect.sleep(ms), message),
  ).make();

export const delayCommand: {
  <M>(ms: number, message: M): (name: string) => PageCommand<M>;
  <M>(name: string, ms: number, message: M): PageCommand<M>;
} = Fn.dual(3, delayCommandImpl);

// The only retryable conflict is an idempotency mismatch, which requires a fresh key.
export const preserveRequestKey = (failure: Failure): boolean =>
  failure.retryable && failure.tag !== "Conflict";

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
const canRoleImpl = (role: Role | undefined, action: DocumentAction): boolean => {
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

export const canRole: {
  (action: DocumentAction): (role: Role | undefined) => boolean;
  (role: Role | undefined, action: DocumentAction): boolean;
} = Fn.dual(2, canRoleImpl);

export const ifMatch = (revision: number) => Api.ifMatchHeaders(revision);

export const documentHasFinalInvoice = (doc: DocumentView): boolean =>
  Arr.some(doc.related, (r) => r.relation === "final_invoice_for");

const sharedCopyTable: Copy<
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
    // biome-ignore lint/security/noSecrets: This is static user-facing copy or a translation key.
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

const sharedCopyImpl = copy(sharedCopyTable);
type SharedCopyKey = keyof typeof sharedCopyTable.en;
type SharedCopyParams = Readonly<Record<string, string | number>>;

export const sharedCopy: {
  (key: SharedCopyKey, params?: SharedCopyParams): (locale: AppLocale) => string;
  (locale: AppLocale, key: SharedCopyKey, params?: SharedCopyParams): string;
} = Fn.dual((args) => args[0] === "cs" || args[0] === "en", sharedCopyImpl);

const decimalText = /^-?\d+(?:\.\d+)?$/;
