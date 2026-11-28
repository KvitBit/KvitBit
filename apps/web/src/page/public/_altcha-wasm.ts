import { argon2id } from "hash-wasm";
import type { Argon2idParams } from "./_altcha_kdf";

export const deriveArgon2id = ({
  password,
  salt,
  params: { memoryCost, cost, parallelism, keyLength },
}: {
  readonly password: Uint8Array;
  readonly salt: Uint8Array;
  readonly params: Argon2idParams;
}) =>
  argon2id({
    password,
    salt,
    memorySize: memoryCost,
    iterations: cost,
    parallelism,
    hashLength: keyLength,
    outputType: "binary",
  });
