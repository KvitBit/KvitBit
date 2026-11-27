import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AccountPreferences, M3_COLOR_ROLES, ResolvedTheme } from "@kvitbit/api-contract";
import { Invalid } from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Order from "effect/Order";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { as, type Harness, json, makeHarness, TEST_NOW, type TestUser } from "../harness";
import { createSeededWorkspace, seedUser } from "./seed";

let h: Harness;
let alice: TestUser;
let bob: TestUser;

const PATH = "/api/v1/me/preferences";
const decodePreferences = Fn.flow(
  Schema.decodeUnknownEffect(
    Schema.toEncoded(
      Schema.Struct({
        ...AccountPreferences.fields,
        theme: Schema.JsonObject,
        resolvedTheme: Schema.NullOr(
          Schema.Struct({
            ...ResolvedTheme.fields,
            source: Schema.JsonObject,
            schemes: Schema.Record(Schema.String, Schema.Struct({ roles: Schema.JsonObject })),
          }),
        ),
      }),
    ),
  ),
  Effect.runSync,
);
const decodeInvalid = Fn.flow(
  Schema.decodeUnknownEffect(Schema.toEncoded(Invalid)),
  Effect.runSync,
);

beforeEach(async () => {
  h = makeHarness();
  await h.run(TestClock.setTime(TEST_NOW));
  alice = h.addUser("Alice");
  bob = h.addUser("Bob");
  await h.run(seedUser(alice));
  await h.run(seedUser(bob));
}, 20_000);

afterEach(async () => {
  await h.dispose();
});

const patchPrefs = (user: TestUser, body: Schema.Json, headers: Record<string, string> = {}) =>
  h.fetch(PATH, {
    ...json(body),
    method: "PATCH",
    headers: { "content-type": "application/json", ...as.mobile(user), ...headers },
  });

