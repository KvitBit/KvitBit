/**
 * Company registry access shared by `Workspaces.lookupCompany`, `Workspaces.create` (Issuing
 * Entity prefill) and `Contacts.fromIco` (core-ports W9, 4.2 invariants): the mod-11 IČO checksum
 * runs before any registry call, results (including "no record") are cached 24 hours per IČO in
 * process, and lookups are serialized, never fanned out in parallel. Nothing is persisted here.
 */

import type { RegistryResult, Unavailable } from "@kvitbit/domain/contract";
import { Invalid } from "@kvitbit/domain/contract";
import { CompanyRegistry } from "@kvitbit/domain/ports";
import * as EffectArray from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { orUnavailable } from "../../shared/errors";

/** Cache lifetime per IČO. */
const ICO_FORMAT = /^\d{8}$/;
export const REGISTRY_CACHE_TTL = Duration.hours(24);

/**
 * Czech IČO validity (adapted from Deskohub packages/ares): exactly eight digits and the check
 * digit `(11 − (weighted sum mod 11)) mod 10`, the first seven digits weighted 8 down to 2.
 */
export const isValidIco = (ico: string): boolean => {
  if (!ICO_FORMAT.test(ico)) return false;
  const digits = EffectArray.map(EffectArray.fromIterable(ico), Number);
  const weightedSum = EffectArray.reduce(
    digits.slice(0, 7),
    0,
    (sum, digit, index) => sum + digit * (8 - index),
  );
  return (11 - (weightedSum % 11)) % 10 === digits[7];
};

/** `Invalid{ico.checksum}` at `path` (default `["ico"]`). */
export const icoChecksumInvalid = (path: ReadonlyArray<string | number> = ["ico"]): Invalid =>
  Invalid.make({ issues: [{ path: [...path], code: "ico.checksum" }] });

/** Fails with `Invalid{ico.checksum}` unless `ico` passes the checksum. */
export const validateIco: {
  (path?: ReadonlyArray<string | number>): (ico: string) => Effect.Effect<void, Invalid>;
  (ico: string, path?: ReadonlyArray<string | number>): Effect.Effect<void, Invalid>;
} = Fn.dual(
  (args) => Predicate.isString(args[0]),
  (ico: string, path?: ReadonlyArray<string | number>): Effect.Effect<void, Invalid> =>
    isValidIco(ico) ? Effect.void : Effect.fail(icoChecksumInvalid(path)),
);

interface CacheEntry {
  readonly at: number;
  readonly result: RegistryResult | null;
}

export class RegistryLookup extends Context.Service<
  RegistryLookup,
  {
    /**
     * Checksum, then cache, then `CompanyRegistry.lookup`. `null` means the registry has no record
     * (each caller maps it to its own NotFound). Registry failure is `Unavailable{company_registry}`.
     */
    readonly lookup: (ico: string) => Effect.Effect<RegistryResult | null, Invalid | Unavailable>;
  }
>()("@kvitbit/core/modules/workspaces/registry/RegistryLookup") {
  /** One cache per layer instance; provide it once per process (requires `CompanyRegistry`). */
  static readonly layer: Layer.Layer<RegistryLookup, never, CompanyRegistry> = Layer.effect(
    RegistryLookup,
    Effect.gen(function* () {
      const registry = yield* CompanyRegistry;
      const cache = yield* Ref.make<ReadonlyMap<string, CacheEntry>>(new Map());
      const serial = yield* Semaphore.make(1);
      const ttl = Duration.toMillis(REGISTRY_CACHE_TTL);
      return {
        lookup: Effect.fn("RegistryLookup.lookup")(function* (ico: string) {
          yield* validateIco(ico);
          return yield* Semaphore.withPermit(
            serial,
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              const hit = (yield* Ref.get(cache)).get(ico);
              if (hit !== undefined && now - hit.at < ttl) return hit.result;
              const record = yield* orUnavailable(registry.lookup(ico));
              const result: RegistryResult | null = record === null ? null : { ico, ...record };
              yield* Ref.update(cache, (all) => new Map(all).set(ico, { at: now, result }));
              return result;
            }),
          );
        }),
      };
    }),
  );
}
