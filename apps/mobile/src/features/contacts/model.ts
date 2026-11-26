import type {
  ContactDefaults,
  ContactId,
  ContactInput,
  ContactRole,
  ContactView,
  CurrencyCode,
  Locale,
  Page,
  PaymentMethod,
  RegistryResult,
  ReminderPolicy,
  WorkspaceId,
  WorkspaceSummary,
} from "@kvitbit/domain/contract";
import { ifMatchHeaders, inWorkspace, type KvitbitApiClient } from "@kvitbit/ui-port/api";
import { normalizeIco, normalizeVatId, validateIco } from "@kvitbit/ui-port/format";
import { OverrideForm } from "@kvitbit/ui-port/view-models";
import { BigDecimal, Effect, Result } from "effect";
import { canWriteWorkspace } from "../dashboard/model";
import type { ReceivablesReportData } from "../reports/model";

export interface ContactAddressRecord {
  readonly street: string | null;
  readonly city: string | null;
  readonly postalCode: string | null;
  readonly country: string;
}

export interface ContactRecord {
  readonly id: ContactId;
  readonly roles: readonly [ContactRole, ...Array<ContactRole>];
  readonly name: string;
  readonly ico: string | null;
  readonly dic: string | null;
  readonly legalForm: string | null;
  readonly address: ContactAddressRecord;
  readonly billingEmails: ReadonlyArray<string>;
  readonly phone: string | null;
  readonly note: string | null;
  readonly defaults: ContactDefaults;
  readonly registryFetchedAt: string | null;
  readonly archived: boolean;
  readonly revision: number;
}

export interface ContactFormState {
  readonly editingRevision: number | null;
  readonly name: string;
  readonly roles: ReadonlyArray<ContactRole>;
  readonly ico: string;
  readonly dic: string;
  readonly legalForm: string;
  readonly street: string;
  readonly city: string;
  readonly postalCode: string;
  readonly country: string;
  readonly billingEmails: ReadonlyArray<string>;
  readonly phone: string;
  readonly note: string;
  readonly overrides: OverrideForm;
  readonly dueDaysText: string;
  readonly reminderOffsetsText: string;
}

export interface RegistryDiffItem {
  readonly field: "name" | "dic" | "legalForm" | "street" | "city" | "postalCode" | "country";
  readonly before: string | null;
  readonly after: string | null;
}

export interface RegistryPreview {
  readonly result: RegistryResult;
  readonly items: ReadonlyArray<RegistryDiffItem>;
  readonly contactId: ContactId;
  readonly revision: number;
}

export type ContactFormErrorCode =
  | "name_required"
  | "roles_required"
  | "ico_format"
  | "ico_checksum"
  | "country_invalid"
  | "due_days_invalid"
  | "reminder_offsets_invalid";

export const CONTACT_CURRENCIES: ReadonlyArray<CurrencyCode> = [
  "CZK" as CurrencyCode,
  "EUR" as CurrencyCode,
  "USD" as CurrencyCode,
  "GBP" as CurrencyCode,
];

export const CONTACT_LANGUAGES: ReadonlyArray<Locale> = ["cs", "en"];

export const CONTACT_PAYMENT_METHODS: ReadonlyArray<PaymentMethod> = [
  "bank_transfer",
  "cash",
  "card",
  "other",
];

export const COMMON_COUNTRIES = ["CZ", "SK", "DE", "AT", "PL"] as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COUNTRY_RE = /^[A-Z]{2}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asNullableString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const asRoles = (value: unknown): readonly [ContactRole, ...Array<ContactRole>] => {
  if (!Array.isArray(value)) return ["customer"];
  const valid = value.filter((v): v is ContactRole => v === "customer" || v === "supplier");
  const [first, ...rest] = [...new Set(valid)];
  return first === undefined ? ["customer"] : [first, ...rest];
};

/** Parses the open `ContactView` wire object into a concrete `ContactRecord`. */
export const parseContactView = (raw: ContactView | unknown): ContactRecord | null => {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? (raw.id as ContactId) : null;
  const name = typeof raw.name === "string" ? raw.name : null;
  const revision = typeof raw.revision === "number" ? raw.revision : null;
  if (id === null || name === null || revision === null) return null;

  const addr = isRecord(raw.address) ? raw.address : {};
  const country =
    typeof addr.country === "string" && COUNTRY_RE.test(addr.country.toUpperCase())
      ? addr.country.toUpperCase()
      : "CZ";
  const billingEmails = Array.isArray(raw.billingEmails)
    ? raw.billingEmails.filter((e): e is string => typeof e === "string")
    : [];
  const defaults = isRecord(raw.defaults) ? (raw.defaults as ContactDefaults) : {};

  return {
    id,
    roles: asRoles(raw.roles),
    name,
    ico: asNullableString(raw.ico),
    dic: asNullableString(raw.dic),
    legalForm: asNullableString(raw.legalForm),
    address: {
      street: asNullableString(addr.street),
      city: asNullableString(addr.city),
      postalCode: asNullableString(addr.postalCode),
      country,
    },
    billingEmails,
    phone: asNullableString(raw.phone),
    note: asNullableString(raw.note),
    defaults,
    registryFetchedAt: asNullableString(raw.registryFetchedAt),
    archived: raw.archived === true,
    revision,
  };
};

