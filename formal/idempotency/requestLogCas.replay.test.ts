/**
 * Replays the RequestLogCas.tla traces on the real code: `Contacts.save` (withIdempotency over
 * requestLog.claim/complete, getForUpdate + update compare-and-set) on the in-memory CoreStore.
 * Each test is one selected trace reachable in the base model; its name lists the model steps per attempt
 * (Claim, Existing, Lock, Commit, Abort) and it asserts the model's invariants on real state:
 * AtMostOnceEffect, ReplayReturnsStoredResult, MismatchNeverReplayed, NoLostUpdate.
 *
 * The in-memory store serializes whole transactions, so overlapping attempts here interleave
 * only between transactions; the Postgres row-lock and claim-wait interleavings inside a
 * transaction are the model's (and the pg-contention job's) to cover.
 */
import { describe, expect, test } from "bun:test";
import { makeRequestOutcome } from "@kvitbit/core";
import { ContactsTestLayer, FakeContactSeries, InMemoryPortsLive } from "@kvitbit/core/testing";
import type {
  ContactId,
  ContactInput,
  ContactView,
  MemberCaller,
  NumberingSeriesId,
  RequestKey,
  UserId,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Contacts, CurrentCaller } from "@kvitbit/domain/contract";
import { RequestOutcome } from "@kvitbit/domain/ports";
import { Effect, Exit, Layer, Ref } from "effect";
import { TestClock } from "effect/testing";

const WORKSPACE = "01900000-0000-7000-8000-00000000a001" as WorkspaceId;
const owner: MemberCaller = {
  _tag: "Member",
  userId: "01900000-0000-7000-8000-00000000c001" as UserId,
  workspaceId: WORKSPACE,
  role: "owner",
  scopes: "all",
  locale: "cs",
  channel: "web",
  client: null,
};
const SERIES = "01900000-0000-7000-8000-0000000005e1" as NumberingSeriesId;
const k1 = "01900000-0000-7000-8000-0000000000a1" as RequestKey;
const k2 = "01900000-0000-7000-8000-0000000000a2" as RequestKey;
const k3 = "01900000-0000-7000-8000-0000000000a3" as RequestKey;

interface Contact {
  readonly id: ContactId;
  readonly revision: number;
  readonly name: string;
}
const asContact = (v: ContactView) => v as unknown as Contact;

/** One attempt: Contacts.save with its own RequestOutcome, so a replay is observable. */
const attempt = (
  input: Record<string, unknown>,
  requestKey: RequestKey,
): Effect.Effect<
  { readonly exit: Exit.Exit<Contact, unknown>; readonly replayed: boolean },
  never,
  Contacts | CurrentCaller
> =>
  Effect.gen(function* () {
    const outcome = yield* makeRequestOutcome;
    const contacts = yield* Contacts;
    const exit = yield* Effect.exit(
      contacts
        .save(input as unknown as ContactInput, { requestKey })
        .pipe(Effect.map(asContact), Effect.provideService(RequestOutcome, outcome)),
    );
    return { exit, replayed: yield* outcome.replayed };
  });

const ok = (e: { readonly exit: Exit.Exit<Contact, unknown> }): Contact => {
  if (Exit.isSuccess(e.exit)) return e.exit.value;
  throw new Error(`expected success, got ${String(e.exit.cause)}`);
};
const failure = (e: { readonly exit: Exit.Exit<Contact, unknown> }): unknown => {
  if (Exit.isFailure(e.exit)) {
    const err = e.exit.cause.reasons.find((r) => r._tag === "Fail");
    if (err !== undefined && "error" in err) return err.error;
  }
  throw new Error("expected a typed failure");
};

/** The committed row: revision and name, read back through the service. */
const current = (id: ContactId) =>
  Effect.flatMap(Contacts, (c) => c.get(id)).pipe(Effect.map(asContact), Effect.orDie);
