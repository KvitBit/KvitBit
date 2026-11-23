import { describe, expect, test } from "bun:test";
import { Invalid, Unavailable } from "@kvitbit/domain/contract";
import type { RegistryRecord } from "@kvitbit/domain/ports";
import { Duration, Effect, Exit, Layer, Ref } from "effect";
import { TestClock } from "effect/testing";
import { isValidIco, RegistryLookup } from "../../../src/modules/workspaces/registry";
import { FakeCompanyRegistry } from "../../../src/testing";

const record: RegistryRecord = {
  name: "Acme s.r.o.",
  address: { street: "Hlavní 1", city: "Praha", postalCode: "11000", country: "CZ" },
  dic: "CZ27074358",
  legalForm: "112",
  registerEntry: null,
  terminatedOn: null,
};

const run = <A, E>(effect: Effect.Effect<A, E, RegistryLookup | FakeCompanyRegistry>) =>
  Effect.runPromiseExit(
    effect.pipe(
      Effect.provide(
        Layer.merge(
          RegistryLookup.layer.pipe(
            Layer.provideMerge(FakeCompanyRegistry.layer({ "27074358": record })),
          ),
          TestClock.layer(),
        ),
      ),
    ),
  );

describe("RegistryLookup", () => {
  test("isValidIco applies the mod-11 checksum", () => {
    expect(isValidIco("27074358")).toBe(true);
    expect(isValidIco("27074359")).toBe(false);
    expect(isValidIco("2707435")).toBe(false);
    expect(isValidIco("2707435a")).toBe(false);
  });

  test("checksum failure is Invalid{ico.checksum} with no registry call", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const error = yield* Effect.flip((yield* RegistryLookup).lookup("27074359"));
        return [error, yield* Ref.get((yield* FakeCompanyRegistry).lookups)] as const;
      }),
    );
    const [error, lookups] = Exit.isSuccess(exit) ? exit.value : [undefined, undefined];
    expect(error).toBeInstanceOf(Invalid);
    expect((error as Invalid).issues[0]?.code).toBe("ico.checksum");
    expect(lookups).toEqual([]);
  });

  test("caches hits and misses for 24 hours, then refetches", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const lookup = yield* RegistryLookup;
        const fake = yield* FakeCompanyRegistry;
        const first = yield* lookup.lookup("27074358");
        yield* lookup.lookup("27074358");
        const missing = yield* lookup.lookup("25596641");
        yield* lookup.lookup("25596641");
        yield* TestClock.adjust(Duration.hours(24));
        yield* lookup.lookup("27074358");
        return { first, missing, lookups: yield* Ref.get(fake.lookups) };
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.first).toEqual({ ico: "27074358", ...record });
    expect(exit.value.missing).toBeNull();
    expect(exit.value.lookups).toEqual(["27074358", "25596641", "27074358"]);
  });

  test("registry failure is Unavailable{company_registry} and is not cached", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const lookup = yield* RegistryLookup;
        const fake = yield* FakeCompanyRegistry;
        yield* Ref.set(fake.unavailable, true);
        const error = yield* Effect.flip(lookup.lookup("27074358"));
        yield* Ref.set(fake.unavailable, false);
        const after = yield* lookup.lookup("27074358");
        return { error, after };
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.error).toEqual(new Unavailable({ dependency: "company_registry" }));
    expect(exit.value.after?.name).toBe("Acme s.r.o.");
  });
});
