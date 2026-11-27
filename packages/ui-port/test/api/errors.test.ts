import { describe, expect, test } from "bun:test";
import {
  InvalidBotProof,
  OriginRejected,
  PayloadTooLarge,
  PreconditionRequired,
  Unauthorized,
} from "@kvitbit/api-contract";
import { Conflict, Forbidden, Invalid, NotFound, Unavailable } from "@kvitbit/domain/contract";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";

import {
  describeError,
  fromCause,
  isAutoRetryable,
  isRetryable,
  issuesAt,
  partitionIssues,
  toUiError,
  UiError,
} from "../../src/api";

describe("toUiError", () => {
  test("keeps decoded wire errors and local UiErrors as they are", () => {
    const notFound = NotFound.make({ entity: "Contact", id: "x" });
    notFound.pipe(toUiError, expect).toBe(notFound);
    expect(toUiError(UiError.offline)).toBe(UiError.offline);
  });

  test("transport errors are Offline, other client errors Unexpected", () => {
    const request = HttpClientRequest.get("https://x.test/");
    const transport = new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request }),
    });
    const encode = new HttpClientError.HttpClientError({
      reason: new HttpClientError.EncodeError({ request }),
    });
    const offline = toUiError(transport);
    expect(offline).toEqual({ _tag: "Offline" });
    encode.pipe(toUiError, expect).toEqual({ _tag: "Unexpected", status: null, requestId: null });
  });

  test("timeouts, schema errors and unknown values", () => {
    new Cause.TimeoutError().pipe(toUiError, expect).toEqual({ _tag: "Timeout" });
    const schemaError = Schema.decodeUnknownEffect(Schema.Finite)("x").pipe(
      Effect.flip,
      Effect.runSync,
    );
    expect(toUiError(schemaError)._tag).toBe("Unexpected");
    expect(toUiError(new Error("boom"))._tag).toBe("Unexpected");
  });

  test("fromCause: interrupt-only is Cancelled, defects are Unexpected", () => {
    Cause.interrupt().pipe(fromCause, expect).toEqual({ _tag: "Cancelled" });
    expect(fromCause(Cause.die("bug"))._tag).toBe("Unexpected");
    Cause.fail(UiError.timeout).pipe(fromCause, expect).toEqual({ _tag: "Timeout" });
  });
});