const contactCount = Effect.flatMap(Contacts, (c) => c.search({})).pipe(
  Effect.map((page) => page.items.length),
  Effect.orDie,
);

/** Fresh in-memory core with one Contact at revision 1 (the model's Init). */
const run = <A, E>(
  body: (seed: Contact) => Effect.Effect<A, E, Contacts | CurrentCaller | FakeContactSeries>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 10, 23, 9, 0, 0));
      const seed = asContact(
        yield* Effect.flatMap(Contacts, (c) =>
          c.save({ name: "Acme s.r.o." } as unknown as ContactInput),
        ).pipe(Effect.orDie),
      );
      expect(seed.revision).toBe(1);
      return yield* body(seed);
    }).pipe(
      Effect.provide(ContactsTestLayer),
      Effect.provideService(CurrentCaller, owner),
      Effect.provide(Layer.merge(InMemoryPortsLive(), TestClock.layer())),
    ),
  );

/** The model's requests on the seeded row. */
const r1 = (seed: Contact) => ({ id: seed.id, expectedRevision: 1, name: "A" }); // key k1
const r2 = (seed: Contact) => ({ id: seed.id, expectedRevision: 1, name: "B" }); // key k1
const r3 = (seed: Contact) => ({ id: seed.id, expectedRevision: 1, name: "C" }); // key k2
const r4 = { name: "D" }; // create, key k3
const r5 = (seed: Contact) => ({ id: seed.id, expectedRevision: 2, name: "C2" }); // key k2

