/**
 * `ContactSnapshots`: the narrow read port Documents uses to freeze a buyer's particulars and
 * resolve its overrides (core-ports 4.2, 4.4). It does not authorize: the calling Documents
 * method has already authorized its own action (e.g. `document.draft`) in the same Workspace,
 * and a token scoped to `documents` alone must still draft for a Contact (rule R1).
 */
import type {
  ContactDefaults,
  ContactId,
  ContactRole,
  NotFound,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { StoreUnavailable } from "../../store/CoreStore";
import type { ContactAddress, ContactRow } from "./model";
import { ContactsRepo } from "./repo";

/** Buyer particulars as printed on a document; frozen when the document is issued. */
export interface ContactPartySnapshot {
  readonly contactId: ContactId;
  readonly name: string;
  readonly ico: string | null;
  /** DIČ as stored; VAT-payer status is never inferred from it. */
  readonly dic: string | null;
  readonly legalForm: string | null;
  readonly address: ContactAddress;
}

export interface ContactForDocument {
  readonly party: ContactPartySnapshot;
  /** The Contact level of `resolveDocumentDefaults` / `resolveReminders` (`reminderPolicy` set). */
  readonly defaults: ContactDefaults;
  readonly roles: ReadonlyArray<ContactRole>;
  /** Default recipients of document emails. */
  readonly billingEmails: ReadonlyArray<string>;
  /** Archived Contacts keep their documents; whether new drafts may use them is Documents' rule. */
  readonly archived: boolean;
  readonly revision: number;
}

export const toContactForDocument = (row: ContactRow): ContactForDocument => ({
  party: {
    contactId: row.id,
    name: row.name,
    ico: row.ico,
    dic: row.dic,
    legalForm: row.legalForm,
    address: row.address,
  },
  defaults: row.defaults,
  roles: row.roles,
  billingEmails: row.billingEmails,
  archived: row.archivedAt !== null,
  revision: row.revision,
});

export class ContactSnapshots extends Context.Service<
  ContactSnapshots,
  {
    /** Another Workspace's Contact is `NotFound` (rule R2). Map `StoreUnavailable` with `orUnavailable`. */
    readonly forDocument: (
      workspaceId: WorkspaceId,
      id: ContactId,
    ) => Effect.Effect<ContactForDocument, NotFound | StoreUnavailable>;
  }
>()("@kvitbit/core/modules/contacts/snapshots/ContactSnapshots") {}

export const ContactSnapshotsLive: Layer.Layer<ContactSnapshots, never, ContactsRepo> =
  Layer.effect(
    ContactSnapshots,
    Effect.map(ContactsRepo, (repo) => ({
      forDocument: (workspaceId: WorkspaceId, id: ContactId) =>
        Effect.map(repo.get(workspaceId, id), toContactForDocument),
    })),
  );
