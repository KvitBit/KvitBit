/**
 * Contact rows, the concrete Contact view and the save input (core-ports 4.2). The domain leaves
 * particulars open (`ContactInput`/`ContactView` are `OpenStruct`s); the fields here follow the
 * `contacts` table of packages/db. VAT-payer status is never inferred from a DIČ, so the view
 * carries no VAT-payer flag at all.
 */
import type { ContactRole } from "@kvitbit/domain/contract";
import {
  ContactDefaults,
  ContactId as ContactIdSchema,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import * as Schema from "effect/Schema";

const ContactRoleSchema = Schema.Literals(["customer", "supplier"]);

const OptionalText = Schema.NullOr(Schema.String);
/** A trimmed, non-empty name. */
const Name = Schema.Trimmed.pipe(Schema.check(Schema.isMinLength(1)));
const Email = Schema.String.pipe(Schema.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)));
/** ISO 3166-1 alpha-2. */
const Country = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Z]{2}$/)));

export const ContactAddress = Schema.Struct({
  street: OptionalText,
  city: OptionalText,
  postalCode: OptionalText,
  country: Country,
});
export type ContactAddress = typeof ContactAddress.Type;

/** Particulars and overrides, as stored and as echoed by the view. */
const ContactFields = {
  roles: Schema.NonEmptyArray(ContactRoleSchema),
  name: Name,
  ico: OptionalText,
  /** DIČ (VAT ID) as given; never read as proof of VAT-payer status. */
  dic: OptionalText,
  legalForm: OptionalText,
  address: ContactAddress,
  billingEmails: Schema.Array(Email),
  phone: OptionalText,
  note: OptionalText,
  defaults: ContactDefaults,
  /** When particulars were last taken from the company registry (`fromIco`). */
  registryFetchedAt: OptionalText,
};

export const ContactRowSchema = Schema.Struct({
  id: ContactIdSchema,
  workspaceId: WorkspaceId,
  revision: Schema.Int,
  ...ContactFields,
  archivedAt: OptionalText,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type ContactRow = typeof ContactRowSchema.Type;

/** The concrete `ContactView`: stored particulars and overrides (rule C4) plus `revision`. */
export const ContactViewSchema = Schema.Struct({
  id: ContactIdSchema,
  ...ContactFields,
  archived: Schema.Boolean,
  revision: Schema.Int,
});
export type ContactViewData = typeof ContactViewSchema.Type;

export const toContactView = (row: ContactRow): ContactViewData => ({
  id: row.id,
  roles: row.roles,
  name: row.name,
  ico: row.ico,
  dic: row.dic,
  legalForm: row.legalForm,
  address: row.address,
  billingEmails: row.billingEmails,
  phone: row.phone,
  note: row.note,
  defaults: row.defaults,
  registryFetchedAt: row.registryFetchedAt,
  archived: row.archivedAt !== null,
  revision: row.revision,
});

/**
 * The open fields of `ContactInput` that `save` reads. Every field is optional: on create an
 * absent field takes its default (`roles` `["customer"]`, `country` `"CZ"`, others empty) and
 * `name` is required; on an existing Contact an absent field keeps its stored value, `null`
 * clears it, and `defaults`, when given, replaces the whole override set (an override left out
 * falls back to the Workspace).
 */
export const ContactSaveFields = Schema.Struct({
  roles: ContactRoleSchema.pipe(Schema.NonEmptyArray, Schema.optional),
  name: Schema.optional(Name),
  ico: Schema.optional(OptionalText),
  dic: Schema.optional(OptionalText),
  legalForm: Schema.optional(OptionalText),
  address: Schema.optional(
    Schema.Struct({
      street: Schema.optional(OptionalText),
      city: Schema.optional(OptionalText),
      postalCode: Schema.optional(OptionalText),
      country: Schema.optional(Country),
    }),
  ),
  billingEmails: Email.pipe(Schema.Array, Schema.optional),
  phone: Schema.optional(OptionalText),
  note: Schema.optional(OptionalText),
  defaults: Schema.optional(ContactDefaults),
});
export type ContactSaveFields = typeof ContactSaveFields.Type;

/** The whole `save` input, decoded strictly (unknown fields are Invalid). */
export const ContactSaveInput = Schema.Struct({
  ...ContactSaveFields.fields,
  id: Schema.optional(ContactIdSchema),
  expectedRevision: Schema.optional(Schema.Int),
});

/** What `save` fingerprints for its request key (rule C3). */
export const ContactSavePayload = Schema.Struct({
  fields: ContactSaveFields,
  id: Schema.optional(ContactIdSchema),
  expectedRevision: Schema.optional(Schema.Int),
});

/** Roles without duplicates, in first-seen order. */
export const uniqueRoles = (
  roles: ReadonlyArray<ContactRole>,
): readonly [ContactRole, ...Array<ContactRole>] => {
  const [first, ...rest] = [...new Set(roles)];
  return first === undefined ? ["customer"] : [first, ...rest];
};

/** `reminderPolicy` absent behaves as inherit (core-ports 4.2); it is stored explicitly. */
export const normalizeDefaults = (defaults: ContactDefaults | undefined): ContactDefaults => ({
  ...defaults,
  reminderPolicy: defaults?.reminderPolicy ?? { mode: "inherit" },
});
