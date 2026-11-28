/**
 * `TestCore`: the real core composition (`CoreModulesLive`) on in-memory persistence and fakes
 * for every external port, with the fakes' controls in its output:
 *
 * - `InMemoryCorePorts`: CoreStore + MemoryTables, deterministic IdGenerator (no shared
 *   `RequestOutcome`: provide one per request, as the edge does), `FakeCompanyRegistry` (registry fixtures), `FixtureRates` (CNB fixings), `CaptureEmailSender`,
 *   `MemoryBlobStorage`;
 * - `CoreReposMemory`: every module repository on MemoryTables, plus the in-memory FX cache;
 * - `TestCoreFakes`: `UserDirectoryFake` (directory users), `CaptureInvitationDelivery`,
 *   `InvitationTokensFake`, `BrandingPreviewFake`, `DocumentRendererFake` (renders in
 *   `DocumentFixtures.renders`), `FakeReportPdfRenderer`, `DeliveryJobsMemory` (started jobs in
 *   `StartedDeliveries`), `FakeExportWorkflow`, `ShareLinkKeysTest`.
 *
 * The delivery steps and the delivery reconcile (`deliver`, `reconcileStaleDeliveries`, J1a)
 * run on this context as they do on CoreLive's: `DeliveriesRepoMemory` answers the reconcile's
 * stale query, and its restarts land in `StartedDeliveries`.
 *
 * Pair it with `TestClock.layer()` (test/helpers `runCore` does, at TEST_NOW).
 */
import * as Layer from "effect/Layer";
import { CoreModulesLive } from "../compose/CoreLive";
import { ContactsRepoMemory } from "../modules/contacts";
import {
  DeliveriesRepoMemory,
  DeliveryJobsMemory,
  DocumentRendererFake,
  DocumentsRepoMemory,
} from "../modules/documents";
import { ExpensesRepoMemory } from "../modules/expenses";
import { NumberingSeriesRepoMemory } from "../modules/numbering";
import { PaymentsRepoMemory } from "../modules/payments";
import { PriceListRepoMemory } from "../modules/pricelist";
import { RecurringRepoMemory } from "../modules/recurring";
import {
  ExportsRepoMemory,
  FakeExportWorkflow,
  FakeReportPdfRenderer,
  FxFixingCacheMemory,
} from "../modules/reports";
import { ShareLinkKeysTest, ShareLinksRepoMemory } from "../modules/sharelinks";
import {
  BrandingPreviewFake,
  CaptureInvitationDelivery,
  type DirectoryUser,
  InvitationTokensFake,
  UserDirectoryFake,
  WorkspacesRepoMemory,
} from "../modules/workspaces";
import { InMemoryCorePorts, type InMemoryPortsOptions } from "./inMemoryPorts";

/** Every `CoreRepos` port on MemoryTables (and the in-memory FX cache). */
export const CoreReposMemory = Layer.mergeAll(
  WorkspacesRepoMemory,
  ContactsRepoMemory,
  PriceListRepoMemory,
  NumberingSeriesRepoMemory,
  DocumentsRepoMemory,
  DeliveriesRepoMemory,
  PaymentsRepoMemory,
  ShareLinksRepoMemory,
  ExpensesRepoMemory,
  RecurringRepoMemory,
  ExportsRepoMemory,
  FxFixingCacheMemory,
);

/** Fakes for the external ports apps/server implements, with their controls. */
export const TestCoreFakes = (users: ReadonlyArray<DirectoryUser> = []) =>
  Layer.mergeAll(
    UserDirectoryFake.layer(users),
    CaptureInvitationDelivery.layer,
    InvitationTokensFake,
    BrandingPreviewFake,
    DocumentRendererFake,
    FakeReportPdfRenderer.layer,
    DeliveryJobsMemory,
    FakeExportWorkflow.layer,
    ShareLinkKeysTest,
  );

export interface TestCoreOptions extends InMemoryPortsOptions {
  /** Users the fake `UserDirectory` knows (names and emails of Members). */
  readonly users?: ReadonlyArray<DirectoryUser>;
}

/** The whole core on memory ports and fakes; a fresh, isolated world per build. */
export const TestCore = (options: TestCoreOptions = {}) =>
  CoreModulesLive.pipe(
    Layer.provideMerge(Layer.merge(CoreReposMemory, TestCoreFakes(options.users))),
    Layer.provideMerge(InMemoryCorePorts(options)),
  );

/** Everything a test can reach under `TestCore`: services, repositories, fakes and controls. */
export type TestCoreServices = Layer.Success<ReturnType<typeof TestCore>>;
