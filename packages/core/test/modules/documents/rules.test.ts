/** Documents P1: replay, references, D9 edge cases, list filters, pdf language, seams. */
import { describe, expect, test } from "bun:test";
import type {
  DeliveryId,
  DocumentId,
  DocumentView,
  IsoDate,
  NumberingSeriesId,
  RequestKey,
  ScheduleId,
} from "@kvitbit/domain/contract";
import { Documents, Forbidden, NotFound, Unavailable } from "@kvitbit/domain/contract";
import { RequestOutcome } from "@kvitbit/domain/ports";
import { Effect, Exit, Layer, Ref } from "effect";
import {
  DocumentFakesLive,
  DocumentFixtures,
  DocumentSender,
  DocumentSenderStub,
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
const noteTexts = (view: DocumentView) => view.statutoryNotes.map((n) => n.text);

/** Runs `effect` with a fresh per-request RequestOutcome; returns [result, replayed]. */
const withOutcome = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const outcome = yield* makeRequestOutcome;
    const result = yield* Effect.provideService(effect, RequestOutcome, outcome);
    return [result, yield* outcome.replayed] as const;
  });

describe("idempotency (C3) and audit", () => {
  test("a replay is marked replayed and still authorizes first (R1a)", async () => {
    const key = "req-replay" as RequestKey;
    const [first, second, denied] = ok(
      await scenario(
        Effect.gen(function* () {
          const docs = yield* Documents;
          const first = yield* withOutcome(docs.createDraft(invoiceInput(), { requestKey: key }));
          const second = yield* withOutcome(docs.createDraft(invoiceInput(), { requestKey: key }));
          const denied = yield* Effect.flip(
            as(member("accountant"), docs.createDraft(invoiceInput(), { requestKey: key })),
          );
          return [first, second, denied] as const;
        }),
      ),
    );
    expect(first[1]).toBe(false);
    expect(second[1]).toBe(true);
    expect(second[0].id).toBe(first[0].id);
    expect(denied).toEqual(new Forbidden({ action: "document.draft" }));
  });

  test("editing a draft writes no audit entry", async () => {
    const history = ok(
      await scenario(
        Effect.gen(function* () {
          const docs = yield* Documents;
          const view = yield* docs.createDraft(invoiceInput());
          yield* docs.edit(view.id, { note: "changed" }, 1);
          return yield* docs.history(view.id);
        }),
      ),
    );
    expect(history.map((e) => e.action)).toEqual(["document.create"]);
  });
});