export const parseContactViews = (
  items: ReadonlyArray<ContactView | unknown>,
): ReadonlyArray<ContactRecord> =>
  items.flatMap((item) => {
    const parsed = parseContactView(item);
    return parsed === null ? [] : [parsed];
  });

export const emptyContactForm = (): ContactFormState => ({
  editingRevision: null,
  name: "",
  roles: ["customer"],
  ico: "",
  dic: "",
  legalForm: "",
  street: "",
  city: "",
  postalCode: "",
  country: "CZ",
  billingEmails: [],
  phone: "",
  note: "",
  overrides: OverrideForm.init({}),
  dueDaysText: "",
  reminderOffsetsText: "",
});

export const contactFormFromRecord = (record: ContactRecord): ContactFormState => {
  const overrides = OverrideForm.init(record.defaults);
  const policy = overrides.current.reminderPolicy;
  return {
    editingRevision: record.revision,
    name: record.name,
    roles: [...record.roles],
    ico: record.ico ?? "",
    dic: record.dic ?? "",
    legalForm: record.legalForm ?? "",
    street: record.address.street ?? "",
    city: record.address.city ?? "",
    postalCode: record.address.postalCode ?? "",
    country: record.address.country,
    billingEmails: [...record.billingEmails],
    phone: record.phone ?? "",
    note: record.note ?? "",
    overrides,
    dueDaysText: overrides.current.dueDays !== undefined ? String(overrides.current.dueDays) : "",
    reminderOffsetsText: policy?.mode === "custom" ? policy.offsetsDays.join(", ") : "",
  };
};

export const canEditContact = (
  workspace: WorkspaceSummary,
  contact: ContactRecord | "new" | null,
): boolean => canWriteWorkspace(workspace) && (contact === "new" || contact?.archived === false);

const emptyToNull = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

/** Applies an ARES `RegistryResult` onto a form while keeping emails, roles, phone, note, and defaults. */
export const applyRegistryToForm = (
  form: ContactFormState,
  result: RegistryResult,
): ContactFormState => {
  const country = COUNTRY_RE.test(result.address.country.trim().toUpperCase())
    ? result.address.country.trim().toUpperCase()
    : "CZ";
  return {
    ...form,
    name: result.name.trim(),
    ico: normalizeIco(result.ico),
    dic: result.dic?.trim() ?? "",
    legalForm: result.legalForm.trim(),
    street: result.address.street.trim(),
    city: result.address.city.trim(),
    postalCode: result.address.postalCode.trim(),
    country,
  };
};

/** Computes changed fields between a stored contact and a fresh ARES lookup for diff preview. */
export const diffContactWithRegistry = (
  record: ContactRecord,
  result: RegistryResult,
): ReadonlyArray<RegistryDiffItem> => {
  const nextCountry = COUNTRY_RE.test(result.address.country.trim().toUpperCase())
    ? result.address.country.trim().toUpperCase()
    : "CZ";
  const pairs: ReadonlyArray<RegistryDiffItem> = [
    { field: "name", before: record.name, after: emptyToNull(result.name) ?? record.name },
    {
      field: "dic",
      before: record.dic,
      after: result.dic === null ? record.dic : (emptyToNull(result.dic) ?? record.dic),
    },
    { field: "legalForm", before: record.legalForm, after: emptyToNull(result.legalForm) },
    { field: "street", before: record.address.street, after: emptyToNull(result.address.street) },
    { field: "city", before: record.address.city, after: emptyToNull(result.address.city) },
    {
      field: "postalCode",
      before: record.address.postalCode,
      after: emptyToNull(result.address.postalCode),
    },
    { field: "country", before: record.address.country, after: nextCountry },
  ];
  return pairs.filter((item) => item.before !== item.after);
};

export const isValidEmail = (email: string): boolean => EMAIL_RE.test(email.trim());

/** Parses comma-separated non-negative integers (e.g. `"3, 7, 14"`). Empty returns `[]`; bad input returns `null`. */
export const parseReminderOffsets = (text: string): ReadonlyArray<number> | null => {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  const parts = trimmed.split(",").map((p) => p.trim());
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isSafeInteger(n) || n < 0) return null;
    out.push(n);
  }
  return out;
};

