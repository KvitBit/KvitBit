/**
 * Environment configuration for driven-port adapters (`apps/server/src/wiring/**`).
 * Variable names follow the Phase 3 runtime contract agreed on board threads #871/#908/#913.
 */
import { Config, type Option, type Redacted } from "effect";

export type BlobDriver = "local" | "gcs";

export interface EmailWiringConfig {
  readonly from: string;
  readonly resendApiKey: Option.Option<Redacted.Redacted<string>>;
  readonly smtpUrl: Option.Option<Redacted.Redacted<string>>;
}

export interface BlobWiringConfig {
  readonly driver: BlobDriver;
  readonly localDir: string;
  readonly gcsBucket: Option.Option<string>;
  readonly gcsProject: Option.Option<string>;
}

export interface ShareSecretsConfig {
  readonly authSecret: Redacted.Redacted<string>;
  readonly shareKeyVersion: number;
  readonly appOrigin: string;
}

export interface PdfWiringConfig {
  readonly chromiumPath: string;
}

export const EmailWiringConfigSchema: Config.Config<EmailWiringConfig> = Config.all({
  from: Config.String("EMAIL_FROM").pipe(Config.withDefault("Kvitbit <noreply@kvitbit.cz>")),
  resendApiKey: Config.option(Config.Redacted("RESEND_API_KEY")),
  smtpUrl: Config.option(Config.Redacted("KVITBIT_SMTP_URL")),
});

export const BlobWiringConfigSchema: Config.Config<BlobWiringConfig> = Config.all({
  driver: Config.Literals(["local", "gcs"] as const, "KVITBIT_BLOB_DRIVER").pipe(
    Config.withDefault("local" as const),
  ),
  localDir: Config.String("KVITBIT_BLOB_DIR").pipe(Config.withDefault("/var/lib/kvitbit/blobs")),
  gcsBucket: Config.option(Config.String("KVITBIT_BLOB_BUCKET")),
  gcsProject: Config.option(Config.String("KVITBIT_GCS_PROJECT")),
});

export const ShareSecretsConfigSchema: Config.Config<ShareSecretsConfig> = Config.all({
  authSecret: Config.Redacted("BETTER_AUTH_SECRET"),
  shareKeyVersion: Config.Int("KVITBIT_SHARE_KEY_VERSION").pipe(Config.withDefault(1)),
  appOrigin: Config.String("APP_ORIGIN").pipe(Config.withDefault("http://localhost:8080")),
});

export const PdfWiringConfigSchema: Config.Config<PdfWiringConfig> = Config.all({
  chromiumPath: Config.String("KVITBIT_CHROMIUM_PATH").pipe(
    Config.withDefault("/usr/bin/chromium"),
  ),
});
