import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { type Challenge, createChallenge, type Solution, solveChallenge } from "altcha-lib";
import { deriveKey as derivePbkdf2 } from "altcha-lib/algorithms/pbkdf2";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as SqlClient from "effect/sql/SqlClient";
import {
  AltchaBotProtection,
  AltchaBotProtectionConfig,
  type AltchaOptions,
  BotProtection,
  BotProtectionUnavailable,
  type BotScope,
  consumeChallenge,
  InvalidBotProof,
  NoopBotProtection,
  purgeExpiredChallenges,
} from "../../src/altcha";
import { layerFromPglite, makeMigratedPglite } from "../../src/testing";

const SECRET = "test-hmac-secret-0123456789";
const fast: AltchaOptions = {
  hmacKey: Redacted.make(SECRET),
  algorithm: "PBKDF2/SHA-256",
  cost: 1,
  keyPrefix: "0",
};

let pg: PGlite;
beforeAll(async () => {
  pg = await makeMigratedPglite();
});
afterAll(async () => {
  await pg.close();
});

const run = <A, E>(
  effect: Effect.Effect<A, E, BotProtection | SqlClient.SqlClient>,
  options: AltchaOptions = fast,
) => {
  const sql = layerFromPglite(pg);
  return Effect.runPromiseExit(
    effect.pipe(Effect.provide(Layer.provideMerge(AltchaBotProtection(options), sql))),
  );
};

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const encode = (challenge: Challenge, solution: Solution | null) =>
  encodeJson({ challenge, solution }).pipe(
    Effect.map((json) => Buffer.from(json).toString("base64")),
  );

const solve = async (challenge: Challenge) => {
  const solution = await solveChallenge({ challenge, deriveKey: derivePbkdf2 });
  if (solution === null) throw new Error("unsolved");
  return solution;
};

const issueAndSolve = Effect.fn("issueAndSolve")(function* (scope: BotScope) {
  const bp = yield* BotProtection;
  const challenge = yield* bp.issue(scope);
  const solution = yield* Effect.promise(() => solve(challenge));
  return { challenge, solution };
});

const isBotError = Schema.is(Schema.Union([InvalidBotProof, BotProtectionUnavailable]));

const reasonOf = <A, E>(exit: Exit.Exit<A, E>) =>
  exit.pipe(
    Exit.findErrorOption,
    Option.filter(isBotError),
    Option.map((error) => (error._tag === "InvalidBotProof" ? error.reason : error._tag)),
    Option.getOrUndefined,
  );

const verifyWith = (scope: BotScope, payload: string) =>
  BotProtection.use((bp) => bp.verify(scope, payload));

