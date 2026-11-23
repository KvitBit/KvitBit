import { describe, expect, test } from "bun:test";
import type { DocumentId, IsoDate, NumberingSeriesId } from "@kvitbit/domain/contract";
import { Conflict, Invalid, NotFound } from "@kvitbit/domain/contract";
import { Effect, Exit } from "effect";
import type { NumberingSeriesShape } from "../../../src/modules/numbering";
import { NumberingSeries, NumberingTestLayer } from "../../../src/modules/numbering";
import { CoreStore } from "../../../src/store/CoreStore";
import { rng, SEEDS } from "../../engines/random";
import { member, runTest, WORKSPACE_A, WORKSPACE_B } from "../../helpers";

const TODAY = "2026-11-23" as IsoDate;
const doc = (n: number) =>
  `01900000-0000-7000-8000-0000000d${String(n).padStart(4, "0")}` as DocumentId;

/** Runs `body` with the service and a transaction runner on fresh in-memory ports. */
const scenario = <A, E>(
  body: (
    s: NumberingSeriesShape,
    tx: <B, F>(effect: Effect.Effect<B, F>) => Effect.Effect<B, F | unknown>,
  ) => Effect.Effect<A, E>,
) =>
  runTest(
    member("owner"),
    Effect.gen(function* () {
      const s = yield* NumberingSeries;
      const store = yield* CoreStore;
      return yield* body(s, store.transaction);
    }).pipe(Effect.provide(NumberingTestLayer)),
  );

const create = (
  s: NumberingSeriesShape,
  pattern: string,
  extra: Partial<Parameters<NumberingSeriesShape["configure"]>[1]> = {},
) =>
  Effect.map(
    s.configure(WORKSPACE_A, { kind: "invoice", name: "Faktury", pattern, ...extra }, TODAY),
    (r) => r.view,
  );

const allocate = (
  s: NumberingSeriesShape,
  seriesId: NumberingSeriesId,
  n: number,
  issuedOn = TODAY,
) =>
  Effect.map(
    s.allocate({
      workspaceId: WORKSPACE_A,
      kind: "invoice",
      seriesId,
      documentId: doc(n),
      issuedOn,
    }),
    (a) => a.number,
  );

