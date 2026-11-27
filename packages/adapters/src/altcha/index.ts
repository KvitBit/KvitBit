/**
 * Bot protection for the Better Auth endpoints that create accounts or send mail (ADR 0002,
 * core-ports section 6, http-mcp-contracts section 2.6).
 *
 * The adapter exports the `BotProtection` port and its internal errors for `apps/server`.
 * The edge maps `InvalidBotProof` to the HTTP `InvalidBotProof` (400) of
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
  type CreateChallengeOptions,
  createChallenge,
  type DeriveKeyFunction,
  verifySolution,
} from "altcha-lib";
import { deriveKey as deriveArgon2id } from "altcha-lib/algorithms/argon2id";
import { deriveKey as derivePbkdf2 } from "altcha-lib/algorithms/pbkdf2";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export type { BotScope } from "@kvitbit/api-contract";

/** What `issue` returns and the widget solves: an ALTCHA v2 challenge, JSON-serializable. */
export type BotChallenge = Challenge;

const InvalidBotProofReason = Schema.Literals([
  "missing",
  "malformed",
  "wrong_scope",
  "expired",
  "invalid_signature",
  "invalid_solution",
  "replayed",
]);

/** Why a proof was refused. Logged by the edge; the HTTP answer carries only the tag (B3). */
export type InvalidBotProofReason = typeof InvalidBotProofReason.Type;

/** The payload is missing, malformed, for another scope, expired, wrong, or already used. */
export class InvalidBotProof extends Schema.TaggedError<
  InvalidBotProof,
  { readonly brand: unique symbol }
>()("InvalidBotProof", {
  reason: InvalidBotProofReason,
}) {}

/** The replay store (or challenge signing) failed. Never fails open (rule B6). */
export class BotProtectionUnavailable extends Schema.TaggedError<
  BotProtectionUnavailable,
  { readonly brand: unique symbol }
>()("BotProtectionUnavailable", { cause: Schema.optional(Schema.Unknown) }) {}

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
>()(
  // @effect-diagnostics-next-line deterministicKeys:off Keep the documented edge port key.
  "kvitbit/edge/BotProtection",
) {}

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
 * Defaults. With prefix "0" the client derives 16 keys on average. The ADR 0002 solve-time
 * benchmark on mid-range Android devices is deferred to the mobile client work (apps/mobile
 * does not exist yet); until it runs these values are provisional, and `cost`, `memoryCost`
 * and `keyPrefix` are tuned together from its measurements.
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
  }).pipe(Effect.mapError((cause) => BotProtectionUnavailable.make({ cause })));

/**
 * Housekeeping: deletes replay rows whose challenge has expired (an expired challenge fails
 * verification anyway, so its row no longer guards anything). Returns the number deleted.
 */
export const purgeExpiredChallenges = (
  now?: Date,
): Effect.Effect<number, BotProtectionUnavailable, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const cutoff = now ?? (yield* DateTime.nowAsDate);
    const rows = yield* sql`
      delete from altcha_replays where expires_at < ${cutoff} returning challenge_digest`;
    return rows.length;
  }).pipe(Effect.mapError((cause) => BotProtectionUnavailable.make({ cause })));

// --- Payload decoding ------------------------------------------------------------------------

const ProofPayload = Schema.Struct({
  challenge: Schema.Struct({
    signature: Schema.String,
    parameters: Schema.Struct({
      algorithm: Schema.String,
      nonce: Schema.String,
      salt: Schema.String,
      cost: Schema.Finite,
      keyLength: Schema.Finite,
      keyPrefix: Schema.String,
      memoryCost: Schema.optionalKey(Schema.Finite),
      parallelism: Schema.optionalKey(Schema.Finite),
      expiresAt: Schema.Finite,
      data: Schema.optionalKey(
        Schema.Record(
          Schema.String,
          Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]),
        ),
      ),
    }),
  }),
  solution: Schema.Struct({ counter: Schema.Finite, derivedKey: Schema.String }),
});

// Verify the original signed parameters. A struct decode would drop extra fields before the HMAC check.
const decodePayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown.pipe(Schema.refine(Schema.is(ProofPayload)))),
);

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

    const issue = Effect.fn("BotProtection.issue")(function* (scope: BotScope) {
      const nowMs = yield* Clock.currentTimeMillis;
      const challengeOptions = {
        algorithm: settings.algorithm,
        cost: settings.cost,
        keyPrefix: settings.keyPrefix,
        deriveKey,
        hmacSignatureSecret: secret,
        expiresAt: Math.floor(nowMs / 1000) + settings.ttlSeconds,
        data: { scope },
      } satisfies CreateChallengeOptions;
      const signedOptions =
        settings.algorithm === "ARGON2ID"
          ? {
              ...challengeOptions,
              memoryCost: settings.memoryCost,
              parallelism: settings.parallelism,
            }
          : challengeOptions;
      return yield* Effect.tryPromise({
        try: () => createChallenge(signedOptions),
        catch: (cause) => BotProtectionUnavailable.make({ cause }),
      });
    });

    const verify = Effect.fn("BotProtection.verify")(function* (scope: BotScope, raw: string) {
      if (raw.length === 0) return yield* InvalidBotProof.make({ reason: "missing" });
      if (raw.length > ALTCHA_HEADER_MAX_LENGTH) {
        return yield* InvalidBotProof.make({ reason: "malformed" });
      }
      const { challenge, solution } = yield* decodePayload(
        Buffer.from(raw, "base64").toString("utf8"),
      ).pipe(Effect.mapError(() => InvalidBotProof.make({ reason: "malformed" })));
      // The algorithm is signed, but only the configured one is accepted, so a stale
      // challenge from a cheaper configuration cannot be replayed into a new one.
      if (challenge.parameters.algorithm !== settings.algorithm) {
        return yield* InvalidBotProof.make({ reason: "malformed" });
      }
      const result = yield* Effect.tryPromise({
        try: () => verifySolution({ challenge, solution, deriveKey, hmacSignatureSecret: secret }),
        // altcha-lib throws on parameters its KDF rejects: a malformed proof, not an outage.
        catch: () => InvalidBotProof.make({ reason: "malformed" }),
      });
      if (result.expired) return yield* InvalidBotProof.make({ reason: "expired" });
      if (result.invalidSignature !== false) {
        return yield* InvalidBotProof.make({ reason: "invalid_signature" });
      }
      if (!result.verified) return yield* InvalidBotProof.make({ reason: "invalid_solution" });
      // Signature verified: the scope and expiry below are the server's own.
      if (challenge.parameters.data?.scope !== scope) {
        return yield* InvalidBotProof.make({ reason: "wrong_scope" });
      }
      const expiresAtSeconds = challenge.parameters.expiresAt;
      const nowMs = yield* Clock.currentTimeMillis;
      if (expiresAtSeconds * 1000 <= nowMs) {
        return yield* InvalidBotProof.make({ reason: "expired" });
      }
      const fresh = yield* consumeChallenge({
        // The signature is an HMAC over parameters including a random nonce: unique per
        // challenge and unforgeable, so it is the single-use key.
        digest: challenge.signature,
        scope,
        expiresAt: DateTime.toDateUtc(DateTime.fromEpochSeconds(expiresAtSeconds)),
      }).pipe(withSql);
      if (!fresh) return yield* InvalidBotProof.make({ reason: "replayed" });
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
    issue: Effect.fn("BotProtection.issue")(() =>
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
    ),
    verify: Effect.fn("BotProtection.verify")(() => Effect.void),
  }),
);
