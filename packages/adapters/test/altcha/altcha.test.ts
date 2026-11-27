import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { type Challenge, createChallenge, solveChallenge } from "altcha-lib";
import { deriveKey as derivePbkdf2 } from "altcha-lib/algorithms/pbkdf2";
import { ConfigProvider, Effect, Exit, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import {
  AltchaBotProtection,
  AltchaBotProtectionConfig,
  type AltchaOptions,
  BotProtection,
  type BotScope,
  consumeChallenge,
  type InvalidBotProofReason,
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

const encode = (challenge: Challenge, solution: unknown) =>
  Buffer.from(JSON.stringify({ challenge, solution })).toString("base64");

const solve = async (challenge: Challenge) => {
  const solution = await solveChallenge({ challenge, deriveKey: derivePbkdf2 });
  if (solution === null) throw new Error("unsolved");
  return solution;
};

const issueAndSolve = (scope: BotScope) =>
  Effect.gen(function* () {
    const bp = yield* BotProtection;
    const challenge = yield* bp.issue(scope);
    const solution = yield* Effect.promise(() => solve(challenge));
    return { challenge, solution };
  });

const reasonOf = <A>(exit: Exit.Exit<A, unknown>): InvalidBotProofReason | string | undefined => {
  if (Exit.isSuccess(exit)) return undefined;
  const error = exit.cause.reasons.find((r) => r._tag === "Fail");
  const value = error?._tag === "Fail" ? (error.error as { _tag: string; reason?: string }) : null;
  return value?._tag === "InvalidBotProof" ? value.reason : value?._tag;
};

const verifyWith = (scope: BotScope, payload: string) =>
  BotProtection.use((bp) => bp.verify(scope, payload));

describe("AltchaBotProtection", () => {
  test("issue, solve and verify succeeds and records the challenge", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const { challenge, solution } = yield* issueAndSolve("sign_up");
        expect(challenge.parameters.data?.scope).toBe("sign_up");
        yield* verifyWith("sign_up", encode(challenge, solution));
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ scope: string }>`
          select scope from altcha_replays where challenge_digest = ${challenge.signature ?? ""}`;
        return rows;
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toEqual([{ scope: "sign_up" }]);
  });

  test("a second verify of the same payload is a replay", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const { challenge, solution } = yield* issueAndSolve("sign_in");
        const payload = encode(challenge, solution);
        yield* verifyWith("sign_in", payload);
        yield* verifyWith("sign_in", payload);
      }),
    );
    expect(reasonOf(exit)).toBe("replayed");
  });

  test("a challenge issued for one scope fails on another", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const { challenge, solution } = yield* issueAndSolve("sign_up");
        yield* verifyWith("password_reset", encode(challenge, solution));
      }),
    );
    expect(reasonOf(exit)).toBe("wrong_scope");
  });

  test("tampering with the signed scope breaks the HMAC", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const { challenge, solution } = yield* issueAndSolve("sign_up");
        const tampered: Challenge = {
          ...challenge,
          parameters: { ...challenge.parameters, data: { scope: "magic_link" } },
        };
        yield* verifyWith("magic_link", encode(tampered, solution));
      }),
    );
    expect(reasonOf(exit)).toBe("invalid_signature");
  });

  test("a challenge signed with another key is rejected", async () => {
    const forged = await createChallenge({
      algorithm: "PBKDF2/SHA-256",
      cost: 1,
      keyPrefix: "0",
      deriveKey: derivePbkdf2,
      hmacSignatureSecret: "another-secret-0123456789",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      data: { scope: "sign_up" },
    });
    const exit = await run(verifyWith("sign_up", encode(forged, await solve(forged))));
    expect(reasonOf(exit)).toBe("invalid_signature");
  });

  test("an expired challenge is rejected", async () => {
    const expired = await createChallenge({
      algorithm: "PBKDF2/SHA-256",
      cost: 1,
      keyPrefix: "0",
      deriveKey: derivePbkdf2,
      hmacSignatureSecret: SECRET,
      expiresAt: Math.floor(Date.now() / 1000) - 10,
      data: { scope: "sign_up" },
    });
    const exit = await run(verifyWith("sign_up", encode(expired, await solve(expired))));
    expect(reasonOf(exit)).toBe("expired");
  });

  test("a wrong proof of work is rejected and not consumed", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const { challenge, solution } = yield* issueAndSolve("invitation_accept");
        const wrong = { ...solution, derivedKey: "f".repeat(solution.derivedKey.length) };
        const first = yield* Effect.exit(verifyWith("invitation_accept", encode(challenge, wrong)));
        // The failed attempt did not burn the challenge: the honest solution still passes.
        yield* verifyWith("invitation_accept", encode(challenge, solution));
        return first;
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(reasonOf(exit.value)).toBe("invalid_solution");
  });

  test("missing and malformed payloads are rejected", async () => {
    expect(reasonOf(await run(verifyWith("sign_up", "")))).toBe("missing");
    expect(reasonOf(await run(verifyWith("sign_up", "not base64 json")))).toBe("malformed");
    const noSolution = Buffer.from(JSON.stringify({ challenge: {} })).toString("base64");
    expect(reasonOf(await run(verifyWith("sign_up", noSolution)))).toBe("malformed");
    expect(reasonOf(await run(verifyWith("sign_up", "A".repeat(9000))))).toBe("malformed");
  });

  test("a challenge for another algorithm is rejected", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const { challenge, solution } = yield* issueAndSolve("sign_up");
        return encode(challenge, solution);
      }),
    );
    if (!Exit.isSuccess(exit)) throw new Error("issue failed");
    const argon = { ...fast, algorithm: "ARGON2ID" as const, memoryCost: 64 };
    expect(reasonOf(await run(verifyWith("sign_up", exit.value), argon))).toBe("malformed");
  });

  test("ARGON2ID challenges verify end to end", async () => {
    const { deriveKey } = await import("altcha-lib/algorithms/argon2id");
    const exit = await run(
      Effect.gen(function* () {
        const bp = yield* BotProtection;
        const challenge = yield* bp.issue("magic_link");
        expect(challenge.parameters.algorithm).toBe("ARGON2ID");
        const solution = yield* Effect.promise(() => solveChallenge({ challenge, deriveKey }));
        yield* bp.verify("magic_link", encode(challenge, solution));
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
        yield* verifyWith("sign_up", encode(challenge, solution));
      }).pipe(Effect.provide(Layer.provide(AltchaBotProtection(fast), layerFromPglite(broken)))),
    );
    await broken.close();
    expect(reasonOf(exit)).toBe("BotProtectionUnavailable");
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
        const now = new Date("2030-01-01T00:00:00Z");
        yield* consumeChallenge({
          digest: "purge-old",
          scope: "sign_up",
          expiresAt: new Date(now.getTime() - 1000),
        });
        yield* consumeChallenge({
          digest: "purge-live",
          scope: "sign_up",
          expiresAt: new Date(now.getTime() + 1000),
        });
        const deleted = yield* purgeExpiredChallenges(now);
        const sql = yield* SqlClient.SqlClient;
        const left = yield* sql<{ d: string }>`
          select challenge_digest as d from altcha_replays where challenge_digest like 'purge-%'`;
        return { deleted, left: left.map((r) => r.d) };
      }).pipe(Effect.provide(layerFromPglite(pg))),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.left).toEqual(["purge-live"]);
      expect(exit.value.deleted).toBeGreaterThanOrEqual(1);
    }
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
