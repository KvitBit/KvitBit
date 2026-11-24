/**
 * Reports module (core-ports 4.9): `ReportsLive` (domain tag `Reports`), the `ReportsSource`
 * read seam (board #397, #404, #477), the FX fixing cache port, the PDF renderer port, export jobs (`ExportJobs` for the
 * DataExport workflow and Housekeeping, `ExportWorkflow` starter port) and the pure builders.
 */
import { Layer } from "effect";
import { FxFixingsLive } from "../../shared/fx";
import { ExportJobsLive, ExportsRepoMemory, FakeExportWorkflow } from "./exports";
import { FxFixingCacheMemory } from "./fxcache";
import { FakeReportPdfRenderer } from "./renderer";
import { ReportsLive } from "./service";
import { ReportsSourceMemory } from "./source";

export * as ReportCompute from "./compute";
export type { CsvCell, CsvDialect, CsvTable } from "./csv";
export {
  BOM,
  CSV_CONTENT_TYPE,
  csvStream,
  dialectFor,
  encodeCsv,
  encodeField,
  formatDecimal,
} from "./csv";
export type { ExportFile, ExportJobsShape } from "./exports";
export {
  EXPORT_RETENTION_MILLIS,
  ExportJobs,
  ExportJobsLive,
  ExportRow,
  ExportsRepo,
  ExportsRepoMemory,
  ExportsTable,
  ExportWorkflow,
  exportBlobKey,
  FakeExportWorkflow,
  ONE_RUNNING_EXPORT,
  REPORTING_FILES,
} from "./exports";
export { cachedFixing, FxFixingCache, FxFixingCacheMemory } from "./fxcache";
export type { ReportPdfInput } from "./renderer";
export { FakeReportPdfRenderer, ReportPdfRenderer } from "./renderer";
export type { ReportsImpl } from "./service";
export { MAX_PERIOD_DAYS, makeReports, ReportsLive, validatePeriod } from "./service";
export type {
  DateRange,
  ReportDocument,
  ReportExpense,
  ReportPayment,
  ReportsSourceData,
  ReportsSourceShape,
  StoredFx,
} from "./source";
export { ReportsSource, ReportsSourceFake, ReportsSourceMemory } from "./source";
export { documentsTable, expensesTable, paymentsTable, reportTable } from "./tables";
export * from "./views";

/**
 * `Reports` and `ExportJobs` on the in-memory export repo, the seedable `ReportsSourceMemory`,
 * the in-memory FX fixing cache, the fake PDF renderer and the fake workflow starter (their
 * controls are in the output).
 * Needs `InMemoryPortsLive` (CoreStore, MemoryTables, IdGenerator, BlobStorage, ExchangeRates).
 */
export const ReportsTestLayer = Layer.mergeAll(ReportsLive, ExportJobsLive).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      ExportsRepoMemory,
      ReportsSourceMemory,
      FakeReportPdfRenderer.layer,
      FakeExportWorkflow.layer,
      FxFixingsLive.pipe(Layer.provideMerge(FxFixingCacheMemory)),
    ),
  ),
);
