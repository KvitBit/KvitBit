/**
 * Environment configuration for driven-port adapters (`apps/server/src/wiring/**`).
 * Variable names follow the Phase 3 runtime contract agreed on board threads #871/#908/#913.
 */
import { Config, Effect, Option, Redacted } from "effect";
import {
  type BlobDriver,
  type EmailMode,
  InvalidRuntimeConfig,
  liftValidation,
  loadKvitbitEnv,
  loadValidatedAppOrigin,
  resolveBlobConfig,
  toConfigError,
} from "../config-contract";

export type { BlobDriver, EmailMode };

export interface EmailWiringConfig {
  readonly mode?: string | undefined;
  readonly from?: string | undefined;
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

const optionalTrimmedString = (
  name: string,
): Effect.Effect<string | undefined, Config.ConfigError> =>
  Effect.map(Config.option(Config.String(name)), (opt) =>
    Option.getOrUndefined(
      Option.flatMap(opt, (v) => {
        const trimmed = v.trim();
        return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
      }),
    ),
  );

const optionalNonEmptyRedacted = (
  name: string,
): Effect.Effect<Option.Option<Redacted.Redacted<string>>, Config.ConfigError> =>
  Effect.map(Config.option(Config.Redacted(name)), (opt) =>
    Option.flatMap(opt, (secret) =>
      Redacted.value(secret).trim().length > 0 ? Option.some(secret) : Option.none(),
    ),
  );

export const EmailWiringConfigSchema: Effect.Effect<EmailWiringConfig, Config.ConfigError> =
  Effect.gen(function* () {
    const mode = yield* optionalTrimmedString("KVITBIT_EMAIL_MODE");
    const from = yield* optionalTrimmedString("EMAIL_FROM");
    const resendApiKey = yield* optionalNonEmptyRedacted("RESEND_API_KEY");
    const smtpUrl = yield* optionalNonEmptyRedacted("KVITBIT_SMTP_URL");
    return { mode, from, resendApiKey, smtpUrl } satisfies EmailWiringConfig;
  });

export const BlobWiringConfigSchema: Effect.Effect<BlobWiringConfig, Config.ConfigError> =
  Effect.gen(function* () {
    const env = yield* loadKvitbitEnv;
    const driver = yield* optionalTrimmedString("KVITBIT_BLOB_DRIVER");
    const localDir = yield* optionalTrimmedString("KVITBIT_BLOB_DIR");
    const bucket = yield* optionalTrimmedString("KVITBIT_BLOB_BUCKET");
    const gcsProject = yield* optionalTrimmedString("KVITBIT_GCS_PROJECT");
    const resolved = yield* liftValidation(
      resolveBlobConfig(env, { driver, bucket, localDir, gcsProject }),
    );
    return {
      driver: resolved.driver,
      localDir: resolved.localDir,
      gcsBucket: resolved.gcsBucket !== undefined ? Option.some(resolved.gcsBucket) : Option.none(),
      gcsProject:
        resolved.gcsProject !== undefined ? Option.some(resolved.gcsProject) : Option.none(),
    } satisfies BlobWiringConfig;
  });

export const ShareSecretsConfigSchema: Effect.Effect<ShareSecretsConfig, Config.ConfigError> =
  Effect.gen(function* () {
    const authSecret = yield* Config.Redacted("BETTER_AUTH_SECRET");
    if (Redacted.value(authSecret).trim().length === 0) {
      return yield* Effect.fail(
        toConfigError(
          new InvalidRuntimeConfig({
            field: "BETTER_AUTH_SECRET",
            reason: "BETTER_AUTH_SECRET must be non-empty",
          }),
        ),
      );
    }
    const shareKeyVersion = yield* Config.Int("KVITBIT_SHARE_KEY_VERSION").pipe(
      Config.withDefault(1),
    );
    const appOrigin = yield* loadValidatedAppOrigin;
    return { authSecret, shareKeyVersion, appOrigin } satisfies ShareSecretsConfig;
  });

export const PdfWiringConfigSchema: Config.Config<PdfWiringConfig> = Config.all({
  chromiumPath: Config.String("KVITBIT_CHROMIUM_PATH").pipe(
    Config.withDefault("/usr/bin/chromium"),
  ),
});
