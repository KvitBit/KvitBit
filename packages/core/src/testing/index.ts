/**
 * `@kvitbit/core/testing`: in-memory implementations of the core store and the driven ports,
 * and deterministic ids, for tests of the core and of the packages that compose it.
 */
import type { CnbFixing, RegistryRecord } from "@kvitbit/domain/ports";
import { Layer } from "effect";
import { IdGeneratorTest } from "../shared/ids";
import { RequestOutcomeLive } from "../shared/requestOutcome";
import { CoreStoreMemory } from "../store/memory";
import { CaptureEmailSender, FakeCompanyRegistry, FixtureRates, MemoryBlobStorage } from "./ports";

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
export * from "./ports";

export interface InMemoryPortsOptions {
  readonly registry?: Readonly<Record<string, RegistryRecord>>;
  readonly fixings?: ReadonlyArray<CnbFixing>;
}

/**
 * Every port the core requires, in memory: CoreStore with its MemoryTables, IdGenerator
 * (deterministic), RequestOutcome,
 * CompanyRegistry, ExchangeRates, EmailSender (capture) and BlobStorage, plus their test controls.
 * Pair it with `TestClock.layer()` for deterministic time.
 */
export const InMemoryPortsLive = (options: InMemoryPortsOptions = {}) =>
  Layer.mergeAll(
    CoreStoreMemory,
    IdGeneratorTest,
    RequestOutcomeLive,
    FakeCompanyRegistry.layer(options.registry),
    FixtureRates.layer(options.fixings),
    CaptureEmailSender.layer,
    MemoryBlobStorage.layer,
  );
