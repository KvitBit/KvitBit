/**
 * Replays formal/numbering/Numbering.tla traces on the real numbering code: `NumberingSeries`
 * `allocate` (issue) and `override` (D4) inside `CoreStore.transaction`, on the in-memory store.
 *
 * The in-memory store runs one top-level transaction at a time (store/memory.ts), so each model
 * trace replays as its serial projection: a transaction that waits in the model on another's
 * open reservation runs here after that one committed or rolled back. Postgres statement
 * interleaving is the pg-contention job's (see the verify-numbering skill).
 *
 * Each step runs on the real code and on an executable copy of the model's transitions; after
 * every step the harness asserts that both agree (number, outcome, counters) and checks the
 * model's invariants on the real store state: NoDuplicateNumber, NoReuse, ReservedForever,
 * Gapless, CounterTracksIssue and OverrideKeepsCounter. A reservation is read by probing
 * `reservations.tryReserve` in a transaction that always rolls back.
 */
import { describe, expect, test } from "bun:test";
import { NumberingModule } from "@kvitbit/core";
import type { StoreUnavailable } from "@kvitbit/core/ports";
import { CoreStore } from "@kvitbit/core/ports";
import { InMemoryPortsLive, NumberingTestLayer } from "@kvitbit/core/testing";
import type {
  Conflict,
  DocumentId,
  Invalid,
  IsoDate,
  NotFound,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Effect, Layer } from "effect";

const WS = "01900000-0000-7000-8000-00000000a001" as WorkspaceId;
/** Model periods p1, p2: the YYYY-NNNN series keeps one counter per year. */
const PERIODS = ["2026", "2027"] as const;
type Period = (typeof PERIODS)[number];
const dayIn = (p: Period) => `${p}-06-01` as IsoDate;
const fmt = (p: Period, seq: number) => `${p}-${String(seq).padStart(4, "0")}`;
const docId = (name: string) =>
  `01900000-0000-7000-8000-${Buffer.from(name).toString("hex").padStart(12, "0")}` as DocumentId;

/** Model actions. `crash` rolls the transaction back after its last statement (model `Crash`). */
type Step =
  | { readonly op: "issue"; readonly doc: string; readonly period: Period; readonly crash?: true }
  | {
      readonly op: "override";
      readonly doc: string;
      readonly number: string;
      readonly crash?: true;
    };

type Outcome =
  | { readonly kind: "committed"; readonly number: string }
  | { readonly kind: "aborted" }
  | { readonly kind: "conflict" }
  | { readonly kind: "unchanged" };

/** The model's state, restricted to committed data (what a serial run observes). */
interface ModelState {
  counter: Record<Period, number>;
  resv: Set<string>;
  docNum: Map<string, string>;
  held: Map<string, Set<string>>;
  allocated: Map<Period, Set<number>>;
}

const initialModel = (): ModelState => ({
  counter: { "2026": 1, "2027": 1 },
  resv: new Set(),
  docNum: new Map(),
  held: new Map(),
  allocated: new Map(PERIODS.map((p) => [p, new Set<number>()])),
});

/** Serial transitions of Numbering.tla (ILock..ICommit, OLock..OCommit, Crash). */
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
    m.held.set(n, new Set([...(m.held.get(n) ?? []), step.doc]));
    m.allocated.get(step.period)?.add(seq);
    return { kind: "committed", number: n };
  }
  const current = m.docNum.get(step.doc);
  if (current === undefined) throw new Error(`trace overrides unissued ${step.doc}`);
  if (current === step.number) return { kind: "unchanged" };
  if (m.resv.has(step.number)) return { kind: "conflict" }; // OReserve: taken
  if (step.crash) return { kind: "aborted" };
  m.resv.add(step.number);
  m.docNum.set(step.doc, step.number);
  m.held.set(step.number, new Set([...(m.held.get(step.number) ?? []), step.doc]));
  return { kind: "committed", number: step.number };
};

const World = NumberingTestLayer.pipe(Layer.provideMerge(InMemoryPortsLive()));

