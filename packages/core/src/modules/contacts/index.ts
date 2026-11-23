/** Contacts module (core-ports 4.2). The parent wires `ContactsLive` into the core composition. */
import { Layer } from "effect";
import { RegistryLookup } from "../workspaces/registry";
import { ContactsLive } from "./live";
import { ContactsRepoMemory } from "./repo";
import { ContactSnapshotsLive } from "./snapshots";

export type { ContactsImpl } from "./live";
export { CONTACT_PAGE_SIZE, ContactsLive, makeContacts } from "./live";
export type {
  ContactAddress,
  ContactRow,
  ContactSaveFields,
  ContactViewData,
} from "./model";
export {
  ContactRowSchema,
  ContactSaveFields as ContactSaveFieldsSchema,
  ContactViewSchema,
  toContactView,
} from "./model";
export type { ContactSearch } from "./repo";
export {
  CONTACTS_ACTIVE_ICO_UNIQUE,
  ContactsRepo,
  ContactsRepoMemory,
  ContactsTable,
} from "./repo";
export type { ContactForDocument, ContactPartySnapshot } from "./snapshots";
export { ContactSnapshots, ContactSnapshotsLive, toContactForDocument } from "./snapshots";

/**
 * Contacts on the in-memory repository, with `ContactSnapshots` and the memory repo exposed.
 * Provides its own `RegistryLookup` (tests only; production shares one with Workspaces).
 * Requires `InMemoryPortsLive` (CoreStore, MemoryTables, IdGenerator, CompanyRegistry).
 */
export const ContactsTestLayer = Layer.mergeAll(ContactsLive, ContactSnapshotsLive).pipe(
  Layer.provideMerge(ContactsRepoMemory),
  Layer.provide(RegistryLookup.layer),
);
