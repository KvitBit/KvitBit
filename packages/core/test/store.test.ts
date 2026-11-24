import { describe, expect, test } from "bun:test";
import type { DocumentId, NumberingSeriesId, WorkspaceId } from "@kvitbit/domain/contract";
import { Conflict, NotFound } from "@kvitbit/domain/contract";
import { Cause, Effect, Exit, Fiber, Option, Ref, Schema } from "effect";
import { CoreStore, UniqueViolation } from "../src/store/CoreStore";
import { allocateNumber, reserveNumber } from "../src/store/numbering";
import type { Collection } from "../src/store/tables";
import { defineCollection, MemoryTables } from "../src/store/tables";
import {
  ensureDocumentRow,
  member,
  runTest,
  StubDocuments,
  WORKSPACE_A,
  WORKSPACE_B,
} from "./helpers";

const Note = Schema.Struct({
  id: Schema.String,
  workspaceId: Schema.String as unknown as Schema.Codec<WorkspaceId>,
  revision: Schema.Number,
  title: Schema.String,
  slug: Schema.String,
  email: Schema.NullOr(Schema.String),
  status: Schema.String,
  issuedOn: Schema.String,
});
type Note = typeof Note.Type;

const Notes = defineCollection<Note>({
  name: "notes",
  entity: "Contact",
  schema: Note as unknown as Schema.Codec<Note, unknown>,
  unique: [
    { name: "notes_slug_unique", scope: "global", key: (n) => [n.slug] },
    // Partial expression index: lower(email) WHERE status = 'pending'.
    {
      name: "notes_pending_email_unique",
      scope: "workspace",
      key: (n) => (n.status === "pending" && n.email !== null ? [n.email.toLowerCase()] : null),
    },
  ],
});

const note = (id: string, overrides: Partial<Note> = {}): Note => ({
  id,
  workspaceId: WORKSPACE_A,
  revision: 0,
  title: `Note ${id}`,
  slug: `slug-${id}`,
  email: null,
  status: "active",
  issuedOn: "2026-11-01",
  ...overrides,
});

interface Env {
  readonly store: CoreStore["Service"];
  readonly notes: Collection<Note>;
}

const run = <A, E>(f: (env: Env) => Effect.Effect<A, E, CoreStore | MemoryTables>) =>
  runTest(
    member("owner"),
    Effect.gen(function* () {
      const store = yield* CoreStore;
      const tables = yield* MemoryTables;
      return yield* f({ store, notes: tables.collection(Notes) });
    }),
  );

const isDefect = <A, E>(exit: Exit.Exit<A, E>) => Exit.isFailure(exit) && Cause.hasDies(exit.cause);

