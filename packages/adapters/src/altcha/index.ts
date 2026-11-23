/**
 * Bot protection for the Better Auth endpoints that create accounts or send mail (ADR 0002,
 * core-ports section 6, http-mcp-contracts section 2.6).
 *
 * The spec places the `BotProtection` port in `apps/server/src/edge/BotProtection.ts`. That app
 * does not exist yet, so the port (tag `kvitbit/edge/BotProtection`) and its errors live here
 * next to the adapters; apps/server re-exports them. Port errors are internal
 * `Data.TaggedError`s: the edge maps `InvalidBotProof` to the HTTP `InvalidBotProof` (400) of
 * `@kvitbit/api-contract` and `BotProtectionUnavailable` to `503 Unavailable` (rules B3, B6).
 *
 * Adapters:
 * - `AltchaBotProtection`: ALTCHA PoW v2 (`altcha-lib`). Challenges are HMAC-signed, expire,
 *   and carry the scope in their signed `data`, so a challenge issued for one scope fails on
 *   another (rule B1). `verify` checks HMAC, proof of work and expiry, then consumes the
 *   challenge once with an atomic insert into `altcha_replays` (rule B2).
 * - `NoopBotProtection`: self-host opt-out and tests; accepts every payload.
 */
import { ALTCHA_HEADER_MAX_LENGTH, type BotScope } from "@kvitbit/api-contract";
import {
  type Challenge,
  createChallenge,
  type DeriveKeyFunction,
  type Payload,
  verifySolution,
} from "altcha-lib";
import { deriveKey as deriveArgon2id } from "altcha-lib/algorithms/argon2id";
import { deriveKey as derivePbkdf2 } from "altcha-lib/algorithms/pbkdf2";
import { Clock, Config, Context, Data, Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";

export type { BotScope } from "@kvitbit/api-contract";

/** What `issue` returns and the widget solves: an ALTCHA v2 challenge, JSON-serializable. */
export type BotChallenge = Challenge;

/** Why a proof was refused. Logged by the edge; the HTTP answer carries only the tag (B3). */
export type InvalidBotProofReason =
  | "missing"
  | "malformed"
  | "wrong_scope"
  | "expired"
  | "invalid_signature"
  | "invalid_solution"
  | "replayed";

/** The payload is missing, malformed, for another scope, expired, wrong, or already used. */
export class InvalidBotProof extends Data.TaggedError("InvalidBotProof")<{
  readonly reason: InvalidBotProofReason;
}> {}

/** The replay store (or challenge signing) failed. Never fails open (rule B6). */
export class BotProtectionUnavailable extends Data.TaggedError("BotProtectionUnavailable")<{
  readonly cause?: unknown;
}> {}

/** Edge-only port. The route picks the scope; it is never read from client input. */
export class BotProtection extends Context.Service<
  BotProtection,
  {
    readonly issue: (scope: BotScope) => Effect.Effect<BotChallenge, BotProtectionUnavailable>;
    /**
     * Checks HMAC, proof of work and expiry, then consumes the challenge once (atomic Postgres
     * insert). `payload` is the raw `X-Altcha` header: base64 of `{ challenge, solution }`.
     */
    readonly verify: (
      scope: BotScope,
      payload: string,
    ) => Effect.Effect<void, InvalidBotProof | BotProtectionUnavailable>;
  }
>()("kvitbit/edge/BotProtection") {}

// --- Options ---------------------------------------------------------------------------------

/** Key derivation for the proof of work. ARGON2ID is the ADR 0002 preference. */
export type AltchaAlgorithm = "ARGON2ID" | "PBKDF2/SHA-256";

export interface AltchaOptions {
  /** HMAC secret that signs challenges. */
  readonly hmacKey: Redacted.Redacted<string>;
  /** Challenge lifetime. Defaults to 5 minutes. */
  readonly ttlSeconds?: number;
  readonly algorithm?: AltchaAlgorithm;
  /** KDF iterations (Argon2id time cost, PBKDF2 iterations). */
  readonly cost?: number;
  /** Argon2id memory in KiB. Ignored for PBKDF2. */
  readonly memoryCost?: number;
  readonly parallelism?: number;
  /** Hex prefix the derived key must start with; each hex digit multiplies the work by 16. */
  readonly keyPrefix?: string;
}

/**
 * Defaults. Not yet benchmarked on mid-range Android devices (ADR 0002 consequence): tune
 * `cost`, `memoryCost` and `keyPrefix` together once measured. With prefix "0" the client
 * derives 16 keys on average.
 */
export const ALTCHA_DEFAULTS = {
  ttlSeconds: 300,
  algorithm: "ARGON2ID",
  cost: 2,
  memoryCost: 19_456,
  parallelism: 1,
  keyPrefix: "0",
} as const satisfies Required<Omit<AltchaOptions, "hmacKey">>;

const deriveKeyFor = (algorithm: AltchaAlgorithm): DeriveKeyFunction =>
  algorithm === "ARGON2ID" ? deriveArgon2id : derivePbkdf2;

// --- Replay store ----------------------------------------------------------------------------

/**
 * Consumes a challenge: `INSERT ... ON CONFLICT DO NOTHING RETURNING`. True on first use, false
 * when the digest is already stored (a replay).
 */
export const consumeChallenge = (input: {
  readonly digest: string;
  readonly scope: BotScope;
  readonly expiresAt: Date;
}): Effect.Effect<boolean, BotProtectionUnavailable, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`
      insert into altcha_replays (challenge_digest, scope, expires_at)
      values (${input.digest}, ${input.scope}::bot_scope, ${input.expiresAt})
      on conflict (challenge_digest) do nothing
      returning challenge_digest`;
    return rows.length === 1;
  }).pipe(Effect.mapError((cause) => new BotProtectionUnavailable({ cause })));

