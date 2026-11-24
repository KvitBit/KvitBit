/** Documents P2: issue, numbering, the state machine, lock/unlock, number override, cancel. */
import { describe, expect, test } from "bun:test";
import type {
  Caller,
  DocumentId,
  DocumentView,
  IsoDate,
  NumberingSeriesId,
  RequestKey,
} from "@kvitbit/domain/contract";
import { Conflict, Documents, Forbidden, Invalid } from "@kvitbit/domain/contract";
import { Effect, Exit, Schema } from "effect";
import { VatMath } from "../../../src/engines/vat";
import type {
  ContactSnapshotRecord,
  IssuerForDocument,
  LifecycleAction,
  LifecycleState,
} from "../../../src/modules/documents";
import {
  DocumentFixtures,
  DocumentsRepo,
  DocumentViewData,
  isFullyCredited,
  LIFECYCLE_ACTIONS,
  LIFECYCLE_STATES,
  remainderSpec,
  remainingBuckets,
  TRANSITIONS,
} from "../../../src/modules/documents";
import { NumberingSeries } from "../../../src/modules/numbering";
import { CoreStore } from "../../../src/store/CoreStore";
import { member, WORKSPACE_A, WORKSPACE_B } from "../../helpers";
import type { Services } from "./fixtures";
import { as, CZ_BUYER, contact, dec, invoiceInput, issuer, scenario, str } from "./fixtures";

const WS = WORKSPACE_A;
const TODAY = "2026-11-23" as IsoDate;

