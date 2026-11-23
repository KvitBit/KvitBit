import { describe, expect, test } from "bun:test";
import { Option, Schema } from "effect";
import {
  ApiKeyId,
  ApiKeyToken,
  apiKeyDisplayPrefix,
  formatApiKey,
  isApiKeyBearer,
  parseApiKey,
} from "../src/index";

const secret = "Zm9vYmFyLWJhei1xdXV4LTAxMjM0NTY3ODlhYmNkZWY_-";
const keyId = ApiKeyId.make("01JDX3K7M9");

describe("kvb_ API key format", () => {
  test("formats and parses kvb_<key id>_<secret>", () => {
    const token = formatApiKey({ keyId, secret });
    expect(String(token)).toBe(`kvb_01JDX3K7M9_${secret}`);
    expect(parseApiKey(token)).toEqual(Option.some({ keyId, secret }));
    expect(Schema.is(ApiKeyToken)(token)).toBe(true);
    expect(apiKeyDisplayPrefix(keyId)).toBe("kvb_01JDX3K7M9");
  });

  test("a secret containing _ still splits at the first separator", () => {
    const parsed = parseApiKey("kvb_abcdefgh_aaaaaaaa_bbbbbbbb_cccccccc_dddddddd");
    expect(Option.map(parsed, (p) => [p.keyId, p.secret])).toEqual(
      Option.some(["abcdefgh", "aaaaaaaa_bbbbbbbb_cccccccc_dddddddd"]),
    );
  });

  test("rejects other prefixes, short ids, short secrets and junk", () => {
    for (const bad of [
      `kva_01JDX3K7M9_${secret}`,
      `kvb_short_${secret}`,
      "kvb_01JDX3K7M9_tooShort",
      `kvb_01JDX3K7M9_${secret}!`,
      "kvb_",
      "",
    ]) {
      expect(Option.isNone(parseApiKey(bad))).toBe(true);
      expect(Schema.is(ApiKeyToken)(bad)).toBe(false);
    }
  });

  test("the kvb_ prefix alone routes a bearer value to the API Key lookup (rule A1)", () => {
    expect(isApiKeyBearer("kvb_anything")).toBe(true);
    expect(isApiKeyBearer("session-token-value")).toBe(false);
    expect(isApiKeyBearer("KVB_upper")).toBe(false);
  });
});
