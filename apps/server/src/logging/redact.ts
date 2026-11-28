import { API_KEY_PREFIX } from "@kvitbit/api-contract";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as HttpServerError from "effect/http/HttpServerError";
import * as Predicate from "effect/Predicate";
import * as EffectRecord from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import * as SqlError from "effect/sql/SqlError";

const authorizationHeaderCookiesPattern =
  /(?:authorization(?:header)?|cookies?|password(?:hash)?|passwd|(?:auth|smtp)pass|secret|token|apikey|databaseurl(?:unpooled)?|smtpurl|connectionstring|privatekey|verificationcode|resetcode|invitecode)$/;
const credentialsPassParamsPattern =
  /^(?:credentials?|pass|params|parameters|sql|query|sessionid|otp|magiclink|(?:smtp)?response(?:body|text)?|(?:magiclink|resetpassword|passwordreset|verification|verifyemail|invite|invitation|share|callback|redirect)(?:url|link))$/;
const failedQueryParamsPattern = /\bFailed query:|(?:^|\n)\s*(?:params|parameters):/i;
const urlsPattern = /^(?:[a-z][a-z\d+.-]*:)?\/\/[^/?#\s]*@/i;
const sanitizeLogValuePattern = /^[\dA-Z]{5}$/;

const REDACTED = "[REDACTED]";
const UNAVAILABLE = "[Unserializable]";
const MAX_DEPTH = 8;
const MAX_FIELDS = 50;
const MAX_TEXT_LENGTH = 160_000;
const PERCENT_ESCAPE = /%[\da-f]{2}/i;
const MAX_DECODE_ROUNDS = 3;

const percentSequence = /(?:%[\da-f]{2})+/gi;
const percentByte = /%([\da-f]{2})/gi;

const replaceMatches = (
  text: string,
  pattern: RegExp,
  render: (match: RegExpMatchArray) => string,
) => {
  let output = "";
  let last = 0;
  for (const match of Str.matchAll(pattern)(text)) {
    const offset = match.index ?? last;
    output += Str.slice(last, offset)(text) + render(match);
    last = offset + match[0].length;
  }
  return output + Str.slice(last)(text);
};

const decodePercentEscapes = (text: string): string =>
  replaceMatches(text, percentSequence, ([part]) =>
    Result.try({
      try: () => decodeURIComponent(part ?? ""),
      catch: () => "MalformedPercentSequence" as const,
    }).pipe(
      Result.getOrElse(() =>
        replaceMatches(part ?? "", percentByte, ([, hex]) =>
          String.fromCharCode(Number.parseInt(hex ?? "", 16)),
        ),
      ),
    ),
  );

const sensitiveKey = (key: string): boolean => {
  let decoded = key;
  for (let round = 0; round < MAX_DECODE_ROUNDS && PERCENT_ESCAPE.test(decoded); round++) {
    decoded = decodePercentEscapes(decoded);
  }
  if (PERCENT_ESCAPE.test(decoded)) return true;
  const normalized = Str.toLowerCase(Str.replace(/[^a-z0-9]/gi, "")(decoded));
  return (
    authorizationHeaderCookiesPattern.test(normalized) ||
    credentialsPassParamsPattern.test(normalized)
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
  if (failedQueryParamsPattern.test(text)) return REDACTED;
  const urls = replaceMatches(text, URL, ([found]) => {
    const url = found ?? "";
    return PRIVATE_SCHEME.test(url) ||
      urlsPattern.test(url) ||
      SECURE_PATH.test(url) ||
      SENSITIVE_QUERY.test(url)
      ? REDACTED
      : url;
  });
  const credentials = Str.replace(
    LINK_TOKEN,
    REDACTED,
  )(
    Str.replace(
      JWT,
      REDACTED,
    )(Str.replace(API_KEY, REDACTED)(Str.replace(CREDENTIAL, REDACTED)(urls))),
  );
  for (const match of Str.matchAll(ASSIGNMENT)(credentials)) {
    if (sensitiveKey(match[1] ?? "")) {
      // The rest can be an unquoted password, a cookie list, or escaped JSON.
      return Str.slice(0, (match.index ?? 0) + match[0].length)(credentials) + REDACTED;
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

export type LogValue =
  | null
  | boolean
  | number
  | string
  | Array<LogValue>
  | { [key: string]: LogValue };

const ownValue = (value: Parameters<typeof Reflect.ownKeys>[0], key: string): unknown =>
  Object.getOwnPropertyDescriptor(value, key)?.value;

const sanitizeValue = (value: unknown, ancestors = new WeakSet<object>(), depth = 0): LogValue => {
  const checked = Result.try({
    try: (): LogValue => {
      if (value === null || Predicate.isBoolean(value) || Predicate.isNumber(value)) return value;
      if (Predicate.isString(value)) return redactLogText(value);
      if (Predicate.isBigInt(value)) return value.toString();
      if (!Predicate.isObjectOrArray(value)) {
        if (Predicate.isSymbol(value)) return "[symbol]";
        if (Predicate.isFunction(value)) return "[function]";
        return "[undefined]";
      }
      if (Redacted.isRedacted(value)) return REDACTED;
      if (depth >= MAX_DEPTH) return "[Maximum depth]";
      if (ancestors.has(value)) return "[Circular]";

      ancestors.add(value);
      const sanitized = Result.try({
        try: (): LogValue => {
          const sanitize = (item: unknown) => sanitizeValue(item, ancestors, depth + 1);
          if (Cause.isCause(value)) {
            return Arr.map(Arr.take(value.reasons, MAX_FIELDS), (reason) => {
              if (Cause.isFailReason(reason))
                return { type: "Fail", error: sanitize(reason.error) };
              if (Cause.isDieReason(reason))
                return { type: "Die", defect: sanitize(reason.defect) };
              return { type: "Interrupt" };
            });
          }
          // HTTP errors can carry the full request and include its raw path in the stack.
          if (HttpServerError.isHttpServerError(value))
            return { type: value._tag, reason: value.reason._tag };
          // SQL failure messages and stacks can contain unlabeled bound values.
          if (SqlError.isSqlError(value))
            return { type: value._tag, reason: sanitize(value.reason) };
          if (SqlError.isSqlErrorReason(value)) return { type: value._tag };
          if (Arr.isArray(value)) {
            return Array.from({ length: Math.min(value.length, MAX_FIELDS) }, (_, index) =>
              sanitize(ownValue(value, String(index))),
            );
          }
          if (value instanceof globalThis.URL)
            return redactLogText(globalThis.URL.prototype.toString.call(value));

          const properties = new Set(
            Arr.take(
              Arr.filter(
                Reflect.ownKeys(value),
                (key) =>
                  Predicate.isString(key) &&
                  Object.getOwnPropertyDescriptor(value, key)?.enumerable === true,
              ),
              MAX_FIELDS,
            ),
          );
          const entries: Array<[string, LogValue]> = [];
          if (value instanceof Error) {
            const code = ownValue(value, "code");
            if (
              Predicate.isString(code) &&
              sanitizeLogValuePattern.test(code) &&
              Predicate.isString(ownValue(value, "severity"))
            ) {
              return { type: "DatabaseError", code };
            }
            entries.push(["name", sanitize(value.name)]);
            for (const field of ["message", "stack", "cause", "errors"]) {
              if (Object.getOwnPropertyDescriptor(value, field) !== undefined)
                properties.add(field);
            }
          }
          for (const key of properties) {
            if (!Predicate.isString(key)) continue;
            entries.push([
              redactLogText(key),
              sensitiveKey(key) ? REDACTED : sanitize(ownValue(value, key)),
            ]);
          }
          return EffectRecord.fromEntries(entries);
        },
        catch: () => "UnserializableLogValue" as const,
      });
      ancestors.delete(value);
      return Result.getOrElse(sanitized, () => UNAVAILABLE);
    },
    catch: () => "UnserializableLogValue" as const,
  });
  return Result.getOrElse(checked, () => UNAVAILABLE);
};

export const sanitizeLogValue = (value: unknown): LogValue => sanitizeValue(value);
