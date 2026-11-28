import { expect, test } from "bun:test";
import { AltchaBotProtection, BotProtection } from "@kvitbit/adapters/altcha";
import { layerMigrated } from "@kvitbit/adapters/testing";
import { AltchaChallenge } from "@kvitbit/api-contract";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { WebServicesLive } from "../../src/app/api";
import { fetchAndSolveBotProof } from "../../src/page/public/_altcha";
import { solveAltchaChallenge } from "../../src/page/public/_altcha-solver";
import { mockWire } from "./wire";

test("an invalid worker reply fails the solve and interruption terminates a pending worker", async () => {
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
  const fetch = mockWire(() => Response.json({ parameters: { nonce: "00112233" } }));
  const solve = fetchAndSolveBotProof("sign_in", (result) => result).pipe(
    Effect.provide(WebServicesLive),
  );
  try {
    const badReply = Effect.runFork(solve);
    const firstWorker = await started.promise;
    firstWorker.onmessage?.(new MessageEvent("message", { data: { header: 42 } }));
    expect(await badReply.pipe(Fiber.join, Effect.runPromise)).toEqual({
      _tag: "Failed",
      reason: "Invalid verification worker reply",
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

test("the frozen verifier accepts the browser's proof for a signed default Argon2id challenge", async () => {
  const challenge = Effect.runSync(
    Schema.decodeEffect(AltchaChallenge)({
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
    }),
  );
  const proof = await Effect.runPromise(solveAltchaChallenge(challenge));
  const program = Effect.gen(function* () {
    const protection = yield* BotProtection;
    const mismatch = yield* Effect.flip(protection.verify("sign_in", proof));
    expect(mismatch).toMatchObject({ _tag: "InvalidBotProof", reason: "wrong_scope" });
    yield* protection.verify("sign_up", proof);
    const replay = yield* Effect.flip(protection.verify("sign_up", proof));
    expect(replay).toMatchObject({ _tag: "InvalidBotProof", reason: "replayed" });
  });
  await Effect.runPromise(
    program.pipe(
      Effect.provide(
        Layer.provide(
          AltchaBotProtection({ hmacKey: Redacted.make("web-altcha-test-only-signer") }),
          layerMigrated,
        ),
      ),
    ),
  );
}, 60_000);
