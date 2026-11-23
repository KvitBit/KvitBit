import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  AltchaChallenge,
  AltchaHeaders,
  AltchaPayloadFromHeader,
  BOT_PROTECTED_AUTH_PATHS,
  BotScope,
} from "../src/index";

const challenge = {
  algorithm: "SHA-256" as const,
  challenge: "4d6f6f6e",
  maxnumber: 100000,
  salt: "c0ffee?scope=sign_up&expires=1795000000",
  signature: "abcdef0123",
};
const payload = { ...challenge, number: 4242, took: 812 };
const { maxnumber: _maxnumber, ...solved } = payload;

describe("ALTCHA schemas", () => {
  test("challenge decodes; bad algorithm, non-hex signature and negative maxnumber fail", () => {
    const decode = Schema.decodeUnknownSync(AltchaChallenge);
    expect(decode(challenge)).toEqual(challenge);
    expect(() => decode({ ...challenge, algorithm: "MD5" })).toThrow();
    expect(() => decode({ ...challenge, signature: "XYZ" })).toThrow();
    expect(() => decode({ ...challenge, maxnumber: -1 })).toThrow();
  });

  test("X-Altcha header is base64 JSON of the solved payload and round-trips", () => {
    const header = btoa(JSON.stringify(solved));
    const decoded = Schema.decodeUnknownSync(AltchaPayloadFromHeader)(header);
    expect(decoded).toEqual(solved);
    const encoded = Schema.encodeSync(AltchaPayloadFromHeader)(decoded);
    expect(JSON.parse(atob(encoded))).toEqual(solved);
    expect(Schema.decodeUnknownSync(AltchaHeaders)({ "x-altcha": header })["x-altcha"]).toEqual(
      solved,
    );
  });

  test("header rejects non-base64, non-JSON and payloads without a number", () => {
    const decode = Schema.decodeUnknownSync(AltchaPayloadFromHeader);
    expect(() => decode("%%%not-base64%%%")).toThrow();
    expect(() => decode(btoa("not json"))).toThrow();
    const { number: _number, ...unsolved } = solved;
    expect(() => decode(btoa(JSON.stringify(unsolved)))).toThrow();
    expect(() => Schema.decodeUnknownSync(AltchaHeaders)({})).toThrow();
  });

  test("protected Better Auth paths map to fixed scopes", () => {
    expect(BOT_PROTECTED_AUTH_PATHS).toEqual({
      "/sign-up/email": "sign_up",
      "/sign-in/email": "sign_in",
      "/sign-in/magic-link": "magic_link",
      "/request-password-reset": "password_reset",
    });
    expect(() => Schema.decodeUnknownSync(BotScope)("sign_out")).toThrow();
  });
});
