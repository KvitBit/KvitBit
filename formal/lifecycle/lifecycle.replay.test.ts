/**
 * Replays DocumentLifecycle.tla traces on the real core (TestCore: every module on real layers
 * over the in-memory store). Each test walks the shortest path to one model action through the
 * `Documents` and `Payments` service tags, asserts the outcome the model's guard predicts, and
 * checks the model's invariants on the real state after every step (`Lab.check`).
 *
 * The memory store serializes transactions (store/memory.ts:4-8), so the H2 interleaving runs
 * here as its two serial orders; the in-flight overlap the model explores needs Postgres row
 * locks and belongs to a pg-contention test (see the verify-document-lifecycle skill).
 *
 * Crash points use the injectable failure the PTD and Final Invoice paths reach: the CNB fixing
 * (`FixtureRates.unavailable`) for a EUR Proforma.
 */
import { describe, expect, test } from "bun:test";
import { FixtureRates, TestCore, type TestCoreServices } from "@kvitbit/core/testing";
import type {
  ContactId,
  CurrencyCode,
  DocumentId,
  DocumentPatch,
  DocumentView,
  IsoDate,
  LineId,
  PaymentId,
  TaxRegime,
} from "@kvitbit/domain/contract";
import {
  Caller,
  Contacts,
  CurrentCaller,
  Documents,
  MoneyMath,
  Payments,
  Workspaces,
} from "@kvitbit/domain/contract";
import type { CnbFixing } from "@kvitbit/domain/ports";
import { BigDecimal, Effect, Exit, Layer, Ref } from "effect";
import { TestClock } from "effect/testing";

const TEST_NOW = Date.UTC(2026, 10, 23, 9, 0, 0);
const CZK = "CZK" as CurrencyCode;
const EUR = "EUR" as CurrencyCode;
const ICO = "27082440";
const dec = (s: string) => BigDecimal.fromStringUnsafe(s);
const str = (d: BigDecimal.BigDecimal) => BigDecimal.format(BigDecimal.normalize(d));
const fixing = (date: string, eur: string): CnbFixing => ({
  fixingDate: date as IsoDate,
  sequence: 1,
  rates: [{ code: EUR, quantity: 1, rate: dec(eur) }],
});

type Env = TestCoreServices | CurrentCaller;
type Fx<A> = Effect.Effect<A, unknown, Env>;

// The core's error shapes, as far as the assertions need them.
interface Failure {
  readonly _tag?: string;
  readonly reason?: string;
  readonly detail?: string;
  readonly issues?: ReadonlyArray<{ readonly code: string }>;
}

interface LineRow {
  readonly id: LineId;
  readonly deducts: DocumentId | null;
  readonly unitPrice: BigDecimal.BigDecimal;
  readonly treatment: string;
}
const linesOf = (d: DocumentView) => d.lines as unknown as ReadonlyArray<LineRow>;
const related = (d: DocumentView, relation: string) =>
  d.related.filter((r) => r.relation === relation).map((r) => r.id as DocumentId);
const bucketKey = (b: {
  readonly treatment: string;
  readonly ratePercent: BigDecimal.BigDecimal;
}) => `${b.treatment}|${str(b.ratePercent)}`;

/** A payment the harness recorded: where it was booked, its PTD, and what deducted it. */
interface Booked {
  readonly id: PaymentId;
  readonly on: DocumentId;
  readonly ptd: DocumentId | null;
  removed: boolean;
  /** Live on the Proforma when its Final Invoice was issued (the model's fi.deducted). */
  deductedByFinal: boolean;
}

/**
 * One Workspace's Proforma chain with the model's bookkeeping. Every step method runs the real
 * service and returns its Exit; `check` asserts the model's invariants on the stored state.
 */
class Lab {
  readonly payments: Array<Booked> = [];
  proforma: DocumentId | null = null;
  constructor(
    readonly vat: boolean,
    readonly customer: ContactId,
  ) {}

