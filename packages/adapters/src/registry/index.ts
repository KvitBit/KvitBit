/**
 * CompanyRegistry adapters (core-ports section 6): `AresV3` (live ARES v3 REST) and
 * `FakeCompanyRegistry` (in-memory, for tests and local development).
 */

export type { AresV3Config } from "./ares-v3";
export * as AresV3 from "./ares-v3";
export type { FakeCompanyRegistryOptions, FakeRegistryRecords } from "./fake";
export * as FakeCompanyRegistry from "./fake";
export { FakeCompanyRegistryControl } from "./fake";
