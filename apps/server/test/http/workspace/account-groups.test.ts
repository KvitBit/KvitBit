import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { M3_COLOR_ROLES, THEME_JSON_MAX_BYTES } from "@kvitbit/api-contract";
import { as, type Harness, json, makeHarness, type TestUser } from "../harness";

let h: Harness;
let owner: TestUser;

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
      const view = (await createRes.json()) as { id: string; name: string; revision: number };
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
      expect(await replay.json()).toEqual(view);

      // listMine includes the created workspace
      const listRes = await h.fetch("/api/v1/workspaces", { headers: as.mobile(owner) });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as Array<{ id: string; role: string }>;
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
  const resolve = (body: unknown, headers: Record<string, string> = as.mobile(owner)) =>
    h.fetch("/api/v1/themes/resolve", {
      ...json(body),
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
    });

  test("resolves built-in presets (including graphite_atelier exact DESIGN.md roles) and custom seeds", async () => {
    const presetRes = await resolve({ source: { _tag: "Preset", id: "graphite_atelier" } });
    expect(presetRes.status).toBe(200);
    const preset = (await presetRes.json()) as {
      source: unknown;
      schemes: Record<
        string,
        {
          roles: Record<string, string>;
          extended: Record<string, { color: string; onColor: string }>;
        }
      >;
      warnings?: string[];
    };
    expect(preset.source).toEqual({ _tag: "Preset", id: "graphite_atelier" });
    expect(preset.schemes.light?.roles.primary).toBe("#18181B");
    expect(preset.schemes.dark?.roles.surface).toBe("#09090B");
    expect(Object.keys(preset.schemes.light?.roles ?? {}).length).toBe(M3_COLOR_ROLES.length);
    expect(preset.schemes.light?.extended.paid?.color).toMatch(/^#[0-9A-F]{6}$/);
    expect(preset.warnings).toBeUndefined();

    // Custom seed works for API key callers too
    const ws = await h.createWorkspace(owner);
    const seedRes = await resolve(
      { source: { _tag: "Seed", seed: "#1D4ED8" }, contrast: "high" },
      as.apiKey(owner, ws.workspaceId, ["workspace:read"]),
    );
    expect(seedRes.status).toBe(200);
    const seed = (await seedRes.json()) as { schemes: Record<string, unknown> };
    expect(Object.keys(seed.schemes).sort()).toEqual([
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
    const baseTheme = (await (
      await resolve({ source: { _tag: "Seed", seed: "#0F5D42" } })
    ).json()) as {
      schemes: {
        light: { roles: Record<string, string> };
        dark: { roles: Record<string, string> };
      };
    };

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
    const resolved = (await okRes.json()) as {
      schemes: { lightHigh: { roles: Record<string, string> } };
      warnings?: string[];
    };
    // Missing contrast schemes generated from seed
    expect(resolved.schemes.lightHigh.roles.primary).toMatch(/^#[0-9A-F]{6}$/);
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
    const lowContrast = (await lowContrastRes.json()) as { warnings?: string[] };
    expect(lowContrast.warnings).toEqual(["theme.low_contrast"]);

    // Invalid seed in MTB JSON -> 422 theme.seed_invalid
    const badSeed = await resolve({
      source: { _tag: "MaterialThemeBuilder", json: { ...mtbJson, seed: "not-hex" } },
    });
    expect(badSeed.status).toBe(422);
    expect(((await badSeed.json()) as { issues: Array<{ code: string }> }).issues[0]?.code).toBe(
      "theme.seed_invalid",
    );

    // Missing required scheme role -> 422 theme.json_invalid
    const { primary: _dropped, ...incompleteLight } = mtbJson.schemes.light;
    const missingRole = await resolve({
      source: {
        _tag: "MaterialThemeBuilder",
        json: { ...mtbJson, schemes: { ...mtbJson.schemes, light: incompleteLight } },
      },
    });
    expect(missingRole.status).toBe(422);
    expect(
      ((await missingRole.json()) as { issues: Array<{ code: string }> }).issues[0]?.code,
    ).toBe("theme.json_invalid");

    // Over 64 KB MTB JSON -> 422 theme.too_large (EdgeGuard allows THEME_JSON_MAX_BYTES + 4 KB)
    const hugeRes = await resolve({
      source: {
        _tag: "MaterialThemeBuilder",
        json: { ...mtbJson, description: "x".repeat(THEME_JSON_MAX_BYTES + 100) },
      },
    });
    expect(hugeRes.status).toBe(422);
    expect(((await hugeRes.json()) as { issues: Array<{ code: string }> }).issues[0]?.code).toBe(
      "theme.too_large",
    );
  });
});
