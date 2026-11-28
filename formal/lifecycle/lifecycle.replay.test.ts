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
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import * as EffectArray from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  FixtureRates,
  TestCore,
  type TestCoreServices,
} from "../../packages/core/src/testing/index";
import type {
  CoreError,
  DocumentInput,
  DocumentPatch,
  DocumentView,
  TaxRegime,
} from "../../packages/domain/src/contract";
import {
  BankAccountInput,
  Caller,
  ContactId,
  Contacts,
  CurrencyCode,
  DocumentId,
  Documents,
  IsoDate,
  LineId,
  type MemberCaller,
  MoneyMath,
  PaymentId,
  Payments,
  type PaymentView,
  UserId,
  Workspaces,
} from "../../packages/domain/src/contract";
import type { CnbFixing } from "../../packages/domain/src/ports";

const TEST_NOW = Date.UTC(2026, 10, 23, 9, 0, 0);
const CZK = CurrencyCode.make("CZK");
const EUR = CurrencyCode.make("EUR");
const ICO = "27082440";
const dec = (s: string) => BigDecimal.fromStringUnsafe(s);
const str = (d: BigDecimal.BigDecimal) => d.pipe(BigDecimal.normalize, BigDecimal.format);
const fixing = (date: string, eur: string): CnbFixing => ({
  fixingDate: IsoDate.make(date),
  sequence: 1,
  rates: [{ code: EUR, quantity: 1, rate: dec(eur) }],
});

type Env = TestCoreServices;
type Fx<A> = Effect.Effect<A, CoreError, Env>;

const ReplayLine = Schema.Struct({
  id: LineId,
  deducts: Schema.NullOr(DocumentId),
  unitPrice: Schema.BigDecimal,
  amount: Schema.BigDecimal,
  treatment: Schema.String,
  ratePercent: Schema.BigDecimal,
});
const isReplayLine = Schema.is(ReplayLine);
const linesOf = (document: DocumentView) =>
  EffectArray.map(document.lines, (line) => {
    if (!isReplayLine(line)) throw new Error("invalid line in lifecycle replay");
    return line;
  });

const ReplayPayment = Schema.Struct({
  id: PaymentId,
  target: Schema.Struct({ document: DocumentId }),
  taxDocument: Schema.NullOr(DocumentId),
});
const isPaymentIdentity = Schema.is(Schema.Struct({ id: PaymentId }));
const paymentId = (payment: PaymentView) => {
  if (!isPaymentIdentity(payment)) throw new Error("invalid payment in lifecycle replay");
  return payment.id;
};

const required = <A>(candidate: A | null | undefined, message: string): A => {
  if (candidate === null || candidate === undefined) throw new Error(message);
  return candidate;
};