  issueProforma(currency: CurrencyCode = CZK): Fx<DocumentView> {
    const lines = this.vat
      ? [
          { description: "Vývoj", unitPrice: dec("1000") },
          { description: "Kniha", unitPrice: dec("500"), vat: "reduced" },
        ]
      : [{ description: "Vývoj", unitPrice: dec("1500") }];
    return Effect.flatMap(Documents, (d) =>
      d.issue({
        input: {
          kind: "proforma",
          contact: this.customer,
          currency,
          issuedOn: "2026-11-23" as IsoDate,
          lines,
        } as never,
      }),
    ).pipe(Effect.tap((v) => Effect.sync(() => (this.proforma = v.id as DocumentId))));
  }

  get p(): DocumentId {
    if (this.proforma === null) throw new Error("no Proforma yet");
    return this.proforma;
  }

  /** Payments.record naming `target` (default the Proforma), half the Proforma by default. */
  pay(amount = "885", target?: DocumentId, paidOn?: string, currency: CurrencyCode = CZK) {
    const self = this;
    return Effect.gen(function* () {
      const result = yield* (yield* Payments).record({
        target: { document: target ?? self.p },
        amount: MoneyMath.make(dec(amount), currency),
        ...(paidOn === undefined ? {} : { paidOn: paidOn as IsoDate }),
      });
      const view = result.payment as unknown as {
        readonly id: PaymentId;
        readonly target: { readonly document: DocumentId };
        readonly taxDocument: DocumentId | null;
      };
      self.payments.push({
        id: view.id,
        on: view.target.document,
        ptd: view.taxDocument,
        removed: false,
        deductedByFinal: false,
      });
      return { ...result, booked: self.payments[self.payments.length - 1] as Booked };
    });
  }

  remove(booked: Booked) {
    return Effect.flatMap(Payments, (p) => p.remove(booked.id, "vrácení")).pipe(
      Effect.tap(() => Effect.sync(() => (booked.removed = true))),
    );
  }

  issueFinal(patch?: DocumentPatch) {
    const self = this;
    return Effect.gen(function* () {
      const fi = yield* (yield* Documents).issueFinalInvoice(
        self.p,
        patch === undefined ? undefined : { patch },
      );
      for (const b of self.payments) if (!b.removed && b.on === self.p) b.deductedByFinal = true;
      return fi;
    });
  }

  finalId(): Fx<DocumentId | null> {
    return Effect.map(this.get(this.p), (p) => related(p, "final_invoice_for")[0] ?? null);
  }

  get(id: DocumentId) {
    return Effect.flatMap(Documents, (d) => d.get(id));
  }

  correct(id: DocumentId, lines: "full" | ReadonlyArray<{ readonly line: LineId }>) {
    return Effect.flatMap(Documents, (d) => d.correct(id, { reason: "oprava", lines } as never));
  }

  cancel(id: DocumentId) {
    return Effect.flatMap(Documents, (d) => d.cancel(id, { reason: "storno" }));
  }

  lock(id: DocumentId) {
    return Effect.flatMap(Documents, (d) => d.lock(id));
  }

  unlock(id: DocumentId) {
    return Effect.flatMap(Documents, (d) => d.unlock(id, "oprava"));
  }

  editLines(id: DocumentId) {
    const self = this;
    return Effect.gen(function* () {
      const current = yield* self.get(id);
      return yield* (yield* Documents).edit(
        id,
        { lines: [{ description: "Vývoj", unitPrice: dec("1500") }] } as never,
        current.revision,
      );
    });
  }

  /** The uncredited base per bucket of `doc` (its buckets plus its Credit Notes'). */
  remaining(doc: DocumentView): Fx<Map<string, string>> {
    const self = this;
    return Effect.gen(function* () {
      const sums = new Map<string, BigDecimal.BigDecimal>();
      const add = (d: DocumentView) => {
        for (const b of d.totals.buckets) {
          const k = bucketKey(b);
          sums.set(k, BigDecimal.sum(sums.get(k) ?? dec("0"), b.base));
        }
      };
      add(doc);
      for (const cn of related(doc, "corrected_by")) add(yield* self.get(cn));
      return new Map(
        [...sums].filter(([, v]) => !BigDecimal.isZero(v)).map(([k, v]) => [k, str(v)]),
      );
    });
  }