/**
 * Housekeeping: deletes replay rows whose challenge has expired (an expired challenge fails
 * verification anyway, so its row no longer guards anything). Returns the number deleted.
 */
export const purgeExpiredChallenges = (
  now?: Date,
): Effect.Effect<number, BotProtectionUnavailable, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const cutoff = now ?? new Date(yield* Clock.currentTimeMillis);
    const rows = yield* sql`
      delete from altcha_replays where expires_at < ${cutoff} returning challenge_digest`;
    return rows.length;
  }).pipe(Effect.mapError((cause) => new BotProtectionUnavailable({ cause })));

// --- Payload decoding ------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Base64 JSON `{ challenge, solution }` with the fields `verifySolution` reads. */
const decodePayload = (raw: string): Payload | undefined => {
  if (raw.length > ALTCHA_HEADER_MAX_LENGTH) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.challenge) || !isRecord(parsed.solution)) {
    return undefined;
  }
  const { challenge, solution } = parsed;
  const parameters = challenge.parameters;
  if (
    !isRecord(parameters) ||
    typeof challenge.signature !== "string" ||
    typeof parameters.expiresAt !== "number" ||
    typeof solution.counter !== "number" ||
    typeof solution.derivedKey !== "string"
  ) {
    return undefined;
  }
  return parsed as unknown as Payload;
};

// --- Adapters --------------------------------------------------------------------------------