/** Runs `steps` on the real code and the model, checking agreement and invariants per step. */
const replay = (steps: ReadonlyArray<Step>) =>
  Effect.gen(function* () {
    const numbering = yield* NumberingModule.NumberingSeries;
    const store = yield* CoreStore;
    yield* numbering.ensureDefaults(WS, ["invoice"]);
    const series = yield* numbering.resolve(WS, "invoice");

    const counters = Effect.gen(function* () {
      const out = {} as Record<Period, number>;
      for (const p of PERIODS) out[p] = (yield* numbering.view(series, dayIn(p))).nextCounter;
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
              documentId: docId("probe"),
            }),
            (free) => Effect.fail({ _tag: "Probe" as const, free }),
          ),
        )
        .pipe(Effect.catchTag("Probe", (p) => Effect.succeed(!p.free)));

    const run = (step: Step) => {
      const crash = Effect.fail({ _tag: "Crash" as const });
      const body: Effect.Effect<Outcome, NotFound | Invalid | Conflict | StoreUnavailable> =
        step.op === "issue"
          ? Effect.map(
              numbering.allocate({
                workspaceId: WS,
                kind: "invoice",
                seriesId: series.id,
                documentId: docId(step.doc),
                issuedOn: dayIn(step.period),
              }),
              (a): Outcome => ({ kind: "committed", number: a.number }),
            )
          : Effect.map(
              numbering.override({
                workspaceId: WS,
                kind: "invoice",
                documentId: docId(step.doc),
                number: step.number,
              }),
              (number): Outcome => ({ kind: "committed", number }),
            );
      return store.transaction(step.crash ? Effect.andThen(body, crash) : body).pipe(
        Effect.catchTag("Crash", () => Effect.succeed<Outcome>({ kind: "aborted" })),
        Effect.catchTag("Conflict", (e) =>
          e.reason === "duplicate" ? Effect.succeed<Outcome>({ kind: "conflict" }) : Effect.fail(e),
        ),
      );
    };

    const model = initialModel();
    // Real-side records, built only from what the real code returned.
    const docNum = new Map<string, string>();
    const held = new Map<string, Set<string>>();
    const allocated = new Map<Period, Set<number>>(PERIODS.map((p) => [p, new Set<number>()]));

    for (const [i, step] of steps.entries()) {
      const at = `step ${i} ${JSON.stringify(step)}`;
      const before = yield* counters;
      const expected = modelStep(model, step);
      // D4 via editIssued (lifecycle.ts): the same number is no override and reserves nothing.
      const actual: Outcome =
        step.op === "override" && docNum.get(step.doc) === step.number
          ? { kind: "unchanged" }
          : yield* run(step);
      expect({ at, outcome: actual }).toEqual({ at, outcome: expected });
      if (actual.kind === "committed") {
        docNum.set(step.doc, actual.number);
        held.set(actual.number, new Set([...(held.get(actual.number) ?? []), step.doc]));
        if (step.op === "issue") {
          allocated.get(step.period)?.add(Number(actual.number.slice(5)));
        }
      }
      const after = yield* counters;
      expect({ at, counters: after }).toEqual({ at, counters: model.counter });

      // NoDuplicateNumber
      const numbers = [...docNum.values()];
      expect({ at, duplicates: numbers.length - new Set(numbers).size }).toEqual({
        at,
        duplicates: 0,
      });
      // NoReuse
      for (const [n, docs] of held)
        expect({ at, n, holders: docs.size }).toEqual({ at, n, holders: 1 });
      // ReservedForever
      for (const n of held.keys())
        expect({ at, n, reserved: yield* reserved(n) }).toEqual({ at, n, reserved: true });
      for (const p of PERIODS) {
        // Gapless
        for (let s = 1; s < after[p]; s++) {
          const n = fmt(p, s);
          expect({ at, n, reserved: yield* reserved(n) }).toEqual({ at, n, reserved: true });
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
    return { docNum: Object.fromEntries(docNum), counters: yield* counters };
  }).pipe(Effect.provide(World));

const runReplay = (steps: ReadonlyArray<Step>) => Effect.runPromise(replay(steps));

/** Model Init: D0 issued in p1 as 2026-0001. */
const D0: Step = { op: "issue", doc: "d0", period: "2026" };

describe("Numbering.tla traces on NumberingSeries (serial projections)", () => {
  test("two issues in two periods (IStart, ILock, ITry, ISet, IWrite, ICommit)", async () => {
    const r = await runReplay([
      D0,
      { op: "issue", doc: "i1", period: "2026" },
      { op: "issue", doc: "i2", period: "2027" },
    ]);
    expect(r.docNum).toEqual({ d0: "2026-0001", i1: "2026-0002", i2: "2027-0001" });
  });

  test("H1, override commits first: the allocator skips the overridden number", async () => {
    // Model: o1 reserves <<p1,2>>; i1 locks the counter (2) and waits in ITry on o1's open
    // reservation; o1 commits; ITry sees Committed and moves to 3.
    const r = await runReplay([
      D0,
      { op: "override", doc: "d0", number: "2026-0002" },
      { op: "issue", doc: "i1", period: "2026" },
    ]);
    expect(r.docNum).toEqual({ d0: "2026-0002", i1: "2026-0003" });
    expect(r.counters["2026"]).toBe(4);
  });

  test("H1, allocation commits first: the override is Conflict{duplicate}", async () => {
    // Model: i1 reserves <<p1,2>>; o1 waits in OReserve; i1 commits; OReserve -> conflict.
    const r = await runReplay([
      D0,
      { op: "issue", doc: "i1", period: "2026" },
      { op: "override", doc: "d0", number: "2026-0002" },
    ]);
    expect(r.docNum).toEqual({ d0: "2026-0001", i1: "2026-0002" });
  });

  test("H1, override rolls back: the waiting allocator takes the number", async () => {
    const r = await runReplay([
      D0,
      { op: "override", doc: "d0", number: "2026-0002", crash: true },
      { op: "issue", doc: "i1", period: "2026" },
    ]);
    expect(r.docNum).toEqual({ d0: "2026-0001", i1: "2026-0002" });
  });

  test("a rolled-back issue reverts the counter and its reservation (S3, no gap)", async () => {
    const r = await runReplay([
      D0,
      { op: "issue", doc: "i1", period: "2026", crash: true },
      { op: "issue", doc: "i2", period: "2026" },
    ]);
    expect(r.docNum).toEqual({ d0: "2026-0001", i2: "2026-0002" });
    expect(r.counters["2026"]).toBe(3);
  });

  test("the old number stays reserved after an override (D4)", async () => {
    const r = await runReplay([
      D0,
      { op: "override", doc: "d0", number: "2027-0001" },
      { op: "issue", doc: "i1", period: "2027" },
      { op: "issue", doc: "i2", period: "2026" },
      { op: "override", doc: "i2", number: "2026-0001" },
    ]);
    expect(r.docNum).toEqual({ d0: "2027-0001", i1: "2027-0002", i2: "2026-0002" });
  });

  test("an override of an override keeps both earlier numbers (wide bound)", async () => {
    const r = await runReplay([
      D0,
      { op: "override", doc: "d0", number: "2026-0003" },
      { op: "override", doc: "d0", number: "2026-0002" },
      { op: "issue", doc: "i1", period: "2026" },
      { op: "override", doc: "i1", number: "2026-0003" },
    ]);
    expect(r.docNum).toEqual({ d0: "2026-0002", i1: "2026-0004" });
  });

  test("an override into another period is skipped there, not counted", async () => {
    const r = await runReplay([
      D0,
      { op: "override", doc: "d0", number: "2027-0002" },
      { op: "issue", doc: "i1", period: "2027" },
      { op: "issue", doc: "i2", period: "2027" },
      { op: "override", doc: "i2", number: "2027-0003" },
    ]);
    expect(r.docNum).toEqual({ d0: "2027-0002", i1: "2027-0001", i2: "2027-0003" });
    expect(r.counters["2027"]).toBe(4);
  });
});

/** mulberry32: a small seeded generator, so a failing trace reruns from its seed. */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe("sampled serial traces (property test, not exhaustive)", () => {
  test("200 seeded traces of 8 steps agree with the model and keep its invariants", async () => {
    for (let seed = 1; seed <= 200; seed++) {
      const next = rng(seed);
      const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(next() * xs.length)] as T;
      const issued = ["d0"];
      const steps: Step[] = [D0];
      for (let k = 0; k < 8; k++) {
        const crash = next() < 0.25 ? ({ crash: true } as const) : {};
        if (next() < 0.5) {
          const doc = `t${k}`;
          steps.push({ op: "issue", doc, period: pick(PERIODS), ...crash });
          if (!("crash" in crash)) issued.push(doc); // a conflict leaves it unissued too
        } else {
          const number = fmt(pick(PERIODS), 1 + Math.floor(next() * 5));
          steps.push({ op: "override", doc: pick(issued), number, ...crash });
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
