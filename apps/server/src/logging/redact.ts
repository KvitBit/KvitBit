import { API_KEY_PREFIX } from "@kvitbit/api-contract";
import { Cause, Redacted } from "effect";
import { isHttpServerError } from "effect/http/HttpServerError";
import { isSqlError, isSqlErrorReason } from "effect/sql/SqlError";

const REDACTED = "[REDACTED]";
const UNAVAILABLE = "[Unserializable]";
const MAX_DEPTH = 8;
const MAX_FIELDS = 50;
const MAX_TEXT_LENGTH = 160_000;
const PERCENT_ESCAPE = /%[\da-f]{2}/i;
const MAX_DECODE_ROUNDS = 3;

const decodePercentEscapes = (text: string): string =>
  text.replace(/(?:%[\da-f]{2})+/gi, (part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part.replace(/%([\da-f]{2})/gi, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    }
  });

const sensitiveKey = (key: string): boolean => {
  let decoded = key;
  for (let round = 0; round < MAX_DECODE_ROUNDS && PERCENT_ESCAPE.test(decoded); round++) {
    decoded = decodePercentEscapes(decoded);
  }
  if (PERCENT_ESCAPE.test(decoded)) return true;
  const normalized = decoded.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    /(?:authorization(?:header)?|cookies?|password(?:hash)?|passwd|(?:auth|smtp)pass|secret|token|apikey|databaseurl(?:unpooled)?|smtpurl|connectionstring|privatekey|verificationcode|resetcode|invitecode)$/.test(
      normalized,
    ) ||
    /^(?:credentials?|pass|params|parameters|sql|query|sessionid|otp|magiclink|(?:smtp)?response(?:body|text)?|(?:magiclink|resetpassword|passwordreset|verification|verifyemail|invite|invitation|share|callback|redirect)(?:url|link))$/.test(
      normalized,
    )
  );
};

