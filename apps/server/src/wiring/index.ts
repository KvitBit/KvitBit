/**
 * Driven-port wiring for `@kvitbit/server` (core-ports 6 & 10):
 * combines all external ports required by `CoreLive` (except `UserDirectory`, which is provided
 * by `PersistenceLive`).
 */
import type { CoreExternalPorts, UserDirectory } from "@kvitbit/core";
import type { BlobUnavailable } from "@kvitbit/domain/ports";
import { type Config, Layer } from "effect";
import type { SqlClient } from "effect/sql";
import type * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { BlobStorageLive, makeBlobStorageLayer } from "./blob";
import {
  type BlobDriver,
  type BlobWiringConfig,
  BlobWiringConfigSchema,
  type EmailMode,
  type EmailWiringConfig,
  EmailWiringConfigSchema,
  type PdfWiringConfig,
  PdfWiringConfigSchema,
  type ShareSecretsConfig,
  ShareSecretsConfigSchema,
} from "./config";
import { EmailSenderLive, makeEmailSenderLayer, parseSmtpUrl } from "./email";
import { ExchangeRatesLive } from "./fx";
import {
  BrandingPreviewLive,
  brandingPreviewToRenderModel,
  type DocumentRenderContext,
  DocumentRendererLive,
  documentViewToRenderModel,
  makePdfRenderersLayer,
  PdfEngineLive,
  PdfRenderersLive,
  ReportPdfRendererLive,
  type ReportRenderContext,
  reportPdfInputToRenderModel,
} from "./pdf";
import { CompanyRegistryLive } from "./registry";
import {
  deriveInvitationTokenKey,
  deriveShareLinkKey,
  InvitationTokensLive,
  makeInvitationTokensLayer,
  makeShareLinkKeysLayer,
  ShareLinkKeysLive,
} from "./secrets";
import {
  DeliveryJobsLive,
  ExportWorkflowLive,
  InvitationDeliveryLive,
  WorkflowStartersLive,
} from "./workflows";

export type {
  BlobDriver,
  BlobWiringConfig,
  DocumentRenderContext,
  EmailMode,
  EmailWiringConfig,
  PdfWiringConfig,
  ReportRenderContext,
  ShareSecretsConfig,
};
export {
  BlobStorageLive,
  BlobWiringConfigSchema,
  BrandingPreviewLive,
  brandingPreviewToRenderModel,
  CompanyRegistryLive,
  DeliveryJobsLive,
  DocumentRendererLive,
  deriveInvitationTokenKey,
  deriveShareLinkKey,
  documentViewToRenderModel,
  EmailSenderLive,
  EmailWiringConfigSchema,
  ExchangeRatesLive,
  ExportWorkflowLive,
  InvitationDeliveryLive,
  InvitationTokensLive,
  makeBlobStorageLayer,
  makeEmailSenderLayer,
  makeInvitationTokensLayer,
  makePdfRenderersLayer,
  makeShareLinkKeysLayer,
  PdfEngineLive,
  PdfRenderersLive,
  PdfWiringConfigSchema,
  parseSmtpUrl,
  ReportPdfRendererLive,
  reportPdfInputToRenderModel,
  ShareLinkKeysLive,
  ShareSecretsConfigSchema,
  WorkflowStartersLive,
};

/** Every external port `CoreLive` needs besides `UserDirectory` (provided by `PersistenceLive`). */
export type ServerExternalPorts = Exclude<CoreExternalPorts, UserDirectory>;

const PdfSupportingPortsLive = Layer.mergeAll(BlobStorageLive, ShareLinkKeysLive);

/**
 * Live driven-port layer for `apps/server` (`main.ts` and `worker.ts`).
 * Requires only `SqlClient` (for `ExchangeRates` SQL cache) and `WorkflowEngine` (for workflow starters).
 */
export const CoreExternalPortsLive: Layer.Layer<
  ServerExternalPorts,
  Config.ConfigError | BlobUnavailable,
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

export const makeCoreExternalPortsLayer = () => CoreExternalPortsLive;
