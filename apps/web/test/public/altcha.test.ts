import { expect, test } from "bun:test";
import { AltchaBotProtection, BotProtection } from "@kvitbit/adapters/altcha";
import { layerMigrated } from "@kvitbit/adapters/testing";
import { AltchaChallenge } from "@kvitbit/api-contract";
import { createChallenge, verifySolution } from "altcha-lib";
import { deriveKey as deriveSha } from "altcha-lib/algorithms/sha";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { WebServicesLive } from "../../src/app/api";
import { fetchAndSolveBotProof } from "../../src/page/public/_altcha";
import { solveAltchaChallenge } from "../../src/page/public/_altcha-solver";
import { mockWire } from "./wire";

test("an invalid worker reply falls back and interruption terminates a pending worker", async () => {
  let started = Promise.withResolvers<WorkerFixture>();
  class WorkerFixture {
    onmessage?: (event: MessageEvent) => void;
    terminated = false;

    postMessage() {
      started.resolve(this);
    }

    terminate() {
      this.terminated = true;
    }
  }
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: WorkerFixture });
  const fetch = mockWire(() =>
    Response.json({ parameters: { algorithm: "SHA-256", nonce: "00112233" } }),
  );
  const solve = fetchAndSolveBotProof("sign_in", (result) => result).pipe(
    Effect.provide(WebServicesLive),
  );
  try {
    const badReply = Effect.runFork(solve);
    const firstWorker = await started.promise;
    firstWorker.onmessage?.(new MessageEvent("message", { data: { header: 42 } }));
    expect(await badReply.pipe(Fiber.join, Effect.runPromise)).toMatchObject({
      _tag: "Solved",
      header: expect.any(String),
    });
    expect(firstWorker.terminated).toBe(true);

    started = Promise.withResolvers<WorkerFixture>();
    const interrupted = Effect.runFork(solve);
    const secondWorker = await started.promise;
    await interrupted.pipe(Fiber.interrupt, Effect.runPromise);
    expect(secondWorker.terminated).toBe(true);
  } finally {
    fetch.mockRestore();
    if (previousWorker === undefined) Reflect.deleteProperty(globalThis, "Worker");
    else Object.defineProperty(globalThis, "Worker", previousWorker);
  }
});

const hmacSignatureSecret = "web-altcha-test-only-signer";
const hmacKey = Redacted.make(hmacSignatureSecret);
const asChallenge = Schema.decodeUnknownEffect(AltchaChallenge);

test.each(["ARGON2ID", "PBKDF2/SHA-256"] as const)(
  "the bot protection adapter verifies %s, enforces scope, and rejects replay",
  async (algorithm) => {
    const program = Effect.gen(function* () {
      const protection = yield* BotProtection;
      const challenge =
        algorithm === "ARGON2ID" ? defaultArgon2id : yield* protection.issue("sign_up");
      const proof = yield* asChallenge(challenge).pipe(Effect.flatMap(solveAltchaChallenge));
      const mismatch = yield* Effect.flip(protection.verify("sign_in", proof));
      expect(mismatch).toMatchObject({ _tag: "InvalidBotProof", reason: "wrong_scope" });
      yield* protection.verify("sign_up", proof);
      const replay = yield* Effect.flip(protection.verify("sign_up", proof));
      expect(replay).toMatchObject({ _tag: "InvalidBotProof", reason: "replayed" });
    });
    await Effect.runPromise(
      program.pipe(
        Effect.provide(Layer.provide(AltchaBotProtection({ hmacKey, algorithm }), layerMigrated)),
      ),
    );
  },
  60_000,
);

test("altcha-lib verifies the SHA-256 proof from the browser solver", async () => {
  const challenge = await createChallenge({
    algorithm: "SHA-256",
    cost: 2,
    keyPrefix: "0",
    deriveKey: deriveSha,
    hmacSignatureSecret,
  });
  const header = await asChallenge(challenge).pipe(
    Effect.flatMap(solveAltchaChallenge),
    Effect.runPromise,
  );
  const proof = Schema.fromJsonString(
    Schema.Struct({
      solution: Schema.Struct({ counter: Schema.Int, derivedKey: Schema.String, time: Schema.Int }),
    }),
  );
  const { solution } = await Schema.decodeEffect(proof)(
    Buffer.from(header, "base64").toString("utf8"),
  ).pipe(Effect.runPromise);
  expect(
    await verifySolution({ challenge, solution, deriveKey: deriveSha, hmacSignatureSecret }),
  ).toMatchObject({
    verified: true,
  });
});

// A frozen challenge keeps this real default-cost compatibility check repeatable.
const defaultArgon2id = {
  parameters: {
    algorithm: "ARGON2ID",
    cost: 2,
    data: { scope: "sign_up" },
    expiresAt: 4_102_444_800,
    keyLength: 32,
    keyPrefix: "0",
    memoryCost: 19_456,
    nonce: "7407d6a4c7e62682432eabaccc103c74",
    parallelism: 1,
    salt: "ecf173ac326d6604dd54b6a31ba04d7e",
  },
  signature: "7e6804b169fe2d40f759832e084f51a398ba9bcd3fb8b06d91584ec4f9cf635e",
};
