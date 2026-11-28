/** Contacts (core-ports 4.2) and PriceList (core-ports 4.3). Interfaces only. */

import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Caller } from "../caller";
import { ContactDefaults } from "../contact";
import type { Conflict, Forbidden, Invalid, NotFound, Unavailable } from "../errors";
import type { ContactId, PriceListItemId } from "../ids";
import { OpenStruct } from "../shared";
import type { Page, RequestOptions } from "../vocabulary";

/** Partly specified: particulars, VAT IDs and invoicing emails are not yet defined (open). */
export const ContactInput = OpenStruct({
  defaults: Schema.optional(ContactDefaults), // billing overrides, Document → Contact → Workspace
});
export type ContactInput = typeof ContactInput.Type;
export const ContactView = OpenStruct({
  defaults: ContactDefaults, // views echo the stored overrides (rule C4)
  revision: Schema.Int, // save (existing) takes expectedRevision (rule C2)
});
export type ContactView = typeof ContactView.Type;
export type ContactRole = "customer" | "supplier";

export class Contacts extends Context.Service<
  Contacts,
  {
    /** IČO in, saved Contact out: checksum, CompanyRegistry lookup, cache, upsert by IČO. */
    readonly fromIco: (
      caller: Caller,
      ico: string,
      opts?: { readonly role?: ContactRole },
    ) => Effect.Effect<ContactView, Invalid | NotFound | Unavailable | Forbidden>;
    readonly save: (
      caller: Caller,
      input: ContactInput & { readonly id?: ContactId; readonly expectedRevision?: number },
      opts?: RequestOptions,
    ) => Effect.Effect<ContactView, Invalid | NotFound | Conflict | Unavailable | Forbidden>;
    readonly archive: (
      caller: Caller,
      id: ContactId,
    ) => Effect.Effect<void, NotFound | Unavailable | Forbidden>;
    readonly get: (
      caller: Caller,
      id: ContactId,
    ) => Effect.Effect<ContactView, NotFound | Unavailable | Forbidden>;
    readonly search: (
      caller: Caller,
      q: {
        readonly text?: string;
        readonly role?: ContactRole;
        readonly cursor?: string;
        readonly limit?: number; // 1 to 100, default 50
      },
    ) => Effect.Effect<Page<ContactView>, Invalid | Unavailable | Forbidden>;
  }
>()("@kvitbit/domain/modules/contacts") {}

// biome-ignore lint/security/noSecrets: This literal names the Price List Item Input brand.
export const PriceListItemInput = Schema.Unknown.pipe(Schema.brand("PriceListItemInput"));
export type PriceListItemInput = typeof PriceListItemInput.Type;
/** Partly specified: only the revision used by save (existing) is fixed (open). */
export const PriceListItemView = OpenStruct({ revision: Schema.Int });
export type PriceListItemView = typeof PriceListItemView.Type;

/** A Price List Item only supplies defaults; lines copy its values when a document is drafted. */
export class PriceList extends Context.Service<
  PriceList,
  {
    readonly save: (
      caller: Caller,
      input: PriceListItemInput & {
        readonly id?: PriceListItemId;
        readonly expectedRevision?: number;
      },
      opts?: RequestOptions,
    ) => Effect.Effect<PriceListItemView, Invalid | NotFound | Conflict | Unavailable | Forbidden>;
    readonly archive: (
      caller: Caller,
      id: PriceListItemId,
    ) => Effect.Effect<void, NotFound | Unavailable | Forbidden>;
    readonly list: (
      caller: Caller,
      q?: {
        readonly text?: string;
        readonly includeArchived?: boolean;
      },
    ) => Effect.Effect<ReadonlyArray<PriceListItemView>, Unavailable | Forbidden>;
  }
>()("@kvitbit/domain/modules/contacts/PriceList") {}
