import { Schema } from "effect";

export const FEEDBACK_LIMITS = {
  comment: 2_000,
  pins: 8,
  diagnostics: 20,
  selector: 1_000,
  domPath: 1_000,
  tag: 64,
  accessibleName: 300,
  role: 80,
  text: 500,
  style: 100,
  url: 2_048,
  locale: 64,
  theme: 64,
} as const;

const boundedString = (maxLength: number) => Schema.String.check(Schema.isMaxLength(maxLength));
const boundedNumber = (minimum: number, maximum: number) =>
  Schema.Number.check(Schema.isFinite(), Schema.isBetween({ minimum, maximum }));
const extent = boundedNumber(0, 10_000_000);
const coordinate = boundedNumber(-10_000_000, 10_000_000);
const style = boundedString(FEEDBACK_LIMITS.style);

export const FeedbackSubmission = Schema.Struct({
  comment: boundedString(FEEDBACK_LIMITS.comment).check(Schema.isPattern(/[^\s\p{C}]/u)),
  pins: Schema.Array(
    Schema.Struct({
      selector: boundedString(FEEDBACK_LIMITS.selector),
      domPath: boundedString(FEEDBACK_LIMITS.domPath),
      tag: boundedString(FEEDBACK_LIMITS.tag),
      accessibleName: boundedString(FEEDBACK_LIMITS.accessibleName),
      role: boundedString(FEEDBACK_LIMITS.role),
      rect: Schema.Struct({ x: coordinate, y: coordinate, width: extent, height: extent }),
      text: boundedString(FEEDBACK_LIMITS.text),
      styles: Schema.Struct({
        display: style,
        position: style,
        color: style,
        backgroundColor: style,
        fontSize: style,
        fontWeight: style,
      }),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(FEEDBACK_LIMITS.pins)),
  page: Schema.Struct({
    url: boundedString(FEEDBACK_LIMITS.url),
    locale: boundedString(FEEDBACK_LIMITS.locale),
    theme: boundedString(FEEDBACK_LIMITS.theme),
    viewport: Schema.Struct({ width: extent, height: extent }),
    dpr: boundedNumber(0, 64).check(Schema.isGreaterThan(0)),
  }),
  diagnostics: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["warn", "error", "onerror", "unhandledrejection"]),
      timestamp: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 })),
    }),
  ).check(Schema.isMaxLength(FEEDBACK_LIMITS.diagnostics)),
});
export type FeedbackSubmission = typeof FeedbackSubmission.Type;

export const FeedbackIssue = Schema.Struct({
  issueNumber: Schema.Int.check(Schema.isGreaterThan(0)),
  issueUrl: Schema.String,
  title: Schema.String,
});
export type FeedbackIssue = typeof FeedbackIssue.Type;

const REDACTED_VALUE = "[redacted]";
const REDACTED_PATH = `/${REDACTED_VALUE}`;
const WORKSPACE_API_KEYS_PATH = /^\/w\/[^/]+\/settings\/(?:apikeys|api-keys)(?:\/|$)/;
const WORKSPACE_API_KEY = /kvb_[a-zA-Z\d-]{8,64}_[a-zA-Z\d_-]*/g;

/** Removes complete or truncated keys while retaining the public prefix shown in lists. */
export const redactFeedbackApiKeys = (value: string) =>
  value.replaceAll(WORKSPACE_API_KEY, REDACTED_VALUE);

const SENSITIVE_PATHS = [
  "/i",
  "/s",
  "/invite",
  "/auth",
  "/consent",
  "/oauth/consent",
  "/reset-password",
  "/check-email",
  "/api/v1/share",
  "/api/v1/invitations",
  "/api/auth/callback",
  "/api/auth/magic-link",
  "/api/auth/reset-password",
  "/api/auth/verify-email",
  "/api/auth/oauth2",
];

const feedbackRoutes = (path: string) => {
  const normalized = path
    .replaceAll("\\", "/")
    .replaceAll(/\/{2,}/g, "/")
    .toLowerCase();
  // The decode loop below can reveal dot segments that the first URL parse did not resolve.
  const canonical = new URL(`https://feedback.invalid${normalized}`).pathname;
  return [normalized, canonical].map((candidate) => candidate.replace(/^\/app(?=\/)/, ""));
};

const sensitiveRoute = (route: string) =>
  WORKSPACE_API_KEYS_PATH.test(route) ||
  SENSITIVE_PATHS.some((prefix) => route === prefix || route.startsWith(`${prefix}/`));

const EMBEDDED_URL =
  /(?:https?(?::|%(?:25)*3a)(?:\/|%(?:25)*2f){2}(?:\[[\da-f:.]+\])?|(?<![\w./%\\-])(?:\/|%(?:25)*2f))[^\s<>"'`()[\]{}]+/gi;

// Decode bytes individually so a malformed escape cannot hide an encoded route.
const decodePercentBytes = (value: string) =>
  value.replaceAll(/%([\da-f]{2})/gi, (_, byte: string) =>
    String.fromCharCode(Number.parseInt(byte, 16)),
  );

const hasSensitivePath = (value: string) => {
  let candidate = value;
  if (/^https?/i.test(candidate)) {
    // Decode the absolute URL's separators before URL parsing, which otherwise treats it as a path.
    for (let depth = 0; depth < 8 && !/^https?:\/\//i.test(candidate); depth++) {
      candidate = decodePercentBytes(candidate);
    }
    if (!/^https?:\/\//i.test(candidate)) return true;
  }

  let path: string;
  try {
    path = new URL(candidate, "https://feedback.invalid").pathname;
  } catch {
    return false;
  }

  for (let depth = 0; depth < 8; depth++) {
    if (feedbackRoutes(path).some(sensitiveRoute)) return true;
    const decoded = decodePercentBytes(path);
    if (decoded === path) return false;
    path = decoded;
  }
  return true;
};

/** Removes embedded URLs on sensitive routes, including root-relative links. */
export const redactFeedbackUrls = (value: string) =>
  value.replaceAll(EMBEDDED_URL, (url) => (hasSensitivePath(url) ? REDACTED_VALUE : url));

/** Removes URL credentials, query, fragment and paths that may contain access tokens. */
export const sanitizeFeedbackPageUrl = (value: string) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;

  const redacted = { url: `${url.origin}${REDACTED_PATH}`, sensitive: true };
  if (redacted.url.length > FEEDBACK_LIMITS.url) return undefined;
  const sanitized = `${url.origin}${url.pathname}`;
  if (sanitized.length > FEEDBACK_LIMITS.url) return redacted;
  let path = url.pathname;
  // Repeated encoding or ambiguous path delimiters must not disguise a sensitive route.
  for (let depth = 0; depth < 8; depth++) {
    if (
      /[?#]/.test(path) ||
      feedbackRoutes(path).some(
        (route) =>
          route === REDACTED_PATH || route.startsWith(`${REDACTED_PATH}/`) || sensitiveRoute(route),
      ) ||
      redactFeedbackApiKeys(path) !== path
    )
      return redacted;
    if (!/%[\da-f]{2}/i.test(path)) {
      return { url: sanitized, sensitive: false };
    }
    try {
      path = decodeURIComponent(path);
    } catch {
      return redacted;
    }
  }
  return redacted;
};
