/**
 * Write headers (ui-port-contracts section 2.3, AG-UI-1): one UUIDv7 `Idempotency-Key` per user
 * intent, minted on the first submit, reused on every retry, cleared on success, on edit, or when
 * the server reports `Conflict{idempotency_mismatch}`; `If-Match` carries the loaded revision.
 */
import { type EntityTag, entityTag, type IdempotencyKey } from "@kvitbit/api-contract";
import { Clock, Effect, Option, Random } from "effect";
import { describeError, type UiError } from "./errors";

const hex = (n: number, width: number): string => n.toString(16).padStart(width, "0");

/** RFC 9562 UUIDv7 from the Effect Clock and Random (deterministic under TestClock/seeded Random). */
export const uuidV7: Effect.Effect<string> = Effect.gen(function* () {
  const millis = yield* Clock.currentTimeMillis;
  const bytes: Array<number> = [];
  for (let i = 0; i < 10; i++) bytes.push(yield* Random.nextIntBetween(0, 255));
  const at = (i: number): number => bytes[i] ?? 0;
  const time = hex(Math.floor(millis) % 2 ** 48, 12);
  const randA = hex(0x7000 | (((at(0) << 8) | at(1)) & 0x0fff), 4);
  const randB = hex(0x8000 | (((at(2) << 8) | at(3)) & 0x3fff), 4);
  const tail = bytes
    .slice(4)
    .map((b) => hex(b, 2))
    .join("");
  return `${time.slice(0, 8)}-${time.slice(8)}-${randA}-${randB}-${tail}`;
});

/** The intent's key: the one already stored, else a fresh UUIDv7. */
export const ensureRequestKey = (
  current: Option.Option<IdempotencyKey>,
): Effect.Effect<IdempotencyKey> =>
  Option.isSome(current) ? Effect.succeed(current.value) : uuidV7;

/** What to keep after an attempt: cleared on success or on idempotency_mismatch, else reused. */
export const keyAfter = (
  current: Option.Option<IdempotencyKey>,
  outcome: { readonly _tag: "Ok" } | { readonly _tag: "Err"; readonly error: UiError },
): Option.Option<IdempotencyKey> =>
  outcome._tag === "Ok" || describeError(outcome.error).clearRequestKey ? Option.none() : current;

export const idempotencyHeaders = (
  key: IdempotencyKey,
): { readonly "idempotency-key": IdempotencyKey } => ({ "idempotency-key": key });

export const ifMatchHeaders = (revision: number): { readonly "if-match": EntityTag } => ({
  "if-match": entityTag(revision),
});
