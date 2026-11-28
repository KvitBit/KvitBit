import { TestCaller } from "../../helpers/callerContext";
/** Documents P1: replay, references, D9 edge cases, list filters, pdf language, seams. */

import { describe, expect, test } from "bun:test";
import type { Caller, DocumentView } from "@kvitbit/domain/contract";
import {
  BankAccountId,
  ContactId,
  DeliveryId,
  DocumentId,
  Documents,
  Forbidden,
  IsoDate,
  NotFound,
  NumberingSeriesId,
  PriceListItemId,
  RequestKey,
  ScheduleId,
  StatutoryCode,
  Unavailable,
} from "@kvitbit/domain/contract";
import { RequestOutcome } from "@kvitbit/domain/ports";
import * as EffectArray from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  DocumentActivityNone,
  DocumentFakesLive,
  DocumentFixtures,
  DocumentSender,
  DocumentSenderStub,
  DocumentSummaryData,
  DocumentsLive,
  DocumentsRepo,
  DocumentsRepoMemory,
  SCHEDULE_OCCURRENCE,
} from "../../../src/modules/documents";
import { NumberingSeries, NumberingTestLayer } from "../../../src/modules/numbering";
import { makeRequestOutcome } from "../../../src/shared/requestOutcome";
import { CoreStore, StoreUnavailable, UniqueViolation } from "../../../src/store/CoreStore";
import { member, runTest } from "../../helpers";
import {
  as,
  CZ_BUYER,
  CZK,
  concreteView,
  contact,
  DE_BUYER,
  dec,
  EUR,
  fixing,
  ITEM,
  invoiceInput,
  scenario,
  seed,
  str,
} from "./fixtures";

