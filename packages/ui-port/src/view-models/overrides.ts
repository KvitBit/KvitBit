/**
 * The `Document → Contact → Workspace` override chain (core-ports 4.2, ui-port-contracts 8.15)
 * with a source badge per value, plus the "Billing defaults" form state of the Contact editor.
 *
 * Contact-overridable fields are exactly `ContactDefaults`: currency, language, dueDays,
 * paymentMethod, preferredSeriesByKind, defaultNote and reminderPolicy. Bank account, VAT
 * treatment and pricesIncludeVat are not Contact-overridable in the domain and stay out.
 */

import {
  type ContactDefaults,
  CurrencyCode,
  type DocumentKind,
  type Locale,
  type NumberingSeriesId,
  type PaymentMethod,
  type ReminderPolicy,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";

/** Where an effective value came from. `default` is the product fallback below the Workspace. */
export type SettingSource = "document" | "contact" | "workspace" | "default";

export interface Resolved<A> {
  readonly value: A;
  readonly source: SettingSource;
  /** True when this level set its own value (`source` is the level asked about). */
  readonly overridden: boolean;
  /** What applies when this level's own value is cleared (the "Workspace default" hint). */
  readonly inherited: A;
  /** The inherited value's source. */
  readonly inheritedSource: SettingSource;
}

export interface SettingLayers<A> {
  readonly document?: A | undefined;
  readonly contact?: A | undefined;
  readonly workspace?: A | undefined;
  readonly fallback: A;
}

const ORDER = ["document", "contact", "workspace"] as const;
type Level = (typeof ORDER)[number];

const firstSet = <A>(
  layers: SettingLayers<A>,
  from: number,
): { readonly value: A; readonly source: SettingSource } => {
  for (let i = from; i < ORDER.length; i++) {
    const level = ORDER[i];
    if (level === undefined) continue;
    const value = layers[level];
    if (value !== undefined) return { value, source: level };
  }
  return { value: layers.fallback, source: "default" };
};

/**
 * Resolves one setting as seen from `at` (default `document`): the first level from `at`
 * downwards that sets a value wins, else the product fallback. `inherited` is what the levels
 * below `at` give, so clearing `at`'s own value yields exactly `inherited`.
 */
export const resolveSetting: {
  (at?: Level): <A>(layers: SettingLayers<A>) => Resolved<A>;
  <A>(layers: SettingLayers<A>, at?: Level): Resolved<A>;
} = Fn.dual(
  (args) => Predicate.isObjectOrArray(args[0]),
  <A>(layers: SettingLayers<A>, at: Level = "document"): Resolved<A> => {
    const index = ORDER.indexOf(at);
    const own = firstSet(layers, index);
    const below = firstSet(layers, index + 1);
    return {
      value: own.value,
      source: own.source,
      overridden: own.source === at,
      inherited: below.value,
      inheritedSource: below.source,
    };
  },
);

// --- Billing defaults ----------------------------------------------------------------------------

/** Workspace-level values of the Contact-overridable fields. Absent fields use `PRODUCT_DEFAULTS`. */
export interface WorkspaceBillingDefaults {
  readonly currency?: CurrencyCode;
  readonly language?: Locale;
  readonly dueDays?: number;
  readonly paymentMethod?: PaymentMethod;
  /** Workspace default Numbering Series per kind. */
  readonly seriesByKind?: Partial<Record<DocumentKind, NumberingSeriesId>>;
  readonly defaultNote?: string;
}

/**
 * Product fallbacks when the Workspace leaves a field unset. CZK and bank transfer follow the
 * domain defaults (`DocumentInput.currency` "Workspace (CZK)"); 14 due days and Czech are
 * ui-port assumptions until the Workspace defaults schema is specified (workspaces.ts "open").
 */
export const PRODUCT_DEFAULTS = {
  currency: CurrencyCode.make("CZK"),
  language: "cs",
  dueDays: 14,
  paymentMethod: "bank_transfer",
  defaultNote: "",
} as const;

/** Values a Member typed on the Document itself (a typed value always wins). */
export interface DocumentBillingValues {
  readonly currency?: CurrencyCode;
  readonly language?: Locale;
  readonly dueDays?: number;
  readonly paymentMethod?: PaymentMethod;
  readonly series?: NumberingSeriesId;
  readonly note?: string;
}

export interface EffectiveBilling {
  readonly currency: Resolved<CurrencyCode>;
  readonly language: Resolved<Locale>;
  readonly dueDays: Resolved<number>;
  readonly paymentMethod: Resolved<PaymentMethod>;
  /** None when neither the Contact nor the Workspace names a series for the kind. */
  readonly series: Resolved<NumberingSeriesId | null>;
  readonly note: Resolved<string>;
}

/** Editor prefill for `kind` along Document → Contact → Workspace → product default. */
export const resolveBilling = (input: {
  readonly kind: DocumentKind;
  readonly document?: DocumentBillingValues;
  readonly contact?: ContactDefaults | undefined;
  readonly workspace: WorkspaceBillingDefaults;
}): EffectiveBilling => {
  const d = input.document ?? {};
  const c = input.contact ?? {};
  const w = input.workspace;
  return {
    currency: resolveSetting({
      document: d.currency,
      contact: c.currency,
      workspace: w.currency,
      fallback: PRODUCT_DEFAULTS.currency,
    }),
    language: resolveSetting({
      document: d.language,
      contact: c.language,
      workspace: w.language,
      fallback: PRODUCT_DEFAULTS.language,
    }),
    dueDays: resolveSetting({
      document: d.dueDays,
      contact: c.dueDays,
      workspace: w.dueDays,
      fallback: PRODUCT_DEFAULTS.dueDays,
    }),
    paymentMethod: resolveSetting({
      document: d.paymentMethod,
      contact: c.paymentMethod,
      workspace: w.paymentMethod,
      fallback: PRODUCT_DEFAULTS.paymentMethod,
    }),
    series: resolveSetting<NumberingSeriesId | null>({
      document: d.series,
      contact: c.preferredSeriesByKind?.[input.kind],
      workspace: w.seriesByKind?.[input.kind],
      fallback: null,
    }),
    note: resolveSetting({
      document: d.note,
      contact: c.defaultNote,
      workspace: w.defaultNote,
      fallback: PRODUCT_DEFAULTS.defaultNote,
    }),
  };
};

/** Reminder schedule for a Contact: `inherit` (or absent) follows the Workspace schedule. */
export const resolveReminders: {
  (
    workspaceOffsetsDays: ReadonlyArray<number>,
  ): (contact: ReminderPolicy | undefined) => Resolved<ReadonlyArray<number>>;
  (
    contact: ReminderPolicy | undefined,
    workspaceOffsetsDays: ReadonlyArray<number>,
  ): Resolved<ReadonlyArray<number>>;
} = Fn.dual(
  2,
  (
    contact: ReminderPolicy | undefined,
    workspaceOffsetsDays: ReadonlyArray<number>,
  ): Resolved<ReadonlyArray<number>> => {
    const own =
      contact === undefined || contact.mode === "inherit"
        ? undefined
        : contact.mode === "disabled"
          ? []
          : contact.offsetsDays;
    return resolveSetting(
      { contact: own, workspace: workspaceOffsetsDays, fallback: [] },
      "contact",
    );
  },
);

// --- Contact "Billing defaults" form ------------------------------------------------------------

type ScalarOverrideField = "currency" | "language" | "dueDays" | "paymentMethod" | "defaultNote";

export interface OverrideForm {
  /** As loaded (`ContactView.defaults`); `{}` for a new Contact. */
  readonly initial: ContactDefaults;
  readonly current: ContactDefaults;
}

const withoutKey = <K extends keyof ContactDefaults>(
  value: ContactDefaults,
  key: K,
): ContactDefaults => {
  const { [key]: _removed, ...rest } = value;
  return rest;
};

const normalizeDefaults = (defaults: ContactDefaults): ContactDefaults => {
  let out = defaults;
  const series = out.preferredSeriesByKind;
  if (
    series !== undefined &&
    Arr.every(Rec.values<string, NumberingSeriesId | undefined>(series), (id) => id === undefined)
  ) {
    out = withoutKey(out, "preferredSeriesByKind");
  }
  // Absent behaves as inherit, so both spell the same stored state.
  if (out.reminderPolicy?.mode === "inherit") out = withoutKey(out, "reminderPolicy");
  return out;
};

const definedEntries = (value: Parameters<typeof Object.entries<unknown>>[0]) =>
  Arr.filter(
    // Arrays participate by enumerable keys too. Record.toEntries accepts only records.
    // @effect-diagnostics-next-line preferEffectRecord:off
    Object.entries<unknown>(value),
    ([, entry]) => entry !== undefined,
  );

// biome-ignore lint/plugin/no-unknown-parameters: Recursive comparison visits values from arbitrary nested object keys.
const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!(Predicate.isObjectOrArray(a) && Predicate.isObjectOrArray(b))) return false;
  if (Arr.isArray(a) !== Arr.isArray(b)) return false;
  const entriesA = definedEntries(a);
  const entriesB = definedEntries(b);
  if (entriesA.length !== entriesB.length) return false;
  const bByKey = new Map(entriesB);
  return Arr.every(entriesA, ([key, value]) => deepEqual(value, bByKey.get(key)));
};

