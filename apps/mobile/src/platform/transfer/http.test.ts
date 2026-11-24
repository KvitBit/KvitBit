import { describe, expect, test } from "bun:test";
import { PayloadTooLarge, Unauthorized } from "@kvitbit/api-contract";
import { Invalid, NotFound } from "@kvitbit/domain/contract";
import { bearer, describeError, sessionCookie } from "@kvitbit/ui-port/api";
import { Redacted } from "effect";
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
    ).toBe("https://a.cz/api/v1/reports/vat/export?format=csv&from=2026-01-01");
  });

  test("authHeaders sends the bearer on Android and nothing with the cookie", () => {
    expect(authHeaders(bearer("tok"))).toEqual({ authorization: "Bearer tok" });
    expect(authHeaders(bearer(Redacted.make("sec")))).toEqual({ authorization: "Bearer sec" });
    expect(authHeaders(sessionCookie)).toEqual({});
  });

  test("errorFromResponse decodes declared error bodies", () => {
    const invalid = errorFromResponse(422, {
      _tag: "Invalid",
      issues: [{ path: ["file"], code: "attachment.type_rejected" }],
    });
    expect(invalid).toBeInstanceOf(Invalid);
    expect(errorFromResponse(401, { _tag: "Unauthorized", reason: "expired" })).toBeInstanceOf(
      Unauthorized,
    );
    expect(errorFromResponse(404, { _tag: "NotFound", entity: "Expense", id: "x" })).toBeInstanceOf(
      NotFound,
    );
    expect(errorFromResponse(413, { _tag: "PayloadTooLarge", limitBytes: 10 })).toBeInstanceOf(
      PayloadTooLarge,
    );
  });

  test("errorFromResponse falls back by status", () => {
    expect(errorFromResponse(0, null)._tag).toBe("Offline");
    expect(errorFromResponse(413, "too big")).toBeInstanceOf(PayloadTooLarge);
    expect(errorFromResponse(502, "<html>", "req-1")).toEqual({
      _tag: "Unexpected",
      status: 502,
      requestId: "req-1",
    });
    expect(describeError(errorFromResponse(500, null)).surface).toBe("banner");
  });

  test("parseJson and safeFileName", () => {
    expect(parseJson("")).toBeNull();
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseJson("nope")).toBe("nope");
    expect(safeFileName("VAT report 2026/Q1.csv")).toBe("VAT-report-2026-Q1.csv");
    expect(safeFileName("///")).toBe("file");
  });
});
