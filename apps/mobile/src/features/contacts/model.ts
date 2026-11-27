import {
  ContactDefaults,
  ContactId,
  type ContactInput,
  type ContactRole,
  type ContactView,
  CurrencyCode,
  type Locale,
  type Page,
  type PaymentMethod,
  type RegistryResult,
  type ReminderPolicy,
  type WorkspaceId,
  type WorkspaceSummary,
} from "@kvitbit/domain/contract";
import {
  ifMatchHeaders,
  inWorkspace,
  type KvitbitApiClient,
  Paged,
  type Paged as PagedState,
} from "@kvitbit/ui-port/api";
import { normalizeIco, normalizeVatId, validateIco } from "@kvitbit/ui-port/format";
import { OverrideForm } from "@kvitbit/ui-port/view-models";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { canWriteWorkspace } from "../dashboard/model";
import type { ReceivablesReportData } from "../reports/model";

interface ContactAddressRecord {
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
  CurrencyCode.make("CZK"),
  CurrencyCode.make("EUR"),
  CurrencyCode.make("USD"),
  CurrencyCode.make("GBP"),
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
const WHOLE_NUMBER_RE = /^\d+$/;

const decodeContact = Schema.decodeUnknownOption(
  Schema.Struct({
    id: ContactId,
    name: Schema.String,
    revision: Schema.Finite,
    address: Schema.optional(Schema.Unknown),
    roles: Schema.optional(Schema.Unknown),
    ico: Schema.optional(Schema.Unknown),
    dic: Schema.optional(Schema.Unknown),
    legalForm: Schema.optional(Schema.Unknown),
    billingEmails: Schema.optional(Schema.Unknown),
    phone: Schema.optional(Schema.Unknown),
    note: Schema.optional(Schema.Unknown),
    defaults: Schema.optional(Schema.Unknown),
    registryFetchedAt: Schema.optional(Schema.Unknown),
    archived: Schema.optional(Schema.Unknown),
  }),
);
const decodeAddress = Schema.decodeUnknownOption(
  Schema.Struct({
    street: Schema.optional(Schema.Unknown),
    city: Schema.optional(Schema.Unknown),
    postalCode: Schema.optional(Schema.Unknown),
    country: Schema.optional(Schema.Unknown),
  }),
);
const decodeString = Schema.decodeUnknownOption(Schema.String);
const asNullableString = Fn.flow(
  decodeString,
  Option.filter((value) => Str.trim(value) !== ""),
  Option.getOrNull,
);
const decodeRole = Schema.decodeUnknownOption(Schema.Literals(["customer", "supplier"]));
const decodeDefaults = Schema.decodeUnknownOption(ContactDefaults);

const nonEmptyRoles = (
  roles: ReadonlyArray<ContactRole>,
): readonly [ContactRole, ...ContactRole[]] => {
  const [first, ...rest] = [...new Set(roles)];
  return first === undefined ? ["customer"] : [first, ...rest];
};

/** Parses the open Contact View payload into the fields the screens use. */
export const parseContactView = Fn.flow(
  decodeContact,
  Option.map((row): ContactRecord => {
    const address = Option.getOrUndefined(decodeAddress(row.address));
    const countryCode = Str.toUpperCase(asNullableString(address?.country) ?? "");
    const roles = Arr.isArray(row.roles)
      ? Arr.flatMap(row.roles, (value) => {
          const role = decodeRole(value);
          return role._tag === "Some" ? [role.value] : [];
        })
      : [];
    const billingEmails = Arr.isArray(row.billingEmails)
      ? Arr.flatMap(row.billingEmails, (value) => {
          const email = decodeString(value);
          return email._tag === "Some" ? [email.value] : [];
        })
      : [];
    return {
      id: row.id,
      name: row.name,
      revision: row.revision,
      roles: nonEmptyRoles(roles),
      ico: asNullableString(row.ico),
      dic: asNullableString(row.dic),
      legalForm: asNullableString(row.legalForm),
      address: {
        street: asNullableString(address?.street),
        city: asNullableString(address?.city),
        postalCode: asNullableString(address?.postalCode),
        country: COUNTRY_RE.test(countryCode) ? countryCode : "CZ",
      },
      billingEmails,
      phone: asNullableString(row.phone),
      note: asNullableString(row.note),
      defaults: Option.getOrElse(decodeDefaults(row.defaults), (): ContactDefaults => ({})),
      registryFetchedAt: asNullableString(row.registryFetchedAt),
      archived: row.archived === true,
    };
  }),
  Option.getOrNull,
);

export const parseContactViews = (
  items: ReadonlyArray<ContactView>,
): ReadonlyArray<ContactRecord> =>
  Arr.flatMap(items, (item) => {
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
    reminderOffsetsText:
      policy?.mode === "custom" ? Arr.join(Arr.map(policy.offsetsDays, String), ", ") : "",
  };
};

export const canEditContact: {
  (contact: ContactRecord | "new" | null): (workspace: WorkspaceSummary) => boolean;
  (workspace: WorkspaceSummary, contact: ContactRecord | "new" | null): boolean;
} = Fn.dual(
  2,
  (workspace: WorkspaceSummary, contact: ContactRecord | "new" | null): boolean =>
    canWriteWorkspace(workspace) && (contact === "new" || contact?.archived === false),
);

const emptyToNull = (value: string): string | null => {
  const trimmed = Str.trim(value);
  return trimmed === "" ? null : trimmed;
};

/** Applies an ARES `RegistryResult` onto a form while keeping emails, roles, phone, note, and defaults. */
export const applyRegistryToForm: {
  (result: RegistryResult): (form: ContactFormState) => ContactFormState;
  (form: ContactFormState, result: RegistryResult): ContactFormState;
} = Fn.dual(2, (form: ContactFormState, result: RegistryResult): ContactFormState => {
  const country = COUNTRY_RE.test(Str.toUpperCase(Str.trim(result.address.country)))
    ? Str.toUpperCase(Str.trim(result.address.country))
    : "CZ";
  return {
    ...form,
    name: Str.trim(result.name),
    ico: normalizeIco(result.ico),
    dic: Str.trim(result.dic ?? ""),
    legalForm: Str.trim(result.legalForm),
    street: Str.trim(result.address.street),
    city: Str.trim(result.address.city),
    postalCode: Str.trim(result.address.postalCode),
    country,
  };
});

/** Computes changed fields between a stored contact and a fresh ARES lookup for diff preview. */
export const diffContactWithRegistry: {
  (result: RegistryResult): (record: ContactRecord) => ReadonlyArray<RegistryDiffItem>;
  (record: ContactRecord, result: RegistryResult): ReadonlyArray<RegistryDiffItem>;
} = Fn.dual(2, (record: ContactRecord, result: RegistryResult): ReadonlyArray<RegistryDiffItem> => {
  const nextCountry = COUNTRY_RE.test(Str.toUpperCase(Str.trim(result.address.country)))
    ? Str.toUpperCase(Str.trim(result.address.country))
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
  return Arr.filter(pairs, (item) => item.before !== item.after);
});

export const isValidEmail = (email: string): boolean => EMAIL_RE.test(Str.trim(email));

/** Parses comma-separated non-negative integers (e.g. `"3, 7, 14"`). Empty returns `[]`; bad input returns `null`. */
export const parseReminderOffsets = (text: string): ReadonlyArray<number> | null => {
  const trimmed = Str.trim(text);
  if (trimmed === "") return [];
  const parts = Arr.map(Str.split(",")(trimmed), (p) => Str.trim(p));
  const out: number[] = [];
  for (const part of parts) {
    if (!WHOLE_NUMBER_RE.test(part)) return null;
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
  if (Str.trim(form.name) === "") errors.name = "name_required";
  if (form.roles.length === 0) errors.roles = "roles_required";

  const country = Str.toUpperCase(Str.trim(form.country));
  if (!COUNTRY_RE.test(country)) errors["address.country"] = "country_invalid";

  const icoTrimmed = Str.trim(form.ico);
  if (icoTrimmed !== "") {
    const check = validateIco(icoTrimmed);
    if (Result.isFailure(check)) {
      errors.ico = check.failure.code === "ico.checksum" ? "ico_checksum" : "ico_format";
    }
  }

  const dueTrimmed = Str.trim(form.dueDaysText);
  if (dueTrimmed !== "" && !WHOLE_NUMBER_RE.test(dueTrimmed)) {
    errors["defaults.dueDays"] = "due_days_invalid";
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
  const country = Str.toUpperCase(Str.trim(form.country)) || "CZ";
  const icoRaw = Str.trim(form.ico);
  const ico = icoRaw === "" ? null : normalizeIco(icoRaw);
  const dicRaw = Str.trim(form.dic);
  const dic = dicRaw === "" ? null : normalizeVatId(dicRaw);

  let overrides = form.overrides;
  const dueTrimmed = Str.trim(form.dueDaysText);
  if (dueTrimmed === "") {
    overrides = OverrideForm.clear(overrides, "dueDays");
  } else if (WHOLE_NUMBER_RE.test(dueTrimmed)) {
    overrides = OverrideForm.set(overrides, "dueDays", Number(dueTrimmed));
  }

  if (overrides.current.reminderPolicy?.mode === "custom") {
    const parsed = parseReminderOffsets(form.reminderOffsetsText);
    const policy: ReminderPolicy = { mode: "custom", offsetsDays: parsed ?? [] };
    overrides = OverrideForm.setReminderPolicy(overrides, policy);
  }

  const roles = nonEmptyRoles(Arr.sort(form.roles, Order.String));

  return {
    roles: [...roles],
    name: Str.trim(form.name),
    ico,
    dic,
    legalForm: emptyToNull(form.legalForm),
    address: {
      street: emptyToNull(form.street),
      city: emptyToNull(form.city),
      postalCode: emptyToNull(form.postalCode),
      country,
    },
    billingEmails: Arr.filter(
      Arr.map(form.billingEmails, (e) => Str.trim(e)),
      (e) => e !== "",
    ),
    phone: emptyToNull(form.phone),
    note: emptyToNull(form.note),
    defaults: OverrideForm.toInput(overrides),
  };
};

export const filterVisibleContacts: {
  (showArchived: boolean): (items: ReadonlyArray<ContactRecord>) => ReadonlyArray<ContactRecord>;
  (items: ReadonlyArray<ContactRecord>, showArchived: boolean): ReadonlyArray<ContactRecord>;
} = Fn.dual(
  2,
  (items: ReadonlyArray<ContactRecord>, showArchived: boolean): ReadonlyArray<ContactRecord> =>
    showArchived ? items : Arr.filter(items, (c) => !c.archived),
);

export const contactSubtitle = (contact: ContactRecord): string => {
  const parts: string[] = [];
  if (contact.ico !== null) parts.push(`IČO ${contact.ico}`);
  if (contact.address.city !== null) parts.push(contact.address.city);
  const firstEmail = contact.billingEmails[0];
  if (firstEmail !== undefined) parts.push(firstEmail);
  return Arr.join(parts, " · ");
};

const registryContactPatch = (items: ReadonlyArray<RegistryDiffItem>): ContactInput => {
  const patch: Record<string, string | null> = {};
  const address: Record<string, string | null> = {};
  for (const { field, after } of items) {
    const target = field === "name" || field === "dic" || field === "legalForm" ? patch : address;
    target[field] = after;
  }
  return Rec.keys(address).length === 0 ? patch : { ...patch, address };
};

export const applyRegistryPreview = ({
  contacts,
  workspaceId,
  preview,
}: {
  readonly contacts: Pick<KvitbitApiClient["contacts"], "update">;
  readonly workspaceId: WorkspaceId;
  readonly preview: RegistryPreview;
}) =>
  contacts.update({
    params: inWorkspace(workspaceId, { contactId: preview.contactId }),
    headers: ifMatchHeaders(preview.revision),
    payload: registryContactPatch(preview.items),
  });

export const findActiveContactByIco = Effect.fn("findActiveContactByIco")(function* <E>({
  ico,
  excludedId,
  loadPage,
}: {
  readonly ico: string;
  readonly excludedId: ContactId | null;
  readonly loadPage: (cursor: string | null) => Effect.Effect<Page<ContactView>, E>;
}) {
  let cursor: string | null = null;
  do {
    const page: Page<ContactView> = yield* loadPage(cursor);
    const match = Option.getOrUndefined(
      Arr.findFirst(
        parseContactViews(page.items),
        (contact) => !contact.archived && contact.ico === ico && contact.id !== excludedId,
      ),
    );
    if (match !== undefined) return match;
    cursor = page.nextCursor;
  } while (cursor !== null);
  return null;
});

export const summarizeContactReceivables = ({
  report,
  contactId,
}: {
  readonly report: ReceivablesReportData;
  readonly contactId: ContactId;
}) => {
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

export interface ContactQuery {
  readonly text?: string;
  readonly role?: ContactRole;
}

export const loadContactsQuery = ({
  current,
  query,
}: {
  readonly current: PagedState<ContactRecord, ContactQuery>;
  readonly query: ContactQuery;
}) => {
  const step = Paged.setQuery(current, query);
  return step.fetch === null && current.seq === 1 ? Paged.refresh(current) : step;
};
