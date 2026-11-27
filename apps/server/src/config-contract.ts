/**
 * Typed-mode runtime configuration contract for `@kvitbit/server` (`main.ts`, `worker.ts`,
 * `wiring/**`, `http/mobile/config.ts`, `runtime/workflows.ts`).
 *
 * Contract:
 * - Environments: `production`, `staging`, `preview`, `development`, `test`.
 *   `KVITBIT_ENV` takes precedence; when absent, `NODE_ENV` is mapped fail-closed; when both are
 *   absent, defaults to `development`.
 * - `production`: zero opt-outs allowed. Requires real email transport (`resend`, `smtp`, or
 *   `resend+smtp`) + explicit valid `EMAIL_FROM`, `KVITBIT_BLOB_DRIVER=gcs` + `KVITBIT_BLOB_BUCKET`,
 *   explicit HTTPS non-localhost `APP_ORIGIN`, and non-empty database/auth secrets.
 * - `staging` & `preview`: fail fast by default if required service config is missing; non-prod
 *   modes are allowed only when explicitly declared (`KVITBIT_EMAIL_MODE=capture|console`,
 *   `KVITBIT_BLOB_DRIVER=local`), never via silent fallback.
 * - `development` & `test`: zero-config local DX (`console`/`capture` email, `local` blobs,
 *   `http://localhost:8080`).
 */
import { Config, ConfigProvider, Data, Effect, Option } from "effect";

export const KVITBIT_ENVS = ["production", "staging", "preview", "development", "test"] as const;
export type KvitbitEnv = (typeof KVITBIT_ENVS)[number];

export const EMAIL_MODES = [
  "resend",
  "smtp",
  "resend+smtp",
  "capture",
  "console",
  "disabled",
] as const;
export type EmailMode = (typeof EMAIL_MODES)[number];

export const PROD_EMAIL_MODES = ["resend", "smtp", "resend+smtp"] as const;
export type ProdEmailMode = (typeof PROD_EMAIL_MODES)[number];

export const NON_PROD_EMAIL_MODES = ["capture", "console"] as const;
export type NonProdEmailMode = (typeof NON_PROD_EMAIL_MODES)[number];

export const RESOLVED_EMAIL_MODES = [
  "resend",
  "smtp",
  "resend+smtp",
  "capture",
  "console",
] as const;
export type ResolvedEmailMode = (typeof RESOLVED_EMAIL_MODES)[number];

export const BLOB_DRIVERS = ["gcs", "local"] as const;
export type BlobDriver = (typeof BLOB_DRIVERS)[number];

export const SERVER_WORKLOADS = ["server", "worker"] as const;
export type ServerWorkload = (typeof SERVER_WORKLOADS)[number];

export const FORBIDDEN_OPT_OUT_ENV_VARS = [
  "KVITBIT_PREVIEW_DISABLE_EMAIL",
  "KVITBIT_PREVIEW_DISABLE_BLOB",
  "KVITBIT_DISABLE_EMAIL",
  "KVITBIT_DISABLE_BLOB",
  "KVITBIT_DISABLE_BLOBS",
  "KVITBIT_DISABLE_ORIGIN_CHECK",
  "KVITBIT_ALLOW_LOCAL_BLOBS",
] as const;

export const DEFAULT_DEV_APP_ORIGIN = "http://localhost:8080";
export const DEFAULT_DEV_EMAIL_FROM = "Kvitbit <noreply@kvitbit.cz>";
export const DEFAULT_BLOB_DIR = "/var/lib/kvitbit/blobs";

export class InvalidRuntimeConfig extends Data.TaggedError("InvalidRuntimeConfig")<{
  readonly field: string;
  readonly reason: string;
}> {
  override get message() {
    return `Invalid runtime config (${this.field}): ${this.reason}`;
  }
}

export type ValidationResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: InvalidRuntimeConfig };

const ok = <A>(value: A): ValidationResult<A> => ({ ok: true, value });
const fail = (field: string, reason: string): ValidationResult<never> => ({
  ok: false,
  error: new InvalidRuntimeConfig({ field, reason }),
});

export const toConfigError = (error: InvalidRuntimeConfig): Config.ConfigError =>
  new Config.ConfigError(new ConfigProvider.SourceError({ message: error.message }));