describe("AltchaBotProtection", () => {
  test("issue, solve and verify succeeds and records the challenge", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const { challenge, solution } = yield* issueAndSolve("sign_up");
        expect(challenge.parameters.data?.["scope"]).toBe("sign_up");
        const payload = yield* encode(challenge, solution);
        yield* verifyWith("sign_up", payload);
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ scope: string }>`
          select scope from altcha_replays where challenge_digest = ${challenge.signature ?? ""}`;
        return rows;
      }),
    );
    expect(exit).toMatchObject({ _tag: "Success", value: [{ scope: "sign_up" }] });
  });

  test("a second verify of the same payload is a replay", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const { challenge, solution } = yield* issueAndSolve("sign_in");
        const payload = yield* encode(challenge, solution);
        yield* verifyWith("sign_in", payload);
        yield* verifyWith("sign_in", payload);
      }),
    );
    expect(exit.pipe(reasonOf)).toBe("replayed");
  });

  test("a challenge issued for one scope fails on another", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const { challenge, solution } = yield* issueAndSolve("sign_up");
        const payload = yield* encode(challenge, solution);
        yield* verifyWith("password_reset", payload);
      }),
    );
    expect(exit.pipe(reasonOf)).toBe("wrong_scope");
  });

  test("tampering with the signed scope breaks the HMAC", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const { challenge, solution } = yield* issueAndSolve("sign_up");
        const tampered: Challenge = {
          ...challenge,
          parameters: { ...challenge.parameters, data: { scope: "magic_link" } },
        };
        const payload = yield* encode(tampered, solution);
        yield* verifyWith("magic_link", payload);
      }),
    );
    expect(exit.pipe(reasonOf)).toBe("invalid_signature");
  });

  test("a challenge signed with another key is rejected", async () => {
    const nowMs = await Effect.runPromise(Clock.currentTimeMillis);
    const forged = await createChallenge({
      algorithm: "PBKDF2/SHA-256",
      cost: 1,
      keyPrefix: "0",
      deriveKey: derivePbkdf2,
      hmacSignatureSecret: "another-secret-0123456789",
      expiresAt: Math.floor(nowMs / 1000) + 60,
      data: { scope: "sign_up" },
    });
    const solution = await solve(forged);
    const payload = await Effect.runPromise(encode(forged, solution));
    const exit = await run(verifyWith("sign_up", payload));
    expect(exit.pipe(reasonOf)).toBe("invalid_signature");
  });

  test("an expired challenge is rejected", async () => {
    const nowMs = await Effect.runPromise(Clock.currentTimeMillis);
    const expired = await createChallenge({
      algorithm: "PBKDF2/SHA-256",
      cost: 1,
      keyPrefix: "0",
      deriveKey: derivePbkdf2,
      hmacSignatureSecret: SECRET,
      expiresAt: Math.floor(nowMs / 1000) - 10,
      data: { scope: "sign_up" },
    });
    const solution = await solve(expired);
    const payload = await Effect.runPromise(encode(expired, solution));
    const exit = await run(verifyWith("sign_up", payload));
    expect(exit.pipe(reasonOf)).toBe("expired");
  });

  test("a wrong proof of work is rejected and not consumed", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const { challenge, solution } = yield* issueAndSolve("invitation_accept");
        const wrong = { ...solution, derivedKey: Str.repeat(solution.derivedKey.length)("f") };
        const wrongPayload = yield* encode(challenge, wrong);
        const first = yield* Effect.exit(verifyWith("invitation_accept", wrongPayload));
        // The failed attempt did not burn the challenge: the honest solution still passes.
        const honestPayload = yield* encode(challenge, solution);
        yield* verifyWith("invitation_accept", honestPayload);
        return reasonOf(first);
      }),
    );
    expect(exit).toMatchObject({ _tag: "Success", value: "invalid_solution" });
  });

  test("missing and malformed payloads are rejected", async () => {
    const missing = await run(verifyWith("sign_up", ""));
    const malformed = await run(verifyWith("sign_up", "not base64 json"));
    const json = await Effect.runPromise(encodeJson({ challenge: {} }));
    const noSolution = await run(verifyWith("sign_up", Buffer.from(json).toString("base64")));
    const oversized = await run(verifyWith("sign_up", Str.repeat(9000)("A")));
    expect(missing.pipe(reasonOf)).toBe("missing");
    expect(malformed.pipe(reasonOf)).toBe("malformed");
    expect(noSolution.pipe(reasonOf)).toBe("malformed");
    expect(oversized.pipe(reasonOf)).toBe("malformed");
  });

  test("a challenge for another algorithm is rejected", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const { challenge, solution } = yield* issueAndSolve("sign_up");
        return yield* encode(challenge, solution);
      }),
    );
    if (!Exit.isSuccess(exit)) throw new Error("issue failed");
    const argon = { ...fast, algorithm: "ARGON2ID" as const, memoryCost: 64 };
    const verified = await run(verifyWith("sign_up", exit.value), argon);
    expect(verified.pipe(reasonOf)).toBe("malformed");
  });

  test("ARGON2ID challenges verify end to end", async () => {
    const { deriveKey } = await import("altcha-lib/algorithms/argon2id");
    const exit = await run(
      Effect.gen(function* () {
        const bp = yield* BotProtection;
        const challenge = yield* bp.issue("magic_link");
        expect(challenge.parameters.algorithm).toBe("ARGON2ID");
        const solution = yield* Effect.promise(() => solveChallenge({ challenge, deriveKey }));
        const payload = yield* encode(challenge, solution);
        yield* bp.verify("magic_link", payload);
      }),
      { ...fast, algorithm: "ARGON2ID", cost: 1, memoryCost: 64 },
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("the store being down is BotProtectionUnavailable, never success", async () => {
    const broken = await makeMigratedPglite();
    await broken.exec("drop table altcha_replays");
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const { challenge, solution } = yield* issueAndSolve("sign_up");
        const payload = yield* encode(challenge, solution);
        yield* verifyWith("sign_up", payload);
      }).pipe(Effect.provide(Layer.provide(AltchaBotProtection(fast), layerFromPglite(broken)))),
    );
    await broken.close();
    expect(exit.pipe(reasonOf)).toBe("BotProtectionUnavailable");
  }, 20_000);

  test("AltchaBotProtectionConfig reads ALTCHA_HMAC_KEY", async () => {
    const layer = AltchaBotProtectionConfig({ algorithm: "PBKDF2/SHA-256", cost: 1 }).pipe(
      Layer.provide(layerFromPglite(pg)),
      Layer.provide(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ALTCHA_HMAC_KEY: SECRET } })),
      ),
    );
    const exit = await Effect.runPromiseExit(
      BotProtection.use((bp) => bp.issue("sign_up")).pipe(Effect.provide(layer)),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("purgeExpiredChallenges", () => {
  test("deletes only rows past expires_at", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const now = DateTime.makeUnsafe("2030-01-01T00:00:00Z");
        yield* consumeChallenge({
          digest: "purge-old",
          scope: "sign_up",
          expiresAt: now.pipe(DateTime.subtract({ seconds: 1 }), DateTime.toDateUtc),
        });
        yield* consumeChallenge({
          digest: "purge-live",
          scope: "sign_up",
          expiresAt: now.pipe(DateTime.add({ seconds: 1 }), DateTime.toDateUtc),
        });
        const deleted = yield* purgeExpiredChallenges(Fn.pipe(now, DateTime.toDateUtc));
        const sql = yield* SqlClient.SqlClient;
        const left = yield* sql<{ d: string }>`
          select challenge_digest as d from altcha_replays where challenge_digest like 'purge-%'`;
        return { deleted, left: Arr.map(left, (r) => r.d) };
      }).pipe(Effect.provide(layerFromPglite(pg))),
    );
    const value = exit.pipe(Exit.getSuccess, Option.getOrThrow);
    expect(value.left).toEqual(["purge-live"]);
    expect(value.deleted).toBeGreaterThanOrEqual(1);
  });
});

describe("NoopBotProtection", () => {
  test("accepts any payload", async () => {
    const exit = await Effect.runPromiseExit(
      verifyWith("sign_up", "").pipe(Effect.provide(NoopBotProtection)),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});
