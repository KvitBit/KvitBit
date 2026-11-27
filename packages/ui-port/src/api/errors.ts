// biome-ignore-all lint/suspicious/noUnnecessaryConditions: The lint resolver omits the tags inherited from Effect schema classes.
/**
 * UiError and the one error mapping (ui-port-contracts section 2.6). `toUiError` normalizes
 * anything a KvitbitApi call can fail with; `describe` turns a UiError into the render-ready
 * model (field issues, banner text, retry hints) that every screen starts from.
 */

import {
  InvalidBotProof,
  OriginRejected,
  PayloadTooLarge,
  PreconditionFailed,
  PreconditionRequired,
  RateLimited,
  Unauthorized,
} from "@kvitbit/api-contract";
import {
  Conflict,
  Forbidden,
  Invalid,
  type Issue,
  IssueCode,
  NotFound,
  Unavailable,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Fn from "effect/Function";
import * as HttpClientError from "effect/http/HttpClientError";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { type Text, text } from "../text";

interface Offline {
  readonly _tag: "Offline";
}
interface Timeout {
  readonly _tag: "Timeout";
}
interface Cancelled {
  readonly _tag: "Cancelled";
}
/** 5xx, undeclared statuses and decode failures. `requestId` is the response's `X-Request-Id`. */
interface Unexpected {
  readonly _tag: "Unexpected";
  readonly status: number | null;
  readonly requestId: string | null;
}

/** Wire-visible errors, kept as the decoded contract instances. */
export type WireError =
  | NotFound
  | Forbidden
  | Invalid
  | Conflict
  | Unavailable
  | Unauthorized
  | PreconditionFailed
  | PreconditionRequired
  | RateLimited
  | PayloadTooLarge
  | InvalidBotProof
  | OriginRejected;

/** A Better Auth issue code (`auth.bot_proof_required`, ...): not in the domain IssueCode enum. */
export type AuthIssueCode = `auth.${string}`;

interface AuthIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly code: AuthIssueCode | IssueCode;
  readonly params?: Readonly<Record<string, string>>;
}

/**
 * An `Invalid` built outside the HttpApi decoder: the AuthClient port reports Better Auth issues
 * with this shape. A plain object, so it is told apart from the class by its codes, not by type.
 */
export interface AuthInvalid {
  readonly _tag: "Invalid";
  readonly issues: readonly [AuthIssue, ...Array<AuthIssue>];
}

export type UiError = WireError | AuthInvalid | Offline | Timeout | Cancelled | Unexpected;

const offline: Offline = { _tag: "Offline" };
const timeout: Timeout = { _tag: "Timeout" };
const cancelled: Cancelled = { _tag: "Cancelled" };
const unexpected = (status: number | null = null, requestId: string | null = null): Unexpected => ({
  _tag: "Unexpected",
  status,
  requestId,
});

const WIRE_ERRORS = [
  NotFound,
  Forbidden,
  Invalid,
  Conflict,
  Unavailable,
  Unauthorized,
  PreconditionFailed,
  PreconditionRequired,
  RateLimited,
  PayloadTooLarge,
  InvalidBotProof,
  OriginRejected,
] as const;

export const UiError = { offline, timeout, cancelled, unexpected } as const;

const isWireError = (u: unknown): u is WireError =>
  Arr.some(WIRE_ERRORS, (ErrorClass) => Schema.is(ErrorClass)(u));

const LOCAL_TAGS = new Set(["Offline", "Timeout", "Cancelled", "Unexpected"]);

/**
 * An `Invalid` built outside the HttpApi decoder: the AuthClient port reports Better Auth issues
 * (`auth.*`, e.g. `auth.bot_proof_required`) with this shape, and those codes are not in the domain
 * IssueCode enum, so they never decode into the `Invalid` class.
 */
const isIssueCode = Schema.is(IssueCode);

const isAuthIssue = (u: unknown): u is AuthIssue => {
  if (typeof u !== "object" || u === null) return false;
  const path = "path" in u ? u.path : undefined;
  const code = "code" in u ? u.code : undefined;
  const params = "params" in u ? u.params : undefined;
  return (
    Arr.isArray(path) &&
    Arr.every(path, (segment) => typeof segment === "string" || typeof segment === "number") &&
    typeof code === "string" &&
    (Fn.pipe(code, Str.startsWith("auth.")) || isIssueCode(code)) &&
    (params === undefined ||
      (typeof params === "object" &&
        params !== null &&
        !Arr.isArray(params) &&
        Arr.every(Rec.values(params), (value) => typeof value === "string")))
  );
};

