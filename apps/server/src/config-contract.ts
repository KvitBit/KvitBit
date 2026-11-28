import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
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
 *   explicit HTTPS non-localhost `APP_ORIGIN`, non-empty `ALTCHA_HMAC_KEY` (on `server`), and
 *   non-empty database/auth secrets.
 * - `staging` & `preview`: fail fast by default if required service config is missing; non-prod
 *   modes are allowed only when explicitly declared (`KVITBIT_EMAIL_MODE=capture|console`,
 *   `KVITBIT_BLOB_DRIVER=local`, `KVITBIT_BOT_PROTECTION_MODE=none`), never via silent fallback.
 * - `development` & `test`: zero-config local DX (`console`/`capture` email, `local` blobs,
 *   `none` bot protection when `ALTCHA_HMAC_KEY` is absent, `http://localhost:8080`).
 */

import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as EffectRecord from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Str from "effect/String";

const encodeJsonValue = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Fn.flow(encodeJsonValue, Result.getOrThrow);

const normalizedPattern = /\.+$/;
const validateAppOriginImplPattern = /^\/*$/;
const isValidEmailFromPattern = /[\r\n]/;
const bracketMatchPattern = /^[^<>]*<([^<>]+)>$/;

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

export const PROD_EMAIL_MODES = ["resend", "smtp", "resend+smtp"] as const;

export const RESOLVED_EMAIL_MODES = [
  "resend",
  "smtp",
  "resend+smtp",
  "capture",
  "console",
] as const;
type ResolvedEmailMode = (typeof RESOLVED_EMAIL_MODES)[number];

export const BLOB_DRIVERS = ["gcs", "local"] as const;
export type BlobDriver = (typeof BLOB_DRIVERS)[number];

export const BOT_PROTECTION_MODES = ["altcha", "none", "disabled"] as const;

export const PROD_BOT_PROTECTION_MODES = ["altcha"] as const;

export const RESOLVED_BOT_PROTECTION_MODES = ["altcha", "none"] as const;
type ResolvedBotProtectionMode = (typeof RESOLVED_BOT_PROTECTION_MODES)[number];

export const SERVER_WORKLOADS = ["server", "worker"] as const;
export type ServerWorkload = (typeof SERVER_WORKLOADS)[number];

export const FORBIDDEN_OPT_OUT_ENV_VARS = [
  "KVITBIT_PREVIEW_DISABLE_EMAIL",
  "KVITBIT_PREVIEW_DISABLE_BLOB",
  "KVITBIT_PREVIEW_DISABLE_BOT_PROTECTION",
  "KVITBIT_DISABLE_EMAIL",
  "KVITBIT_DISABLE_BLOB",
  "KVITBIT_DISABLE_BLOBS",
  "KVITBIT_DISABLE_BOT_PROTECTION",
  "KVITBIT_DISABLE_ORIGIN_CHECK",
  "KVITBIT_ALLOW_LOCAL_BLOBS",
] as const;

const DEFAULT_DEV_APP_ORIGIN = "http://localhost:8080";
const DEFAULT_DEV_EMAIL_FROM = "Kvitbit <noreply@kvitbit.cz>";
const DEFAULT_BLOB_DIR = "/var/lib/kvitbit/blobs";

export class InvalidRuntimeConfig extends Schema.TaggedError<
  InvalidRuntimeConfig,
  { readonly brand: unique symbol }
>()("InvalidRuntimeConfig", {
  field: Schema.String,
  reason: Schema.String,
}) {
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
  error: InvalidRuntimeConfig.make({ field, reason }),
});

export const toConfigError = (error: InvalidRuntimeConfig): Config.ConfigError =>
  new Config.ConfigError(new ConfigProvider.SourceError({ message: error.message }));

export const liftValidation = <A>(
  result: ValidationResult<A>,
): Effect.Effect<A, Config.ConfigError> =>
  result.ok ? Effect.succeed(result.value) : Fn.pipe(toConfigError(result.error), Effect.fail);

const trimOptional = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  const trimmed = Str.trim(raw);
  return trimmed.length > 0 ? trimmed : undefined;
};

const isKvitbitEnv = Schema.is(Schema.Literals(KVITBIT_ENVS));

const isEmailMode = Schema.is(Schema.Literals(EMAIL_MODES));

const isProdEmailMode = Schema.is(Schema.Literals(PROD_EMAIL_MODES));

const isBlobDriver = Schema.is(Schema.Literals(BLOB_DRIVERS));

const isBotProtectionMode = Schema.is(Schema.Literals(BOT_PROTECTION_MODES));

const isProdBotProtectionMode = Schema.is(Schema.Literals(PROD_BOT_PROTECTION_MODES));

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
        `must be one of ${Arr.join(KVITBIT_ENVS, ", ")} (got ${encodeJson(explicit)})`,
      );
    }
    return ok(explicit);
  }

  const nodeEnv = trimOptional(raw.nodeEnv);
  if (nodeEnv !== undefined) {
    if (!isKvitbitEnv(nodeEnv)) {
      return fail(
        "NODE_ENV",
        `must be one of ${Arr.join(KVITBIT_ENVS, ", ")} when KVITBIT_ENV is unset (got ${encodeJson(nodeEnv)})`,
      );
    }
    return ok(nodeEnv);
  }

  return ok("development");
};

const IPV4_LOOPBACK_PATTERN =
  /^127\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV4_ADDR_PATTERN = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6_HEXTET_PATTERN = /^[0-9a-f]{1,4}$/;

const parseIpv6Words = (raw: string): ReadonlyArray<number> | undefined => {
  const withoutZone = Str.split(raw, "%")[0] ?? raw;
  if (!Str.includes(":")(withoutZone)) return undefined;
  const halves = Str.split(withoutZone, "::");
  if (halves.length > 2) return undefined;

  const parseSide = (side: string, allowIpv4Tail: boolean): Array<number> | undefined => {
    if (side === "") return [];
    const parts = Str.split(side, ":");
    const words: Array<number> = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] ?? "";
      if (Str.includes(".")(part)) {
        if (!allowIpv4Tail || i !== parts.length - 1 || !IPV4_ADDR_PATTERN.test(part)) {
          return undefined;
        }
        const octets = Arr.map(Str.split(part, "."), (o) => Number.parseInt(o, 10));
        words.push(((octets[0] ?? 0) << 8) | (octets[1] ?? 0));
        words.push(((octets[2] ?? 0) << 8) | (octets[3] ?? 0));
      } else {
        if (!IPV6_HEXTET_PATTERN.test(part)) return undefined;
        words.push(Number.parseInt(part, 16));
      }
    }
    return words;
  };

  if (halves.length === 1) {
    const words = parseSide(halves[0] ?? "", true);
    return words !== undefined && words.length === 8 ? words : undefined;
  }
  const left = parseSide(halves[0] ?? "", false);
  const right = parseSide(halves[1] ?? "", true);
  if (left === undefined || right === undefined) return undefined;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return undefined;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
};

const isLoopbackOrUnspecifiedIpv6 = (words: ReadonlyArray<number>): boolean => {
  const w0 = words[0] ?? 0;
  const w1 = words[1] ?? 0;
  const w2 = words[2] ?? 0;
  const w3 = words[3] ?? 0;
  const w4 = words[4] ?? 0;
  const w5 = words[5] ?? 0;
  const w6 = words[6] ?? 0;
  const w7 = words[7] ?? 0;
  // :: (unspecified) or ::1 (loopback)
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 && w6 === 0) {
    return w7 === 0 || w7 === 1;
  }
  const embeddedLoopbackOrUnspecified = w6 >> 8 === 127 || (w6 === 0 && w7 === 0);
  // ::ffff:0:0/96 IPv4-mapped IPv6 (RFC 4291 §2.5.5.2)
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff) {
    return embeddedLoopbackOrUnspecified;
  }
  // ::/96 IPv4-compatible IPv6 (RFC 4291 §2.5.5.1)
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
    return embeddedLoopbackOrUnspecified;
  }
  // ::ffff:0:0:0/96 IPv4-translated IPv6 (RFC 2765)
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0xffff && w5 === 0) {
    return embeddedLoopbackOrUnspecified;
  }
  return false;
};

/** Returns true if `hostname` points to localhost, loopback, or an unspecified bind address. */
const isLocalhostHostname = (hostname: string): boolean => {
  const normalized = Str.replace(
    normalizedPattern,
    "",
  )(Str.toLowerCase(Str.trim(Str.replace(/^\[|\]$/g, "")(hostname))));
  if (
    normalized === "localhost" ||
    Str.endsWith(".localhost")(normalized) ||
    normalized === "localhost.localdomain" ||
    normalized === "0.0.0.0" ||
    IPV4_LOOPBACK_PATTERN.test(normalized)
  ) {
    return true;
  }
  const ipv6Words = parseIpv6Words(normalized);
  return ipv6Words !== undefined && isLoopbackOrUnspecifiedIpv6(ipv6Words);
};

