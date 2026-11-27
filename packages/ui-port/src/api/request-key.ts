/**
 * Write headers (ui-port-contracts section 2.3, AG-UI-1): one UUIDv7 `Idempotency-Key` per user
 * intent, minted on the first submit, reused on every retry, cleared on success, on edit, or when
 * the server reports `Conflict{idempotency_mismatch}`; `If-Match` carries the loaded revision.
 */

import { type EntityTag, entityTag, type IdempotencyKey } from "@kvitbit/api-contract";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Str from "effect/String";

import { describeError, type UiError } from "./errors";

const hex = (n: number, width: number): string => Fn.pipe(n.toString(16), Str.padStart(width, "0"));

/** RFC 9562 UUIDv7 from the Effect Clock and Random (deterministic under TestClock/seeded Random). */
export const uuidV7: Effect.Effect<string> = Effect.gen(function* () {
  const millis = yield* Clock.currentTimeMillis;
  const bytes: Array<number> = [];
  for (let i = 0; i < 10; i++) {
    const byte = yield* Random.nextIntBetween(0, 255);
    bytes.push(byte);
  }
  const at = (i: number): number => bytes[i] ?? 0;
  const time = hex(Math.floor(millis) % 2 ** 48, 12);
  const randA = hex(0x7000 | (((at(0) << 8) | at(1)) & 0x0fff), 4);
  const randB = hex(0x8000 | (((at(2) << 8) | at(3)) & 0x3fff), 4);
  const tail = Arr.join(
    Arr.map(bytes.slice(4), (b) => hex(b, 2)),
    "",
  );
  return `${Fn.pipe(time, Str.slice(0, 8))}-${Fn.pipe(time, Str.slice(8))}-${randA}-${randB}-${tail}`;
});

/** The intent's key: the one already stored, else a fresh UUIDv7. */
export const ensureRequestKey = (
  current: Option.Option<IdempotencyKey>,
): Effect.Effect<IdempotencyKey> =>
  Option.isSome(current) ? Effect.succeed(current.value) : uuidV7;

/** What to keep after an attempt: cleared on success or on idempotency_mismatch, else reused. */
export const keyAfter: {
  (
    outcome: { readonly _tag: "Ok" } | { readonly _tag: "Err"; readonly error: UiError },
  ): (current: Option.Option<IdempotencyKey>) => Option.Option<IdempotencyKey>;
  (
    current: Option.Option<IdempotencyKey>,
    outcome: { readonly _tag: "Ok" } | { readonly _tag: "Err"; readonly error: UiError },
  ): Option.Option<IdempotencyKey>;
} = Fn.dual(
  2,
  (
    current: Option.Option<IdempotencyKey>,
    outcome: { readonly _tag: "Ok" } | { readonly _tag: "Err"; readonly error: UiError },
  ): Option.Option<IdempotencyKey> =>
    outcome._tag === "Ok" || describeError(outcome.error).clearRequestKey ? Option.none() : current,
);

export const idempotencyHeaders = (
  key: IdempotencyKey,
): { readonly "idempotency-key": IdempotencyKey } => ({ "idempotency-key": key });

export const ifMatchHeaders = (revision: number): { readonly "if-match": EntityTag } => ({
  "if-match": entityTag(revision),
});
