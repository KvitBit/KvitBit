import { expect, test } from "bun:test";
import { AltchaChallenge } from "@kvitbit/api-contract";
import { Effect, Layer, Redacted, Schema } from "effect";
import { AltchaBotProtection, BotProtection } from "../../../../packages/adapters/src/altcha";
import { layerMigrated } from "../../../../packages/adapters/src/testing";
import { solveAltchaChallenge } from "../../src/page/public/_altcha-solver";

test("the frozen verifier accepts the browser's proof for a signed default Argon2id challenge", async () => {
  const challenge = Schema.decodeUnknownSync(AltchaChallenge)({
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
  });
  const proof = await solveAltchaChallenge(challenge);
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
}, 20_000);
