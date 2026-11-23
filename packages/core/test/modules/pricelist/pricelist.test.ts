import { describe, expect, test } from "bun:test";
import type {
  Caller,
  CurrentCaller,
  PriceListItemId,
  PriceListItemView,
  RequestKey,
} from "@kvitbit/domain/contract";
import { PriceList } from "@kvitbit/domain/contract";
import { BigDecimal, Effect, Exit } from "effect";
import type { PriceListItemViewData } from "../../../src/modules/pricelist";
import { PriceListItems, PriceListTestLayer } from "../../../src/modules/pricelist";
import type { CoreStore } from "../../../src/store/CoreStore";
import { member, runTest, shareVisitor, system, WORKSPACE_A, WORKSPACE_B } from "../../helpers";
import { as, expectFailure, failureOf, history, successOf } from "../contacts/harness";

const run = <A, E>(
  caller: Caller,
  effect: Effect.Effect<A, E, PriceList | PriceListItems | CoreStore | CurrentCaller>,
) => runTest(caller, Effect.provide(effect, PriceListTestLayer));

const owner = member("owner");
const view = (v: PriceListItemView) => v as PriceListItemViewData;
type SaveInput = Parameters<PriceList["Service"]["save"]>[0];
const input = (fields: Record<string, unknown>) => fields as unknown as SaveInput;
const dec = (s: string) => BigDecimal.fromStringUnsafe(s);

const saveHour = (fields: Record<string, unknown> = {}) =>
  Effect.flatMap(PriceList, (p) =>
    p.save(
      input({
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
    expect(BigDecimal.format(successOf(exit).unitPrice)).toBe("1234.5");
  });

  test("required fields and malformed values are Invalid{request.malformed}", async () => {
    const noPrice = await run(
      owner,
      Effect.flatMap(PriceList, (p) => p.save(input({ name: "X", currency: "CZK" }))),
    );
    expectFailure(noPrice, { issues: [{ path: ["unitPrice"], code: "request.malformed" }] });
    const badCurrency = await run(owner, saveHour({ currency: "czk" }));
    expectFailure(badCurrency, { issues: [{ path: ["currency"], code: "request.malformed" }] });
    const badVat = await run(owner, saveHour({ vat: "21" }));
    expectFailure(badVat, { issues: [{ path: ["vat"], code: "request.malformed" }] });
    const blankName = await run(owner, saveHour({ name: "  " }));
    expectFailure(blankName, { issues: [{ path: ["name"], code: "request.malformed" }] });
  });

  test("revisions: each edit bumps the revision; stale or missing ones are Conflict", async () => {
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const prices = yield* PriceList;
        const created = yield* saveHour();
        const second = view(
          yield* prices.save(
            input({ id: created.id, expectedRevision: 1, unitPrice: dec("1800"), unit: null }),
          ),
        );
        const third = view(
          yield* prices.save(input({ id: created.id, expectedRevision: 2, name: "Konzultace+" })),
        );
        const unchanged = view(
          yield* prices.save(input({ id: created.id, expectedRevision: 3, unitPrice: "1800.00" })),
        );
        const stale = yield* Effect.flip(
          prices.save(input({ id: created.id, expectedRevision: 2, name: "Old" })),
        );
        const missing = yield* Effect.flip(prices.save(input({ id: created.id, name: "Old" })));
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
    const key = "01900000-0000-7000-8000-0000000000ac" as RequestKey;
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const prices = yield* PriceList;
        const body = input({ name: "Hodina", unitPrice: "100", currency: "CZK" });
        const first = view(yield* prices.save(body, { requestKey: key }));
        const replay = view(yield* prices.save(body, { requestKey: key }));
        const mismatch = yield* Effect.flip(
          prices.save(input({ name: "Jiné", unitPrice: "100", currency: "CZK" }), {
            requestKey: key,
          }),
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
            items.map((i) => `${view(i).name}${view(i).archived ? " (archived)" : ""}`),
          );
        return {
          active: yield* names(),
          all: yield* names({ includeArchived: true }),
          text: yield* names({ text: "skoleni" }),
          description: yield* names({ text: "WORKSHOP" }),
          archivedRevision: (yield* prices.list({ includeArchived: true }))
            .map(view)
            .find((i) => i.archived)?.revision,
        };
      }),
    );
    expect(successOf(exit)).toEqual({
      active: ["Audit kódu", "Školení"],
      all: ["Audit kódu", "Konzultace (archived)", "Školení"],
      text: ["Školení"],
      description: ["Školení"],
      archivedRevision: 2,
    });
  });

  test("unknown ids are NotFound", async () => {
    const id = "01900000-0000-7000-8000-000000000099" as PriceListItemId;
    const exit = await run(
      owner,
      Effect.gen(function* () {
        const prices = yield* PriceList;
        return [
          yield* Effect.exit(prices.archive(id)),
          yield* Effect.exit(prices.save(input({ id, expectedRevision: 1, name: "X" }))),
        ] as const;
      }),
    );
    for (const e of successOf(exit)) {
      expectFailure(e, { _tag: "NotFound", entity: "PriceListItem", id });
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
          Effect.all({
            list: Effect.exit(prices.list()),
            create: Effect.exit(saveHour()),
            save: Effect.exit(
              prices.save(input({ id: saved.id, expectedRevision: 1, name: "Edited" })),
            ),
            archive: Effect.exit(prices.archive(saved.id)),
          }),
        );
      }),
    ).then(successOf);

  const tags = (exits: Record<string, Exit.Exit<unknown, unknown>>) =>
    Object.fromEntries(
      Object.entries(exits).map(([k, v]) => [
        k,
        Exit.isSuccess(v) ? "ok" : (failureOf(v) as { _tag: string })._tag,
      ]),
    );

  test("owner, admin and member write; accountant and System read only", async () => {
    for (const role of ["owner", "admin", "member"] as const) {
      expect(tags(await attempt(member(role)))).toEqual({
        list: "ok",
        create: "ok",
        save: "ok",
        archive: "ok",
      });
    }
    for (const caller of [member("accountant"), system()]) {
      const exits = await attempt(caller);
      expect(tags(exits)).toEqual({
        list: "ok",
        create: "Forbidden",
        save: "Forbidden",
        archive: "Forbidden",
      });
      expectFailure(exits.create, { action: "priceList.write" });
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
    expect(new Set(Object.values(tags(contactsOnly)))).toEqual(new Set(["Forbidden"]));
    expectFailure(contactsOnly.list, { action: "priceList.read" });
    expect(new Set(Object.values(tags(await attempt(shareVisitor()))))).toEqual(
      new Set(["Forbidden"]),
    );
  });

  test("another Workspace sees none of the items and gets NotFound on writes", async () => {
    const exits = await attempt(member("owner", { workspaceId: WORKSPACE_B }));
    expectFailure(exits.save, { _tag: "NotFound", entity: "PriceListItem" });
    expectFailure(exits.archive, { _tag: "NotFound", entity: "PriceListItem" });
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