describe("describeError covers every UiError", () => {
  const cases: ReadonlyArray<
    [UiError, ReturnType<typeof describeError>["surface"], string, boolean]
  > = [
    [Forbidden.make({ action: "contact.read" }), "inline", "error.forbidden", false],
    [NotFound.make({ entity: "Contact", id: "x" }), "page", "error.notFound", false],
    [
      Conflict.make({ reason: "revision_changed" }),
      "banner",
      "error.conflict.revision_changed",
      false,
    ],
    [
      Conflict.make({ reason: "document_locked" }),
      "banner",
      "error.conflict.document_locked",
      false,
    ],
    [
      Conflict.make({ reason: "illegal_transition" }),
      "inline",
      "error.conflict.illegal_transition",
      false,
    ],
    [PreconditionRequired.make({}), "banner", "error.unknown", false],
    [
      Unavailable.make({ dependency: "exchange_rates" }),
      "banner",
      "error.unavailable.exchange_rates",
      true,
    ],
    [InvalidBotProof.make({}), "inline", "error.invalidBotProof", false],
    [OriginRejected.make({}), "banner", "error.originRejected", false],
    [Unauthorized.make({ reason: "missing" }), "session", "error.unauthorized.missing", false],
    [UiError.offline, "inline", "error.offline", true],
    [UiError.timeout, "banner", "error.timeout", true],
    [UiError.cancelled, "silent", "error.cancelled", false],
    [UiError.unexpected(null, null), "banner", "error.unknown", true],
    [UiError.unexpected(404, null), "banner", "error.unknown", false],
  ];
  for (const [error, surface, key, retryable] of cases) {
    test(`${error._tag} -> ${surface} ${key}`, () => {
      const view = describeError(error);
      expect(view.surface).toBe(surface);
      expect(view.text.key).toBe(key);
      expect(view.retryable).toBe(retryable);
      expect(isRetryable(error)).toBe(retryable);
    });
  }

  test("413 PayloadTooLarge -> attachment.too_large on the file row", () => {
    const view = describeError(PayloadTooLarge.make({ limitBytes: 20 * 1024 * 1024 }));
    expect(view.surface).toBe("fields");
    expect(view.issues).toEqual([
      { path: ["file"], text: { key: "issue.attachment.too_large", params: { megabytes: 20 } } },
    ]);
  });

  test("Unavailable carries the Retry-After countdown", () => {
    const view = describeError(
      Unavailable.make({ dependency: "company_registry", retryAfterSeconds: 5 }),
    );
    expect(view.text).toEqual({ key: "error.unavailable.company_registry" });
    expect(view.retryText).toEqual({ key: "error.unavailable.retryIn", params: { seconds: 5 } });
    expect(view.retryAfterSeconds).toBe(5);
  });

  test("Invalid: stale cursor is silent, bot proof requirement asks for a fresh proof", () => {
    const cursor = Invalid.make({ issues: [{ path: ["cursor"], code: "page.cursor_mismatch" }] });
    expect(describeError(cursor).surface).toBe("silent");
    // Better Auth issue codes reach ui-port through the AuthClient port, outside the domain enum.
    const bot = toUiError({
      _tag: "Invalid",
      issues: [{ path: [], code: "auth.bot_proof_required" }],
    });
    expect(describeError(bot).freshBotProof).toBe(true);
  });

  test("issue params pass through, and issues split between fields and summary", () => {
    const invalid = Invalid.make({
      issues: [
        { path: ["lines", 0, "price"], code: "qr.field_too_long", params: { max: "140" } },
        { path: [], code: "document.lines_required" },
      ],
    });
    const { issues } = describeError(invalid);
    expect(issues[0]?.text).toEqual({ key: "issue.qr.field_too_long", params: { max: "140" } });
    const split = partitionIssues(issues, (path) => path.length > 0);
    expect(split.fields).toHaveLength(1);
    expect(split.summary[0]?.text.key).toBe("issue.document.lines_required");
    expect(issuesAt(issues, ["lines", 0, "price"])).toHaveLength(1);
  });
});

describe("council follow-ups", () => {
  test("reauthentication_required asks for step-up inline, not sign-out", () => {
    const view = describeError(Unauthorized.make({ reason: "reauthentication_required" }));
    expect(view.surface).toBe("inline");
    expect(view.text.key).toBe("error.unauthorized.reauthentication_required");
  });

  test("small payload limits keep a readable megabyte figure", () => {
    const view = describeError(PayloadTooLarge.make({ limitBytes: 64 * 1024 }));
    expect(view.text).toEqual({ key: "error.payloadTooLarge", params: { megabytes: 0.06 } });
  });

  test("manual vs automatic retry", () => {
    const malformed2xx = UiError.unexpected(201, "r");
    const mismatch = Conflict.make({ reason: "idempotency_mismatch" });
    expect(isRetryable(malformed2xx)).toBe(true);
    expect(isAutoRetryable(malformed2xx)).toBe(false);
    mismatch.pipe(isRetryable, expect).toBe(true);
    expect(describeError(mismatch).clearRequestKey).toBe(true);
    mismatch.pipe(isAutoRetryable, expect).toBe(false);
    expect(isAutoRetryable(UiError.unexpected(null, null))).toBe(false);
    expect(isAutoRetryable(UiError.unexpected(502, null))).toBe(true);
    expect(isAutoRetryable(UiError.offline)).toBe(true);
  });
});

describe("review follow-ups", () => {
  test("an AuthClient Invalid with a Better Auth code survives toUiError", () => {
    const fromAuth = {
      _tag: "Invalid",
      issues: [{ path: [], code: "auth.bot_proof_required" }],
    } as const;
    const error = toUiError(fromAuth);
    expect(error).toBe(fromAuth);
    expect(describeError(error).freshBotProof).toBe(true);
    expect(toUiError({ _tag: "Invalid", issues: [] })._tag).toBe("Unexpected");
  });
});