/**
 * Validates `APP_ORIGIN` according to the environment contract:
 * - `production`: explicit HTTPS non-localhost origin required.
 * - `staging` / `preview`: explicit valid HTTP(S) origin required (no silent localhost fallback).
 * - `development` / `test`: defaults to `http://localhost:8080` when absent.
 */
const validateAppOriginImpl = (
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

  const parsed = URL.parse(trimmed);
  if (parsed === null) return fail("APP_ORIGIN", `invalid URL: ${encodeJson(trimmed)}`);

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return fail("APP_ORIGIN", `must use http or https protocol (got ${parsed.protocol})`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return fail("APP_ORIGIN", "must not contain credentials");
  }
  if (
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !validateAppOriginImplPattern.test(parsed.pathname)
  ) {
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

const validateAppOrigin: {
  (rawAppOrigin: string | undefined): (env: KvitbitEnv) => ValidationResult<string>;
  (env: KvitbitEnv, rawAppOrigin: string | undefined): ValidationResult<string>;
} = Fn.dual(2, validateAppOriginImpl);

const EMAIL_LOCAL_ATOM = "[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+";
const EMAIL_ADDR_PATTERN = new RegExp(
  `^${EMAIL_LOCAL_ATOM}(?:\\.${EMAIL_LOCAL_ATOM})*@(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\\.)+(?:[a-zA-Z]{2,63}|xn--[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,57}[a-zA-Z0-9])?)$`,
);

/** Validates an explicit `EMAIL_FROM` header value (either `user@domain.tld` or `Name <user@domain.tld>`). */
const isValidEmailFrom = (raw: string | undefined): boolean => {
  const trimmed = trimOptional(raw);
  if (trimmed === undefined || isValidEmailFromPattern.test(trimmed)) {
    return false;
  }
  const bracketMatch = bracketMatchPattern.exec(trimmed);
  const address = Str.trim(bracketMatch?.[1] ?? trimmed);
  if (address.length > 254) {
    return false;
  }
  const atIndex = Option.getOrElse(Str.indexOf("@")(address), () => -1);
  if (atIndex <= 0 || atIndex > 64) {
    return false;
  }
  const domain = Str.slice(atIndex + 1)(address);
  if (domain.length > 253) {
    return false;
  }
  const labels = Str.split(domain, ".");
  if (labels.length < 2 || Arr.some(labels, (label) => label.length === 0 || label.length > 63)) {
    return false;
  }
  return EMAIL_ADDR_PATTERN.test(address);
};

/** Validates an `smtp://` or `smtps://` transport URL. */
const isValidSmtpUrl = (raw: string | undefined): boolean => {
  const trimmed = trimOptional(raw);
  if (trimmed === undefined) return false;
  const url = URL.parse(trimmed);
  if (url === null || (url.protocol !== "smtp:" && url.protocol !== "smtps:")) return false;
  if (Str.trim(url.hostname).length === 0) return false;
  if (url.port !== "") {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  }
  return true;
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
const resolveEmailConfigImpl = (
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
        `must be one of ${Arr.join(RESOLVED_EMAIL_MODES, ", ")} (got ${encodeJson(rawMode)})`,
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
    mode = rawMode;
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
    mode = !(hasResend || hasSmtp) ? "console" : "capture";
  }

  if (mode === "capture" || mode === "console") {
    if (emailFrom !== undefined && !isValidEmailFrom(emailFrom)) {
      return fail("EMAIL_FROM", `invalid EMAIL_FROM address: ${encodeJson(emailFrom)}`);
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
    return fail("EMAIL_FROM", `invalid EMAIL_FROM address: ${encodeJson(emailFrom)}`);
  }

  return ok({
    mode,
    from: emailFrom,
    resendApiKey,
    smtpUrl,
  });
};

export const resolveEmailConfig: {
  (raw: {
    readonly emailMode?: string | undefined;
    readonly emailFrom?: string | undefined;
    readonly resendApiKey?: string | undefined;
    readonly smtpUrl?: string | undefined;
  }): (env: KvitbitEnv) => ValidationResult<ResolvedEmailConfig>;
  (
    env: KvitbitEnv,
    raw: {
      readonly emailMode?: string | undefined;
      readonly emailFrom?: string | undefined;
      readonly resendApiKey?: string | undefined;
      readonly smtpUrl?: string | undefined;
    },
  ): ValidationResult<ResolvedEmailConfig>;
} = Fn.dual(2, resolveEmailConfigImpl);

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
const resolveBlobConfigImpl = (
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
      `must be one of ${Arr.join(BLOB_DRIVERS, ", ")} (got ${encodeJson(rawDriver)})`,
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

export const resolveBlobConfig: {
  (raw: {
    readonly driver?: string | undefined;
    readonly bucket?: string | undefined;
    readonly localDir?: string | undefined;
    readonly gcsProject?: string | undefined;
  }): (env: KvitbitEnv) => ValidationResult<ResolvedBlobConfig>;
  (
    env: KvitbitEnv,
    raw: {
      readonly driver?: string | undefined;
      readonly bucket?: string | undefined;
      readonly localDir?: string | undefined;
      readonly gcsProject?: string | undefined;
    },
  ): ValidationResult<ResolvedBlobConfig>;
} = Fn.dual(2, resolveBlobConfigImpl);

export interface ResolvedBotProtectionConfig {
  readonly mode: ResolvedBotProtectionMode;
  readonly hmacKey: string | undefined;
}

/**
 * Resolves and validates HTTP bot-protection configuration (`KVITBIT_BOT_PROTECTION_MODE` +
 * `ALTCHA_HMAC_KEY`):
 * - `production`: non-empty `ALTCHA_HMAC_KEY` required; `none` / `disabled` are forbidden.
 * - `staging` / `preview`: fail fast if `ALTCHA_HMAC_KEY` is missing/whitespace unless
 *   `KVITBIT_BOT_PROTECTION_MODE=none` is explicitly declared; `disabled` is forbidden.
 * - `development` / `test`: zero-config (`none` when `ALTCHA_HMAC_KEY` is absent/whitespace,
 *   `altcha` when present unless `KVITBIT_BOT_PROTECTION_MODE=none`).
 */
const resolveBotProtectionConfigImpl = (
  env: KvitbitEnv,
  raw: {
    readonly mode?: string | undefined;
    readonly hmacKey?: string | undefined;
  },
): ValidationResult<ResolvedBotProtectionConfig> => {
  const rawMode = trimOptional(raw.mode);
  const hmacKey = trimOptional(raw.hmacKey);

  if (rawMode !== undefined) {
    if (!isBotProtectionMode(rawMode)) {
      return fail(
        "KVITBIT_BOT_PROTECTION_MODE",
        `must be one of ${Arr.join(RESOLVED_BOT_PROTECTION_MODES, ", ")} (got ${encodeJson(rawMode)})`,
      );
    }
    if (rawMode === "disabled") {
      return fail(
        "KVITBIT_BOT_PROTECTION_MODE",
        "KVITBIT_BOT_PROTECTION_MODE=disabled is forbidden; configure ALTCHA_HMAC_KEY or KVITBIT_BOT_PROTECTION_MODE=none in non-production",
      );
    }
    if (env === "production" && !isProdBotProtectionMode(rawMode)) {
      return fail(
        "KVITBIT_BOT_PROTECTION_MODE",
        `non-production bot protection mode '${rawMode}' is forbidden when KVITBIT_ENV=production`,
      );
    }
  }

  if (env === "production") {
    if (hmacKey === undefined) {
      return fail(
        "ALTCHA_HMAC_KEY",
        "ALTCHA_HMAC_KEY must be non-empty when KVITBIT_ENV=production",
      );
    }
    return ok({ mode: "altcha", hmacKey });
  }

  if (env === "staging" || env === "preview") {
    if (rawMode === "none") {
      return ok({ mode: "none", hmacKey: undefined });
    }
    if (hmacKey === undefined) {
      return fail(
        "ALTCHA_HMAC_KEY",
        rawMode === "altcha"
          ? "ALTCHA_HMAC_KEY is required when KVITBIT_BOT_PROTECTION_MODE=altcha"
          : `ALTCHA_HMAC_KEY must be non-empty when KVITBIT_ENV=${env} unless KVITBIT_BOT_PROTECTION_MODE=none is explicitly set`,
      );
    }
    return ok({ mode: "altcha", hmacKey });
  }

  // development / test: zero-config local DX.
  if (rawMode === "none") {
    return ok({ mode: "none", hmacKey: undefined });
  }
  if (rawMode === "altcha") {
    if (hmacKey === undefined) {
      return fail(
        "ALTCHA_HMAC_KEY",
        "ALTCHA_HMAC_KEY is required when KVITBIT_BOT_PROTECTION_MODE=altcha",
      );
    }
    return ok({ mode: "altcha", hmacKey });
  }
  return hmacKey !== undefined
    ? ok({ mode: "altcha", hmacKey })
    : ok({ mode: "none", hmacKey: undefined });
};

export const resolveBotProtectionConfig: {
  (raw: {
    readonly mode?: string | undefined;
    readonly hmacKey?: string | undefined;
  }): (env: KvitbitEnv) => ValidationResult<ResolvedBotProtectionConfig>;
  (
    env: KvitbitEnv,
    raw: {
      readonly mode?: string | undefined;
      readonly hmacKey?: string | undefined;
    },
  ): ValidationResult<ResolvedBotProtectionConfig>;
} = Fn.dual(2, resolveBotProtectionConfigImpl);

const validateWorkerBotProtectionMode = (
  env: KvitbitEnv,
  rawMode: string | undefined,
): ValidationResult<undefined> => {
  const trimmed = trimOptional(rawMode);
  if (trimmed === undefined) return ok(undefined);
  if (!isBotProtectionMode(trimmed)) {
    return fail(
      "KVITBIT_BOT_PROTECTION_MODE",
      `must be one of ${Arr.join(RESOLVED_BOT_PROTECTION_MODES, ", ")} (got ${encodeJson(trimmed)})`,
    );
  }
  if (trimmed === "disabled") {
    return fail(
      "KVITBIT_BOT_PROTECTION_MODE",
      "KVITBIT_BOT_PROTECTION_MODE=disabled is forbidden; configure ALTCHA_HMAC_KEY or KVITBIT_BOT_PROTECTION_MODE=none in non-production",
    );
  }
  if (env === "production" && !isProdBotProtectionMode(trimmed)) {
    return fail(
      "KVITBIT_BOT_PROTECTION_MODE",
      `non-production bot protection mode '${trimmed}' is forbidden when KVITBIT_ENV=production`,
    );
  }
  return ok(undefined);
};

export interface ValidatedRuntimeEnv {
  readonly env: KvitbitEnv;
  readonly workload: ServerWorkload;
  readonly appOrigin: string;
  readonly email: ResolvedEmailConfig;
  readonly blob: ResolvedBlobConfig;
  readonly botProtection: ResolvedBotProtectionConfig | undefined;
}

const FORBIDDEN_OPT_OUT_PATTERN = /^KVITBIT_(?:PREVIEW_)?DISABLE_/;

const isForbiddenOptOutKey = (key: string): boolean =>
  FORBIDDEN_OPT_OUT_PATTERN.test(key) ||
  Arr.some(FORBIDDEN_OPT_OUT_ENV_VARS, (flag) => flag === key);

const findForbiddenOptOutFlag = (
  envMap: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  // Prefer reporting an active (non-empty) forbidden flag before an explicitly empty one.
  for (const [key, value] of EffectRecord.toEntries(envMap)) {
    if (isForbiddenOptOutKey(key) && trimOptional(value) !== undefined) {
      return key;
    }
  }
  for (const [key, value] of EffectRecord.toEntries(envMap)) {
    if (isForbiddenOptOutKey(key) && value !== undefined) {
      return key;
    }
  }
  return undefined;
};

/**
 * Pure boot-time validation of the full runtime environment map for `apps/server` (`server` or
 * `worker`). Directly exercised by both runtime boot and the Tier 1 exhaustive verification suite.
 */
const validateServerRuntimeEnvImpl = (
  envMap: Readonly<Record<string, string | undefined>>,
  workload: ServerWorkload = "server",
): ValidationResult<ValidatedRuntimeEnv> => {
  const envResult = resolveKvitbitEnv({
    kvitbitEnv: envMap["KVITBIT_ENV"],
    nodeEnv: envMap["NODE_ENV"],
  });
  if (!envResult.ok) return envResult;
  const env = envResult.value;

  const forbiddenKey = findForbiddenOptOutFlag(envMap);
  if (forbiddenKey !== undefined) {
    return fail(
      forbiddenKey,
      env === "production"
        ? `opt-out flag ${forbiddenKey} is forbidden when KVITBIT_ENV=production`
        : `boolean opt-out flag ${forbiddenKey} is not supported; declare typed modes (KVITBIT_EMAIL_MODE, KVITBIT_BLOB_DRIVER, KVITBIT_BOT_PROTECTION_MODE) instead`,
    );
  }

  const databaseUrl = trimOptional(envMap["DATABASE_URL"]);
  const unpooledDatabaseUrl = trimOptional(envMap["DATABASE_URL_UNPOOLED"]);
  if (workload === "server") {
    if (databaseUrl === undefined) {
      return fail("DATABASE_URL", "DATABASE_URL must be non-empty");
    }
  } else if (databaseUrl === undefined && unpooledDatabaseUrl === undefined) {
    return fail("DATABASE_URL", "DATABASE_URL or DATABASE_URL_UNPOOLED must be non-empty");
  }

  if (trimOptional(envMap["BETTER_AUTH_SECRET"]) === undefined) {
    return fail("BETTER_AUTH_SECRET", "BETTER_AUTH_SECRET must be non-empty");
  }

  const appOrigin = validateAppOrigin(env, envMap["APP_ORIGIN"]);
  if (!appOrigin.ok) return appOrigin;

  const email = resolveEmailConfig(env, {
    emailMode: envMap["KVITBIT_EMAIL_MODE"],
    emailFrom: envMap["EMAIL_FROM"],
    resendApiKey: envMap["RESEND_API_KEY"],
    smtpUrl: envMap["KVITBIT_SMTP_URL"],
  });
  if (!email.ok) return email;

  const blob = resolveBlobConfig(env, {
    driver: envMap["KVITBIT_BLOB_DRIVER"],
    bucket: envMap["KVITBIT_BLOB_BUCKET"],
    localDir: envMap["KVITBIT_BLOB_DIR"],
    gcsProject: envMap["KVITBIT_GCS_PROJECT"],
  });
  if (!blob.ok) return blob;

  let botProtection: ResolvedBotProtectionConfig | undefined;
  if (workload === "server") {
    const botProtectionRes = resolveBotProtectionConfig(env, {
      mode: envMap["KVITBIT_BOT_PROTECTION_MODE"],
      hmacKey: envMap["ALTCHA_HMAC_KEY"],
    });
    if (!botProtectionRes.ok) return botProtectionRes;
    botProtection = botProtectionRes.value;
  } else {
    const workerModeRes = validateWorkerBotProtectionMode(
      env,
      envMap["KVITBIT_BOT_PROTECTION_MODE"],
    );
    if (!workerModeRes.ok) return workerModeRes;
  }

  return ok({
    env,
    workload,
    appOrigin: appOrigin.value,
    email: email.value,
    blob: blob.value,
    botProtection,
  });
};

export const validateServerRuntimeEnv: {
  (
    workload?: ServerWorkload,
  ): (
    envMap: Readonly<Record<string, string | undefined>>,
  ) => ValidationResult<ValidatedRuntimeEnv>;
  (
    envMap: Readonly<Record<string, string | undefined>>,
    workload?: ServerWorkload,
  ): ValidationResult<ValidatedRuntimeEnv>;
} = Fn.dual((args) => Predicate.isObject(args[0]), validateServerRuntimeEnvImpl);

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

/** Reads and validates HTTP bot-protection settings from the active Effect `ConfigProvider`. */
export const loadBotProtectionConfig: Effect.Effect<
  ResolvedBotProtectionConfig,
  Config.ConfigError
> = Effect.gen(function* () {
  const env = yield* loadKvitbitEnv;
  const mode = yield* optionalEnvString("KVITBIT_BOT_PROTECTION_MODE");
  const hmacKey = yield* Effect.map(Config.option(Config.Redacted("ALTCHA_HMAC_KEY")), (opt) =>
    Option.getOrUndefined(Option.map(opt, Redacted.value)),
  );
  return yield* liftValidation(resolveBotProtectionConfig(env, { mode, hmacKey }));
});

/**
 * Lossless raw environment snapshot carried alongside Effect's `ConfigProvider`.
 *
 * Effect v4's `ConfigProvider.fromEnv` (default `preserveEmptyStrings: false`) erases empty
 * strings when a longer key shares the same `_`-delimited prefix, and `ConfigProvider.orElse`
 * masks fallback subtrees whenever the primary provider returns any node (`Value`, `Record`, or
 * `Array`) at a prefix path. Providing `RuntimeEnv` via `makeRuntimeEnvLayer` or
 * `composeRuntimeEnvLayers` (wired at process startup in `main.ts` and `worker.ts`) preserves
 * exact key presence and effective values across composed sources before Effect normalization.
 */
export class RuntimeEnv extends Context.Service<
  RuntimeEnv,
  Readonly<Record<string, string | undefined>>
>()("@kvitbit/server/config-contract/RuntimeEnv") {}

/**
 * Merges a primary and fallback environment map using Effect `ConfigProvider.orElse` value
 * precedence (non-empty strings — including whitespace — stay primary; `""` and `undefined` fall
 * through to fallback) while preserving every configured key name (including explicit empty
 * strings) from both sources.
 */
const mergeRuntimeEnvSourcesImpl = (
  primary: Readonly<Record<string, string | undefined>>,
  fallback: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> => {
  const merged: Record<string, string | undefined> = {};
  const keys = new Set([...EffectRecord.keys(primary), ...EffectRecord.keys(fallback)]);
  for (const key of keys) {
    const primaryValue = primary[key];
    const fallbackValue = fallback[key];
    if (primaryValue !== undefined && primaryValue !== "") {
      merged[key] = primaryValue;
    } else if (fallbackValue !== undefined && fallbackValue !== "") {
      merged[key] = fallbackValue;
    } else if (primaryValue !== undefined) {
      merged[key] = primaryValue;
    } else if (fallbackValue !== undefined) {
      merged[key] = fallbackValue;
    }
  }
  return merged;
};

const mergeRuntimeEnvSources: {
  (
    fallback: Readonly<Record<string, string | undefined>>,
  ): (primary: Readonly<Record<string, string | undefined>>) => Record<string, string | undefined>;
  (
    primary: Readonly<Record<string, string | undefined>>,
    fallback: Readonly<Record<string, string | undefined>>,
  ): Record<string, string | undefined>;
} = Fn.dual(2, mergeRuntimeEnvSourcesImpl);

const definedEnvRecord = (
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of EffectRecord.toEntries(env)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
};

/** Installs both an Effect `ConfigProvider` and a lossless `RuntimeEnv` snapshot for `env`. */
export const makeRuntimeEnvLayer = (
  env: Readonly<Record<string, string | undefined>>,
): Layer.Layer<RuntimeEnv> =>
  Layer.merge(
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: definedEnvRecord(env) })),
    Layer.succeed(RuntimeEnv, env),
  );

/** Composes primary and fallback env sources while preserving exact keys and unified values. */
const composeRuntimeEnvLayersImpl = (
  primary: Readonly<Record<string, string | undefined>>,
  fallback: Readonly<Record<string, string | undefined>>,
): Layer.Layer<RuntimeEnv> => {
  const merged = mergeRuntimeEnvSources(primary, fallback);
  return Layer.merge(
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: definedEnvRecord(merged) })),
    Layer.succeed(RuntimeEnv, merged),
  );
};