const isPlainInvalid = (u: object): u is AuthInvalid =>
  "_tag" in u &&
  u._tag === "Invalid" &&
  "issues" in u &&
  Arr.isArray(u.issues) &&
  u.issues.length > 0 &&
  Arr.every(u.issues, isAuthIssue);

export const isUiError = (u: unknown): u is UiError =>
  isWireError(u) ||
  (typeof u === "object" &&
    u !== null &&
    (("_tag" in u && typeof u._tag === "string" && LOCAL_TAGS.has(u._tag)) || isPlainInvalid(u)));

/** The exchange a failure came from, when the failure value does not carry its response. */
export interface FailedResponse {
  readonly status: number;
  readonly requestId: string | null;
}

const failedResponses = new WeakMap<object, FailedResponse>();

/**
 * Associates a failure value (a response body's `SchemaError`) with the response that produced it,
 * while that response is in hand. The error itself stays in the channel unchanged, so typed
 * recovery (`Effect.catchTag("SchemaError", ...)`) still sees it; `toUiError` reads the
 * association. Keyed by the error object, so each failure keeps its own exchange.
 */
export const annotateFailedResponse: {
  (response: FailedResponse): (error: unknown) => void;
  (error: unknown, response: FailedResponse): void;
} = Fn.dual(2, (error: unknown, response: FailedResponse): void => {
  if (typeof error === "object" && error !== null && !failedResponses.has(error)) {
    failedResponses.set(error, { status: response.status, requestId: response.requestId });
  }
});

const failedResponseOf = (error: unknown): FailedResponse | undefined =>
  typeof error === "object" && error !== null ? failedResponses.get(error) : undefined;

const fromHttpClientError = (error: HttpClientError.HttpClientError): UiError => {
  const reason = error.reason;
  switch (reason._tag) {
    case "TransportError":
      return offline; // no response reached the client
    case "StatusCodeError":
    case "DecodeError":
    case "EmptyBodyError":
      return unexpected(reason.response.status, reason.response.headers["x-request-id"] ?? null);
    default:
      return unexpected(); // EncodeError, InvalidUrlError: a client-side defect
  }
};

/** The one mapping from a failure value (the `E` channel of a KvitbitApi call) to UiError. */
export const toUiError = (error: unknown): UiError => {
  if (isUiError(error)) return error;
  if (HttpClientError.isHttpClientError(error)) return fromHttpClientError(error);
  const failed = failedResponseOf(error);
  if (failed !== undefined) return unexpected(failed.status, failed.requestId);
  if (Cause.isTimeoutError(error)) return timeout;
  return unexpected();
};

/** Interruption only (the user navigated away, a newer query won) is `Cancelled`. */
export const fromCause = (cause: Cause.Cause<unknown>): UiError => {
  if (Cause.hasInterruptsOnly(cause)) return cancelled;
  const failure = Cause.findErrorOption(cause);
  return Option.isSome(failure) ? toUiError(failure.value) : unexpected();
};

export const fromExit = <A>(exit: Exit.Exit<A, unknown>): Option.Option<UiError> =>
  Exit.isFailure(exit) ? exit.cause.pipe(fromCause, Option.some) : Option.none();

// --- presentation -------------------------------------------------------------------------------

export type IssuePath = ReadonlyArray<string | number>;

export interface FieldIssue {
  readonly path: IssuePath;
  readonly text: Text;
}

/**
 * Where a screen shows the error by default (screens may refine, never contradict):
 * - fields: per-field issues plus a form-level summary
 * - inline: next to the control or list that failed
 * - banner: page-level banner (stale revision, lock, dependency down, generic)
 * - page: error page variant (detail route not found)
 * - session: emit SessionInvalid; Shell signs out and routes to sign-in
 * - silent: nothing to show (cancelled, stale cursor reloads by itself)
 */
type Surface = "fields" | "inline" | "banner" | "page" | "session" | "silent";

