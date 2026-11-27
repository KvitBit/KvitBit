import { describe, expect, test } from "bun:test";
import type { Caller, CoreError, CurrentCaller, PriceListItemView } from "@kvitbit/domain/contract";
import {
  PriceList,
  PriceListItemId,
  PriceListItemInput,
  RequestKey,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as EffectRecord from "effect/Record";
import * as Schema from "effect/Schema";
import {
  type PriceListItemSaveInput,
  PriceListItems,
  PriceListItemViewSchema,
  PriceListTestLayer,
} from "../../../src/modules/pricelist";
import type { CoreStore } from "../../../src/store/CoreStore";
import { member, runTest, shareVisitor, system, WORKSPACE_A, WORKSPACE_B } from "../../helpers";
import { as, failureOf, history, successOf } from "../contacts/harness";

const run = <A, E>(
  caller: Caller,
  effect: Effect.Effect<A, E, PriceList | PriceListItems | CoreStore | CurrentCaller>,
) => runTest(caller, Effect.provide(effect, PriceListTestLayer));

const owner = member("owner");
const view = (value: PriceListItemView) =>
  Schema.decodeUnknownOption(PriceListItemViewSchema)(value).pipe(Option.getOrThrow);
type FixtureFields = Omit<typeof PriceListItemSaveInput.Encoded, "vat"> & {
  readonly colour?: string;
  readonly vat?: (typeof PriceListItemSaveInput.Encoded)["vat"] | "21";
};
const dec = (s: string) => BigDecimal.fromStringUnsafe(s);

const saveHour = (fields: FixtureFields = {}) =>
  Effect.flatMap(PriceList, (p) =>
    p.save(
      PriceListItemInput.make({
        name: "Konzultace",
        unit: "hod",
        unitPrice: dec("1500"),
        currency: "CZK",
        vat: "standard",
        ...fields,
      }),
    ),
  ).pipe(Effect.map(view));

describe("PriceList.save", () => {
  test("creates an item at revision 1 and writes no audit entry", async () => {
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const saved = yield* saveHour();
        return {
          saved,
          entries: yield* history(WORKSPACE_A, { entity: "PriceListItem", id: saved.id }),
        };
      }),
    );
    const { saved, entries } = successOf(exit);
    expect(saved).toMatchObject({
      name: "Konzultace",
      description: null,
      unit: "hod",
      currency: "CZK",
      vat: "standard",
      archived: false,
      revision: 1,
    });
    expect(BigDecimal.equals(saved.unitPrice, dec("1500"))).toBe(true);
    expect(entries).toEqual([]);
  });

  test("accepts unitPrice as a decimal string", async () => {
    const exit = await run(owner, saveHour({ unitPrice: "1234.50" }));
    const unitPrice = BigDecimal.format(successOf(exit).unitPrice);
    expect(unitPrice).toBe("1234.5");
  });

  test("required fields and malformed values are Invalid{request.malformed}", async () => {
    const noPrice = await run(
      owner,
      Effect.flatMap(PriceList, (p) =>
        p.save(PriceListItemInput.make({ name: "X", currency: "CZK" })),
      ),
    );
    const noPriceFailure = failureOf<unknown, CoreError>(noPrice);
    expect(noPriceFailure).toMatchObject({
      issues: [{ path: ["unitPrice"], code: "request.malformed" }],
    });
    const malformedPrices = await Promise.all(
      EffectArray.map(["", "1e3", " 12"], (unitPrice) => run(owner, saveHour({ unitPrice }))),
    );
    for (const malformedPrice of malformedPrices) {
      const malformedPriceFailure = failureOf<unknown, CoreError>(malformedPrice);
      expect(malformedPriceFailure).toMatchObject({
        issues: [{ path: ["unitPrice"], code: "request.malformed" }],
      });
    }
    const failure = failureOf<unknown, CoreError>(await run(owner, saveHour({ colour: "red" })));
    expect(failure).toMatchObject({
      issues: [{ path: ["colour"], code: "request.malformed" }],
    });
    const failure2 = failureOf<unknown, CoreError>(
      await run(
        owner,
        saveHour({ id: "01900000-0000-7000-8000-000000000001", expectedRevision: 1.5 }),
      ),
    );
    expect(failure2).toMatchObject({
      issues: [{ path: ["expectedRevision"], code: "request.malformed" }],
    });
    const badCurrency = await run(owner, saveHour({ currency: "czk" }));
    const badCurrencyFailure = failureOf<unknown, CoreError>(badCurrency);
    expect(badCurrencyFailure).toMatchObject({
      issues: [{ path: ["currency"], code: "request.malformed" }],
    });
    const badVat = await run(owner, saveHour({ vat: "21" }));
    const badVatFailure = failureOf<unknown, CoreError>(badVat);
    expect(badVatFailure).toMatchObject({
      issues: [{ path: ["vat"], code: "request.malformed" }],
    });
    const blankName = await run(owner, saveHour({ name: "  " }));
    const blankNameFailure = failureOf<unknown, CoreError>(blankName);
    expect(blankNameFailure).toMatchObject({
      issues: [{ path: ["name"], code: "request.malformed" }],
    });
  });

  test("revisions: each edit bumps the revision; stale or missing ones are Conflict", async () => {
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const prices = yield* PriceList;
        const created = yield* saveHour();
        const saveResult = yield* prices.save(
          PriceListItemInput.make({
            id: created.id,
            expectedRevision: 1,
            unitPrice: dec("1800"),
            unit: null,
          }),
        );
        const second = view(saveResult);
        const saveResult2 = yield* prices.save(
          PriceListItemInput.make({ id: created.id, expectedRevision: 2, name: "Konzultace+" }),
        );
        const third = view(saveResult2);
        const saveResult3 = yield* prices.save(
          PriceListItemInput.make({ id: created.id, expectedRevision: 3, unitPrice: "1800.00" }),
        );
        const unchanged = view(saveResult3);
        const stale = yield* Effect.flip(
          prices.save(
            PriceListItemInput.make({ id: created.id, expectedRevision: 2, name: "Old" }),
          ),
        );
        const missing = yield* Effect.flip(
          prices.save(PriceListItemInput.make({ id: created.id, name: "Old" })),
        );
        return { second, third, unchanged, stale, missing };
      }),
    );
    const { second, third, unchanged, stale, missing } = successOf(exit);
    expect(second).toMatchObject({ unit: null, name: "Konzultace", revision: 2 });
    expect(BigDecimal.equals(second.unitPrice, dec("1800"))).toBe(true);
    expect(third).toMatchObject({ name: "Konzultace+", unit: null, revision: 3 });
    expect(unchanged.revision).toBe(3);
    for (const conflict of [stale, missing]) {
      expect(conflict).toMatchObject({
        _tag: "Conflict",
        reason: "revision_changed",
        currentRevision: 3,
      });
    }
  });

  test("requestKey replays the stored result; another payload is idempotency_mismatch", async () => {
    const key = RequestKey.make("01900000-0000-7000-8000-0000000000ac");
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const prices = yield* PriceList;
        const body = PriceListItemInput.make({ name: "Hodina", unitPrice: "100", currency: "CZK" });
        const saveResult = yield* prices.save(body, { requestKey: key });
        const first = view(saveResult);
        const saveResult2 = yield* prices.save(body, { requestKey: key });
        const replay = view(saveResult2);
        const mismatch = yield* Effect.flip(
          prices.save(
            PriceListItemInput.make({ name: "Jiné", unitPrice: "100", currency: "CZK" }),
            {
              requestKey: key,
            },
          ),
        );
        return { first, replay, mismatch, all: yield* prices.list() };
      }),
    );
    const { first, replay, mismatch, all } = successOf(exit);
    expect(replay.id).toBe(first.id);
    expect(BigDecimal.equals(replay.unitPrice, first.unitPrice)).toBe(true);
    expect(all).toHaveLength(1);
    expect(mismatch).toMatchObject({ _tag: "Conflict", reason: "idempotency_mismatch" });
  });
});