export const composeRuntimeEnvLayers: {
  (
    fallback: Readonly<Record<string, string | undefined>>,
  ): (primary: Readonly<Record<string, string | undefined>>) => Layer.Layer<RuntimeEnv>;
  (
    primary: Readonly<Record<string, string | undefined>>,
    fallback: Readonly<Record<string, string | undefined>>,
  ): Layer.Layer<RuntimeEnv>;
} = Fn.dual(2, composeRuntimeEnvLayersImpl);

const MAX_ARRAY_DIRECT_SCAN = 4096;

const FORBIDDEN_PROVIDER_PROBE_PATHS: ReadonlyArray<ReadonlyArray<string>> = [
  [],
  ["KVITBIT", "DISABLE"],
  ["KVITBIT", "PREVIEW"],
  ["KVITBIT", "PREVIEW", "DISABLE"],
  ["KVITBIT", "ALLOW", "LOCAL"],
  ["KVITBIT", "ALLOW", "LOCAL", "BLOBS"],
];

const collectKvitbitProviderSubtree = (
  provider: ConfigProvider.ConfigProvider,
  path: ReadonlyArray<string | number>,
  visited: Set<string>,
): Effect.Effect<Array<readonly [string, string]>, Config.ConfigError> =>
  Effect.gen(function* () {
    const pathKey = Arr.join(Arr.map(path, String), "\0");
    if (visited.has(pathKey)) return [];
    visited.add(pathKey);

    const node = yield* provider
      .load(path)
      .pipe(Effect.mapError((error) => new Config.ConfigError(error)));
    if (node === undefined) return [];
    const entries: Array<readonly [string, string]> = [];
    if (node._tag === "Value") {
      if (path.length > 0) {
        entries.push([Arr.join(Arr.map(path, String), "_"), node.value]);
      }
      return entries;
    }
    if (node._tag === "Record") {
      if (node.value !== undefined && path.length > 0) {
        entries.push([Arr.join(Arr.map(path, String), "_"), node.value]);
      }
      for (const key of node.keys) {
        if (path.length === 0 && key !== "KVITBIT" && !Str.startsWith("KVITBIT_")(key)) {
          continue;
        }
        const childPath = [...path, key];
        const nested = yield* collectKvitbitProviderSubtree(provider, childPath, visited);
        entries.push(...nested);
        const childName = Arr.join(Arr.map(childPath, String), "_");
        if (nested.length === 0 && FORBIDDEN_OPT_OUT_PATTERN.test(childName)) {
          entries.push([childName, ""]);
        } else if (childName === "KVITBIT_ALLOW_LOCAL_BLOBS" && nested.length === 0) {
          // Only infer empty KVITBIT_ALLOW_LOCAL_BLOBS when the node itself is absent (not a container for longer keys like KVITBIT_ALLOW_LOCAL_BLOBS_EXTRA).
          const childNode = yield* provider
            .load(childPath)
            .pipe(Effect.mapError((error) => new Config.ConfigError(error)));
          if (childNode === undefined) {
            entries.push([childName, ""]);
          }
        }
      }
      return entries;
    }
    if (node._tag === "Array") {
      if (node.value !== undefined && path.length > 0) {
        entries.push([Arr.join(Arr.map(path, String), "_"), node.value]);
      }
      const arrayEntries: Array<readonly [string, string]> = [];
      const limit = Math.min(node.length, MAX_ARRAY_DIRECT_SCAN);
      for (let index = 0; index < limit; index++) {
        const nested = yield* collectKvitbitProviderSubtree(provider, [...path, index], visited);
        arrayEntries.push(...nested);
      }
      entries.push(...arrayEntries);
      if (node.length > 0 && arrayEntries.length === 0) {
        const lastName = Arr.join(Arr.map([...path, node.length - 1], String), "_");
        if (FORBIDDEN_OPT_OUT_PATTERN.test(lastName)) {
          entries.push([lastName, ""]);
        }
      }
    }
    return entries;
  });

