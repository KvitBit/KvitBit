import type { CnbFixing, RegistryRecord } from "@kvitbit/domain/ports";
import { Layer } from "effect";
import { FxFixingsMemory } from "../shared/fx";
import { IdGeneratorTest } from "../shared/ids";
import { RequestOutcomeLive } from "../shared/requestOutcome";
import { CoreStoreMemory } from "../store/memory";
import { CaptureEmailSender, FakeCompanyRegistry, FixtureRates, MemoryBlobStorage } from "./ports";

export interface InMemoryPortsOptions {
  readonly registry?: Readonly<Record<string, RegistryRecord>>;
  readonly fixings?: ReadonlyArray<CnbFixing>;
}

/**
 * Every port the core requires, in memory: CoreStore with its MemoryTables, IdGenerator
 * (deterministic), RequestOutcome,
 * CompanyRegistry, ExchangeRates (+ FxFixings over a private in-memory cache), EmailSender (capture) and BlobStorage, plus their test controls.
 * Pair it with `TestClock.layer()` for deterministic time.
 */
export const InMemoryPortsLive = (options: InMemoryPortsOptions = {}) =>
  Layer.mergeAll(
    CoreStoreMemory,
    IdGeneratorTest,
    RequestOutcomeLive,
    FakeCompanyRegistry.layer(options.registry),
    FxFixingsMemory.pipe(Layer.provideMerge(FixtureRates.layer(options.fixings))),
    CaptureEmailSender.layer,
    MemoryBlobStorage.layer,
  );
