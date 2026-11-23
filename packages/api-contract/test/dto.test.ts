import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  AccountPreferences,
  AccountPreferencesPatch,
  ApiKeyCreate,
  ConsentDecision,
  EdgeError,
  EntityTag,
  entityTag,
  IdempotencyKey,
  InvalidBotProof,
  M3_COLOR_ROLES,
  OriginRejected,
  PayloadTooLarge,
  PreconditionFailed,
  PreconditionRequired,
  parseEntityTag,
  RateLimited,
  ResolvedScheme,
  ThemePresetId,
  ThemePresets,
  Unauthorized,
} from "../src/index";

const WS = "01936f3e-7b4c-7d2a-9f1e-3c5a7b9d1e2f";

describe("entity tags and retry keys", () => {
  test("revision <-> strong ETag", () => {
    expect(entityTag(7)).toBe('"7"');
    expect(parseEntityTag(entityTag(1234))).toBe(1234);
    expect(Schema.is(EntityTag)('"0"')).toBe(true);
    for (const bad of ['W/"1"', "*", '""', '"-1"', '"01"'])
      expect(Schema.is(EntityTag)(bad)).toBe(false);
  });

  test("Idempotency-Key is 8 to 128 URL-safe characters", () => {
    expect(Schema.is(IdempotencyKey)("01936f3e-7b4c-7d2a-9f1e-3c5a7b9d1e2f")).toBe(true);
    for (const bad of ["short", "x".repeat(129), "has space key", "slash/inside"]) {
      expect(Schema.is(IdempotencyKey)(bad)).toBe(false);
    }
  });
});

describe("edge errors", () => {
  const json = Schema.toCodecJson(EdgeError);
  const samples: ReadonlyArray<EdgeError> = [
    new Unauthorized({ reason: "reauthentication_required" }),
    new InvalidBotProof({}),
    new OriginRejected({}),
    new PreconditionFailed({ currentRevision: null }),
    new PayloadTooLarge({ limitBytes: 20 * 1024 * 1024 }),
    new PreconditionRequired({}),
    new RateLimited({ retryAfterSeconds: 30 }),
  ];

  test.each(samples.map((e) => [e._tag, e] as const))("%s round-trips through JSON", (_, e) => {
    const encoded = Schema.encodeSync(json)(e);
    expect(encoded).toMatchObject({ _tag: e._tag });
    const back = Schema.decodeUnknownSync(json)(encoded);
    expect(back).toBeInstanceOf(e.constructor);
    expect(back).toEqual(e);
  });

  test("rejects unknown Unauthorized reasons and fractional retry delays", () => {
    expect(() =>
      Schema.decodeUnknownSync(json)({ _tag: "Unauthorized", reason: "nope" }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(json)({ _tag: "RateLimited", retryAfterSeconds: 1.5 }),
    ).toThrow();
  });
});

describe("API key and consent payloads", () => {
  const decodeKey = Schema.decodeUnknownSync(ApiKeyCreate);

  test("ApiKeyCreate accepts presets and non-empty custom scopes", () => {
    expect(decodeKey({ name: "CI", access: "read" })).toEqual({ name: "CI", access: "read" });
    expect<unknown>(
      decodeKey({
        name: "Sync",
        access: "custom",
        scopes: ["expenses:write"],
        expiresOn: "2027-01-31",
      }),
    ).toEqual({
      name: "Sync",
      access: "custom",
      scopes: ["expenses:write"],
      expiresOn: "2027-01-31",
    });
  });

  test("ApiKeyCreate rejects empty names, empty custom scopes and bad expiry dates", () => {
    expect(() => decodeKey({ name: "", access: "read" })).toThrow();
    expect(() => decodeKey({ name: "x", access: "custom", scopes: [] })).toThrow();
    expect(() => decodeKey({ name: "x", access: "read", expiresOn: "2027-02-30" })).toThrow();
  });

  test("ConsentDecision is Approve with a Workspace and grant, or Deny", () => {
    const decode = Schema.decodeUnknownSync(ConsentDecision);
    expect(decode({ _tag: "Deny" })).toEqual({ _tag: "Deny" });
    expect(decode({ _tag: "Approve", workspace: WS, grant: { access: "read" } })).toEqual({
      _tag: "Approve",
      workspace: WS,
      grant: { access: "read" },
    } as never);
    expect(() =>
      decode({ _tag: "Approve", workspace: "not-a-uuid", grant: { access: "read" } }),
    ).toThrow();
    expect(() => decode({ _tag: "Approve", workspace: WS })).toThrow();
  });
});

describe("theme", () => {
  test("every preset id has a #RRGGBB seed", () => {
    for (const id of ThemePresetId.literals) {
      expect(ThemePresets[id].seed).toMatch(/^#[0-9A-F]{6}$/i);
    }
    expect(Object.keys(ThemePresets).sort()).toEqual([...ThemePresetId.literals].sort());
  });

  const extended = {
    color: "#112233",
    onColor: "#FFFFFF",
    colorContainer: "#AABBCC",
    onColorContainer: "#000000",
  };
  const scheme = {
    roles: Object.fromEntries(M3_COLOR_ROLES.map((role) => [role, "#123456"])),
    extended: { paid: extended, proforma: extended, overdue: extended, draft: extended },
  };

  test("a resolved scheme needs every M3 role and all four extended colours", () => {
    const decode = Schema.decodeUnknownSync(ResolvedScheme);
    expect(decode(scheme)).toEqual(scheme as never);
    const { primary: _primary, ...missing } = scheme.roles;
    expect(() => decode({ ...scheme, roles: missing })).toThrow();
    expect(() => decode({ ...scheme, roles: { ...scheme.roles, primary: "red" } })).toThrow();
    expect(() => decode({ ...scheme, extended: { paid: extended } })).toThrow();
  });

  test("account preferences decode with a null source and reject bad modes", () => {
    const prefs = {
      locale: null,
      theme: {
        mode: "system",
        style: "elegant",
        contrast: "standard",
        dynamicColor: true,
        source: null,
      },
      resolvedTheme: null,
      revision: 3,
    };
    expect(Schema.decodeUnknownSync(AccountPreferences)(prefs)).toEqual(prefs as never);
    expect(() =>
      Schema.decodeUnknownSync(AccountPreferences)({
        ...prefs,
        theme: { ...prefs.theme, mode: "dim" },
      }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(AccountPreferencesPatch)({
        theme: { ...prefs.theme, source: { _tag: "Seed", seed: "#0F5D42" } },
      }),
    ).toMatchObject({ theme: { source: { _tag: "Seed", seed: "#0F5D42" } } });
    expect(() =>
      Schema.decodeUnknownSync(AccountPreferencesPatch)({
        theme: { ...prefs.theme, source: { _tag: "Seed", seed: "#0F5D4" } },
      }),
    ).toThrow();
  });
});