describe("me preferences group", () => {
  test('GET returns default preferences with ETag "1" when no row exists yet', async () => {
    const res = await h.fetch(PATH, { headers: as.mobile(alice) });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('"1"');
    expect(await res.json()).toEqual({
      locale: null,
      theme: {
        mode: "system",
        style: "elegant",
        contrast: "standard",
        dynamicColor: true,
        source: null,
      },
      resolvedTheme: null,
      revision: 1,
    });
  });

  test("preferences and the theme endpoint produce the same Material scheme for a seed", async () => {
    const source = { _tag: "Seed", seed: "#336699" };
    const resolved = await h.fetch("/api/v1/themes/resolve", {
      ...json({ source }),
      method: "POST",
      headers: { "content-type": "application/json", ...as.mobile(alice) },
    });
    expect(resolved.status).toBe(200);
    const expected = await resolved.json();
    const saved = await patchPrefs(
      alice,
      {
        theme: {
          mode: "system",
          style: "elegant",
          contrast: "standard",
          dynamicColor: false,
          source,
        },
      },
      { "if-match": '"1"' },
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ resolvedTheme: expected });
    const read = await h.fetch(PATH, { headers: as.mobile(alice) });
    expect(await read.json()).toMatchObject({ resolvedTheme: expected });
  });

  test("PATCH requires If-Match (428) and enforces optimistic revision (412 with ETag)", async () => {
    // Missing If-Match -> 428 PreconditionRequired
    const missing = await patchPrefs(alice, { locale: "en" });
    expect(missing.status).toBe(428);
    expect(await missing.json()).toEqual({ _tag: "PreconditionRequired" });

    // Stale revision before first insert -> 412 PreconditionFailed with currentRevision 1
    const staleBeforeInsert = await patchPrefs(alice, { locale: "en" }, { "if-match": '"5"' });
    expect(staleBeforeInsert.status).toBe(412);
    expect(staleBeforeInsert.headers.get("etag")).toBe('"1"');
    expect(await staleBeforeInsert.json()).toEqual({
      _tag: "PreconditionFailed",
      currentRevision: 1,
    });

    // Valid first write with If-Match: "1" -> 200 with ETag: "2"
    const first = await patchPrefs(alice, { locale: "en" }, { "if-match": '"1"' });
    expect(first.status).toBe(200);
    expect(first.headers.get("etag")).toBe('"2"');
    const firstBody = decodePreferences(await first.json());
    expect(firstBody.locale).toBe("en");
    expect(firstBody.revision).toBe(2);
    expect(firstBody.resolvedTheme).toBeNull();

    // Stale update against existing row -> 412 with currentRevision 2
    const staleAfterInsert = await patchPrefs(alice, { locale: "cs" }, { "if-match": '"1"' });
    expect(staleAfterInsert.status).toBe(412);
    expect(staleAfterInsert.headers.get("etag")).toBe('"2"');
    expect(await staleAfterInsert.json()).toEqual({
      _tag: "PreconditionFailed",
      currentRevision: 2,
    });
  });

  test("PATCH persists theme Preset/Seed with resolvedTheme, supports partial updates and resetting to null", async () => {
    const presetRes = await patchPrefs(
      alice,
      {
        locale: "cs",
        theme: {
          mode: "dark",
          style: "cozy",
          contrast: "high",
          dynamicColor: false,
          source: { _tag: "Preset", id: "forest" },
        },
      },
      { "if-match": '"1"' },
    );
    expect(presetRes.status).toBe(200);
    expect(presetRes.headers.get("etag")).toBe('"2"');
    const presetWire = await presetRes.json();
    const presetBody = decodePreferences(presetWire);
    expect(presetBody.locale).toBe("cs");
    expect(presetBody.theme).toEqual({
      mode: "dark",
      style: "cozy",
      contrast: "high",
      dynamicColor: false,
      source: { _tag: "Preset", id: "forest" },
    });
    expect(presetBody.resolvedTheme).not.toBeNull();
    expect(presetBody.resolvedTheme?.source).toEqual({ _tag: "Preset", id: "forest" });
    for (const schemeKey of [
      "light",
      "dark",
      "lightMedium",
      "lightHigh",
      "darkMedium",
      "darkHigh",
    ]) {
      const scheme = presetBody.resolvedTheme?.schemes[schemeKey];
      expect(scheme).toBeDefined();
      expect(Arr.sort(Rec.keys(scheme?.roles ?? {}), Order.String)).toEqual(
        Arr.sort(M3_COLOR_ROLES, Order.String),
      );
    }

    // GET reflects the persisted preferences and ETag
    const got = await h.fetch(PATH, { headers: as.mobile(alice) });
    expect(got.status).toBe(200);
    expect(got.headers.get("etag")).toBe('"2"');
    expect(await got.json()).toEqual(presetWire);

    // Partial update: clearing locale to null preserves theme
    const clearLocale = await patchPrefs(alice, { locale: null }, { "if-match": '"2"' });
    expect(clearLocale.status).toBe(200);
    expect(clearLocale.headers.get("etag")).toBe('"3"');
    const clearLocaleBody = decodePreferences(await clearLocale.json());
    expect(clearLocaleBody.locale).toBeNull();
    expect(clearLocaleBody.theme["source"]).toEqual({ _tag: "Preset", id: "forest" });
    expect(clearLocaleBody.resolvedTheme).not.toBeNull();

    // Setting theme.source to null clears resolvedTheme to null
    const resetSource = await patchPrefs(
      alice,
      {
        theme: {
          mode: "system",
          style: "elegant",
          contrast: "standard",
          dynamicColor: true,
          source: null,
        },
      },
      { "if-match": '"3"' },
    );
    expect(resetSource.status).toBe(200);
    expect(resetSource.headers.get("etag")).toBe('"4"');
    const resetBody = decodePreferences(await resetSource.json());
    expect(resetBody.resolvedTheme).toBeNull();

    // Bob's preferences remain untouched at revision 1
    const bobRes = await h.fetch(PATH, { headers: as.mobile(bob) });
    expect(bobRes.status).toBe(200);
    expect(bobRes.headers.get("etag")).toBe('"1"');
  });

  test("MaterialThemeBuilder validates structure and emits theme.low_contrast warning without rejecting", async () => {
    const invalidMtb = await patchPrefs(
      alice,
      {
        theme: {
          mode: "light",
          style: "elegant",
          contrast: "standard",
          dynamicColor: false,
          source: { _tag: "MaterialThemeBuilder", json: { bad: true } },
        },
      },
      { "if-match": '"1"' },
    );
    expect(invalidMtb.status).toBe(422);
    expect(decodeInvalid(await invalidMtb.json()).issues[0].code).toBe("theme.json_invalid");

    const roles = Rec.fromIterableWith(M3_COLOR_ROLES, (role) => [role, "#EEEEEE"]);
    const lowContrastMtb = await patchPrefs(
      alice,
      {
        theme: {
          mode: "light",
          style: "elegant",
          contrast: "standard",
          dynamicColor: false,
          source: {
            _tag: "MaterialThemeBuilder",
            json: {
              seed: "#1D4ED8",
              coreColors: { primary: "#1D4ED8" },
              schemes: {
                light: { ...roles, primary: "#FFFFFF" },
                dark: { ...roles, primary: "#93C5FD", onPrimary: "#111111" },
              },
            },
          },
        },
      },
      { "if-match": '"1"' },
    );
    expect(lowContrastMtb.status).toBe(200);
    const body = decodePreferences(await lowContrastMtb.json());
    expect(body.resolvedTheme?.warnings).toEqual(["theme.low_contrast"]);
  });

  test("SessionOnly rejects API Key credentials with 401 credential_not_allowed", async () => {
    const ws = await createSeededWorkspace(h, alice, "alice-sro", "Alice s.r.o.");
    const res = await h.fetch(PATH, {
      headers: as.apiKey(alice, ws.workspaceId, ["workspace:read"]),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ _tag: "Unauthorized", reason: "credential_not_allowed" });
  });
});
