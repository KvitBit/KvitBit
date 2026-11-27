import { describe, expect, test } from "bun:test";
import { defaultKeyHasher } from "@better-auth/api-key";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import {
  apiKeyMatches,
  generateApiKey,
  hashApiKey,
  parseApiKey,
  verifyApiKey,
} from "../../src/auth";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const KEY_TOKEN = /^kvb_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/;

describe("kvb_ API keys", () => {
  test("generate issues kvb_<uuidv7>_<secret> with matching stored fields", () => {
    const key = generateApiKey();
    expect(key.keyId).toMatch(UUID_V7);
    expect(key.token).toMatch(KEY_TOKEN);
    expect(key.prefix).toBe("kvb_");
    expect(key.start).toBe(`kvb_${key.keyId}`);
    expect(Str.startsWith(key.start)(key.token)).toBe(true);
    expect(key.hash).toBe(hashApiKey(key.token));
    expect(key.hash).not.toContain(Str.slice(key.start.length + 1)(key.token));
    expect(generateApiKey().token).not.toBe(key.token);
  });

  test("parse splits the key id from a secret that may contain _", () => {
    const key = generateApiKey();
    const parts = Option.getOrThrow(parseApiKey(key.token));
    expect(parts.keyId).toBe(key.keyId);
    const tricky = Option.getOrThrow(parseApiKey(`kvb_${key.keyId}_${Str.repeat(20)("a_")}`));
    expect(tricky.secret).toBe(Str.repeat(20)("a_"));
  });

  test("parse rejects malformed bearer values", () => {
    for (const bad of [
      "",
      "kvb_",
      "kvb_abc",
      "kvx_0190a0b1-0000-7000-8000-000000000000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "kvb_0190a0b1-0000-7000-8000-000000000000_short",
      "kvb_0190a0b1-0000-7000-8000-000000000000_has space aaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ]) {
      expect(parseApiKey(bad).pipe(Option.isNone)).toBe(true);
    }
  });

  test("the stored hash equals Better Auth's defaultKeyHasher", async () => {
    const key = generateApiKey();
    expect(key.hash).toBe(await defaultKeyHasher(key.token));
  });

  test("apiKeyMatches accepts the right token only", () => {
    const key = generateApiKey();
    expect(apiKeyMatches(key.token, key.hash)).toBe(true);
    const flipped = `${Str.slice(0, -1)(key.token)}${Str.endsWith("A")(key.token) ? "B" : "A"}`;
    expect(apiKeyMatches(flipped, key.hash)).toBe(false);
    expect(apiKeyMatches(generateApiKey().token, key.hash)).toBe(false);
    expect(apiKeyMatches(key.token, "")).toBe(false);
    expect(apiKeyMatches(key.token, "not-a-digest")).toBe(false);
  });

  test("verifyApiKey reports malformed, unknown key and wrong secret", async () => {
    const key = generateApiKey();
    const rows = new Map<string, string>([[key.keyId, key.hash]]);
    const find = async (id: string) => rows.get(id);

    expect(await verifyApiKey(key.token, find)).toEqual({ ok: true, keyId: key.keyId });
    expect(await verifyApiKey("Bearer nonsense", find)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await verifyApiKey(generateApiKey().token, find)).toEqual({
      ok: false,
      reason: "unknown_key",
    });
    const wrongSecret = `kvb_${key.keyId}_${Str.repeat(43)("x")}`;
    expect(await verifyApiKey(wrongSecret, find)).toEqual({ ok: false, reason: "wrong_secret" });
  });
});