describe("in-memory tables: collections", () => {
  test("insert starts at revision 1; update is a compare-and-set that bumps it", async () => {
    const exit = await run(({ store, notes }) =>
      Effect.gen(function* () {
        const inserted = yield* store.transaction(notes.insert(note("1", { revision: 99 })));
        const updated = yield* store.transaction(
          Effect.gen(function* () {
            const row = yield* notes.getForUpdate(WORKSPACE_A, "1", 1);
            return yield* notes.update({ ...row, title: "Edited", revision: 42 }, row.revision);
          }),
        );
        return [inserted.revision, updated.revision, (yield* notes.get(WORKSPACE_A, "1")).title];
      }),
    );
    expect(exit).toEqual(Exit.succeed([1, 2, "Edited"]));
  });

  test("a stale expectedRevision fails getForUpdate, update and remove", async () => {
    const exit = await run(({ store, notes }) =>
      Effect.gen(function* () {
        yield* store.transaction(notes.insert(note("1")));
        yield* store.transaction(
          Effect.flatMap(notes.lock(WORKSPACE_A, "1"), (row) =>
            notes.update({ ...row, title: "first" }, row.revision),
          ),
        );
        // A client still editing revision 1.
        const stale = yield* Effect.flip(
          store.transaction(notes.getForUpdate(WORKSPACE_A, "1", 1)),
        );
        const staleUpdate = yield* Effect.flip(
          store.transaction(notes.update(note("1", { title: "second" }), 1)),
        );
        const staleRemove = yield* Effect.flip(
          store.transaction(notes.remove(WORKSPACE_A, "1", 1)),
        );
        return [stale, staleUpdate, staleRemove];
      }),
    );
    const conflict = new Conflict({ reason: "revision_changed", currentRevision: 2 });
    expect(exit).toEqual(Exit.succeed([conflict, conflict, conflict]));
  });

  test("another Workspace's row is NotFound for every operation", async () => {
    const exit = await run(({ store, notes }) =>
      Effect.gen(function* () {
        yield* store.transaction(notes.insert(note("1")));
        const results = yield* Effect.all([
          Effect.flip(notes.get(WORKSPACE_B, "1")),
          Effect.flip(store.transaction(notes.getForUpdate(WORKSPACE_B, "1", 1))),
          Effect.flip(store.transaction(notes.lock(WORKSPACE_B, "1"))),
          Effect.flip(store.transaction(notes.update(note("1", { workspaceId: WORKSPACE_B }), 1))),
          Effect.flip(store.transaction(notes.remove(WORKSPACE_B, "1", 1))),
        ]);
        const found = yield* notes.find(WORKSPACE_B, "1");
        const listed = yield* notes.list(WORKSPACE_B);
        return { results, found: Option.isNone(found), listed: listed.length };
      }),
    );
    const notFound = new NotFound({ entity: "Contact", id: "1" });
    expect(exit).toEqual(
      Exit.succeed({
        results: [notFound, notFound, notFound, notFound, notFound],
        found: true,
        listed: 0,
      }),
    );
  });

  test("remove deletes the row", async () => {
    const exit = await run(({ store, notes }) =>
      Effect.gen(function* () {
        yield* store.transaction(notes.insert(note("1")));
        yield* store.transaction(notes.remove(WORKSPACE_A, "1", 1));
        return Option.isNone(yield* notes.find(WORKSPACE_A, "1"));
      }),
    );
    expect(exit).toEqual(Exit.succeed(true));
  });

  test("unique indexes: global, partial expression, duplicate id, findUnique", async () => {
    const exit = await run(({ store, notes }) =>
      Effect.gen(function* () {
        const insert = (n: Note) => store.transaction(notes.insert(n));
        yield* insert(note("1", { slug: "acme", status: "pending", email: "A@x.cz" }));
        const slugTaken = yield* Effect.flip(
          insert(note("2", { slug: "acme", workspaceId: WORKSPACE_B })),
        );
        const emailTaken = yield* Effect.flip(
          insert(note("3", { status: "pending", email: "a@X.cz" })),
        );
        // Outside the partial index, and in another Workspace: no collision.
        yield* insert(note("4", { status: "accepted", email: "a@x.cz" }));
        yield* insert(note("5", { status: "pending", email: "a@x.cz", workspaceId: WORKSPACE_B }));
        const duplicateId = yield* Effect.flip(insert(note("1", { slug: "other" })));
        const bySlug = yield* notes.findUnique("notes_slug_unique", ["acme"]);
        const byEmail = yield* notes.findUnique(
          "notes_pending_email_unique",
          ["a@x.cz"],
          WORKSPACE_B,
        );
        return {
          slugTaken,
          emailTaken,
          duplicateId,
          bySlug: Option.map(bySlug, (n) => n.id),
          byEmail: Option.map(byEmail, (n) => n.id),
        };
      }),
    );
    expect(exit).toEqual(
      Exit.succeed({
        slugTaken: new UniqueViolation({ collection: "notes", constraint: "notes_slug_unique" }),
        emailTaken: new UniqueViolation({
          collection: "notes",
          constraint: "notes_pending_email_unique",
        }),
        duplicateId: new UniqueViolation({ collection: "notes", constraint: "primary" }),
        bySlug: Option.some("1"),
        byEmail: Option.some("5"),
      }),
    );
  });

  test("list filters, orders and pages by keyset", async () => {
    const exit = await run(({ store, notes }) =>
      Effect.gen(function* () {
        yield* store.transaction(
          Effect.forEach(
            [
              note("a", { issuedOn: "2026-11-03", title: "x" }),
              note("b", { issuedOn: "2026-11-01", title: "y" }),
              note("c", { issuedOn: "2026-11-02", title: "x" }),
              note("d", { issuedOn: "2026-11-02", title: "x" }),
              note("e", { issuedOn: "2026-10-30", title: "x" }),
              note("f", { workspaceId: WORKSPACE_B }),
            ],
            notes.insert,
          ),
        );
        const ids = (rows: ReadonlyArray<Note>) => rows.map((r) => r.id);
        const query = {
          where: { title: "x" },
          range: { issuedOn: { gte: "2026-11-01" } },
          orderBy: ["issuedOn"] as const,
          direction: "desc" as const,
        };
        const page1 = yield* notes.list(WORKSPACE_A, { ...query, limit: 2 });
        const last = page1[page1.length - 1];
        const page2 = yield* notes.list(WORKSPACE_A, {
          ...query,
          after: last === undefined ? [] : [last.issuedOn, last.id],
        });
        const inList = yield* notes.list(WORKSPACE_A, { whereIn: { id: ["e", "b"] } });
        const global = yield* notes.listGlobal({ where: { slug: "slug-f" } });
        return [ids(page1), ids(page2), ids(inList), ids(global)];
      }),
    );
    expect(exit).toEqual(Exit.succeed([["a", "d"], ["c"], ["b", "e"], ["f"]]));
  });
});

