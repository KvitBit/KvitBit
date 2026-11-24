/**
 * Cross-module Documents scenarios on TestCore: onboarding (Workspaces, Contacts from ARES,
 * PriceList), a EUR Invoice on a weekend tax point with numbering and a number override, and the
 * vat_payer advance flow (Proforma, Payment, auto-sent PTD, Final Invoice, Credit Note).
 */
import { describe, expect, test } from "bun:test";
import type { ContactView, DocumentId, DocumentView, IsoDate } from "@kvitbit/domain/contract";
import { Contacts, Documents, Payments, PriceList, Workspaces } from "@kvitbit/domain/contract";
import { Effect, Exit, Ref } from "effect";
import { StartedDeliveries } from "../../src/testing";
import { account, asCaller, runCore } from "../helpers";
import {
  amounts,
  BUYER_ICO,
  buckets,
  buyerRecord,
  CZK,
  dec,
  EUR,
  fixing,
  onboard,
  registry,
  str,
} from "./documents-fixtures";

const ok = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${JSON.stringify(exit.cause)}`);
  return exit.value;
};

describe("onboarding", () => {
  test("an Account creates a Workspace, adds a Contact from ARES and a Price List Item", async () => {
    const result = ok(
      await runCore(
        account(),
        Effect.gen(function* () {
          const ws = yield* Workspaces;
          const owner = yield* ws.create({ name: "Kvitbit s.r.o." } as never);
          return yield* asCaller(
            owner,
            Effect.gen(function* () {
              const current = yield* ws.current;
              const contact = yield* Effect.flatMap(Contacts, (c) => c.fromIco(BUYER_ICO));
              const priceList = yield* PriceList;
              const item = yield* priceList.save({
                name: "Konzultace",
                unit: "h",
                unitPrice: dec("1500"),
                currency: CZK,
                vat: "standard",
              } as never);
              const items = yield* priceList.list();
              const found = yield* Effect.flatMap(Contacts, (c) => c.search({ text: "Odběratel" }));
              return { owner, current, contact, item, items, found };
            }),
          );
        }),
        { registry },
      ),
    );
    expect(result.owner).toMatchObject({ _tag: "Member", role: "owner" });
    expect(result.current.name).toBe("Kvitbit s.r.o.");
    const contact = result.contact as ContactView & Record<string, unknown>;
    expect(contact).toMatchObject({
      ico: BUYER_ICO,
      name: buyerRecord.name,
      dic: buyerRecord.dic,
      address: buyerRecord.address,
    });
    expect(result.found.items.map((c) => c.id)).toEqual([contact.id]);
    expect(result.item).toMatchObject({ name: "Konzultace", unit: "h", vat: "standard" });
    expect(str(result.item.unitPrice as never)).toBe("1500");
    expect(result.items.map((i) => i.id)).toEqual([result.item.id]);
  });
});

describe("EUR invoice on a weekend tax point", () => {
  test("uses the prior working day's CNB fixing, CZK VAT per bucket, and numbering skips an override", async () => {
    // Fixings: Thursday, Friday, then Monday; none for the weekend of 21-22 Nov 2026.
    const fixings = [
      fixing("2026-11-19", "24.900"),
      fixing("2026-11-20", "25.000"),
      fixing("2026-11-23", "25.500"),
    ];
    const result = ok(
      await runCore(
        account(),
        Effect.gen(function* () {
          const { owner, buyer } = yield* onboard("vat_payer");
          return yield* asCaller(
            owner,
            Effect.gen(function* () {
              const docs = yield* Documents;
              const input = (extra: object = {}) =>
                ({
                  kind: "invoice",
                  contact: buyer,
                  currency: EUR,
                  issuedOn: "2026-11-23",
                  taxableSupplyOn: "2026-11-21", // Saturday
                  lines: [
                    { description: "Vývoj", quantity: dec("10"), unitPrice: dec("100") },
                    { description: "Kniha", unitPrice: dec("50"), vat: "reduced" },
                  ],
                  ...extra,
                }) as never;
              const eur = yield* docs.issue({ input: input() });
              const second = yield* docs.issue({ input: input() });
              const overridden = yield* docs.edit(
                second.id,
                { number: "2026-0003" },
                second.revision,
              );
              const next = yield* docs.issue({ input: input({ currency: CZK }) });
              const duplicate = yield* Effect.flip(
                docs.edit(next.id, { number: eur.number as string }, next.revision),
              );
              return { eur, second, overridden, next, duplicate };
            }),
          );
        }),
        { registry, fixings },
      ),
    );
    const { eur } = result;
    expect(eur.dates).toMatchObject({ issuedOn: "2026-11-23", taxableSupplyOn: "2026-11-21" });
    expect(eur.fx).toMatchObject({ fixingDate: "2026-11-20", source: "cnb", quantity: 1 });
    expect(str(eur.fx?.rate ?? dec("0"))).toBe("25");
    expect(buckets(eur)).toEqual([
      ["standard", "21", "1000", "210", "1210", "5250"],
      ["reduced", "12", "50", "6", "56", "150"],
    ]);
    expect(eur.totals.gross.currency).toBe(EUR);
    expect(str(eur.totals.vatCzk?.amount ?? dec("0"))).toBe("5400");
    // Numbering: next in series, override keeps the old number reserved and is skipped.
    expect([eur.number, result.second.number]).toEqual(["2026-0001", "2026-0002"]);
    expect(result.overridden.number).toBe("2026-0003");
    expect(result.next.number).toBe("2026-0004");
    expect(result.duplicate).toMatchObject({ _tag: "Conflict", reason: "duplicate" });
  });
});

describe("vat_payer advance flow", () => {
  /**
   * Onboards a vat_payer Workspace with PTD auto-send `autoSend`, issues a CZK Proforma and
   * records a payment covering it through Payments, then runs `after` on the Proforma.
   */
  const advance = <A, E, R>(
    autoSend: boolean,
    after: (proforma: DocumentView) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const { owner, buyer } = yield* onboard("vat_payer");
      return yield* asCaller(
        owner,
        Effect.gen(function* () {
          const ws = yield* Workspaces;
          const current = yield* ws.current;
          yield* ws.updateSettings(
            { defaults: { paymentTaxDocumentAutoSend: autoSend } } as never,
            current.revision,
          );
          const docs = yield* Documents;
          const proforma = yield* docs.issue({
            input: {
              kind: "proforma",
              contact: buyer,
              issuedOn: "2026-11-23" as IsoDate,
              lines: [{ description: "Záloha na vývoj", unitPrice: dec("1000") }],
            },
          });
          const recorded = yield* Effect.flatMap(Payments, (p) =>
            p.record({ target: { document: proforma.id } }),
          );
          const ptd = yield* docs.get((recorded.issued[0] as DocumentView).id);
          const started = yield* Effect.flatMap(StartedDeliveries, Ref.get);
          return { proforma, recorded, ptd, started, after: yield* after(proforma) };
        }),
      );
    });

  test("paying a Proforma issues a PTD in its series and auto-sends it; the Final Invoice deducts it; a Credit Note reverses it", async () => {
    const result = ok(
      await runCore(
        account(),
        advance(true, (proforma) =>
          Effect.gen(function* () {
            const docs = yield* Documents;
            const finalInvoice = yield* docs.issueFinalInvoice(proforma.id, {
              patch: {
                lines: [
                  { description: "Vývoj", unitPrice: dec("1000") },
                  { description: "Vícepráce", unitPrice: dec("500") },
                ],
              },
            });
            const creditNote = yield* docs.correct(finalInvoice.id, {
              reason: "dobropis",
              lines: "full",
            });
            return {
              proforma: yield* docs.get(proforma.id),
              finalInvoice,
              creditNote,
              credited: yield* docs.get(finalInvoice.id),
            };
          }),
        ),
        { registry },
      ),
    );
    const { recorded, ptd, started } = result;
    const { proforma, finalInvoice, creditNote, credited } = result.after;
    // The payment covers the Proforma; the PTD is numbered in the PTD series (DD-YYYY-NNNN).
    expect(proforma.number).toBe("ZF-2026-0001");
    expect(recorded.settlement).toBe("paid");
    expect(recorded.issued.map((d) => d.id)).toEqual([ptd.id]);
    expect(ptd.kind).toBe("payment_tax_document");
    expect(ptd.number).toMatch(/^DD-2026-\d{4}$/);
    expect(ptd.number).toBe("DD-2026-0001");
    expect(ptd.taxDocument).toBe(true);
    expect(amounts(ptd)).toEqual({ net: "1000", vat: "210", gross: "1210" });
    expect(ptd.related.map((r) => [r.relation, r.id])).toEqual([["advance_of", proforma.id]]);
    // Auto-sent through the real DocumentSender: a delivery row and a started delivery job.
    expect(ptd.deliveries).toHaveLength(1);
    expect(ptd.deliveries[0]).toMatchObject({
      purpose: "document",
      to: ["fakturace@odberatel.cz"],
    });
    expect(started.map((s) => s.deliveryId)).toEqual(ptd.deliveries.map((d) => d.id));
    // Final Invoice: the full supply less the advance; only the extra work remains due.
    expect(finalInvoice.kind).toBe("invoice");
    expect(finalInvoice.number).toBe("2026-0001");
    const fiLines = finalInvoice.lines as unknown as ReadonlyArray<{
      readonly deducts: DocumentId | null;
      readonly quantity: never;
      readonly unitPrice: never;
    }>;
    expect(fiLines.map((l) => [str(l.quantity), str(l.unitPrice), l.deducts])).toEqual([
      ["1", "1000", null],
      ["1", "500", null],
      ["-1", "1000", ptd.id],
    ]);
    expect(amounts(finalInvoice)).toEqual({ net: "500", vat: "105", gross: "605" });
    expect(finalInvoice.settlement).toBe("unpaid");
    expect(finalInvoice.related.map((r) => [r.relation, r.id])).toEqual([
      ["advance_of", proforma.id],
      ["deducts", ptd.id],
    ]);
    // Credit Note: signed (negative) totals, linked both ways; the invoice is credited.
    expect(creditNote.kind).toBe("credit_note");
    expect(creditNote.number).toBe("OD-2026-0001");
    expect(amounts(creditNote)).toEqual({ net: "-500", vat: "-105", gross: "-605" });
    expect(creditNote.related).toEqual([
      {
        relation: "corrects",
        id: finalInvoice.id,
        kind: "invoice",
        number: finalInvoice.number as string,
      },
    ]);
    expect(credited.settlement).toBe("credited");
    expect(credited.related.map((r) => [r.relation, r.id])).toContainEqual([
      "corrected_by",
      creditNote.id,
    ]);
  });

  test("with PTD auto-send off, the PTD is issued and nothing is delivered", async () => {
    const { recorded, ptd, started } = ok(
      await runCore(
        account(),
        advance(false, () => Effect.void),
        { registry },
      ),
    );
    expect(recorded.issued.map((d) => d.id)).toEqual([ptd.id]);
    expect(ptd.number).toBe("DD-2026-0001");
    expect(ptd.deliveries).toEqual([]);
    expect(started).toEqual([]);
  });
});