export const liftValidation = <A>(
  result: ValidationResult<A>,
): Effect.Effect<A, Config.ConfigError> =>
  result.ok ? Effect.succeed(result.value) : Effect.fail(toConfigError(result.error));

const trimOptional = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const isKvitbitEnv = (value: string): value is KvitbitEnv =>
  (KVITBIT_ENVS as ReadonlyArray<string>).includes(value);

const isEmailMode = (value: string): value is EmailMode =>
  (EMAIL_MODES as ReadonlyArray<string>).includes(value);

const isProdEmailMode = (value: string): value is ProdEmailMode =>
  (PROD_EMAIL_MODES as ReadonlyArray<string>).includes(value);

const isBlobDriver = (value: string): value is BlobDriver =>
  (BLOB_DRIVERS as ReadonlyArray<string>).includes(value);

/** Resolves `KvitbitEnv` from `KVITBIT_ENV` (preferred) and `NODE_ENV` (fail-closed fallback). */
export const resolveKvitbitEnv = (raw: {
  readonly kvitbitEnv?: string | undefined;
  readonly nodeEnv?: string | undefined;
}): ValidationResult<KvitbitEnv> => {
  const explicit = trimOptional(raw.kvitbitEnv);
  if (explicit !== undefined) {
    if (!isKvitbitEnv(explicit)) {
      return fail(
        "KVITBIT_ENV",
        `must be one of ${KVITBIT_ENVS.join(", ")} (got ${JSON.stringify(explicit)})`,
      );
    }
    return ok(explicit);
  }

  const nodeEnv = trimOptional(raw.nodeEnv);
  if (nodeEnv !== undefined) {
    if (!isKvitbitEnv(nodeEnv)) {
      return fail(
        "NODE_ENV",
        `must be one of ${KVITBIT_ENVS.join(", ")} when KVITBIT_ENV is unset (got ${JSON.stringify(nodeEnv)})`,
      );
    }
    return ok(nodeEnv);
  }

  return ok("development");
};

const IPV4_LOOPBACK_PATTERN =
  /^127\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

/** Returns true if `hostname` points to localhost, loopback, or an unspecified bind address. */
export const isLocalhostHostname = (hostname: string): boolean => {
  const normalized = hostname
    .replace(/^\[|\]$/g, "")
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "localhost.localdomain" ||
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    IPV4_LOOPBACK_PATTERN.test(normalized)
  );
};

/**
 * Validates `APP_ORIGIN` according to the environment contract:
 * - `production`: explicit HTTPS non-localhost origin required.
 * - `staging` / `preview`: explicit valid HTTP(S) origin required (no silent localhost fallback).
 * - `development` / `test`: defaults to `http://localhost:8080` when absent.
 */
