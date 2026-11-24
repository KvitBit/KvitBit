/**
 * Translation of internal port failures to the shared `Unavailable` error (core-ports 3, 6), so
 * provider details never cross the seam.
 */
import type { UnavailableDependency } from "@kvitbit/domain/contract";
import { Unavailable } from "@kvitbit/domain/contract";
import { Effect } from "effect";

const DEPENDENCY = {
  StoreUnavailable: "database",
  RegistryUnavailable: "company_registry",
  RatesUnavailable: "exchange_rates",
  BlobUnavailable: "blob_storage",
} as const satisfies Record<string, UnavailableDependency>;

type PortFailure = { readonly _tag: keyof typeof DEPENDENCY };

const isPortFailure = (error: unknown): error is PortFailure =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  typeof error._tag === "string" &&
  Object.hasOwn(DEPENDENCY, error._tag);

/** The `Unavailable` a port failure becomes. */
export const toUnavailable = (error: PortFailure): Unavailable =>
  new Unavailable({ dependency: DEPENDENCY[error._tag] });

/** Maps every port failure in the error channel to `Unavailable`; other errors pass through. */
export const orUnavailable = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, PortFailure> | Unavailable, R> =>
  Effect.mapError(effect, (error) =>
    isPortFailure(error) ? toUnavailable(error) : (error as Exclude<E, PortFailure>),
  );
