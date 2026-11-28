import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
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
const json = Schema.fromJsonString(Schema.Unknown);

describe("ALTCHA schemas", () => {
  test("challenge is a non-empty JSON object", () => {
    const decode = Fn.flow(Schema.decodeUnknownEffect(AltchaChallenge), Effect.runSync);
    expect<Schema.Json>(decode(challenge)).toEqual(challenge);
    expect(() => decode({})).toThrow();
    expect(() => decode([challenge])).toThrow();
    expect(() => decode("challenge")).toThrow();
    expect(() => decode(null)).toThrow();
  });

  test("challenge values must be JSON values", () => {
    const decode = Fn.flow(Schema.decodeUnknownEffect(AltchaChallenge), Effect.runSync);
    expect<Schema.Json>(decode({ a: [1, true, null], b: { c: "d" } })).toEqual({
      a: [1, true, null],
      b: { c: "d" },
    });
    expect(() => decode({ a: undefined })).toThrow();
    expect(() => decode({ a: () => 1 })).toThrow();
    expect(() => decode({ a: 1n })).toThrow();
  });

  test("X-Altcha header is base64 JSON of an object and round-trips", () => {
    const header = btoa(
      '{"challenge":{"parameters":{"algorithm":"PBKDF2/SHA-256","nonce":"4d6f6f6e","expiresAt":1795000000},"signature":"abcdef0123"},"solution":{"counter":4242,"time":812}}',
    );
    const decoded = Schema.decodeEffect(AltchaPayloadFromHeader)(header).pipe(Effect.runSync);
    expect<Schema.Json>(decoded).toEqual(solved);
    const encoded = Schema.encodeEffect(AltchaPayloadFromHeader)(decoded).pipe(Effect.runSync);
    expect(Schema.decodeEffect(json)(atob(encoded)).pipe(Effect.runSync)).toEqual(solved);
    expect<Schema.Json>(
      Schema.decodeEffect(AltchaHeaders)({ "x-altcha": header }).pipe(Effect.runSync)["x-altcha"],
    ).toEqual(solved);
  });

  test("header rejects bad base64, non-JSON and JSON that is not an object", () => {
    const decode = Fn.flow(Schema.decodeUnknownEffect(AltchaPayloadFromHeader), Effect.runSync);
    expect(() => decode("%%%not-base64%%%")).toThrow();
    expect(() => decode(btoa("not json"))).toThrow();
    for (const body of ["[1,2]", '"text"', "42", "null", "true"]) {
      expect(() => decode(btoa(body))).toThrow();
    }
    expect(() => Schema.decodeUnknownEffect(AltchaHeaders)({}).pipe(Effect.runSync)).toThrow();
  });

  test("header rejects values over the length bound", () => {
    expect(ALTCHA_HEADER_MAX_LENGTH).toBe(8192);
    const decode = Fn.flow(Schema.decodeUnknownEffect(AltchaPayloadFromHeader), Effect.runSync);
    const fits = (length: number) => btoa(`{"pad":"${Str.repeat(length)("x")}"}`);
    let n = 0;
    while (fits(n + 3).length <= ALTCHA_HEADER_MAX_LENGTH) n += 3;
    expect(fits(n).length).toBeLessThanOrEqual(ALTCHA_HEADER_MAX_LENGTH);
    expect<Schema.Json>(decode(fits(n))).toEqual({ pad: Str.repeat(n)("x") });
    expect(fits(n + 3).length).toBeGreaterThan(ALTCHA_HEADER_MAX_LENGTH);
    expect(() => decode(fits(n + 3))).toThrow();
  });

  test("bot scopes are the five signed scopes", () => {
    expect(Schema.decodeEffect(BotScope)("invitation_accept").pipe(Effect.runSync)).toBe(
      "invitation_accept",
    );
    expect(() => Schema.decodeUnknownEffect(BotScope)("sign_out").pipe(Effect.runSync)).toThrow();
  });
});
