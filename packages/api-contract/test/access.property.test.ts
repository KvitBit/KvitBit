/**
 * Exhaustive checks of the scope helpers in src/access.ts over every subset of the twenty core
 * scopes, against a bitmask oracle written from http-mcp-contracts sections 2.2 and 6.3: write
 * adds read, one canonical order, no unknown scopes, and a lossless OAuth wire round trip.
 * Every domain is enumerated in full and its size is asserted. Guarded by
 * .agents/skills/verify-money-access.
 */
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { OAuthScopeToken } from "../src/index";
import {
  ALL_SCOPES,
  accessFromOAuthScopes,
  expandAccess,
  GrantedAccess,
  normalizeScopes,
  OAUTH_SCOPES_SUPPORTED,
  oauthScopesForGrant,
  READ_SCOPES,
  Scope,
  ScopeFromOAuth,
} from "../src/index";

// The ten areas in the order of http-mcp-contracts.md:95, written out here; per area read is
// bit 2i and write bit 2i + 1, so ascending bit order is the canonical order (read before write).
const AREAS = [
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
] as const;
const ORACLE_SCOPES: ReadonlyArray<Scope> = AREAS.flatMap((area) => [
  `${area}:read` as const,
  `${area}:write` as const,
]);
const SUBSETS = 2 ** ORACLE_SCOPES.length;
const READ_BITS = 0b01010101010101010101;
const WRITE_BITS = READ_BITS << 1;
const INDEX = new Map(ORACLE_SCOPES.map((scope, i) => [scope, i]));

/** Write adds read (http-mcp-contracts.md:89, :1277). */
const closure = (mask: number): number => mask | ((mask & WRITE_BITS) >>> 1);
const listOf = (mask: number): Array<Scope> => ORACLE_SCOPES.filter((_, i) => (mask >>> i) & 1);
/** The mask of a list, or -1 when it has an unknown scope, a duplicate, or is out of order. */
const canonicalMask = (list: ReadonlyArray<string>): number => {
  let mask = 0;
  let last = -1;
  for (const scope of list) {
    const i = INDEX.get(scope as Scope);
    if (i === undefined || i <= last) return -1;
    last = i;
    mask |= 1 << i;
  }
  return mask;
};

/** Every closed set (each area none, read, or read and write): every storable custom grant. */
const CLOSED: ReadonlyArray<number> = Array.from({ length: 3 ** 10 }, (_, g) => {
  let mask = 0;
  let rest = g;
  for (let area = 0; area < 10; area++) {
    const digit = rest % 3;
    rest = (rest - digit) / 3;
    if (digit >= 1) mask |= 1 << (2 * area);
    if (digit === 2) mask |= 1 << (2 * area + 1);
  }
  return mask;
});
/** Every raw subset (write-only included) of the first five areas, and of the last five. */
const HALVES: ReadonlyArray<number> = [
  ...Array.from({ length: 2 ** 10 }, (_, m) => m),
  ...Array.from({ length: 2 ** 10 - 1 }, (_, m) => (m + 1) << 10),
];

const isGranted = Schema.is(GrantedAccess);
const isScope = Schema.is(Scope);
const decodeWire = Schema.decodeUnknownSync(ScopeFromOAuth);
const encodeWire = Schema.encodeSync(ScopeFromOAuth);

describe("scope set: every subset of the twenty scopes", () => {
  test("the domain has the expected size and the code's scope list is the spec's", () => {
    expect(ORACLE_SCOPES.length).toBe(20);
    expect(SUBSETS).toBe(1_048_576);
    expect(ALL_SCOPES).toEqual(ORACLE_SCOPES);
    expect(READ_SCOPES).toEqual(listOf(READ_BITS));
  });

  test("normalizeScopes: write adds read, canonical order, no unknown scope, idempotent", () => {
    // Idempotence needs no second call: closure(mask) is itself a subset in this loop, and the
    // loop checks normalize(listOf(closure)) = listOf(closure).
    let checked = 0;
    const wrong: Array<string> = [];
    for (let mask = 0; mask < SUBSETS; mask++) {
      checked++;
      if (canonicalMask(normalizeScopes(listOf(mask))) !== closure(mask)) {
        wrong.push(listOf(mask).join(","));
        if (wrong.length >= 5) break;
      }
    }
    expect(wrong).toEqual([]);
    expect(checked).toBe(SUBSETS);
  }, 30_000);

  test("normalizeScopes ignores input order and duplicates", () => {
    let checked = 0;
    const wrong: Array<string> = [];
    for (const mask of HALVES) {
      checked++;
      const list = listOf(mask);
      const out = normalizeScopes(list).join();
      if (normalizeScopes([...list].reverse().concat(list)).join() !== out)
        wrong.push(list.join(","));
      if (normalizeScopes(new Set(list)).join() !== out) wrong.push(`set ${list.join(",")}`);
    }
    expect(wrong).toEqual([]);
    expect(checked).toBe(2 * 2 ** 10 - 1);
  });

  test("expandAccess and GrantedAccess: custom stores the closure; only normalized lists are consistent", () => {
    let checked = 0;
    const wrong: Array<string> = [];
    for (const mask of [...CLOSED, ...HALVES]) {
      if (mask === 0) continue;
      checked++;
      const list = listOf(mask);
      const granted = expandAccess({ access: "custom", scopes: list as [Scope, ...Array<Scope>] });
      if (granted.access !== "custom" || canonicalMask(granted.scopes) !== closure(mask)) {
        wrong.push(`expand ${list.join(",")}`);
      }
      // A stored custom list is consistent exactly when it is already closed under write ⇒ read.
      if (isGranted({ access: "custom", scopes: list }) !== (closure(mask) === mask)) {
        wrong.push(`consistent ${list.join(",")}`);
      }
      if (wrong.length >= 5) break;
    }
    expect(wrong).toEqual([]);
    expect(checked).toBe(3 ** 10 - 1 + 2 * 2 ** 10 - 2);
    expect(isGranted({ access: "custom", scopes: [] })).toBe(false);
    expect(expandAccess({ access: "read" })).toEqual({ access: "read", scopes: listOf(READ_BITS) });
    expect(expandAccess({ access: "read_write" })).toEqual({
      access: "read_write",
      scopes: ORACLE_SCOPES,
    });
  }, 30_000);
});

