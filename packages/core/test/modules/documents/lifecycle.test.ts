import { TestCaller } from "../../helpers/callerContext";
import { withoutStackTrace } from "../../helpers/run";
/** Documents P2: issue, numbering, the state machine, lock/unlock, number override, cancel. */

import { describe, expect, test } from "bun:test";
import type { Caller, DocumentView } from "@kvitbit/domain/contract";
import {
  Conflict,
  Documents,
  Forbidden,
  Invalid,
  IsoDate,
  NumberingSeriesId,
  RequestKey,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as EffectRecord from "effect/Record";
import * as EffectString from "effect/String";
import { VatMath } from "../../../src/engines/vat";
import type {
  IssuerForDocument,
  LifecycleAction,
  LifecycleState,
} from "../../../src/modules/documents";
import {
  DocumentFixtures,
  DocumentsRepo,
  isFullyCredited,
  LIFECYCLE_ACTIONS,
  LIFECYCLE_STATES,
  remainderSpec,
  TRANSITIONS,
} from "../../../src/modules/documents";
import { NumberingSeries } from "../../../src/modules/numbering";
import { CoreStore } from "../../../src/store/CoreStore";
import { member, WORKSPACE_B, WORKSPACE_A as WS } from "../../helpers";
import type { Services } from "./fixtures";
import {
  as,
  CZ_BUYER,
  CZK_ACCOUNT,
  concreteView,
  contact,
  DE_BUYER,
  dec,
  EUR,
  EUR_ACCOUNT,
  encodedView,
  invoiceInput,
  issuer,
  present,
  scenario,
  str,
} from "./fixtures";

const TODAY = IsoDate.make("2026-11-23");

const ok = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${String(exit.cause)}`);
  return exit.value;
};

const buyer = (view: DocumentView) => concreteView(view).contact;
const seller = (view: DocumentView) => concreteView(view).issuer;

const illegal = Conflict.make({ reason: "illegal_transition" });
const locked = Conflict.make({ reason: "document_locked" });

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
      ...options,
      billingA: { seriesByKind: {}, ...options.billingA },
    },
  );

const issueInvoice = (extra: Parameters<typeof invoiceInput>[0] = {}) =>
  Effect.flatMap(Documents, (d) =>
    Effect.flatMap(TestCaller, (caller) => d.issue(caller, { input: invoiceInput(extra) })),
  );
const issueProforma = () => issueInvoice({ kind: "proforma" });

describe("issue", () => {
  test("numbers a draft from its series, freezes it and audits create + issue", async () => {
    const [view, row, history] = ok(
      await run(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const draft = yield* d.createDraft(testCaller, invoiceInput({ issuedOn: undefined }));
          const documentView = yield* d.issue(testCaller, {
            draft: draft.id,
            expectedRevision: draft.revision,
          });
          const rowResult = yield* (yield* DocumentsRepo).get(WS, documentView.id);
          return [documentView, rowResult, yield* d.history(testCaller, documentView.id)] as const;
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
    expect(row.given.series).toBe(present(row.seriesId));
    expect(row.issuedAt).not.toBeNull();
    expect(EffectArray.map(history, (e) => [e.action, e.revision])).toEqual([
      ["document.create", 1],
      ["document.issue", 2],
    ]);
    expect(history[1]?.changes).toEqual([{ path: "number", before: null, after: "2026-0001" }]);
  });

  test("straight from input; numbering is gapless and discarded drafts consume nothing", async () => {
    const numbers = ok(
      await run(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const a = yield* issueInvoice();
          const draft = yield* d.createDraft(testCaller, invoiceInput());
          yield* d.discardDraft(testCaller, draft.id, draft.revision);
          const b = yield* issueInvoice();
          const p = yield* issueProforma();
          const history = yield* d.history(testCaller, a.id);
          return [a.number, b.number, p.number, EffectArray.map(history, (e) => e.action)];
        }),
      ),
    );
    expect(numbers).toEqual(["2026-0001", "2026-0002", "ZF-2026-0001", ["document.issue"]]);
  });

  test("an exhausted series surfaces Conflict{illegal_transition, numbering.pattern_invalid} and rolls back", async () => {
    const [error, draft] = ok(
      await run(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const store = yield* CoreStore;
          yield* store.transaction(
            (yield* NumberingSeries).configure(
              WS,
              {
                kind: "invoice",
                name: "Krátká",
                pattern: `${EffectString.repeat(18)("A")}-N`,
                nextNumber: 9,
                isDefault: true,
              },
              TODAY,
            ),
          );
          const first = yield* issueInvoice();
          expect(first.number).toBe(`${EffectString.repeat(18)("A")}-9`);
          const draftResult = yield* d.createDraft(testCaller, invoiceInput());
          const errorResult = yield* Effect.flip(
            d.issue(testCaller, { draft: draftResult.id, expectedRevision: draftResult.revision }),
          );
          return [errorResult, yield* d.get(testCaller, draftResult.id)] as const;
        }),
      ),
    );
    expect(error).toEqual(
      Conflict.make({ reason: "illegal_transition", detail: "numbering.pattern_invalid" }),
    );
    expect(draft.status).toBe("draft");
    expect(draft.number).toBeNull();
    expect(draft.revision).toBe(1);
  });

  test("a blind retry without a requestKey fails illegal_transition; a stale draft revision_changed", async () => {
    const [retry, stale] = ok(
      await run(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const draft = yield* d.createDraft(testCaller, invoiceInput());
          yield* d.issue(testCaller, { draft: draft.id, expectedRevision: 1 });
          const retryResult = yield* Effect.flip(
            d.issue(testCaller, { draft: draft.id, expectedRevision: 1 }),
          );
          const other = yield* d.createDraft(testCaller, invoiceInput());
          yield* d.edit(testCaller, other.id, { note: "změna" }, 1);
          const staleResult = yield* Effect.flip(
            d.issue(testCaller, { draft: other.id, expectedRevision: 1 }),
          );
          return [retryResult, staleResult] as const;
        }),
      ),
    );
    expect(retry).toEqual(illegal);
    expect(stale).toEqual(Conflict.make({ reason: "revision_changed", currentRevision: 2 }));
  });

  test("a requestKey replays the stored result and never numbers twice", async () => {
    const [first, again, next, mismatch] = ok(
      await run(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const key = { requestKey: RequestKey.make("issue-1") };
          const draft = yield* d.createDraft(testCaller, invoiceInput());
          const from = { draft: draft.id, expectedRevision: 1 };
          const firstResult = yield* d.issue(testCaller, from, key);
          const repeated = yield* d.issue(testCaller, from, key);
          const nextResult = yield* issueInvoice();
          const mismatchResult = yield* Effect.flip(
            d.issue(testCaller, { input: invoiceInput() }, key),
          );
          return [firstResult, repeated, nextResult.number, mismatchResult] as const;
        }),
      ),
    );
    expect(await encodedView(again)).toEqual(await encodedView(first));
    expect(next).toBe("2026-0002");
    expect(mismatch).toEqual(Conflict.make({ reason: "idempotency_mismatch" }));
  });

  test("party snapshots stay frozen after Contact and Workspace changes until refreshParties", async () => {
    const [afterChange, afterEdit, refreshed, history] = ok(
      await run(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const f = yield* DocumentFixtures;
          const view = yield* issueInvoice();
          yield* f.putContact(WS, contact(CZ_BUYER, { name: "Nový název a.s." }));
          const changed = issuer(WS, "vat_payer", { seriesByKind: {}, dueDays: 30 });
          yield* f.putIssuer({
            ...changed,
            party: { ...changed.party, name: "Nová firma s.r.o." },
          });
          const afterChangeResult = yield* d.get(testCaller, view.id);
          const afterEditResult = yield* d.edit(
            testCaller,
            view.id,
            { note: "Díky" },
            view.revision,
          );
          const refreshedResult = yield* d.edit(
            testCaller,
            view.id,
            { refreshParties: true },
            afterEditResult.revision,
          );
          return [
            afterChangeResult,
            afterEditResult,
            refreshedResult,
            yield* d.history(testCaller, view.id),
          ] as const;
        }),
      ),
    );
    expect(buyer(afterChange).name).toBe("Odběratel a.s.");
    expect(seller(afterChange).name).toBe("Dodavatel s.r.o.");
    expect(buyer(afterEdit).name).toBe("Odběratel a.s.");
    expect(seller(afterEdit).name).toBe("Dodavatel s.r.o.");
    // The Workspace's new dueDays does not move a pinned due date.
    expect(afterEdit.dates.dueOn).toBe(IsoDate.make("2026-12-07"));
    expect(buyer(refreshed).name).toBe("Nový název a.s.");
    expect(seller(refreshed).name).toBe("Nová firma s.r.o.");
    // An issue from input stores its draft row at revision 1 and numbers it at 2 (D1).
    expect(EffectArray.map(history, (e) => [e.action, e.revision])).toEqual([
      ["document.issue", 2],
      ["document.edit", 3],
      ["document.edit", 4],
    ]);
    expect(EffectArray.map(present(history[1]).changes, (c) => c.path)).toEqual([
      "note",
      "given.note",
    ]);
    expect(EffectArray.map(present(history[2]).changes, (c) => c.path)).toEqual([
      "contact",
      "issuer",
    ]);
  });
});

// State machine -----------------------------------------------------------------------------

const SERVICE_ACTIONS = ["edit", "discard", "issue", "lock", "unlock", "cancel"] as const;
type ServiceAction = (typeof SERVICE_ACTIONS)[number];

/** Expected outcome of every service action in every state (D2, D3a, D5, D13). */
const EXPECTED = {
  draft: {
    edit: "ok",
    discard: "ok",
    issue: "ok",
    lock: "illegal_transition",
    unlock: "illegal_transition",
    cancel: "illegal_transition",
  },
  issued: {
    edit: "ok",
    discard: "illegal_transition",
    issue: "illegal_transition",
    lock: "ok",
    unlock: "noop",
    cancel: "ok",
  },
  locked: {
    edit: "document_locked",
    discard: "illegal_transition",
    issue: "illegal_transition",
    lock: "noop",
    unlock: "ok",
    cancel: "document_locked",
  },
  cancelled: {
    edit: "illegal_transition",
    discard: "illegal_transition",
    issue: "illegal_transition",
    lock: "noop",
    unlock: "illegal_transition",
    cancel: "illegal_transition",
  },
} satisfies Record<
  LifecycleState,
  Record<ServiceAction, "ok" | "noop" | "illegal_transition" | "document_locked">
>;

/** A Proforma (never a tax document, so cancel cancels) in `state`. */
const inState = (state: LifecycleState) =>
  Effect.gen(function* () {
    const testCaller = yield* TestCaller;
    const d = yield* Documents;
    if (state === "draft")
      return yield* d.createDraft(testCaller, invoiceInput({ kind: "proforma" }));
    const view = yield* issueProforma();
    if (state === "locked") return yield* d.lock(testCaller, view.id);
    if (state === "cancelled")
      return (yield* d.cancel(testCaller, view.id, { reason: "chyba" })).document;
    return view;
  });

const act = (action: ServiceAction, view: DocumentView) =>
  Effect.gen(function* () {
    const testCaller = yield* TestCaller;
    const d = yield* Documents;
    switch (action) {
      case "edit":
        return yield* d.edit(testCaller, view.id, { note: "x" }, view.revision);
      case "discard":
        return yield* d.discardDraft(testCaller, view.id, view.revision);
      case "issue":
        return yield* d.issue(testCaller, { draft: view.id, expectedRevision: view.revision });
      case "lock":
        return yield* d.lock(testCaller, view.id);
      case "unlock":
        return yield* d.unlock(testCaller, view.id, "oprava");
      case "cancel":
        return yield* d.cancel(testCaller, view.id, { reason: "storno" });
    }
  });

describe("state machine", () => {
  for (const state of LIFECYCLE_STATES) {
    for (const action of SERVICE_ACTIONS) {
      const expected = EXPECTED[state][action];
      test(`${action} on ${state}: ${expected}`, async () => {
        const [before, exit, after, history] = ok(
          await run(
            Effect.gen(function* () {
              const testCaller = yield* TestCaller;
              const d = yield* Documents;
              const beforeResult = yield* inState(state);
              const historyBefore = (yield* d.history(testCaller, beforeResult.id)).length;
              const exitResult = yield* Effect.exit(act(action, beforeResult));
              const afterResult =
                action === "discard" && Exit.isSuccess(exitResult)
                  ? null
                  : yield* d.get(testCaller, beforeResult.id);
              const historyAfter =
                afterResult === null
                  ? historyBefore
                  : (yield* d.history(testCaller, beforeResult.id)).length;
              return [beforeResult, exitResult, afterResult, historyAfter - historyBefore] as const;
            }),
          ),
        );
        const assertSuccess = () => {
          expect(Exit.isSuccess(exit)).toBe(true);
        };
        const assertNoop = () => {
          assertSuccess();
          expect(after).toEqual(before);
          expect(history).toBe(0);
        };
        const assertConflict = (reason: "illegal_transition" | "document_locked") => {
          expect(exit.pipe(withoutStackTrace)).toEqual(Exit.fail(Conflict.make({ reason })));
          expect(after?.revision).toBe(before.revision);
          expect(history).toBe(0);
        };
        switch (expected) {
          case "ok":
            assertSuccess();
            break;
          case "noop":
            assertNoop();
            break;
          default:
            assertConflict(expected);
        }
        expect(TRANSITIONS[state][action]).toBe(expected);
      });
    }
  }

  test("the table covers every state x action; later-phase actions follow D5 and D13", () => {
    for (const state of LIFECYCLE_STATES) {
      expect(EffectArray.sort(EffectRecord.keys(TRANSITIONS[state]), EffectString.Order)).toEqual(
        EffectArray.sort(LIFECYCLE_ACTIONS, EffectString.Order),
      );
    }
    const later: ReadonlyArray<LifecycleAction> = [
      "correct",
      "finalInvoice",
      "send",
      "share",
      "recordPayment",
    ];
    expect(EffectArray.map(later, (a) => TRANSITIONS.draft[a])).toEqual(
      EffectArray.map(later, () => "illegal_transition"),
    );
    expect(EffectArray.map(later, (a) => TRANSITIONS.issued[a])).toEqual(
      EffectArray.map(later, () => "ok"),
    );
    expect(EffectArray.map(later, (a) => TRANSITIONS.locked[a])).toEqual([
      "document_locked",
      "ok",
      "ok",
      "ok",
      "ok",
    ]);
    expect(EffectArray.map(later, (a) => TRANSITIONS.cancelled[a])).toEqual(
      EffectArray.map(later, () => "illegal_transition"),
    );
  });
});

// Lock / unlock -----------------------------------------------------------------------------

describe("lock and unlock", () => {
  test("lock is idempotent and audited once; unlock needs a reason that is audited", async () => {
    const [first, second, blank, unlocked, history] = ok(
      await run(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const view = yield* issueInvoice();
          const firstResult = yield* d.lock(testCaller, view.id);
          const secondResult = yield* d.lock(testCaller, view.id);
          const blankReason = yield* Effect.flip(d.unlock(testCaller, view.id, "   "));
          const unlockedResult = yield* d.unlock(testCaller, view.id, "  oprava adresy ");
          return [
            firstResult,
            secondResult,
            blankReason,
            unlockedResult,
            yield* d.history(testCaller, view.id),
          ] as const;
        }),
      ),
    );
    expect(first.locked).toBe(true);
    expect(second).toEqual(first);
    // A missing reason fails with Invalid.
    expect(blank).toEqual(
      Invalid.make({
        issues: [{ path: ["reason"], code: "request.malformed", params: { reason: "required" } }],
      }),
    );
    expect(unlocked.locked).toBe(false);
    expect(EffectArray.map(history, (e) => [e.action, e.reason])).toEqual([
      ["document.issue", null],
      ["document.lock", null],
      ["document.unlock", "oprava adresy"],
    ]);
  });

  test("unlock needs owner or admin; lock is open to member, not accountant", async () => {
    const results = ok(
      await run(
        Effect.gen(function* () {
          const d = yield* Documents;
          const view = yield* issueInvoice();
          const accountantLock = yield* Effect.flip(
            as(member("accountant"), d.lock(member("accountant"), view.id)),
          );
          yield* as(member("member"), d.lock(member("member"), view.id));
          const memberUnlock = yield* Effect.flip(
            as(member("member"), d.unlock(member("member"), view.id, "x")),
          );
          const adminUnlock = yield* as(member("admin"), d.unlock(member("admin"), view.id, "x"));
          return [accountantLock, memberUnlock, adminUnlock.locked] as const;
        }),
      ),
    );
    expect(results).toEqual([
      Forbidden.make({ action: "document.lock" }),
      Forbidden.make({ action: "document.unlock" }),
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
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const view = yield* issueInvoice();
          const editedResult = yield* d.edit(
            testCaller,
            view.id,
            { lines: [invoiceInput().lines[0]] },
            view.revision,
          );
          const seriesResult = yield* Effect.flip(
            d.edit(
              testCaller,
              view.id,
              { series: NumberingSeriesId.make("01900000-0000-7000-8000-000000000999") },
              editedResult.revision,
            ),
          );
          return [editedResult, yield* d.history(testCaller, view.id), seriesResult] as const;
        }),
      ),
    );
    edited.totals.gross.amount.pipe(str, expect).toBe("2420");
    expect(edited.number).toBe("2026-0001");
    expect(EffectArray.map(present(history.at(-1)).changes, (c) => c.path)).toEqual([
      "lines",
      "totals",
    ]);
    expect(series).toEqual(illegal);
  });

  test("D3a: a document with dependents keeps lines, currency and tax point; text still edits", async () => {
    const [linesErr, taxPointErr, note] = ok(
      await run(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const repo = yield* DocumentsRepo;
          const store = yield* CoreStore;
          const view = yield* issueProforma();
          const row = yield* repo.get(WS, view.id);
          const paid = yield* store.transaction(repo.update({ ...row, payments: 1 }, row.revision));
          const linesErrResult = yield* Effect.flip(
            d.edit(testCaller, view.id, { lines: invoiceInput().lines }, paid.revision),
          );
          const taxPointErrResult = yield* Effect.flip(
            d.edit(
              testCaller,
              view.id,
              { taxableSupplyOn: IsoDate.make("2026-11-20") },
              paid.revision,
            ),
          );
          const noteResult = yield* d.edit(testCaller, view.id, { note: "Záloha" }, paid.revision);
          return [linesErrResult, taxPointErrResult, noteResult.revision] as const;
        }),
      ),
    );
    expect(linesErr).toEqual(illegal);
    expect(taxPointErr).toEqual(illegal);
    expect(note).toBe(4);
  });
});

// Number override (D4) ----------------------------------------------------------------------

describe("number override", () => {
  test("owner/admin only; a reserved number is Conflict{duplicate}; the old one stays reserved", async () => {
    const [renamed, taken, old, memberTry, draftTry, history, row] = ok(
      await run(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const a = yield* issueInvoice();
          const b = yield* issueInvoice();
          const renamedResult = yield* d.edit(
            testCaller,
            a.id,
            { number: " 2026-0100 " },
            a.revision,
          );
          const takenResult = yield* Effect.flip(
            d.edit(testCaller, b.id, { number: "2026-0100" }, b.revision),
          );
          const oldResult = yield* Effect.flip(
            d.edit(testCaller, b.id, { number: "2026-0001" }, b.revision),
          );
          const memberTryResult = yield* Effect.flip(
            as(
              member("member"),
              d.edit(member("member"), b.id, { number: "2026-0200" }, b.revision),
            ),
          );
          const draft = yield* d.createDraft(testCaller, invoiceInput());
          const draftTryResult = yield* Effect.flip(
            d.edit(testCaller, draft.id, { number: "D-1" }, 1),
          );
          const rowResult = yield* (yield* DocumentsRepo).get(WS, a.id);
          return [
            renamedResult,
            takenResult,
            oldResult,
            memberTryResult,
            draftTryResult,
            yield* d.history(testCaller, a.id),
            rowResult,
          ] as const;
        }),
      ),
    );
    expect(renamed.number).toBe("2026-0100");
    expect(row.variableSymbol).toBe("20260100");
    expect(taken).toEqual(Conflict.make({ reason: "duplicate" }));
    expect(old).toEqual(Conflict.make({ reason: "duplicate" }));
    expect(memberTry).toEqual(Forbidden.make({ action: "document.overrideNumber" }));
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
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const view = yield* issueProforma();
          const operationResult = yield* d.cancel(testCaller, view.id, {
            reason: "duplicita",
            on: IsoDate.make("2026-11-23"),
          });
          return [operationResult, yield* d.history(testCaller, view.id)] as const;
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
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const view = yield* issueInvoice();
          const operationResult2 = yield* d.cancel(testCaller, view.id, { reason: "vráceno" });
          const repeated = yield* Effect.flip(d.cancel(testCaller, view.id, { reason: "znovu" }));
          return [
            operationResult2,
            repeated,
            yield* d.history(testCaller, present(operationResult2.creditNote).id),
          ] as const;
        }),
      ),
    );
    const { document } = result;
    const creditNote = present(result.creditNote);
    expect(document.status).toBe("issued");
    expect(document.settlement).toBe("credited");
    expect(creditNote?.kind).toBe("credit_note");
    expect(creditNote?.number).toBe("OD-2026-0001");
    expect(creditNote?.taxDocument).toBe(true);
    expect(creditNote?.overdue).toBe(false);
    expect(creditNote?.dates).toEqual({ issuedOn: TODAY, taxableSupplyOn: TODAY, dueOn: TODAY });
    creditNote.totals.net.amount.pipe(str, expect).toBe("-2500");
    creditNote.totals.vat.amount.pipe(str, expect).toBe("-480");
    creditNote.totals.gross.amount.pipe(str, expect).toBe("-2980");
    expect(document.related).toEqual([
      {
        relation: "corrected_by",
        id: creditNote.id,
        kind: "credit_note",
        number: "OD-2026-0001",
      },
    ]);
    expect(creditNote?.related).toEqual([
      { relation: "corrects", id: document.id, kind: "invoice", number: "2026-0001" },
    ]);
    expect(again).toEqual(illegal);
    expect(EffectArray.map(cnHistory, (e) => [e.action, e.reason])).toEqual([
      ["document.issue", "vráceno"],
    ]);
  });

  test("payments, a Final Invoice, a lock, a missing reason or a date before issue block it", async () => {
    const results = ok(
      await run(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
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
          const lockedDoc = yield* d.lock(testCaller, (yield* issueInvoice()).id);
          const open = yield* issueInvoice();
          return [
            yield* Effect.flip(d.cancel(testCaller, paid.id, { reason: "x" })),
            yield* Effect.flip(d.cancel(testCaller, proforma.id, { reason: "x" })),
            yield* Effect.flip(d.cancel(testCaller, lockedDoc.id, { reason: "x" })),
            yield* Effect.flip(d.cancel(testCaller, open.id, { reason: " " })),
            yield* Effect.flip(
              d.cancel(testCaller, open.id, { reason: "x", on: IsoDate.make("2026-11-01") }),
            ),
          ];
        }),
      ),
    );
    expect(results).toEqual([
      illegal,
      illegal,
      locked,
      Invalid.make({
        issues: [{ path: ["reason"], code: "request.malformed", params: { reason: "required" } }],
      }),
      Invalid.make({
        issues: [{ path: ["on"], code: "request.malformed", params: { reason: "out_of_range" } }],
      }),
    ]);
  });

  test("a requestKey replays the cancel result without a second Credit Note", async () => {
    const [first, again, next] = ok(
      await run(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const key = { requestKey: RequestKey.make("cancel-1") };
          const view = yield* issueInvoice();
          const firstResult = yield* d.cancel(testCaller, view.id, { reason: "x" }, key);
          const repeatedResult = yield* d.cancel(testCaller, view.id, { reason: "x" }, key);
          const other = yield* issueInvoice();
          const nextResult = yield* d.cancel(testCaller, other.id, { reason: "x" });
          return [firstResult, repeatedResult, nextResult.creditNote?.number] as const;
        }),
      ),
    );
    expect(await encodedView(again.document)).toEqual(await encodedView(first.document));
    expect(await encodedView(present(again.creditNote))).toEqual(
      await encodedView(present(first.creditNote)),
    );
    expect(next).toBe("OD-2026-0002");
  });
});

// Authorization and Workspace scoping -------------------------------------------------------

describe("authorization and scoping", () => {
  test("accountants cannot issue, cancel or edit; members can issue and cancel", async () => {
    const results = ok(
      await run(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const accountant = member("accountant");
          const draft = yield* d.createDraft(testCaller, invoiceInput());
          const view = yield* issueInvoice();
          return [
            yield* Effect.flip(
              as(accountant, d.issue(accountant, { draft: draft.id, expectedRevision: 1 })),
            ),
            yield* Effect.flip(as(accountant, d.cancel(accountant, view.id, { reason: "x" }))),
            yield* Effect.flip(
              as(accountant, d.edit(accountant, view.id, { note: "x" }, view.revision)),
            ),
            (yield* as(
              member("member"),
              d.issue(member("member"), { draft: draft.id, expectedRevision: 1 }),
            )).status,
            (yield* as(member("member"), d.cancel(member("member"), view.id, { reason: "x" })))
              .document.settlement,
          ];
        }),
      ),
    );
    expect(results).toEqual([
      Forbidden.make({ action: "document.issue" }),
      Forbidden.make({ action: "document.cancel" }),
      Forbidden.make({ action: "document.edit" }),
      "issued",
      "credited",
    ]);
  });

  test("another Workspace's documents are NotFound for every lifecycle method", async () => {
    const misses = ok(
      await run(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const other = member("owner", { workspaceId: WORKSPACE_B });
          const draft = yield* d.createDraft(testCaller, invoiceInput());
          const view = yield* issueInvoice();
          return [
            yield* Effect.flip(as(other, d.issue(other, { draft: draft.id, expectedRevision: 1 }))),
            yield* Effect.flip(as(other, d.edit(other, view.id, { note: "x" }, view.revision))),
            yield* Effect.flip(as(other, d.edit(other, view.id, { number: "X-1" }, view.revision))),
            yield* Effect.flip(as(other, d.lock(other, view.id))),
            yield* Effect.flip(as(other, d.unlock(other, view.id, "x"))),
            yield* Effect.flip(as(other, d.cancel(other, view.id, { reason: "x" }))),
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
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const { creditNote } = yield* d.cancel(testCaller, (yield* issueInvoice()).id, {
            reason: "x",
          });
          const cn = present(creditNote);
          return [
            yield* Effect.flip(
              d.edit(testCaller, cn.id, { lines: invoiceInput().lines }, cn.revision),
            ),
            yield* Effect.flip(d.edit(testCaller, cn.id, { refreshParties: true }, cn.revision)),
            yield* d.edit(
              testCaller,
              cn.id,
              { note: "Dobropis", orderNumber: "PO-7" },
              cn.revision,
            ),
          ] as const;
        }),
      ),
    );
    expect(linesErr).toEqual(illegal);
    expect(refreshErr).toEqual(illegal);
    // Issued at revision 2 (draft row, then numbered), one edit.
    expect(noted.revision).toBe(3);
    noted.totals.gross.amount.pipe(str, expect).toBe("-2980");
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
              VatMath.fromBuckets(standard === undefined ? [] : [standard], original.currency),
            ),
          };
          const specResult = remainderSpec(original, [partial]);
          const closedResult = isFullyCredited(original, [
            partial,
            { ...original, totals: specResult.totals },
          ]);
          return [specResult, closedResult] as const;
        }),
      ),
    );
    expect(
      EffectArray.map(spec.lines, (l) => [
        l.treatment,
        str(l.quantity),
        str(l.unitPrice),
        str(l.amount),
      ]),
    ).toEqual([["reduced", "-1", "500", "-500"]]);
    spec.totals.vat.amount.pipe(str, expect).toBe("-60");
    spec.totals.gross.amount.pipe(str, expect).toBe("-560");
    expect(closed).toBe(true);
  });
});

describe("council follow-ups", () => {
  test("unrelated edits keep the issued amounts and a pinned null note", async () => {
    const [before, edited, refreshed] = ok(
      await run(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const f = yield* DocumentFixtures;
          const view = yield* issueInvoice();
          // The Workspace stops being a VAT payer and gains a default note.
          yield* f.putIssuer(
            issuer(WS, "non_vat_payer", { seriesByKind: {}, defaultNote: "Nová" }),
          );
          const editedResult = yield* d.edit(
            testCaller,
            view.id,
            { orderNumber: "PO-1" },
            view.revision,
          );
          const refreshedResult = yield* d.edit(
            testCaller,
            view.id,
            { paymentMethod: "cash", issuedOn: IsoDate.make("2026-11-22") },
            editedResult.revision,
          );
          return [view, editedResult, refreshedResult] as const;
        }),
      ),
    );
    expect((await encodedView(edited)).totals).toEqual((await encodedView(before)).totals);
    expect(edited.taxDocument).toBe(true);
    expect(refreshed.paymentMethod).toBe("cash");
    expect(refreshed.dates).toEqual({
      issuedOn: IsoDate.make("2026-11-22"),
      taxableSupplyOn: TODAY,
      dueOn: IsoDate.make("2026-12-06"),
    });
    expect((await encodedView(refreshed)).totals).toEqual((await encodedView(before)).totals);
  });

  test("D3a amount guard and settlement follow-up", async () => {
    const [guarded, settlement] = ok(
      await run(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const repo = yield* DocumentsRepo;
          const store = yield* CoreStore;
          const proforma = yield* issueProforma();
          const pRow = yield* repo.get(WS, proforma.id);
          const paidP = yield* store.transaction(
            repo.update({ ...pRow, payments: 1 }, pRow.revision),
          );
          const guardedResult = yield* Effect.flip(
            d.edit(testCaller, proforma.id, { pricesIncludeVat: true }, paidP.revision),
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
            testCaller,
            invoice.id,
            { lines: [invoiceInput().lines[0]] },
            paidI.revision,
          );
          return [guardedResult, cheaper.settlement] as const;
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
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const view = yield* issueInvoice({ issuedOn: IsoDate.make("2026-11-20") });
          const futureResult = yield* Effect.flip(
            d.cancel(testCaller, view.id, { reason: "x", on: IsoDate.make("2026-11-24") }),
          );
          const { creditNote } = yield* d.cancel(testCaller, view.id, {
            reason: "x",
            on: IsoDate.make("2026-11-21"),
          });
          const creditNoteView = present(creditNote);
          const row = yield* (yield* DocumentsRepo).get(WS, creditNoteView.id);
          return [
            {
              dates: creditNoteView.dates,
              correctedNumber: row.correctedNumber,
              reason: row.reason,
            },
            yield* Effect.flip(d.cancel(testCaller, creditNoteView.id, { reason: "x" })),
            futureResult,
          ] as const;
        }),
      ),
    );
    expect(cn).toEqual({
      dates: { issuedOn: TODAY, taxableSupplyOn: IsoDate.make("2026-11-21"), dueOn: TODAY },
      correctedNumber: "2026-0001",
      reason: "x",
    });
    expect(cancelCn).toEqual(illegal);
    expect(future).toEqual(
      Invalid.make({
        issues: [{ path: ["on"], code: "request.malformed", params: { reason: "out_of_range" } }],
      }),
    );
  });
});

describe("diff council follow-ups", () => {
  test("recomputing edits keep the frozen buyer, regime and rounding (D10)", async () => {
    const [reverse, regime] = ok(
      await run(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const f = yield* DocumentFixtures;
          const eu = yield* issueInvoice({
            contact: DE_BUYER,
            currency: EUR,
            fx: { manual: { rate: dec("25"), quantity: 1 } },
            lines: [{ description: "Služba", unitPrice: dec("100") }],
          });
          // The live Contact loses its VAT ID; the issued buyer still has it.
          yield* f.putContact(WS, contact(DE_BUYER, { country: "DE", dic: null }));
          const reverseResult = yield* d.edit(
            testCaller,
            eu.id,
            { lines: [{ description: "Služba", unitPrice: dec("120") }] },
            eu.revision,
          );
          const cz = yield* issueInvoice();
          yield* f.putIssuer(issuer(WS, "non_vat_payer", { seriesByKind: {} }));
          const regimeResult = yield* d.edit(
            testCaller,
            cz.id,
            { lines: [invoiceInput().lines[0]] },
            cz.revision,
          );
          return [reverseResult, regimeResult] as const;
        }),
      ),
    );
    expect(EffectArray.map(concreteView(reverse).lines, (line) => line.treatment)).toEqual([
      "reverse_charge",
    ]);
    reverse.totals.gross.amount.pipe(str, expect).toBe("120");
    expect(regime.taxDocument).toBe(true);
    regime.totals.vat.amount.pipe(str, expect).toBe("420");
  });

  test("a bank account edit keeps the amounts; payments freeze the currency; dependents the rate", async () => {
    const [account, currency, rate] = ok(
      await run(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const repo = yield* DocumentsRepo;
          const store = yield* CoreStore;
          const view = yield* issueInvoice();
          const accountResult = yield* Effect.flip(
            d.edit(testCaller, view.id, { bankAccount: EUR_ACCOUNT }, view.revision),
          );
          const same = yield* d.edit(
            testCaller,
            view.id,
            { bankAccount: CZK_ACCOUNT },
            view.revision,
          );
          const row = yield* repo.get(WS, view.id);
          const paid = yield* store.transaction(repo.update({ ...row, payments: 1 }, row.revision));
          const currencyResult = yield* Effect.flip(
            d.edit(testCaller, view.id, { currency: EUR }, paid.revision),
          );
          const proforma = yield* issueProforma();
          const pRow = yield* repo.get(WS, proforma.id);
          const paidP = yield* store.transaction(
            repo.update({ ...pRow, payments: 1 }, pRow.revision),
          );
          const rateResult = yield* Effect.flip(
            d.edit(
              testCaller,
              proforma.id,
              { fx: { manual: { rate: dec("25"), quantity: 1 } } },
              paidP.revision,
            ),
          );
          return [[accountResult, same.revision], currencyResult, rateResult] as const;
        }),
      ),
    );
    // The EUR account cannot take a CZK document.
    expect(account[0]).toMatchObject({ _tag: "Invalid" });
    expect(account[1]).toBe(3);
    expect(currency).toEqual(illegal);
    expect(rate).toEqual(illegal);
  });

  test("a Credit Note shows the corrected number as at correction time", async () => {
    const related = ok(
      await run(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const view = yield* issueInvoice();
          const { document, creditNote } = yield* d.cancel(testCaller, view.id, { reason: "x" });
          yield* d.edit(testCaller, view.id, { number: "2026-0500" }, document.revision);
          return (yield* d.get(testCaller, present(creditNote).id)).related;
        }),
      ),
    );
    expect(EffectArray.map(related, (r) => [r.relation, r.number])).toEqual([
      ["corrects", "2026-0001"],
    ]);
  });
});

describe("review round 1 follow-ups", () => {
  test("a credited document stays issued: refreshParties keeps its tax classification", async () => {
    const [refreshed, again] = ok(
      await run(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const f = yield* DocumentFixtures;
          const view = yield* issueInvoice();
          const { document } = yield* d.cancel(testCaller, view.id, { reason: "x" });
          yield* f.putIssuer(issuer(WS, "non_vat_payer", { seriesByKind: {} }));
          const refreshedResult = yield* d.edit(
            testCaller,
            view.id,
            { refreshParties: true },
            document.revision,
          );
          return [
            refreshedResult,
            yield* Effect.flip(d.cancel(testCaller, view.id, { reason: "y" })),
          ] as const;
        }),
      ),
    );
    expect(refreshed.taxDocument).toBe(true);
    expect(refreshed.status).toBe("issued");
    expect(refreshed.settlement).toBe("credited");
    expect(again).toEqual(illegal);
  });

  test("refreshParties keeps the issued rounding and amount owed", async () => {
    const [before, after] = ok(
      await run(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const f = yield* DocumentFixtures;
          const view = yield* issueInvoice({
            lines: [{ description: "Drobnost", unitPrice: dec("1.1") }],
          });
          yield* f.putIssuer({
            ...issuer(WS, "vat_payer", { seriesByKind: {} }),
            paymentRounding: "whole_unit",
          });
          return [
            view,
            yield* d.edit(testCaller, view.id, { refreshParties: true }, view.revision),
          ] as const;
        }),
      ),
    );
    const priorGross = str(before.totals.gross.amount);
    const refreshedGross = str(after.totals.gross.amount);
    expect(priorGross).toBe("1.33");
    expect(refreshedGross).toBe("1.33");
  });

  test("a bank account in another currency is Invalid on both edit paths", async () => {
    const [alone, withContact] = ok(
      await run(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const view = yield* issueInvoice();
          return [
            yield* Effect.flip(
              d.edit(testCaller, view.id, { bankAccount: EUR_ACCOUNT }, view.revision),
            ),
            yield* Effect.flip(
              d.edit(
                testCaller,
                view.id,
                { bankAccount: EUR_ACCOUNT, contact: CZ_BUYER },
                view.revision,
              ),
            ),
          ] as const;
        }),
      ),
    );
    for (const e of [alone, withContact]) {
      expect(e).toMatchObject({
        _tag: "Invalid",
        issues: [{ path: ["bankAccount"], params: { reason: "currency_mismatch" } }],
      });
    }
  });

  test("a renumbered Credit Note's variable symbol follows its number (D4)", async () => {
    const [before, after] = ok(
      await run(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const repo = yield* DocumentsRepo;
          const { creditNote } = yield* d.cancel(testCaller, (yield* issueInvoice()).id, {
            reason: "x",
          });
          const cn = present(creditNote);
          const beforeResult = (yield* repo.get(WS, cn.id)).variableSymbol;
          yield* d.edit(testCaller, cn.id, { number: "OD-777" }, cn.revision);
          return [beforeResult, (yield* repo.get(WS, cn.id)).variableSymbol] as const;
        }),
      ),
    );
    expect([before, after]).toEqual(["20260001", "777"]);
  });

  test("a changed due term is audited even when the due date stays", async () => {
    const changes = ok(
      await run(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const view = yield* issueInvoice();
          yield* d.edit(
            testCaller,
            view.id,
            { due: { on: IsoDate.make("2026-12-07") } },
            view.revision,
          );
          return (yield* d.history(testCaller, view.id)).at(-1)?.changes;
        }),
      ),
    );
    expect(changes).toEqual([
      { path: "given.due", before: { inDays: 14 }, after: { on: "2026-12-07" } },
    ]);
  });

  test("a CZK VAT residual stays in the remainder until credited", async () => {
    const row = ok(
      await run(
        Effect.gen(function* () {
          const view = yield* issueInvoice();
          return yield* (yield* DocumentsRepo).get(WS, view.id);
        }),
      ),
    );
    const bucket = (base: string, vat: string, czk: string) => ({
      treatment: "standard" as const,
      ratePercent: dec("21"),
      base: dec(base),
      vat: dec(vat),
      gross: BigDecimal.sum(dec(base), dec(vat)),
      vatCzk: dec(czk),
    });
    const original = {
      ...row,
      lines: [],
      currency: EUR,
      totals: VatMath.fromBuckets([bucket("1", "0.21", "0.49")], EUR),
    };
    const partial = {
      ...original,
      totals: VatMath.fromBuckets([bucket("-1", "-0.21", "-0.48")], EUR),
    };
    const spec = remainderSpec(original, [partial]);
    expect(EffectArray.map(spec.totals.buckets, (b) => b.vatCzk && str(b.vatCzk))).toEqual([
      "-0.01",
    ]);
    expect(isFullyCredited(original, [partial])).toBe(false);
    expect(isFullyCredited(original, [partial, { totals: spec.totals }])).toBe(true);
  });

  test("issue with send rolls back numbering, audit and the request log when sending fails", async () => {
    const [failed, draft, history, retried] = ok(
      await run(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const key = { requestKey: RequestKey.make("issue-send") };
          const created = yield* d.createDraft(testCaller, invoiceInput());
          const from = { draft: created.id, expectedRevision: 1 };
          // The sender stub dies (stage 2 delivers): everything since the row lock reverts.
          const failedResult = yield* Effect.exit(d.issue(testCaller, from, { ...key, send: {} }));
          const draftResult = yield* d.get(testCaller, created.id);
          const trail = yield* d.history(testCaller, created.id);
          const historyResult = EffectArray.map(trail, (e) => e.action);
          // Same key, other payload: no request-log row survived, so this runs fresh.
          const retriedResult = yield* d.issue(testCaller, from, key);
          return [
            Exit.isFailure(failedResult),
            draftResult,
            historyResult,
            retriedResult.number,
          ] as const;
        }),
      ),
    );
    expect(failed).toBe(true);
    expect([draft.status, draft.number, draft.revision]).toEqual(["draft", null, 1]);
    expect(history).toEqual(["document.create"]);
    expect(retried).toBe("2026-0001");
  });
});

describe("review round 2 follow-ups", () => {
  test("an explicit variable symbol equal to the derived one is audited and stops following", async () => {
    const [changes, renumbered] = ok(
      await run(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const view = yield* issueInvoice();
          const pinned = yield* d.edit(
            testCaller,
            view.id,
            { variableSymbol: "20260001" },
            view.revision,
          );
          const changesResult = (yield* d.history(testCaller, view.id)).at(-1)?.changes;
          yield* d.edit(testCaller, view.id, { number: "X-777" }, pinned.revision);
          return [
            changesResult,
            (yield* (yield* DocumentsRepo).get(WS, view.id)).variableSymbol,
          ] as const;
        }),
      ),
    );
    expect(changes).toEqual([{ path: "given.variableSymbol", before: null, after: "20260001" }]);
    expect(renumbered).toBe("20260001");
  });

  test("a Credit Note never inherits the corrected document's variable symbol", async () => {
    const symbol = ok(
      await run(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const view = yield* issueInvoice({ variableSymbol: "555" });
          const { creditNote } = yield* d.cancel(testCaller, view.id, { reason: "x" });
          return (yield* (yield* DocumentsRepo).get(WS, present(creditNote).id)).variableSymbol;
        }),
      ),
    );
    expect(symbol).toBe("20260001");
  });
});

describe("review round 3 follow-ups", () => {
  test("a due term change is audited with the due date, so fixed and relative terms differ", async () => {
    const [fixed, relative] = ok(
      await run(
        Effect.gen(function* () {
          const testCaller = yield* TestCaller;
          const d = yield* Documents;
          const a = yield* issueInvoice();
          const b = yield* issueInvoice();
          yield* d.edit(testCaller, a.id, { due: { on: IsoDate.make("2026-12-08") } }, a.revision);
          yield* d.edit(testCaller, b.id, { due: { inDays: 15 } }, b.revision);
          return [
            (yield* d.history(testCaller, a.id)).at(-1)?.changes,
            (yield* d.history(testCaller, b.id)).at(-1)?.changes,
          ] as const;
        }),
      ),
    );
    expect(fixed).toEqual([
      { path: "dueOn", before: "2026-12-07", after: "2026-12-08" },
      { path: "given.due", before: { inDays: 14 }, after: { on: "2026-12-08" } },
    ]);
    expect(relative).toEqual([
      { path: "dueOn", before: "2026-12-07", after: "2026-12-08" },
      { path: "given.due", before: { inDays: 14 }, after: { inDays: 15 } },
    ]);
  });
});
