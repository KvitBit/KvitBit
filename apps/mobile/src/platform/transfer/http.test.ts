import { describe, expect, test } from "bun:test";
import { PayloadTooLarge, Unauthorized } from "@kvitbit/api-contract";
import { Invalid, NotFound } from "@kvitbit/domain/contract";
import { bearer, describeError, sessionCookie } from "@kvitbit/ui-port/api";
import * as Redacted from "effect/Redacted";
import { apiUrl, authHeaders, errorFromResponse, parseJson, safeFileName } from "./http";

describe("transfer http helpers", () => {
  test("apiUrl joins origin, /api/v1 and path and drops undefined query values", () => {
    expect(apiUrl("https://app.kvitbit.cz/", "/workspaces/w/expenses")).toBe(
      "https://app.kvitbit.cz/api/v1/workspaces/w/expenses",
    );
    expect(
      apiUrl("https://a.cz", "reports/vat/export", {
        format: "csv",
        groupBy: undefined,
        from: "2026-01-01",
      }),
    ).toBe(
      // biome-ignore lint/security/noSecrets: URL for the test-only placeholder domain.
      "https://a.cz/api/v1/reports/vat/export?format=csv&from=2026-01-01",
    );
  });

  test("authHeaders sends the bearer on Android and nothing with the cookie", () => {
    expect(authHeaders(bearer("tok"))).toEqual({ authorization: "Bearer tok" });
    Redacted.make("sec").pipe(bearer, authHeaders, expect).toEqual({ authorization: "Bearer sec" });
    expect(authHeaders(sessionCookie)).toEqual({});
  });

  test("errorFromResponse decodes declared error bodies", () => {
    const invalid = errorFromResponse({
      status: 422,
      body: {
        _tag: "Invalid",
        issues: [{ path: ["file"], code: "attachment.type_rejected" }],
      },
    });
    expect(invalid).toBeInstanceOf(Invalid);
    expect(
      errorFromResponse({ status: 401, body: { _tag: "Unauthorized", reason: "expired" } }),
    ).toBeInstanceOf(Unauthorized);
    expect(
      errorFromResponse({ status: 404, body: { _tag: "NotFound", entity: "Expense", id: "x" } }),
    ).toBeInstanceOf(NotFound);
    expect(
      errorFromResponse({ status: 413, body: { _tag: "PayloadTooLarge", limitBytes: 10 } }),
    ).toBeInstanceOf(PayloadTooLarge);
  });

  test("errorFromResponse falls back by status", () => {
    expect(errorFromResponse({ status: 0, body: null })._tag).toBe("Offline");
    expect(errorFromResponse({ status: 413, body: "too big" })).toBeInstanceOf(PayloadTooLarge);
    expect(errorFromResponse({ status: 502, body: "<html>", requestId: "req-1" })).toEqual({
      _tag: "Unexpected",
      status: 502,
      requestId: "req-1",
    });
    expect(describeError(errorFromResponse({ status: 500, body: null })).surface).toBe("banner");
  });

  test("parseJson and safeFileName", () => {
    expect(parseJson("")).toBeNull();
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseJson("nope")).toBe("nope");
    expect(safeFileName("VAT report 2026/Q1.csv")).toBe("VAT-report-2026-Q1.csv");
    expect(safeFileName("///")).toBe("file");
  });
});
