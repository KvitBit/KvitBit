import { describe, expect, test } from "bun:test";
import {
  InvalidBotProof,
  OriginRejected,
  PayloadTooLarge,
  PreconditionRequired,
  Unauthorized,
} from "@kvitbit/api-contract";
import { Conflict, Forbidden, Invalid, NotFound, Unavailable } from "@kvitbit/domain/contract";
import { Cause, Schema } from "effect";
import { HttpClientError, HttpClientRequest } from "effect/http";
import {
  describeError,
  fromCause,
  isRetryable,
  issuesAt,
  partitionIssues,
  toUiError,
  UiError,
} from "../../src/api";

describe("toUiError", () => {
  test("keeps decoded wire errors and local UiErrors as they are", () => {
    const notFound = new NotFound({ entity: "Contact", id: "x" });
    expect(toUiError(notFound)).toBe(notFound);
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
    expect(toUiError(transport)).toEqual({ _tag: "Offline" });
    expect(toUiError(encode)).toEqual({ _tag: "Unexpected", status: null, requestId: null });
  });

  test("timeouts, schema errors and unknown values", () => {
    expect(toUiError(new Cause.TimeoutError())).toEqual({ _tag: "Timeout" });
    const schemaError = (() => {
      try {
        Schema.decodeUnknownSync(Schema.Number)("x");
      } catch (e) {
        return e;
      }
    })();
    expect(toUiError(schemaError)._tag).toBe("Unexpected");
    expect(toUiError(new Error("boom"))._tag).toBe("Unexpected");
  });

  test("fromCause: interrupt-only is Cancelled, defects are Unexpected", () => {
    expect(fromCause(Cause.interrupt())).toEqual({ _tag: "Cancelled" });
    expect(fromCause(Cause.die("bug"))._tag).toBe("Unexpected");
    expect(fromCause(Cause.fail(UiError.timeout))).toEqual({ _tag: "Timeout" });
  });
});

describe("describeError covers every UiError", () => {
  const cases: ReadonlyArray<[UiError, string, string, boolean]> = [
    [new Forbidden({ action: "contact.read" }), "inline", "error.forbidden", false],
    [new NotFound({ entity: "Contact", id: "x" }), "page", "error.notFound", false],
    [
      new Conflict({ reason: "revision_changed" }),
      "banner",
      "error.conflict.revision_changed",
      false,
    ],
    [
      new Conflict({ reason: "document_locked" }),
      "banner",
      "error.conflict.document_locked",
      false,
    ],
    [
      new Conflict({ reason: "illegal_transition" }),
      "inline",
      "error.conflict.illegal_transition",
      false,
    ],
    [new PreconditionRequired({}), "banner", "error.unknown", false],
    [
      new Unavailable({ dependency: "exchange_rates" }),
      "banner",
      "error.unavailable.exchange_rates",
      true,
    ],
    [new InvalidBotProof({}), "inline", "error.invalidBotProof", false],
    [new OriginRejected({}), "banner", "error.originRejected", false],
    [new Unauthorized({ reason: "missing" }), "session", "error.unauthorized.missing", false],
    [UiError.offline, "inline", "error.offline", true],
    [UiError.timeout, "banner", "error.timeout", true],
    [UiError.cancelled, "silent", "error.cancelled", false],
    [UiError.unexpected(null, null), "banner", "error.unknown", true],
    [UiError.unexpected(404, null), "banner", "error.unknown", false],
  ];
  for (const [error, surface, key, retryable] of cases) {
    test(`${error._tag} -> ${surface} ${key}`, () => {
      const view = describeError(error);
      expect(view.surface).toBe(surface as never);
      expect(view.text.key).toBe(key);
      expect(view.retryable).toBe(retryable);
      expect(isRetryable(error)).toBe(retryable);
    });
  }

  test("413 PayloadTooLarge -> attachment.too_large on the file row", () => {
    const view = describeError(new PayloadTooLarge({ limitBytes: 20 * 1024 * 1024 }));
    expect(view.surface).toBe("fields");
    expect(view.issues).toEqual([
      { path: ["file"], text: { key: "issue.attachment.too_large", params: { megabytes: 20 } } },
    ]);
  });

  test("Unavailable carries the Retry-After countdown", () => {
    const view = describeError(
      new Unavailable({ dependency: "company_registry", retryAfterSeconds: 5 }),
    );
    expect(view.text).toEqual({ key: "error.unavailable.company_registry" });
    expect(view.retryText).toEqual({ key: "error.unavailable.retryIn", params: { seconds: 5 } });
    expect(view.retryAfterSeconds).toBe(5);
  });

  test("Invalid: stale cursor is silent, bot proof requirement asks for a fresh proof", () => {
    const cursor = new Invalid({ issues: [{ path: ["cursor"], code: "page.cursor_mismatch" }] });
    expect(describeError(cursor).surface).toBe("silent");
    // Better Auth issue codes reach ui-port through the AuthClient port, outside the domain enum.
    const bot = {
      _tag: "Invalid",
      issues: [{ path: [], code: "auth.bot_proof_required" }],
    } as never;
    expect(describeError(bot).freshBotProof).toBe(true);
  });

  test("issue params pass through, and issues split between fields and summary", () => {
    const invalid = new Invalid({
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
