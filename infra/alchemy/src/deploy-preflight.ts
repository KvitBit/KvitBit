/**
 * Pure, zero-dependency preflight & shared config validation helpers for GCP Alchemy deploys
 * (`.github/workflows/deploy.yml` and `infra/alchemy/src/config.ts`).
 *
 * Intentionally imports zero third-party packages so `.github/workflows/deploy.yml` can execute
 * `bun infra/alchemy/src/preflight-cli.ts` immediately after checkout/setup-bun, before
 * `bun install`, GCP OIDC auth, Docker build, or database migrations.
 */

export const DEPLOY_STAGES = ["prod", "staging"] as const;
export type DeployStage = (typeof DEPLOY_STAGES)[number];

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

export const BLOB_DRIVERS = ["gcs", "local"] as const;
export type BlobDriver = (typeof BLOB_DRIVERS)[number];

export const BOT_PROTECTION_MODES = ["altcha", "none", "disabled"] as const;
export type BotProtectionMode = (typeof BOT_PROTECTION_MODES)[number];

export const PROD_BOT_PROTECTION_MODES = ["altcha"] as const;
export type ProdBotProtectionMode = (typeof PROD_BOT_PROTECTION_MODES)[number];

export const DEPLOY_MODES = [
  "normal",
  "bootstrap_foundation",
  "bootstrap_feedback_secret",
  "bootstrap_altcha_secret",
] as const;
export type DeployMode = (typeof DEPLOY_MODES)[number];

export const SECRET_FLAG_ENV_VARS = [
  "KVITBIT_ENABLE_RESEND_SECRET",
  "KVITBIT_ENABLE_SMTP_SECRET",
  "KVITBIT_ENABLE_MOBILE_SIGNING_KEY_SECRET",
  "KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET",
  "KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET",
] as const;
export type SecretFlagEnvVar = (typeof SECRET_FLAG_ENV_VARS)[number];

export const REQUIRED_GCP_VARS = [
  "GCP_PROJECT_ID",
  "GCP_PROJECT_NUMBER",
  "GCP_REGION",
  "GCP_ZONE",
  "GCP_WORKLOAD_IDENTITY_PROVIDER",
  "GCP_DEPLOYER_SERVICE_ACCOUNT",
  "ALCHEMY_STATE_BUCKET",
] as const;

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

const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const IPV4_LOOPBACK_PATTERN =
  /^127\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV4_ADDR_PATTERN = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6_HEXTET_PATTERN = /^[0-9a-f]{1,4}$/;
const EMAIL_LOCAL_ATOM = "[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+";
const EMAIL_ADDR_PATTERN = new RegExp(
  `^${EMAIL_LOCAL_ATOM}(?:\\.${EMAIL_LOCAL_ATOM})*@(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\\.)+(?:[a-zA-Z]{2,63}|xn--[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,57}[a-zA-Z0-9])?)$`,
);
const FORBIDDEN_OPT_OUT_PATTERN = /^KVITBIT_(?:PREVIEW_)?DISABLE_/;

const parseIpv6Words = (raw: string): ReadonlyArray<number> | undefined => {
  const withoutZone = raw.split("%")[0] ?? raw;
  if (!withoutZone.includes(":")) return undefined;
  const halves = withoutZone.split("::");
  if (halves.length > 2) return undefined;

  const parseSide = (side: string, allowIpv4Tail: boolean): Array<number> | undefined => {
    if (side === "") return [];
    const parts = side.split(":");
    const words: Array<number> = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] ?? "";
      if (part.includes(".")) {
        if (!allowIpv4Tail || i !== parts.length - 1 || !IPV4_ADDR_PATTERN.test(part)) {
          return undefined;
        }
        const octets = part.split(".").map((o) => Number.parseInt(o, 10));
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
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 && w6 === 0) {
    return w7 === 0 || w7 === 1;
  }
  const embeddedLoopbackOrUnspecified = w6 >> 8 === 127 || (w6 === 0 && w7 === 0);
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff) {
    return embeddedLoopbackOrUnspecified;
  }
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
    return embeddedLoopbackOrUnspecified;
  }
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0xffff && w5 === 0) {
    return embeddedLoopbackOrUnspecified;
  }
  return false;
};

