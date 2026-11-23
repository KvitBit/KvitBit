import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  AccessRequest,
  ALL_SCOPES,
  accessFromOAuthScopes,
  expandAccess,
  GrantedAccess,
  normalizeScopes,
  OAUTH_SCOPES_SUPPORTED,
  OAuthScopeToken,
  oauthScopesForGrant,
  READ_SCOPES,
  SCOPE_AREAS,
  Scope,
  ScopeArea,
  ScopeFromOAuth,
  ScopeLevel,
} from "../src/index";

describe("scope wire codec (kvitbit:<area>:<level> <-> <area>:<level>)", () => {
  const decode = Schema.decodeUnknownSync(ScopeFromOAuth);
  const encode = Schema.encodeSync(ScopeFromOAuth);

  test("decodes the OAuth form to the core scope and encodes it back", () => {
    expect(decode("kvitbit:documents:write")).toBe("documents:write");
    expect(encode("catalog:read")).toBe("kvitbit:catalog:read");
    for (const scope of ALL_SCOPES) expect(decode(encode(scope))).toBe(scope);
  });

  test("rejects presets, unknown areas, unknown levels and the bare core form", () => {
    for (const bad of [
      "kvitbit:read",
      "kvitbit:billing:read",
      "kvitbit:documents:admin",
      "documents:read",
      "offline_access",
    ]) {
      expect(() => decode(bad)).toThrow();
    }
  });

  test("scopes_supported lists the two presets, all twenty area scopes and offline_access", () => {
    expect(OAUTH_SCOPES_SUPPORTED).toEqual([
      "kvitbit:read",
      "kvitbit:write",
      "kvitbit:workspace:read",
      "kvitbit:workspace:write",
      "kvitbit:members:read",
      "kvitbit:members:write",
      "kvitbit:contacts:read",
      "kvitbit:contacts:write",
      "kvitbit:catalog:read",
      "kvitbit:catalog:write",
      "kvitbit:documents:read",
      "kvitbit:documents:write",
      "kvitbit:payments:read",
      "kvitbit:payments:write",
      "kvitbit:expenses:read",
      "kvitbit:expenses:write",
      "kvitbit:templates:read",
      "kvitbit:templates:write",
      "kvitbit:reports:read",
      "kvitbit:reports:write",
      "kvitbit:share:read",
      "kvitbit:share:write",
      "offline_access",
    ]);
    for (const token of OAUTH_SCOPES_SUPPORTED) {
      expect(Schema.is(OAuthScopeToken)(token)).toBe(true);
    }
  });
});

describe("access requests", () => {
  const decode = Schema.decodeUnknownSync(AccessRequest);

  test("decodes presets and non-empty custom requests", () => {
    expect(decode({ access: "read" })).toEqual({ access: "read" });
    expect(decode({ access: "custom", scopes: ["documents:write"] })).toEqual({
      access: "custom",
      scopes: ["documents:write"],
    });
  });

  test("rejects empty custom, unknown scopes and unknown modes", () => {
    expect(() => decode({ access: "custom", scopes: [] })).toThrow();
    expect(() => decode({ access: "custom", scopes: ["documents:admin"] })).toThrow();
    expect(() => decode({ access: "admin" })).toThrow();
  });

  test("presets expand to ten reads or all twenty scopes", () => {
    expect(expandAccess({ access: "read" })).toEqual({ access: "read", scopes: READ_SCOPES });
    expect(READ_SCOPES).toHaveLength(10);
    expect(expandAccess({ access: "read_write" }).scopes).toHaveLength(20);
  });

  test("custom write adds read, de-duplicates and orders canonically", () => {
    expect(
      expandAccess({
        access: "custom",
        scopes: ["payments:write", "documents:read", "payments:write"],
      }),
    ).toEqual({
      access: "custom",
      scopes: ["documents:read", "payments:read", "payments:write"],
    });
    expect(normalizeScopes([])).toEqual([]);
  });
});

