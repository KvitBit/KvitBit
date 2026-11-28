/**
 * Driven-port wiring for `@kvitbit/server` (core-ports 6 & 10):
 * combines all external ports required by `CoreLive` (except `UserDirectory`, which is provided
 * by `PersistenceLive`).
 */
import type { CoreExternalPorts, UserDirectory } from "@kvitbit/core";
import type { BlobUnavailable } from "@kvitbit/domain/ports";
import type * as Config from "effect/Config";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { BlobStorageLive } from "./blob";
import { EmailSenderLive } from "./email";
import { ExchangeRatesLive } from "./fx";
import { PdfRenderersLive } from "./pdf";
import { CompanyRegistryLive } from "./registry";
import { InvitationTokensLive, type KeyDerivationError, ShareLinkKeysLive } from "./secrets";
import { WorkflowStartersLive } from "./workflows";

export { makeBlobStorageLayer } from "./blob";
export type { EmailWiringConfig } from "./config";
export { EmailWiringConfigSchema } from "./config";
export { EmailSenderLive, makeEmailSenderLayer, parseSmtpUrl } from "./email";
export { documentViewToRenderModel, makePdfRenderersLayer } from "./pdf";
export {
  deriveInvitationTokenKey,
  deriveShareLinkKey,
  makeInvitationTokensLayer,
  makeShareLinkKeysLayer,
} from "./secrets";

type ServerExternalPorts = Exclude<CoreExternalPorts, UserDirectory>;

const PdfSupportingPortsLive = Layer.mergeAll(BlobStorageLive, ShareLinkKeysLive);

/**
 * Live driven-port layer for `apps/server` (`main.ts` and `worker.ts`).
 * Requires only `SqlClient` (for `ExchangeRates` SQL cache) and `WorkflowEngine` (for workflow starters).
 */
export const CoreExternalPortsLive: Layer.Layer<
  ServerExternalPorts,
  Config.ConfigError | BlobUnavailable | KeyDerivationError,
  SqlClient.SqlClient | WorkflowEngine.WorkflowEngine
> = Layer.mergeAll(
  CompanyRegistryLive,
  ExchangeRatesLive,
  EmailSenderLive,
  PdfSupportingPortsLive,
  InvitationTokensLive,
  PdfRenderersLive.pipe(Layer.provide(PdfSupportingPortsLive)),
  WorkflowStartersLive,
);
