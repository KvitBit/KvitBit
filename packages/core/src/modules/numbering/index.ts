/**
 * Numbering module: Numbering Series storage, number allocation (S3) and overrides (D4).
 * Core-internal (no domain tag): `Workspaces` and `Documents` call `NumberingSeries`.
 */
import * as Layer from "effect/Layer";
import { NumberingSeriesRepoMemory } from "./repo";
import { NumberingSeriesLive } from "./service";

export {
  DEFAULT_PER_KIND,
  NumberingSeriesRepo,
  NumberingSeriesRepoMemory,
  NumberingSeriesTable,
  SeriesRow,
} from "./repo";
export type { Allocation, ConfigureSeriesInput, NumberingSeriesShape } from "./service";
export {
  DEFAULT_SERIES_NAMES,
  DEFAULT_SERIES_PATTERNS,
  NumberingSeries,
  NumberingSeriesLive,
} from "./service";

/** `NumberingSeries` on the in-memory repo; needs `InMemoryPortsLive` (CoreStore, MemoryTables, IdGenerator). */
export const NumberingTestLayer = NumberingSeriesLive.pipe(
  Layer.provide(NumberingSeriesRepoMemory),
);