describe("PriceList.archive and list", () => {
  test("archive is idempotent by state; list hides archived unless asked", async () => {
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const prices = yield* PriceList;
        const hour = yield* saveHour();
        yield* saveHour({ name: "Školení", description: "Celodenní workshop" });
        yield* saveHour({ name: "Audit kódu" });
        yield* prices.archive(hour.id);
        yield* prices.archive(hour.id);
        const names = (q?: Parameters<PriceList["Service"]["list"]>[0]) =>
          Effect.map(prices.list(q), (items) =>
            EffectArray.map(
              items,
              (i) => `${view(i).name}${view(i).archived ? " (archived)" : ""}`,
            ),
          );
        const includingArchived = yield* prices.list({ includeArchived: true });
        return {
          active: yield* names(),
          all: yield* names({ includeArchived: true }),
          text: yield* names({ text: "skoleni" }),
          description: yield* names({ text: "WORKSHOP" }),
          archivedRevision: Option.getOrUndefined(
            EffectArray.findFirst(EffectArray.map(includingArchived, view), (i) => i.archived),
          )?.revision,
        };
      }),
    );
    const lists = successOf(exit);
    expect(lists).toEqual({
      active: ["Audit kódu", "Školení"],
      all: ["Audit kódu", "Konzultace (archived)", "Školení"],
      text: ["Školení"],
      description: ["Školení"],
      archivedRevision: 2,
    });
  });

  test("unknown ids are NotFound", async () => {
    const id = PriceListItemId.make("01900000-0000-7000-8000-000000000099");
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const prices = yield* PriceList;
        return [
          yield* Effect.exit(prices.archive(id)),
          yield* Effect.exit(
            prices.save(PriceListItemInput.make({ id, expectedRevision: 1, name: "X" })),
          ),
        ] as const;
      }),
    );
    for (const e of successOf(exit)) {
      const failure = failureOf<unknown, CoreError>(e);
      expect(failure).toMatchObject({ _tag: "NotFound", entity: "PriceListItem", id });
    }
  });
});

