import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  ALTCHA_HEADER_MAX_LENGTH,
  AltchaChallenge,
  AltchaHeaders,
  AltchaPayloadFromHeader,
  BotScope,
} from "../src/index";

// v2-like sample; the contract accepts any JSON object, so the field names are illustrative.
const challenge = {
  parameters: { algorithm: "PBKDF2/SHA-256", nonce: "4d6f6f6e", expiresAt: 1795000000 },
  signature: "abcdef0123",
};
const solved = { challenge, solution: { counter: 4242, time: 812 } };
/** Drops the brand so decoded values compare against plain literals. */
const plain = (value: unknown): unknown => value;

describe("ALTCHA schemas", () => {
  test("challenge is a non-empty JSON object", () => {
    const decode = Schema.decodeUnknownSync(AltchaChallenge);
    expect(plain(decode(challenge))).toEqual(challenge);
    expect(() => decode({})).toThrow();
    expect(() => decode([challenge])).toThrow();
    expect(() => decode("challenge")).toThrow();
    expect(() => decode(null)).toThrow();
  });

  test("X-Altcha header is base64 JSON of an object and round-trips", () => {
    const header = btoa(JSON.stringify(solved));
    const decoded = Schema.decodeUnknownSync(AltchaPayloadFromHeader)(header);
    expect(plain(decoded)).toEqual(solved);
    const encoded = Schema.encodeSync(AltchaPayloadFromHeader)(decoded);
    expect(JSON.parse(atob(encoded))).toEqual(solved);
    expect(
      plain(Schema.decodeUnknownSync(AltchaHeaders)({ "x-altcha": header })["x-altcha"]),
    ).toEqual(solved);
  });

  test("header rejects bad base64, non-JSON and JSON that is not an object", () => {
    const decode = Schema.decodeUnknownSync(AltchaPayloadFromHeader);
    expect(() => decode("%%%not-base64%%%")).toThrow();
    expect(() => decode(btoa("not json"))).toThrow();
    for (const json of ["[1,2]", '"text"', "42", "null", "true"]) {
      expect(() => decode(btoa(json))).toThrow();
    }
    expect(() => Schema.decodeUnknownSync(AltchaHeaders)({})).toThrow();
  });

  test("header rejects values over the length bound", () => {
    const decode = Schema.decodeUnknownSync(AltchaPayloadFromHeader);
    const fits = (n: number) => btoa(JSON.stringify({ pad: "x".repeat(n) }));
    let n = 0;
    while (fits(n + 3).length <= ALTCHA_HEADER_MAX_LENGTH) n += 3;
    expect(fits(n).length).toBeLessThanOrEqual(ALTCHA_HEADER_MAX_LENGTH);
    expect(plain(decode(fits(n)))).toEqual({ pad: "x".repeat(n) });
    expect(fits(n + 3).length).toBeGreaterThan(ALTCHA_HEADER_MAX_LENGTH);
    expect(() => decode(fits(n + 3))).toThrow();
  });

  test("bot scopes are the five signed scopes", () => {
    expect(Schema.decodeUnknownSync(BotScope)("invitation_accept")).toBe("invitation_accept");
    expect(() => Schema.decodeUnknownSync(BotScope)("sign_out")).toThrow();
  });
});