describe("NumberingSeries.configure", () => {
  test("the first series of a kind is its default; the view shows the next number", async () => {
    const exit = await scenario((s, tx) => tx(create(s, "FV-YYYY-NNNN", { isDefault: false })));
    expect(exit).toMatchObject(
      Exit.succeed({
        kind: "invoice",
        name: "Faktury",
        isDefault: true,
        periodKey: "2026",
        nextCounter: 1,
        nextNumber: "FV-2026-0001",
      }),
    );
  });

  test("an invalid pattern or empty name is Invalid", async () => {
    expect(await scenario((s, tx) => tx(create(s, "FV-YYYY")))).toEqual(
      Exit.fail(
        new Invalid({
          issues: [
            {
              path: ["pattern"],
              code: "numbering.pattern_invalid",
              params: { reason: "counter_missing" },
            },
          ],
        }),
      ),
    );
    const exit = await scenario((s, tx) =>
      tx(s.configure(WORKSPACE_A, { kind: "invoice", name: "  ", pattern: "NNN" }, TODAY)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("nextNumber raises the current period's counter, never lowers it below used", async () => {
    const exit = await scenario((s, tx) =>
      Effect.gen(function* () {
        const v = yield* tx(create(s, "YYYY-NNNN", { nextNumber: 41 }));
        const first = yield* tx(allocate(s, v.id, 1));
        const same = yield* tx(create(s, "YYYY-NNNN", { id: v.id, nextNumber: 42 }));
        const lower = yield* Effect.flip(tx(create(s, "YYYY-NNNN", { id: v.id, nextNumber: 41 })));
        return [first, same.nextNumber, lower];
      }),
    );
    expect(exit).toEqual(
      Exit.succeed([
        "2026-0041",
        "2026-0042",
        new Invalid({
          issues: [
            {
              path: ["nextNumber"],
              code: "numbering.pattern_invalid",
              params: { reason: "below_used", minimum: "42" },
            },
          ],
        }),
      ]),
    );
  });

  test("isDefault: true demotes the old default; unsetting the default or changing kind is illegal", async () => {
    const exit = await scenario((s, tx) =>
      Effect.gen(function* () {
        const a = yield* tx(create(s, "YYYY-NNNN"));
        const b = yield* tx(create(s, "B-YYYY-NNNN", { isDefault: true }));
        const views = yield* s.list(WORKSPACE_A, TODAY);
        const unset = yield* Effect.flip(
          tx(create(s, "B-YYYY-NNNN", { id: b.id, isDefault: false })),
        );
        const kind = yield* Effect.flip(
          tx(
            s.configure(
              WORKSPACE_A,
              { id: a.id, kind: "proforma", name: "x", pattern: "NNN" },
              TODAY,
            ),
          ),
        );
        const back = yield* tx(
          s.configure(
            WORKSPACE_A,
            { id: a.id, kind: "invoice", name: "A", pattern: "NNN", isDefault: true },
            TODAY,
          ),
        );
        return [
          views.map((v) => [v.pattern, v.isDefault]),
          unset,
          kind,
          back.before?.isDefault,
          back.view.isDefault,
          (yield* s.resolve(WORKSPACE_A, "invoice")).id === a.id,
        ];
      }),
    );
    expect(exit).toEqual(
      Exit.succeed([
        [
          ["YYYY-NNNN", false],
          ["B-YYYY-NNNN", true],
        ],
        new Conflict({ reason: "illegal_transition" }),
        new Conflict({ reason: "illegal_transition" }),
        false,
        true,
        true,
      ]),
    );
  });

  test("another Workspace's series is NotFound", async () => {
    const exit = await scenario((s, tx) =>
      Effect.gen(function* () {
        const v = yield* tx(create(s, "NNN"));
        return yield* tx(
          s.configure(WORKSPACE_B, { id: v.id, kind: "invoice", name: "x", pattern: "NNN" }, TODAY),
        );
      }),
    );
    expect(Exit.isFailure(exit) && JSON.stringify(exit)).toContain("NotFound");
  });

  test("ensureDefaults creates one default per listed kind, once", async () => {
    const exit = await scenario((s, tx) =>
      Effect.gen(function* () {
        yield* tx(s.ensureDefaults(WORKSPACE_A, ["invoice", "proforma", "credit_note"]));
        yield* tx(s.ensureDefaults(WORKSPACE_A, ["invoice", "proforma", "credit_note"]));
        return (yield* s.list(WORKSPACE_A, TODAY)).map((v) => [
          v.kind,
          v.pattern,
          v.isDefault,
          v.nextNumber,
        ]);
      }),
    );
    expect(exit).toEqual(
      Exit.succeed([
        ["credit_note", "OD-YYYY-NNNN", true, "OD-2026-0001"],
        ["invoice", "YYYY-NNNN", true, "2026-0001"],
        ["proforma", "ZF-YYYY-NNNN", true, "ZF-2026-0001"],
      ]),
    );
  });
});

describe("NumberingSeries.allocate", () => {
  test("monotonic per series and period; yearly and monthly resets", async () => {
    const exit = await scenario((s, tx) =>
      Effect.gen(function* () {
        const y = yield* tx(create(s, "YYYY-NNNN"));
        const m = yield* tx(create(s, "YYMM-NNN"));
        return [
          yield* tx(allocate(s, y.id, 1)),
          yield* tx(allocate(s, y.id, 2)),
          yield* tx(allocate(s, y.id, 3, "2027-01-04" as IsoDate)),
          yield* tx(allocate(s, m.id, 4, "2026-11-30" as IsoDate)),
          yield* tx(allocate(s, m.id, 5, "2026-12-01" as IsoDate)),
          yield* tx(allocate(s, m.id, 6, "2026-12-02" as IsoDate)),
        ];
      }),
    );
    expect(exit).toEqual(
      Exit.succeed(["2026-0001", "2026-0002", "2027-0001", "2611-001", "2612-001", "2612-002"]),
    );
  });

  test("a rolled-back issue leaves no gap", async () => {
    const exit = await scenario((s, tx) =>
      Effect.gen(function* () {
        const v = yield* tx(create(s, "YYYY-NNNN"));
        const failed = yield* Effect.flip(
          tx(Effect.andThen(allocate(s, v.id, 1), Effect.fail("issue failed later" as const))),
        );
        return [
          failed,
          yield* tx(allocate(s, v.id, 2)),
          (yield* s.list(WORKSPACE_A, TODAY))[0]?.nextNumber,
        ];
      }),
    );
    expect(exit).toEqual(Exit.succeed(["issue failed later", "2026-0001", "2026-0002"]));
  });

  test("a series of another kind or Workspace is NotFound", async () => {
    const exit = await scenario((s, tx) =>
      Effect.gen(function* () {
        const v = yield* tx(create(s, "NNN"));
        const otherKind = yield* Effect.flip(
          tx(
            s.allocate({
              workspaceId: WORKSPACE_A,
              kind: "proforma",
              seriesId: v.id,
              documentId: doc(1),
              issuedOn: TODAY,
            }),
          ),
        );
        const otherWs = yield* Effect.flip(
          tx(
            s.allocate({
              workspaceId: WORKSPACE_B,
              kind: "invoice",
              seriesId: v.id,
              documentId: doc(1),
              issuedOn: TODAY,
            }),
          ),
        );
        return [otherKind, otherWs];
      }),
    );
    expect(exit).toMatchObject(Exit.succeed([expect.any(NotFound), expect.any(NotFound)]));
  });
});

describe("NumberingSeries.override (D4)", () => {
  test("reserved numbers are skipped; taken numbers conflict; old numbers are never reused", async () => {
    const exit = await scenario((s, tx) =>
      Effect.gen(function* () {
        const v = yield* tx(create(s, "YYYY-NNNN"));
        const first = yield* tx(allocate(s, v.id, 1)); // 2026-0001 for doc 1
        // Doc 1 moves to a manual number ahead of the counter.
        const manual = yield* tx(
          s.override({
            workspaceId: WORKSPACE_A,
            kind: "invoice",
            documentId: doc(1),
            number: " 2026-0002 ",
          }),
        );
        const second = yield* tx(allocate(s, v.id, 2)); // skips the reserved 2026-0002
        const taken = yield* Effect.flip(
          tx(
            s.override({
              workspaceId: WORKSPACE_A,
              kind: "invoice",
              documentId: doc(3),
              number: first,
            }),
          ),
        );
        // Same number is free for another kind.
        const otherKind = yield* tx(
          s.override({
            workspaceId: WORKSPACE_A,
            kind: "proforma",
            documentId: doc(4),
            number: first,
          }),
        );
        return [first, manual, second, taken, otherKind];
      }),
    );
    expect(exit).toEqual(
      Exit.succeed([
        "2026-0001",
        "2026-0002",
        "2026-0003",
        new Conflict({ reason: "duplicate" }),
        "2026-0001",
      ]),
    );
  });

  test("property: allocations strictly increase and never collide with reservations (seeded)", async () => {
    for (const seed of SEEDS.slice(0, 40)) {
      const r = rng(seed);
      const exit = await scenario((s, tx) =>
        Effect.gen(function* () {
          const v = yield* tx(create(s, "NNNN"));
          const reserved = new Set<string>();
          const sequences: Array<number> = [];
          let documents = 0;
          for (let step = 0; step < 30; step++) {
            const roll = r.next();
            documents++;
            if (roll < 0.3) {
              const number = String(r.int(1, 60)).padStart(4, "0");
              const result = yield* Effect.result(
                tx(
                  s.override({
                    workspaceId: WORKSPACE_A,
                    kind: "invoice",
                    documentId: doc(documents),
                    number,
                  }),
                ),
              );
              if (result._tag === "Success") reserved.add(number);
              else if (!reserved.has(number))
                return `seed ${seed}: override of free ${number} failed`;
            } else if (roll < 0.4) {
              // An issue that rolls back must not consume a number.
              yield* Effect.flip(
                tx(Effect.andThen(allocate(s, v.id, documents), Effect.fail("rollback"))),
              );
            } else {
              const a = yield* tx(
                s.allocate({
                  workspaceId: WORKSPACE_A,
                  kind: "invoice",
                  seriesId: v.id,
                  documentId: doc(documents),
                  issuedOn: TODAY,
                }),
              );
              if (reserved.has(a.number)) return `seed ${seed}: ${a.number} reused`;
              const last = sequences.at(-1);
              if (last !== undefined && a.sequence <= last)
                return `seed ${seed}: ${a.sequence} after ${last}`;
              sequences.push(a.sequence);
              reserved.add(a.number);
            }
          }
          // Every counter value below the next one was issued or reserved (no gaps from rollbacks).
          const next = (yield* s.list(WORKSPACE_A, TODAY))[0]?.nextCounter ?? 0;
          for (let c = 1; c < next; c++) {
            if (!reserved.has(String(c).padStart(4, "0"))) return `seed ${seed}: gap at ${c}`;
          }
          return "ok";
        }),
      );
      expect(exit).toEqual(Exit.succeed("ok"));
    }
  });
});
