import { argon2id } from "hash-wasm";
import type { Argon2idParams } from "./_altcha_kdf";

export const deriveArgon2id = (
  password: Uint8Array,
  salt: Uint8Array,
  { memoryCost, cost, parallelism, keyLength }: Argon2idParams,
) =>
  argon2id({
    password,
    salt,
    memorySize: memoryCost,
    iterations: cost,
    parallelism,
    hashLength: keyLength,
    outputType: "binary",
  });