export const trimOptional = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const isValidDomain = (domain: string): boolean => {
  const normalized = domain.trim().toLowerCase();
  if (!DOMAIN_PATTERN.test(normalized) || normalized.length > 253) {
    return false;
  }
  const labels = normalized.split(".");
  if (labels.some((label) => label.length > 63)) {
    return false;
  }
  return !/^\d+$/.test(labels[labels.length - 1] ?? "");
};

export const isLocalhostHostname = (hostname: string): boolean => {
  const normalized = hostname
    .replace(/^\[|\]$/g, "")
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "localhost.localdomain" ||
    normalized === "0.0.0.0" ||
    IPV4_LOOPBACK_PATTERN.test(normalized)
  ) {
    return true;
  }
  const ipv6Words = parseIpv6Words(normalized);
  return ipv6Words !== undefined && isLoopbackOrUnspecifiedIpv6(ipv6Words);
};

export const validateOriginUrl = (
  raw: string | undefined,
  options: { readonly requireHttpsNonLocalhost: boolean },
):
  | { readonly ok: true; readonly origin: string }
  | { readonly ok: false; readonly reason: string } => {
  const trimmed = trimOptional(raw);
  if (trimmed === undefined) {
    return { ok: false, reason: "must be explicitly set" };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: `invalid URL '${trimmed}'` };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: `must use http or https protocol (got '${parsed.protocol}')` };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "must not contain credentials" };
  }
  if (parsed.search !== "" || parsed.hash !== "" || !/^\/*$/.test(parsed.pathname)) {
    return {
      ok: false,
      reason: `must be an origin without path, query, or fragment (got '${trimmed}')`,
    };
  }
  if (options.requireHttpsNonLocalhost) {
    if (parsed.protocol !== "https:") {
      return { ok: false, reason: `production origin must use https (got '${parsed.origin}')` };
    }
    if (isLocalhostHostname(parsed.hostname)) {
      return {
        ok: false,
        reason: `production origin must not point to localhost or loopback (got '${parsed.origin}')`,
      };
    }
  }
  return { ok: true, origin: parsed.origin };
};

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
  const domain = address.slice(atIndex + 1);
  if (domain.length > 253) {
    return false;
  }
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => label.length === 0 || label.length > 63)) {
    return false;
  }
  return EMAIL_ADDR_PATTERN.test(address);
};

export const parseOptionalBoolean = (
  raw: string | undefined,
  defaultValue: boolean,
):
  | { readonly ok: true; readonly value: boolean }
  | { readonly ok: false; readonly reason: string } => {
  const trimmed = trimOptional(raw);
  if (trimmed === undefined) {
    return { ok: true, value: defaultValue };
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return { ok: true, value: true };
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return { ok: true, value: false };
  }
  return {
    ok: false,
    reason: `expected boolean ('true'/'1'/'yes'/'on' or 'false'/'0'/'no'/'off'), got '${raw ?? ""}'`,
  };
};

export const parseCsvDomainList = (raw: string | undefined): ReadonlyArray<string> => {
  const trimmed = trimOptional(raw);
  if (trimmed === undefined) return [];
  return trimmed
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
};

export const isEmailMode = (value: string): value is EmailMode =>
  (EMAIL_MODES as ReadonlyArray<string>).includes(value);

export const isProdEmailMode = (value: string): value is ProdEmailMode =>
  (PROD_EMAIL_MODES as ReadonlyArray<string>).includes(value);

export const isBlobDriver = (value: string): value is BlobDriver =>
  (BLOB_DRIVERS as ReadonlyArray<string>).includes(value);

export const isBotProtectionMode = (value: string): value is BotProtectionMode =>
  (BOT_PROTECTION_MODES as ReadonlyArray<string>).includes(value);

export const isProdBotProtectionMode = (value: string): value is ProdBotProtectionMode =>
  (PROD_BOT_PROTECTION_MODES as ReadonlyArray<string>).includes(value);

export const isForbiddenOptOutPrefixKey = (key: string): boolean =>
  FORBIDDEN_OPT_OUT_PATTERN.test(key);

export const isForbiddenOptOutKey = (key: string): boolean =>
  isForbiddenOptOutPrefixKey(key) ||
  (FORBIDDEN_OPT_OUT_ENV_VARS as ReadonlyArray<string>).includes(key);

export const findForbiddenOptOutFlag = (
  env: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  // Prefer reporting an active (non-empty) forbidden flag before an explicitly empty one.
  for (const [key, value] of Object.entries(env)) {
    if (isForbiddenOptOutKey(key) && trimOptional(value) !== undefined) {
      return key;
    }
  }
  for (const [key, value] of Object.entries(env)) {
    if (isForbiddenOptOutKey(key) && value !== undefined) {
      return key;
    }
  }
  return undefined;
};

export type DeployPreflightSuccess = {
  readonly ok: true;
  readonly deployMode: DeployMode;
  readonly normalizedBooleans: Readonly<Record<SecretFlagEnvVar, boolean>>;
};

export type DeployPreflightFailure = {
  readonly ok: false;
  readonly field: string;
  readonly message: string;
};

export type DeployPreflightResult = DeployPreflightSuccess | DeployPreflightFailure;

const failPreflight = (field: string, message: string): DeployPreflightFailure => ({
  ok: false,
  field,
  message,
});

/**
 * Pure preflight validator executed by `.github/workflows/deploy.yml` before installing deps,
 * authenticating to GCP, or building OCI images.
 */
export const validateDeployPreflight = (
  env: Readonly<Record<string, string | undefined>>,
): DeployPreflightResult => {
  const stage = trimOptional(env.KVITBIT_STAGE);
  if (stage !== "prod") {
    return failPreflight(
      "KVITBIT_STAGE",
      `deploy.yml is strictly production-only until an isolated staging environment exists (got KVITBIT_STAGE=${env.KVITBIT_STAGE ?? ""})`,
    );
  }

  const bootstrapFoundationParsed = parseOptionalBoolean(env.BOOTSTRAP_FOUNDATION, false);
  if (!bootstrapFoundationParsed.ok) {
    return failPreflight(
      "BOOTSTRAP_FOUNDATION",
      `Invalid boolean value for BOOTSTRAP_FOUNDATION: ${bootstrapFoundationParsed.reason}`,
    );
  }
  const bootstrapFeedbackParsed = parseOptionalBoolean(env.BOOTSTRAP_FEEDBACK_SECRET, false);
  if (!bootstrapFeedbackParsed.ok) {
    return failPreflight(
      "BOOTSTRAP_FEEDBACK_SECRET",
      `Invalid boolean value for BOOTSTRAP_FEEDBACK_SECRET: ${bootstrapFeedbackParsed.reason}`,
    );
  }
  const bootstrapAltchaParsed = parseOptionalBoolean(env.BOOTSTRAP_ALTCHA_SECRET, false);
  if (!bootstrapAltchaParsed.ok) {
    return failPreflight(
      "BOOTSTRAP_ALTCHA_SECRET",
      `Invalid boolean value for BOOTSTRAP_ALTCHA_SECRET: ${bootstrapAltchaParsed.reason}`,
    );
  }

  const bootstrapFoundation = bootstrapFoundationParsed.value;
  const bootstrapFeedbackSecret = bootstrapFeedbackParsed.value;
  const bootstrapAltchaSecret = bootstrapAltchaParsed.value;
  const activeBootstraps = [
    bootstrapFoundation,
    bootstrapFeedbackSecret,
    bootstrapAltchaSecret,
  ].filter(Boolean).length;
  if (activeBootstraps > 1) {
    return failPreflight(
      bootstrapAltchaSecret ? "BOOTSTRAP_ALTCHA_SECRET" : "BOOTSTRAP_FEEDBACK_SECRET",
      "Select only one of bootstrap_foundation, bootstrap_feedback_secret, and bootstrap_altcha_secret.",
    );
  }

  for (const name of REQUIRED_GCP_VARS) {
    if (trimOptional(env[name]) === undefined) {
      return failPreflight(name, `Missing required repository variable: ${name}`);
    }
  }

  const projectId = trimOptional(env.GCP_PROJECT_ID) ?? "";
  const projectNumber = trimOptional(env.GCP_PROJECT_NUMBER) ?? "";
  const region = trimOptional(env.GCP_REGION) ?? "";
  const zone = trimOptional(env.GCP_ZONE) ?? "";
  const deployerSa = trimOptional(env.GCP_DEPLOYER_SERVICE_ACCOUNT) ?? "";

  if (!/^\d+$/.test(projectNumber)) {
    return failPreflight(
      "GCP_PROJECT_NUMBER",
      `GCP_PROJECT_NUMBER must be numeric (got '${projectNumber}')`,
    );
  }
  if (!zone.startsWith(`${region}-`)) {
    return failPreflight("GCP_ZONE", `GCP_ZONE '${zone}' must belong to GCP_REGION '${region}'`);
  }
  if (!deployerSa.endsWith(`@${projectId}.iam.gserviceaccount.com`)) {
    return failPreflight(
      "GCP_DEPLOYER_SERVICE_ACCOUNT",
      `GCP_DEPLOYER_SERVICE_ACCOUNT must belong to ${projectId}`,
    );
  }

  const normalizedBooleans = {} as Record<SecretFlagEnvVar, boolean>;
  for (const flag of SECRET_FLAG_ENV_VARS) {
    const parsed = parseOptionalBoolean(env[flag], false);
    if (!parsed.ok) {
      return failPreflight(flag, `Invalid boolean value for ${flag}: ${parsed.reason}`);
    }
    normalizedBooleans[flag] = parsed.value;
  }

  // Zero opt-outs or non-prod modes are allowed in production deploys (even during bootstrap).
  // Inspect both process env and the full GitHub Actions repository `vars` JSON when provided.
  const forbiddenFlag = findForbiddenOptOutFlag(env);
  if (forbiddenFlag !== undefined) {
    return failPreflight(
      forbiddenFlag,
      `Opt-out flag ${forbiddenFlag} is forbidden in production deploys.`,
    );
  }
  const repoVarsJson = trimOptional(env.KVITBIT_REPO_VARS_JSON);
  if (repoVarsJson !== undefined) {
    let parsedVars: unknown;
    try {
      parsedVars = JSON.parse(repoVarsJson);
    } catch {
      return failPreflight(
        "KVITBIT_REPO_VARS_JSON",
        "KVITBIT_REPO_VARS_JSON must be a valid JSON object.",
      );
    }
    if (typeof parsedVars !== "object" || parsedVars === null || Array.isArray(parsedVars)) {
      return failPreflight(
        "KVITBIT_REPO_VARS_JSON",
        "KVITBIT_REPO_VARS_JSON must be a JSON object.",
      );
    }
    const repoVarsMap: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(parsedVars as Record<string, unknown>)) {
      if (v !== null && v !== undefined) {
        repoVarsMap[k] = String(v);
      }
    }
    const forbiddenRepoVar = findForbiddenOptOutFlag(repoVarsMap);
    if (forbiddenRepoVar !== undefined) {
      return failPreflight(
        forbiddenRepoVar,
        `Opt-out repository variable ${forbiddenRepoVar} is forbidden in production deploys.`,
      );
    }
  }

  const kvitbitEnv = trimOptional(env.KVITBIT_ENV);
  if (kvitbitEnv !== undefined && kvitbitEnv !== "production") {
    return failPreflight(
      "KVITBIT_ENV",
      `Non-production KVITBIT_ENV='${kvitbitEnv}' is forbidden in production deploys.`,
    );
  }

  const emailMode = trimOptional(env.KVITBIT_EMAIL_MODE);
  if (emailMode !== undefined && !isProdEmailMode(emailMode)) {
    return failPreflight(
      "KVITBIT_EMAIL_MODE",
      `Non-production or invalid KVITBIT_EMAIL_MODE='${emailMode}' is forbidden in production deploys (expected resend, smtp, or resend+smtp).`,
    );
  }

  const blobDriver = trimOptional(env.KVITBIT_BLOB_DRIVER);
  if (blobDriver !== undefined && blobDriver !== "gcs") {
    return failPreflight(
      "KVITBIT_BLOB_DRIVER",
      `Non-production or invalid KVITBIT_BLOB_DRIVER='${blobDriver}' is forbidden in production deploys (expected gcs).`,
    );
  }

  const botProtectionMode = trimOptional(env.KVITBIT_BOT_PROTECTION_MODE);
  if (botProtectionMode !== undefined && !isProdBotProtectionMode(botProtectionMode)) {
    return failPreflight(
      "KVITBIT_BOT_PROTECTION_MODE",
      `Non-production or invalid KVITBIT_BOT_PROTECTION_MODE='${botProtectionMode}' is forbidden in production deploys (expected altcha).`,
    );
  }

  if (bootstrapFeedbackSecret) {
    if (!normalizedBooleans.KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET) {
      return failPreflight(
        "KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET",
        "Set the KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET repository variable to true before bootstrapping the feedback token container.",
      );
    }
    return {
      ok: true,
      deployMode: "bootstrap_feedback_secret",
      normalizedBooleans,
    };
  }

  if (bootstrapAltchaSecret) {
    if (!normalizedBooleans.KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET) {
      return failPreflight(
        "KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET",
        "Set the KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET repository variable to true before bootstrapping the ALTCHA HMAC key container.",
      );
    }
    return {
      ok: true,
      deployMode: "bootstrap_altcha_secret",
      normalizedBooleans,
    };
  }

  if (bootstrapFoundation) {
    return {
      ok: true,
      deployMode: "bootstrap_foundation",
      normalizedBooleans,
    };
  }

  // Normal production deploy: require APP_ORIGIN (HTTPS non-localhost), EMAIL_FROM,
  // KVITBIT_EDGE_DOMAINS, and at least one real email secret matching KVITBIT_EMAIL_MODE.
  const originCheck = validateOriginUrl(env.APP_ORIGIN, { requireHttpsNonLocalhost: true });
  if (!originCheck.ok) {
    return failPreflight("APP_ORIGIN", `Invalid production APP_ORIGIN: ${originCheck.reason}`);
  }

  if (!isValidEmailFrom(env.EMAIL_FROM)) {
    return failPreflight(
      "EMAIL_FROM",
      `Production deploys require a valid EMAIL_FROM address (got '${env.EMAIL_FROM ?? ""}')`,
    );
  }

  const edgeDomains = parseCsvDomainList(env.KVITBIT_EDGE_DOMAINS);
  if (edgeDomains.length === 0) {
    return failPreflight(
      "KVITBIT_EDGE_DOMAINS",
      "Production deploys require at least one domain in KVITBIT_EDGE_DOMAINS.",
    );
  }
  for (const domain of edgeDomains) {
    if (!isValidDomain(domain)) {
      return failPreflight(
        "KVITBIT_EDGE_DOMAINS",
        `Invalid domain in KVITBIT_EDGE_DOMAINS: '${domain}'`,
      );
    }
  }

  const enableResend = normalizedBooleans.KVITBIT_ENABLE_RESEND_SECRET;
  const enableSmtp = normalizedBooleans.KVITBIT_ENABLE_SMTP_SECRET;
  if (!enableResend && !enableSmtp) {
    return failPreflight(
      "KVITBIT_ENABLE_RESEND_SECRET",
      "Production deploys require at least one real email provider secret enabled (KVITBIT_ENABLE_RESEND_SECRET=true and/or KVITBIT_ENABLE_SMTP_SECRET=true).",
    );
  }
  if ((emailMode === "resend" || emailMode === "resend+smtp") && !enableResend) {
    return failPreflight(
      "KVITBIT_ENABLE_RESEND_SECRET",
      `KVITBIT_EMAIL_MODE=${emailMode} requires KVITBIT_ENABLE_RESEND_SECRET=true.`,
    );
  }
  if ((emailMode === "smtp" || emailMode === "resend+smtp") && !enableSmtp) {
    return failPreflight(
      "KVITBIT_ENABLE_SMTP_SECRET",
      `KVITBIT_EMAIL_MODE=${emailMode} requires KVITBIT_ENABLE_SMTP_SECRET=true.`,
    );
  }
  if (!normalizedBooleans.KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET) {
    return failPreflight(
      "KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET",
      "Production deploys require KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET=true so Cloud Run receives ALTCHA_HMAC_KEY.",
    );
  }

  return {
    ok: true,
    deployMode: "normal",
    normalizedBooleans,
  };
};
