import { describe, expect, test } from "bun:test";
import {
  type AuditEntry,
  AuditEntryId,
  ExportId,
  RequestKey,
  UserId,
} from "@kvitbit/domain/contract";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import { CoreStore, runStore, seedWorkspace } from "./support";

const countNotes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ n: number }>`select count(*)::int as n from contacts`;
  return rows[0]?.n ?? 0;
});

const insertContact = (workspaceId: string, name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`insert into contacts (id, workspace_id, name, country)
      values (${SecureRandom.uuidV7Unsafe()}, ${workspaceId}, ${name}, 'CZ')`;
  }).pipe(Effect.orDie);

describe("SQL CoreStore: transactions", () => {
  test("a failure rolls back every write; a nested failure only its savepoint", async () => {
    const result = await runStore(
      Effect.gen(function* () {
        const store = yield* CoreStore;
        const { workspaceId } = yield* seedWorkspace;
        const failed = yield* Effect.exit(
          store.transaction(
            Effect.andThen(insertContact(workspaceId, "a"), Effect.fail("boom" as const)),
          ),
        );
        const afterFailure = yield* countNotes;
        yield* store.transaction(
          Effect.gen(function* () {
            yield* insertContact(workspaceId, "outer");
            yield* Effect.exit(
              store.transaction(
                Effect.andThen(insertContact(workspaceId, "inner"), Effect.fail("inner" as const)),
              ),
            );
          }),
        );
        return { failed: Exit.isFailure(failed), afterFailure, final: yield* countNotes };
      }),
    );
    expect(result).toEqual({ failed: true, afterFailure: 0, final: 1 });
  });

  test("afterCommit runs after the outermost commit and is dropped on rollback", async () => {
    const log = await runStore(
      Effect.gen(function* () {
        const store = yield* CoreStore;
        const events = yield* Ref.make<ReadonlyArray<string>>([]);
        const push = (e: string) => Ref.update(events, (all) => [...all, e]);
        yield* store.transaction(
          Effect.gen(function* () {
            yield* store.afterCommit(push("committed"));
            yield* Effect.exit(
              store.transaction(
                Effect.andThen(store.afterCommit(push("savepoint-rolled-back")), Effect.fail(1)),
              ),
            );
            yield* push("inside");
          }),
        );
        yield* Effect.exit(
          store.transaction(Effect.andThen(store.afterCommit(push("rolled-back")), Effect.fail(2))),
        );
        return yield* Ref.get(events);
      }),
    );
    expect(log).toEqual(["inside", "committed"]);
  });

  test("afterCommit outside a transaction is a defect", async () => {
    const exit = await runStore(
      Effect.gen(function* () {
        const store = yield* CoreStore;
        return yield* Effect.exit(store.afterCommit(Effect.void));
      }),
    );
    expect(exit.pipe(Exit.hasDies)).toBe(true);
  });
});

describe("SQL CoreStore: counters", () => {
  test("lock upserts at 1, set only grows, peek reads without locking", async () => {
    const result = await runStore(
      Effect.gen(function* () {
        const store = yield* CoreStore;
        const { workspaceId, seriesId } = yield* seedWorkspace;
        const key = { workspaceId, seriesId, period: "2026" };
        const before = yield* store.counters.peek(key);
        const first = yield* store.transaction(
          Effect.gen(function* () {
            const next = yield* store.counters.lock(key);
            yield* store.counters.set(key, next + 1);
            return next;
          }),
        );
        const lower = yield* Effect.exit(
          store.transaction(Effect.andThen(store.counters.lock(key), store.counters.set(key, 1))),
        );
        return {
          before,
          first,
          after: yield* store.counters.peek(key),
          lowerDies: Exit.hasDies(lower),
        };
      }),
    );
    expect(result).toEqual({ before: 1, first: 1, after: 2, lowerDies: true });
  });
});

describe("SQL CoreStore: request log (C3)", () => {
  test("claim, complete, then a replay sees the entry; a rollback frees the key", async () => {
    const result = await runStore(
      Effect.gen(function* () {
        const store = yield* CoreStore;
        const { workspaceId } = yield* seedWorkspace;
        const scope = { _tag: "Workspace" as const, workspaceId };
        const key = RequestKey.make("key-1");
        const now = "2026-11-24T10:00:00.000Z";
        const rolledBack = yield* Effect.exit(
          store.transaction(
            Effect.andThen(store.requestLog.claim(scope, key, now), Effect.fail(0)),
          ),
        );
        const claim = yield* store.transaction(
          Effect.gen(function* () {
            const claimed = yield* store.requestLog.claim(scope, key, now);
            yield* store.requestLog.complete({
              scope,
              key,
              method: "Contacts.save",
              fingerprint: "abc",
              result: { id: "x" },
              createdAt: now,
              expiresAt: "2026-11-25T10:00:00.000Z",
            });
            return claimed;
          }),
        );
        const replay = yield* store.transaction(
          store.requestLog.claim(scope, key, "2026-11-24T11:00:00.000Z"),
        );
        const expired = yield* store.transaction(
          store.requestLog.claim(scope, key, "2026-11-25T10:00:01.000Z"),
        );
        return { rolledBack: Exit.isFailure(rolledBack), claim, replay, expired };
      }),
    );
    expect(result.rolledBack).toBe(true);
    expect(result.claim).toEqual({ _tag: "Claimed" });
    expect(result.replay).toMatchObject({
      _tag: "Existing",
      entry: {
        method: "Contacts.save",
        fingerprint: "abc",
        expiresAt: "2026-11-25T10:00:00.000Z",
      },
    });
    const replayed = result.replay._tag === "Existing" ? result.replay.entry : undefined;
    expect(replayed?.result).toEqual({ id: "x" });
    expect(result.expired).toEqual({ _tag: "Claimed" });
  });
});

describe("SQL CoreStore: audit", () => {
  test("append then history returns the entries in time order, actors intact", async () => {
    const result = await runStore(
      Effect.gen(function* () {
        const store = yield* CoreStore;
        const { workspaceId } = yield* seedWorkspace;
        const subject = { entity: "Contact" as const, id: SecureRandom.uuidV7Unsafe() };
        const member: AuditEntry = {
          id: AuditEntryId.make(SecureRandom.uuidV7Unsafe()),
          at: "2026-11-24T10:00:01.000Z",
          actor: {
            _tag: "Member",
            userId: UserId.make(SecureRandom.uuidV7Unsafe()),
            channel: "api",
            client: { kind: "api_key", id: "k1", name: "CI key" },
          },
          subject,
          action: "contact.edit",
          revision: 2,
          changes: [
            { path: "name", before: "A", after: "B" },
            { path: "note", before: undefined, after: null },
            { path: "phone", before: null, after: undefined },
          ],
          reason: null,
        };
        const system: AuditEntry = {
          ...member,
          id: AuditEntryId.make("01900000-0000-4000-8000-0000000000dd", { disableChecks: true }),
          at: "2026-11-24T10:00:00.000Z",
          actor: {
            _tag: "System",
            job: { _tag: "DataExport", exportId: ExportId.make(SecureRandom.uuidV7Unsafe()) },
          },
          revision: null,
          changes: [],
          reason: "nightly",
        };
        yield* store.transaction(
          Effect.andThen(
            store.audit.append(workspaceId, member),
            store.audit.append(workspaceId, system),
          ),
        );
        return { member, system, history: yield* store.audit.history(workspaceId, subject) };
      }),
    );
    expect(result.history).toStrictEqual([result.system, result.member]);
  });
});
