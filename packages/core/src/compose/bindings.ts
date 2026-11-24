/**
 * One-line adapters that bind each module's narrow seam port to the module that owns the data
 * (core-ports 10). Each is a `Layer` from the owning module's service or repository; none
 * authorizes (the calling method has), and each runs inside the caller's transaction.
 * Board agreements are cited per binding (channel kvitbit).
 */
import type { NumberingSeriesId, WorkspaceId } from "@kvitbit/domain/contract";
import { Contacts, CurrentCaller, NotFound } from "@kvitbit/domain/contract";
import { Effect, Layer } from "effect";
import type { ContactViewData } from "../modules/contacts";
import { ContactSeriesLookup, ContactSnapshots } from "../modules/contacts";
import {
  DeliveriesRepo,
  DocumentContacts,
  DocumentIssuers,
  DocumentPriceList,
  DocumentsRepo,
} from "../modules/documents";
import { ExpenseSuppliers, ExpensePayables as ExpensesPayables } from "../modules/expenses";
import { NumberingSeries, NumberingSeriesRepo } from "../modules/numbering";
import { ExpensePayables, PaymentSettings } from "../modules/payments";
import { PriceListItems } from "../modules/pricelist";
import { DeliveryStatusLookup, RecurringDocumentLink } from "../modules/recurring";
import { IssuerSnapshots, WorkspaceSeries, WorkspaceSnapshots } from "../modules/workspaces";
import { today } from "../modules/workspaces/rules";

/** Workspaces' series operations are the numbering module's (#335). */
export const WorkspaceSeriesLive: Layer.Layer<WorkspaceSeries, never, NumberingSeries> =
  Layer.effect(WorkspaceSeries, Effect.service(NumberingSeries));

/** Kind of each existing series of the Workspace, from the numbering repository (#389). */
export const ContactSeriesLookupLive: Layer.Layer<ContactSeriesLookup, never, NumberingSeriesRepo> =
  Layer.effect(
    ContactSeriesLookup,
    Effect.map(Effect.service(NumberingSeriesRepo), (repo) => ({
      kindsOf: (workspaceId: WorkspaceId, ids: ReadonlyArray<NumberingSeriesId>) =>
        Effect.map(repo.list(workspaceId), (rows) => {
          const wanted = new Set<string>(ids);
          return new Map(rows.filter((r) => wanted.has(r.id)).map((r) => [r.id, r.kind] as const));
        }),
    })),
  );

/** Documents read Contacts, Price List items and the Issuing Entity through identity's read ports (#402, #407, #418). */
export const DocumentContactsLive: Layer.Layer<DocumentContacts, never, ContactSnapshots> =
  Layer.effect(DocumentContacts, Effect.service(ContactSnapshots));

export const DocumentPriceListLive: Layer.Layer<DocumentPriceList, never, PriceListItems> =
  Layer.effect(DocumentPriceList, Effect.service(PriceListItems));

export const DocumentIssuersLive: Layer.Layer<DocumentIssuers, never, IssuerSnapshots> =
  Layer.effect(DocumentIssuers, Effect.service(IssuerSnapshots));

/** Payments' view of an Expense payable is the expenses module's (#395, #579). */
export const PaymentExpensePayablesLive: Layer.Layer<ExpensePayables, never, ExpensesPayables> =
  Layer.effect(ExpensePayables, Effect.service(ExpensesPayables));

/**
 * The Workspace setting `autoSendPaymentTaxDocument` (#581) from `WorkspaceSnapshots`, as of
 * today (Prague). Only the current Member or System caller's Workspace is visible (R2).
 */
export const PaymentSettingsLive: Layer.Layer<PaymentSettings, never, WorkspaceSnapshots> =
  Layer.effect(
    PaymentSettings,
    Effect.map(Effect.service(WorkspaceSnapshots), (snapshots) => ({
      autoSendPaymentTaxDocument: (workspaceId: WorkspaceId) =>
        Effect.gen(function* () {
          const caller = yield* CurrentCaller;
          const own =
            (caller._tag === "Member" || caller._tag === "System") &&
            caller.workspaceId === workspaceId;
          if (!own) return yield* new NotFound({ entity: "Workspace", id: workspaceId });
          const snapshot = yield* snapshots.get(workspaceId, yield* today);
          return snapshot.paymentTaxDocumentAutoSend;
        }),
    })),
  );

/**
 * Expenses link a supplier through the domain `Contacts` tag as the current caller, so the
 * Contacts policy applies (`contact.read` for an id, `contact.write` for an IČO).
 */
export const ExpenseSuppliersLive: Layer.Layer<ExpenseSuppliers, never, Contacts> = Layer.effect(
  ExpenseSuppliers,
  Effect.map(Effect.service(Contacts), (contacts) => {
    // The domain ContactView is a placeholder schema; the contacts module returns ContactViewData.
    const supplier = (view: unknown) => {
      const contact = view as ContactViewData;
      return { contactId: contact.id, name: contact.name, ico: contact.ico, dic: contact.dic };
    };
    return {
      contact: (id) => Effect.map(contacts.get(id), supplier),
      fromIco: (ico) => Effect.map(contacts.fromIco(ico, { role: "supplier" }), supplier),
    };
  }),
);

/** Recurring reads delivery statuses from the deliveries repository (#399). */
export const DeliveryStatusLookupLive: Layer.Layer<DeliveryStatusLookup, never, DeliveriesRepo> =
  Layer.effect(
    DeliveryStatusLookup,
    Effect.map(Effect.service(DeliveriesRepo), (repo) => ({ statuses: repo.statuses })),
  );

/**
 * Recurring links an issued occurrence to its Schedule through the documents repository
 * (#450, #461). The document was created in the same transaction, so NotFound is a defect.
 */
export const RecurringDocumentLinkLive: Layer.Layer<RecurringDocumentLink, never, DocumentsRepo> =
  Layer.effect(
    RecurringDocumentLink,
    Effect.map(Effect.service(DocumentsRepo), (repo) => ({
      link: (workspaceId, document, occurrence) =>
        repo
          .linkSchedule(workspaceId, document, occurrence)
          .pipe(Effect.catchTag("NotFound", (e) => Effect.die(e))),
    })),
  );