const related = (d: DocumentView, relation: string) =>
  EffectArray.map(
    EffectArray.filter(d.related, (r) => r.relation === relation),
    (r) => r.id,
  );
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
  /** A tax Final Invoice was cancelled by a full Credit Note (the model's fi.storno). */
  finalStorno = false;
  readonly vat: boolean;
  readonly customer: ContactId;
  readonly caller: MemberCaller;

  constructor(caller: MemberCaller, vat: boolean, customer: ContactId) {
    this.caller = caller;
    this.vat = vat;
    this.customer = customer;
  }

  issueProforma(currency: CurrencyCode = CZK): Fx<DocumentView> {
    const lines: DocumentInput["lines"] = this.vat
      ? [
          { description: "Vývoj", unitPrice: dec("1000") },
          { description: "Kniha", unitPrice: dec("500"), vat: "reduced" },
        ]
      : [{ description: "Vývoj", unitPrice: dec("1500") }];
    return Effect.flatMap(Documents, (d) =>
      d.issue(this.caller, {
        input: {
          kind: "proforma",
          contact: this.customer,
          currency,
          issuedOn: IsoDate.make("2026-11-23"),
          lines,
        },
      }),
    ).pipe(
      Effect.tap((v) =>
        Effect.sync(() => {
          this.proforma = v.id;
        }),
      ),
    );
  }

  get p(): DocumentId {
    if (this.proforma === null) throw new Error("no Proforma yet");
    return this.proforma;
  }

  /** Payments.record naming `target` (default the Proforma), half the Proforma by default. */
  pay(amount = "885", target?: DocumentId, paidOn?: string, currency: CurrencyCode = CZK) {
    const self = this;
    return Effect.gen(function* () {
      const input = {
        target: { document: target ?? self.p },
        amount: MoneyMath.make(dec(amount), currency),
      };
      const payments = yield* Payments;
      const result = yield* payments.record(
        self.caller,
        paidOn === undefined ? input : { ...input, paidOn: IsoDate.make(paidOn) },
      );
      const view = yield* Schema.decodeUnknownEffect(ReplayPayment)(result.payment).pipe(
        Effect.orDie,
      );
      const booked: Booked = {
        id: view.id,
        on: view.target.document,
        ptd: view.taxDocument,
        removed: false,
        deductedByFinal: false,
      };
      self.payments.push(booked);
      return { ...result, booked };
    });
  }

  remove(booked: Booked) {
    return Effect.flatMap(Payments, (p) => p.remove(this.caller, booked.id, "vrácení")).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          booked.removed = true;
        }),
      ),
    );
  }

  issueFinal(patch?: DocumentPatch) {
    const self = this;
    return Effect.gen(function* () {
      const fi = yield* (yield* Documents).issueFinalInvoice(
        self.caller,
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
    return Effect.flatMap(Documents, (d) => d.get(this.caller, id));
  }

  correct(id: DocumentId, lines: "full" | ReadonlyArray<{ readonly line: LineId }>) {
    return Effect.flatMap(Documents, (d) =>
      d.correct(this.caller, id, { reason: "oprava", lines }),
    );
  }

  cancel(id: DocumentId) {
    return Effect.flatMap(Documents, (d) => d.cancel(this.caller, id, { reason: "storno" })).pipe(
      Effect.tap((r) =>
        Effect.sync(() => {
          if (r.document.kind === "invoice" && r.creditNote !== null) this.finalStorno = true;
        }),
      ),
    );
  }

  lock(id: DocumentId) {
    return Effect.flatMap(Documents, (d) => d.lock(this.caller, id));
  }

  unlock(id: DocumentId) {
    return Effect.flatMap(Documents, (d) => d.unlock(this.caller, id, "oprava"));
  }

  editLines(id: DocumentId) {
    const self = this;
    return Effect.gen(function* () {
      const current = yield* self.get(id);
      return yield* (yield* Documents).edit(
        self.caller,
        id,
        { lines: [{ description: "Vývoj", unitPrice: dec("1500") }] },
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
      for (const cn of related(doc, "corrected_by")) {
        const creditNote = yield* self.get(cn);
        add(creditNote);
      }
      return new Map(
        Fn.pipe(
          EffectArray.filter([...sums], ([, v]) => !BigDecimal.isZero(v)),
          EffectArray.map(([k, v]) => [k, str(v)] as const),
        ),
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
      const p = yield* docs.get(self.caller, self.p);
      const finals = related(p, "final_invoice_for");
      // OneFinalInvoice
      ok(finals.length <= 1, "OneFinalInvoice");
      const fi = finals[0] === undefined ? null : yield* docs.get(self.caller, finals[0]);
      const liveOnP = yield* payments.listFor(self.caller, { document: self.p });
      const liveOnFi = fi === null ? [] : yield* payments.listFor(self.caller, { document: fi.id });
      const ptds = related(p, "tax_document_for");
      // CancelledProformaUnpaid, CancelledIsLocked
      if (p.status === "cancelled") {
        strictEqual(liveOnP.length, 0);
        strictEqual(fi, null);
        strictEqual(p.locked, true);
      }
      // CancelledFinalUnpaid (status cancelled, or a tax Final Invoice's storno), CancelledIsLocked
      if (fi !== null && (fi.status === "cancelled" || self.finalStorno)) {
        strictEqual(liveOnFi.length, 0);
      }
      if (fi !== null && fi.status === "cancelled") strictEqual(fi.locked, true);
      // FinalInvoiceOfPaidProforma
      if (fi !== null) {
        ok(EffectArray.some(linesOf(fi), (line) => line.deducts !== null));
        ok(EffectArray.some(self.payments, (b) => b.deductedByFinal));
      }
      // PtdPerPayment: one PTD of its own per payment booked on a vat_payer's Proforma
      const onP = EffectArray.filter(self.payments, (b) => b.on === self.p);
      for (const b of self.payments) {
        strictEqual(b.ptd !== null, self.vat && b.on === self.p);
      }
      deepStrictEqual(
        [...ptds].sort(Order.String),
        EffectArray.flatMap(onP, (b) => (b.ptd === null ? [] : [b.ptd])).sort(Order.String),
      );
      strictEqual(new Set(ptds).size, ptds.length);
      const fiLive = fi !== null && fi.status === "issued" && fi.settlement !== "credited";
      const fiReversed = fi !== null && (fi.settlement === "credited" || fi.status === "cancelled");
      for (const id of ptds) {
        const ptd = yield* docs.get(self.caller, id);
        const remaining = yield* self.remaining(ptd);
        // CreditWithinOriginal: per bucket the credits never pass the original's base
        for (const b of ptd.totals.buckets) {
          const left = dec(remaining.get(bucketKey(b)) ?? "0");
          const negative = BigDecimal.isNegative(left);
          strictEqual(negative, false);
          ok(left.pipe(BigDecimal.isLessThanOrEqualTo(b.base)));
        }
        // DeductionsCurrent (H2): a live Final Invoice deducts exactly the PTD's remainder
        if (fiLive && fi !== null) {
          // Sum every deduction line of this PTD per bucket (the line's own treatment and
          // rate); a deduction line's amount is minus the deducted base.
          const sums = new Map<string, BigDecimal.BigDecimal>();
          for (const l of EffectArray.filter(linesOf(fi), (line) => line.deducts === id)) {
            const k = bucketKey(l);
            sums.set(k, BigDecimal.sum(sums.get(k) ?? dec("0"), BigDecimal.negate(l.amount)));
          }
          const deducted = new Map(
            Fn.pipe(
              EffectArray.filter([...sums], ([, v]) => !BigDecimal.isZero(v)),
              EffectArray.map(([k, v]) => [k, str(v)] as const),
            ),
          );
          deepStrictEqual(deducted, remaining);
        }
      }
      // CreditWithinOriginal for the Final Invoice: per bucket, its Credit Notes' supply
      // lines never credit more than its own supply lines (deduction reversals aside).
      if (fi !== null) {
        const supply = new Map<string, BigDecimal.BigDecimal>();
        for (const l of EffectArray.filter(linesOf(fi), (line) => line.deducts === null)) {
          supply.set(bucketKey(l), BigDecimal.sum(supply.get(bucketKey(l)) ?? dec("0"), l.amount));
        }
        const credited = new Map<string, BigDecimal.BigDecimal>();
        for (const cnId of related(fi, "corrected_by")) {
          const document2 = yield* docs.get(self.caller, cnId);
          for (const l of EffectArray.filter(linesOf(document2), (line) => line.deducts === null)) {
            credited.set(
              bucketKey(l),
              BigDecimal.sum(credited.get(bucketKey(l)) ?? dec("0"), BigDecimal.negate(l.amount)),
            );
          }
        }
        for (const [bucket, c] of credited) {
          ok(BigDecimal.isLessThanOrEqualTo(c, supply.get(bucket) ?? dec("0")));
        }
      }
      // RemovedPaymentReversed (which payments the Final Invoice deducted is the harness's
      // bookkeeping: live on the Proforma when issueFinalInvoice succeeded)
      for (const b of EffectArray.filter(onP, (payment) => payment.removed)) {
        if (b.ptd !== null) {
          const document = yield* docs.get(self.caller, b.ptd);
          strictEqual(document.settlement, "credited");
        }
        if (b.deductedByFinal) strictEqual(fiReversed, true);
      }
      // Live payments the harness booked on P are the ones Payments lists.
      const liveIds = new Set(EffectArray.map(liveOnP, (v) => paymentId(v)));
      for (const b of onP) strictEqual(liveIds.has(b.id), !b.removed);
    });
  }

  /** Runs `step` (keeping its Exit) and then `check`. */
  step<A>(step: Fx<A>): Fx<Exit.Exit<A, CoreError>> {
    return Effect.tap(Effect.exit(step), () => this.check());
  }
}

const value = <A>(exit: Exit.Exit<A, unknown>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${String(exit.cause)}`);
  return exit.value;
};

const failure = (exit: Exit.Exit<unknown, CoreError>): CoreError => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure, got success");
  const found = Option.getOrUndefined(
    EffectArray.findFirst(exit.cause.reasons, (r) => r._tag === "Fail"),
  );
  if (found === undefined || found._tag !== "Fail")
    throw new Error(`no failure: ${String(exit.cause)}`);
  return found.error;
};

const conflict = (exit: Exit.Exit<unknown, CoreError>, reason: string, detail?: string) => {
  const error = failure(exit);
  if (error._tag !== "Conflict") throw new Error(`expected Conflict, got ${error._tag}`);
  strictEqual(error.reason, reason);
  if (detail !== undefined) strictEqual(error.detail, detail);
};

const invalid = (exit: Exit.Exit<unknown, CoreError>, code: string) => {
  const error = failure(exit);
  if (error._tag !== "Invalid") throw new Error(`expected Invalid, got ${error._tag}`);
  ok(
    EffectArray.some(error.issues, (issue) => issue.code === code),
    `expected issue ${code}`,
  );
};

/** Runs `body` as the owner of a fresh Workspace with `regime` on a fresh TestCore. */
const replay = async <A>(regime: TaxRegime, body: (lab: Lab) => Fx<A>): Promise<A> => {
  const account = Caller.account({
    userId: UserId.make("01900000-0000-7000-8000-00000000c001"),
    email: "owner@example.cz",
    locale: "cs",
    channel: "web",
  });
  const program = Effect.gen(function* () {
    const ws = yield* Workspaces;
    const owner = yield* ws.create(account, {
      name: "Alfa Beta s.r.o.",
      ico: ICO,
      taxRegime: regime,
    });
    yield* ws.saveBankAccount(
      owner,
      BankAccountInput.make({
        iban: "CZ65 0800 0000 1920 0014 5399",
        currency: "CZK",
      }),
    );
    yield* ws.saveBankAccount(
      owner,
      BankAccountInput.make({ iban: "DE89370400440532013000", currency: "EUR" }),
    );
    const customer = yield* Effect.flatMap(Contacts, (c) =>
      c.save(owner, {
        name: "Odběratel a.s.",
        ico: "25596641",
        dic: "CZ25596641",
        address: { city: "Brno", country: "CZ" },
        roles: ["customer"],
        billingEmails: ["fakturace@odberatel.cz"],
      }),
    );
    const contactId = yield* Schema.decodeUnknownEffect(ContactId)(customer["id"]).pipe(
      Effect.orDie,
    );
    const lab = new Lab(owner, regime === "vat_payer", contactId);
    return yield* body(lab);
  });
  const exit = await Effect.runPromiseExit(
    Effect.andThen(TestClock.setTime(TEST_NOW), program).pipe(
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
            },
            fixings: [fixing("2026-11-20", "25.000"), fixing("2026-11-23", "25.000")],
          }),
          TestClock.layer(),
        ),
      ),
    ),
  );
  return value(exit);
};

const ptdLine = (ptd: DocumentView, treatment: string) => {
  const line = Option.getOrUndefined(
    EffectArray.findFirst(linesOf(ptd), (l) => l.treatment === treatment),
  );
  if (line === undefined) throw new Error(`PTD has no ${treatment} line`);
  return [{ line: line.id }];
};

/** Puts the default series of `kind` at its last valid counter: the next allocation fails. */
const exhaustSeries = (caller: MemberCaller, kind: "credit_note" | "invoice") =>
  Effect.flatMap(Workspaces, (ws) =>
    ws.configureSeries(caller, {
      kind,
      name: "last",
      pattern: "N",
      isDefault: true,
      nextNumber: 2147483646,
    }),
  );

// Shortest path per model action ---------------------------------------------------------------

/**
 * Each test is the shortest trace to one DocumentLifecycle.tla action (named in the test), run
 * on the real services; the later describe blocks add the guards and longer traces.
 */
describe("Shortest path per model action", () => {
  test("IssueProforma -> CancelProforma", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma());
        value(proformaResult);
        const cancellationResult = yield* lab.step(lab.cancel(lab.p));
        const cancelled = value(cancellationResult);
        expect(cancelled.document.status).toBe("cancelled");
        expect(cancelled.document.locked).toBe(true);
      }),
    );
  });

  test("IssueProforma -> EditProformaLines", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma());
        value(proformaResult);
        const editResult = yield* lab.step(lab.editLines(lab.p));
        expect(Exit.isSuccess(editResult)).toBe(true);
      }),
    );
  });

  test("IssueProforma -> LockProforma -> UnlockProforma", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma());
        value(proformaResult);
        const lockResult = yield* lab.step(lab.lock(lab.p));
        expect(value(lockResult).locked).toBe(true);
        const unlockResult = yield* lab.step(lab.unlock(lab.p));
        expect(value(unlockResult).locked).toBe(false);
      }),
    );
  });

  test("IssueProforma -> RecordOnProforma -> RemovePayment (non_vat_payer)", async () => {
    await replay("non_vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma());
        value(proformaResult);
        const paymentResult = yield* lab.step(lab.pay("700"));
        const { booked } = value(paymentResult);
        const removalResult = yield* lab.step(lab.remove(booked));
        expect(Exit.isSuccess(removalResult)).toBe(true);
      }),
    );
  });

  test("IssueProforma -> RecordOnProforma -> CpStart..CpCommit (partial PTD Credit Note)", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma());
        value(proformaResult);
        const paymentResult = yield* lab.step(lab.pay());
        const { issued } = value(paymentResult);
        const ptd = required(issued[0], "expected an issued document");
        const correctionResult = yield* lab.step(lab.correct(ptd.id, ptdLine(ptd, "reduced")));
        expect(Exit.isSuccess(correctionResult)).toBe(true);
      }),
    );
  });

  // FiStart, FiCommit, RecordOnFinal
  test("Record a payment after the Final Invoice is issued", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma());
        value(proformaResult);
        const paymentResult = yield* lab.step(lab.pay());
        value(paymentResult);
        const finalInvoiceResult = yield* lab.step(lab.issueFinal());
        const fi = value(finalInvoiceResult);
        const paymentResult2 = yield* lab.step(lab.pay("100", fi.id));
        expect(value(paymentResult2).booked.on).toBe(fi.id);
      }),
    );
  });

  test("... -> FiStart..FiCommit -> LockFinal -> UnlockFinal", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma());
        value(proformaResult);
        const paymentResult = yield* lab.step(lab.pay());
        value(paymentResult);
        const finalInvoiceResult = yield* lab.step(lab.issueFinal());
        const fi = value(finalInvoiceResult);
        const lockResult = yield* lab.step(lab.lock(fi.id));
        expect(value(lockResult).locked).toBe(true);
        const unlockResult = yield* lab.step(lab.unlock(fi.id));
        expect(value(unlockResult).locked).toBe(false);
      }),
    );
  });

  test("... -> FiCommit -> CorrectFinalPartial", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma());
        value(proformaResult);
        const paymentResult = yield* lab.step(lab.pay());
        value(paymentResult);
        const finalInvoiceResult = yield* lab.step(lab.issueFinal());
        const fi = value(finalInvoiceResult);
        const supply = required(
          Option.getOrUndefined(EffectArray.findFirst(linesOf(fi), (l) => l.deducts === null)),
          "expected a supply line",
        );
        const correctionResult = yield* lab.step(lab.correct(fi.id, [{ line: supply.id }]));
        expect(Exit.isSuccess(correctionResult)).toBe(true);
      }),
    );
  });

  test("... -> FiCommit -> ReverseFinal(FALSE) (full Credit Note)", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma());
        value(proformaResult);
        const paymentResult = yield* lab.step(lab.pay());
        value(paymentResult);
        const finalInvoiceResult = yield* lab.step(lab.issueFinal());
        const fi = value(finalInvoiceResult);
        const correctionResult = yield* lab.step(lab.correct(fi.id, "full"));
        value(correctionResult);
        expect((yield* lab.get(fi.id)).settlement).toBe("credited");
      }),
    );
  });

  test("... -> FiCommit -> ReverseFinal(TRUE) (storno of a tax Final Invoice)", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma());
        value(proformaResult);
        const paymentResult = yield* lab.step(lab.pay());
        value(paymentResult);
        const finalInvoiceResult = yield* lab.step(lab.issueFinal());
        const fi = value(finalInvoiceResult);
        const cancellationResult = yield* lab.step(lab.cancel(fi.id));
        const cancelled = value(cancellationResult);
        expect(cancelled.document.settlement).toBe("credited");
      }),
    );
  });

  test("... -> FiCommit -> CancelNonTaxFinal (non_vat_payer)", async () => {
    await replay("non_vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma());
        value(proformaResult);
        const paymentResult = yield* lab.step(lab.pay("700"));
        value(paymentResult);
        const finalInvoiceResult = yield* lab.step(lab.issueFinal());
        const fi = value(finalInvoiceResult);
        const cancellationResult = yield* lab.step(lab.cancel(fi.id));
        expect(value(cancellationResult).document.status).toBe("cancelled");
      }),
    );
  });
});

// Proforma lifecycle --------------------------------------------------------------------------

describe("Proforma actions", () => {
  test("IssueProforma, EditProformaLines, Lock/UnlockProforma, CancelProforma", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma());
        const p = value(proformaResult);
        expect(p.status).toBe("issued");
        const editResult = yield* lab.step(lab.editLines(lab.p));
        value(editResult);
        const lockResult = yield* lab.step(lab.lock(lab.p));
        value(lockResult);
        // D5: cancel on a locked document fails with document_locked
        const cancellationResult = yield* lab.step(lab.cancel(lab.p));
        conflict(cancellationResult, "document_locked");
        const unlockResult = yield* lab.step(lab.unlock(lab.p));
        value(unlockResult);
        const cancellationResult2 = yield* lab.step(lab.cancel(lab.p));
        const cancelled = value(cancellationResult2);
        expect(cancelled.document.status).toBe("cancelled");
        expect(cancelled.document.locked).toBe(true);
        expect(cancelled.creditNote).toBeNull();
        // A cancelled Proforma takes no payment and no Final Invoice.
        const paymentResult = yield* lab.step(lab.pay());
        conflict(paymentResult, "illegal_transition");
        const finalInvoiceResult = yield* lab.step(lab.issueFinal());
        conflict(finalInvoiceResult, "illegal_transition");
      }),
    );
  });

  test("CancelProforma and EditProformaLines are blocked by a payment (D6, D3a)", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma());
        value(proformaResult);
        const paymentResult = yield* lab.step(lab.pay());
        value(paymentResult);
        const cancellationResult = yield* lab.step(lab.cancel(lab.p));
        conflict(cancellationResult, "illegal_transition");
        const editResult = yield* lab.step(lab.editLines(lab.p));
        conflict(editResult, "illegal_transition");
        // P4: a locked Proforma still takes payments.
        const lockResult = yield* lab.step(lab.lock(lab.p));
        value(lockResult);
        const paymentResult2 = yield* lab.step(lab.pay());
        value(paymentResult2);
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
        const proformaResult = yield* lab.step(lab.issueProforma());
        value(proformaResult);
        const paymentResult = yield* lab.step(lab.pay());
        const first = value(paymentResult);
        const paymentResult2 = yield* lab.step(lab.pay());
        const second = value(paymentResult2);
        expect(first.issued).toHaveLength(1);
        expect(second.issued).toHaveLength(1);
        expect(first.booked.ptd).not.toBe(second.booked.ptd);
      }),
    );
  });

  test("RecordOnProforma issues no PTD for a non_vat_payer", async () => {
    await replay("non_vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma());
        value(proformaResult);
        const paymentResult = yield* lab.step(lab.pay("700"));
        const paid = value(paymentResult);
        expect(paid.issued).toHaveLength(0);
        expect(paid.booked.ptd).toBeNull();
      }),
    );
  });

  test("RemovePayment: blocked while the PTD is open, allowed once it is credited (P3)", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma());
        value(proformaResult);
        const paymentResult = yield* lab.step(lab.pay());
        const { booked } = value(paymentResult);
        const removalResult = yield* lab.step(lab.remove(booked));
        conflict(removalResult, "illegal_transition", "payment.has_tax_document");
        const cancellationResult = yield* lab.step(
          lab.cancel(required(booked.ptd, "expected a PTD")),
        );
        value(cancellationResult);
        const removalResult2 = yield* lab.step(lab.remove(booked));
        value(removalResult2);
        // Idempotent by state (C6).
        const removalResult3 = yield* lab.step(lab.remove(booked));
        value(removalResult3);
        // No payment left: the Proforma can be cancelled.
        const cancellationResult2 = yield* lab.step(lab.cancel(lab.p));
        expect(value(cancellationResult2).document.status).toBe("cancelled");
      }),
    );
  });
});

// Final Invoice -------------------------------------------------------------------------------

describe("Final Invoice actions", () => {
  test("FiStart..FiCommit: needs a payment, runs once per Proforma (D8)", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma());
        value(proformaResult);
        const finalInvoiceResult = yield* lab.step(lab.issueFinal());
        invalid(finalInvoiceResult, "final_invoice.proforma_unpaid");
        const paymentResult = yield* lab.step(lab.pay());
        value(paymentResult);
        const finalInvoiceResult2 = yield* lab.step(lab.issueFinal());
        const fi = value(finalInvoiceResult2);
        expect(fi.kind).toBe("invoice");
        const finalInvoiceResult3 = yield* lab.step(lab.issueFinal());
        conflict(finalInvoiceResult3, "duplicate");
        // D6: a Proforma with a Final Invoice cannot be cancelled.
        const cancellationResult = yield* lab.step(lab.cancel(lab.p));
        conflict(cancellationResult, "illegal_transition");
      }),
    );
  });

  // RecordOnFinal routes payments to the issued Final Invoice.
  test("A payment naming the Proforma settles on its Final Invoice", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma());
        value(proformaResult);
        const paymentResult = yield* lab.step(lab.pay());
        value(paymentResult);
        const finalInvoiceResult = yield* lab.step(lab.issueFinal());
        const fi = value(finalInvoiceResult);
        const paymentResult2 = yield* lab.step(lab.pay("100"));
        const late = value(paymentResult2);
        expect(late.booked.on).toBe(fi.id);
        expect(late.issued).toHaveLength(0);
        // The Final Invoice's own payment blocks its cancel (D6), not its removal (P3).
        const cancellationResult = yield* lab.step(lab.cancel(fi.id));
        conflict(cancellationResult, "illegal_transition");
        const removalResult = yield* lab.step(lab.remove(late.booked));
        value(removalResult);
      }),
    );
  });

  test("RemovePayment is blocked while a live Final Invoice deducts it (P3)", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma());
        value(proformaResult);
        const paymentResult = yield* lab.step(lab.pay());
        const { booked } = value(paymentResult);
        const finalInvoiceResult = yield* lab.step(lab.issueFinal());
        const fi = value(finalInvoiceResult);
        const removalResult = yield* lab.step(lab.remove(booked));
        conflict(removalResult, "illegal_transition", "payment.has_tax_document");
        // A partial credit leaves the deductions standing.
        const supply = required(
          Option.getOrUndefined(EffectArray.findFirst(linesOf(fi), (l) => l.deducts === null)),
          "expected a supply line",
        );
        const correctionResult = yield* lab.step(lab.correct(fi.id, [{ line: supply.id }]));
        value(correctionResult);
        const removalResult2 = yield* lab.step(lab.remove(booked));
        conflict(removalResult2, "illegal_transition", "payment.has_tax_document");
        // The full remainder reverses them; the PTD is still open, then credited.
        const correctionResult2 = yield* lab.step(lab.correct(fi.id, "full"));
        value(correctionResult2);
        const removalResult3 = yield* lab.step(lab.remove(booked));
        conflict(removalResult3, "illegal_transition", "payment.has_tax_document");
        const correctionResult3 = yield* lab.step(
          lab.correct(required(booked.ptd, "expected a PTD"), "full"),
        );
        value(correctionResult3);
        const removalResult4 = yield* lab.step(lab.remove(booked));
        expect(Exit.isSuccess(removalResult4)).toBe(true);
      }),
    );
  });

  test("ReverseFinal via cancel: a tax Final Invoice gets a full Credit Note (D6)", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma());
        value(proformaResult);
        const paymentResult = yield* lab.step(lab.pay());
        value(paymentResult);
        const finalInvoiceResult = yield* lab.step(lab.issueFinal());
        const fi = value(finalInvoiceResult);
        const lockResult = yield* lab.step(lab.lock(fi.id));
        value(lockResult);
        const cancellationResult = yield* lab.step(lab.cancel(fi.id));
        conflict(cancellationResult, "document_locked");
        const unlockResult = yield* lab.step(lab.unlock(fi.id));
        value(unlockResult);
        const cancellationResult2 = yield* lab.step(lab.cancel(fi.id));
        const cancelled = value(cancellationResult2);
        expect(cancelled.document.settlement).toBe("credited");
        expect(cancelled.creditNote).not.toBeNull();
        // Credited: no payment lands on it, no second reversal.
        const paymentResult2 = yield* lab.step(lab.pay("100"));
        conflict(paymentResult2, "illegal_transition");
        const cancellationResult3 = yield* lab.step(lab.cancel(fi.id));
        conflict(cancellationResult3, "illegal_transition");
      }),
    );
  });

  // CancelNonTaxFinal, then RemovePayment
  test("Cancel a non-tax Final Invoice and remove its cash advance", async () => {
    await replay("non_vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma());
        value(proformaResult);
        const paymentResult = yield* lab.step(lab.pay("700"));
        const { booked } = value(paymentResult);
        const finalInvoiceResult = yield* lab.step(lab.issueFinal());
        const fi = value(finalInvoiceResult);
        expect(EffectArray.some(linesOf(fi), (l) => l.deducts === lab.p)).toBe(true);
        const removalResult = yield* lab.step(lab.remove(booked));
        conflict(removalResult, "illegal_transition", "payment.has_tax_document");
        const cancellationResult = yield* lab.step(lab.cancel(fi.id));
        const cancelled = value(cancellationResult);
        expect(cancelled.document.status).toBe("cancelled");
        expect(cancelled.creditNote).toBeNull();
        const removalResult2 = yield* lab.step(lab.remove(booked));
        value(removalResult2);
      }),
    );
  });

  // CancelNonTaxFinal is guarded after CorrectFinalPartial.
  test("A partial Credit Note blocks cancelling the non-tax Final Invoice", async () => {
    await replay("non_vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma());
        value(proformaResult);
        const paymentResult = yield* lab.step(lab.pay("700"));
        value(paymentResult);
        const finalInvoiceResult = yield* lab.step(lab.issueFinal());
        const fi = value(finalInvoiceResult);
        const supply = required(
          Option.getOrUndefined(EffectArray.findFirst(linesOf(fi), (l) => l.deducts === null)),
          "expected a supply line",
        );
        const correctionResult = yield* lab.step(lab.correct(fi.id, [{ line: supply.id }]));
        value(correctionResult);
        const cancellationResult = yield* lab.step(lab.cancel(fi.id));
        const error = failure(cancellationResult);
        expect(error).toMatchObject({
          _tag: "Conflict",
          reason: "illegal_transition",
        });
      }),
    );
  });
});

// Hypothesis H2 and the D7 cap ----------------------------------------------------------------

describe("H2: PTD correction around Final Invoice issue", () => {
  test("correction first: the Final Invoice deducts the PTD's remainder", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma());
        value(proformaResult);
        const paymentResult = yield* lab.step(lab.pay());
        const { issued } = value(paymentResult);
        const ptd = required(issued[0], "expected an issued document");
        const correctionResult = yield* lab.step(lab.correct(ptd.id, ptdLine(ptd, "reduced")));
        value(correctionResult);
        const finalInvoiceResult = yield* lab.step(lab.issueFinal());
        const fi = value(finalInvoiceResult);
        // Only the standard bucket is left to deduct.
        expect(
          EffectArray.map(
            EffectArray.filter(linesOf(fi), (l) => l.deducts === ptd.id),
            (l) => l.treatment,
          ),
        ).toEqual(["standard"]);
      }),
    );
  });

  test("Final Invoice first: the PTD cannot be corrected or cancelled until it is reversed", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma());
        value(proformaResult);
        const paymentResult = yield* lab.step(lab.pay());
        const { issued } = value(paymentResult);
        const ptd = required(issued[0], "expected an issued document");
        const finalInvoiceResult = yield* lab.step(lab.issueFinal());
        const fi = value(finalInvoiceResult);
        const correctionResult = yield* lab.step(lab.correct(ptd.id, ptdLine(ptd, "reduced")));
        conflict(correctionResult, "illegal_transition");
        const cancellationResult = yield* lab.step(lab.cancel(ptd.id));
        conflict(cancellationResult, "illegal_transition");
        const correctionResult2 = yield* lab.step(lab.correct(fi.id, "full"));
        value(correctionResult2);
        const correctionResult3 = yield* lab.step(lab.correct(ptd.id, ptdLine(ptd, "reduced")));
        expect(Exit.isSuccess(correctionResult3)).toBe(true);
      }),
    );
  });

  test("CreditOptions: a second credit of the same PTD bucket exceeds the original (D7)", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma());
        value(proformaResult);
        const paymentResult = yield* lab.step(lab.pay());
        const { issued } = value(paymentResult);
        const ptd = required(issued[0], "expected an issued document");
        const correctionResult = yield* lab.step(lab.correct(ptd.id, ptdLine(ptd, "reduced")));
        value(correctionResult);
        const correctionResult2 = yield* lab.step(lab.correct(ptd.id, ptdLine(ptd, "reduced")));
        invalid(correctionResult2, "credit_note.exceeds_original");
        const correctionResult3 = yield* lab.step(lab.correct(ptd.id, ptdLine(ptd, "standard")));
        value(correctionResult3);
        expect((yield* lab.get(ptd.id)).settlement).toBe("credited");
        const correctionResult4 = yield* lab.step(lab.correct(ptd.id, "full"));
        conflict(correctionResult4, "illegal_transition");
      }),
    );
  });

  test("CorrectFinalPartial: a second credit of the same supply line exceeds the original (D7)", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma());
        value(proformaResult);
        const paymentResult = yield* lab.step(lab.pay());
        value(paymentResult);
        const finalInvoiceResult = yield* lab.step(lab.issueFinal());
        const fi = value(finalInvoiceResult);
        const supply = required(
          Option.getOrUndefined(EffectArray.findFirst(linesOf(fi), (l) => l.deducts === null)),
          "expected a supply line",
        );
        const correctionResult = yield* lab.step(lab.correct(fi.id, [{ line: supply.id }]));
        value(correctionResult);
        const correctionResult2 = yield* lab.step(lab.correct(fi.id, [{ line: supply.id }]));
        const error = failure(correctionResult2);
        expect(error).toMatchObject({
          _tag: "Invalid",
          issues: expect.arrayContaining([
            expect.objectContaining({ code: "credit_note.exceeds_original" }),
          ]),
        });
      }),
    );
  });
});

// Crash points --------------------------------------------------------------------------------

describe("Crash points (FiAbort, CpAbort, a failed RecordOnProforma)", () => {
  test("CpAbort: a PTD Credit Note that cannot be numbered writes nothing", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        yield* exhaustSeries(lab.caller, "credit_note");
        const proformaResult = yield* lab.step(lab.issueProforma());
        value(proformaResult);
        const paymentResult = yield* lab.step(lab.pay());
        const { issued } = value(paymentResult);
        const ptd = required(issued[0], "expected an issued document");
        // The last number goes to the first Credit Note; the second allocation fails.
        const correctionResult = yield* lab.step(lab.correct(ptd.id, ptdLine(ptd, "reduced")));
        value(correctionResult);
        const before = yield* lab.get(ptd.id);
        const correctionResult2 = yield* lab.step(lab.correct(ptd.id, ptdLine(ptd, "standard")));
        conflict(correctionResult2, "illegal_transition", "numbering.pattern_invalid");
        const after = yield* lab.get(ptd.id);
        expect(related(after, "corrected_by")).toEqual(related(before, "corrected_by"));
        expect(after.revision).toBe(before.revision);
        expect(after.settlement).toBe(before.settlement);
      }),
    );
  });

  test("FiAbort: a Final Invoice that cannot be numbered writes nothing", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma());
        value(proformaResult);
        const paymentResult = yield* lab.step(lab.pay());
        value(paymentResult);
        yield* exhaustSeries(lab.caller, "invoice");
        const before = yield* lab.get(lab.p);
        // The series' last number is still free: take it with an unrelated Invoice first.
        const exit2 = yield* Effect.exit(
          Effect.flatMap(Documents, (d) =>
            d.issue(lab.caller, {
              input: {
                kind: "invoice",
                contact: lab.customer,
                lines: [{ description: "Jiné", unitPrice: dec("100") }],
              },
            }),
          ),
        );
        value(exit2);
        const finalInvoiceResult = yield* lab.step(lab.issueFinal());
        conflict(finalInvoiceResult, "illegal_transition", "numbering.pattern_invalid");
        const after = yield* lab.get(lab.p);
        const finalId2 = yield* lab.finalId();
        expect(finalId2).toBeNull();
        expect(after.revision).toBe(before.revision);
      }),
    );
  });

  const ratesDown = (down: boolean) =>
    Effect.flatMap(FixtureRates, (f) => Ref.set(f.unavailable, down));

  test("a PTD that cannot get its fixing rolls the payment back", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma(EUR));
        value(proformaResult);
        yield* ratesDown(true);
        const exit = yield* Effect.exit(lab.pay("10", undefined, "2026-11-20", EUR));
        expect(failure(exit)._tag).toBe("Unavailable");
        yield* lab.check();
        const p = yield* lab.get(lab.p);
        expect(related(p, "tax_document_for")).toEqual([]);
        expect(p.settlement).toBe("unpaid");
        const flatMap2 = yield* Effect.flatMap(Payments, (x) =>
          x.listFor(lab.caller, { document: lab.p }),
        );
        expect(flatMap2).toEqual([]);
        yield* ratesDown(false);
        const paymentResult = yield* lab.step(lab.pay("10", undefined, "2026-11-20", EUR));
        value(paymentResult);
      }),
    );
  });

  // The fixing is read in compose, before the Final Invoice's first write: this shows the
  // request fails cleanly, not a rollback (CpAbort/FiAbort below and the PTD case do that).
  test("a Final Invoice that cannot get its fixing fails before writing", async () => {
    await replay("vat_payer", (lab) =>
      Effect.gen(function* () {
        const proformaResult = yield* lab.step(lab.issueProforma(EUR));
        value(proformaResult);
        const paymentResult = yield* lab.step(lab.pay("10", undefined, undefined, EUR));
        value(paymentResult);
        yield* ratesDown(true);
        const patch = { taxableSupplyOn: IsoDate.make("2026-11-21") } satisfies DocumentPatch;
        const exit = yield* lab.step(lab.issueFinal(patch));
        expect(failure(exit)._tag).toBe("Unavailable");
        const finalId2 = yield* lab.finalId();
        expect(finalId2).toBeNull();
        yield* ratesDown(false);
        const finalInvoiceResult = yield* lab.step(lab.issueFinal(patch));
        value(finalInvoiceResult);
        const finalId3 = yield* lab.finalId();
        expect(finalId3).not.toBeNull();
      }),
    );
  });
});