export const validateAppOrigin = (
  env: KvitbitEnv,
  rawAppOrigin: string | undefined,
): ValidationResult<string> => {
  const trimmed = trimOptional(rawAppOrigin);
  if (trimmed === undefined) {
    if (env === "development" || env === "test") {
      return ok(DEFAULT_DEV_APP_ORIGIN);
    }
    return fail("APP_ORIGIN", `APP_ORIGIN must be explicitly set when KVITBIT_ENV=${env}`);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return fail("APP_ORIGIN", `invalid URL: ${JSON.stringify(trimmed)}`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return fail("APP_ORIGIN", `must use http or https protocol (got ${parsed.protocol})`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return fail("APP_ORIGIN", "must not contain credentials");
  }
  if (parsed.search !== "" || parsed.hash !== "" || !/^\/*$/.test(parsed.pathname)) {
    return fail(
      "APP_ORIGIN",
      `must be an origin without path, query, or fragment (got ${trimmed})`,
    );
  }

  if (env === "production") {
    if (parsed.protocol !== "https:") {
      return fail("APP_ORIGIN", `production APP_ORIGIN must use https (got ${parsed.origin})`);
    }
    if (isLocalhostHostname(parsed.hostname)) {
      return fail(
        "APP_ORIGIN",
        `production APP_ORIGIN must not point to localhost or loopback (got ${parsed.origin})`,
      );
    }
  }

  return ok(parsed.origin);
};

const EMAIL_LOCAL_ATOM = "[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+";
const EMAIL_ADDR_PATTERN = new RegExp(
  `^${EMAIL_LOCAL_ATOM}(?:\\.${EMAIL_LOCAL_ATOM})*@(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\\.)+(?:[a-zA-Z]{2,}|xn--[a-zA-Z0-9-]{2,})$`,
);

/** Validates an explicit `EMAIL_FROM` header value (either `user@domain.tld` or `Name <user@domain.tld>`). */
export const isValidEmailFrom = (raw: string | undefined): boolean => {
  const trimmed = trimOptional(raw);
  if (trimmed === undefined || /[\r\n]/.test(trimmed)) {
    return false;
  }
  const bracketMatch = /^[^<>]*<([^<>]+)>$/.exec(trimmed);
  const address = (bracketMatch?.[1] ?? trimmed).trim();
  if (address.length > 254) {
    return false;
  }
  const atIndex = address.indexOf("@");
  if (atIndex <= 0 || atIndex > 64) {
    return false;
  }
  return EMAIL_ADDR_PATTERN.test(address);
};

/** Validates an `smtp://` or `smtps://` transport URL. */
export const isValidSmtpUrl = (raw: string | undefined): boolean => {
  const trimmed = trimOptional(raw);
  if (trimmed === undefined) return false;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "smtp:" && url.protocol !== "smtps:") return false;
    if (url.hostname.trim().length === 0) return false;
    if (url.port !== "") {
      const port = Number(url.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    }
    return true;
  } catch {
    return false;
  }
};

export interface ResolvedEmailConfig {
  readonly mode: ResolvedEmailMode;
  readonly from: string;
  readonly resendApiKey: string | undefined;
  readonly smtpUrl: string | undefined;
}

/**
 * Resolves and validates email transport configuration.
 * Never returns a runtime reject-stub mode.
 */
export const resolveEmailConfig = (
  env: KvitbitEnv,
  raw: {
    readonly emailMode?: string | undefined;
    readonly emailFrom?: string | undefined;
    readonly resendApiKey?: string | undefined;
    readonly smtpUrl?: string | undefined;
  },
): ValidationResult<ResolvedEmailConfig> => {
  const rawMode = trimOptional(raw.emailMode);
  const emailFrom = trimOptional(raw.emailFrom);
  const resendApiKey = trimOptional(raw.resendApiKey);
  const smtpUrl = trimOptional(raw.smtpUrl);
  const hasResend = resendApiKey !== undefined;
  const hasSmtp = smtpUrl !== undefined;

  if (rawMode !== undefined) {
    if (!isEmailMode(rawMode)) {
      return fail(
        "KVITBIT_EMAIL_MODE",
        `must be one of ${RESOLVED_EMAIL_MODES.join(", ")} (got ${JSON.stringify(rawMode)})`,
      );
    }
    if (rawMode === "disabled") {
      return fail(
        "KVITBIT_EMAIL_MODE",
        "KVITBIT_EMAIL_MODE=disabled is forbidden; configure a real transport (resend, smtp, resend+smtp) or capture/console in non-production",
      );
    }
    if (env === "production" && !isProdEmailMode(rawMode)) {
      return fail(
        "KVITBIT_EMAIL_MODE",
        `non-production email mode '${rawMode}' is forbidden when KVITBIT_ENV=production`,
      );
    }
  }

  let mode: ResolvedEmailMode;
  if (rawMode !== undefined) {
    mode = rawMode as ResolvedEmailMode;
  } else if (env === "production" || env === "staging" || env === "preview") {
    if (hasResend && hasSmtp) {
      mode = "resend+smtp";
    } else if (hasResend) {
      mode = "resend";
    } else if (hasSmtp) {
      mode = "smtp";
    } else {
      return fail(
        "KVITBIT_EMAIL_MODE",
        env === "production"
          ? "production requires RESEND_API_KEY and/or KVITBIT_SMTP_URL"
          : `${env} requires RESEND_API_KEY and/or KVITBIT_SMTP_URL unless KVITBIT_EMAIL_MODE=capture or KVITBIT_EMAIL_MODE=console is explicitly set`,
      );
    }
  } else if (env === "test") {
    mode = "capture";
  } else {
    mode = !hasResend && !hasSmtp ? "console" : "capture";
  }

  if (mode === "capture" || mode === "console") {
    if (emailFrom !== undefined && !isValidEmailFrom(emailFrom)) {
      return fail("EMAIL_FROM", `invalid EMAIL_FROM address: ${JSON.stringify(emailFrom)}`);
    }
    return ok({
      mode,
      from: emailFrom ?? DEFAULT_DEV_EMAIL_FROM,
      resendApiKey,
      smtpUrl,
    });
  }

  if ((mode === "resend" || mode === "resend+smtp") && !hasResend) {
    return fail("RESEND_API_KEY", `RESEND_API_KEY is required when KVITBIT_EMAIL_MODE=${mode}`);
  }
  if ((mode === "smtp" || mode === "resend+smtp") && !hasSmtp) {
    return fail("KVITBIT_SMTP_URL", `KVITBIT_SMTP_URL is required when KVITBIT_EMAIL_MODE=${mode}`);
  }
  if ((mode === "smtp" || mode === "resend+smtp") && !isValidSmtpUrl(smtpUrl)) {
    return fail("KVITBIT_SMTP_URL", "KVITBIT_SMTP_URL must be a valid smtp:// or smtps:// URL");
  }

  if (emailFrom === undefined) {
    if (env === "development" || env === "test") {
      return ok({
        mode,
        from: DEFAULT_DEV_EMAIL_FROM,
        resendApiKey,
        smtpUrl,
      });
    }
    return fail("EMAIL_FROM", `EMAIL_FROM must be explicitly set when KVITBIT_ENV=${env}`);
  }
  if (!isValidEmailFrom(emailFrom)) {
    return fail("EMAIL_FROM", `invalid EMAIL_FROM address: ${JSON.stringify(emailFrom)}`);
  }

  return ok({
    mode,
    from: emailFrom,
    resendApiKey,
    smtpUrl,
  });
};

export interface ResolvedBlobConfig {
  readonly driver: BlobDriver;
  readonly localDir: string;
  readonly gcsBucket: string | undefined;
  readonly gcsProject: string | undefined;
}

/**
 * Resolves and validates `BlobStorage` configuration:
 * - `production`: `gcs` + `KVITBIT_BLOB_BUCKET` required; `local` or unset is a hard error.
 * - `staging` / `preview`: driver must be explicitly set (`gcs` or `local`); no silent fallback.
 * - `development` / `test`: defaults to `local` when unset.
 */
export const resolveBlobConfig = (
  env: KvitbitEnv,
  raw: {
    readonly driver?: string | undefined;
    readonly bucket?: string | undefined;
    readonly localDir?: string | undefined;
    readonly gcsProject?: string | undefined;
  },
): ValidationResult<ResolvedBlobConfig> => {
  const rawDriver = trimOptional(raw.driver);
  const bucket = trimOptional(raw.bucket);
  const localDir = trimOptional(raw.localDir) ?? DEFAULT_BLOB_DIR;
  const gcsProject = trimOptional(raw.gcsProject);

  if (rawDriver !== undefined && !isBlobDriver(rawDriver)) {
    return fail(
      "KVITBIT_BLOB_DRIVER",
      `must be one of ${BLOB_DRIVERS.join(", ")} (got ${JSON.stringify(rawDriver)})`,
    );
  }

  let driver: BlobDriver;
  if (rawDriver !== undefined) {
    driver = rawDriver;
  } else if (env === "development" || env === "test") {
    driver = "local";
  } else {
    return fail(
      "KVITBIT_BLOB_DRIVER",
      env === "production"
        ? "KVITBIT_BLOB_DRIVER=gcs is required when KVITBIT_ENV=production"
        : `KVITBIT_BLOB_DRIVER must be explicitly set to 'gcs' or 'local' when KVITBIT_ENV=${env}`,
    );
  }

  if (env === "production" && driver !== "gcs") {
    return fail(
      "KVITBIT_BLOB_DRIVER",
      `non-production blob driver '${driver}' is forbidden when KVITBIT_ENV=production`,
    );
  }

  if (driver === "gcs" && bucket === undefined) {
    return fail(
      "KVITBIT_BLOB_BUCKET",
      "KVITBIT_BLOB_BUCKET is required when KVITBIT_BLOB_DRIVER=gcs",
    );
  }

  return ok({
    driver,
    localDir,
    gcsBucket: driver === "gcs" ? bucket : undefined,
    gcsProject,
  });
};

export interface ValidatedRuntimeEnv {
  readonly env: KvitbitEnv;
  readonly workload: ServerWorkload;
  readonly appOrigin: string;
  readonly email: ResolvedEmailConfig;
  readonly blob: ResolvedBlobConfig;
}

const FORBIDDEN_OPT_OUT_PATTERN = /^KVITBIT_(?:PREVIEW_)?DISABLE_/;

/**
 * Pure boot-time validation of the full runtime environment map for `apps/server` (`server` or
 * `worker`). Directly exercised by both runtime boot and the Tier 1 exhaustive verification suite.
 */
export const validateServerRuntimeEnv = (
  envMap: Readonly<Record<string, string | undefined>>,
  workload: ServerWorkload = "server",
): ValidationResult<ValidatedRuntimeEnv> => {
  const envResult = resolveKvitbitEnv({
    kvitbitEnv: envMap.KVITBIT_ENV,
    nodeEnv: envMap.NODE_ENV,
  });
  if (!envResult.ok) return envResult;
  const env = envResult.value;

  for (const [key, value] of Object.entries(envMap)) {
    const isForbiddenName =
      FORBIDDEN_OPT_OUT_PATTERN.test(key) ||
      (FORBIDDEN_OPT_OUT_ENV_VARS as ReadonlyArray<string>).includes(key);
    if (isForbiddenName && trimOptional(value) !== undefined) {
      return fail(
        key,
        env === "production"
          ? `opt-out flag ${key} is forbidden when KVITBIT_ENV=production`
          : `boolean opt-out flag ${key} is not supported; declare typed modes (KVITBIT_EMAIL_MODE, KVITBIT_BLOB_DRIVER) instead`,
      );
    }
  }

  const databaseUrl = trimOptional(envMap.DATABASE_URL);
  const unpooledDatabaseUrl = trimOptional(envMap.DATABASE_URL_UNPOOLED);
  if (workload === "server") {
    if (databaseUrl === undefined) {
      return fail("DATABASE_URL", "DATABASE_URL must be non-empty");
    }
  } else if (databaseUrl === undefined && unpooledDatabaseUrl === undefined) {
    return fail("DATABASE_URL", "DATABASE_URL or DATABASE_URL_UNPOOLED must be non-empty");
  }

  if (trimOptional(envMap.BETTER_AUTH_SECRET) === undefined) {
    return fail("BETTER_AUTH_SECRET", "BETTER_AUTH_SECRET must be non-empty");
  }

  const appOrigin = validateAppOrigin(env, envMap.APP_ORIGIN);
  if (!appOrigin.ok) return appOrigin;

  const email = resolveEmailConfig(env, {
    emailMode: envMap.KVITBIT_EMAIL_MODE,
    emailFrom: envMap.EMAIL_FROM,
    resendApiKey: envMap.RESEND_API_KEY,
    smtpUrl: envMap.KVITBIT_SMTP_URL,
  });
  if (!email.ok) return email;

  const blob = resolveBlobConfig(env, {
    driver: envMap.KVITBIT_BLOB_DRIVER,
    bucket: envMap.KVITBIT_BLOB_BUCKET,
    localDir: envMap.KVITBIT_BLOB_DIR,
    gcsProject: envMap.KVITBIT_GCS_PROJECT,
  });
  if (!blob.ok) return blob;

  return ok({
    env,
    workload,
    appOrigin: appOrigin.value,
    email: email.value,
    blob: blob.value,
  });
};

const optionalEnvString = (name: string): Effect.Effect<string | undefined, Config.ConfigError> =>
  Effect.map(Config.option(Config.String(name)), Option.getOrUndefined);

/** Reads and resolves `KvitbitEnv` from the active Effect `ConfigProvider`. */
export const loadKvitbitEnv: Effect.Effect<KvitbitEnv, Config.ConfigError> = Effect.gen(
  function* () {
    const kvitbitEnv = yield* optionalEnvString("KVITBIT_ENV");
    const nodeEnv = yield* optionalEnvString("NODE_ENV");
    return yield* liftValidation(resolveKvitbitEnv({ kvitbitEnv, nodeEnv }));
  },
);

/** Reads and validates `APP_ORIGIN` from the active Effect `ConfigProvider`. */
export const loadValidatedAppOrigin: Effect.Effect<string, Config.ConfigError> = Effect.gen(
  function* () {
    const env = yield* loadKvitbitEnv;
    const rawAppOrigin = yield* optionalEnvString("APP_ORIGIN");
    return yield* liftValidation(validateAppOrigin(env, rawAppOrigin));
  },
);

const collectKvitbitProviderEntries = (
  provider: ConfigProvider.ConfigProvider,
  path: ReadonlyArray<string> = [],
): Effect.Effect<Array<readonly [string, string]>, Config.ConfigError> =>
  Effect.gen(function* () {
    const node = yield* provider
      .load(path)
      .pipe(Effect.mapError((error) => new Config.ConfigError(error)));
    if (node === undefined) return [];
    const entries: Array<readonly [string, string]> = [];
    if (node._tag === "Value") {
      if (path.length > 0) {
        entries.push([path.join("_"), node.value]);
      }
      return entries;
    }
    if (node._tag === "Record") {
      if (node.value !== undefined && path.length > 0) {
        entries.push([path.join("_"), node.value]);
      }
      for (const key of node.keys) {
        if (path.length === 0 && key !== "KVITBIT" && !key.startsWith("KVITBIT_")) {
          continue;
        }
        const nested = yield* collectKvitbitProviderEntries(provider, [...path, key]);
        entries.push(...nested);
      }
    }
    return entries;
  });

/**
 * Loads and validates the complete boot-time runtime configuration from the active Effect
 * `ConfigProvider` before binding HTTP or starting Effect Cluster runners.
 */
export const loadBootRuntimeConfig = (
  workload: ServerWorkload,
): Effect.Effect<ValidatedRuntimeEnv, Config.ConfigError> =>
  Effect.gen(function* () {
    const provider = yield* ConfigProvider.ConfigProvider;
    const dynamicKvitbitEntries = yield* collectKvitbitProviderEntries(provider);

    const envMap: Record<string, string | undefined> = {
      KVITBIT_ENV: yield* optionalEnvString("KVITBIT_ENV"),
      NODE_ENV: yield* optionalEnvString("NODE_ENV"),
      DATABASE_URL: yield* optionalEnvString("DATABASE_URL"),
      DATABASE_URL_UNPOOLED: yield* optionalEnvString("DATABASE_URL_UNPOOLED"),
      BETTER_AUTH_SECRET: yield* optionalEnvString("BETTER_AUTH_SECRET"),
      APP_ORIGIN: yield* optionalEnvString("APP_ORIGIN"),
      KVITBIT_EMAIL_MODE: yield* optionalEnvString("KVITBIT_EMAIL_MODE"),
      EMAIL_FROM: yield* optionalEnvString("EMAIL_FROM"),
      RESEND_API_KEY: yield* optionalEnvString("RESEND_API_KEY"),
      KVITBIT_SMTP_URL: yield* optionalEnvString("KVITBIT_SMTP_URL"),
      KVITBIT_BLOB_DRIVER: yield* optionalEnvString("KVITBIT_BLOB_DRIVER"),
      KVITBIT_BLOB_BUCKET: yield* optionalEnvString("KVITBIT_BLOB_BUCKET"),
      KVITBIT_BLOB_DIR: yield* optionalEnvString("KVITBIT_BLOB_DIR"),
      KVITBIT_GCS_PROJECT: yield* optionalEnvString("KVITBIT_GCS_PROJECT"),
    };
    for (const [key, value] of dynamicKvitbitEntries) {
      if (!(key in envMap)) {
        envMap[key] = value;
      }
    }
    for (const forbidden of FORBIDDEN_OPT_OUT_ENV_VARS) {
      if (envMap[forbidden] === undefined) {
        envMap[forbidden] = yield* optionalEnvString(forbidden);
      }
    }
    return yield* liftValidation(validateServerRuntimeEnv(envMap, workload));
  });
