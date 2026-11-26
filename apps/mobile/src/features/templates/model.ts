import type {
  ContactId,
  CurrencyCode,
  IsoDate,
  Locale,
  PaymentMethod,
  ScheduleId,
  TemplateId,
  TemplateInput,
  VatTreatment,
} from "@kvitbit/domain/contract";
import { BigDecimal } from "effect";

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

export interface TemplateLineData {
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
  readonly contact: ContactId;
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

const asRecord = (u: unknown): Record<string, unknown> =>
  typeof u === "object" && u !== null && !Array.isArray(u) ? (u as Record<string, unknown>) : {};

const asString = (u: unknown): string | null => (typeof u === "string" ? u : null);

const asNumber = (u: unknown): number | null =>
  typeof u === "number" && Number.isFinite(u) ? u : null;

const asDecimalString = (u: unknown): string => {
  if (typeof u === "string" && u.trim() !== "") return u.trim();
  if (typeof u === "number" && Number.isFinite(u)) return String(u);
  if (typeof u === "object" && u !== null && "value" in u && "scale" in u) {
    try {
      return BigDecimal.format(u as BigDecimal.BigDecimal);
    } catch {
      return "0";
    }
  }
  return "0";
};

const asVatTreatment = (u: unknown): VatTreatment =>
  u === "reduced" ||
  u === "exempt_intra_eu_goods" ||
  u === "reverse_charge" ||
  u === "outside_scope"
    ? u
    : "standard";

const decodeEvery = (u: unknown): ScheduleEvery => {
  const r = asRecord(u);
  const weeks = asNumber(r.weeks);
  if (weeks !== null && weeks >= 1) return { weeks: Math.round(weeks) };
  const years = asNumber(r.years);
  if (years !== null && years >= 1) return { years: Math.round(years) };
  const months = asNumber(r.months);
  return { months: months !== null && months >= 1 ? Math.round(months) : 1 };
};

export const decodeSchedule = (u: unknown): ScheduleViewData | null => {
  if (u === null || u === undefined) return null;
  const r = asRecord(u);
  const startOn = asString(r.startOn) as IsoDate | null;
  if (startOn === null) return null;
  return {
    id: (asString(r.id) ?? "") as ScheduleId,
    every: decodeEvery(r.every),
    startOn,
    endOn: asString(r.endOn) as IsoDate | null,
    issueAs: r.issueAs === "proforma" ? "proforma" : "invoice",
    autoSend: r.autoSend === true,
    nextOccurrence: asString(r.nextOccurrence) as IsoDate | null,
    paused: r.paused === true || r.pausedReason !== null,
    pausedReason: asString(r.pausedReason),
    pausedError: asString(r.pausedError),
  };
};

export const decodeTemplate = (u: unknown): TemplateViewData => {
  const r = asRecord(u);
  const input = asRecord(r.input);
  const due = asRecord(input.due);
  const rawLines = Array.isArray(input.lines) ? input.lines : [];
  return {
    id: (asString(r.id) ?? "") as TemplateId,
    name: asString(r.name) ?? asString(input.name) ?? "",
    revision: asNumber(r.revision) ?? 1,
    archived: r.archived === true,
    kind: input.kind === "proforma" ? "proforma" : "invoice",
    contact: (asString(input.contact) ?? "") as ContactId,
    currency: asString(input.currency) as CurrencyCode | null,
    language: input.language === "cs" || input.language === "en" ? input.language : null,
    dueInDays: asNumber(due.inDays),
    paymentMethod:
      input.paymentMethod === "bank_transfer" ||
      input.paymentMethod === "card" ||
      input.paymentMethod === "cash" ||
      input.paymentMethod === "other"
        ? input.paymentMethod
        : null,
    note: asString(input.note),
    lines: rawLines.map((entry) => {
      const line = asRecord(entry);
      return {
        description: asString(line.description) ?? "",
        quantity: asDecimalString(line.quantity ?? "1"),
        unit: asString(line.unit) ?? "",
        unitPrice: asDecimalString(line.unitPrice ?? "0"),
        vat: asVatTreatment(line.vat),
      };
    }),
    schedule: decodeSchedule(r.schedule),
  };
};

// --- Schedule state & date preview ----------------------------------------------------------------

export const scheduleStateOf = (schedule: ScheduleViewData | null): ScheduleState => {
  if (schedule === null) return "none";
  if (schedule.paused) return "paused";
  if (schedule.nextOccurrence === null) return "ended";
  return "active";
};

export const filterTemplates = (
  items: ReadonlyArray<TemplateViewData>,
  filter: TemplateFilter,
): ReadonlyArray<TemplateViewData> =>
  items.filter((item) => {
    const state = scheduleStateOf(item.schedule);
    if (filter === "all") return true;
    if (filter === "active") return state === "active";
    if (filter === "paused") return state === "paused";
    return state === "none" || state === "ended";
  });

export const cadenceParts = (
  every: ScheduleEvery,
): { readonly unit: CadenceUnit; readonly count: number } => {
  if ("weeks" in every) return { unit: "weeks", count: every.weeks };
  if ("years" in every) return { unit: "years", count: every.years };
  return { unit: "months", count: every.months };
};

const pad2 = (n: number): string => String(n).padStart(2, "0");

const daysInMonth = (year: number, month1: number): number => new Date(year, month1, 0).getDate();

/** Computes occurrence `k` (0-indexed) from `startOn + k * every`, clamping day to end of month. */
export const occurrenceAt = (startOn: IsoDate, every: ScheduleEvery, k: number): IsoDate => {
  const parts = startOn.split("-").map((p) => Number.parseInt(p, 10));
  const y = parts[0] ?? 2026;
  const m = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  if ("weeks" in every) {
    const dt = new Date(Date.UTC(y, m - 1, d + k * every.weeks * 7));
    return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}` as IsoDate;
  }
  const addMonths = "years" in every ? k * every.years * 12 : k * every.months;
  const totalMonths = y * 12 + (m - 1) + addMonths;
  const ny = Math.floor(totalMonths / 12);
  const nm = (totalMonths % 12) + 1;
  const nd = Math.min(d, daysInMonth(ny, nm));
  return `${ny}-${pad2(nm)}-${pad2(nd)}` as IsoDate;
};

/** Previews up to `count` occurrences starting at `startOn` (stopping after `endOn`). */
export const previewOccurrences = (
  startOn: string,
  every: ScheduleEvery,
  endOn: string,
  count = 3,
): ReadonlyArray<IsoDate> => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startOn)) return [];
  const validEnd = /^\d{4}-\d{2}-\d{2}$/.test(endOn) ? (endOn as IsoDate) : null;
  const out: Array<IsoDate> = [];
  for (let k = 0; k < count; k++) {
    const next = occurrenceAt(startOn as IsoDate, every, k);
    if (validEnd !== null && next > validEnd) break;
    out.push(next);
  }
  return out;
};

// --- Form builders --------------------------------------------------------------------------------

export interface TemplateLineDraft {
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
  contact: view.contact,
  currency: view.currency ?? "CZK",
  language: view.language ?? "cs",
  dueInDays: view.dueInDays === null ? "14" : String(view.dueInDays),
  paymentMethod: view.paymentMethod ?? "bank_transfer",
  note: view.note ?? "",
  lines:
    view.lines.length === 0
      ? emptyTemplateForm().lines
      : view.lines.map((line, i) => ({
          id: `line-${i}`,
          description: line.description,
          quantity: line.quantity,
          unit: line.unit,
          unitPrice: line.unitPrice,
          vat: line.vat,
        })),
});

const parseBigDecimal = (raw: string): BigDecimal.BigDecimal | null => {
  const cleaned = raw.trim().replace(/\s+/g, "").replace(",", ".");
  if (cleaned === "" || !/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const parsed = BigDecimal.fromString(cleaned);
  return parsed._tag === "Some" ? parsed.value : null;
};

export const buildTemplateInput = (
  form: TemplateFormState,
): { readonly input: TemplateInput | null; readonly errors: Readonly<Record<string, string>> } => {
  const errors: Record<string, string> = {};
  const name = form.name.trim();
  if (name === "") errors.name = "required";
  const contact = form.contact.trim();
  if (contact === "") errors.contact = "required";

  const dueDays = form.dueInDays.trim() === "" ? null : Number.parseInt(form.dueInDays.trim(), 10);
  if (dueDays !== null && (!Number.isInteger(dueDays) || dueDays < 0 || dueDays > 365)) {
    errors.dueInDays = "invalid_days";
  }

  const builtLines: Array<{
    readonly description: string;
    readonly quantity: BigDecimal.BigDecimal;
    readonly unit?: string;
    readonly unitPrice: BigDecimal.BigDecimal;
    readonly vat: VatTreatment;
  }> = [];

  if (form.lines.length === 0) {
    errors.lines = "required";
  } else {
    form.lines.forEach((line, i) => {
      const desc = line.description.trim();
      const qty = parseBigDecimal(line.quantity);
      const price = parseBigDecimal(line.unitPrice);
      if (desc === "") errors[`lines.${i}.description`] = "required";
      if (qty === null || BigDecimal.isLessThanOrEqualTo(qty, BigDecimal.fromNumberUnsafe(0))) {
        errors[`lines.${i}.quantity`] = "invalid_number";
      }
      if (price === null) errors[`lines.${i}.unitPrice`] = "invalid_number";
      if (desc !== "" && qty !== null && price !== null) {
        builtLines.push({
          description: desc,
          quantity: qty,
          ...(line.unit.trim() === "" ? {} : { unit: line.unit.trim() }),
          unitPrice: price,
          vat: line.vat,
        });
      }
    });
  }

  if (Object.keys(errors).length > 0 || builtLines.length === 0) {
    return { input: null, errors };
  }

  const [first, ...rest] = builtLines;
  if (first === undefined) return { input: null, errors };

  const input: TemplateInput = {
    name,
    kind: form.kind,
    contact: contact as ContactId,
    lines: [first, ...rest],
    ...(form.currency.trim() === ""
      ? {}
      : { currency: form.currency.trim().toUpperCase() as CurrencyCode }),
    language: form.language,
    ...(dueDays === null ? {} : { due: { inDays: dueDays } }),
    paymentMethod: form.paymentMethod,
    ...(form.note.trim() === "" ? {} : { note: form.note.trim() }),
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

export const scheduleFormFromView = (
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
};

export const buildScheduleEvery = (unit: CadenceUnit, countRaw: string): ScheduleEvery | null => {
  const count = Number.parseInt(countRaw.trim(), 10);
  if (!Number.isInteger(count) || count < 1 || count > 99) return null;
  if (unit === "weeks") return { weeks: count };
  if (unit === "years") return { years: count };
  return { months: count };
};