  /** The model's invariants (DocumentLifecycle.tla, "Properties") on the real state. */
  check(): Fx<void> {
    const self = this;
    return Effect.gen(function* () {
      if (self.proforma === null) return;
      const docs = yield* Documents;
      const payments = yield* Payments;
      const p = yield* docs.get(self.p);
      const finals = related(p, "final_invoice_for");
      // OneFinalInvoice
      expect(finals.length).toBeLessThanOrEqual(1);
      const fi = finals[0] === undefined ? null : yield* docs.get(finals[0]);
      const liveOnP = yield* payments.listFor({ document: self.p });
      const liveOnFi =
        fi === null ? [] : yield* payments.listFor({ document: fi.id as DocumentId });
      const ptds = related(p, "tax_document_for");
      // CancelledProformaUnpaid, CancelledIsLocked
      if (p.status === "cancelled") {
        expect(liveOnP).toHaveLength(0);
        expect(fi).toBeNull();
        expect(p.locked).toBe(true);
      }
      // CancelledFinalUnpaid, CancelledIsLocked
      if (fi !== null && fi.status === "cancelled") {
        expect(liveOnFi).toHaveLength(0);
        expect(fi.locked).toBe(true);
      }
      // FinalInvoiceOfPaidProforma
      if (fi !== null) {
        expect(linesOf(fi).some((l) => l.deducts !== null)).toBe(true);
        expect(self.payments.some((b) => b.deductedByFinal)).toBe(true);
      }
      // PtdPerPayment: one PTD of its own per payment booked on a vat_payer's Proforma
      const onP = self.payments.filter((b) => b.on === self.p);
      for (const b of self.payments) {
        expect(b.ptd !== null).toBe(self.vat && b.on === self.p);
      }
      expect([...ptds].sort()).toEqual(onP.flatMap((b) => (b.ptd === null ? [] : [b.ptd])).sort());
      expect(new Set(ptds).size).toBe(ptds.length);
      const fiLive = fi !== null && fi.status === "issued" && fi.settlement !== "credited";
      const fiReversed = fi !== null && (fi.settlement === "credited" || fi.status === "cancelled");
      for (const id of ptds) {
        const ptd = yield* docs.get(id);
        const remaining = yield* self.remaining(ptd);
        // CreditWithinOriginal: per bucket the credits never pass the original's base
        for (const b of ptd.totals.buckets) {
          const left = dec(remaining.get(bucketKey(b)) ?? "0");
          expect(BigDecimal.isNegative(left)).toBe(false);
          expect(BigDecimal.isLessThanOrEqualTo(left, b.base)).toBe(true);
        }
        // DeductionsCurrent (H2): a live Final Invoice deducts exactly the PTD's remainder
        if (fiLive && fi !== null) {
          const deducted = new Map<string, string>();
          for (const l of linesOf(fi).filter((l) => l.deducts === id)) {
            const rate = ptd.totals.buckets.find((b) => b.treatment === l.treatment)?.ratePercent;
            deducted.set(`${l.treatment}|${str(rate ?? dec("0"))}`, str(l.unitPrice));
          }
          expect(deducted).toEqual(remaining);
        }
      }
      // RemovedPaymentReversed
      for (const b of onP.filter((b) => b.removed)) {
        if (b.ptd !== null) expect((yield* docs.get(b.ptd)).settlement).toBe("credited");
        if (b.deductedByFinal) expect(fiReversed).toBe(true);
      }
      // Live payments the harness booked on P are the ones Payments lists.
      const liveIds = new Set(liveOnP.map((v) => (v as unknown as { readonly id: PaymentId }).id));
      for (const b of onP) expect(liveIds.has(b.id)).toBe(!b.removed);
    });
  }

  /** Runs `step` (keeping its Exit) and then `check`. */
  step<A>(step: Fx<A>): Effect.Effect<Exit.Exit<A, unknown>, unknown, Env> {
    return Effect.tap(Effect.exit(step), () => this.check());
  }
}

