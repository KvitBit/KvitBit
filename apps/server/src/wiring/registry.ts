/**
 * Live `CompanyRegistry` port backed by Czech ARES v3 (`@kvitbit/adapters/registry`).
 */
import { AresV3 } from "@kvitbit/adapters/registry";
import type { CompanyRegistry } from "@kvitbit/domain/ports";
import type * as Layer from "effect/Layer";

export const CompanyRegistryLive: Layer.Layer<CompanyRegistry> = AresV3.layer;