export interface UiErrorView {
  readonly error: UiError;
  readonly surface: Surface;
  readonly text: Text;
  readonly issues: ReadonlyArray<FieldIssue>;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
  readonly requestId: string | null;
  /** Conflict{revision_changed} and 412: keep the draft, offer Reload (one StaleRevision state). */
  readonly staleRevision: boolean;
  /** The intent's Idempotency-Key must be dropped before any retry. */
  readonly clearRequestKey: boolean;
  /** ALTCHA screens must fetch and solve a fresh challenge. */
  readonly freshBotProof: boolean;
  /** Countdown line under the banner (`error.unavailable.retryIn {seconds}`), when Retry-After is set. */
  readonly retryText: Text | null;
}

const issueText = (issue: Issue | AuthIssue): Text => text(`issue.${issue.code}`, issue.params);

const fieldIssues = (issues: ReadonlyArray<Issue | AuthIssue>): ReadonlyArray<FieldIssue> =>
  Arr.map(issues, (issue) => ({ path: issue.path, text: issueText(issue) }));

/** Better Auth issue code (via the AuthClient port, not the domain enum): solve ALTCHA first. */
const BOT_PROOF_CODES = new Set<string>(["auth.bot_proof_required"]);

/** True when the server says the list cursor no longer matches its filters. */
export const isCursorMismatch = (error: UiError): boolean =>
  error._tag === "Invalid" &&
  Arr.every<Issue | AuthIssue>(error.issues, (issue) => issue.code === "page.cursor_mismatch");

/**
 * Whether the screen offers Retry (a user action). `Conflict{idempotency_mismatch}` qualifies only
 * after the key is cleared (`clearRequestKey`); a malformed 2xx may have been applied, which is why
 * only the user, not `isAutoRetryable`, retries it.
 */
export const isRetryable = (error: UiError): boolean => {
  switch (error._tag) {
    case "Offline":
    case "Timeout":
    case "Unavailable":
    case "RateLimited":
      return true;
    case "Unexpected":
      return error.status === null || error.status < 400 || error.status >= 500;
    case "Conflict":
      return error.reason === "idempotency_mismatch"; // retry with a fresh key
    default:
      return false;
  }
};

/**
 * Whether the client may replay the same request on its own: only when no response arrived, the
 * server asked to come back later, or it failed with a 5xx. Never a pre-send defect (Unexpected
 * without status), a malformed 2xx/3xx (the write may have happened) or an idempotency mismatch.
 */
export const isAutoRetryable = (error: UiError): boolean => {
  switch (error._tag) {
    case "Offline":
    case "Timeout":
    case "Unavailable":
    case "RateLimited":
      return true;
    case "Unexpected":
      return error.status !== null && error.status >= 500;
    default:
      return false;
  }
};

export const retryAfterSeconds = (error: UiError): number | null => {
  if (error._tag === "RateLimited") return error.retryAfterSeconds;
  if (error._tag === "Unavailable") return error.retryAfterSeconds ?? null;
  return null;
};

const BYTES_PER_MEGABYTE = 1024 * 1024;

const view = (
  error: UiError,
  surface: Surface,
  message: Text,
  extra: Partial<Omit<UiErrorView, "error" | "surface" | "text">> = {},
): UiErrorView => ({
  error,
  surface,
  text: message,
  issues: [],
  retryable: isRetryable(error),
  retryAfterSeconds: retryAfterSeconds(error),
  requestId: null,
  staleRevision: false,
  clearRequestKey: false,
  freshBotProof: false,
  retryText: null,
  ...extra,
});

/** Generic error; with a request id for support when the server sent one (`error.unknownWithId`). */
const unknownText = (status: number | null, requestId: string | null): Text =>
  requestId !== null
    ? text("error.unknownWithId", { requestId })
    : text("error.unknown", status === null ? undefined : { status });