describe("RequestLogCas traces on Contacts.save", () => {
  test("r1: Claim, Lock, Commit; r1 retry: Claim, Existing -> the stored result, replayed", async () => {
    const { first, retry, row } = await run((seed) =>
      Effect.gen(function* () {
        const first = yield* attempt(r1(seed), k1);
        const retry = yield* attempt(r1(seed), k1);
        return { first, retry, row: yield* current(seed.id) };
      }),
    );
    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    // ReplayReturnsStoredResult
    expect(ok(retry)).toEqual(ok(first));
    // AtMostOnceEffect + NoLostUpdate: one edit, from revision 1 to 2
    expect(row).toMatchObject({ revision: 2, name: "A" });
  });

  test("r1 commits; r2 (same key, other payload): Claim, Existing -> idempotency_mismatch", async () => {
    const { mismatch, row } = await run((seed) =>
      Effect.gen(function* () {
        ok(yield* attempt(r1(seed), k1));
        const mismatch = yield* attempt(r2(seed), k1);
        return { mismatch, row: yield* current(seed.id) };
      }),
    );
    // MismatchNeverReplayed
    expect(mismatch.replayed).toBe(false);
    expect(failure(mismatch)).toMatchObject({ _tag: "Conflict", reason: "idempotency_mismatch" });
    expect(row).toMatchObject({ revision: 2, name: "A" });
  });

  test("r1 commits; r3: Lock (stale) twice; r5 on k2 commits; r1 retry: Existing -> its own result", async () => {
    const { first, stale, again, fresh, retry, row } = await run((seed) =>
      Effect.gen(function* () {
        const first = yield* attempt(r1(seed), k1);
        const stale = yield* attempt(r3(seed), k2);
        // A failed attempt stores nothing: the retry runs the body again (no replay).
        const again = yield* attempt(r3(seed), k2);
        // r5 (the fresh revision) is a new payload on k2, which nothing holds: it claims.
        const fresh = yield* attempt(r5(seed), k2);
        // r1's retry after a later edit gets r1's stored result, not the live row.
        const retry = yield* attempt(r1(seed), k1);
        return { first, stale, again, fresh, retry, row: yield* current(seed.id) };
      }),
    );
    for (const s of [stale, again]) {
      expect(s.replayed).toBe(false);
      expect(failure(s)).toMatchObject({
        _tag: "Conflict",
        reason: "revision_changed",
        currentRevision: 2,
      });
    }
    // NoLostUpdate: revision 3 = two committed edits, made from revisions 1 and 2
    expect(fresh.replayed).toBe(false);
    expect(ok(fresh)).toMatchObject({ revision: 3, name: "C2" });
    expect(row).toMatchObject({ revision: 3, name: "C2" });
    // ReplayReturnsStoredResult while the row has moved on
    expect(retry.replayed).toBe(true);
    expect(ok(retry)).toEqual(ok(first));
    expect(ok(retry)).toMatchObject({ revision: 2, name: "A" });
  });

  test("r1: Claim, Lock, Abort; r1 retry: Claim, Lock, Commit -> the rollback freed the key", async () => {
    const { aborted, retry, row } = await run((seed) =>
      Effect.gen(function* () {
        // The body fails after getForUpdate: the preferred series does not exist yet.
        const input = { ...r1(seed), defaults: { preferredSeriesByKind: { invoice: SERIES } } };
        const aborted = yield* attempt(input, k1);
        const fake = yield* FakeContactSeries;
        yield* Ref.set(fake.series, [{ workspaceId: WORKSPACE, id: SERIES, kind: "invoice" }]);
        const retry = yield* attempt(input, k1);
        return { aborted, retry, row: yield* current(seed.id) };
      }),
    );
    expect(failure(aborted)).toMatchObject({ _tag: "NotFound" });
    // keep_claim_on_rollback would leave k1 pending (the retry would wait or replay nothing)
    expect(retry.replayed).toBe(false);
    expect(ok(retry)).toMatchObject({ revision: 2, name: "A" });
    expect(row).toMatchObject({ revision: 2, name: "A" });
  });

  test("r1 attempt 1 || r1 attempt 2 overlap: one Commit, one Existing with the same result", async () => {
    const { attempts, row } = await run((seed) =>
      Effect.gen(function* () {
        const attempts = yield* Effect.all([attempt(r1(seed), k1), attempt(r1(seed), k1)], {
          concurrency: "unbounded",
        });
        return { attempts, row: yield* current(seed.id) };
      }),
    );
    expect(attempts.map((a) => a.replayed).sort()).toEqual([false, true]);
    expect(ok(attempts[0])).toEqual(ok(attempts[1]));
    expect(row).toMatchObject({ revision: 2, name: "A" });
  });

  test("r4 attempt 1 || r4 attempt 2 overlap (create): one Contact, both get it", async () => {
    const { attempts, count } = await run(() =>
      Effect.gen(function* () {
        const attempts = yield* Effect.all([attempt(r4, k3), attempt(r4, k3)], {
          concurrency: "unbounded",
        });
        return { attempts, count: yield* contactCount };
      }),
    );
    // AtMostOnceEffect: the seed plus exactly one created Contact
    expect(count).toBe(2);
    expect(attempts.map((a) => a.replayed).sort()).toEqual([false, true]);
    expect(ok(attempts[0])).toEqual(ok(attempts[1]));
  });

  test("r1 || r3 overlap from revision 1: one Commit, the other Lock is stale", async () => {
    const { attempts, row } = await run((seed) =>
      Effect.gen(function* () {
        const attempts = yield* Effect.all([attempt(r1(seed), k1), attempt(r3(seed), k2)], {
          concurrency: "unbounded",
        });
        return { attempts, row: yield* current(seed.id) };
      }),
    );
    const wins = attempts.filter((a) => Exit.isSuccess(a.exit));
    const losses = attempts.filter((a) => Exit.isFailure(a.exit));
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(failure(losses[0] as (typeof attempts)[number])).toMatchObject({
      reason: "revision_changed",
      currentRevision: 2,
    });
    // NoLostUpdate: the row holds the winner's edit at revision 2
    const winner = ok(wins[0] as (typeof attempts)[number]);
    expect(row).toEqual(expect.objectContaining({ revision: 2, name: winner.name }));
  });
});
