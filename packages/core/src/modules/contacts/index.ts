/** Contacts module (core-ports 4.2). The parent wires `ContactsLive` into the core composition. */
import * as Layer from "effect/Layer";
import { RegistryLookup } from "../workspaces/registry";
import { ContactsLive } from "./live";
import { ContactsRepoMemory } from "./repo";
import { FakeContactSeries } from "./series";
import { ContactSnapshotsLive } from "./snapshots";

export type { ContactsImpl } from "./live";
export { CONTACT_PAGE_MAX, CONTACT_PAGE_SIZE, ContactsLive, makeContacts } from "./live";
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
export { ContactSeriesLookup, FakeContactSeries } from "./series";
export type { ContactForDocument, ContactPartySnapshot } from "./snapshots";
export { ContactSnapshots, ContactSnapshotsLive, toContactForDocument } from "./snapshots";

/**
 * Contacts on the in-memory repository, with `ContactSnapshots`, the memory repo and the
 * `FakeContactSeries` control (empty: seed series before saving preferred ones) exposed.
 * Provides its own `RegistryLookup` (tests only; production shares one with Workspaces).
 * Requires `InMemoryPortsLive` (CoreStore, MemoryTables, IdGenerator, CompanyRegistry).
 */
export const ContactsTestLayer = Layer.mergeAll(ContactsLive, ContactSnapshotsLive).pipe(
  Layer.provideMerge(Layer.merge(ContactsRepoMemory, FakeContactSeries.layer)),
  Layer.provide(RegistryLookup.layer),
);
