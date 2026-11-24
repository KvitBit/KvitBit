/**
 * Replays formal/numbering/Numbering.tla traces on the real code: `Documents.issue` (from a
 * stored draft or from input) and `Documents.edit` with `patch.number` (D4), on
 * `DocumentsTestLayer` over the in-memory store.
 *
 * The in-memory store runs one top-level transaction at a time (store/memory.ts) and has no
 * foreign keys, so each model trace replays as its serial projection: a transaction that waits
 * in the model on another's lock or open reservation runs here after that one committed or
 * rolled back, and an issue from input commits (on the committed Postgres schema the model
 * aborts it on number_reservations_document_fk; see the verify-numbering skill). Postgres
 * statement interleaving is the pg-contention job's.
 *
 * Each step runs on the real code and on an executable copy of the model's serial transitions
 * (`modelStep`). After every step the harness reads the stored documents back through
 * `Documents.get`, asserts that outcome, stored numbers and counters equal the model's, and
 * checks the model's invariants on the real store: NoDuplicateNumber, NoReuse,
 * ReservedForever, Gapless, CounterTracksIssue and OverrideKeepsCounter. A reservation is read
 * by probing `reservations.tryReserve` in a transaction that always rolls back.
 */
import { describe, expect, test } from "bun:test";
import { NumberingModule } from "@kvitbit/core";
import { CoreStore } from "@kvitbit/core/ports";
import { DocumentFixtures, DocumentsTestLayer, InMemoryPortsLive } from "@kvitbit/core/testing";
import type {
  Caller,
  ContactId,
  CurrencyCode,
  DocumentId,
  DocumentInput,
  IsoDate,
  UserId,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { CurrentCaller, Documents } from "@kvitbit/domain/contract";
import { BigDecimal, Effect, Layer } from "effect";

const WS = "01900000-0000-7000-8000-00000000a001" as WorkspaceId;
const BUYER = "01900000-0000-7000-8000-0000c0000001" as ContactId;
const CZK = "CZK" as CurrencyCode;
const OWNER: Caller = {
  _tag: "Member",
  userId: "01900000-0000-7000-8000-00000000c001" as UserId,
  workspaceId: WS,
  role: "owner",
  scopes: "all",
  locale: "cs",
  channel: "web",
  client: null,
};

/** Model periods p1, p2: the default invoice series YYYY-NNNN keeps one counter per year. */
const PERIODS = ["2026", "2027"] as const;
type Period = (typeof PERIODS)[number];
const dayIn = (p: Period) => `${p}-06-01` as IsoDate;
const fmt = (p: Period, seq: number) => `${p}-${String(seq).padStart(4, "0")}`;
const seqOf = (n: string) => Number(n.slice(5));

type FixturesShape = DocumentFixtures["Service"];
const issuer: Parameters<FixturesShape["putIssuer"]>[0] = {
  party: {
    workspaceId: WS,
    name: "Dodavatel s.r.o.",
    ico: "27074358",
    dic: "CZ27074358",
    address: { street: "Dlouhá 1", city: "Praha", postalCode: "11000", country: "CZ" },
    registerEntry: "C 123 vedená u Městského soudu v Praze",
    email: null,
    phone: null,
    web: null,
  },
  regime: "vat_payer",
  bankAccounts: [
    {
      id: "01900000-0000-7000-8000-0000ba000001" as never,
      name: null,
      currency: CZK,
      accountNumber: "123456789/0100",
      iban: "CZ1801000000000123456789",
      bic: null,
      isDefault: true,
    },
  ],
  billing: {
    currency: CZK,
    language: "cs",
    dueDays: 14,
    paymentMethod: "bank_transfer",
    seriesByKind: {},
    defaultNote: null,
  },
  reminders: { enabled: true, proformas: false, offsetsDays: [3, 10] },
  paymentRounding: "none",
  revision: 1,
};
const buyer: Parameters<FixturesShape["putContact"]>[1] = {
  party: {
    contactId: BUYER,
    name: "Odběratel a.s.",
    ico: "25596641",
    dic: "CZ25596641",
    legalForm: null,
    address: { street: null, city: "Brno", postalCode: null, country: "CZ" },
  },
  defaults: { reminderPolicy: { mode: "inherit" } },
  roles: ["customer"],
  billingEmails: ["fakturace@odberatel.cz"],
  archived: false,
  revision: 1,
};
const input = (p: Period): DocumentInput => ({
  kind: "invoice",
  contact: BUYER,
  lines: [{ description: "Konzultace", unitPrice: BigDecimal.fromStringUnsafe("1000") }],
  issuedOn: dayIn(p),
});

/**
 * Model actions. `from: "draft"` issues a draft stored before the trace (model DraftIssuers).
 * `crash` rolls the transaction back after its last statement (model `Crash`). `stale` sends
 * the revision the document had before its latest change (an edit that read it while another
 * transaction held the row).
 */
type Step =
  | {
      readonly op: "issue";
      readonly doc: string;
      readonly from: "draft" | "input";
      readonly period: Period;
      readonly crash?: true;
    }
  | {
      readonly op: "override";
      readonly doc: string;
      readonly number: string;
      readonly crash?: true;
      readonly stale?: true;
    };

type Outcome =
  | { readonly kind: "committed"; readonly number: string }
  | { readonly kind: "aborted" | "conflict" | "illegal" | "unchanged" | "revision_changed" };

/** The model's committed state (what a serial run observes). */
interface ModelState {
  counter: Record<Period, number>;
  resv: Set<string>;
  docNum: Map<string, string | null>;
  /** documents.revision history per document (model docRev), the last one current. */
  rev: Map<string, Array<number>>;
}

/** The revision the client sends: the current one, or the one before it when `stale`. */
const expectedRevision = (m: ModelState, step: Step) => {
  const history = m.rev.get(step.doc) ?? [];
  const current = history.at(-1) ?? 1;
  return step.op === "override" && step.stale ? (history.at(-2) ?? current) : current;
};
const bump = (m: ModelState, doc: string) => {
  const history = m.rev.get(doc) ?? [];
  m.rev.set(doc, [...history, (history.at(-1) ?? 0) + 1]);
};

/** Serial transitions of Numbering.tla with the foreign-key check passing (memory store). */
const modelStep = (m: ModelState, step: Step): Outcome => {
  if (step.op === "issue") {
    let seq = m.counter[step.period];
    while (m.resv.has(fmt(step.period, seq))) seq++; // ITry: skip a committed reservation
    const n = fmt(step.period, seq);
    if ([...m.docNum.values()].includes(n)) return { kind: "conflict" }; // IWrite index
    if (step.crash) return { kind: "aborted" };
    m.resv.add(n);
    m.counter[step.period] = seq + 1;
    m.docNum.set(step.doc, n);
    if (step.from === "draft") bump(m, step.doc);
    else m.rev.set(step.doc, [1]); // repo.insert stores revision 1
    return { kind: "committed", number: n };
  }
  const current = m.docNum.get(step.doc);
  if (current === undefined) throw new Error(`trace edits unknown ${step.doc}`);
  // OLock: getForUpdate's revision check
  if (expectedRevision(m, step) !== m.rev.get(step.doc)?.at(-1))
    return { kind: "revision_changed" };
  if (current === null) return { kind: "illegal" }; // OLock: a draft
  // editIssued: the same number reserves nothing, but the edit still commits (revision + 1).
  if (current === step.number) {
    if (step.crash) return { kind: "aborted" };
    bump(m, step.doc);
    return { kind: "unchanged" };
  }
  if (m.resv.has(step.number)) return { kind: "conflict" }; // OReserve: taken
  if (step.crash) return { kind: "aborted" };
  m.resv.add(step.number);
  m.docNum.set(step.doc, step.number);
  bump(m, step.doc);
  return { kind: "committed", number: step.number };
};

const World = DocumentsTestLayer.pipe(Layer.provideMerge(InMemoryPortsLive()));

/** Runs `steps` on the real code and the model, checking agreement and invariants per step. */
const replay = (steps: ReadonlyArray<Step>) =>
  Effect.gen(function* () {
    const documents = yield* Documents;
    const numbering = yield* NumberingModule.NumberingSeries;
    const store = yield* CoreStore;
    const fixtures = yield* DocumentFixtures;
    yield* fixtures.putIssuer(issuer);
    yield* fixtures.putContact(WS, buyer);
    yield* numbering.ensureDefaults(WS, ["invoice"]);
    const series = yield* numbering.resolve(WS, "invoice");

    const model: ModelState = {
      counter: { "2026": 1, "2027": 1 },
      resv: new Set(),
      docNum: new Map(),
      rev: new Map(),
    };
    /** Trace document -> real id; drafts are stored up front (model Init). */
    const ids = new Map<string, DocumentId>();
    for (const s of steps) {
      if (s.op === "issue" && s.from === "draft" && !ids.has(s.doc)) {
        ids.set(s.doc, (yield* documents.createDraft(input(s.period))).id);
        model.docNum.set(s.doc, null);
        model.rev.set(s.doc, [1]);
      }
    }

    const counters = Effect.gen(function* () {
      const out = {} as Record<Period, number>;
      for (const p of PERIODS) out[p] = (yield* numbering.view(series, dayIn(p))).nextCounter;
      return out;
    });
    /** Stored number and revision of every trace document, read back after commit. */
    const stored = Effect.gen(function* () {
      const out = new Map<string, { number: string | null; revision: number }>();
      for (const [doc, id] of ids) {
        const view = yield* documents.get(id);
        out.set(doc, { number: view.number, revision: view.revision });
      }
      return out;
    });
    /** Whether `number` is reserved: tryReserve in a transaction that always rolls back. */
    const reserved = (number: string) =>
      store
        .transaction(
          Effect.flatMap(
            store.reservations.tryReserve({
              workspaceId: WS,
              kind: "invoice",
              number,
              seriesId: null,
              documentId: "01900000-0000-7000-8000-0000000000ff" as DocumentId,
            }),
            (free) => Effect.fail({ _tag: "Probe" as const, free }),
          ),
        )
        .pipe(Effect.catchTag("Probe", (p) => Effect.succeed(!p.free)));

    const run = (step: Step, unchangedBefore: boolean, expected: number) => {
      const id = ids.get(step.doc);
      const body =
        step.op === "issue"
          ? documents.issue(
              step.from === "draft" && id !== undefined
                ? { draft: id, expectedRevision: expected }
                : { input: input(step.period) },
            )
          : Effect.suspend(() => {
              if (id === undefined) return Effect.die(`no document ${step.doc}`);
              return documents.edit(id, { number: step.number }, expected);
            });
      const crash = Effect.fail({ _tag: "Crash" as const });
      return store.transaction(step.crash ? Effect.tap(body, () => crash) : body).pipe(
        Effect.map((view): Outcome => {
          if (!ids.has(step.doc)) ids.set(step.doc, view.id);
          if (step.op === "override" && unchangedBefore) return { kind: "unchanged" };
          return { kind: "committed", number: view.number ?? "" };
        }),
        Effect.catchTag("Crash", () => Effect.succeed<Outcome>({ kind: "aborted" })),
        Effect.catchTag("Conflict", (e) =>
          e.reason === "duplicate"
            ? Effect.succeed<Outcome>({ kind: "conflict" })
            : e.reason === "revision_changed"
              ? Effect.succeed<Outcome>({ kind: "revision_changed" })
              : e.reason === "illegal_transition"
                ? Effect.succeed<Outcome>({ kind: "illegal" })
                : Effect.fail(e),
        ),
      );
    };

    const held = new Map<string, Set<string>>();
    const allocated = new Map<Period, Set<number>>(PERIODS.map((p) => [p, new Set<number>()]));
    const record = (rows: Map<string, { number: string | null; revision: number }>) => {
      for (const [doc, row] of rows) {
        if (row.number !== null)
          held.set(row.number, new Set([...(held.get(row.number) ?? []), doc]));
      }
    };
    record(yield* stored);

    for (const [i, step] of steps.entries()) {
      const at = `step ${i} ${JSON.stringify(step)}`;
      const before = yield* counters;
      const sent = expectedRevision(model, step);
      const expected = modelStep(model, step);
      const previous = step.op === "override" ? (yield* stored).get(step.doc)?.number : undefined;
      const actual = yield* run(step, step.op === "override" && previous === step.number, sent);
      expect({ at, outcome: actual }).toEqual({ at, outcome: expected });
      const rows = yield* stored;
      record(rows);
      if (step.op === "issue" && actual.kind === "committed") {
        allocated.get(step.period)?.add(seqOf(actual.number));
      }
      // Stored revisions follow the model's docRev (an accepted edit bumps it once).
      const storedRevisions = Object.fromEntries([...rows].map(([d, r]) => [d, r.revision]));
      expect({ at, revisions: storedRevisions }).toEqual({
        at,
        revisions: Object.fromEntries(
          [...model.rev].filter(([d]) => ids.has(d)).map(([d, h]) => [d, h.at(-1) ?? 0]),
        ),
      });
      // The stored rows, not the service's return values, carry the numbers.
      const storedNumbers = Object.fromEntries([...rows].map(([d, r]) => [d, r.number]));
      expect({ at, stored: storedNumbers }).toEqual({
        at,
        stored: Object.fromEntries([...model.docNum].filter(([d]) => ids.has(d))),
      });
      const after = yield* counters;
      expect({ at, counters: after }).toEqual({ at, counters: model.counter });

      // IssueNeverHitsIndex
      if (step.op === "issue")
        expect({ at, outcome: actual.kind }).not.toEqual({ at, outcome: "conflict" });
      // NoDuplicateNumber
      const numbers = [...rows.values()].flatMap((r) => (r.number === null ? [] : [r.number]));
      expect({ at, duplicates: numbers.length - new Set(numbers).size }).toEqual({
        at,
        duplicates: 0,
      });
      for (const [n, docs] of held) {
        // NoReuse
        expect({ at, n, holders: docs.size }).toEqual({ at, n, holders: 1 });
        // ReservedForever
        expect({ at, n, reserved: yield* reserved(n) }).toEqual({ at, n, reserved: true });
      }
      for (const p of PERIODS) {
        // Gapless
        for (let s = 1; s < after[p]; s++) {
          const n = fmt(p, s);
          expect({ at, n, reserved: yield* reserved(n) }).toEqual({ at, n, reserved: true });
        }
        // NoOrphanReservation: every reserved number some document carried
        for (let s = 1; s <= 6; s++) {
          const n = fmt(p, s);
          if (yield* reserved(n))
            expect({ at, n, held: held.has(n) }).toEqual({ at, n, held: true });
        }
        // CounterTracksIssue
        expect({ at, p, counter: after[p] }).toEqual({
          at,
          p,
          counter: 1 + Math.max(0, ...(allocated.get(p) ?? [])),
        });
      }
      // OverrideKeepsCounter
      if (step.op === "override") expect({ at, counters: after }).toEqual({ at, counters: before });
    }
    const final = yield* stored;
    return {
      numbers: Object.fromEntries([...final].map(([d, r]) => [d, r.number])),
      counters: yield* counters,
    };
  }).pipe(Effect.provideService(CurrentCaller, OWNER), Effect.provide(World));

const runReplay = (steps: ReadonlyArray<Step>) => Effect.runPromise(replay(steps));

/** Model Init: D0 issued in p1 as 2026-0001. */
const D0: Step = { op: "issue", doc: "d0", from: "draft", period: "2026" };

describe("Numbering.tla traces on Documents.issue / Documents.edit (serial projections)", () => {
  test("two issues in two periods (IStart, IDocLock, ILock, ITry, ISet, IWrite, ICommit)", async () => {
    const r = await runReplay([
      D0,
      { op: "issue", doc: "i1", from: "draft", period: "2026" },
      { op: "issue", doc: "i2", from: "draft", period: "2027" },
    ]);
    expect(r.numbers).toEqual({ d0: "2026-0001", i1: "2026-0002", i2: "2027-0001" });
  });

  test("H1, override commits first: the allocator skips the overridden number", async () => {
    // Model: o1 reserves <<p1,2>>; i1 locks its draft and the counter (2) and waits in ITry
    // on o1's open reservation; o1 commits; ITry sees Committed and moves to 3.
    const r = await runReplay([
      D0,
      { op: "override", doc: "d0", number: "2026-0002" },
      { op: "issue", doc: "i1", from: "draft", period: "2026" },
    ]);
    expect(r.numbers).toEqual({ d0: "2026-0002", i1: "2026-0003" });
    expect(r.counters["2026"]).toBe(4);
  });

  test("H1, allocation commits first: the override is Conflict{duplicate}", async () => {
    // Model: i1 reserves <<p1,2>>; o1 waits in OReserve; i1 commits; OReserve -> conflict.
    const r = await runReplay([
      D0,
      { op: "issue", doc: "i1", from: "draft", period: "2026" },
      { op: "override", doc: "d0", number: "2026-0002" },
    ]);
    expect(r.numbers).toEqual({ d0: "2026-0001", i1: "2026-0002" });
  });

  test("H1, override rolls back: the waiting allocator takes the number", async () => {
    const r = await runReplay([
      D0,
      { op: "override", doc: "d0", number: "2026-0002", crash: true },
      { op: "issue", doc: "i1", from: "draft", period: "2026" },
    ]);
    expect(r.numbers).toEqual({ d0: "2026-0001", i1: "2026-0002" });
  });

  test("an edit of a draft being issued waits, then fails its revision check", async () => {
    // Model: i1 holds its draft's row lock (IDocLock); o1 read revision 1 and waits in OLock;
    // i1 commits (revision 2); OLock -> revision_changed.
    const r = await runReplay([
      D0,
      { op: "issue", doc: "i1", from: "draft", period: "2026" },
      { op: "override", doc: "i1", number: "2026-0003", stale: true },
    ]);
    expect(r.numbers).toEqual({ d0: "2026-0001", i1: "2026-0002" });
  });

  test("a number edit of a draft is refused (OLock: illegal)", async () => {
    const r = await runReplay([
      D0,
      { op: "override", doc: "i1", number: "2026-0003" },
      { op: "issue", doc: "i1", from: "draft", period: "2026" },
    ]);
    expect(r.numbers).toEqual({ d0: "2026-0001", i1: "2026-0002" });
  });

  test("an edit with the current number reserves nothing and commits one revision", async () => {
    const r = await runReplay([
      D0,
      { op: "override", doc: "d0", number: "2026-0001" },
      { op: "issue", doc: "i1", from: "draft", period: "2026" },
    ]);
    expect(r.numbers).toEqual({ d0: "2026-0001", i1: "2026-0002" });
  });

  test("a rolled-back issue reverts the counter and its reservation (S3, no gap)", async () => {
    const r = await runReplay([
      D0,
      { op: "issue", doc: "i1", from: "draft", period: "2026", crash: true },
      { op: "issue", doc: "i2", from: "draft", period: "2026" },
    ]);
    expect(r.numbers).toEqual({ d0: "2026-0001", i1: null, i2: "2026-0002" });
    expect(r.counters["2026"]).toBe(3);
  });

  test("an override into another period is skipped there, not counted", async () => {
    const r = await runReplay([
      D0,
      { op: "override", doc: "d0", number: "2027-0001" },
      { op: "issue", doc: "i1", from: "draft", period: "2027" },
      { op: "issue", doc: "i2", from: "draft", period: "2026" },
    ]);
    expect(r.numbers).toEqual({ d0: "2027-0001", i1: "2027-0002", i2: "2026-0002" });
    expect(r.counters["2027"]).toBe(3);
  });

  test("beyond the TLC bounds (two overrides): an override of an override keeps both earlier numbers", async () => {
    const r = await runReplay([
      D0,
      { op: "override", doc: "d0", number: "2027-0002" },
      { op: "override", doc: "d0", number: "2027-0001" },
      { op: "issue", doc: "i1", from: "draft", period: "2027" },
    ]);
    expect(r.numbers).toEqual({ d0: "2027-0001", i1: "2027-0003" });
  });

  test("memory only: an issue from input commits (the wide model aborts it on the FK)", async () => {
    const r = await runReplay([
      D0,
      { op: "issue", doc: "i3", from: "input", period: "2026" },
      { op: "issue", doc: "i1", from: "draft", period: "2026" },
    ]);
    expect(r.numbers).toEqual({ d0: "2026-0001", i3: "2026-0002", i1: "2026-0003" });
  });
});

/** mulberry32: a small seeded generator, so a failing trace reruns from its seed. */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Sampled traces mix issues from input (memory only) and several overrides (beyond the TLC
// bounds): they check the code against the model's serial transitions, not a TLC bound.
describe("sampled serial traces (property test, not exhaustive)", () => {
  test("100 seeded traces of 6 steps agree with the model and keep its invariants", async () => {
    for (let seed = 1; seed <= 100; seed++) {
      const next = rng(seed);
      const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(next() * xs.length)] as T;
      const steps: Step[] = [D0];
      const known = ["d0"];
      for (let k = 0; k < 6; k++) {
        const crash = next() < 0.25 ? ({ crash: true } as const) : {};
        if (next() < 0.5) {
          const doc = `t${k}`;
          const from = next() < 0.5 ? "draft" : "input";
          steps.push({ op: "issue", doc, from, period: pick(PERIODS), ...crash });
          if (from === "draft" || !("crash" in crash)) known.push(doc);
        } else {
          const number = fmt(pick(PERIODS), 1 + Math.floor(next() * 4));
          const stale = next() < 0.2 ? ({ stale: true } as const) : {};
          steps.push({ op: "override", doc: pick(known), number, ...crash, ...stale });
        }
      }
      try {
        await runReplay(steps);
      } catch (e) {
        throw new Error(`seed ${seed}: ${JSON.stringify(steps)}\n${String(e)}`);
      }
    }
  });
});
