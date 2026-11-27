import { expect, test } from "bun:test";
import { AltchaChallenge } from "@kvitbit/api-contract";
import { createChallenge, type Payload, verifySolution } from "altcha-lib";
import { deriveKey as deriveSha } from "altcha-lib/algorithms/sha";
import { Effect, Layer, Redacted, Schema } from "effect";
import { AltchaBotProtection, BotProtection } from "../../../../packages/adapters/src/altcha";
import { layerMigrated } from "../../../../packages/adapters/src/testing";
import { solveAltchaChallenge } from "../../src/page/public/_altcha-solver";

const hmacSignatureSecret = "web-altcha-test-only-signer";
const hmacKey = Redacted.make(hmacSignatureSecret);
const asChallenge = Schema.decodeUnknownSync(AltchaChallenge);

test.each(["ARGON2ID", "PBKDF2/SHA-256"] as const)(
  "the bot protection adapter verifies %s, enforces scope, and rejects replay",
  async (algorithm) => {
    const program = Effect.gen(function* () {
      const protection = yield* BotProtection;
      const challenge =
        algorithm === "ARGON2ID" ? defaultArgon2id : yield* protection.issue("sign_up");
      const proof = yield* Effect.promise(() => solveAltchaChallenge(asChallenge(challenge)));
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
  const header = await solveAltchaChallenge(asChallenge(challenge));
  const payload: Payload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  expect(
    await verifySolution({ ...payload, deriveKey: deriveSha, hmacSignatureSecret }),
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
