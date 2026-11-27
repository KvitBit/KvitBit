/**
 * Cross-module e2e on TestCore: payments on invoices and Expenses, recurring issuance, D16
 * reminders and reports over the data the scenario creates. Every step goes through the domain
 * service tags or the core job entry points a workflow would call (RecurringIssuance; the
 * reminder sweep and delivery steps), as the System caller of that job.
 */

import { describe, expect, test } from "bun:test";
import type { DocumentId, ReportKind, ScheduleId, WorkspaceId } from "@kvitbit/domain/contract";
import {
  Contacts,
  Documents,
  ExpenseId,
  Expenses,
  IsoDate,
  Reports,
  Templates,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as EffectString from "effect/String";
import * as TestClock from "effect/testing/TestClock";
import { deliver, enqueueReminder, selectDueReminders } from "../../src/modules/documents";
import { DocumentSummaryData } from "../../src/modules/documents/view";
import { RecurringIssuance } from "../../src/modules/recurring";
import { TemplateViewSchema } from "../../src/modules/recurring/view";
import { CashflowView, ReceivablesView, VatSummaryView } from "../../src/modules/reports/views";
import { CaptureEmailSender } from "../../src/testing";
import { asCaller, system } from "../helpers";
import {
  bodyText,
  dec,
  docId,
  EUR,
  expenseFields,
  expenseInput,
  inWorkspace,
  issueInvoice,
  ok,
  payDocument,
  payExpense,
  str,
  TODAY,
} from "./payments-flow-fixtures";

const NOV = { from: IsoDate.make("2026-11-01"), to: IsoDate.make("2026-11-30") };

/** Moves the TestClock to 09:00 UTC on `date`. */
const at = (date: string) =>
  TestClock.setTime(Date.parse(`${date}T09:00:00Z`)).pipe(Effect.as(IsoDate.make(date)));

const report = <S extends Schema.Constraint>(kind: ReportKind, schema: S) =>
  Effect.flatMap(
    Effect.flatMap(Reports, (r) => r.run({ report: kind, period: NOV })),
    Schema.decodeUnknownEffect(Schema.toType(schema)),
  );

const outstandingOf = (id: DocumentId) =>
  Effect.map(report("receivables", ReceivablesView), (v) => {
    const row = Option.getOrUndefined(
      EffectArray.findFirst(
        EffectArray.flatMap(v.buckets, (b) => b.documents),
        (d) => d.id === id,
      ),
    );
    return row === undefined ? null : str(row.outstanding.amount);
  });

describe("payments flow (d)", () => {
  test("an invoice goes partially paid then overpaid; an Expense is paid through Payments", async () => {
    const r = ok(
      await inWorkspace(({ customer, supplier }) =>
        Effect.gen(function* () {
          const d = yield* Documents;
          const inv = yield* issueInvoice({ contact: customer });
          const before = yield* outstandingOf(docId(inv));
          const partial = yield* payDocument({ document: docId(inv), amount: "1000" });
          const afterPartial = {
            settlement: (yield* d.get(docId(inv))).settlement,
            outstanding: yield* outstandingOf(docId(inv)),
          };
          const over = yield* payDocument({ document: docId(inv), amount: "2500" });
          const afterOver = {
            settlement: (yield* d.get(docId(inv))).settlement,
            outstanding: yield* outstandingOf(docId(inv)),
          };

          const e = yield* Expenses;
          const recordResult = yield* e.record(expenseInput(supplier));
          const expense = ExpenseId.make(expenseFields(recordResult).id);
          const getResult = yield* e.get(expense);
          const unpaid = expenseFields(getResult).payment;
          const firstPart = yield* payExpense({ expense, amount: "21" });
          const getResult2 = yield* e.get(expense);
          const partly = expenseFields(getResult2).payment;
          const rest = yield* payExpense({ expense });
          const getResult3 = yield* e.get(expense);
          const paid = expenseFields(getResult3).payment;
          return {
            gross: str(inv.totals.gross.amount),
            before,
            partial: partial.settlement,
            afterPartial,
            over: over.settlement,
            afterOver,
            unpaid,
            firstPart: firstPart.settlement,
            partly,
            rest: rest.settlement,
            paid,
          };
        }),
      ),
    );
    expect(r.gross).toBe("2980");
    expect(r.before).toBe("2980");
    expect(r.partial).toBe("partially_paid");
    expect(r.afterPartial).toEqual({ settlement: "partially_paid", outstanding: "1980" });
    expect(r.over).toBe("overpaid");
    // An overpaid invoice is no longer a receivable.
    expect(r.afterOver).toEqual({ settlement: "overpaid", outstanding: null });

    expect(r.unpaid).toMatchObject({ settlement: "unpaid", payments: 0 });
    expect(r.firstPart).toBe("partially_paid");
    expect(r.partly.settlement).toBe("partially_paid");
    expect(r.partly.paid && str(r.partly.paid.amount)).toBe("21");
    expect(r.rest).toBe("paid");
    expect(r.paid.settlement).toBe("paid");
    expect(r.paid.payments).toBe(2);
    expect(r.paid.paid && [str(r.paid.paid.amount), r.paid.paid.currency]).toEqual(["121", "CZK"]);
  });
});

// ---------------------------------------------------------------------------------------------

const MONTHLY = {
  every: { months: 1 },
  startOn: TODAY,
  issueAs: "invoice",
  autoSend: false,
} as const;

/** The sealed System caller of one occurrence's RecurringIssuance job. */
const occurrenceJob = (workspaceId: WorkspaceId, scheduleId: ScheduleId, occurrence: IsoDate) =>
  system({ _tag: "RecurringIssuance", scheduleId, occurrence }, workspaceId);

/** One RecurringSweep tick whose `start` runs the workflow body inline (as the sweep's caller). */
const sweep = Effect.flatMap(RecurringIssuance, (r) =>
  r.sweep((decision) => Effect.asVoid(r.run(decision.scheduleId, decision.occurrence))),
);

const decodeSummary = Schema.decodeUnknownResult(Schema.toType(DocumentSummaryData));
const invoices = Effect.map(
  Effect.flatMap(Documents, (d) => d.list({ kind: "invoice" })),
  (page) => EffectArray.map(page.items, (summary) => Result.getOrThrow(decodeSummary(summary)).id),
);

const decodeTemplate = Schema.decodeUnknownEffect(Schema.toType(TemplateViewSchema));

describe("recurring issuance (e)", () => {
  test("one document per occurrence; re-running an occurrence is idempotent", async () => {
    const r = ok(
      await inWorkspace(({ owner, customer }) =>
        Effect.gen(function* () {
          const t = yield* Templates;
          const saved = yield* t.save({
            name: "Monthly hosting",
            kind: "invoice",
            contact: customer,
            lines: [{ description: "Hosting", quantity: dec("1"), unitPrice: dec("1250.50") }],
            due: { inDays: 14 },
          });
          const created = yield* decodeTemplate(saved);
          const templateId = created.id;
          const scheduleView = yield* t.schedule(templateId, MONTHLY, created.revision);
          const scheduled = yield* decodeTemplate(scheduleView);
          if (scheduled.schedule === null || scheduled.schedule.nextOccurrence === null) {
            return yield* Effect.die("Expected the first scheduled occurrence");
          }
          const { id: scheduleId, nextOccurrence: first } = scheduled.schedule;

          const tick1 = yield* sweep;
          const docs1 = yield* invoices;
          const runs1 = (yield* t.runs(templateId)).items;

          // The same occurrence again: as its job's System caller (a workflow retry) and a
          // second sweep tick the same day.
          const rerun = yield* asCaller(
            occurrenceJob(owner.workspaceId, scheduleId, first),
            Effect.flatMap(RecurringIssuance, (ri) => ri.run(scheduleId, first)),
          );
          const tick1b = yield* sweep;
          const docs1b = yield* invoices;
          const runs1b = (yield* t.runs(templateId)).items;

          // Next month: the second occurrence.
          const nextView = yield* t.get(templateId);
          const next = yield* decodeTemplate(nextView);
          const second = next.schedule?.nextOccurrence;
          if (second === undefined || second === null)
            return yield* Effect.die("Expected a second occurrence");
          yield* at(second);
          const tick2 = yield* sweep;
          const docs2 = yield* invoices;
          const runs2 = (yield* t.runs(templateId)).items;
          return {
            first,
            second,
            tick1: EffectArray.map(tick1, (x) => [x.occurrence, x.action]),
            docs1,
            runs1,
            rerun: rerun.issue,
            tick1b: tick1b.length,
            docs1b,
            runs1b,
            tick2: EffectArray.map(tick2, (x) => [x.occurrence, x.action]),
            docs2,
            runs2,
          };
        }),
      ),
    );
    expect(r.first).toBe(TODAY);
    expect(r.second).toBe(IsoDate.make("2026-12-23"));
    expect<unknown>(r.tick1).toEqual([[TODAY, "issue"]]);
    expect(r.docs1).toHaveLength(1);
    expect(r.runs1).toHaveLength(1);
    expect(r.runs1[0]).toMatchObject({ occurrence: TODAY, outcome: "issued" });
    const issuedId = EffectArray.getUnsafe(r.docs1, 0);
    expect(r.runs1[0]?.document?.id).toBe(issuedId);

    // Idempotent: no second document, the run row and its document link unchanged.
    expect(r.rerun).toMatchObject({ _tag: "Issued", replayed: true });
    expect(r.rerun._tag === "Issued" && r.rerun.run.documentId).toBe(issuedId);
    expect(r.tick1b).toBe(0);
    expect(r.docs1b).toEqual(r.docs1);
    expect(r.runs1b).toEqual(r.runs1);

    expect<unknown>(r.tick2).toEqual([["2026-12-23", "issue"]]);
    expect(r.docs2).toHaveLength(2);
    expect(new Set(r.docs2).size).toBe(2);
    expect<unknown>(EffectArray.map(r.runs2, (x) => [x.occurrence, x.outcome])).toEqual([
      ["2026-12-23", "issued"],
      [TODAY, "issued"],
    ]);
    expect(r.runs2[1]).toEqual(r.runs1[0]);
  });
});

// ---------------------------------------------------------------------------------------------

const reminderEmails = Effect.flatMap(CaptureEmailSender, (c) =>
  Effect.map(Ref.get(c.sent), (sent) =>
    EffectArray.filter(sent, (e) => EffectString.startsWith("Upomínka")(e.message.subject)),
  ),
);

describe("D16 reminders (f)", () => {
  test("a reminder queued for an overdue invoice is skipped once the Contact disables reminders", async () => {
    const r = ok(
      await inWorkspace(({ owner, customer }) =>
        Effect.gen(function* () {
          const d = yield* Documents;
          const workspaceId = owner.workspaceId;
          const inv = yield* issueInvoice({ contact: customer });
          const id = docId(inv);
          yield* d.send(id);
          const dueOn = (yield* d.get(id)).dates.dueOn;

          // The PaymentReminders sweep, three days after the due date (first offset).
          const today = yield* at("2026-12-10");
          const worker = system({ _tag: "PaymentReminders", documentId: id }, workspaceId);
          const due = yield* asCaller(worker, selectDueReminders(workspaceId, today));
          const queued = yield* Effect.forEach(
            due,
            (reminder) => asCaller(worker, enqueueReminder(workspaceId, reminder)),
            { concurrency: 1 },
          );
          const deliveryId = queued[0];
          if (deliveryId === undefined || deliveryId === null)
            return yield* Effect.die("Expected a queued reminder");
          const queuedView = Option.getOrUndefined(
            EffectArray.findFirst((yield* d.get(id)).deliveries, (x) => x.id === deliveryId),
          );

          // Reminders turned off on the Contact before the send step runs.
          const contacts = yield* Contacts;
          const c = yield* contacts.get(customer);
          yield* contacts.save({
            id: customer,
            expectedRevision: c.revision,
            name: c["name"],
            ico: c["ico"],
            dic: c["dic"],
            address: c["address"],
            roles: c["roles"],
            billingEmails: c["billingEmails"],
            defaults: { reminderPolicy: { mode: "disabled" } },
          });

          const sender = system({ _tag: "DocumentDelivery", deliveryId }, workspaceId);
          const outcome = yield* asCaller(sender, deliver(workspaceId, deliveryId));
          const after = Option.getOrUndefined(
            EffectArray.findFirst((yield* d.get(id)).deliveries, (x) => x.id === deliveryId),
          );
          return {
            dueOn,
            due: EffectArray.map(due, (x) => [x.documentId, x.offsetDays]),
            queued: queued.length,
            queuedView,
            outcome,
            after,
            emails: (yield* reminderEmails).length,
          };
        }),
      ),
    );
    expect(r.dueOn).toBe(IsoDate.make("2026-12-07"));
    expect(r.queued).toBe(1);
    expect(r.queuedView).toMatchObject({ purpose: "reminder", status: "queued" });
    expect(r.outcome).toBe("skipped");
    expect(r.after).toMatchObject({ purpose: "reminder", status: "skipped" });
    expect(r.emails).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe("reports over the scenario's data (g)", () => {
  test("VAT summary, cashflow, receivables aging and a CSV export", async () => {
    const r = ok(
      await inWorkspace(({ customer, supplier }) =>
        Effect.gen(function* () {
          const d = yield* Documents;
          // Paid in full: 2000 + 420 standard, 500 + 60 reduced.
          const paid = yield* issueInvoice({ contact: customer });
          yield* payDocument({ document: docId(paid) });
          // Unpaid; overdue once the clock moves: 1000 + 210.
          const overdue = yield* issueInvoice({
            contact: customer,
            lines: [{ description: "Služby", unitPrice: dec("1000") }],
          });
          // EUR at 25.000: 100 EUR + 21 EUR = 2500 + 525 CZK.
          const eur = yield* issueInvoice({
            contact: customer,
            currency: EUR,
            lines: [{ description: "Služby", unitPrice: dec("100") }],
          });
          // Credited in full: +1000/+210 and -1000/-210.
          const credited = yield* issueInvoice({
            contact: customer,
            lines: [{ description: "Služby", unitPrice: dec("1000") }],
          });
          const cn = yield* d.correct(docId(credited), { reason: "sleva", lines: "full" });

          const e = yield* Expenses;
          const recordResult = yield* e.record(expenseInput(supplier));
          const expense = ExpenseId.make(expenseFields(recordResult).id);
          yield* payExpense({ expense });

          // 2027-01-02: the 1210 invoice (due 2026-12-07) is 26 days overdue.
          yield* at("2027-01-02");
          const vat = yield* report("vat_summary", VatSummaryView);
          const cashflow = yield* report("cashflow", CashflowView);
          const receivables = yield* report("receivables", ReceivablesView);
          const csv = yield* Effect.flatMap(Reports, (rep) =>
            rep.export({ report: "cashflow", period: NOV }, "csv"),
          );
          return {
            ids: { overdue: docId(overdue), eur: docId(eur), cn: docId(cn) },
            vat,
            cashflow,
            receivables,
            csv: { filename: csv.filename, text: yield* bodyText(csv.bytes) },
          };
        }),
      ),
    );
    expect(
      EffectArray.map(r.vat.output, (l) => [
        l.month,
        l.treatment,
        str(l.ratePercent),
        str(l.base.amount),
        str(l.vat.amount),
      ]),
    ).toEqual([
      ["2026-11", "standard", "21", "5500", "1155"],
      ["2026-11", "reduced", "12", "500", "60"],
    ]);
    expect(r.vat.output[0]?.documents).toContainEqual({ _tag: "Document", id: r.ids.cn });
    expect(r.vat.output[0]?.documents).toContainEqual({ _tag: "Document", id: r.ids.eur });
    expect(
      EffectArray.map(r.vat.input, (l) => [
        l.month,
        l.treatment,
        str(l.base.amount),
        str(l.vat.amount),
      ]),
    ).toEqual([["2026-11", "standard", "100", "21"]]);
    expect(EffectArray.map(r.vat.input[0]?.documents ?? [], (document) => document._tag)).toEqual([
      "Expense",
    ]);
    expect(
      EffectArray.map([r.vat.totals.output, r.vat.totals.input, r.vat.totals.payable], (m) =>
        str(m.amount),
      ),
    ).toEqual(["1215", "21", "1194"]);

    expect(
      EffectArray.map(r.cashflow.points, (p) => [
        p.month,
        str(p.in.amount),
        str(p.out.amount),
        str(p.net.amount),
      ]),
    ).toEqual([["2026-11", "2980", "121", "2859"]]);

    expect(r.receivables.asOf).toBe(IsoDate.make("2027-01-02"));
    const aged = Option.getOrUndefined(
      EffectArray.findFirst(r.receivables.buckets, (b) =>
        EffectArray.some(b.documents, (x) => x.id === r.ids.overdue),
      ),
    );
    expect(aged?.bucket).toBe("1_30");
    const entry = EffectArray.findFirst(
      aged?.documents ?? [],
      (document) => document.id === r.ids.overdue,
    );
    const overdueEntry = Option.getOrUndefined(entry);
    expect(overdueEntry).toMatchObject({ daysOverdue: 26 });
    expect(r.receivables.overdue.count).toBe(2);

    expect(r.csv.filename).toBe("cashflow_2026-11-01_2026-11-30.csv");
    expect(r.csv.text).toBe("﻿month;in_czk;out_czk;net_czk\r\n2026-11;2980,00;121,00;2859,00\r\n");
  });
});