describe("OAuth scope parameter", () => {
  test("kvitbit:read is the read preset, kvitbit:write the read_write preset", () => {
    expect(accessFromOAuthScopes(["kvitbit:read"])?.access).toEqual({
      access: "read",
      scopes: READ_SCOPES,
    });
    expect(accessFromOAuthScopes(["kvitbit:write", "offline_access"])).toEqual({
      access: { access: "read_write", scopes: ALL_SCOPES },
      offlineAccess: true,
    });
  });

  test("per-area scopes are custom with write implying read", () => {
    expect(accessFromOAuthScopes(["kvitbit:documents:write", "kvitbit:contacts:read"])).toEqual({
      access: { access: "custom", scopes: ["contacts:read", "documents:read", "documents:write"] },
      offlineAccess: false,
    });
  });

  test("per-area scopes stay custom even when they equal a preset's expansion", () => {
    const reads = READ_SCOPES.map((s) => `kvitbit:${s}` as const);
    expect(accessFromOAuthScopes(reads)?.access).toEqual({ access: "custom", scopes: READ_SCOPES });
    const all = ALL_SCOPES.map((s) => `kvitbit:${s}` as const);
    expect(accessFromOAuthScopes(all)?.access).toEqual({ access: "custom", scopes: ALL_SCOPES });
  });

  test("kvitbit:read plus per-area scopes is custom on top of the ten reads", () => {
    expect(accessFromOAuthScopes(["kvitbit:read", "kvitbit:documents:write"])?.access).toEqual({
      access: "custom",
      scopes: normalizeScopes([...READ_SCOPES, "documents:write"]),
    });
  });

  test("kvitbit:write wins over per-area scopes", () => {
    expect(accessFromOAuthScopes(["kvitbit:contacts:read", "kvitbit:write"])?.access).toEqual({
      access: "read_write",
      scopes: ALL_SCOPES,
    });
  });

  test("no Kvitbit scope is undefined", () => {
    expect(accessFromOAuthScopes(["offline_access"])).toBeUndefined();
    expect(accessFromOAuthScopes([])).toBeUndefined();
  });

  test("token response scope lists the preset or the per-area scopes", () => {
    expect(oauthScopesForGrant({ access: "read", scopes: READ_SCOPES })).toEqual(["kvitbit:read"]);
    expect(oauthScopesForGrant({ access: "read_write", scopes: ALL_SCOPES })).toEqual([
      "kvitbit:write",
    ]);
    expect(
      oauthScopesForGrant({ access: "custom", scopes: ["reports:read", "documents:read"] }),
    ).toEqual(["kvitbit:documents:read", "kvitbit:reports:read"]);
  });
});

describe("GrantedAccess consistency", () => {
  const is = Schema.is(GrantedAccess);

  test("accepts what expandAccess produces", () => {
    expect(is(expandAccess({ access: "read" }))).toBe(true);
    expect(is(expandAccess({ access: "read_write" }))).toBe(true);
    expect(is(expandAccess({ access: "custom", scopes: ["payments:write"] }))).toBe(true);
  });

  test("read must carry exactly the ten reads", () => {
    expect(is({ access: "read", scopes: READ_SCOPES.slice(1) })).toBe(false);
    expect(is({ access: "read", scopes: ALL_SCOPES })).toBe(false);
  });

  test("read_write must carry all twenty", () => {
    expect(is({ access: "read_write", scopes: READ_SCOPES })).toBe(false);
  });

  test("custom must be non-empty and normalized", () => {
    expect(is({ access: "custom", scopes: [] })).toBe(false);
    expect(is({ access: "custom", scopes: ["payments:write"] })).toBe(false);
    expect(is({ access: "custom", scopes: ["payments:read", "documents:read"] })).toBe(false);
    expect(is({ access: "custom", scopes: ["documents:read", "documents:read"] })).toBe(false);
  });
});

describe("domain scope re-exports", () => {
  test("are the core schemas", () => {
    expect(SCOPE_AREAS).toHaveLength(10);
    expect(Schema.is(Scope)("documents:read")).toBe(true);
    expect(Schema.is(ScopeArea)("documents")).toBe(true);
    expect(Schema.is(ScopeLevel)("write")).toBe(true);
  });
});
