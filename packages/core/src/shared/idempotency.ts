/**
 * Request-key retry safety (rule C3). Run the policy check first (rule R1a), then wrap the
 * method body:
 *
 *   yield* authorizeInWorkspace(caller, "document.draft")
 *   return yield* withIdempotency({ scope, key: opts?.requestKey, method: "Documents.createDraft",
 *     payload: { schema: DocumentInput, value: input }, result: DocumentView }, body)
 */

import type { RequestKey } from "@kvitbit/domain/contract";
import { Conflict } from "@kvitbit/domain/contract";
import { RequestOutcome } from "@kvitbit/domain/ports";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { RequestScope, StoreUnavailable } from "../store/CoreStore";
import { CoreStore } from "../store/CoreStore";
import { canonicalJson } from "./canonicalJson";
import { sha256Hex } from "./hash";

/** How long a request key is remembered. */
export const REQUEST_KEY_TTL_MILLIS = 24 * 60 * 60 * 1000;

export interface IdempotencyOptions<A, P> {
  readonly scope: RequestScope;
  /** Absent: the body runs in a plain transaction with no replay protection. */
  readonly key: RequestKey | undefined;
  /** Stable method name, e.g. `"Documents.createDraft"`; a different method is a mismatch. */
  readonly method: string;
  /** The request payload and its schema; its canonical JSON encoding is fingerprinted. */
  readonly payload: { readonly schema: Schema.Codec<P, unknown>; readonly value: P };
  /** Schema of the success value; stored as its canonical JSON encoding, decoded on replay. */
  readonly result: Schema.Codec<A, unknown>;
}

const fingerprintOf = <P>(method: string, encodedPayload: P) =>
  sha256Hex(canonicalJson([method, encodedPayload]));

/**
 * Runs `body` in one transaction with its request-log row, claiming the key first so a
 * concurrent duplicate waits and then replays instead of running the mutation again. A live
 * entry with the same method and payload returns the stored result (and marks the request
 * replayed when a `RequestOutcome` is provided); a different method or payload fails with
 * `Conflict{idempotency_mismatch}`. Only successes are stored, so a failed attempt can retry.
 * Must be the outermost transaction of the method (the claim precedes every row lock); the
 * payload must carry every input that shapes the result (target ids, options). The caller gets
 * exactly what is stored, first time and on replay alike: never enrich a result after the body.
 */
export const withIdempotency: {
  <A, E, R>(
    body: Effect.Effect<A, E, R>,
  ): <P>(
    options: IdempotencyOptions<A, P>,
  ) => Effect.Effect<A, E | Conflict | StoreUnavailable, R | CoreStore>;
  <A, P, E, R>(
    options: IdempotencyOptions<A, P>,
    body: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Conflict | StoreUnavailable, R | CoreStore>;
} = Fn.dual(
  2,
  Effect.fnUntraced(function* <A, P, E, R>(
    options: IdempotencyOptions<A, P>,
    body: Effect.Effect<A, E, R>,
  ) {
    const store = yield* CoreStore;
    const key = options.key;
    if (key === undefined) return yield* store.transaction(body);
    const encodedPayload = yield* Schema.encodeUnknownEffect(
      Schema.toCodecJson(options.payload.schema),
    )(options.payload.value).pipe(Effect.orDie);
    const fingerprint = yield* fingerprintOf(options.method, encodedPayload);
    const resultJson = Schema.toCodecJson(options.result);

    return yield* store.transaction(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const nowIso = DateTime.formatIso(DateTime.makeUnsafe(now));
        const claim = yield* store.requestLog.claim(options.scope, key, nowIso);
        if (claim._tag === "Existing") {
          const entry = claim.entry;
          if (entry.method !== options.method || entry.fingerprint !== fingerprint) {
            return yield* Conflict.make({ reason: "idempotency_mismatch" });
          }
          // A stored result that no longer decodes is a bug, never a miss.
          const replayed = yield* Schema.decodeUnknownEffect(resultJson)(entry.result).pipe(
            Effect.orDie,
          );
          const outcome = yield* Effect.serviceOption(RequestOutcome);
          if (Option.isSome(outcome)) yield* outcome.value.markReplayed;
          return replayed;
        }
        const result = yield* body;
        const encoded = yield* Schema.encodeUnknownEffect(resultJson)(result).pipe(Effect.orDie);
        yield* store.requestLog.complete({
          scope: options.scope,
          key,
          method: options.method,
          fingerprint,
          result: encoded,
          createdAt: nowIso,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + REQUEST_KEY_TTL_MILLIS)),
        });
        return result;
      }),
    );
  }),
);
