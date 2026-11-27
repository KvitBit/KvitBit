/**
 * R4: one read-through FX fixing service for the whole core (core-ports 6, L1230, L1438). On
 * TestCore (CoreModulesLive wiring), a fixing Reports fetched once stays readable for Documents,
 * DocumentPayments and Expenses while CNB is down; an uncached date still fails honestly. Dry
 * runs read through it without writing (core-ports 4: dry runs write nothing).
 */
import { describe, expect, test } from "bun:test";
import type { DocumentInput } from "@kvitbit/domain/contract";
import { Documents, Expenses, IsoDate, Reports, Unavailable } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { FxFixingCache } from "../../src";
import { FixtureRates } from "../../src/testing";
import { withoutStackTrace } from "../helpers/run";
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

          const invoice = yield* issueInvoice({
            contact: customer,
            currency: EUR,
            lines: [{ description: "Služby", unitPrice: dec("100") }],
          });
          const proforma = yield* issueInvoice({
            contact: customer,
            kind: "proforma",
            currency: EUR,
            lines: [{ description: "Služby", unitPrice: dec("100") }],
          });
          yield* payDocument({ document: docId(proforma), amount: "121", currency: EUR });
          const ptds = yield* Effect.flatMap(Documents, (d) =>
            d.list({ kind: "payment_tax_document" }),
          );
          const flatMapResult = yield* Effect.flatMap(Expenses, (e) =>
            e.record({ ...expenseInput(supplier), currency: "EUR" }),
          );
          const expense = expenseFields(flatMapResult);
          const uncached = yield* Effect.exit(
            Effect.flatMap(Reports, (rep) =>
              rep.fxRate({ currency: EUR, on: IsoDate.make("2026-11-02") }),
            ),
          );
          return { rate, invoice, ptds, expense, uncached };
        }),
      ),
    );
    r.rate.rate.pipe(str, expect).toBe("25");
    (r.invoice.fx?.rate ?? dec("0")).pipe(str, expect).toBe("25");
    expect(r.ptds.items).toHaveLength(1);
    expect(r.expense.fx?.fixingDate).toBe(TODAY);
    expect(r.uncached.pipe(withoutStackTrace)).toEqual(
      Exit.fail(Unavailable.make({ dependency: "exchange_rates" })),
    );
  });

  test("a foreign-currency preview fetches the fixing without caching it; issuing caches it", async () => {
    const r = ok(
      await inWorkspace(({ customer }) =>
        Effect.gen(function* () {
          const cache = yield* FxFixingCache;
          const input: DocumentInput = {
            kind: "invoice",
            contact: customer,
            currency: EUR,
            issuedOn: TODAY,
            lines: [{ description: "Služby", unitPrice: dec("100") }],
          };
          const before = yield* cache.get(TODAY);
          const preview = yield* Effect.flatMap(Documents, (d) => d.preview(input));
          const afterPreview = yield* cache.get(TODAY);
          const invoice = yield* issueInvoice({
            contact: customer,
            currency: EUR,
            lines: [{ description: "Služby", unitPrice: dec("100") }],
          });
          const afterIssue = yield* cache.get(TODAY);
          return { before, preview, afterPreview, invoice, afterIssue };
        }),
      ),
    );
    (r.preview.fx?.rate ?? dec("0")).pipe(str, expect).toBe("25");
    expect(r.before).toEqual(Option.none());
    expect(r.afterPreview).toEqual(Option.none());
    (r.invoice.fx?.rate ?? dec("0")).pipe(str, expect).toBe("25");
    expect(Option.isSome(r.afterIssue)).toBe(true);
  });
});