const SECURE_PATH =
  /\/(?:s|i|share|invite|invitation|invitations|accept-invitation|reset-password|password-reset|verify-email|email-verification|magic-link|auth\/magic|consent|consents)(?:\/|[?#]|$)/i;
const SENSITIVE_QUERY =
  /[?&#](?:[^=&#]*token|[^=&#]*password|[^=&#]*secret|api[-_]?key|code|state|oauth_query|consent(?:_?id)?|signature|x-goog-signature|callbackurl|redirect_uri)=/i;
const PRIVATE_SCHEME =
  /^(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis(?:s)?|smtp(?:s)?|sqlserver):\/\//i;
const URL = /\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+|(?:^|(?<=[\s("'=]))\/{1,2}[^\s"'<>]+/gi;
const ASSIGNMENT = /\b([\w.-]+)(?:\\*["'])?\s*[:=]\s*/g;
const CREDENTIAL = /\b(?:Bearer|Basic)\s+[^\s,;"'<>]+/gi;
const API_KEY = new RegExp(`\\b${API_KEY_PREFIX}[A-Za-z0-9_-]+`, "g");
// Cloud share tokens include a version. Invitation tokens are base64url HMAC-SHA256.
const LINK_TOKEN = /(?<![\w-])(?:v\d{1,10}\.)?[\w-]{43}(?![\w-])/g;
const JWT = /(?<![\w-])eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+(?![\w-])/g;

const redactText = (text: string): string => {
  if (/\bFailed query:|(?:^|\n)\s*(?:params|parameters):/i.test(text)) return REDACTED;
  const urls = text.replace(URL, (url) =>
    PRIVATE_SCHEME.test(url) ||
    /^(?:[a-z][a-z\d+.-]*:)?\/\/[^/?#\s]*@/i.test(url) ||
    SECURE_PATH.test(url) ||
    SENSITIVE_QUERY.test(url)
      ? REDACTED
      : url,
  );
  const credentials = urls
    .replace(CREDENTIAL, REDACTED)
    .replace(API_KEY, REDACTED)
    .replace(JWT, REDACTED)
    .replace(LINK_TOKEN, REDACTED);
  for (const match of credentials.matchAll(ASSIGNMENT)) {
    if (sensitiveKey(match[1] ?? "")) {
      // The rest can be an unquoted password, a cookie list, or escaped JSON.
      return credentials.slice(0, match.index + match[0].length) + REDACTED;
    }
  }
  return credentials;
};

export const redactLogText = (text: string): string => {
  if (text.length > MAX_TEXT_LENGTH) return "[Log text exceeded the size limit]";
  let decoded = text;
  // Inspect escaped copies without emitting newly decoded control characters or text.
  for (let round = 0; round < MAX_DECODE_ROUNDS && PERCENT_ESCAPE.test(decoded); round++) {
    decoded = decodePercentEscapes(decoded);
    if (redactText(decoded) !== decoded) return REDACTED;
  }
  return PERCENT_ESCAPE.test(decoded) ? REDACTED : redactText(text);
};

type LogValue = null | boolean | number | string | Array<LogValue> | { [key: string]: LogValue };

const ownValue = (object: object, key: string): unknown =>
  Object.getOwnPropertyDescriptor(object, key)?.value;

export const sanitizeLogValue = (
  value: unknown,
  ancestors = new WeakSet<object>(),
  depth = 0,
): LogValue => {
  try {
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") return redactLogText(value);
    if (typeof value === "bigint") return value.toString();
    if (typeof value !== "object") return `[${typeof value}]`;
    if (Redacted.isRedacted(value)) return REDACTED;
    if (depth >= MAX_DEPTH) return "[Maximum depth]";
    if (ancestors.has(value)) return "[Circular]";

    ancestors.add(value);
    try {
      const sanitize = (item: unknown) => sanitizeLogValue(item, ancestors, depth + 1);
      if (Cause.isCause(value)) {
        return value.reasons.slice(0, MAX_FIELDS).map((reason) => {
          if (Cause.isFailReason(reason)) return { type: "Fail", error: sanitize(reason.error) };
          if (Cause.isDieReason(reason)) return { type: "Die", defect: sanitize(reason.defect) };
          return { type: "Interrupt" };
        });
      }
      // HTTP errors can carry the full request and include its raw path in the stack.
      if (isHttpServerError(value)) return { type: value._tag, reason: value.reason._tag };
      // SQL failure messages and stacks can contain unlabeled bound values.
      if (isSqlError(value)) return { type: value._tag, reason: sanitize(value.reason) };
      if (isSqlErrorReason(value)) return { type: value._tag };
      if (Array.isArray(value)) {
        return Array.from({ length: Math.min(value.length, MAX_FIELDS) }, (_, index) =>
          sanitize(ownValue(value, String(index))),
        );
      }
      if (value instanceof globalThis.URL)
        return redactLogText(globalThis.URL.prototype.toString.call(value));

      const properties = new Set(Object.keys(value).slice(0, MAX_FIELDS));
      const entries: Array<[string, LogValue]> = [];
      if (value instanceof Error) {
        const code = ownValue(value, "code");
        if (
          typeof code === "string" &&
          /^[\dA-Z]{5}$/.test(code) &&
          typeof ownValue(value, "severity") === "string"
        ) {
          return { type: "DatabaseError", code };
        }
        entries.push(["name", sanitize(value.name)]);
        for (const field of ["message", "stack", "cause", "errors"]) {
          if (Object.hasOwn(value, field)) properties.add(field);
        }
      }
      for (const key of properties) {
        entries.push([
          redactLogText(key),
          sensitiveKey(key) ? REDACTED : sanitize(ownValue(value, key)),
        ]);
      }
      return Object.fromEntries(entries);
    } finally {
      ancestors.delete(value);
    }
  } catch {
    return UNAVAILABLE;
  }
};
