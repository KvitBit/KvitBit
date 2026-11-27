import {
  ContactId,
  CurrencyCode,
  IsoDate,
  type Locale,
  type PaymentMethod,
  ScheduleId,
  TemplateId,
  type TemplateInput,
  type TemplateView,
  VatTreatment,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as DateTime from "effect/DateTime";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

export type CadenceUnit = "weeks" | "months" | "years";

export type ScheduleEvery =
  | { readonly weeks: number }
  | { readonly months: number }
  | { readonly years: number };

export interface ScheduleViewData {
  readonly id: ScheduleId;
  readonly every: ScheduleEvery;
  readonly startOn: IsoDate;
  readonly endOn: IsoDate | null;
  readonly issueAs: "invoice" | "proforma";
  readonly autoSend: boolean;
  readonly nextOccurrence: IsoDate | null;
  readonly paused: boolean;
  readonly pausedReason: string | null;
  readonly pausedError: string | null;
}

interface TemplateLineData {
  readonly description: string;
  readonly quantity: string;
  readonly unit: string;
  readonly unitPrice: string;
  readonly vat: VatTreatment;
}

export interface TemplateViewData {
  readonly id: TemplateId;
  readonly name: string;
  readonly revision: number;
  readonly archived: boolean;
  readonly kind: "invoice" | "proforma";
  readonly contact: ContactId | null;
  readonly currency: CurrencyCode | null;
  readonly language: Locale | null;
  readonly dueInDays: number | null;
  readonly paymentMethod: PaymentMethod | null;
  readonly note: string | null;
  readonly lines: ReadonlyArray<TemplateLineData>;
  readonly schedule: ScheduleViewData | null;
}

export type ScheduleState = "none" | "active" | "paused" | "ended";

export type TemplateFilter = "all" | "active" | "paused" | "one_off";

// --- Safe decoders --------------------------------------------------------------------------------

const TemplateRecord = Schema.Record(Schema.String, Schema.Unknown);
const emptyTemplateRecord = (): typeof TemplateRecord.Type => ({});
const asRecord = Fn.flow(
  Schema.decodeUnknownOption(TemplateRecord),
  Option.getOrElse(emptyTemplateRecord),
);
const asString = Fn.flow(Schema.decodeUnknownOption(Schema.String), Option.getOrNull);
const asNumber = Fn.flow(Schema.decodeUnknownOption(Schema.Finite), Option.getOrNull);
const asDate = Fn.flow(Schema.decodeUnknownOption(IsoDate), Option.getOrNull);
const asTemplateId = Fn.flow(Schema.decodeUnknownOption(TemplateId), Option.getOrNull);
const asScheduleId = Fn.flow(Schema.decodeUnknownOption(ScheduleId), Option.getOrNull);
const asContactId = Fn.flow(Schema.decodeUnknownOption(ContactId), Option.getOrNull);
const asCurrency = Fn.flow(Schema.decodeUnknownOption(CurrencyCode), Option.getOrNull);
const asVatTreatment = Fn.flow(
  Schema.decodeUnknownOption(VatTreatment),
  Option.getOrElse(() => "standard" as const),
);
const asDecimalString = Fn.flow(
  Schema.decodeUnknownOption(Schema.Union([Schema.BigDecimal, Schema.String, Schema.Finite])),
  Option.map((value) =>
    BigDecimal.isBigDecimal(value) ? BigDecimal.format(value) : Str.trim(String(value)),
  ),
  Option.filter((value) => value !== ""),
  Option.getOrElse(() => "0"),
);

const decodeEvery = Fn.flow(asRecord, (r): ScheduleEvery => {
  const weeks = asNumber(r["weeks"]);
  if (weeks !== null && weeks >= 1) return { weeks: Math.round(weeks) };
  const years = asNumber(r["years"]);
  if (years !== null && years >= 1) return { years: Math.round(years) };
  const months = asNumber(r["months"]);
  return { months: months !== null && months >= 1 ? Math.round(months) : 1 };
});

const decodeSchedule = Fn.flow(asRecord, (r): ScheduleViewData | null => {
  const startOn = asDate(r["startOn"]);
  const id = asScheduleId(r["id"]);
  if (startOn === null || id === null) return null;
  return {
    id,
    every: decodeEvery(r["every"]),
    startOn,
    endOn: asDate(r["endOn"]),
    issueAs: r["issueAs"] === "proforma" ? "proforma" : "invoice",
    autoSend: r["autoSend"] === true,
    nextOccurrence: asDate(r["nextOccurrence"]),
    paused: r["paused"] === true || r["pausedReason"] !== null,
    pausedReason: asString(r["pausedReason"]),
    pausedError: asString(r["pausedError"]),
  };
});

export const decodeTemplate = (view: TemplateView): TemplateViewData | null => {
  const r = asRecord(view);
  const id = asTemplateId(r["id"]);
  if (id === null) return null;
  const input = asRecord(r["input"]);
  const due = asRecord(input["due"]);
  const rawLines = Arr.isArray(input["lines"]) ? input["lines"] : [];
  return {
    id,
    name: asString(r["name"]) ?? asString(input["name"]) ?? "",
    revision: asNumber(r["revision"]) ?? 1,
    archived: r["archived"] === true,
    kind: input["kind"] === "proforma" ? "proforma" : "invoice",
    contact: asContactId(input["contact"]),
    currency: asCurrency(input["currency"]),
    language: input["language"] === "cs" || input["language"] === "en" ? input["language"] : null,
    dueInDays: asNumber(due["inDays"]),
    paymentMethod:
      input["paymentMethod"] === "bank_transfer" ||
      input["paymentMethod"] === "card" ||
      input["paymentMethod"] === "cash" ||
      input["paymentMethod"] === "other"
        ? input["paymentMethod"]
        : null,
    note: asString(input["note"]),
    lines: Arr.map(rawLines, (entry) => {
      const line = asRecord(entry);
      return {
        description: asString(line["description"]) ?? "",
        quantity: asDecimalString(line["quantity"] ?? "1"),
        unit: asString(line["unit"]) ?? "",
        unitPrice: asDecimalString(line["unitPrice"] ?? "0"),
        vat: asVatTreatment(line["vat"]),
      };
    }),
    schedule: decodeSchedule(r["schedule"]),
  };
};

// --- Schedule state & date preview ----------------------------------------------------------------

export const scheduleStateOf = (schedule: ScheduleViewData | null): ScheduleState => {
  if (schedule === null) return "none";
  if (schedule.paused) return "paused";
  if (schedule.nextOccurrence === null) return "ended";
  return "active";
};

export const filterTemplates: {
  (
    filter: TemplateFilter,
  ): (items: ReadonlyArray<TemplateViewData>) => ReadonlyArray<TemplateViewData>;
  (items: ReadonlyArray<TemplateViewData>, filter: TemplateFilter): ReadonlyArray<TemplateViewData>;
} = Fn.dual(
  2,
  (
    items: ReadonlyArray<TemplateViewData>,
    filter: TemplateFilter,
  ): ReadonlyArray<TemplateViewData> =>
    Arr.filter(items, (item) => {
      const state = scheduleStateOf(item.schedule);
      if (filter === "all") return true;
      if (filter === "active") return state === "active";
      if (filter === "paused") return state === "paused";
      return state === "none" || state === "ended";
    }),
);

export const cadenceParts = (
  every: ScheduleEvery,
): { readonly unit: CadenceUnit; readonly count: number } => {
  if ("weeks" in every) return { unit: "weeks", count: every.weeks };
  if ("years" in every) return { unit: "years", count: every.years };
  return { unit: "months", count: every.months };
};

const pad2 = (n: number): string => Str.padStart(2, "0")(String(n));

const daysInMonth = (year: number, month1: number): number =>
  DateTime.toPartsUtc(DateTime.endOf(DateTime.makeUnsafe({ year, month: month1, day: 1 }), "month"))
    .day;

const firstIsoDay = DateTime.toEpochMillis(DateTime.makeUnsafe("0000-01-01T00:00:00Z"));
const lastIsoDay = DateTime.toEpochMillis(DateTime.makeUnsafe("9999-12-31T00:00:00Z"));
const weekMs = 7 * 24 * 60 * 60 * 1000;

/** Computes an occurrence within the date format, clamping the day at month end. */
export const occurrenceAt: {
  (every: ScheduleEvery, k: number): (startOn: IsoDate) => IsoDate | null;
  (startOn: IsoDate, every: ScheduleEvery, k: number): IsoDate | null;
} = Fn.dual(3, (startOn: IsoDate, every: ScheduleEvery, k: number): IsoDate | null => {
  const start = DateTime.makeUnsafe(`${startOn}T00:00:00Z`);
  if ("weeks" in every) {
    const next = DateTime.toEpochMillis(start) + k * every.weeks * weekMs;
    if (!Number.isFinite(next) || next < firstIsoDay || next > lastIsoDay) return null;
    return IsoDate.make(DateTime.formatIsoDateUtc(DateTime.makeUnsafe(next)));
  }
  const { year, month, day } = DateTime.toPartsUtc(start);
  const addMonths = "years" in every ? k * every.years * 12 : k * every.months;
  const totalMonths = year * 12 + (month - 1) + addMonths;
  const nextYear = Math.floor(totalMonths / 12);
  if (!Number.isInteger(nextYear) || nextYear < 0 || nextYear > 9999) return null;
  const nextMonth = (totalMonths % 12) + 1;
  const nextDay = Math.min(day, daysInMonth(nextYear, nextMonth));
  const yearPart = Str.padStart(4, "0")(String(nextYear));
  return IsoDate.make(`${yearPart}-${pad2(nextMonth)}-${pad2(nextDay)}`);
});

/** Previews up to `count` occurrences starting at `startOn` (stopping after `endOn`). */
export const previewOccurrences = ({
  startOn,
  every,
  endOn,
  count = 3,
}: {
  readonly startOn: string;
  readonly every: ScheduleEvery;
  readonly endOn: string;
  readonly count?: number;
}): ReadonlyArray<IsoDate> => {
  const start = asDate(startOn);
  if (start === null) return [];
  const validEnd = asDate(endOn);
  const out: Array<IsoDate> = [];
  for (let k = 0; k < count; k++) {
    const next = occurrenceAt(start, every, k);
    if (next === null || (validEnd !== null && next > validEnd)) break;
    out.push(next);
  }
  return out;
};

// --- Form builders --------------------------------------------------------------------------------

interface TemplateLineDraft {
  readonly id: string;
  readonly description: string;
  readonly quantity: string;
  readonly unit: string;
  readonly unitPrice: string;
  readonly vat: VatTreatment;
}

export interface TemplateFormState {
  readonly name: string;
  readonly kind: "invoice" | "proforma";
  readonly contact: string;
  readonly currency: string;
  readonly language: Locale;
  readonly dueInDays: string;
  readonly paymentMethod: PaymentMethod;
  readonly note: string;
  readonly lines: ReadonlyArray<TemplateLineDraft>;
}

export const emptyTemplateForm = (): TemplateFormState => ({
  name: "",
  kind: "invoice",
  contact: "",
  currency: "CZK",
  language: "cs",
  dueInDays: "14",
  paymentMethod: "bank_transfer",
  note: "",
  lines: [
    {
      id: "line-0",
      description: "",
      quantity: "1",
      unit: "ks",
      unitPrice: "",
      vat: "standard",
    },
  ],
});

export const templateFormFromView = (view: TemplateViewData): TemplateFormState => ({
  name: view.name,
  kind: view.kind,
  contact: view.contact ?? "",
  currency: view.currency ?? "CZK",
  language: view.language ?? "cs",
  dueInDays: view.dueInDays === null ? "14" : String(view.dueInDays),
  paymentMethod: view.paymentMethod ?? "bank_transfer",
  note: view.note ?? "",
  lines:
    view.lines.length === 0
      ? emptyTemplateForm().lines
      : Arr.map(view.lines, (line, i) => ({
          id: `line-${i}`,
          description: line.description,
          quantity: line.quantity,
          unit: line.unit,
          unitPrice: line.unitPrice,
          vat: line.vat,
        })),
});

const DECIMAL_RE = /^-?\d+(?:\.\d+)?$/;

const parseBigDecimal = (raw: string): BigDecimal.BigDecimal | null => {
  const cleaned = Str.replace(",", ".")(Str.replace(/\s+/g, "")(Str.trim(raw)));
  if (cleaned === "" || !DECIMAL_RE.test(cleaned)) return null;
  const parsed = BigDecimal.fromString(cleaned);
  return parsed._tag === "Some" ? parsed.value : null;
};

export const buildTemplateInput = (
  form: TemplateFormState,
): { readonly input: TemplateInput | null; readonly errors: Readonly<Record<string, string>> } => {
  const errors: Record<string, string> = {};
  const name = Str.trim(form.name);
  if (name === "") errors["name"] = "required";
  const contact = asContactId(Str.trim(form.contact));
  if (contact === null) errors["contact"] = "required";
  const currencyCode = Str.toUpperCase(Str.trim(form.currency));
  const currency = asCurrency(currencyCode);
  if (currencyCode !== "" && currency === null) errors["currency"] = "invalid_currency";

  const dueDays =
    Str.trim(form.dueInDays) === "" ? null : Number.parseInt(Str.trim(form.dueInDays), 10);
  if (dueDays !== null && (!Number.isInteger(dueDays) || dueDays < 0 || dueDays > 365)) {
    errors["dueInDays"] = "invalid_days";
  }

  const builtLines: Array<{
    readonly description: string;
    readonly quantity: BigDecimal.BigDecimal;
    readonly unit?: string | undefined;
    readonly unitPrice: BigDecimal.BigDecimal;
    readonly vat: VatTreatment;
  }> = [];

  if (form.lines.length === 0) {
    errors["lines"] = "required";
  } else {
    Arr.forEach(form.lines, (line, i) => {
      const desc = Str.trim(line.description);
      const qty = parseBigDecimal(line.quantity);
      const price = parseBigDecimal(line.unitPrice);
      const unit = Str.trim(line.unit);
      if (desc === "") errors[`lines.${i}.description`] = "required";
      if (qty === null || BigDecimal.isLessThanOrEqualTo(qty, BigDecimal.fromNumberUnsafe(0))) {
        errors[`lines.${i}.quantity`] = "invalid_number";
      }
      if (price === null) errors[`lines.${i}.unitPrice`] = "invalid_number";
      if (desc !== "" && qty !== null && price !== null) {
        builtLines.push({
          description: desc,
          quantity: qty,
          unit: unit === "" ? undefined : unit,
          unitPrice: price,
          vat: line.vat,
        });
      }
    });
  }

  if (contact === null || Rec.keys(errors).length > 0 || builtLines.length === 0) {
    return { input: null, errors };
  }

  const [first, ...rest] = builtLines;
  if (first === undefined) return { input: null, errors };

  const input: TemplateInput = {
    name,
    kind: form.kind,
    contact,
    lines: [first, ...rest],
    currency: currency ?? undefined,
    language: form.language,
    due: dueDays === null ? undefined : { inDays: dueDays },
    paymentMethod: form.paymentMethod,
    note: Str.trim(form.note) || undefined,
  };

  return { input, errors };
};

export interface ScheduleFormState {
  readonly unit: CadenceUnit;
  readonly count: string;
  readonly startOn: string;
  readonly endOn: string;
  readonly issueAs: "invoice" | "proforma";
  readonly autoSend: boolean;
}

export const scheduleFormFromView: {
  (
    defaultKind: "invoice" | "proforma",
    today: IsoDate,
  ): (schedule: ScheduleViewData | null) => ScheduleFormState;
  (
    schedule: ScheduleViewData | null,
    defaultKind: "invoice" | "proforma",
    today: IsoDate,
  ): ScheduleFormState;
} = Fn.dual(
  3,
  (
    schedule: ScheduleViewData | null,
    defaultKind: "invoice" | "proforma",
    today: IsoDate,
  ): ScheduleFormState => {
    if (schedule === null) {
      return {
        unit: "months",
        count: "1",
        startOn: today,
        endOn: "",
        issueAs: defaultKind,
        autoSend: false,
      };
    }
    const { unit, count } = cadenceParts(schedule.every);
    return {
      unit,
      count: String(count),
      startOn: schedule.startOn,
      endOn: schedule.endOn ?? "",
      issueAs: schedule.issueAs,
      autoSend: schedule.autoSend,
    };
  },
);

export const buildScheduleEvery: {
  (countRaw: string): (unit: CadenceUnit) => ScheduleEvery | null;
  (unit: CadenceUnit, countRaw: string): ScheduleEvery | null;
} = Fn.dual(2, (unit: CadenceUnit, countRaw: string): ScheduleEvery | null => {
  const count = Number.parseInt(Str.trim(countRaw), 10);
  if (!Number.isInteger(count) || count < 1 || count > 99) return null;
  if (unit === "weeks") return { weeks: count };
  if (unit === "years") return { years: count };
  return { months: count };
});
