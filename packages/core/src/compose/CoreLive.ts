/**
 * The core composition (core-ports 10): every module Live with every cross-module seam bound to
 * the module that owns it. What stays open is what the core cannot provide itself:
 *
 * - `CoreStore` and `CoreRepos` (the persistence ports; SQL implementations come with the
 *   adapters, memory ones in `@kvitbit/core/testing`),
 * - `CoreExternalPorts`: the driven ports of core-ports 6 (CompanyRegistry, ExchangeRates,
 *   BlobStorage; EmailSender is used by the DocumentDelivery steps at call time) and the
 *   ports apps/server implements (UserDirectory, InvitationTokens, InvitationDelivery,
 *   BrandingPreview, DocumentRenderer, ReportPdfRenderer, DeliveryJobs, ExportWorkflow,
 *   ShareLinkKeys).
 *
 * `RequestOutcome` is not bound: the edge provides one per request and `withIdempotency` reads
 * it optionally from the call site. `ShareVisitorDevice` is a `Context.Reference` the share
 * route sets per request.
 *
 * Layers are memoized by reference within one build, so `RegistryLookup.layer` (with its cache)
 * is built once and shared by Workspaces and Contacts. That cache lives as long as one CoreLive
 * build: apps build CoreLive once per process, so it is process-wide there, while each
 * `TestCore` build starts empty.
 *
 * No layer keeps a per-request service from its build: each captures only its declared build
 * dependencies (`Context.pick`) and merges the call-site context (CurrentCaller, RequestOutcome,
 * an enclosing transaction) on every call.
 */
import type {
  BlobStorage,
  CompanyRegistry,
  EmailSender,
  ExchangeRates,
} from "@kvitbit/domain/ports";
import { Layer } from "effect";
import { ContactSnapshotsLive, ContactsLive, type ContactsRepo } from "../modules/contacts";
import {
  type DeliveriesRepo,
  type DeliveryJobs,
  DocumentDeliveryReadsLive,
  DocumentPaymentsLive,
  type DocumentRenderer,
  DocumentSenderLive,
  DocumentsLive,
  type DocumentsRepo,
} from "../modules/documents";
import {
  ExpensePayablesLive,
  ExpenseRecordsLive,
  ExpensesLive,
  type ExpensesRepo,
} from "../modules/expenses";
import { NumberingSeriesLive, type NumberingSeriesRepo } from "../modules/numbering";
import { PaymentDocumentsLive, PaymentsLive, type PaymentsRepo } from "../modules/payments";
import { PriceListItemsLive, PriceListLive, type PriceListRepo } from "../modules/pricelist";
import { RecurringIssuanceLive, type RecurringRepo, TemplatesLive } from "../modules/recurring";
import {
  ExportJobsLive,
  type ExportsRepo,
  type ExportWorkflow,
  type FxFixingCache,
  type ReportPdfRenderer,
  ReportsLive,
} from "../modules/reports";
import {
  PublicShareLinksLive,
  type ShareLinkKeys,
  type ShareLinksRepo,
} from "../modules/sharelinks";
import {
  type BrandingPreview,
  type InvitationDelivery,
  type InvitationTokens,
  IssuerSnapshotsLive,
  RegistryLookup,
  type UserDirectory,
  WorkspaceSnapshotsLive,
  WorkspacesLive,
  type WorkspacesRepo,
} from "../modules/workspaces";
import { FxFixingsLive } from "../shared/fx";
import { IdGeneratorLive } from "../shared/ids";
import type { CoreStore } from "../store/CoreStore";
import { BankAccountReferencesLive } from "./bankAccounts";
import {
  ContactSeriesLookupLive,
  DeliveryStatusLookupLive,
  DocumentContactsLive,
  DocumentIssuersLive,
  DocumentPriceListLive,
  ExpenseSuppliersLive,
  PaymentExpensePayablesLive,
  PaymentSettingsLive,
  RecurringDocumentLinkLive,
  WorkspaceSeriesLive,
} from "./bindings";
import { DocumentActivityLive } from "./documentActivity";
import { ReportsSourceLive } from "./reportsSource";
import { ShareWorkspacesLive } from "./shareWorkspaces";