const collectKvitbitProviderEntries = (
  provider: ConfigProvider.ConfigProvider,
): Effect.Effect<Array<readonly [string, string]>, Config.ConfigError> =>
  Effect.gen(function* () {
    const visited = new Set<string>();
    const entries: Array<readonly [string, string]> = [];
    for (const rootPath of FORBIDDEN_PROVIDER_PROBE_PATHS) {
      const found = yield* collectKvitbitProviderSubtree(provider, rootPath, visited);
      entries.push(...found);
    }
    return entries;
  });

/**
 * Loads and validates the complete boot-time runtime configuration from `RuntimeEnv` (when
 * provided via `makeRuntimeEnvLayer` / `composeRuntimeEnvLayers`, as in `main.ts` and `worker.ts`)
 * or falls back to the active Effect `ConfigProvider` before binding HTTP or starting runners.
 */
export const loadBootRuntimeConfig = (
  workload: ServerWorkload,
): Effect.Effect<ValidatedRuntimeEnv, Config.ConfigError> =>
  Effect.gen(function* () {
    const rawEnv = yield* Effect.serviceOption(RuntimeEnv);
    if (Option.isSome(rawEnv)) {
      return yield* liftValidation(validateServerRuntimeEnv(rawEnv.value, workload));
    }

    const provider = yield* ConfigProvider.ConfigProvider;
    const dynamicKvitbitEntries = yield* collectKvitbitProviderEntries(provider);

    const envMap = Object.assign(EffectRecord.empty<string, string | undefined>(), {
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
      KVITBIT_BOT_PROTECTION_MODE: yield* optionalEnvString("KVITBIT_BOT_PROTECTION_MODE"),
      ALTCHA_HMAC_KEY: yield* optionalEnvString("ALTCHA_HMAC_KEY"),
    });
    for (const [key, value] of dynamicKvitbitEntries) {
      if (!(key in envMap) || trimOptional(envMap[key]) === undefined) {
        envMap[key] = value;
      }
    }
    for (const forbidden of FORBIDDEN_OPT_OUT_ENV_VARS) {
      const direct = yield* optionalEnvString(forbidden);
      if (direct !== undefined) {
        envMap[forbidden] = direct;
      }
    }
    return yield* liftValidation(validateServerRuntimeEnv(envMap, workload));
  });