type OverrideFieldKey = keyof ContactDefaults;

export const OverrideForm = {
  init: (initial: ContactDefaults = {}): OverrideForm => {
    const normalized = normalizeDefaults(initial);
    return { initial: normalized, current: normalized };
  },
  /** Sets this Contact's own value for a scalar field. */
  set: <F extends ScalarOverrideField>(
    form: OverrideForm,
    field: F,
    value: NonNullable<ContactDefaults[F]>,
  ): OverrideForm => ({ ...form, current: { ...form.current, [field]: value } }),
  /** "Use Workspace default": clears the field so the Workspace value applies again. */
  clear: (form: OverrideForm, field: OverrideFieldKey): OverrideForm => ({
    ...form,
    current: withoutKey(form.current, field),
  }),
  /** Sets or (with `null`) clears the preferred series for one kind. */
  setSeries: (
    form: OverrideForm,
    kind: DocumentKind,
    series: NumberingSeriesId | null,
  ): OverrideForm => {
    const map = { ...form.current.preferredSeriesByKind };
    if (series === null) delete map[kind];
    else map[kind] = series;
    return { ...form, current: normalizeDefaults({ ...form.current, preferredSeriesByKind: map }) };
  },
  setReminderPolicy: (form: OverrideForm, policy: ReminderPolicy): OverrideForm => ({
    ...form,
    current: normalizeDefaults({ ...form.current, reminderPolicy: policy }),
  }),
  isOverridden: (form: OverrideForm, field: OverrideFieldKey): boolean =>
    form.current[field] !== undefined,
  /** Fields whose value differs from the loaded one. */
  dirtyFields: (form: OverrideForm): ReadonlyArray<OverrideFieldKey> => {
    const keys: ReadonlyArray<OverrideFieldKey> = [
      "currency",
      "language",
      "dueDays",
      "paymentMethod",
      "preferredSeriesByKind",
      "defaultNote",
      "reminderPolicy",
    ];
    return Arr.filter(keys, (k) => !deepEqual(form.initial[k], form.current[k]));
  },
  isDirty: (form: OverrideForm): boolean => OverrideForm.dirtyFields(form).length > 0,
  /** `ContactInput.defaults` to send: only the fields this Contact overrides. */
  toInput: (form: OverrideForm): ContactDefaults => normalizeDefaults(form.current),
};