describe("in-memory CoreStore: transactions", () => {
  const counter = { workspaceId: WORKSPACE_A, seriesId: "s" as NumberingSeriesId, period: "2026" };

  test("a failure or a defect rolls back every write", async () => {
    const exit = await run(({ store, notes }) =>
      Effect.gen(function* () {
        const failed = yield* Effect.flip(
          store.transaction(
            Effect.gen(function* () {
              yield* notes.insert(note("1"));
              yield* store.counters.lock(counter);
              yield* store.counters.set(counter, 5);
              return yield* Effect.fail("boom" as const);
            }),
          ),
        );
        const died = yield* Effect.exit(
          store.transaction(Effect.andThen(notes.insert(note("2")), Effect.die("defect"))),
        );
        return {
          failed,
          died: Exit.isFailure(died),
          rows: (yield* notes.list(WORKSPACE_A)).length,
          next: yield* store.counters.peek(counter),
        };
      }),
    );
    expect(exit).toEqual(Exit.succeed({ failed: "boom", died: true, rows: 0, next: 1 }));
  });

  test("a nested transaction is a savepoint", async () => {
    const exit = await run(({ store, notes }) =>
      Effect.gen(function* () {
        yield* store.transaction(
          Effect.gen(function* () {
            yield* notes.insert(note("outer"));
            yield* Effect.ignore(
              store.transaction(Effect.andThen(notes.insert(note("inner")), Effect.fail("x"))),
            );
            yield* store.transaction(notes.insert(note("kept")));
          }),
        );
        return (yield* notes.list(WORKSPACE_A)).map((n) => n.id);
      }),
    );
    expect(exit).toEqual(Exit.succeed(["kept", "outer"]));
  });

  test("an interrupted transaction rolls back", async () => {
    const exit = await run(({ store, notes }) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          store.transaction(Effect.andThen(notes.insert(note("1")), Effect.never)),
        );
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
        return (yield* notes.list(WORKSPACE_A)).length;
      }),
    );
    expect(exit).toEqual(Exit.succeed(0));
  });

  test("writes outside a transaction are defects (rule C1)", async () => {
    expect(isDefect(await run(({ notes }) => notes.insert(note("1"))))).toBe(true);
    expect(isDefect(await run(({ store }) => store.counters.lock(counter)))).toBe(true);
    expect(isDefect(await run(({ store }) => store.afterCommit(Effect.void)))).toBe(true);
  });

  test("child fibers share the transaction", async () => {
    const exit = await run(({ store, notes }) =>
      Effect.gen(function* () {
        yield* store.transaction(
          Effect.all([notes.insert(note("1")), notes.insert(note("2"))], {
            concurrency: "unbounded",
          }),
        );
        return (yield* notes.list(WORKSPACE_A)).length;
      }),
    );
    expect(exit).toEqual(Exit.succeed(2));
  });

  test("using a transaction after it ended is a defect", async () => {
    const exit = await run(({ store, notes }) =>
      Effect.gen(function* () {
        const gate = yield* Ref.make(false);
        const leaked = yield* store.transaction(
          Effect.forkDetach(
            Effect.gen(function* () {
              while (!(yield* Ref.get(gate))) yield* Effect.yieldNow;
              return yield* notes.insert(note("late"));
            }),
          ),
        );
        yield* Ref.set(gate, true);
        return yield* Fiber.await(leaked);
      }),
    );
    expect(Exit.isSuccess(exit) && isDefect(exit.value)).toBe(true);
  });

  test("using a transaction while one of its savepoints is open is a defect", async () => {
    const exit = await run(({ store, notes }) =>
      store.transaction(
        Effect.gen(function* () {
          const opened = yield* Ref.make(false);
          const release = yield* Ref.make(false);
          const savepoint = yield* Effect.forkChild(
            store.transaction(
              Effect.gen(function* () {
                yield* Ref.set(opened, true);
                while (!(yield* Ref.get(release))) yield* Effect.yieldNow;
                return yield* notes.insert(note("in-savepoint"));
              }),
            ),
          );
          while (!(yield* Ref.get(opened))) yield* Effect.yieldNow;
          const sibling = yield* Effect.exit(notes.insert(note("sibling")));
          yield* Ref.set(release, true);
          yield* Fiber.join(savepoint);
          return sibling;
        }),
      ),
    );
    expect(Exit.isSuccess(exit) && isDefect(exit.value)).toBe(true);
  });

  test("concurrent read-modify-write transactions never lose an update", async () => {
    const exit = await run(({ store, notes }) =>
      Effect.gen(function* () {
        yield* store.transaction(notes.insert(note("1", { title: "0" })));
        const bump = store.transaction(
          Effect.gen(function* () {
            const row = yield* notes.lock(WORKSPACE_A, "1");
            yield* Effect.yieldNow;
            yield* notes.update({ ...row, title: String(Number(row.title) + 1) }, row.revision);
          }),
        );
        yield* Effect.all(
          Array.from({ length: 10 }, () => bump),
          { concurrency: "unbounded" },
        );
        const row = yield* notes.get(WORKSPACE_A, "1");
        return [row.title, row.revision];
      }),
    );
    expect(exit).toEqual(Exit.succeed(["10", 11]));
  });

  test("afterCommit runs after the outermost commit, outside the transaction", async () => {
    const exit = await run(({ store, notes }) =>
      Effect.gen(function* () {
        const log = yield* Ref.make<ReadonlyArray<string>>([]);
        const push = (s: string) => Ref.update(log, (l) => [...l, s]);
        yield* store.transaction(
          Effect.gen(function* () {
            yield* store.afterCommit(push("outer"));
            yield* store.transaction(store.afterCommit(push("savepoint kept")));
            yield* Effect.ignore(
              store.transaction(Effect.andThen(store.afterCommit(push("dropped")), Effect.fail(1))),
            );
            // The hook may open its own transaction.
            yield* store.afterCommit(
              Effect.orDie(store.transaction(Effect.asVoid(notes.insert(note("hook"))))),
            );
            yield* push("body");
          }),
        );
        yield* Effect.ignore(
          store.transaction(Effect.andThen(store.afterCommit(push("rolled back")), Effect.fail(1))),
        );
        // A failing hook is logged, not surfaced.
        yield* store.transaction(store.afterCommit(Effect.die("hook failed")));
        return { log: yield* Ref.get(log), hookRow: (yield* notes.list(WORKSPACE_A)).length };
      }),
    );
    expect(exit).toEqual(Exit.succeed({ log: ["body", "outer", "savepoint kept"], hookRow: 1 }));
  });
});