const ok = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${String(exit.cause)}`);
  return exit.value;
};
const WS = member("owner").workspaceId;
const MISSING = "01900000-0000-7000-8000-0000deadbeef";
const STUB_DELIVERY_ID = DeliveryId.make("d-1", { disableChecks: true });
const noteTexts = (view: DocumentView) => EffectArray.map(view.statutoryNotes, (n) => n.text);

/** Runs `effect` with a fresh per-request RequestOutcome; returns [result, replayed]. */
const withOutcome = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const outcome = yield* makeRequestOutcome;
    const result = yield* Effect.provideService(effect, RequestOutcome, outcome);
    return [result, yield* outcome.replayed] as const;
  });

describe("idempotency (C3) and audit", () => {
  test("a replay is marked replayed and still authorizes first (R1a)", async () => {
    const key = RequestKey.make("req-replay");
    const [first, second, denied] = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const docs = yield* Documents;
          const firstResult = yield* withOutcome(
            docs.createDraft(testCaller, invoiceInput(), { requestKey: key }),
          );
          const secondResult = yield* withOutcome(
            docs.createDraft(testCaller, invoiceInput(), { requestKey: key }),
          );
          const deniedResult = yield* Effect.flip(
            as(
              member("accountant"),
              docs.createDraft(member("accountant"), invoiceInput(), { requestKey: key }),
            ),
          );
          return [firstResult, secondResult, deniedResult] as const;
        }),
      ),
    );
    expect(first[1]).toBe(false);
    expect(second[1]).toBe(true);
    expect(second[0].id).toBe(first[0].id);
    expect(denied).toEqual(Forbidden.make({ action: "document.draft" }));
  });

  test("editing a draft writes no audit entry", async () => {
    const history = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const docs = yield* Documents;
          const view = yield* docs.createDraft(testCaller, invoiceInput());
          yield* docs.edit(testCaller, view.id, { note: "changed" }, 1);
          return yield* docs.history(testCaller, view.id);
        }),
      ),
    );
    expect(EffectArray.map(history, (e) => e.action)).toEqual(["document.create"]);
  });
});

describe("referenced records", () => {
  test("preview reports missing item, bank account and series as NotFound (same errors as createDraft)", async () => {
    const [item, bank, series] = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const docs = yield* Documents;
          return [
            yield* Effect.flip(
              docs.preview(
                testCaller,
                invoiceInput({ lines: [{ item: PriceListItemId.make(MISSING) }] }),
              ),
            ),
            yield* Effect.flip(
              docs.preview(testCaller, invoiceInput({ bankAccount: BankAccountId.make(MISSING) })),
            ),
            yield* Effect.flip(
              docs.preview(testCaller, invoiceInput({ series: NumberingSeriesId.make(MISSING) })),
            ),
          ] as const;
        }),
      ),
    );
    expect(item).toEqual(NotFound.make({ entity: "PriceListItem", id: MISSING }));
    expect(bank).toEqual(NotFound.make({ entity: "BankAccount", id: MISSING }));
    expect(series).toEqual(NotFound.make({ entity: "NumberingSeries", id: MISSING }));
  });

  test("createDraft: missing series or bank account is NotFound; an explicit series is kept", async () => {
    const [series, bank, kept] = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const docs = yield* Documents;
          const store = yield* CoreStore;
          const created = yield* store.transaction(
            (yield* NumberingSeries).configure(
              WS,
              { kind: "invoice", name: "Jiná", pattern: "X-YYYY-NNN" },
              IsoDate.make("2026-11-23"),
            ),
          );
          const id = NumberingSeriesId.make(created.view.id);
          const view = yield* docs.createDraft(testCaller, invoiceInput({ series: id }));
          const row = yield* (yield* DocumentsRepo).get(WS, view.id);
          return [
            yield* Effect.flip(
              docs.createDraft(
                testCaller,
                invoiceInput({ series: NumberingSeriesId.make(MISSING) }),
              ),
            ),
            yield* Effect.flip(
              docs.createDraft(
                testCaller,
                invoiceInput({ bankAccount: BankAccountId.make(MISSING) }),
              ),
            ),
            [row.seriesId, id] as const,
          ] as const;
        }),
      ),
    );
    expect(series).toEqual(NotFound.make({ entity: "NumberingSeries", id: MISSING }));
    expect(bank).toEqual(NotFound.make({ entity: "BankAccount", id: MISSING }));
    expect(kept[0]).toBe(kept[1]);
  });

  test("blank descriptions fall back to the item name, else are Invalid", async () => {
    const [fromName, blank] = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          yield* (yield* DocumentFixtures).putItem(WS, {
            id: ITEM,
            name: "Hodina",
            description: "  ",
            unit: null,
            unitPrice: dec("100"),
            currency: CZK,
            vat: null,
            archived: false,
            revision: 1,
          });
          const docs = yield* Documents;
          return [
            yield* docs.createDraft(
              testCaller,
              invoiceInput({ lines: [{ item: ITEM, description: " " }] }),
            ),
            yield* Effect.flip(
              docs.createDraft(
                testCaller,
                invoiceInput({ lines: [{ description: "  ", unitPrice: dec("1") }] }),
              ),
            ),
          ] as const;
        }),
      ),
    );
    expect(concreteView(fromName).lines[0]?.description).toBe("Hodina");
    expect(blank).toMatchObject({
      _tag: "Invalid",
      issues: [{ path: ["lines", 0, "description"] }],
    });
  });
});

describe("rule D9 edge cases", () => {
  const exempt = [
    { description: "Zboží", unitPrice: dec("100"), vat: "exempt_intra_eu_goods" },
  ] as const;

  test("exempt intra-EU goods: vat_payer to an EU buyer only", async () => {
    const [eu, domestic] = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const docs = yield* Documents;
          return [
            yield* docs.createDraft(testCaller, invoiceInput({ contact: DE_BUYER, lines: exempt })),
            yield* Effect.flip(docs.createDraft(testCaller, invoiceInput({ lines: exempt }))),
          ] as const;
        }),
      ),
    );
    expect(EffectArray.map(eu.statutoryNotes, (n) => n.code)).toContain(
      StatutoryCode.make("exempt_intra_eu_goods"),
    );
    expect(domestic).toMatchObject({ issues: [{ code: "vat.not_allowed_for_regime" }] });
  });

  test("an identified person cannot use exempt intra-EU goods or standard VAT", async () => {
    const [exemptErr, standardErr] = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const docs = yield* Documents;
          return [
            yield* Effect.flip(
              docs.createDraft(testCaller, invoiceInput({ contact: DE_BUYER, lines: exempt })),
            ),
            yield* Effect.flip(
              docs.createDraft(
                testCaller,
                invoiceInput({
                  contact: DE_BUYER,
                  lines: [{ description: "x", unitPrice: dec("1"), vat: "standard" }],
                }),
              ),
            ),
          ] as const;
        }),
        { regimeA: "identified_person" },
      ),
    );
    expect(exemptErr).toMatchObject({ issues: [{ code: "vat.not_allowed_for_regime" }] });
    expect(standardErr).toMatchObject({ issues: [{ code: "vat.not_allowed_for_regime" }] });
  });
});

describe("list filters", () => {
  test("status, settlement, period and overdue narrow the list", async () => {
    const [issued, unpaid, period, overdue, notOverdue] = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const docs = yield* Documents;
          const repo = yield* DocumentsRepo;
          const store = yield* CoreStore;
          const a = yield* docs.createDraft(
            testCaller,
            invoiceInput({ issuedOn: IsoDate.make("2026-10-01"), due: { inDays: 14 } }),
          );
          yield* docs.createDraft(
            testCaller,
            invoiceInput({ issuedOn: IsoDate.make("2026-11-20") }),
          );
          const row = yield* repo.get(WS, a.id);
          yield* store.transaction(
            repo.update({ ...row, status: "issued", number: "2026-0001" }, 1),
          );
          const ids = (p: { items: ReadonlyArray<unknown> }) =>
            EffectArray.map(p.items, (item) => {
              Schema.asserts(DocumentSummaryData, item);
              return item.id;
            });
          const issuedPage = yield* docs.list(testCaller, { status: "issued" });
          const issuedIds = ids(issuedPage);
          const unpaidCount = (yield* docs.list(testCaller, { settlement: "unpaid" })).items.length;
          const periodCount = (yield* docs.list(testCaller, {
            from: IsoDate.make("2026-11-01"),
            to: IsoDate.make("2026-11-30"),
          })).items.length;
          const overduePage = yield* docs.list(testCaller, { overdue: true });
          const overdueIds = ids(overduePage);
          const notOverdueCount = (yield* docs.list(testCaller, { overdue: false })).items.length;
          return [issuedIds, unpaidCount, periodCount, overdueIds, notOverdueCount] as const;
        }),
      ),
    );
    expect(issued).toHaveLength(1);
    expect(unpaid).toBe(2);
    expect(period).toBe(1);
    expect(overdue).toEqual(issued);
    expect(notOverdue).toBe(1);
  });

  test("a limit outside 1..100 or a garbage cursor is Invalid", async () => {
    const [limit, cursor] = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const docs = yield* Documents;
          return [
            yield* Effect.flip(docs.list(testCaller, { limit: 0 })),
            yield* Effect.flip(docs.list(testCaller, { cursor: "not-a-cursor" })),
          ] as const;
        }),
      ),
    );
    expect(limit).toMatchObject({ issues: [{ path: ["limit"] }] });
    expect(cursor).toMatchObject({ issues: [{ code: "page.cursor_mismatch" }] });
  });
});

describe("pdf", () => {
  test("the language override applies to the rendered statutory notes", async () => {
    const [stored, rendered] = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const docs = yield* Documents;
          const view = yield* docs.createDraft(testCaller, invoiceInput({ kind: "proforma" }));
          yield* docs.pdf(testCaller, view.id, { language: "en" });
          const [render] = yield* Ref.get((yield* DocumentFixtures).renders);
          return [view, render] as const;
        }),
      ),
    );
    expect(noteTexts(stored)).toContain("Nejedná se o daňový doklad.");
    expect(rendered?.options.language).toBe("en");
    expect(noteTexts(rendered?.view ?? stored)).toContain("This is not a tax document.");
  });
});

describe("seams", () => {
  test("send and previewSend delegate to DocumentSender unchanged", async () => {
    const caller = member("owner");
    const calls: Array<{ caller: Caller; operation: string }> = [];
    const sender = Layer.succeed(
      DocumentSender,
      DocumentSender.of({
        send: (requestCaller, documentId) =>
          Effect.sync(() => {
            calls.push({ caller: requestCaller, operation: `send:${documentId}` });
            return { deliveryId: STUB_DELIVERY_ID, status: "queued" as const };
          }),
        previewSend: (requestCaller, documentId) =>
          Effect.sync(() => {
            calls.push({ caller: requestCaller, operation: `preview:${documentId}` });
            return {
              purpose: "document" as const,
              to: [],
              language: "cs" as const,
              subject: "s",
              attachments: [],
              armsReminders: false,
            };
          }),
      }),
    );
    const layer = DocumentsLive.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          DocumentsRepoMemory,
          NumberingTestLayer,
          DocumentFakesLive,
          sender,
          DocumentActivityNone,
        ),
      ),
    );
    const id = DocumentId.make(MISSING);
    const exit = await runTest(
      caller,
      Effect.gen(function* () {
        yield* seed();
        const docs = yield* Documents;
        return [
          yield* docs.send(caller, id),
          (yield* docs.previewSend(caller, id)).subject,
        ] as const;
      }).pipe(Effect.provide(layer)),
    );
    exit.pipe(ok, expect).toEqual([{ deliveryId: STUB_DELIVERY_ID, status: "queued" }, "s"]);
    expect(EffectArray.map(calls, (call) => call.operation)).toEqual([
      `send:${id}`,
      `preview:${id}`,
    ]);
    for (const call of calls) expect(call.caller).toBe(caller);
  });

  test("the default sender stub dies clearly", async () => {
    const exit = await scenario(
      Effect.flatMap(Documents, (d) =>
        Effect.flatMap(TestCaller, (caller) => d.send(caller, DocumentId.make(MISSING))),
      ),
    );
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("not implemented (stage 2");
  });

  test("linkSchedule sets the occurrence once per schedule (board #450)", async () => {
    const schedule = ScheduleId.make("01900000-0000-7000-8000-00005c4ed001");
    const occurrence = IsoDate.make("2026-12-01");
    const [row, dup] = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const docs = yield* Documents;
          const repo = yield* DocumentsRepo;
          const store = yield* CoreStore;
          const a = yield* docs.createDraft(testCaller, invoiceInput());
          const b = yield* docs.createDraft(testCaller, invoiceInput({ contact: CZ_BUYER }));
          yield* store.transaction(
            repo.linkSchedule(WS, a.id, { scheduleId: schedule, occurrence }),
          );
          const duplicate = yield* Effect.flip(
            store.transaction(repo.linkSchedule(WS, b.id, { scheduleId: schedule, occurrence })),
          );
          return [yield* repo.get(WS, a.id), duplicate] as const;
        }),
      ),
    );
    expect([row.scheduleId, row.occurrence, row.revision]).toEqual([schedule, occurrence, 2]);
    expect(dup).toBeInstanceOf(UniqueViolation);
    expect(dup).toHaveProperty("constraint", SCHEDULE_OCCURRENCE);
  });
});

describe("review round 1 regressions", () => {
  const putItem = (vat: "standard" | null = "standard") =>
    Effect.flatMap(DocumentFixtures, (f) =>
      f.putItem(WS, {
        id: ITEM,
        name: "Licence",
        description: null,
        unit: null,
        unitPrice: dec("100"),
        currency: CZK,
        vat,
        archived: false,
        revision: 1,
      }),
    );

  test("a copied CZK price cannot silently become EUR on a currency edit", async () => {
    const [created, edited] = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          yield* putItem();
          const docs = yield* Documents;
          const view = yield* docs.createDraft(
            testCaller,
            invoiceInput({ lines: [{ item: ITEM }] }),
          );
          return [
            view,
            yield* Effect.flip(docs.edit(testCaller, view.id, { currency: EUR }, 1)),
          ] as const;
        }),
        { fixings: [fixing("2026-11-20", "25")] },
      ),
    );
    created.totals.gross.amount.pipe(str, expect).toBe("121");
    expect(edited).toMatchObject({
      _tag: "Invalid",
      issues: [{ path: ["lines", 0, "unitPrice"], params: { currency: "CZK" } }],
    });
  });

  test("a net catalog price is grossed up when prices include VAT (100 net -> 121 gross)", async () => {
    const [inclusive, toggled] = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          yield* putItem();
          const docs = yield* Documents;
          const inclusiveResult = yield* docs.preview(
            testCaller,
            invoiceInput({ lines: [{ item: ITEM }], pricesIncludeVat: true }),
          );
          const draft = yield* docs.createDraft(
            testCaller,
            invoiceInput({ lines: [{ item: ITEM }] }),
          );
          const toggledResult = yield* docs.edit(
            testCaller,
            draft.id,
            { pricesIncludeVat: true },
            1,
          );
          return [inclusiveResult, toggledResult] as const;
        }),
      ),
    );
    for (const view of [inclusive, toggled]) {
      const net = str(view.totals.net.amount);
      const vat = str(view.totals.vat.amount);
      const gross = str(view.totals.gross.amount);
      expect(net).toBe("100");
      expect(vat).toBe("21");
      expect(gross).toBe("121");
    }
  });

  test("an identified person's reverse charge needs a buyer in another EU state", async () => {
    const err = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const us = ContactId.make("01900000-0000-7000-8000-0000c0000005");
          yield* (yield* DocumentFixtures).putContact(
            WS,
            contact(us, { country: "US", dic: "12-3456789" }),
          );
          return yield* Effect.flip(
            (yield* Documents).createDraft(
              testCaller,
              invoiceInput({
                contact: us,
                lines: [{ description: "x", unitPrice: dec("1"), vat: "reverse_charge" }],
              }),
            ),
          );
        }),
        { regimeA: "identified_person" },
      ),
    );
    expect(err).toMatchObject({ issues: [{ code: "vat.not_allowed_for_regime" }] });
  });

  test("returns NotFound for a missing Issuing Entity", async () => {
    const err = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          yield* Ref.update((yield* DocumentFixtures).issuers, () => new Map());
          return yield* Effect.flip((yield* Documents).createDraft(testCaller, invoiceInput()));
        }),
      ),
    );
    expect(err).toEqual(NotFound.make({ entity: "Workspace", id: WS }));
  });

  test("a computed due date beyond 9999-12-31 is Invalid at due", async () => {
    const err = ok(
      await Documents.pipe(
        Effect.flatMap((d) =>
          Effect.flatMap(TestCaller, (caller) =>
            d.preview(caller, invoiceInput({ due: { inDays: 10000000 } })),
          ),
        ),
        Effect.flip,
        scenario,
      ),
    );
    expect(err).toMatchObject({ _tag: "Invalid", issues: [{ path: ["due"] }] });
  });

  test("admins and write-scoped members can draft", async () => {
    const [admin, writer] = ok(
      await scenario(
        Effect.gen(function* () {
          const docs = yield* Documents;
          return [
            (yield* as(member("admin"), docs.createDraft(member("admin"), invoiceInput()))).status,
            (yield* as(
              member("member", { scopes: ["documents:write"] }),
              docs.createDraft(member("member", { scopes: ["documents:write"] }), invoiceInput()),
            )).status,
          ] as const;
        }),
      ),
    );
    expect([admin, writer]).toEqual(["draft", "draft"]);
  });
});

describe("store outages", () => {
  test("a StoreUnavailable from the repo is Unavailable{database} on reads and discard", async () => {
    const failing = Layer.effect(
      DocumentsRepo,
      Effect.map(DocumentsRepo, (repo) =>
        DocumentsRepo.of({
          ...repo,
          get: () => Effect.fail(StoreUnavailable.make({})),
          getForUpdate: () => Effect.fail(StoreUnavailable.make({})),
          search: () => Effect.fail(StoreUnavailable.make({})),
        }),
      ),
    ).pipe(Layer.provide(DocumentsRepoMemory));
    const layer = DocumentsLive.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          failing,
          NumberingTestLayer,
          DocumentFakesLive,
          DocumentSenderStub,
          DocumentActivityNone,
        ),
      ),
    );
    const id = DocumentId.make(MISSING);
    const exit = await runTest(
      member("owner"),
      Effect.gen(function* () {
        yield* seed();
        const docs = yield* Documents;
        return [
          yield* Effect.flip(docs.get(member("owner"), id)),
          yield* Effect.flip(docs.list(member("owner"), {})),
          yield* Effect.flip(docs.history(member("owner"), id)),
          yield* Effect.flip(docs.discardDraft(member("owner"), id, 1)),
        ] as const;
      }).pipe(Effect.provide(layer)),
    );
    for (const err of ok(exit)) {
      expect(err).toEqual(Unavailable.make({ dependency: "database" }));
    }
  });
});

describe("variable symbol and payment QR (P1 scope)", () => {
  test("an explicit variable symbol must be 1-10 digits; it is stored exactly", async () => {
    const [kept, tooLong, letters, listed] = ok(
      await scenario(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const docs = yield* Documents;
          const keptResult = yield* docs.createDraft(
            testCaller,
            invoiceInput({ variableSymbol: "0012345678" }),
          );
          const tooLongResult = yield* Effect.flip(
            docs.createDraft(testCaller, invoiceInput({ variableSymbol: "12345678901" })),
          );
          const lettersResult = yield* Effect.flip(
            docs.preview(testCaller, invoiceInput({ variableSymbol: "VS-1" })),
          );
          const row = yield* (yield* DocumentsRepo).get(WS, keptResult.id);
          return [
            row.variableSymbol,
            tooLongResult,
            lettersResult,
            (yield* docs.list(testCaller, {})).items.length,
          ] as const;
        }),
      ),
    );
    expect(kept).toBe("0012345678");
    for (const err of [tooLong, letters]) {
      expect(err).toMatchObject({
        _tag: "Invalid",
        issues: [
          {
            path: ["variableSymbol"],
            code: "request.malformed",
            params: { reason: "variable_symbol_invalid" },
          },
        ],
      });
    }
    expect(listed).toBe(1);
  });

  test("paymentQr is null until the PaymentQr engine lands (rule D12 deferred)", async () => {
    const view = ok(
      await scenario(
        Effect.flatMap(Documents, (d) =>
          Effect.flatMap(TestCaller, (caller) => d.createDraft(caller, invoiceInput())),
        ),
      ),
    );
    expect(view.paymentQr).toBeNull();
  });
});
