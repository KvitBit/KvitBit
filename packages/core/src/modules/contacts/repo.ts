/**
 * `ContactsRepo`: the Contacts module's repository port (conventions in src/store/tables.ts) and
 * its in-memory implementation on `MemoryTables`.
 */

import type {
  Conflict,
  ContactId,
  ContactRole,
  NotFound,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import * as EffectString from "effect/String";
import type { StoreUnavailable, UniqueViolation } from "../../store/CoreStore";
import { defineCollection, MemoryTables } from "../../store/tables";
import { foldText } from "./input";
import type { ContactRow } from "./model";
import { ContactRowSchema } from "./model";

/** IČO is unique per Workspace among active Contacts (core-ports 4.2). */
export const CONTACTS_ACTIVE_ICO_UNIQUE = "contacts_active_ico_unique";

export const ContactsTable = defineCollection<ContactRow>({
  name: "contacts",
  entity: "Contact",
  schema: ContactRowSchema,
  unique: [
    {
      name: CONTACTS_ACTIVE_ICO_UNIQUE,
      scope: "workspace",
      key: (c) => (c.archivedAt === null && c.ico !== null ? [c.ico] : null),
    },
  ],
});

export interface ContactSearch {
  /** Case- and diacritics-insensitive substring of name, IČO, DIČ or a billing email. */
  readonly text?: string | undefined;
  readonly role?: ContactRole | undefined;
  /** Keyset: the `(name, id)` of the last row of the previous page. */
  readonly after?: readonly [name: string, id: string] | undefined;
  readonly limit: number;
}

export class ContactsRepo extends Context.Service<
  ContactsRepo,
  {
    readonly get: (
      workspaceId: WorkspaceId,
      id: ContactId,
    ) => Effect.Effect<ContactRow, NotFound | StoreUnavailable>;
    readonly getForUpdate: (
      workspaceId: WorkspaceId,
      id: ContactId,
      expectedRevision: number,
    ) => Effect.Effect<ContactRow, NotFound | Conflict | StoreUnavailable>;
    readonly lock: (
      workspaceId: WorkspaceId,
      id: ContactId,
    ) => Effect.Effect<ContactRow, NotFound | StoreUnavailable>;
    /** The active (not archived) Contact with this IČO. */
    readonly findActiveByIco: (
      workspaceId: WorkspaceId,
      ico: string,
    ) => Effect.Effect<Option.Option<ContactRow>, StoreUnavailable>;
    readonly insert: (
      row: ContactRow,
    ) => Effect.Effect<ContactRow, UniqueViolation | StoreUnavailable>;
    readonly update: (
      next: ContactRow,
      expectedRevision: number,
    ) => Effect.Effect<ContactRow, NotFound | Conflict | UniqueViolation | StoreUnavailable>;
    /** Active Contacts matching the filter, by name then id ascending. */
    readonly search: (
      workspaceId: WorkspaceId,
      query: ContactSearch,
    ) => Effect.Effect<ReadonlyArray<ContactRow>, StoreUnavailable>;
  }
>()("@kvitbit/core/modules/contacts/repo/ContactsRepo") {}

const matchesText = (row: ContactRow, folded: string): boolean =>
  EffectArray.some(
    [row.name, row.ico, row.dic, ...row.billingEmails],
    (value) => value !== null && EffectString.includes(folded)(foldText(value)),
  );

/** `ContactsRepo` on `MemoryTables` (tests and the in-memory composition). */
export const ContactsRepoMemory: Layer.Layer<ContactsRepo, never, MemoryTables> = Layer.effect(
  ContactsRepo,
  Effect.gen(function* () {
    const table = (yield* MemoryTables).collection(ContactsTable);
    return {
      get: Effect.fn("ContactsRepo.get")((workspaceId, id) => table.get(workspaceId, id)),
      getForUpdate: Effect.fn("ContactsRepo.getForUpdate")((workspaceId, id, expectedRevision) =>
        table.getForUpdate(workspaceId, id, expectedRevision),
      ),
      lock: Effect.fn("ContactsRepo.lock")((workspaceId, id) => table.lock(workspaceId, id)),
      findActiveByIco: Effect.fn("contacts.activeByIco")((workspaceId, ico) =>
        table.findUnique(CONTACTS_ACTIVE_ICO_UNIQUE, [ico], workspaceId),
      ),
      insert: Effect.fn("ContactsRepo.insert")((row) => table.insert(row)),
      update: Effect.fn("ContactsRepo.update")((next, expectedRevision) =>
        table.update(next, expectedRevision),
      ),
      search: Effect.fn("ContactsRepo.search")((workspaceId, query) =>
        Effect.map(
          table.list(
            workspaceId,
            query.after === undefined
              ? { where: { archivedAt: null }, orderBy: ["name"] }
              : { where: { archivedAt: null }, orderBy: ["name"], after: query.after },
          ),
          (rows) => {
            const folded = query.text === undefined ? "" : foldText(query.text);
            return EffectArray.filter(
              rows,
              (row) =>
                (query.role === undefined || row.roles.includes(query.role)) &&
                (folded === "" || matchesText(row, folded)),
            ).slice(0, query.limit);
          },
        ),
      ),
    };
  }),
);