describe("in-memory CoreStore: number_reservations_document_fk", () => {
  const doc = "01900000-0000-7000-8000-0000000df001" as DocumentId;
  const reservation = (workspaceId: WorkspaceId, number: string) => ({
    workspaceId,
    kind: "invoice" as const,
    number,
    seriesId: null,
    documentId: doc,
  });

  test("a free number for a document with no row, or another Workspace's row, is a defect", async () => {
    const missing = await run(({ store }) =>
      store.transaction(store.reservations.tryReserve(reservation(WORKSPACE_A, "FK-1"))),
    );
    const otherWorkspace = await run(({ store }) =>
      store.transaction(
        Effect.andThen(
          ensureDocumentRow(WORKSPACE_B, doc),
          store.reservations.tryReserve(reservation(WORKSPACE_A, "FK-1")),
        ),
      ),
    );
    expect([isDefect(missing), isDefect(otherWorkspace)]).toEqual([true, true]);
  });

  test("a taken number inserts nothing, so it checks no foreign key", async () => {
    const exit = await run(({ store }) =>
      Effect.gen(function* () {
        yield* store.transaction(
          Effect.andThen(
            ensureDocumentRow(WORKSPACE_A, doc),
            store.reservations.tryReserve(reservation(WORKSPACE_A, "FK-1")),
          ),
        );
        const other = "01900000-0000-7000-8000-0000000df002" as DocumentId;
        return yield* store.transaction(
          store.reservations.tryReserve({ ...reservation(WORKSPACE_A, "FK-1"), documentId: other }),
        );
      }),
    );
    expect(exit).toEqual(Exit.succeed(false));
  });

  test("a document a reservation references cannot be removed; an unreserved one can", async () => {
    const exit = await run(({ store }) =>
      Effect.gen(function* () {
        const documents = (yield* MemoryTables).collection(StubDocuments);
        const free = "01900000-0000-7000-8000-0000000df003" as DocumentId;
        yield* store.transaction(
          Effect.all([
            ensureDocumentRow(WORKSPACE_A, doc),
            ensureDocumentRow(WORKSPACE_A, free),
            store.reservations.tryReserve(reservation(WORKSPACE_A, "FK-1")),
          ]),
        );
        const removedFree = yield* Effect.exit(
          store.transaction(documents.remove(WORKSPACE_A, free, 1)),
        );
        const removedReserved = yield* Effect.exit(
          store.transaction(documents.remove(WORKSPACE_A, doc, 1)),
        );
        return [Exit.isSuccess(removedFree), isDefect(removedReserved)];
      }),
    );
    expect(exit).toEqual(Exit.succeed([true, true]));
  });
});

