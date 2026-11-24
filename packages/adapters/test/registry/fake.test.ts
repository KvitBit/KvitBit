import { describe, expect, test } from "bun:test";
import { CompanyRegistry, type RegistryRecord, RegistryUnavailable } from "@kvitbit/domain/ports";
import { Effect, type Layer } from "effect";
import { FakeCompanyRegistry, FakeCompanyRegistryControl } from "../../src/registry";

const run = <A, E>(
  program: Effect.Effect<A, E, CompanyRegistry | FakeCompanyRegistryControl>,
  layer: Layer.Layer<CompanyRegistry | FakeCompanyRegistryControl> = FakeCompanyRegistry.layer,
) => Effect.runPromise(program.pipe(Effect.provide(layer)));

const lookup = (ico: string) =>
  Effect.gen(function* () {
    const registry = yield* CompanyRegistry;
    return yield* registry.lookup(ico);
  });

const record: RegistryRecord = {
  name: "Nová Firma s.r.o.",
  address: { street: "Krátká 1", city: "Olomouc", postalCode: "77900", country: "CZ" },
  dic: null,
  legalForm: "112",
  registerEntry: "C 1/KSOS",
  terminatedOn: null,
};

describe("FakeCompanyRegistry", () => {
  test("the default seed covers a VAT s.r.o., a trader without DIČ and a dissolved company", async () => {
    const [sro, trader, dissolved] = await run(
      Effect.all([lookup("10047514"), lookup("10079190"), lookup("10087109")]),
    );
    expect(sro?.dic).toBe("CZ10047514");
    expect(sro?.registerEntry).toBe("C 123456/MSPH");
    expect(trader?.dic).toBeNull();
    expect(trader?.registerEntry).toBeNull();
    expect<unknown>(dissolved?.terminatedOn).toBe("2024-06-30");
    expect(FakeCompanyRegistry.defaultFakeRecords["10047514"]).toEqual(sro ?? record);
  });

  test("an unknown IČO returns null", async () => {
    expect(await run(lookup("00000019"))).toBeNull();
  });

  test("layerWith replaces the seed", async () => {
    const layer = FakeCompanyRegistry.layerWith({ records: { "10213813": record } });
    expect(await run(Effect.all([lookup("10213813"), lookup("10047514")]), layer)).toEqual([
      record,
      null,
    ]);
  });

  test("put and remove change later lookups", async () => {
    const results = await run(
      Effect.gen(function* () {
        const control = yield* FakeCompanyRegistryControl;
        const before = yield* lookup("10213813");
        yield* control.put("10213813", record);
        const added = yield* lookup("10213813");
        yield* control.remove("10047514");
        const removed = yield* lookup("10047514");
        return { before, added, removed };
      }),
    );
    expect(results).toEqual({ before: null, added: record, removed: null });
  });

  test("setUnavailable makes lookups fail with RegistryUnavailable until cleared", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const control = yield* FakeCompanyRegistryControl;
        yield* control.setUnavailable(true);
        const failed = yield* Effect.flip(lookup("10047514"));
        yield* control.setUnavailable(false);
        const recovered = yield* lookup("10047514");
        return { failed, recovered };
      }),
    );
    expect(outcome.failed).toBeInstanceOf(RegistryUnavailable);
    expect(outcome.recovered?.name).toBe("Testovací Obchod s.r.o.");
  });

  test("the unavailable option starts the fake in an outage", async () => {
    const error = await run(
      Effect.flip(lookup("10047514")),
      FakeCompanyRegistry.layerWith({ unavailable: true }),
    );
    expect(error).toBeInstanceOf(RegistryUnavailable);
  });

  test("lookups records every call in order, failures included", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const control = yield* FakeCompanyRegistryControl;
        yield* lookup("10047514");
        yield* lookup("00000019");
        yield* control.setUnavailable(true);
        yield* Effect.ignore(lookup("10079190"));
        return yield* control.lookups;
      }),
    );
    expect(seen).toEqual(["10047514", "00000019", "10079190"]);
  });

  test("each layer build has its own state", async () => {
    await run(
      Effect.gen(function* () {
        const control = yield* FakeCompanyRegistryControl;
        yield* control.remove("10047514");
      }),
    );
    expect(await run(lookup("10047514"))).not.toBeNull();
  });
});
