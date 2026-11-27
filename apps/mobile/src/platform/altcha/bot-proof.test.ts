import { describe, expect, test } from "bun:test";
/* biome-ignore lint/correctness/noNodejsModules: Use Node crypto as an independent oracle for the mobile KDFs. */ // @effect-diagnostics-next-line nodeBuiltinImport:off Node crypto provides an independent oracle for the TypeScript KDFs.
import crypto, { createHash, pbkdf2Sync } from "node:crypto";
// biome-ignore lint/correctness/noNodejsModules: Adapt the Node argon2 callback for the oracle test.
import { promisify } from "node:util";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as EffectString from "effect/String";
import { fetchChallenge, isExpired, solveChallenge } from "./bot-proof";
import { argon2id, blake2b, bytesToHex, hexToBytes, pbkdf2Sha256, sha256 } from "./kdf";

const argon2Async = promisify(crypto.argon2);
const iso = (milliseconds: number) => DateTime.formatIso(DateTime.makeUnsafe(milliseconds));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const Proof = Schema.Struct({
  challenge: Schema.Unknown,
  solution: Schema.Struct({ counter: Schema.Int, derivedKey: Schema.String, time: Schema.Finite }),
});
const parseProof = Schema.decodeEffect(Schema.fromJsonString(Proof));
const decodePayload = (payload: string) =>
  Effect.runPromise(parseProof(Buffer.from(payload, "base64").toString("utf8")));

describe("kdf primitives", () => {
  test("sha256 matches node:crypto", () => {
    const input = new TextEncoder().encode("kvitbit-altcha-v2");
    const expected = createHash("sha256").update(input).digest("hex");
    expect(bytesToHex(sha256(input))).toBe(expected);
  });

  test("pbkdf2Sha256 matches node:crypto", async () => {
    const pwd = new TextEncoder().encode("password");
    const salt = new TextEncoder().encode("a fixed test salt");
    const derived = await pbkdf2Sha256(pwd, salt, 100, 32);
    const expected = pbkdf2Sync(pwd, salt, 100, 32, "sha256").toString("hex");
    expect(bytesToHex(derived)).toBe(expected);
  });

  test("blake2b matches RFC 7693 test vector for 'abc'", () => {
    const out = blake2b(new TextEncoder().encode("abc"), 64);
    expect(bytesToHex(out)).toBe(
      // biome-ignore lint/security/noSecrets: Public RFC 7693 digest fixture.
      "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1" +
        // biome-ignore lint/security/noSecrets: Second half of the RFC digest fixture.
        "7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
    );
  });

  test("argon2id matches node:crypto.argon2 (server altcha-lib verifier)", async () => {
    const pwd = new TextEncoder().encode("password");
    const salt = new TextEncoder().encode("somesalt");
    const tag = argon2id(pwd, salt, { cost: 2, memoryCost: 64, parallelism: 1, keyLength: 32 });
    const expected = await argon2Async("argon2id", {
      message: pwd,
      nonce: salt,
      passes: 2,
      memory: 64,
      parallelism: 1,
      tagLength: 32,
    });
    expect(bytesToHex(tag)).toBe(expected.toString("hex"));
  });
});