/** Builds the ALTCHA adapter over the `altcha_replays` store of the given `SqlClient`. */
export const makeAltchaBotProtection = (
  options: AltchaOptions,
): Effect.Effect<BotProtection["Service"], never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const settings = { ...ALTCHA_DEFAULTS, ...options };
    const secret = Redacted.value(settings.hmacKey);
    const deriveKey = deriveKeyFor(settings.algorithm);
    const withSql = Effect.provideService(SqlClient.SqlClient, sql);

    const issue = (scope: BotScope) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        return yield* Effect.tryPromise({
          try: () =>
            createChallenge({
              algorithm: settings.algorithm,
              cost: settings.cost,
              ...(settings.algorithm === "ARGON2ID"
                ? { memoryCost: settings.memoryCost, parallelism: settings.parallelism }
                : {}),
              keyPrefix: settings.keyPrefix,
              deriveKey,
              hmacSignatureSecret: secret,
              expiresAt: Math.floor(nowMs / 1000) + settings.ttlSeconds,
              data: { scope },
            }),
          catch: (cause) => new BotProtectionUnavailable({ cause }),
        });
      });

    const verify = (scope: BotScope, raw: string) =>
      Effect.gen(function* () {
        if (raw.length === 0) return yield* new InvalidBotProof({ reason: "missing" });
        const payload = decodePayload(raw);
        if (payload === undefined) return yield* new InvalidBotProof({ reason: "malformed" });
        const { challenge, solution } = payload;
        // The algorithm is signed, but only the configured one is accepted, so a stale
        // challenge from a cheaper configuration cannot be replayed into a new one.
        if (challenge.parameters.algorithm !== settings.algorithm) {
          return yield* new InvalidBotProof({ reason: "malformed" });
        }
        const result = yield* Effect.tryPromise({
          try: () =>
            verifySolution({ challenge, solution, deriveKey, hmacSignatureSecret: secret }),
          // altcha-lib throws on parameters its KDF rejects: a malformed proof, not an outage.
          catch: () => new InvalidBotProof({ reason: "malformed" }),
        });
        if (result.expired) return yield* new InvalidBotProof({ reason: "expired" });
        if (result.invalidSignature !== false) {
          return yield* new InvalidBotProof({ reason: "invalid_signature" });
        }
        if (!result.verified) return yield* new InvalidBotProof({ reason: "invalid_solution" });
        // Signature verified: the scope and expiry below are the server's own.
        if (challenge.parameters.data?.scope !== scope) {
          return yield* new InvalidBotProof({ reason: "wrong_scope" });
        }
        const expiresAtSeconds = challenge.parameters.expiresAt ?? 0;
        const nowMs = yield* Clock.currentTimeMillis;
        if (expiresAtSeconds * 1000 <= nowMs) {
          return yield* new InvalidBotProof({ reason: "expired" });
        }
        const fresh = yield* consumeChallenge({
          // The signature is an HMAC over parameters including a random nonce: unique per
          // challenge and unforgeable, so it is the single-use key.
          digest: challenge.signature ?? "",
          scope,
          expiresAt: new Date(expiresAtSeconds * 1000),
        }).pipe(withSql);
        if (!fresh) return yield* new InvalidBotProof({ reason: "replayed" });
      });

    return BotProtection.of({ issue, verify });
  });

/** `AltchaBotProtection` with explicit options. */
export const AltchaBotProtection = (
  options: AltchaOptions,
): Layer.Layer<BotProtection, never, SqlClient.SqlClient> =>
  Layer.effect(BotProtection, makeAltchaBotProtection(options));

/** `AltchaBotProtection` with the HMAC key from `ALTCHA_HMAC_KEY`. */
export const AltchaBotProtectionConfig = (
  options: Omit<AltchaOptions, "hmacKey"> = {},
): Layer.Layer<BotProtection, Config.ConfigError, SqlClient.SqlClient> =>
  Layer.effect(
    BotProtection,
    Effect.gen(function* () {
      const hmacKey = yield* Config.Redacted("ALTCHA_HMAC_KEY");
      return yield* makeAltchaBotProtection({ ...options, hmacKey });
    }),
  );

/**
 * Self-host opt-out and tests. `issue` returns an empty challenge the edge never sends (it
 * answers 204 for Noop installs); `verify` accepts every payload.
 */
export const NoopBotProtection: Layer.Layer<BotProtection> = Layer.succeed(
  BotProtection,
  BotProtection.of({
    issue: () =>
      Effect.succeed({
        parameters: {
          algorithm: "NONE",
          nonce: "",
          salt: "",
          cost: 0,
          keyLength: 0,
          keyPrefix: "",
        },
      }),
    verify: () => Effect.void,
  }),
);