/** One repository port per module, plus the FX fixing cache (the `fx_fixings` table). */
export type CoreRepos =
  | WorkspacesRepo
  | ContactsRepo
  | PriceListRepo
  | NumberingSeriesRepo
  | DocumentsRepo
  | DeliveriesRepo
  | PaymentsRepo
  | ShareLinksRepo
  | ExpensesRepo
  | RecurringRepo
  | ExportsRepo
  | FxFixingCache;

/** Ports implemented outside the core (adapters, apps/server). */
export type CoreExternalPorts =
  | CompanyRegistry
  | ExchangeRates
  | EmailSender
  | BlobStorage
  | UserDirectory
  | InvitationTokens
  | InvitationDelivery
  | BrandingPreview
  | DocumentRenderer
  | ReportPdfRenderer
  | DeliveryJobs
  | ExportWorkflow
  | ShareLinkKeys;

// Tiers, lowest first; each tier is built from the outputs of the tiers below it.

/**
 * Seams over repositories and external ports only. `DocumentActivity` is required by the
 * owner-facing boundaries (`DocumentsLive`, `PaymentDocumentsLive`), which add `share` and
 * `deliveries` to the views they return; stored and visitor views never carry them.
 */
const repoSeams = Layer.mergeAll(
  DocumentActivityLive,
  BankAccountReferencesLive,
  ShareWorkspacesLive,
  FxFixingsLive,
);

const readSeams = Layer.mergeAll(
  RegistryLookup.layer,
  NumberingSeriesLive,
  PriceListItemsLive,
  ContactSnapshotsLive,
  ContactSeriesLookupLive,
  DeliveryStatusLookupLive,
  RecurringDocumentLinkLive,
  ExpensePayablesLive,
  ExpenseRecordsLive,
  PaymentDocumentsLive,
  DocumentDeliveryReadsLive,
);

const identity = Layer.mergeAll(
  ReportsSourceLive,
  WorkspaceSeriesLive,
  DocumentPriceListLive,
  DocumentContactsLive,
  PaymentExpensePayablesLive,
  ContactsLive,
  PriceListLive,
);

const workspaces = Layer.mergeAll(
  WorkspacesLive,
  IssuerSnapshotsLive,
  PaymentSettingsLive,
  ExpenseSuppliersLive,
).pipe(Layer.provideMerge(WorkspaceSnapshotsLive));

const documentSeams = Layer.mergeAll(DocumentSenderLive, DocumentPaymentsLive).pipe(
  Layer.provideMerge(DocumentIssuersLive),
);

const documents = Layer.mergeAll(DocumentsLive, ExpensesLive);

const dependents = Layer.mergeAll(
  PaymentsLive,
  PublicShareLinksLive,
  TemplatesLive,
  RecurringIssuanceLive,
  ReportsLive,
  ExportJobsLive,
);

/**
 * Every module and seam, requiring `CoreStore | CoreRepos | CoreExternalPorts | IdGenerator`.
 * Its output holds the nine domain service tags, the job services (`RecurringIssuance`,
 * `ExportJobs`) and the internal seams the workflows call (`DocumentDeliveryReads`, `DocumentSender`, ...).
 */
export const CoreModulesLive = dependents.pipe(
  Layer.provideMerge(documents),
  Layer.provideMerge(documentSeams),
  Layer.provideMerge(workspaces),
  Layer.provideMerge(identity),
  Layer.provideMerge(readSeams),
  Layer.provideMerge(repoSeams),
);

/** `CoreModulesLive` with real UUIDv7 ids. */
export const CoreLive = CoreModulesLive.pipe(Layer.provide(IdGeneratorLive));

/** What `CoreLive` may require: persistence and the external ports, nothing internal. */
export type CoreLiveRequires = CoreStore | CoreRepos | CoreExternalPorts;

/** What `CoreLive` requires (a subset of `CoreLiveRequires`; the smoke test asserts it). */
export type CoreRequirements =
  typeof CoreLive extends Layer.Layer<infer _A, infer _E, infer R> ? R : never;

/** What `CoreLive` provides. */
export type CoreServices = Layer.Success<typeof CoreLive>;