describe("referenced records", () => {
  test("preview reports missing item, bank account and series as NotFound (same errors as createDraft)", async () => {
    const [item, bank, series] = ok(
      await scenario(
        Effect.gen(function* () {
          const docs = yield* Documents;
          return [
            yield* Effect.flip(docs.preview(invoiceInput({ lines: [{ item: MISSING as never }] }))),
            yield* Effect.flip(docs.preview(invoiceInput({ bankAccount: MISSING as never }))),
            yield* Effect.flip(docs.preview(invoiceInput({ series: MISSING as never }))),
          ] as const;
        }),
      ),
    );
    expect(item as unknown).toEqual(new NotFound({ entity: "PriceListItem", id: MISSING }));
    expect(bank as unknown).toEqual(new NotFound({ entity: "BankAccount", id: MISSING }));
    expect(series as unknown).toEqual(new NotFound({ entity: "NumberingSeries", id: MISSING }));
  });

  test("createDraft: missing series or bank account is NotFound; an explicit series is kept", async () => {
    const [series, bank, kept] = ok(
      await scenario(
        Effect.gen(function* () {
          const docs = yield* Documents;
          const store = yield* CoreStore;
          const created = yield* store.transaction(
            (yield* NumberingSeries).configure(
              WS,
              { kind: "invoice", name: "Jiná", pattern: "X-YYYY-NNN" },
              "2026-11-23" as IsoDate,
            ),
          );
          const id = created.view.id as NumberingSeriesId;
          const view = yield* docs.createDraft(invoiceInput({ series: id }));
          const row = yield* (yield* DocumentsRepo).get(WS, view.id);
          return [
            yield* Effect.flip(docs.createDraft(invoiceInput({ series: MISSING as never }))),
            yield* Effect.flip(docs.createDraft(invoiceInput({ bankAccount: MISSING as never }))),
            [row.seriesId, id] as const,
          ] as const;
        }),
      ),
    );
    expect(series).toEqual(new NotFound({ entity: "NumberingSeries", id: MISSING }));
    expect(bank).toEqual(new NotFound({ entity: "BankAccount", id: MISSING }));
    expect(kept[0]).toBe(kept[1]);
  });

  test("blank descriptions fall back to the item name, else are Invalid", async () => {
    const [fromName, blank] = ok(
      await scenario(
        Effect.gen(function* () {
          yield* (yield* DocumentFixtures).putItem(WS, {
            id: ITEM,
            name: "Hodina",
            description: "  ",
            unit: null,
            unitPrice: dec("100"),
            currency: "CZK" as never,
            vat: null,
            archived: false,
            revision: 1,
          });
          const docs = yield* Documents;
          return [
            yield* docs.createDraft(invoiceInput({ lines: [{ item: ITEM, description: " " }] })),
            yield* Effect.flip(
              docs.createDraft(
                invoiceInput({ lines: [{ description: "  ", unitPrice: dec("1") }] }),
              ),
            ),
          ] as const;
        }),
      ),
    );
    expect((fromName.lines[0] as unknown as { description: string }).description).toBe("Hodina");
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
          const docs = yield* Documents;
          return [
            yield* docs.createDraft(invoiceInput({ contact: DE_BUYER, lines: exempt })),
            yield* Effect.flip(docs.createDraft(invoiceInput({ lines: exempt }))),
          ] as const;
        }),
      ),
    );
    expect(eu.statutoryNotes.map((n) => n.code as unknown as string)).toContain(
      "exempt_intra_eu_goods",
    );
    expect(domestic).toMatchObject({ issues: [{ code: "vat.not_allowed_for_regime" }] });
  });

  test("an identified person cannot use exempt intra-EU goods or standard VAT", async () => {
    const [exemptErr, standardErr] = ok(
      await scenario(
        Effect.gen(function* () {
          const docs = yield* Documents;
          return [
            yield* Effect.flip(
              docs.createDraft(invoiceInput({ contact: DE_BUYER, lines: exempt })),
            ),
            yield* Effect.flip(
              docs.createDraft(
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
          const docs = yield* Documents;
          const repo = yield* DocumentsRepo;
          const store = yield* CoreStore;
          const a = yield* docs.createDraft(
            invoiceInput({ issuedOn: "2026-10-01" as IsoDate, due: { inDays: 14 } }),
          );
          yield* docs.createDraft(invoiceInput({ issuedOn: "2026-11-20" as IsoDate }));
          const row = yield* repo.get(WS, a.id);
          yield* store.transaction(
            repo.update({ ...row, status: "issued", number: "2026-0001" }, 1),
          );
          const ids = (p: { items: ReadonlyArray<unknown> }) =>
            p.items.map((i) => (i as { id: DocumentId }).id);
          return [
            ids(yield* docs.list({ status: "issued" })),
            (yield* docs.list({ settlement: "unpaid" })).items.length,
            (yield* docs.list({ from: "2026-11-01" as IsoDate, to: "2026-11-30" as IsoDate })).items
              .length,
            ids(yield* docs.list({ overdue: true })),
            (yield* docs.list({ overdue: false })).items.length,
          ] as const;
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
          const docs = yield* Documents;
          return [
            yield* Effect.flip(docs.list({ limit: 0 })),
            yield* Effect.flip(docs.list({ cursor: "not-a-cursor" })),
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
          const docs = yield* Documents;
          const view = yield* docs.createDraft(invoiceInput({ kind: "proforma" }));
          yield* docs.pdf(view.id, { language: "en" });
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
    const calls: Array<string> = [];
    const sender = Layer.succeed(
      DocumentSender,
      DocumentSender.of({
        send: (id) =>
          Effect.sync(() => {
            calls.push(`send:${id}`);
            return { deliveryId: "d-1" as DeliveryId, status: "queued" as const };
          }),
        previewSend: (id) =>
          Effect.sync(() => {
            calls.push(`preview:${id}`);
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
        Layer.mergeAll(DocumentsRepoMemory, NumberingTestLayer, DocumentFakesLive, sender),
      ),
    );
    const id = MISSING as DocumentId;
    const exit = await runTest(
      member("owner"),
      Effect.gen(function* () {
        yield* seed();
        const docs = yield* Documents;
        return [yield* docs.send(id), (yield* docs.previewSend(id)).subject] as const;
      }).pipe(Effect.provide(layer)),
    );
    expect(ok(exit)).toEqual([{ deliveryId: "d-1" as DeliveryId, status: "queued" }, "s"]);
    expect(calls).toEqual([`send:${id}`, `preview:${id}`]);
  });

  test("the default sender stub dies clearly", async () => {
    const exit = await scenario(Effect.flatMap(Documents, (d) => d.send(MISSING as DocumentId)));
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("not implemented (stage 2");
  });

  test("linkSchedule sets the occurrence once per schedule (board #450)", async () => {
    const schedule = "01900000-0000-7000-8000-00005c4ed001" as ScheduleId;
    const occurrence = "2026-12-01" as IsoDate;
    const [row, dup] = ok(
      await scenario(
        Effect.gen(function* () {
          const docs = yield* Documents;
          const repo = yield* DocumentsRepo;
          const store = yield* CoreStore;
          const a = yield* docs.createDraft(invoiceInput());
          const b = yield* docs.createDraft(invoiceInput({ contact: CZ_BUYER }));
          yield* store.transaction(
            repo.linkSchedule(WS, a.id, { scheduleId: schedule, occurrence }),
          );
          const dup = yield* Effect.flip(
            store.transaction(repo.linkSchedule(WS, b.id, { scheduleId: schedule, occurrence })),
          );
          return [yield* repo.get(WS, a.id), dup] as const;
        }),
      ),
    );
    expect([row.scheduleId, row.occurrence, row.revision]).toEqual([schedule, occurrence, 2]);
    expect(dup).toBeInstanceOf(UniqueViolation);
    expect((dup as UniqueViolation).constraint).toBe(SCHEDULE_OCCURRENCE);
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
        currency: "CZK" as never,
        vat,
        archived: false,
        revision: 1,
      }),
    );

  test("a copied CZK price cannot silently become EUR on a currency edit", async () => {
    const [created, edited] = ok(
      await scenario(
        Effect.gen(function* () {
          yield* putItem();
          const docs = yield* Documents;
          const view = yield* docs.createDraft(invoiceInput({ lines: [{ item: ITEM }] }));
          return [view, yield* Effect.flip(docs.edit(view.id, { currency: EUR }, 1))] as const;
        }),
        { fixings: [fixing("2026-11-20", "25")] },
      ),
    );
    expect(str(created.totals.gross.amount)).toBe("121");
    expect(edited).toMatchObject({
      _tag: "Invalid",
      issues: [{ path: ["lines", 0, "unitPrice"], params: { currency: "CZK" } }],
    });
  });

  test("a net catalog price is grossed up when prices include VAT (100 net -> 121 gross)", async () => {
    const [inclusive, toggled] = ok(
      await scenario(
        Effect.gen(function* () {
          yield* putItem();
          const docs = yield* Documents;
          const inclusive = yield* docs.preview(
            invoiceInput({ lines: [{ item: ITEM }], pricesIncludeVat: true }),
          );
          const draft = yield* docs.createDraft(invoiceInput({ lines: [{ item: ITEM }] }));
          const toggled = yield* docs.edit(draft.id, { pricesIncludeVat: true }, 1);
          return [inclusive, toggled] as const;
        }),
      ),
    );
    for (const view of [inclusive, toggled]) {
      expect(str(view.totals.net.amount)).toBe("100");
      expect(str(view.totals.vat.amount)).toBe("21");
      expect(str(view.totals.gross.amount)).toBe("121");
    }
  });

  test("an identified person's reverse charge needs a buyer in another EU state", async () => {
    const err = ok(
      await scenario(
        Effect.gen(function* () {
          const us = "01900000-0000-7000-8000-0000c00000u5".replace("u5", "05") as never;
          yield* (yield* DocumentFixtures).putContact(
            WS,
            contact(us, { country: "US", dic: "12-3456789" }),
          );
          return yield* Effect.flip(
            (yield* Documents).createDraft(
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

  test("a missing Issuing Entity is NotFound{Workspace}, not a defect", async () => {
    const err = ok(
      await scenario(
        Effect.gen(function* () {
          yield* Ref.update((yield* DocumentFixtures).issuers, () => new Map());
          return yield* Effect.flip((yield* Documents).createDraft(invoiceInput()));
        }),
      ),
    );
    expect(err).toEqual(new NotFound({ entity: "Workspace", id: WS }));
  });

  test("a computed due date beyond 9999-12-31 is Invalid at due", async () => {
    const err = ok(
      await scenario(
        Effect.flip(
          Effect.flatMap(Documents, (d) =>
            d.preview(invoiceInput({ due: { inDays: 10_000_000 } })),
          ),
        ),
      ),
    );
    expect(err).toMatchObject({ _tag: "Invalid", issues: [{ path: ["due"] }] });
  });

  test("payment QR (rule D12): SPAYD for CZK with IBAN, EPC for EUR, none otherwise", async () => {
    const [czk, eur, usd] = ok(
      await scenario(
        Effect.gen(function* () {
          const docs = yield* Documents;
          return [
            yield* docs.createDraft(invoiceInput({ variableSymbol: "20260001" })),
            yield* docs.createDraft(
              invoiceInput({ currency: EUR, lines: [{ description: "x", unitPrice: dec("10") }] }),
            ),
            yield* docs.createDraft(
              invoiceInput({
                currency: "USD" as never,
                fx: { manual: { rate: dec("23"), quantity: 1 } },
              }),
            ),
          ] as const;
        }),
        { fixings: [fixing("2026-11-20", "25")] },
      ),
    );
    expect(czk.paymentQr).toEqual({
      format: "spayd",
      payload:
        "SPD*1.0*ACC:CZ1801000000000123456789*AM:2980.00*CC:CZK*DT:20261207*X-VS:20260001*RN:DODAVATEL S.R.O.",
    });
    expect(eur.paymentQr?.format).toBe("epc");
    // EPC069-12 §2.2: an unnumbered draft's payload ends right after the amount.
    expect(eur.paymentQr?.payload).toBe(
      [
        "BCD",
        "002",
        "1",
        "SCT",
        "KOMBCZPP",
        "Dodavatel s.r.o.",
        "CZ6701000000000987654321",
        "EUR12.10",
      ].join("\n"),
    );
    expect(usd.paymentQr).toBeNull();
  });

  test("admins and write-scoped members can draft", async () => {
    const [admin, writer] = ok(
      await scenario(
        Effect.gen(function* () {
          const docs = yield* Documents;
          return [
            (yield* as(member("admin"), docs.createDraft(invoiceInput()))).status,
            (yield* as(
              member("member", { scopes: ["documents:write"] }),
              docs.createDraft(invoiceInput()),
            )).status,
          ] as const;
        }),
      ),
    );
    expect([admin, writer]).toEqual(["draft", "draft"]);
  });
});

describe("review round 2 regressions (payment QR inputs)", () => {
  test("an explicit variable symbol is kept exactly; a non 1-10 digit one is Invalid", async () => {
    const [kept, tooLong, letters] = ok(
      await scenario(
        Effect.gen(function* () {
          const docs = yield* Documents;
          return [
            yield* docs.preview(invoiceInput({ variableSymbol: "0012345678" })),
            yield* Effect.flip(docs.preview(invoiceInput({ variableSymbol: "12345678901" }))),
            yield* Effect.flip(docs.createDraft(invoiceInput({ variableSymbol: "VS-1" }))),
          ] as const;
        }),
      ),
    );
    expect(kept.paymentQr?.payload).toContain("*X-VS:0012345678*");
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
  });

  test("an IBAN failing mod-97 is Invalid and the draft is not stored", async () => {
    const [err, listed] = ok(
      await scenario(
        Effect.gen(function* () {
          const f = yield* DocumentFixtures;
          const current = (yield* Ref.get(f.issuers)).get(WS);
          if (!current) return yield* Effect.die("seed missing");
          yield* f.putIssuer({
            ...current,
            bankAccounts: current.bankAccounts.map((a) => ({
              ...a,
              iban: "CZ6501000000000123456789",
            })),
          });
          const docs = yield* Documents;
          const err = yield* Effect.flip(docs.createDraft(invoiceInput()));
          return [err, (yield* docs.list({})).items.length] as const;
        }),
      ),
    );
    expect(err).toMatchObject({
      _tag: "Invalid",
      issues: [{ path: ["bankAccount"], params: { field: "iban" } }],
    });
    expect(listed).toBe(0);
  });

  test("D12 exception: above the format maximum or nothing to pay gives no QR, not Invalid", async () => {
    const [czkLarge, eurLarge, zero] = ok(
      await scenario(
        Effect.gen(function* () {
          const docs = yield* Documents;
          const big = (price: string) =>
            [{ description: "x", unitPrice: dec(price), vat: "outside_scope" as const }] as const;
          return [
            yield* docs.createDraft(invoiceInput({ lines: big("10000000") })),
            yield* docs.createDraft(invoiceInput({ currency: EUR, lines: big("1000000000") })),
            yield* docs.createDraft(
              invoiceInput({
                currency: EUR,
                lines: [{ description: "Zdarma", unitPrice: dec("0") }],
              }),
            ),
          ] as const;
        }),
        { fixings: [fixing("2026-11-20", "25")] },
      ),
    );
    expect(str(czkLarge.totals.gross.amount)).toBe("10000000");
    for (const view of [czkLarge, eurLarge, zero]) {
      expect(view.status).toBe("draft");
      expect(view.paymentQr).toBeNull();
    }
  });
});

describe("review round 3 regressions", () => {
  test("an IBAN of the wrong length for its country is Invalid even with a passing checksum", async () => {
    const [err, listed] = ok(
      await scenario(
        Effect.gen(function* () {
          const f = yield* DocumentFixtures;
          const current = (yield* Ref.get(f.issuers)).get(WS);
          if (!current) return yield* Effect.die("seed missing");
          yield* f.putIssuer({
            ...current,
            bankAccounts: current.bankAccounts.map((a) => ({
              ...a,
              iban: "CZ18001000000000123456789",
            })),
          });
          const docs = yield* Documents;
          const err = yield* Effect.flip(docs.createDraft(invoiceInput()));
          return [err, (yield* docs.list({})).items.length] as const;
        }),
      ),
    );
    expect(err).toMatchObject({
      _tag: "Invalid",
      issues: [
        { path: ["bankAccount"], code: "request.malformed", params: { reason: "iban_invalid" } },
      ],
    });
    expect(listed).toBe(0);
  });
});

describe("store outages", () => {
  test("a StoreUnavailable from the repo is Unavailable{database} on reads and discard", async () => {
    const failing = Layer.effect(
      DocumentsRepo,
      Effect.map(DocumentsRepo, (repo) =>
        DocumentsRepo.of({
          ...repo,
          get: () => Effect.fail(new StoreUnavailable({})),
          getForUpdate: () => Effect.fail(new StoreUnavailable({})),
          search: () => Effect.fail(new StoreUnavailable({})),
        }),
      ),
    ).pipe(Layer.provide(DocumentsRepoMemory));
    const layer = DocumentsLive.pipe(
      Layer.provideMerge(
        Layer.mergeAll(failing, NumberingTestLayer, DocumentFakesLive, DocumentSenderStub),
      ),
    );
    const id = MISSING as DocumentId;
    const exit = await runTest(
      member("owner"),
      Effect.gen(function* () {
        yield* seed();
        const docs = yield* Documents;
        return [
          yield* Effect.flip(docs.get(id)),
          yield* Effect.flip(docs.list({})),
          yield* Effect.flip(docs.history(id)),
          yield* Effect.flip(docs.discardDraft(id, 1)),
        ] as const;
      }).pipe(Effect.provide(layer)),
    );
    for (const err of ok(exit)) {
      expect(err as unknown).toEqual(new Unavailable({ dependency: "database" }));
    }
  });
});
