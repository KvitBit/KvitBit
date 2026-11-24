/**
 * R4: one read-through FX fixing service for the whole core (core-ports 6, L1230, L1438). On
 * TestCore (CoreModulesLive wiring), a fixing Reports fetched once stays readable for Documents,
 * DocumentPayments and Expenses while CNB is down; an uncached date still fails honestly.
 */
import { describe, expect, test } from "bun:test";
import type { IsoDate } from "@kvitbit/domain/contract";
import { Documents, Expenses, Reports, Unavailable } from "@kvitbit/domain/contract";
import { Effect, Exit, Ref } from "effect";
import { FixtureRates } from "../../src/testing";
import {
  dec,
  docId,
  EUR,
  expenseFields,
  expenseInput,
  inWorkspace,
  issueInvoice,
  ok,
  payDocument,
  str,
  TODAY,
} from "./payments-flow-fixtures";

describe("FX fixings read through one shared cache", () => {
  test("Documents, Payment Tax Documents and Expenses reuse a fixing Reports fetched", async () => {
    const r = ok(
      await inWorkspace(({ customer, supplier }) =>
        Effect.gen(function* () {
          const rate = yield* Effect.flatMap(Reports, (rep) =>
            rep.fxRate({ currency: EUR, on: TODAY }),
          );
          yield* Ref.set((yield* FixtureRates).unavailable, true);

          const invoice = yield* issueInvoice(customer, {
            currency: EUR,
            lines: [{ description: "Služby", unitPrice: dec("100") }],
          } as never);
          const proforma = yield* issueInvoice(customer, {
            kind: "proforma",
            currency: EUR,
            lines: [{ description: "Služby", unitPrice: dec("100") }],
          } as never);
          yield* payDocument(docId(proforma), "121", EUR);
          const ptds = yield* Effect.flatMap(Documents, (d) =>
            d.list({ kind: "payment_tax_document" } as never),
          );
          const expense = expenseFields(
            yield* Effect.flatMap(Expenses, (e) =>
              e.record({ ...expenseInput(supplier), currency: "EUR" } as never),
            ),
          );
          const uncached = yield* Effect.exit(
            Effect.flatMap(Reports, (rep) =>
              rep.fxRate({ currency: EUR, on: "2026-11-02" as IsoDate }),
            ),
          );
          return { rate, invoice, ptds, expense, uncached };
        }),
      ),
    );
    expect(str(r.rate.rate)).toBe("25");
    const fxOf = (v: unknown) => (v as { readonly fx: { readonly rate: never } | null }).fx;
    expect(str(fxOf(r.invoice)?.rate ?? dec("0"))).toBe("25");
    const ptd = (r.ptds as unknown as { readonly items: ReadonlyArray<unknown> }).items;
    expect(ptd.length).toBe(1);
    expect(r.expense.fx?.fixingDate).toBe(TODAY);
    expect(r.uncached).toEqual(Exit.fail(new Unavailable({ dependency: "exchange_rates" })));
  });
});
