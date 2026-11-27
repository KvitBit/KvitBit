import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  M3_COLOR_ROLES,
  ResolvedScheme,
  ResolvedTheme,
  THEME_JSON_MAX_BYTES,
} from "@kvitbit/api-contract";
import { Invalid, WorkspaceId, WorkspaceSummary } from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Order from "effect/Order";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { as, type Harness, json, makeHarness, type TestUser } from "../harness";

let h: Harness;
let owner: TestUser;

const decodeCreatedWorkspace = Fn.flow(
  Schema.decodeUnknownEffect(
    Schema.Struct({ id: WorkspaceId, name: Schema.String, revision: Schema.Int }),
  ),
  Effect.runSync,
);
const decodeWorkspaceList = Fn.flow(
  Schema.decodeUnknownEffect(Schema.Array(WorkspaceSummary)),
  Effect.runSync,
);
const decodeInvalid = Fn.flow(
  Schema.decodeUnknownEffect(Schema.toEncoded(Invalid)),
  Effect.runSync,
);

const COLOR_HEX = /^#[0-9A-F]{6}$/;
const WireScheme = Schema.Struct({
  ...ResolvedScheme.fields,
  roles: Schema.Record(Schema.String, Schema.String),
});
const decodeTheme = Fn.flow(
  Schema.decodeUnknownEffect(
    Schema.toEncoded(
      Schema.Struct({
        ...ResolvedTheme.fields,
        source: Schema.JsonObject,
        schemes: Schema.StructWithRest(
          Schema.Struct({ light: WireScheme, dark: WireScheme, lightHigh: WireScheme }),
          [Schema.JsonObject],
        ),
      }),
    ),
  ),
  Effect.runSync,
);

const SAMPLE_COMPANY = {
  ico: "25596641",
  name: "Kvitbit Test s.r.o.",
  address: {
    street: "Václavské náměstí 1",
    city: "Praha",
    postalCode: "11000",
    country: "CZ",
  },
  dic: "CZ25596641",
  legalForm: "112",
  registerEntry: "C 12345 vedená u Městského soudu v Praze",
  terminatedOn: null,
};

beforeEach(() => {
  h = makeHarness({
    registry: { "25596641": SAMPLE_COMPANY },
  });
  owner = h.addUser("Olga");
});

afterEach(async () => {
  await h.dispose();
});

describe("myWorkspaces group", () => {
  test(
    "create answers 201 with Location and ETag, replays with Idempotency-Key, and listMine returns it",
    async () => {
      const createRes = await h.fetch("/api/v1/workspaces", {
        ...json({ name: "Nová firma s.r.o." }),
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...as.mobile(owner),
          "idempotency-key": "ws-create-0001",
        },
      });
      expect(createRes.status).toBe(201);
      const workspaceWire = await createRes.json();
      const view = decodeCreatedWorkspace(workspaceWire);
      expect(view.name).toBe("Nová firma s.r.o.");
      expect(createRes.headers.get("location")).toBe(`/api/v1/workspaces/${view.id}`);
      expect(createRes.headers.get("etag")).toBe(`"${view.revision}"`);
      expect(createRes.headers.get("idempotent-replayed")).toBeNull();

      // Replay returns same workspace with Idempotent-Replayed: true
      const replay = await h.fetch("/api/v1/workspaces", {
        ...json({ name: "Nová firma s.r.o." }),
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...as.mobile(owner),
          "idempotency-key": "ws-create-0001",
        },
      });
      expect(replay.status).toBe(201);
      expect(replay.headers.get("idempotent-replayed")).toBe("true");
      expect(await replay.json()).toEqual(workspaceWire);

      // listMine includes the created workspace
      const listRes = await h.fetch("/api/v1/workspaces", { headers: as.mobile(owner) });
      expect(listRes.status).toBe(200);
      const list = decodeWorkspaceList(await listRes.json());
      expect(list).toHaveLength(1);
      expect(list[0]?.id).toBe(view.id);
      expect(list[0]?.role).toBe("owner");

      // SessionOnly (rule A4): API key is rejected with 401 credential_not_allowed
      const keyRes = await h.fetch("/api/v1/workspaces", {
        headers: as.apiKey(owner, view.id, ["workspace:read"]),
      });
      expect(keyRes.status).toBe(401);
      expect(await keyRes.json()).toEqual({
        _tag: "Unauthorized",
        reason: "credential_not_allowed",
      });
    },
    { timeout: 15_000 },
  );
});

describe("registry group", () => {
  test("lookupCompany works for sessions and API keys; rejects bad checksum (422) and unknown ICO (404)", async () => {
    const okSession = await h.fetch("/api/v1/registry/companies/25596641", {
      headers: as.mobile(owner),
    });
    expect(okSession.status).toBe(200);
    expect(await okSession.json()).toEqual(SAMPLE_COMPANY);

    // Pure lookup accepts API key too
    const ws = await h.createWorkspace(owner);
    const okKey = await h.fetch("/api/v1/registry/companies/25596641", {
      headers: as.apiKey(owner, ws.workspaceId, ["contacts:read"]),
    });
    expect(okKey.status).toBe(200);
    expect(await okKey.json()).toEqual(SAMPLE_COMPANY);

    // Invalid IČO checksum -> 422
    const bad = await h.fetch("/api/v1/registry/companies/12345678", {
      headers: as.mobile(owner),
    });
    expect(bad.status).toBe(422);

    // Valid IČO checksum (27074358) not in registry -> 404
    const notFound = await h.fetch("/api/v1/registry/companies/27074358", {
      headers: as.mobile(owner),
    });
    expect(notFound.status).toBe(404);
  });
});