/** Validates client-side contact fields before submitting. */
export const validateContactForm = (
  form: ContactFormState,
): Readonly<Partial<Record<string, ContactFormErrorCode>>> => {
  const errors: Partial<Record<string, ContactFormErrorCode>> = {};
  if (form.name.trim() === "") errors.name = "name_required";
  if (form.roles.length === 0) errors.roles = "roles_required";

  const country = form.country.trim().toUpperCase();
  if (!COUNTRY_RE.test(country)) errors["address.country"] = "country_invalid";

  const icoTrimmed = form.ico.trim();
  if (icoTrimmed !== "") {
    const check = validateIco(icoTrimmed);
    if (Result.isFailure(check)) {
      errors.ico = check.failure.code === "ico.checksum" ? "ico_checksum" : "ico_format";
    }
  }

  const dueTrimmed = form.dueDaysText.trim();
  if (dueTrimmed !== "") {
    if (!/^\d+$/.test(dueTrimmed)) {
      errors["defaults.dueDays"] = "due_days_invalid";
    }
  }

  if (form.overrides.current.reminderPolicy?.mode === "custom") {
    const offsets = parseReminderOffsets(form.reminderOffsetsText);
    if (offsets === null || offsets.length === 0) {
      errors["defaults.reminderPolicy"] = "reminder_offsets_invalid";
    }
  }

  return errors;
};

/** Builds the `ContactInput` wire payload matching core's `ContactSaveFields`. */
export const buildContactInput = (form: ContactFormState): ContactInput => {
  const country = form.country.trim().toUpperCase() || "CZ";
  const icoRaw = form.ico.trim();
  const ico = icoRaw === "" ? null : normalizeIco(icoRaw);
  const dicRaw = form.dic.trim();
  const dic = dicRaw === "" ? null : normalizeVatId(dicRaw);

  let overrides = form.overrides;
  const dueTrimmed = form.dueDaysText.trim();
  if (dueTrimmed === "") {
    overrides = OverrideForm.clear(overrides, "dueDays");
  } else if (/^\d+$/.test(dueTrimmed)) {
    overrides = OverrideForm.set(overrides, "dueDays", Number(dueTrimmed));
  }

  if (overrides.current.reminderPolicy?.mode === "custom") {
    const parsed = parseReminderOffsets(form.reminderOffsetsText);
    const policy: ReminderPolicy = { mode: "custom", offsetsDays: parsed ?? [] };
    overrides = OverrideForm.setReminderPolicy(overrides, policy);
  }

  const roles = asRoles(form.roles);

  return {
    roles: [...roles],
    name: form.name.trim(),
    ico,
    dic,
    legalForm: emptyToNull(form.legalForm),
    address: {
      street: emptyToNull(form.street),
      city: emptyToNull(form.city),
      postalCode: emptyToNull(form.postalCode),
      country,
    },
    billingEmails: form.billingEmails.map((e) => e.trim()).filter((e) => e !== ""),
    phone: emptyToNull(form.phone),
    note: emptyToNull(form.note),
    defaults: OverrideForm.toInput(overrides),
  };
};

export const filterVisibleContacts = (
  items: ReadonlyArray<ContactRecord>,
  showArchived: boolean,
): ReadonlyArray<ContactRecord> => (showArchived ? items : items.filter((c) => !c.archived));

export const contactSubtitle = (contact: ContactRecord): string => {
  const parts: string[] = [];
  if (contact.ico !== null) parts.push(`IČO ${contact.ico}`);
  if (contact.address.city !== null) parts.push(contact.address.city);
  const firstEmail = contact.billingEmails[0];
  if (firstEmail !== undefined) parts.push(firstEmail);
  return parts.join(" · ");
};

const registryContactPatch = (items: ReadonlyArray<RegistryDiffItem>): ContactInput => {
  const patch: Record<string, string | null> = {};
  const address: Record<string, string | null> = {};
  for (const { field, after } of items) {
    const target = field === "name" || field === "dic" || field === "legalForm" ? patch : address;
    target[field] = after;
  }
  return Object.keys(address).length === 0 ? patch : { ...patch, address };
};

export const applyRegistryPreview = (
  contacts: Pick<KvitbitApiClient["contacts"], "update">,
  workspaceId: WorkspaceId,
  preview: RegistryPreview,
) =>
  contacts.update({
    params: inWorkspace(workspaceId, { contactId: preview.contactId }),
    headers: ifMatchHeaders(preview.revision),
    payload: registryContactPatch(preview.items),
  });

export const findActiveContactByIco = <E>(
  ico: string,
  excludedId: ContactId | null,
  loadPage: (cursor: string | null) => Effect.Effect<Page<ContactView>, E>,
) =>
  Effect.gen(function* () {
    let cursor: string | null = null;
    do {
      const page: Page<ContactView> = yield* loadPage(cursor);
      const match = parseContactViews(page.items).find(
        (contact) => !contact.archived && contact.ico === ico && contact.id !== excludedId,
      );
      if (match !== undefined) return match;
      cursor = page.nextCursor;
    } while (cursor !== null);
    return null;
  });

export const summarizeContactReceivables = (
  report: ReceivablesReportData,
  contactId: ContactId,
) => {
  let outstanding = BigDecimal.fromBigInt(0n);
  let overdueCount = 0;
  for (const bucket of report.buckets) {
    for (const row of bucket.documents) {
      if (row.contact.id !== contactId) continue;
      outstanding = BigDecimal.sum(
        outstanding,
        BigDecimal.fromStringUnsafe(row.outstandingCzk.amount),
      );
      if (row.daysOverdue > 0) overdueCount += 1;
    }
  }
  return { outstanding: { amount: outstanding, currency: report.total.currency }, overdueCount };
};