describe("fetchChallenge", () => {
  test("returns NotRequired on 204", async () => {
    const result = await fetchChallenge("https://kvitbit.test", "sign_up", () =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    expect(result).toEqual({ _tag: "NotRequired" });
  });

  test("returns Challenge on 200 with parameters", async () => {
    const challenge = {
      parameters: { algorithm: "PBKDF2/SHA-256", nonce: "aa", salt: "bb", cost: 1, keyPrefix: "0" },
      signature: "sig",
    };
    const body = await Effect.runPromise(encodeJson(challenge));
    let requestedUrl = "";
    const result = await fetchChallenge("https://kvitbit.test/", "magic_link", (url) => {
      requestedUrl = url;
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    expect(requestedUrl).toBe("https://kvitbit.test/api/v1/bot-protection/challenges/magic_link");
    expect(result).toEqual({ _tag: "Challenge", challenge });
  });

  test("maps 429 to RateLimited and network errors to Offline", async () => {
    const rate = await fetchChallenge("https://kvitbit.test", "sign_in", () =>
      Promise.resolve(new Response("{}", { status: 429, headers: { "retry-after": "12" } })),
    );
    expect(rate).toMatchObject({ _tag: "Err", error: { _tag: "RateLimited" } });

    const offline = await fetchChallenge("https://kvitbit.test", "sign_in", () =>
      Promise.reject(new TypeError("network down")),
    );
    expect(offline).toEqual({ _tag: "Err", error: { _tag: "Offline" } });
  });
});

describe("solveChallenge", () => {
  test("solves a PBKDF2/SHA-256 challenge and produces verifiable payload + expiresAt ISO", async () => {
    const expiresSec = 1_800_000_000;
    const challenge = {
      parameters: {
        algorithm: "PBKDF2/SHA-256",
        nonce: "0102030405060708090a0b0c0d0e0f10",
        salt: "1112131415161718191a1b1c1d1e1f20",
        cost: 10,
        keyLength: 32,
        keyPrefix: "0",
        expiresAt: expiresSec,
        data: { scope: "sign_up" },
      },
      signature: "deadbeef",
    };
    const progressValues: number[] = [];
    const outcome = await solveChallenge(challenge, {
      onProgress: (p) => progressValues.push(p),
    });
    expect(outcome._tag).toBe("Solved");
    if (outcome._tag !== "Solved") throw new Error("Expected a solved challenge.");
    expect(outcome.expiresAt).toBe(iso(expiresSec * 1000));
    expect(progressValues.at(-1)).toBe(1);

    const decoded = await decodePayload(outcome.payload);
    expect(decoded.challenge).toEqual(challenge);
    expect(EffectString.startsWith("0")(decoded.solution.derivedKey)).toBe(true);

    // Independently verify derivedKey with node:crypto pbkdf2Sync
    const nonceBytes = hexToBytes(challenge.parameters.nonce);
    const saltBytes = hexToBytes(challenge.parameters.salt);
    if (nonceBytes === null || saltBytes === null) {
      throw new Error("expected valid hex nonce and salt");
    }
    const pwd = new Uint8Array(nonceBytes.length + 4);
    pwd.set(nonceBytes, 0);
    new DataView(pwd.buffer).setUint32(nonceBytes.length, decoded.solution.counter, false);
    const expected = pbkdf2Sync(
      pwd,
      saltBytes,
      challenge.parameters.cost,
      challenge.parameters.keyLength,
      "sha256",
    ).toString("hex");
    expect(decoded.solution.derivedKey).toBe(expected);
  });

  test("solves an ARGON2ID challenge with null expiresAt when absent", async () => {
    const challenge = {
      parameters: {
        algorithm: "ARGON2ID",
        nonce: "0102030405060708",
        salt: "1112131415161718",
        cost: 1,
        memoryCost: 16,
        parallelism: 1,
        keyLength: 32,
        keyPrefix: "0",
      },
      signature: "sig",
    };
    const outcome = await solveChallenge(challenge);
    expect(outcome._tag).toBe("Solved");
    if (outcome._tag !== "Solved") throw new Error("Expected a solved challenge.");
    expect(outcome.expiresAt).toBeNull();
    const decoded = await decodePayload(outcome.payload);
    expect(EffectString.startsWith("0")(decoded.solution.derivedKey)).toBe(true);
  });

  test("respects AbortSignal", async () => {
    const controller = new AbortController();
    controller.abort();
    const options = { signal: controller.signal, parameters: {} };
    const outcome = solveChallenge(
      {
        parameters: {
          algorithm: "SHA-256",
          nonce: "0102",
          salt: "0304",
          cost: 1,
          keyPrefix: "000000",
        },
      },
      options,
    );
    await expect(outcome).resolves.toEqual({ _tag: "Aborted" });
  });

  test("returns Err on malformed challenge parameters", async () => {
    const outcome = await solveChallenge({ parameters: { algorithm: "UNKNOWN" } });
    expect(outcome._tag).toBe("Err");
  });
});

describe("isExpired", () => {
  test("respects margin and null expiresAt", () => {
    expect(isExpired(null, 1_000_000)).toBe(false);
    const exp = iso(1_020_000);
    expect(isExpired(exp, 1_005_000, 10_000)).toBe(false);
    expect(isExpired(exp, 1_010_000, 10_000)).toBe(true);
    expect(isExpired("not-a-date", 1_000_000)).toBe(true);
  });
});