describe("in-memory CoreStore: numbering (S3)", () => {
  const key = { workspaceId: WORKSPACE_A, seriesId: "s1" as NumberingSeriesId, period: "2026" };
  const doc = (n: number) => `01900000-0000-7000-8000-0000000d000${n}` as DocumentId;
  const format = (n: number) => `2026-${String(n).padStart(4, "0")}`;
  const allocate = (n: number) =>
    Effect.andThen(
      ensureDocumentRow(WORKSPACE_A, doc(n)),
      allocateNumber({ ...key, kind: "invoice", documentId: doc(n), format }),
    );
  const reserve = (
    number: string,
    documentId: DocumentId,
    overrides: { readonly workspaceId?: WorkspaceId; readonly kind?: "invoice" | "proforma" } = {},
  ) =>
    Effect.andThen(
      ensureDocumentRow(overrides.workspaceId ?? WORKSPACE_A, documentId),
      reserveNumber({
        workspaceId: overrides.workspaceId ?? WORKSPACE_A,
        kind: overrides.kind ?? "invoice",
        number,
        seriesId: null,
        documentId,
      }),
    );

  test("allocation is monotonic, skips reserved numbers and leaves no gap on rollback", async () => {
    const exit = await run(({ store }) =>
      Effect.gen(function* () {
        const first = yield* store.transaction(allocate(1));
        const rolledBack = yield* Effect.flip(
          store.transaction(Effect.andThen(allocate(2), Effect.fail("abort"))),
        );
        // An override took 2026-0003 (rule D4): the counter skips it.
        yield* store.transaction(reserve("2026-0003", doc(9)));
        const second = yield* store.transaction(allocate(3));
        const third = yield* store.transaction(allocate(4));
        const next = yield* store.counters.peek(key);
        return [first.number, rolledBack, second.number, third.number, next];
      }),
    );
    expect(exit).toEqual(Exit.succeed(["2026-0001", "abort", "2026-0002", "2026-0004", 5]));
  });

  test("a reserved number is never reserved again, per Workspace and kind", async () => {
    const exit = await run(({ store }) =>
      Effect.gen(function* () {
        const first = yield* store.transaction(reserve("X-1", doc(1)));
        const again = yield* store.transaction(reserve("X-1", doc(2)));
        const otherKind = yield* store.transaction(reserve("X-1", doc(3), { kind: "proforma" }));
        const otherWorkspace = yield* store.transaction(
          reserve("X-1", doc(4), { workspaceId: WORKSPACE_B }),
        );
        return [first, again, otherKind, otherWorkspace];
      }),
    );
    expect(exit).toEqual(Exit.succeed([true, false, true, true]));
  });

  test("a counter never goes back, and set needs lock", async () => {
    const backwards = await run(({ store }) =>
      store.transaction(
        Effect.andThen(
          store.counters.lock(key),
          Effect.andThen(store.counters.set(key, 5), store.counters.set(key, 4)),
        ),
      ),
    );
    expect(isDefect(backwards)).toBe(true);
    const unlocked = await run(({ store }) => store.transaction(store.counters.set(key, 5)));
    expect(isDefect(unlocked)).toBe(true);
  });

  test("concurrent allocations get distinct consecutive numbers", async () => {
    const exit = await run(({ store }) =>
      Effect.map(
        Effect.all(
          Array.from({ length: 5 }, (_, i) => store.transaction(allocate(i + 1))),
          { concurrency: "unbounded" },
        ),
        (numbers) => numbers.map((n) => n.sequence).sort(),
      ),
    );
    expect(exit).toEqual(Exit.succeed([1, 2, 3, 4, 5]));
  });
});

