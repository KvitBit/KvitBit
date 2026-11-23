import { describe, expect, test } from "bun:test";
import { Exit, Schema } from "effect";
import { Action, SCOPE_AREAS, Scope, ScopeArea } from "../src/index";

describe("scopes", () => {
  test("there are exactly ten scope areas", () => {
    expect(SCOPE_AREAS).toHaveLength(10);
    expect(ScopeArea.literals).toEqual([
      "workspace",
      "members",
      "contacts",
      "catalog",
      "documents",
      "payments",
      "expenses",
      "templates",
      "reports",
      "share",
    ]);
  });
  test("core scopes are <area>:<level>", () => {
    for (const area of SCOPE_AREAS) {
      for (const level of ["read", "write"]) {
        expect(Schema.is(Scope)(`${area}:${level}`)).toBe(true);
      }
    }
  });
  test.each(["kvitbit:documents:read", "documents:admin", "invoices:read", "documents", ""])(
    "rejects %p",
    (s) => {
      expect(Exit.isFailure(Schema.decodeUnknownExit(Scope)(s))).toBe(true);
    },
  );
  test("Action is a closed union without duplicates", () => {
    expect(new Set(Action.literals).size).toBe(Action.literals.length);
    expect(Schema.is(Action)("member.manageAdmins")).toBe(true);
    expect(Schema.is(Action)("document.delete")).toBe(false);
  });
});