describe("PriceList authorization and tenancy", () => {
  const attempt = (caller: Caller) =>
    run(
      owner,
      Effect.gen(function* () {
        const saved = yield* saveHour();
        const prices = yield* PriceList;
        return yield* as(caller)(
          Effect.all(
            {
              list: Effect.exit(prices.list()),
              create: Effect.exit(saveHour()),
              save: Effect.exit(
                prices.save(
                  PriceListItemInput.make({ id: saved.id, expectedRevision: 1, name: "Edited" }),
                ),
              ),
              archive: Effect.exit(prices.archive(saved.id)),
            },
            { concurrency: 1 },
          ),
        );
      }),
    ).then(successOf);

  const tagOf = (exit: Exit.Exit<unknown, CoreError>) =>
    Exit.isSuccess(exit) ? "ok" : failureOf(exit)._tag;
  const tags = (exits: Awaited<ReturnType<typeof attempt>>) =>
    EffectRecord.fromEntries(
      EffectArray.map(EffectRecord.toEntries(exits), ([key, exit]) => [key, tagOf(exit)]),
    );

  test("owner, admin and member write; accountant and System read only", async () => {
    const writers = await Promise.all(
      EffectArray.map(["owner", "admin", "member"] as const, (role) => attempt(member(role))),
    );
    for (const exits of writers) {
      expect(tags(exits)).toEqual({
        list: "ok",
        create: "ok",
        save: "ok",
        archive: "ok",
      });
    }
    const readers = await Promise.all([attempt(member("accountant")), attempt(system())]);
    for (const exits of readers) {
      expect(tags(exits)).toEqual({
        list: "ok",
        create: "Forbidden",
        save: "Forbidden",
        archive: "Forbidden",
      });
      const failure = failureOf<unknown, CoreError>(exits.create);
      expect(failure).toMatchObject({ action: "priceList.write" });
    }
  });

  test("API keys follow their scopes: catalog:read reads only, contacts:write sees nothing", async () => {
    expect(tags(await attempt(member("owner", { scopes: ["catalog:read"] })))).toEqual({
      list: "ok",
      create: "Forbidden",
      save: "Forbidden",
      archive: "Forbidden",
    });
    expect(tags(await attempt(member("admin", { scopes: ["catalog:write"] })))).toMatchObject({
      create: "ok",
    });
    const contactsOnly = await attempt(member("owner", { scopes: ["contacts:write"] }));
    expect(new Set(EffectRecord.values(tags(contactsOnly)))).toEqual(new Set(["Forbidden"]));
    const failure = failureOf<unknown, CoreError>(contactsOnly.list);
    expect(failure).toMatchObject({ action: "priceList.read" });
    expect(new Set(EffectRecord.values(tags(await attempt(shareVisitor()))))).toEqual(
      new Set(["Forbidden"]),
    );
  });

  test("another Workspace sees none of the items and gets NotFound on writes", async () => {
    const exits = await attempt(member("owner", { workspaceId: WORKSPACE_B }));
    const failure = failureOf<unknown, CoreError>(exits.save);
    expect(failure).toMatchObject({ _tag: "NotFound", entity: "PriceListItem" });
    const failure2 = failureOf<unknown, CoreError>(exits.archive);
    expect(failure2).toMatchObject({ _tag: "NotFound", entity: "PriceListItem" });
    expect(Exit.isSuccess(exits.list) && exits.list.value).toEqual([]);
  });
});

describe("PriceListItems (Documents read port)", () => {
  test("returns the item for a line without priceList.read; scoped by Workspace", async () => {
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const saved = yield* saveHour();
        const items = yield* PriceListItems;
        const line = yield* as(member("owner", { scopes: ["documents:write"] }))(
          items.forLine(WORKSPACE_A, saved.id),
        );
        const elsewhere = yield* Effect.flip(items.forLine(WORKSPACE_B, saved.id));
        return { saved, line, elsewhere };
      }),
    );
    const { saved, line, elsewhere } = successOf(exit);
    expect(line).toEqual(saved);
    expect(elsewhere).toMatchObject({ _tag: "NotFound", entity: "PriceListItem" });
  });
});
