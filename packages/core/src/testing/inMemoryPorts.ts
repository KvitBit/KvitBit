import type { CnbFixing, RegistryRecord } from "@kvitbit/domain/ports";
import { Layer } from "effect";
import { IdGeneratorTest } from "../shared/ids";
import { RequestOutcomeLive } from "../shared/requestOutcome";
import { CoreStoreMemory } from "../store/memory";
import { CaptureEmailSender, FakeCompanyRegistry, FixtureRates, MemoryBlobStorage } from "./ports";

export interface InMemoryPortsOptions {
  readonly registry?: Readonly<Record<string, RegistryRecord>>;
  readonly fixings?: ReadonlyArray<CnbFixing>;
}

/**
 * Every process-wide port the core requires, in memory: CoreStore with its MemoryTables,
 * IdGenerator (deterministic), CompanyRegistry, ExchangeRates, EmailSender (capture) and
 * BlobStorage, plus their test controls. No `RequestOutcome`: it is per request (the edge
 * provides one per call; `withIdempotency` works without it), so `TestCore` uses this.
 * Pair it with `TestClock.layer()` for deterministic time.
 */
export const InMemoryCorePorts = (options: InMemoryPortsOptions = {}) =>
  Layer.mergeAll(
    CoreStoreMemory,
    IdGeneratorTest,
    FakeCompanyRegistry.layer(options.registry),
    FixtureRates.layer(options.fixings),
    CaptureEmailSender.layer,
    MemoryBlobStorage.layer,
  );

/**
 * `InMemoryCorePorts` plus one `RequestOutcome` for the whole build, kept for `runTest` and the
 * module tests that run a single request per build. Never under a shared multi-request layer.
 */
export const InMemoryPortsLive = (options: InMemoryPortsOptions = {}) =>
  Layer.merge(InMemoryCorePorts(options), RequestOutcomeLive);