const value = <A>(exit: Exit.Exit<A, unknown>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${String(exit.cause)}`);
  return exit.value;
};

const failure = (exit: Exit.Exit<unknown, unknown>): Failure => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure, got success");
  const found = exit.cause.reasons.find((r) => r._tag === "Fail");
  if (found === undefined || found._tag !== "Fail")
    throw new Error(`no failure: ${String(exit.cause)}`);
  return found.error as Failure;
};

const conflict = (exit: Exit.Exit<unknown, unknown>, reason: string, detail?: string) => {
  const e = failure(exit);
  expect(e._tag).toBe("Conflict");
  expect(e.reason).toBe(reason);
  if (detail !== undefined) expect(e.detail).toBe(detail);
};

const invalid = (exit: Exit.Exit<unknown, unknown>, code: string) => {
  const e = failure(exit);
  expect(e._tag).toBe("Invalid");
  expect(e.issues?.map((i) => i.code)).toContain(code);
};

/** Runs `body` as the owner of a fresh Workspace with `regime` on a fresh TestCore. */
const replay = async <A>(regime: TaxRegime, body: (lab: Lab) => Fx<A>): Promise<A> => {
  const account = Caller.account({
    userId: "01900000-0000-7000-8000-00000000c001",
    email: "owner@example.cz",
    locale: "cs",
    channel: "web",
  } as never);
  const program = Effect.gen(function* () {
    const owner = yield* Effect.flatMap(Workspaces, (ws) =>
      ws.create({ name: "Alfa Beta s.r.o.", ico: ICO, taxRegime: regime } as never),
    );
    return yield* Effect.provideService(
      Effect.gen(function* () {
        const ws = yield* Workspaces;
        yield* ws.saveBankAccount({
          iban: "CZ65 0800 0000 1920 0014 5399",
          currency: "CZK",
        } as never);
        yield* ws.saveBankAccount({ iban: "DE89370400440532013000", currency: "EUR" } as never);
        const customer = yield* Effect.flatMap(Contacts, (c) =>
          c.save({
            name: "Odběratel a.s.",
            ico: "25596641",
            dic: "CZ25596641",
            address: { city: "Brno", country: "CZ" },
            roles: ["customer"],
            billingEmails: ["fakturace@odberatel.cz"],
          } as never),
        );
        const lab = new Lab(
          regime === "vat_payer",
          (customer as unknown as { readonly id: ContactId }).id,
        );
        return yield* body(lab);
      }),
      CurrentCaller,
      owner as never,
    );
  });
  const exit = await Effect.runPromiseExit(
    Effect.andThen(TestClock.setTime(TEST_NOW), program).pipe(
      Effect.provideService(CurrentCaller, account),
      Effect.provide(
        Layer.merge(
          TestCore({
            registry: {
              [ICO]: {
                name: "Alfa Beta s.r.o.",
                address: { street: "Dlouhá 1", city: "Praha", postalCode: "11000", country: "CZ" },
                dic: "CZ27082440",
                legalForm: "s.r.o.",
                registerEntry: "C 12345 vedená u Městského soudu v Praze",
                terminatedOn: null,
              },
            } as never,
            fixings: [fixing("2026-11-20", "25.000"), fixing("2026-11-23", "25.000")],
          }),
          TestClock.layer(),
        ),
      ),
    ) as Effect.Effect<A, unknown, never>,
  );
  return value(exit);
};

const ptdLine = (ptd: DocumentView, treatment: string) => {
  const line = linesOf(ptd).find((l) => l.treatment === treatment);
  if (line === undefined) throw new Error(`PTD has no ${treatment} line`);
  return [{ line: line.id }];
};

// Proforma lifecycle --------------------------------------------------------------------------

describe("Proforma actions", () => {
  test("IssueProforma, EditProformaLines, Lock/UnlockProforma, CancelProforma", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        const p = value(yield* lab.step(lab.issueProforma()));
        expect(p.status).toBe("issued");
        value(yield* lab.step(lab.editLines(lab.p)));
        value(yield* lab.step(lab.lock(lab.p)));
        // D5: cancel on a locked document fails with document_locked
        conflict(yield* lab.step(lab.cancel(lab.p)), "document_locked");
        value(yield* lab.step(lab.unlock(lab.p)));
        const cancelled = value(yield* lab.step(lab.cancel(lab.p)));
        expect(cancelled.document.status).toBe("cancelled");
        expect(cancelled.document.locked).toBe(true);
        expect(cancelled.creditNote).toBeNull();
        // A cancelled Proforma takes no payment and no Final Invoice.
        conflict(yield* lab.step(lab.pay()), "illegal_transition");
        conflict(yield* lab.step(lab.issueFinal()), "illegal_transition");
      }),
    );
  });

  test("CancelProforma and EditProformaLines are blocked by a payment (D6, D3a)", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        value(yield* lab.step(lab.issueProforma()));
        value(yield* lab.step(lab.pay()));
        conflict(yield* lab.step(lab.cancel(lab.p)), "illegal_transition");
        conflict(yield* lab.step(lab.editLines(lab.p)), "illegal_transition");
        // P4: a locked Proforma still takes payments.
        value(yield* lab.step(lab.lock(lab.p)));
        value(yield* lab.step(lab.pay()));
        expect((yield* lab.get(lab.p)).status).toBe("issued");
      }),
    );
  });
});

// Payments and PTDs ---------------------------------------------------------------------------

describe("Payment actions", () => {
  test("RecordOnProforma issues one PTD per payment for a vat_payer (P2)", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        value(yield* lab.step(lab.issueProforma()));
        const first = value(yield* lab.step(lab.pay()));
        const second = value(yield* lab.step(lab.pay()));
        expect(first.issued).toHaveLength(1);
        expect(second.issued).toHaveLength(1);
        expect(first.booked.ptd).not.toBe(second.booked.ptd);
      }),
    );
  });

  test("RecordOnProforma issues no PTD for a non_vat_payer", async () => {
    await replay("non_vat_payer", (lab) =>
      Effect.gen(function* () {
        value(yield* lab.step(lab.issueProforma()));
        const paid = value(yield* lab.step(lab.pay("700")));
        expect(paid.issued).toHaveLength(0);
        expect(paid.booked.ptd).toBeNull();
      }),
    );
  });

  test("RemovePayment: blocked while the PTD is open, allowed once it is credited (P3)", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        value(yield* lab.step(lab.issueProforma()));
        const { booked } = value(yield* lab.step(lab.pay()));
        conflict(
          yield* lab.step(lab.remove(booked)),
          "illegal_transition",
          "payment.has_tax_document",
        );
        value(yield* lab.step(lab.cancel(booked.ptd as DocumentId)));
        value(yield* lab.step(lab.remove(booked)));
        // Idempotent by state (C6).
        value(yield* lab.step(lab.remove(booked)));
        // No payment left: the Proforma can be cancelled.
        value(yield* lab.step(lab.cancel(lab.p)));
      }),
    );
  });
});

// Final Invoice -------------------------------------------------------------------------------

describe("Final Invoice actions", () => {
  test("FiStart..FiCommit: needs a payment, runs once per Proforma (D8)", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        value(yield* lab.step(lab.issueProforma()));
        invalid(yield* lab.step(lab.issueFinal()), "final_invoice.proforma_unpaid");
        value(yield* lab.step(lab.pay()));
        const fi = value(yield* lab.step(lab.issueFinal()));
        expect(fi.kind).toBe("invoice");
        conflict(yield* lab.step(lab.issueFinal()), "duplicate");
        // D6: a Proforma with a Final Invoice cannot be cancelled.
        conflict(yield* lab.step(lab.cancel(lab.p)), "illegal_transition");
      }),
    );
  });

  test("RecordOnFinal: a payment naming the Proforma after its Final Invoice settles on it", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        value(yield* lab.step(lab.issueProforma()));
        value(yield* lab.step(lab.pay()));
        const fi = value(yield* lab.step(lab.issueFinal()));
        const late = value(yield* lab.step(lab.pay("100")));
        expect(late.booked.on).toBe(fi.id as DocumentId);
        expect(late.issued).toHaveLength(0);
        // The Final Invoice's own payment blocks its cancel (D6), not its removal (P3).
        conflict(yield* lab.step(lab.cancel(fi.id as DocumentId)), "illegal_transition");
        value(yield* lab.step(lab.remove(late.booked)));
      }),
    );
  });

  test("RemovePayment is blocked while a live Final Invoice deducts it (P3)", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        value(yield* lab.step(lab.issueProforma()));
        const { booked } = value(yield* lab.step(lab.pay()));
        const fi = value(yield* lab.step(lab.issueFinal()));
        conflict(
          yield* lab.step(lab.remove(booked)),
          "illegal_transition",
          "payment.has_tax_document",
        );
        // A partial credit leaves the deductions standing.
        const supply = linesOf(fi).find((l) => l.deducts === null) as LineRow;
        value(yield* lab.step(lab.correct(fi.id as DocumentId, [{ line: supply.id }])));
        conflict(
          yield* lab.step(lab.remove(booked)),
          "illegal_transition",
          "payment.has_tax_document",
        );
        // The full remainder reverses them; the PTD is still open, then credited.
        value(yield* lab.step(lab.correct(fi.id as DocumentId, "full")));
        conflict(
          yield* lab.step(lab.remove(booked)),
          "illegal_transition",
          "payment.has_tax_document",
        );
        value(yield* lab.step(lab.correct(booked.ptd as DocumentId, "full")));
        value(yield* lab.step(lab.remove(booked)));
      }),
    );
  });

  test("ReverseFinal via cancel: a tax Final Invoice gets a full Credit Note (D6)", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        value(yield* lab.step(lab.issueProforma()));
        value(yield* lab.step(lab.pay()));
        const fi = value(yield* lab.step(lab.issueFinal()));
        value(yield* lab.step(lab.lock(fi.id as DocumentId)));
        conflict(yield* lab.step(lab.cancel(fi.id as DocumentId)), "document_locked");
        value(yield* lab.step(lab.unlock(fi.id as DocumentId)));
        const cancelled = value(yield* lab.step(lab.cancel(fi.id as DocumentId)));
        expect(cancelled.document.settlement).toBe("credited");
        expect(cancelled.creditNote).not.toBeNull();
        // Credited: no payment lands on it, no second reversal.
        conflict(yield* lab.step(lab.pay("100")), "illegal_transition");
        conflict(yield* lab.step(lab.cancel(fi.id as DocumentId)), "illegal_transition");
      }),
    );
  });

  test("CancelNonTaxFinal: a non_vat_payer's Final Invoice is cancelled; then the cash advance can go", async () => {
    await replay("non_vat_payer", (lab) =>
      Effect.gen(function* () {
        value(yield* lab.step(lab.issueProforma()));
        const { booked } = value(yield* lab.step(lab.pay("700")));
        const fi = value(yield* lab.step(lab.issueFinal()));
        expect(linesOf(fi).some((l) => l.deducts === lab.p)).toBe(true);
        conflict(
          yield* lab.step(lab.remove(booked)),
          "illegal_transition",
          "payment.has_tax_document",
        );
        const cancelled = value(yield* lab.step(lab.cancel(fi.id as DocumentId)));
        expect(cancelled.document.status).toBe("cancelled");
        expect(cancelled.creditNote).toBeNull();
        value(yield* lab.step(lab.remove(booked)));
      }),
    );
  });

  test("CancelNonTaxFinal is blocked once a Credit Note offsets part of it", async () => {
    await replay("non_vat_payer", (lab) =>
      Effect.gen(function* () {
        value(yield* lab.step(lab.issueProforma()));
        value(yield* lab.step(lab.pay("700")));
        const fi = value(yield* lab.step(lab.issueFinal()));
        const supply = linesOf(fi).find((l) => l.deducts === null) as LineRow;
        value(yield* lab.step(lab.correct(fi.id as DocumentId, [{ line: supply.id }])));
        conflict(yield* lab.step(lab.cancel(fi.id as DocumentId)), "illegal_transition");
      }),
    );
  });
});

// Hypothesis H2 and the D7 cap ----------------------------------------------------------------

describe("H2: PTD correction around Final Invoice issue", () => {
  test("correction first: the Final Invoice deducts the PTD's remainder", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        value(yield* lab.step(lab.issueProforma()));
        const { issued } = value(yield* lab.step(lab.pay()));
        const ptd = issued[0] as DocumentView;
        value(yield* lab.step(lab.correct(ptd.id as DocumentId, ptdLine(ptd, "reduced"))));
        const fi = value(yield* lab.step(lab.issueFinal()));
        // Only the standard bucket is left to deduct.
        expect(
          linesOf(fi)
            .filter((l) => l.deducts === ptd.id)
            .map((l) => l.treatment),
        ).toEqual(["standard"]);
      }),
    );
  });

  test("Final Invoice first: the PTD cannot be corrected or cancelled until it is reversed", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        value(yield* lab.step(lab.issueProforma()));
        const { issued } = value(yield* lab.step(lab.pay()));
        const ptd = issued[0] as DocumentView;
        const fi = value(yield* lab.step(lab.issueFinal()));
        conflict(
          yield* lab.step(lab.correct(ptd.id as DocumentId, ptdLine(ptd, "reduced"))),
          "illegal_transition",
        );
        conflict(yield* lab.step(lab.cancel(ptd.id as DocumentId)), "illegal_transition");
        value(yield* lab.step(lab.correct(fi.id as DocumentId, "full")));
        value(yield* lab.step(lab.correct(ptd.id as DocumentId, ptdLine(ptd, "reduced"))));
      }),
    );
  });

  test("CreditOptions: a second credit of the same PTD bucket exceeds the original (D7)", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        value(yield* lab.step(lab.issueProforma()));
        const { issued } = value(yield* lab.step(lab.pay()));
        const ptd = issued[0] as DocumentView;
        value(yield* lab.step(lab.correct(ptd.id as DocumentId, ptdLine(ptd, "reduced"))));
        invalid(
          yield* lab.step(lab.correct(ptd.id as DocumentId, ptdLine(ptd, "reduced"))),
          "credit_note.exceeds_original",
        );
        value(yield* lab.step(lab.correct(ptd.id as DocumentId, ptdLine(ptd, "standard"))));
        expect((yield* lab.get(ptd.id as DocumentId)).settlement).toBe("credited");
        conflict(yield* lab.step(lab.correct(ptd.id as DocumentId, "full")), "illegal_transition");
      }),
    );
  });
});

// Crash points --------------------------------------------------------------------------------

describe("Crash points (FiAbort, a failed RecordOnProforma)", () => {
  const ratesDown = (down: boolean) =>
    Effect.flatMap(FixtureRates, (f) => Ref.set(f.unavailable, down));

  test("a PTD that cannot get its fixing rolls the payment back", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        value(yield* lab.step(lab.issueProforma(EUR)));
        yield* ratesDown(true);
        const exit = yield* Effect.exit(lab.pay("10", undefined, "2026-11-20", EUR));
        expect(Exit.isFailure(exit)).toBe(true);
        yield* lab.check();
        const p = yield* lab.get(lab.p);
        expect(related(p, "tax_document_for")).toEqual([]);
        expect(p.settlement).toBe("unpaid");
        expect(yield* Effect.flatMap(Payments, (x) => x.listFor({ document: lab.p }))).toEqual([]);
        yield* ratesDown(false);
        value(yield* lab.step(lab.pay("10", undefined, "2026-11-20", EUR)));
      }),
    );
  });

  test("a Final Invoice that cannot get its fixing writes nothing", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        value(yield* lab.step(lab.issueProforma(EUR)));
        value(yield* lab.step(lab.pay("10", undefined, undefined, EUR)));
        yield* ratesDown(true);
        const patch = { taxableSupplyOn: "2026-11-21" as IsoDate } as DocumentPatch;
        const exit = yield* lab.step(lab.issueFinal(patch));
        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* lab.finalId()).toBeNull();
        yield* ratesDown(false);
        value(yield* lab.step(lab.issueFinal(patch)));
        expect(yield* lab.finalId()).not.toBeNull();
      }),
    );
  });
});