describe("in-memory CoreStore: council regressions", () => {
  const key = { workspaceId: WORKSPACE_A, seriesId: "s9" as NumberingSeriesId, period: "all" };

  test("an interrupted savepoint rolls back only its own writes", async () => {
    const exit = await run(({ store, notes }) =>
      Effect.gen(function* () {
        yield* store.transaction(
          Effect.gen(function* () {
            yield* notes.insert(note("outer"));
            const inner = yield* Effect.forkChild(
              store.transaction(Effect.andThen(notes.insert(note("inner")), Effect.never)),
            );
            yield* Effect.yieldNow;
            yield* Fiber.interrupt(inner);
            yield* notes.insert(note("after"));
          }),
        );
        return (yield* notes.list(WORKSPACE_A)).map((n) => n.id);
      }),
    );
    expect(exit).toEqual(Exit.succeed(["after", "outer"]));
  });

  test("a transaction that ends with a savepoint still open dies and rolls back", async () => {
    const exit = await run(({ store, notes }) =>
      Effect.gen(function* () {
        const release = yield* Ref.make(false);
        const opened = yield* Ref.make(false);
        const outer = yield* Effect.exit(
          store.transaction(
            Effect.gen(function* () {
              yield* notes.insert(note("outer"));
              const child = yield* Effect.forkDetach(
                store.transaction(
                  Effect.gen(function* () {
                    yield* Ref.set(opened, true);
                    while (!(yield* Ref.get(release))) yield* Effect.yieldNow;
                    return yield* notes.insert(note("late"));
                  }),
                ),
              );
              while (!(yield* Ref.get(opened))) yield* Effect.yieldNow;
              return child;
            }),
          ),
        );
        yield* Ref.set(release, true);
        yield* Effect.yieldNow;
        // A later transaction is unaffected by the dead savepoint finishing.
        yield* store.transaction(notes.insert(note("next")));
        return { outer: isDefect(outer), ids: (yield* notes.list(WORKSPACE_A)).map((n) => n.id) };
      }),
    );
    expect(exit).toEqual(Exit.succeed({ outer: true, ids: ["next"] }));
  });

  test("concurrent child fibers updating one row: the stale writer gets revision_changed", async () => {
    const exit = await run(({ store, notes }) =>
      Effect.gen(function* () {
        yield* store.transaction(notes.insert(note("1")));
        return yield* store.transaction(
          Effect.gen(function* () {
            const row = yield* notes.lock(WORKSPACE_A, "1");
            const results = yield* Effect.all(
              ["a", "b"].map((title) => Effect.exit(notes.update({ ...row, title }, row.revision))),
              { concurrency: "unbounded" },
            );
            return results.map((r) => (Exit.isSuccess(r) ? "ok" : "conflict"));
          }),
        );
      }),
    );
    expect(exit).toEqual(Exit.succeed(["ok", "conflict"]));
  });

  test("counters.set needs counters.lock in the same transaction", async () => {
    const exit = await run(({ store }) =>
      Effect.gen(function* () {
        yield* store.transaction(store.counters.lock(key));
        return yield* store.transaction(store.counters.set(key, 2));
      }),
    );
    expect(isDefect(exit)).toBe(true);
  });

  test("allocateNumber skips long occupied runs but stops on a repeating format", async () => {
    const doc = "01900000-0000-7000-8000-0000000d0001" as DocumentId;
    const exit = await run(({ store }) =>
      Effect.gen(function* () {
        yield* store.transaction(ensureDocumentRow(WORKSPACE_A, doc));
        yield* store.transaction(
          Effect.forEach(
            Array.from({ length: 50 }, (_, i) => `N-${i + 1}`),
            (number) =>
              store.reservations.tryReserve({
                workspaceId: WORKSPACE_A,
                kind: "invoice",
                number,
                seriesId: null,
                documentId: doc,
              }),
          ),
        );
        const allocated = yield* store.transaction(
          allocateNumber({ ...key, kind: "invoice", documentId: doc, format: (n) => `N-${n}` }),
        );
        const repeating = yield* Effect.exit(
          store.transaction(
            allocateNumber({ ...key, kind: "invoice", documentId: doc, format: () => "N-1" }),
          ),
        );
        return { number: allocated.number, repeating: isDefect(repeating) };
      }),
    );
    expect(exit).toEqual(Exit.succeed({ number: "N-51", repeating: true }));
  });

  test("audit history returns detached copies", async () => {
    const exit = await run(({ store }) =>
      Effect.gen(function* () {
        const subject = { entity: "Document", id: "d" } as const;
        const changes = [{ path: "note", before: { a: 1 }, after: null }];
        yield* store.transaction(
          store.audit.append(WORKSPACE_A, {
            id: "01900000-0000-7000-8000-000000000001" as never,
            at: "2026-11-23T09:00:00.000Z",
            actor: { _tag: "System", job: { _tag: "DataExport", exportId: "e" as never } },
            subject,
            action: "document.edit",
            revision: 2,
            changes,
            reason: null,
          }),
        );
        (changes[0] as { before: { a: number } }).before.a = 99;
        const first = yield* store.audit.history(WORKSPACE_A, subject);
        (first[0]?.changes[0]?.before as { a: number }).a = 7;
        const second = yield* store.audit.history(WORKSPACE_A, subject);
        return second[0]?.changes[0]?.before;
      }),
    );
    expect(exit).toEqual(Exit.succeed({ a: 1 }));
  });
});

describe("in-memory CoreStore: review regressions", () => {
  const key = { workspaceId: WORKSPACE_A, seriesId: "s7" as NumberingSeriesId, period: "all" };

  test("a counter lock taken in a rolled-back savepoint does not authorize set", async () => {
    const exit = await run(({ store }) =>
      Effect.gen(function* () {
        // Seed the counter in its own committed transaction, so the rollback cannot remove it.
        yield* store.transaction(store.counters.lock(key));
        return yield* store.transaction(
          Effect.gen(function* () {
            yield* Effect.ignore(
              store.transaction(Effect.andThen(store.counters.lock(key), Effect.fail("rollback"))),
            );
            return yield* Effect.exit(store.counters.set(key, 2));
          }),
        );
      }),
    );
    expect(Exit.isSuccess(exit) && isDefect(exit.value)).toBe(true);
  });

  test("a counter lock taken in a committed savepoint carries to the enclosing transaction", async () => {
    const exit = await run(({ store }) =>
      Effect.gen(function* () {
        yield* store.transaction(
          Effect.andThen(store.transaction(store.counters.lock(key)), store.counters.set(key, 3)),
        );
        return yield* store.counters.peek(key);
      }),
    );
    expect(exit).toEqual(Exit.succeed(3));
  });
});
