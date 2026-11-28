/**
 * FakeCompanyRegistry: in-memory CompanyRegistry for tests and local development.
 * The control service lets a test add or remove records, simulate an outage, and read the
 * lookups the fake received (to check caching and no-fan-out rules).
 */

import { IsoDate } from "@kvitbit/domain";
import { CompanyRegistry, type RegistryRecord, RegistryUnavailable } from "@kvitbit/domain/ports";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Rec from "effect/Record";
import * as Ref from "effect/Ref";

export type FakeRegistryRecords = Readonly<Record<string, RegistryRecord>>;

export interface FakeCompanyRegistryOptions {
  /** Records keyed by IČO. Default: `defaultFakeRecords`. */
  readonly records?: FakeRegistryRecords;
  /** Start with every lookup failing with RegistryUnavailable. Default false. */
  readonly unavailable?: boolean;
}

export class FakeCompanyRegistryControl extends Context.Service<
  FakeCompanyRegistryControl,
  {
    readonly put: (ico: string, record: RegistryRecord) => Effect.Effect<void>;
    readonly remove: (ico: string) => Effect.Effect<void>;
    /** While true, every lookup fails with RegistryUnavailable (and is still recorded). */
    readonly setUnavailable: (unavailable: boolean) => Effect.Effect<void>;
    /** IČOs passed to lookup, in call order. */
    readonly lookups: Effect.Effect<ReadonlyArray<string>>;
  }
>()("@kvitbit/adapters/registry/fake/FakeCompanyRegistryControl") {}

/** Synthetic companies; the IČOs pass the mod-11 checksum. */
export const defaultFakeRecords: FakeRegistryRecords = {
  // VAT-registered s.r.o. with a commercial register entry.
  "10047514": {
    name: "Testovací Obchod s.r.o.",
    address: { street: "Na Florenci 2116/15", city: "Praha", postalCode: "11000", country: "CZ" },
    dic: "CZ10047514",
    legalForm: "112",
    registerEntry: "C 123456/MSPH",
    terminatedOn: null,
  },
  // Sole trader without DIČ or register entry.
  "10079190": {
    name: "Jana Ukázková",
    address: { street: "Masarykova 12", city: "Brno", postalCode: "60200", country: "CZ" },
    dic: null,
    legalForm: "101",
    registerEntry: null,
    terminatedOn: null,
  },
  // Dissolved company.
  "10087109": {
    name: "Zaniklá Firma a.s. v likvidaci",
    address: { street: "Dlouhá 5", city: "Ostrava", postalCode: "70200", country: "CZ" },
    dic: "CZ10087109",
    legalForm: "121",
    registerEntry: "B 9876/KSOS",
    terminatedOn: IsoDate.make("2024-06-30"),
  },
};

const build = Effect.fn("build")(function* (options: FakeCompanyRegistryOptions) {
  const records = yield* Ref.make<ReadonlyMap<string, RegistryRecord>>(
    new Map(Rec.toEntries(options.records ?? defaultFakeRecords)),
  );
  const unavailable = yield* Ref.make(options.unavailable ?? false);
  const lookups = yield* Ref.make<ReadonlyArray<string>>([]);

  const registry = CompanyRegistry.of({
    lookup: Effect.fn("CompanyRegistry.lookup")(function* (ico) {
      yield* Ref.update(lookups, (seen) => [...seen, ico]);
      if (yield* Ref.get(unavailable)) {
        return yield* RegistryUnavailable.make({ cause: "FakeCompanyRegistry: unavailable" });
      }
      return (yield* Ref.get(records)).get(ico) ?? null;
    }),
  });

  const control = FakeCompanyRegistryControl.of({
    put: Effect.fn("registry.put")((ico, record) =>
      Ref.update(records, (map) => new Map(map).set(ico, record)),
    ),
    remove: Effect.fn("registry.remove")((ico) =>
      Ref.update(records, (map) => {
        const next = new Map(map);
        next.delete(ico);
        return next;
      }),
    ),
    setUnavailable: Effect.fn("registry.outage")((value) => Ref.set(unavailable, value)),
    lookups: Ref.get(lookups),
  });

  return Context.make(CompanyRegistry, registry).pipe(
    Context.add(FakeCompanyRegistryControl, control),
  );
});

/** Fake registry plus its control service, with the given records and outage state. */
export const layerWith = (
  options: FakeCompanyRegistryOptions = {},
): Layer.Layer<CompanyRegistry | FakeCompanyRegistryControl> => Layer.effectContext(build(options));

/** Fake registry seeded with `defaultFakeRecords`. */
export const layer: Layer.Layer<CompanyRegistry | FakeCompanyRegistryControl> = layerWith();
