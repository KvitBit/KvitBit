/**
 * `@kvitbit/core/testing`: in-memory implementations of the core store and the driven ports,
 * and deterministic ids, for tests of the core and of the packages that compose it.
 */

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
export { InMemoryPortsLive } from "./inMemoryPorts";
export * from "./ports";
export type { TestCoreOptions, TestCoreServices } from "./TestCore";
export { CoreReposMemory, TestCore, TestCoreFakes } from "./TestCore";