describe("themes group", () => {
  const resolve = (body: Schema.Json, headers: Record<string, string> = as.mobile(owner)) =>
    h.fetch("/api/v1/themes/resolve", {
      ...json(body),
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
    });

  test("resolves built-in presets (including graphite_atelier exact DESIGN.md roles) and custom seeds", async () => {
    const presetRes = await resolve({ source: { _tag: "Preset", id: "graphite_atelier" } });
    expect(presetRes.status).toBe(200);
    const preset = decodeTheme(await presetRes.json());
    expect(preset.source).toEqual({ _tag: "Preset", id: "graphite_atelier" });
    expect(preset.schemes.light.roles["primary"]).toBe("#18181B");
    expect(preset.schemes.dark.roles["surface"]).toBe("#09090B");
    expect(Rec.keys(preset.schemes.light.roles).length).toBe(M3_COLOR_ROLES.length);
    expect(preset.schemes.light.extended.paid.color).toMatch(COLOR_HEX);
    expect(preset.warnings).toBeUndefined();

    // Custom seed works for API key callers too
    const ws = await h.createWorkspace(owner);
    const seedRes = await resolve(
      { source: { _tag: "Seed", seed: "#1D4ED8" }, contrast: "high" },
      as.apiKey(owner, ws.workspaceId, ["workspace:read"]),
    );
    expect(seedRes.status).toBe(200);
    const seed = decodeTheme(await seedRes.json());
    expect(Arr.sort(Rec.keys(seed.schemes), Order.String)).toEqual([
      "dark",
      "darkHigh",
      "darkMedium",
      "light",
      "lightHigh",
      "lightMedium",
    ]);
  });

  test("resolves MaterialThemeBuilder JSON, emits theme.low_contrast warning, and rejects invalid/oversized files", async () => {
    // Get valid light & dark role maps from a seed resolution
    const baseTheme = decodeTheme(
      await (await resolve({ source: { _tag: "Seed", seed: "#0F5D42" } })).json(),
    );

    const mtbJson = {
      seed: "#0F5D42",
      coreColors: { primary: "#0F5D42" },
      extendedColors: [{ name: "paid", color: "#15803D", harmonized: false }],
      schemes: {
        light: baseTheme.schemes.light.roles,
        dark: baseTheme.schemes.dark.roles,
      },
    };
    const okRes = await resolve({ source: { _tag: "MaterialThemeBuilder", json: mtbJson } });
    expect(okRes.status).toBe(200);
    const resolved = decodeTheme(await okRes.json());
    // Missing contrast schemes generated from seed
    expect(resolved.schemes.lightHigh.roles["primary"]).toMatch(COLOR_HEX);
    expect(resolved.warnings).toBeUndefined();

    // Low-contrast MTB JSON is accepted with theme.low_contrast warning (rule T2)
    const lowContrastRes = await resolve({
      source: {
        _tag: "MaterialThemeBuilder",
        json: {
          ...mtbJson,
          schemes: {
            ...mtbJson.schemes,
            light: { ...mtbJson.schemes.light, primary: "#FFFFFF", onPrimary: "#FEFEFE" },
          },
        },
      },
    });
    expect(lowContrastRes.status).toBe(200);
    const lowContrast = decodeTheme(await lowContrastRes.json());
    expect(lowContrast.warnings).toEqual(["theme.low_contrast"]);

    // Invalid seed in MTB JSON -> 422 theme.seed_invalid
    const badSeed = await resolve({
      source: { _tag: "MaterialThemeBuilder", json: { ...mtbJson, seed: "not-hex" } },
    });
    expect(badSeed.status).toBe(422);
    expect(decodeInvalid(await badSeed.json()).issues[0].code).toBe("theme.seed_invalid");

    // Missing required scheme role -> 422 theme.json_invalid
    const { primary: _dropped, ...incompleteLight } = mtbJson.schemes.light;
    const missingRole = await resolve({
      source: {
        _tag: "MaterialThemeBuilder",
        json: { ...mtbJson, schemes: { ...mtbJson.schemes, light: incompleteLight } },
      },
    });
    expect(missingRole.status).toBe(422);
    expect(decodeInvalid(await missingRole.json()).issues[0].code).toBe("theme.json_invalid");

    // Over 64 KB MTB JSON -> 422 theme.too_large (EdgeGuard allows THEME_JSON_MAX_BYTES + 4 KB)
    const hugeRes = await resolve({
      source: {
        _tag: "MaterialThemeBuilder",
        json: { ...mtbJson, description: Str.repeat(THEME_JSON_MAX_BYTES + 100)("x") },
      },
    });
    expect(hugeRes.status).toBe(422);
    expect(decodeInvalid(await hugeRes.json()).issues[0].code).toBe("theme.too_large");
  });
});
