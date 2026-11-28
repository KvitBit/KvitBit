import { describe, expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Order from "effect/Order";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  AccountPreferences,
  AccountPreferencesPatch,
  ApiKeyCreate,
  ApiKeyCreated,
  ConnectedAppView,
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
  READ_SCOPES,
  ResolvedScheme,
  ThemePresetId,
  ThemePresets,
  Unauthorized,
} from "../src/index";

const WS = "01936f3e-7b4c-7d2a-9f1e-3c5a7b9d1e2f";
const HEX_COLOR = /^#[0-9A-F]{6}$/i;

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
    for (const bad of ["short", Str.repeat(129)("x"), "has space key", "slash/inside"]) {
      expect(Schema.is(IdempotencyKey)(bad)).toBe(false);
    }
  });
});

describe("edge errors", () => {
  const json = Schema.toCodecJson(EdgeError);
  const samples: ReadonlyArray<EdgeError> = [
    Unauthorized.make({ reason: "reauthentication_required" }),
    InvalidBotProof.make({}),
    OriginRejected.make({}),
    PreconditionFailed.make({ currentRevision: null }),
    PayloadTooLarge.make({ limitBytes: 20 * 1024 * 1024 }),
    PreconditionRequired.make({}),
    RateLimited.make({ retryAfterSeconds: 30 }),
  ];

  test.each(Arr.map(samples, (e) => [e._tag, e] as const))(
    "%s round-trips through JSON",
    (_, e) => {
      const encoded = Schema.encodeEffect(json)(e).pipe(Effect.runSync);
      expect(encoded).toMatchObject({ _tag: e._tag });
      const back = Schema.decodeEffect(json)(encoded).pipe(Effect.runSync);
      expect(back).toBeInstanceOf(e.constructor);
      expect(back).toEqual(e);
    },
  );

  test("rejects unknown Unauthorized reasons and fractional retry delays", () => {
    expect(() =>
      Schema.decodeEffect(json)({ _tag: "Unauthorized", reason: "nope" }).pipe(Effect.runSync),
    ).toThrow();
    expect(() =>
      Schema.decodeEffect(json)({ _tag: "RateLimited", retryAfterSeconds: 1.5 }).pipe(
        Effect.runSync,
      ),
    ).toThrow();
  });
});

describe("API key and consent payloads", () => {
  const decodeKey = Fn.flow(Schema.decodeUnknownEffect(ApiKeyCreate), Effect.runSync);

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
    const decode = Fn.flow(Schema.decodeUnknownEffect(ConsentDecision), Effect.runSync);
    expect(decode({ _tag: "Deny" })).toEqual({ _tag: "Deny" });
    expect<unknown>(decode({ _tag: "Approve", workspace: WS, grant: { access: "read" } })).toEqual({
      _tag: "Approve",
      workspace: WS,
      grant: { access: "read" },
    });
    expect(() =>
      decode({ _tag: "Approve", workspace: "not-a-uuid", grant: { access: "read" } }),
    ).toThrow();
    expect(() => decode({ _tag: "Approve", workspace: WS })).toThrow();
  });
});

describe("theme", () => {
  test("every preset id has a #RRGGBB seed", () => {
    for (const id of ThemePresetId.literals) {
      expect(ThemePresets[id].seed).toMatch(HEX_COLOR);
    }
    expect(Arr.sort(Record.keys(ThemePresets), Order.String)).toEqual(
      Arr.sort(ThemePresetId.literals, Order.String),
    );
  });

  test("seeds match ui-port's tuned presets (packages/ui-port/src/theme/presets.ts)", () => {
    expect(
      Record.fromEntries(Arr.map(Record.toEntries(ThemePresets), ([id, p]) => [id, p.seed])),
    ).toEqual({
      graphite_atelier: "#111111",
      forest: "#0F5D42",
      ocean: "#0E6B8C",
      plum: "#6B2D5C",
      sand: "#1D4ED8",
      graphite: "#4B5563",
    });
  });

  const extended = {
    color: "#112233",
    onColor: "#FFFFFF",
    colorContainer: "#AABBCC",
    onColorContainer: "#000000",
  };
  const scheme = {
    roles: Record.fromEntries(Arr.map(M3_COLOR_ROLES, (role) => [role, "#123456"])),
    extended: { paid: extended, proforma: extended, overdue: extended, draft: extended },
  };

  test("a resolved scheme needs every M3 role and all four extended colours", () => {
    const decode = Fn.flow(Schema.decodeUnknownEffect(ResolvedScheme), Effect.runSync);
    expect<unknown>(decode(scheme)).toEqual(scheme);
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
    expect<unknown>(
      Schema.decodeUnknownEffect(AccountPreferences)(prefs).pipe(Effect.runSync),
    ).toEqual(prefs);
    expect(() =>
      Schema.decodeUnknownEffect(AccountPreferences)({
        ...prefs,
        theme: { ...prefs.theme, mode: "dim" },
      }).pipe(Effect.runSync),
    ).toThrow();
    expect(
      Schema.decodeUnknownEffect(AccountPreferencesPatch)({
        theme: { ...prefs.theme, source: { _tag: "Seed", seed: "#0F5D42" } },
      }).pipe(Effect.runSync),
    ).toMatchObject({ theme: { source: { _tag: "Seed", seed: "#0F5D42" } } });
    expect(() =>
      Schema.decodeUnknownEffect(AccountPreferencesPatch)({
        theme: { ...prefs.theme, source: { _tag: "Seed", seed: "#0F5D4" } },
      }).pipe(Effect.runSync),
    ).toThrow();
  });
});

describe("stored grants on views", () => {
  const key = {
    id: "01JDX3K7M9",
    name: "CI",
    prefix: "kvb_01JDX3K7M9",
    access: "read",
    scopes: READ_SCOPES,
    createdBy: { userId: "01936f3e-7b4c-7d2a-9f1e-3c5a7b9d1e2f", name: "Ada" },
    createdAt: "2026-01-01T00:00:00Z",
    lastUsedAt: null,
    expiresAt: null,
  };
  const secret = `kvb_01JDX3K7M9_${Str.repeat(43)("a")}`;
  const decodeCreated = Fn.flow(Schema.decodeUnknownEffect(ApiKeyCreated), Effect.runSync);

  test("ApiKeyCreated carries a kvb_ token as its secret", () => {
    expect(String(decodeCreated({ key, secret }).secret)).toBe(secret);
    expect(() => decodeCreated({ key, secret: "plain" })).toThrow();
  });

  test("views reject a mode that disagrees with its scopes", () => {
    expect(() => decodeCreated({ key: { ...key, access: "read_write" }, secret })).toThrow();
    const app = {
      grantId: "g1",
      client: { id: "c1", name: "App", redirectHost: "app.example" },
      member: key.createdBy,
      access: "custom",
      scopes: [],
      createdAt: key.createdAt,
      lastUsedAt: null,
    };
    expect(Schema.is(ConnectedAppView)(app)).toBe(false);
    expect(Schema.is(ConnectedAppView)({ ...app, scopes: ["documents:read"] })).toBe(true);
  });
});
