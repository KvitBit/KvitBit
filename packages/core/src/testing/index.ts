/**
 * `@kvitbit/core/testing`: in-memory implementations of the core store and the driven ports,
 * deterministic ids, and every module's test layer (`<Name>TestLayer`), memory repositories,
 * fakes and their test controls, for tests of the core and of the packages that compose it.
 */

// Module test layers, memory repositories, fakes and their controls -------------------------
export { ContactsRepoMemory, ContactsTestLayer, FakeContactSeries } from "../modules/contacts";
export {
  DeliveriesRepoMemory,
  DeliveryJobsMemory,
  DocumentActivityNone,
  DocumentFakesLive,
  DocumentFixtures,
  DocumentRendererFake,
  DocumentsDeliveryTestLayer,
  DocumentsRepoMemory,
  DocumentsTestLayer,
  documentsDeliveryTestLayer,
  fakePdfBytes,
  StartedDeliveries,
} from "../modules/documents";
export {
  ExpensesRepoMemory,
  ExpensesTestLayer,
  FakeExpenseSuppliers,
  FakeSupplierDirectory,
} from "../modules/expenses";
export { NumberingSeriesRepoMemory, NumberingTestLayer } from "../modules/numbering";
export {
  PaymentFakesLive,
  PaymentFixtures,
  PaymentsRepoMemory,
  PaymentsTestLayer,
} from "../modules/payments";
export { PriceListRepoMemory, PriceListTestLayer } from "../modules/pricelist";
export {
  FakeDeliveryStatuses,
  FakeDocumentLinks,
  RecurringRepoMemory,
  RecurringTestLayer,
} from "../modules/recurring";
export {
  ExportsRepoMemory,
  FakeExportWorkflow,
  FakeReportPdfRenderer,
  FxFixingCacheMemory,
  ReportsSourceFake,
  ReportsSourceMemory,
  ReportsTestLayer,
} from "../modules/reports";
export {
  ShareFixtures,
  ShareLinkKeysTest,
  ShareLinksRepoMemory,
  ShareLinksTestLayer,
  ShareWorkspacesFake,
  shareLinkKeysTest,
} from "../modules/sharelinks";
export {
  BankAccountReferencesFake,
  BrandingPreviewFake,
  CaptureInvitationDelivery,
  InvitationTokensFake,
  UserDirectoryFake,
  WorkspaceSeriesMemory,
  WorkspacesRepoMemory,
  WorkspacesTestLayer,
} from "../modules/workspaces";
export { FxFixingsMemory } from "../shared/fx";
export { IdGeneratorTest } from "../shared/ids";
export { RequestOutcomeLive } from "../shared/requestOutcome";
export type { MemoryStore } from "../store/memory";
export { CoreStoreMemory, makeMemoryStore } from "../store/memory";
export { compareScalar, matches, runQuery } from "../store/query";
export type {
  Collection,
  CollectionDef,
  Query,
  Row,
  Scalar,
  ScalarKeys,
  UniqueConstraint,
} from "../store/tables";
export { defineCollection, MemoryTables } from "../store/tables";
export type { InMemoryPortsOptions } from "./inMemoryPorts";
export { InMemoryCorePorts, InMemoryPortsLive } from "./inMemoryPorts";
export * from "./ports";
export type { TestCoreOptions, TestCoreServices } from "./TestCore";
export { CoreReposMemory, TestCore, TestCoreFakes } from "./TestCore";