/** The default UI model of an error (the table in ui-port-contracts section 2.6). */
export const describeError = (error: UiError): UiErrorView => {
  switch (error._tag) {
    case "Unauthorized":
      // Step-up (passkey or password again) keeps the session; every other reason signs out.
      return view(
        error,
        error.reason === "reauthentication_required" ? "inline" : "session",
        text(`error.unauthorized.${error.reason}`),
      );
    case "Forbidden":
      return view(error, "inline", text("error.forbidden"));
    case "NotFound":
      return view(error, "page", text("error.notFound"));
    case "Invalid":
      return isCursorMismatch(error)
        ? view(error, "silent", text("error.invalid"))
        : view(error, "fields", text("error.invalid"), {
            issues: fieldIssues(error.issues),
            freshBotProof: Arr.some<Issue | AuthIssue>(error.issues, (issue) =>
              BOT_PROOF_CODES.has(issue.code),
            ),
          });
    case "PreconditionFailed":
      return view(error, "banner", text("error.conflict.revision_changed"), {
        staleRevision: true,
      });
    case "Conflict":
      switch (error.reason) {
        case "revision_changed":
          return view(error, "banner", text("error.conflict.revision_changed"), {
            staleRevision: true,
          });
        case "document_locked":
          return view(error, "banner", text("error.conflict.document_locked"));
        case "idempotency_mismatch":
          return view(error, "banner", unknownText(409, null), { clearRequestKey: true });
        default:
          return view(
            error,
            "inline",
            error.detail === undefined
              ? text(`error.conflict.${error.reason}`)
              : text(`issue.${error.detail}`),
          );
      }
    case "PreconditionRequired":
      // ui-port always sends If-Match: a client defect, shown as Unexpected.
      return view(error, "banner", unknownText(428, null));
    case "Unavailable":
      return view(error, "banner", text(`error.unavailable.${error.dependency}`), {
        retryText:
          error.retryAfterSeconds === undefined
            ? null
            : text("error.unavailable.retryIn", { seconds: error.retryAfterSeconds }),
      });
    case "RateLimited":
      return view(
        error,
        "inline",
        text("error.rateLimited", { seconds: error.retryAfterSeconds }),
        {
          freshBotProof: true,
        },
      );
    case "PayloadTooLarge": {
      // Two decimals so small limits (64 KiB theme files) do not read as 0 MB.
      const megabytes = Math.round((error.limitBytes / BYTES_PER_MEGABYTE) * 100) / 100;
      return view(error, "fields", text("error.payloadTooLarge", { megabytes }), {
        issues: [{ path: ["file"], text: text("issue.attachment.too_large", { megabytes }) }],
      });
    }
    case "InvalidBotProof":
      return view(error, "inline", text("error.invalidBotProof"), { freshBotProof: true });
    case "OriginRejected":
      return view(error, "banner", text("error.originRejected"));
    case "Offline":
      return view(error, "inline", text("error.offline"));
    case "Timeout":
      return view(error, "banner", text("error.timeout"));
    case "Cancelled":
      return view(error, "silent", text("error.cancelled"));
    case "Unexpected":
      return view(error, "banner", unknownText(error.status, error.requestId), {
        requestId: error.requestId,
      });
  }
};

/**
 * Splits issues between the form's fields and the form-level summary (section 2.7): an issue whose
 * path a field owns goes to that field, the rest to the summary.
 */
export const partitionIssues: {
  (
    ownsPath: (path: IssuePath) => boolean,
  ): (issues: ReadonlyArray<FieldIssue>) => {
    readonly fields: ReadonlyArray<FieldIssue>;
    readonly summary: ReadonlyArray<FieldIssue>;
  };
  (
    issues: ReadonlyArray<FieldIssue>,
    ownsPath: (path: IssuePath) => boolean,
  ): { readonly fields: ReadonlyArray<FieldIssue>; readonly summary: ReadonlyArray<FieldIssue> };
} = Fn.dual(
  2,
  (
    issues: ReadonlyArray<FieldIssue>,
    ownsPath: (path: IssuePath) => boolean,
  ): {
    readonly fields: ReadonlyArray<FieldIssue>;
    readonly summary: ReadonlyArray<FieldIssue>;
  } => {
    const fields: Array<FieldIssue> = [];
    const summary: Array<FieldIssue> = [];
    for (const issue of issues) (ownsPath(issue.path) ? fields : summary).push(issue);
    return { fields, summary };
  },
);

/** Issues exactly at `path` (for one field). */
export const issuesAt: {
  (path: IssuePath): (issues: ReadonlyArray<FieldIssue>) => ReadonlyArray<FieldIssue>;
  (issues: ReadonlyArray<FieldIssue>, path: IssuePath): ReadonlyArray<FieldIssue>;
} = Fn.dual(
  2,
  (issues: ReadonlyArray<FieldIssue>, path: IssuePath): ReadonlyArray<FieldIssue> =>
    Arr.filter(
      issues,
      (issue) =>
        issue.path.length === path.length && Arr.every(issue.path, (p, i) => p === path[i]),
    ),
);