describe("OAuth wire form (http-mcp-contracts 6.3)", () => {
  test("every core scope encodes to kvitbit:<scope> and decodes back; nothing else is a scope", () => {
    for (const scope of ORACLE_SCOPES) {
      expect(encodeWire(scope)).toBe(`kvitbit:${scope}`);
      expect(decodeWire(`kvitbit:${scope}`)).toBe(scope);
    }
    for (const area of [...AREAS, "invoices", ""]) {
      for (const level of ["read", "write", "admin", ""]) {
        const known =
          (AREAS as ReadonlyArray<string>).includes(area) && /^(read|write)$/.test(level);
        expect(isScope(`${area}:${level}`)).toBe(known);
      }
    }
    expect<ReadonlyArray<string>>(OAUTH_SCOPES_SUPPORTED).toEqual([
      "kvitbit:read",
      "kvitbit:write",
      ...ORACLE_SCOPES.map((s) => `kvitbit:${s}`),
      "offline_access",
    ]);
  });

  test("every half-subset × presets × offline_access parses per 6.3; every custom grant round-trips", () => {
    let checked = 0;
    const wrong: Array<string> = [];
    for (const mask of HALVES) {
      const area = listOf(mask).map((s) => `kvitbit:${s}` as OAuthScopeToken);
      for (let c = 0; c < 8; c++) {
        checked++;
        const wantsRead = (c & 1) !== 0;
        const wantsWrite = (c & 2) !== 0;
        const offline = (c & 4) !== 0;
        const tokens: Array<OAuthScopeToken> = [
          ...(wantsWrite ? (["kvitbit:write"] as const) : []),
          ...area,
          ...(wantsRead ? (["kvitbit:read"] as const) : []),
          ...(offline ? (["offline_access"] as const) : []),
        ];
        const got = accessFromOAuthScopes(tokens);
        // 6.3: write wins; any per-area scope is custom (on top of the reads with kvitbit:read);
        // kvitbit:read alone is read; no Kvitbit scope is no request.
        const expected = wantsWrite
          ? { access: "read_write", mask: (1 << 20) - 1 }
          : mask !== 0
            ? { access: "custom", mask: closure(wantsRead ? mask | READ_BITS : mask) }
            : wantsRead
              ? { access: "read", mask: READ_BITS }
              : undefined;
        if (expected === undefined) {
          if (got !== undefined) wrong.push(`undefined expected for ${tokens.join(" ")}`);
        } else if (
          got === undefined ||
          got.offlineAccess !== offline ||
          got.access.access !== expected.access ||
          canonicalMask(got.access.scopes) !== expected.mask ||
          !isGranted(got.access)
        ) {
          wrong.push(`parse ${tokens.join(" ")}`);
        }
      }
      if (wrong.length >= 5) break;
    }
    // Round trip: every storable custom grant's token-response scopes parse back to it.
    for (const mask of CLOSED) {
      if (mask === 0) continue;
      checked++;
      const grant = { access: "custom" as const, scopes: listOf(mask) };
      const wire = oauthScopesForGrant(grant);
      if (wire.join() !== grant.scopes.map((s) => `kvitbit:${s}`).join()) {
        wrong.push(`token scopes ${grant.scopes.join(",")}`);
      }
      const back = accessFromOAuthScopes(wire);
      if (back?.access.access !== "custom" || back.access.scopes.join() !== grant.scopes.join()) {
        wrong.push(`round trip ${grant.scopes.join(",")}`);
        if (wrong.length >= 5) break;
      }
    }
    expect(wrong).toEqual([]);
    expect(checked).toBe(8 * (2 * 2 ** 10 - 1) + 3 ** 10 - 1);
    expect(oauthScopesForGrant({ access: "read", scopes: listOf(READ_BITS) })).toEqual([
      "kvitbit:read",
    ]);
    expect(oauthScopesForGrant({ access: "read_write", scopes: ORACLE_SCOPES })).toEqual([
      "kvitbit:write",
    ]);
  }, 60_000);
});
