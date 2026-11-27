/**
 * Translation of internal port failures to the shared `Unavailable` error (core-ports 3, 6), so
 * provider details never cross the seam.
 */

import type { UnavailableDependency } from "@kvitbit/domain/contract";
import { Unavailable } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as EffectRecord from "effect/Record";

const DEPENDENCY = {
  StoreUnavailable: "database",
  RegistryUnavailable: "company_registry",
  RatesUnavailable: "exchange_rates",
  BlobUnavailable: "blob_storage",
} as const satisfies Record<string, UnavailableDependency>;

interface PortFailure {
  readonly _tag: keyof typeof DEPENDENCY;
}

const isPortFailure = <E>(error: E): error is E & PortFailure =>
  Predicate.hasProperty(error, "_tag") &&
  Predicate.isString(error._tag) &&
  EffectRecord.has<string, UnavailableDependency>(DEPENDENCY, error._tag);

/** The `Unavailable` a port failure becomes. */
const toUnavailable = (error: PortFailure): Unavailable =>
  Unavailable.make({ dependency: DEPENDENCY[error._tag] });

/** Maps every port failure in the error channel to `Unavailable`; other errors pass through. */
export function orUnavailable<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, PortFailure> | Unavailable, R>;
export function orUnavailable<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Unavailable, R> {
  return Effect.mapError(effect, (error) => (isPortFailure(error) ? toUnavailable(error) : error));
}