const ok = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${String(exit.cause)}`);
  return exit.value;
};

const json = (view: DocumentView) =>
  Schema.encodeSync(Schema.toCodecJson(DocumentViewData))(view as never);
const buyer = (view: DocumentView) => view.contact as unknown as ContactSnapshotRecord;
const seller = (view: DocumentView) => view.issuer as unknown as { readonly name: string };

const illegal = new Conflict({ reason: "illegal_transition" });
const locked = new Conflict({ reason: "document_locked" });

/** Every kind gets its Workspace default series; the issuer names none (NumberingSeries does). */
const run = <A, E>(
  body: Effect.Effect<A, E, Services>,
  options: {
    readonly caller?: Caller;
    readonly billingA?: Partial<IssuerForDocument["billing"]>;
  } = {},
) =>
  scenario(
    Effect.andThen(
      Effect.flatMap(CoreStore, (store) =>
        store.transaction(
          Effect.flatMap(NumberingSeries, (n) =>
            n.ensureDefaults(WS, ["invoice", "proforma", "credit_note", "payment_tax_document"]),
          ),
        ),
      ),
      body,
    ),
    {
      ...(options.caller === undefined ? {} : { caller: options.caller }),
      billingA: { seriesByKind: {}, ...options.billingA },
    },
  );

const docs = Documents;
const issueInvoice = (extra: Parameters<typeof invoiceInput>[0] = {}) =>
  Effect.flatMap(docs, (d) => d.issue({ input: invoiceInput(extra) }));
const issueProforma = () => issueInvoice({ kind: "proforma" });

describe("issue", () => {
  test("numbers a draft from its series, freezes it and audits create + issue", async () => {
    const [view, row, history] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const draft = yield* d.createDraft(invoiceInput({ issuedOn: undefined }));
          const view = yield* d.issue({ draft: draft.id, expectedRevision: draft.revision });
          const row = yield* (yield* DocumentsRepo).get(WS, view.id);
          return [view, row, yield* d.history(view.id)] as const;
        }),
      ),
    );
    expect(view.status).toBe("issued");
    expect(view.number).toBe("2026-0001");
    expect(view.revision).toBe(2);
    expect(view.dates.issuedOn).toBe(TODAY);
    expect(row.variableSymbol).toBe("20260001");
    // Floating defaults are pinned as the document's own values.
    expect(row.given).toMatchObject({
      currency: "CZK",
      issuedOn: TODAY,
      taxableSupplyOn: TODAY,
      due: { inDays: 14 },
      language: "cs",
      paymentMethod: "bank_transfer",
    });
    expect(row.given.series).toBe(row.seriesId as NumberingSeriesId);
    expect(row.issuedAt).not.toBeNull();
    expect(history.map((e) => [e.action, e.revision])).toEqual([
      ["document.create", 1],
      ["document.issue", 2],
    ]);
    expect(history[1]?.changes).toEqual([{ path: "number", before: null, after: "2026-0001" }]);
  });

  test("straight from input; numbering is gapless and discarded drafts consume nothing", async () => {
    const numbers = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const a = yield* issueInvoice();
          const draft = yield* d.createDraft(invoiceInput());
          yield* d.discardDraft(draft.id, draft.revision);
          const b = yield* issueInvoice();
          const p = yield* issueProforma();
          return [a.number, b.number, p.number, (yield* d.history(a.id)).map((e) => e.action)];
        }),
      ),
    );
    expect(numbers).toEqual(["2026-0001", "2026-0002", "ZF-2026-0001", ["document.issue"]]);
  });

  test("an exhausted series surfaces Conflict{illegal_transition, numbering.pattern_invalid} and rolls back", async () => {
    const [error, draft] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const store = yield* CoreStore;
          yield* store.transaction(
            (yield* NumberingSeries).configure(
              WS,
              {
                kind: "invoice",
                name: "Krátká",
                pattern: `${"A".repeat(18)}-N`,
                nextNumber: 9,
                isDefault: true,
              },
              TODAY,
            ),
          );
          const first = yield* issueInvoice();
          expect(first.number).toBe(`${"A".repeat(18)}-9`);
          const draft = yield* d.createDraft(invoiceInput());
          const error = yield* Effect.flip(
            d.issue({ draft: draft.id, expectedRevision: draft.revision }),
          );
          return [error, yield* d.get(draft.id)] as const;
        }),
      ),
    );
    expect(error).toEqual(
      new Conflict({ reason: "illegal_transition", detail: "numbering.pattern_invalid" }),
    );
    expect(draft.status).toBe("draft");
    expect(draft.number).toBeNull();
    expect(draft.revision).toBe(1);
  });

  test("a blind retry without a requestKey fails illegal_transition; a stale draft revision_changed", async () => {
    const [retry, stale] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const draft = yield* d.createDraft(invoiceInput());
          yield* d.issue({ draft: draft.id, expectedRevision: 1 });
          const retry = yield* Effect.flip(d.issue({ draft: draft.id, expectedRevision: 1 }));
          const other = yield* d.createDraft(invoiceInput());
          yield* d.edit(other.id, { note: "změna" }, 1);
          const stale = yield* Effect.flip(d.issue({ draft: other.id, expectedRevision: 1 }));
          return [retry, stale] as const;
        }),
      ),
    );
    expect(retry).toEqual(illegal);
    expect(stale).toEqual(new Conflict({ reason: "revision_changed", currentRevision: 2 }));
  });

  test("a requestKey replays the stored result and never numbers twice", async () => {
    const [first, again, next, mismatch] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const key = { requestKey: "issue-1" as RequestKey };
          const draft = yield* d.createDraft(invoiceInput());
          const from = { draft: draft.id, expectedRevision: 1 };
          const first = yield* d.issue(from, key);
          const again = yield* d.issue(from, key);
          const next = yield* issueInvoice();
          const mismatch = yield* Effect.flip(d.issue({ input: invoiceInput() }, key));
          return [first, again, next.number, mismatch] as const;
        }),
      ),
    );
    expect(json(again)).toEqual(json(first));
    expect(next).toBe("2026-0002");
    expect(mismatch).toEqual(new Conflict({ reason: "idempotency_mismatch" }));
  });

  test("party snapshots stay frozen after Contact and Workspace changes until refreshParties", async () => {
    const [afterChange, afterEdit, refreshed, history] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const f = yield* DocumentFixtures;
          const view = yield* issueInvoice();
          yield* f.putContact(WS, contact(CZ_BUYER, { name: "Nový název a.s." }));
          const changed = issuer(WS, "vat_payer", { seriesByKind: {}, dueDays: 30 });
          yield* f.putIssuer({
            ...changed,
            party: { ...changed.party, name: "Nová firma s.r.o." },
          });
          const afterChange = yield* d.get(view.id);
          const afterEdit = yield* d.edit(view.id, { note: "Díky" }, view.revision);
          const refreshed = yield* d.edit(view.id, { refreshParties: true }, afterEdit.revision);
          return [afterChange, afterEdit, refreshed, yield* d.history(view.id)] as const;
        }),
      ),
    );
    expect(buyer(afterChange).name).toBe("Odběratel a.s.");
    expect(seller(afterChange).name).toBe("Dodavatel s.r.o.");
    expect(buyer(afterEdit).name).toBe("Odběratel a.s.");
    expect(seller(afterEdit).name).toBe("Dodavatel s.r.o.");
    // The Workspace's new dueDays does not move a pinned due date.
    expect(afterEdit.dates.dueOn).toBe("2026-12-07" as IsoDate);
    expect(buyer(refreshed).name).toBe("Nový název a.s.");
    expect(seller(refreshed).name).toBe("Nová firma s.r.o.");
    expect(history.map((e) => [e.action, e.revision])).toEqual([
      ["document.issue", 1],
      ["document.edit", 2],
      ["document.edit", 3],
    ]);
    expect(history[1]?.changes.map((c) => c.path)).toEqual(["note"]);
    expect(history[2]?.changes.map((c) => c.path)).toEqual(["contact", "issuer"]);
  });
});

// State machine -----------------------------------------------------------------------------

type ServiceAction = "edit" | "discard" | "issue" | "lock" | "unlock" | "cancel";

/** Expected outcome of every service action in every state (D2, D3a, D5, D13). */
const EXPECTED: Record<LifecycleState, Record<ServiceAction, "ok" | "noop" | Conflict>> = {
  draft: {
    edit: "ok",
    discard: "ok",
    issue: "ok",
    lock: illegal,
    unlock: illegal,
    cancel: illegal,
  },
  issued: {
    edit: "ok",
    discard: illegal,
    issue: illegal,
    lock: "ok",
    unlock: "noop",
    cancel: "ok",
  },
  locked: {
    edit: locked,
    discard: illegal,
    issue: illegal,
    lock: "noop",
    unlock: "ok",
    cancel: locked,
  },
  cancelled: {
    edit: illegal,
    discard: illegal,
    issue: illegal,
    lock: "noop",
    unlock: illegal,
    cancel: illegal,
  },
};

/** A Proforma (never a tax document, so cancel cancels) in `state`. */
const inState = (state: LifecycleState) =>
  Effect.gen(function* () {
    const d = yield* docs;
    if (state === "draft") return yield* d.createDraft(invoiceInput({ kind: "proforma" }));
    const view = yield* issueProforma();
    if (state === "locked") return yield* d.lock(view.id);
    if (state === "cancelled") return (yield* d.cancel(view.id, { reason: "chyba" })).document;
    return view;
  });

const act = (action: ServiceAction, view: DocumentView) =>
  Effect.flatMap(docs, (d): Effect.Effect<unknown, unknown, never> => {
    switch (action) {
      case "edit":
        return d.edit(view.id, { note: "x" }, view.revision) as never;
      case "discard":
        return d.discardDraft(view.id, view.revision) as never;
      case "issue":
        return d.issue({ draft: view.id, expectedRevision: view.revision }) as never;
      case "lock":
        return d.lock(view.id) as never;
      case "unlock":
        return d.unlock(view.id, "oprava") as never;
      case "cancel":
        return d.cancel(view.id, { reason: "storno" }) as never;
    }
  });

describe("state machine", () => {
  for (const state of LIFECYCLE_STATES) {
    for (const action of Object.keys(EXPECTED[state]) as Array<ServiceAction>) {
      const expected = EXPECTED[state][action];
      test(`${action} on ${state}: ${expected instanceof Conflict ? expected.reason : expected}`, async () => {
        const [before, exit, after, history] = ok(
          await run(
            Effect.gen(function* () {
              const d = yield* docs;
              const before = yield* inState(state);
              const historyBefore = (yield* d.history(before.id)).length;
              const exit = yield* Effect.exit(act(action, before));
              const after =
                action === "discard" && Exit.isSuccess(exit) ? null : yield* d.get(before.id);
              const historyAfter =
                after === null ? historyBefore : (yield* d.history(before.id)).length;
              return [before, exit, after, historyAfter - historyBefore] as const;
            }),
          ),
        );
        if (expected instanceof Conflict) {
          expect(exit).toEqual(Exit.fail(expected));
          expect(after?.revision).toBe(before.revision);
          expect(history).toBe(0);
        } else {
          expect(Exit.isSuccess(exit)).toBe(true);
          if (expected === "noop") {
            expect(after).toEqual(before);
            expect(history).toBe(0);
          }
        }
        expect(TRANSITIONS[state][action]).toBe(
          expected instanceof Conflict
            ? (expected.reason as "illegal_transition" | "document_locked")
            : expected,
        );
      });
    }
  }

  test("the table covers every state x action; later-phase actions follow D5 and D13", () => {
    for (const state of LIFECYCLE_STATES) {
      expect(Object.keys(TRANSITIONS[state]).sort()).toEqual([...LIFECYCLE_ACTIONS].sort());
    }
    const later: ReadonlyArray<LifecycleAction> = [
      "correct",
      "finalInvoice",
      "send",
      "share",
      "recordPayment",
    ];
    expect(later.map((a) => TRANSITIONS.draft[a])).toEqual(later.map(() => "illegal_transition"));
    expect(later.map((a) => TRANSITIONS.issued[a])).toEqual(later.map(() => "ok"));
    expect(later.map((a) => TRANSITIONS.locked[a])).toEqual([
      "document_locked",
      "ok",
      "ok",
      "ok",
      "ok",
    ]);
    expect(later.map((a) => TRANSITIONS.cancelled[a])).toEqual(
      later.map(() => "illegal_transition"),
    );
  });
});

// Lock / unlock -----------------------------------------------------------------------------

describe("lock and unlock", () => {
  test("lock is idempotent and audited once; unlock needs a reason that is audited", async () => {
    const [first, second, blank, unlocked, history] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const view = yield* issueInvoice();
          const first = yield* d.lock(view.id);
          const second = yield* d.lock(view.id);
          const blank = yield* Effect.flip(d.unlock(view.id, "   "));
          const unlocked = yield* d.unlock(view.id, "  oprava adresy ");
          return [first, second, blank, unlocked, yield* d.history(view.id)] as const;
        }),
      ),
    );
    expect(first.locked).toBe(true);
    expect(second).toEqual(first);
    // Domain gap: unlock's signature lacks Invalid (missing reason); widened in service.ts.
    expect(blank as unknown).toEqual(
      new Invalid({
        issues: [{ path: ["reason"], code: "request.malformed", params: { reason: "required" } }],
      }),
    );
    expect(unlocked.locked).toBe(false);
    expect(history.map((e) => [e.action, e.reason])).toEqual([
      ["document.issue", null],
      ["document.lock", null],
      ["document.unlock", "oprava adresy"],
    ]);
  });

  test("unlock needs owner or admin; lock is open to member, not accountant", async () => {
    const results = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const view = yield* issueInvoice();
          const accountantLock = yield* Effect.flip(as(member("accountant"), d.lock(view.id)));
          yield* as(member("member"), d.lock(view.id));
          const memberUnlock = yield* Effect.flip(as(member("member"), d.unlock(view.id, "x")));
          const adminUnlock = yield* as(member("admin"), d.unlock(view.id, "x"));
          return [accountantLock, memberUnlock, adminUnlock.locked] as const;
        }),
      ),
    );
    expect(results).toEqual([
      new Forbidden({ action: "document.lock" }),
      new Forbidden({ action: "document.unlock" }),
      false,
    ]);
  });
});

// Edit of issued documents ------------------------------------------------------------------

describe("edit of an issued document", () => {
  test("recomputes VAT and audits the field-level diff; the series never changes", async () => {
    const [edited, history, series] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const view = yield* issueInvoice();
          const edited = yield* d.edit(
            view.id,
            { lines: [invoiceInput().lines[0]] as never },
            view.revision,
          );
          const series = yield* Effect.flip(
            d.edit(
              view.id,
              { series: "01900000-0000-7000-8000-000000000999" as never },
              edited.revision,
            ),
          );
          return [edited, yield* d.history(view.id), series] as const;
        }),
      ),
    );
    expect(str(edited.totals.gross.amount)).toBe("2420");
    expect(edited.number).toBe("2026-0001");
    expect(history.at(-1)?.changes.map((c) => c.path)).toEqual(["lines", "totals"]);
    expect(series).toEqual(illegal);
  });

  test("D3a: a document with dependents keeps lines, currency and tax point; text still edits", async () => {
    const [linesErr, taxPointErr, note] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const repo = yield* DocumentsRepo;
          const store = yield* CoreStore;
          const view = yield* issueProforma();
          const row = yield* repo.get(WS, view.id);
          const paid = yield* store.transaction(repo.update({ ...row, payments: 1 }, row.revision));
          const linesErr = yield* Effect.flip(
            d.edit(view.id, { lines: invoiceInput().lines }, paid.revision),
          );
          const taxPointErr = yield* Effect.flip(
            d.edit(view.id, { taxableSupplyOn: "2026-11-20" as IsoDate }, paid.revision),
          );
          const note = yield* d.edit(view.id, { note: "Záloha" }, paid.revision);
          return [linesErr, taxPointErr, note.revision] as const;
        }),
      ),
    );
    expect(linesErr).toEqual(illegal);
    expect(taxPointErr).toEqual(illegal);
    expect(note).toBe(3);
  });
});

// Number override (D4) ----------------------------------------------------------------------

describe("number override", () => {
  test("owner/admin only; a reserved number is Conflict{duplicate}; the old one stays reserved", async () => {
    const [renamed, taken, old, memberTry, draftTry, history, row] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const a = yield* issueInvoice();
          const b = yield* issueInvoice();
          const renamed = yield* d.edit(a.id, { number: " 2026-0100 " }, a.revision);
          const taken = yield* Effect.flip(d.edit(b.id, { number: "2026-0100" }, b.revision));
          const old = yield* Effect.flip(d.edit(b.id, { number: "2026-0001" }, b.revision));
          const memberTry = yield* Effect.flip(
            as(member("member"), d.edit(b.id, { number: "2026-0200" }, b.revision)),
          );
          const draft = yield* d.createDraft(invoiceInput());
          const draftTry = yield* Effect.flip(d.edit(draft.id, { number: "D-1" }, 1));
          const row = yield* (yield* DocumentsRepo).get(WS, a.id);
          return [renamed, taken, old, memberTry, draftTry, yield* d.history(a.id), row] as const;
        }),
      ),
    );
    expect(renamed.number).toBe("2026-0100");
    expect(row.variableSymbol).toBe("20260100");
    expect(taken).toEqual(new Conflict({ reason: "duplicate" }));
    expect(old).toEqual(new Conflict({ reason: "duplicate" }));
    expect(memberTry).toEqual(new Forbidden({ action: "document.overrideNumber" }));
    expect(draftTry).toEqual(illegal);
    expect(history.at(-1)?.changes).toEqual([
      { path: "number", before: "2026-0001", after: "2026-0100" },
      { path: "variableSymbol", before: "20260001", after: "20260100" },
    ]);
  });
});

// Cancel (D6) -------------------------------------------------------------------------------

describe("cancel", () => {
  test("a non-tax document becomes cancelled and locked, keeps its number, no Credit Note", async () => {
    const [result, history] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const view = yield* issueProforma();
          const result = yield* d.cancel(view.id, {
            reason: "duplicita",
            on: "2026-11-23" as IsoDate,
          });
          return [result, yield* d.history(view.id)] as const;
        }),
      ),
    );
    expect(result.creditNote).toBeNull();
    expect(result.document.status).toBe("cancelled");
    expect(result.document.locked).toBe(true);
    expect(result.document.number).toBe("ZF-2026-0001");
    expect(history.at(-1)).toMatchObject({ action: "document.cancel", reason: "duplicita" });
  });

  test("a tax document gets a full Credit Note and stays issued as credited", async () => {
    const [result, again, cnHistory] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const view = yield* issueInvoice();
          const result = yield* d.cancel(view.id, { reason: "vráceno" });
          const again = yield* Effect.flip(d.cancel(view.id, { reason: "znovu" }));
          return [result, again, yield* d.history(result.creditNote?.id as DocumentId)] as const;
        }),
      ),
    );
    const { document, creditNote } = result;
    expect(document.status).toBe("issued");
    expect(document.settlement).toBe("credited");
    expect(creditNote?.kind).toBe("credit_note");
    expect(creditNote?.number).toBe("OD-2026-0001");
    expect(creditNote?.taxDocument).toBe(true);
    expect(creditNote?.overdue).toBe(false);
    expect(creditNote?.dates).toEqual({ issuedOn: TODAY, taxableSupplyOn: TODAY, dueOn: TODAY });
    expect(str(creditNote?.totals.net.amount ?? ({} as never))).toBe("-2500");
    expect(str(creditNote?.totals.vat.amount ?? ({} as never))).toBe("-480");
    expect(str(creditNote?.totals.gross.amount ?? ({} as never))).toBe("-2980");
    expect(document.related).toEqual([
      {
        relation: "corrected_by",
        id: creditNote?.id as DocumentId,
        kind: "credit_note",
        number: "OD-2026-0001",
      },
    ]);
    expect(creditNote?.related).toEqual([
      { relation: "corrects", id: document.id, kind: "invoice", number: "2026-0001" },
    ]);
    expect(again).toEqual(illegal);
    expect(cnHistory.map((e) => [e.action, e.reason])).toEqual([["document.issue", "vráceno"]]);
  });

  test("payments, a Final Invoice, a lock, a missing reason or a date before issue block it", async () => {
    const results = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const repo = yield* DocumentsRepo;
          const store = yield* CoreStore;
          const paid = yield* issueInvoice();
          const paidRow = yield* repo.get(WS, paid.id);
          yield* store.transaction(repo.update({ ...paidRow, payments: 1 }, paidRow.revision));
          const proforma = yield* issueProforma();
          const pRow = yield* repo.get(WS, proforma.id);
          yield* store.transaction(
            repo.update(
              { ...pRow, links: [{ relation: "final_invoice_for", id: paid.id }] },
              pRow.revision,
            ),
          );
          const lockedDoc = yield* d.lock((yield* issueInvoice()).id);
          const open = yield* issueInvoice();
          return [
            yield* Effect.flip(d.cancel(paid.id, { reason: "x" })),
            yield* Effect.flip(d.cancel(proforma.id, { reason: "x" })),
            yield* Effect.flip(d.cancel(lockedDoc.id, { reason: "x" })),
            yield* Effect.flip(d.cancel(open.id, { reason: " " })),
            yield* Effect.flip(d.cancel(open.id, { reason: "x", on: "2026-11-01" as IsoDate })),
          ];
        }),
      ),
    );
    expect(results).toEqual([
      illegal,
      illegal,
      locked,
      new Invalid({
        issues: [{ path: ["reason"], code: "request.malformed", params: { reason: "required" } }],
      }),
      new Invalid({
        issues: [{ path: ["on"], code: "request.malformed", params: { reason: "out_of_range" } }],
      }),
    ]);
  });

  test("a requestKey replays the cancel result without a second Credit Note", async () => {
    const [first, again, next] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const key = { requestKey: "cancel-1" as RequestKey };
          const view = yield* issueInvoice();
          const first = yield* d.cancel(view.id, { reason: "x" }, key);
          const again = yield* d.cancel(view.id, { reason: "x" }, key);
          const other = yield* issueInvoice();
          const next = yield* d.cancel(other.id, { reason: "x" });
          return [first, again, next.creditNote?.number] as const;
        }),
      ),
    );
    expect(json(again.document)).toEqual(json(first.document));
    expect(json(again.creditNote as DocumentView)).toEqual(json(first.creditNote as DocumentView));
    expect(next).toBe("OD-2026-0002");
  });
});

// Authorization and Workspace scoping -------------------------------------------------------

describe("authorization and scoping", () => {
  test("accountants cannot issue, cancel or edit; members can issue and cancel", async () => {
    const results = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const accountant = member("accountant");
          const draft = yield* d.createDraft(invoiceInput());
          const view = yield* issueInvoice();
          return [
            yield* Effect.flip(as(accountant, d.issue({ draft: draft.id, expectedRevision: 1 }))),
            yield* Effect.flip(as(accountant, d.cancel(view.id, { reason: "x" }))),
            yield* Effect.flip(as(accountant, d.edit(view.id, { note: "x" }, view.revision))),
            (yield* as(member("member"), d.issue({ draft: draft.id, expectedRevision: 1 }))).status,
            (yield* as(member("member"), d.cancel(view.id, { reason: "x" }))).document.settlement,
          ];
        }),
      ),
    );
    expect(results).toEqual([
      new Forbidden({ action: "document.issue" }),
      new Forbidden({ action: "document.cancel" }),
      new Forbidden({ action: "document.edit" }),
      "issued",
      "credited",
    ]);
  });

  test("another Workspace's documents are NotFound for every lifecycle method", async () => {
    const misses = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const other = member("owner", { workspaceId: WORKSPACE_B });
          const draft = yield* d.createDraft(invoiceInput());
          const view = yield* issueInvoice();
          return [
            yield* Effect.flip(as(other, d.issue({ draft: draft.id, expectedRevision: 1 }))),
            yield* Effect.flip(as(other, d.edit(view.id, { note: "x" }, view.revision))),
            yield* Effect.flip(as(other, d.edit(view.id, { number: "X-1" }, view.revision))),
            yield* Effect.flip(as(other, d.lock(view.id))),
            yield* Effect.flip(as(other, d.unlock(view.id, "x"))),
            yield* Effect.flip(as(other, d.cancel(view.id, { reason: "x" }))),
          ];
        }),
      ),
    );
    for (const miss of misses) expect(miss).toMatchObject({ _tag: "NotFound", entity: "Document" });
  });
});

describe("Credit Notes", () => {
  test("accept only text edits (D3a: their amounts are bound to the corrected document)", async () => {
    const [linesErr, refreshErr, noted] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const { creditNote } = yield* d.cancel((yield* issueInvoice()).id, { reason: "x" });
          const cn = creditNote as DocumentView;
          return [
            yield* Effect.flip(d.edit(cn.id, { lines: invoiceInput().lines }, cn.revision)),
            yield* Effect.flip(d.edit(cn.id, { refreshParties: true }, cn.revision)),
            yield* d.edit(cn.id, { note: "Dobropis", orderNumber: "PO-7" }, cn.revision),
          ] as const;
        }),
      ),
    );
    expect(linesErr).toEqual(illegal);
    expect(refreshErr).toEqual(illegal);
    expect(noted.revision).toBe(2);
    expect(str(noted.totals.gross.amount)).toBe("-2980");
  });

  test("after a partial credit the remainder credits each bucket's rest and closes to zero", async () => {
    const [spec, closed] = ok(
      await run(
        Effect.gen(function* () {
          const view = yield* issueInvoice();
          const original = yield* (yield* DocumentsRepo).get(WS, view.id);
          const [standard] = original.totals.buckets;
          // An earlier Credit Note that credited the whole 21 % bucket.
          const partial = {
            ...original,
            totals: VatMath.negate(
              VatMath.fromBuckets(standard ? [standard] : [], original.currency),
            ),
          };
          const spec = remainderSpec(original, [partial]);
          const closed = isFullyCredited(
            remainingBuckets(original, [partial, { ...original, totals: spec.totals }]),
          );
          return [spec, closed] as const;
        }),
      ),
    );
    expect(
      spec.lines.map((l) => [l.treatment, str(l.quantity), str(l.unitPrice), str(l.amount)]),
    ).toEqual([["reduced", "-1", "500", "-500"]]);
    expect(str(spec.totals.vat.amount)).toBe("-60");
    expect(str(spec.totals.gross.amount)).toBe("-560");
    expect(closed).toBe(true);
  });
});

describe("council follow-ups", () => {
  test("unrelated edits keep the issued amounts and a pinned null note", async () => {
    const [before, edited, refreshed] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const f = yield* DocumentFixtures;
          const view = yield* issueInvoice();
          // The Workspace stops being a VAT payer and gains a default note.
          yield* f.putIssuer(
            issuer(WS, "non_vat_payer", { seriesByKind: {}, defaultNote: "Nová" }),
          );
          const edited = yield* d.edit(view.id, { orderNumber: "PO-1" }, view.revision);
          const refreshed = yield* d.edit(
            view.id,
            { paymentMethod: "cash", issuedOn: "2026-11-22" as IsoDate },
            edited.revision,
          );
          return [view, edited, refreshed] as const;
        }),
      ),
    );
    expect((json(edited) as { totals: unknown }).totals).toEqual(
      (json(before) as { totals: unknown }).totals,
    );
    expect(edited.taxDocument).toBe(true);
    expect(refreshed.paymentMethod).toBe("cash");
    expect(refreshed.dates).toEqual({
      issuedOn: "2026-11-22" as IsoDate,
      taxableSupplyOn: TODAY,
      dueOn: "2026-12-06" as IsoDate,
    });
    expect((json(refreshed) as { totals: unknown }).totals).toEqual(
      (json(before) as { totals: unknown }).totals,
    );
  });

  test("D3a amount guard and settlement follow-up", async () => {
    const [guarded, settlement] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const repo = yield* DocumentsRepo;
          const store = yield* CoreStore;
          const proforma = yield* issueProforma();
          const pRow = yield* repo.get(WS, proforma.id);
          const paidP = yield* store.transaction(
            repo.update({ ...pRow, payments: 1 }, pRow.revision),
          );
          const guarded = yield* Effect.flip(
            d.edit(proforma.id, { pricesIncludeVat: true }, paidP.revision),
          );
          const invoice = yield* issueInvoice();
          const iRow = yield* repo.get(WS, invoice.id);
          const paidI = yield* store.transaction(
            repo.update(
              { ...iRow, payments: 1, paidAmount: dec("2980"), settlement: "paid" },
              iRow.revision,
            ),
          );
          const cheaper = yield* d.edit(
            invoice.id,
            { lines: [invoiceInput().lines[0]] as never },
            paidI.revision,
          );
          return [guarded, cheaper.settlement] as const;
        }),
      ),
    );
    expect(guarded).toEqual(illegal);
    expect(settlement).toBe("overpaid");
  });

  test("Credit Note dates, no cancel of a Credit Note, no future correction date", async () => {
    const [cn, cancelCn, future] = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* docs;
          const view = yield* issueInvoice({ issuedOn: "2026-11-20" as IsoDate });
          const future = yield* Effect.flip(
            d.cancel(view.id, { reason: "x", on: "2026-11-24" as IsoDate }),
          );
          const { creditNote } = yield* d.cancel(view.id, {
            reason: "x",
            on: "2026-11-21" as IsoDate,
          });
          const cn = creditNote as DocumentView;
          const row = yield* (yield* DocumentsRepo).get(WS, cn.id);
          return [
            { dates: cn.dates, correctedNumber: row.correctedNumber, reason: row.reason },
            yield* Effect.flip(d.cancel(cn.id, { reason: "x" })),
            future,
          ] as const;
        }),
      ),
    );
    expect(cn).toEqual({
      dates: { issuedOn: TODAY, taxableSupplyOn: "2026-11-21" as IsoDate, dueOn: TODAY },
      correctedNumber: "2026-0001",
      reason: "x",
    });
    expect(cancelCn).toEqual(illegal);
    expect(future).toEqual(
      new Invalid({
        issues: [{ path: ["on"], code: "request.malformed", params: { reason: "out_of_range" } }],
      }),
    );
  });
});
