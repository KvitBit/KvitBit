/**
 * Regressions for role-review round 1 on the Workspaces module (one block per finding). The
 * memory store serializes top-level transactions, so races are simulated (a stale caller, a
 * repository that reports a taken slug as free, gated deliveries); a true PostgreSQL race test
 * belongs to the adapters.
 */
import { describe, expect, test } from "bun:test";
import type {
  BankAccountId,
  InvitationId,
  IsoDate,
  RequestKey,
  UserId,
} from "@kvitbit/domain/contract";
import { Conflict, Forbidden, Invalid, NotFound, Unavailable } from "@kvitbit/domain/contract";
import { Deferred, Effect, Fiber, Layer, Option, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import {
  BankAccountReferencesFake,
  InvitationDelivery,
  makeWorkspaces,
  WorkspaceSeries,
  WorkspaceSnapshots,
  WorkspacesRepo,
} from "../../../src/modules/workspaces";
import { RegistryLookup } from "../../../src/modules/workspaces/registry";
import { sha256Hex } from "../../../src/shared/hash";
import { CoreStore } from "../../../src/store/CoreStore";
import { FakeCompanyRegistry } from "../../../src/testing";
import {
  ACCOUNTANT,
  ADMIN,
  accountOf,
  as,
  failure,
  history,
  ICO,
  join,
  MEMBER,
  OUTSIDER,
  scenario,
  seed,
  W,
} from "./harness";

// biome-ignore lint/suspicious/noExplicitAny: domain views are open structs; tests read their concrete fields
const view = <A>(v: A) => v as unknown as Record<string, any>;
const IBAN_CZ = "CZ65 0800 0000 1920 0014 5399";
const IBAN_CZ_2 = "CZ6907101781240000004159";
const IBAN_DE = "DE89370400440532013000";
const key = (k: string) => ({ requestKey: k as RequestKey });
const forbidden = (action: string) => new Forbidden({ action: action as never });

describe("R1/R1c: the actor's stored role decides under the workspace lock", () => {
  test("a former owner's in-flight close and transfer are Forbidden", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        yield* as(s.owner)(ws.transferOwnership(ADMIN));
        // s.owner still says role "owner": a request admitted before the transfer.
        expect(yield* failure(as(s.owner)(ws.close("Acme s.r.o.")))).toEqual(
          forbidden("workspace.close"),
        );
        expect(view(yield* as(s.admin)(ws.current)).closed).toBe(false);
      }),
    ));

  test("a demoted admin's in-flight setRole, invite, resend and revoke are Forbidden", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const pending = yield* as(s.admin)(ws.invite("new@example.com", "member"));
        yield* as(s.owner)(ws.setRole(ADMIN, "member"));
        expect(yield* failure(as(s.admin)(ws.setRole(MEMBER, null)))).toEqual(
          forbidden("member.setRole"),
        );
        expect(yield* failure(as(s.admin)(ws.invite("other@example.com", "member")))).toEqual(
          forbidden("member.invite"),
        );
        expect(yield* failure(as(s.admin)(ws.revokeInvitation(pending.id)))).toEqual(
          forbidden("member.invite"),
        );
        yield* TestClock.adjust("2 minutes");
        expect(yield* failure(as(s.admin)(ws.resendInvitation(pending.id)))).toEqual(
          forbidden("member.invite"),
        );
        const roles = (yield* as(s.owner)(ws.members)).map((m) => view(m).role);
        expect(roles).toContain("member");
      }),
    ));

  test("a removed admin's in-flight invite is Forbidden", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        yield* as(s.owner)(ws.setRole(ADMIN, null));
        expect(yield* failure(as(s.admin)(ws.invite("x@example.com", "member")))).toEqual(
          forbidden("member.invite"),
        );
      }),
    ));
});

describe("W2: the baseline Tax Regime period is never replaced", () => {
  test("a change effective on the creation date keeps earlier tax points on the baseline", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const snapshots = yield* WorkspaceSnapshots;
        const s = yield* seed();
        const before = (yield* snapshots.get(s.workspaceId, "2026-11-22" as IsoDate)).taxRegime;
        expect(before).toBe("non_vat_payer");
        const change = { taxRegime: { regime: "vat_payer", effectiveFrom: "2026-11-23" } } as never;
        const next = view(yield* as(s.owner)(ws.updateIssuingEntity(change, 1)));
        expect(next.taxRegime).toBe("vat_payer");
        expect(next.taxRegimeHistory).toEqual([
          { regime: "non_vat_payer", effectiveFrom: "2026-11-23" },
          { regime: "vat_payer", effectiveFrom: "2026-11-23" },
        ]);
        expect((yield* snapshots.get(s.workspaceId, "2026-11-22" as IsoDate)).taxRegime).toBe(
          "non_vat_payer",
        );
        // A second change on the same date replaces the non-first period only.
        const back = { taxRegime: { regime: "non_vat_payer", effectiveFrom: "2026-11-23" } };
        const again = view(
          yield* as(s.owner)(ws.updateIssuingEntity(back as never, next.revision)),
        );
        expect(again.taxRegimeHistory).toEqual([
          { regime: "non_vat_payer", effectiveFrom: "2026-11-23" },
          { regime: "non_vat_payer", effectiveFrom: "2026-11-23" },
        ]);
      }),
    ));
});

describe("bank accounts", () => {
  const setup = Effect.gen(function* () {
    const ws = yield* W;
    const s = yield* seed();
    const save = (input: object) =>
      Effect.map(as(s.admin)(ws.saveBankAccount(input as never)), view);
    const remove = (id: string, replacement?: string) =>
      as(s.admin)(
        ws.removeBankAccount(id as BankAccountId, replacement as BankAccountId | undefined),
      );
    return { ws, s, save, remove };
  });

  test("C1: a rolled-back removal restores the reassigned references", () =>
    scenario(
      Effect.gen(function* () {
        const { ws, s, save, remove } = yield* setup;
        const refs = yield* BankAccountReferencesFake;
        const store = yield* CoreStore;
        const a = yield* save({ iban: IBAN_CZ, currency: "CZK" });
        const b = yield* save({ iban: IBAN_CZ_2, currency: "CZK" });
        yield* refs.set(s.workspaceId, a.id, 2);
        // The removal commits only as a savepoint; the enclosing transaction then fails.
        const outcome = yield* failure(
          store.transaction(Effect.andThen(remove(a.id, b.id), Effect.fail("boom" as const))),
        );
        expect(outcome).toBe("boom");
        expect(yield* refs.get(s.workspaceId, a.id)).toBe(2);
        expect(yield* refs.get(s.workspaceId, b.id)).toBe(0);
        const ids = view(yield* as(s.admin)(ws.current)).bankAccounts.map(
          (x: { id: string }) => x.id,
        );
        expect(ids).toEqual([a.id, b.id]);
      }),
    ));

  test("4.1: the sole account of a currency is its default and needs a replacement", () =>
    scenario(
      Effect.gen(function* () {
        const { save, remove } = yield* setup;
        const a = yield* save({ iban: IBAN_CZ, currency: "CZK" });
        expect(yield* failure(remove(a.id))).toEqual(
          new Conflict({ reason: "illegal_transition", detail: "bank_account.in_use" }),
        );
      }),
    ));

  test("R2: a foreign or unknown replacement is NotFound; archived or self is Invalid", () =>
    scenario(
      Effect.gen(function* () {
        const { ws, save, remove } = yield* setup;
        const other = yield* as(accountOf(OUTSIDER))(ws.create({ name: "Jiná s.r.o." } as never));
        const foreign = view(
          yield* as(other)(ws.saveBankAccount({ iban: IBAN_CZ, currency: "CZK" } as never)),
        );
        const a = yield* save({ iban: IBAN_CZ, currency: "CZK" });
        const b = yield* save({ iban: IBAN_CZ_2, currency: "CZK" });
        const c = yield* save({ iban: IBAN_CZ_2, currency: "CZK", name: "Třetí" });
        const eur = yield* save({ iban: IBAN_DE, currency: "EUR" });
        expect(yield* failure(remove(a.id, foreign.id))).toEqual(
          new NotFound({ entity: "BankAccount", id: foreign.id }),
        );
        expect(yield* failure(remove(a.id, "unknown"))).toEqual(
          new NotFound({ entity: "BankAccount", id: "unknown" }),
        );
        const replacementInvalid = new Invalid({
          issues: [{ path: ["replacement"], code: "bank_account.replacement_invalid" }],
        });
        expect(yield* failure(remove(a.id, a.id))).toEqual(replacementInvalid);
        expect(yield* failure(remove(a.id, eur.id))).toEqual(replacementInvalid);
        yield* remove(c.id);
        expect(yield* failure(remove(a.id, c.id))).toEqual(replacementInvalid);
        yield* remove(a.id, b.id);
      }),
    ));

  test("C6: a keyed replacement of an existing account applies to the current state", () =>
    scenario(
      Effect.gen(function* () {
        const { ws, s, save } = yield* setup;
        const a = yield* save({ iban: IBAN_CZ, currency: "CZK" });
        const edit = (name: string, k?: string) =>
          as(s.admin)(
            ws.saveBankAccount(
              { id: a.id, iban: IBAN_CZ, currency: "CZK", name } as never,
              k === undefined ? undefined : key(k),
            ),
          );
        yield* edit("První", "k1");
        yield* edit("Druhý");
        const repeated = view(yield* edit("První", "k1"));
        expect(repeated.name).toBe("První");
        const stored = view(yield* as(s.admin)(ws.current)).bankAccounts[0];
        expect(stored).toMatchObject({ name: "První", revision: repeated.revision });
      }),
    ));
});

describe("C3: a committed create replays without the registry", () => {
  test("a registry outage does not break the replay; a new key surfaces it", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const registry = yield* FakeCompanyRegistry;
        const creator = accountOf(OUTSIDER);
        const first = yield* as(creator)(ws.create({ ico: ICO } as never, key("c1")));
        yield* Ref.set(registry.unavailable, true);
        // A fresh lookup cache, as on another server instance.
        const fresh = yield* makeWorkspaces.pipe(Effect.provide(Layer.fresh(RegistryLookup.layer)));
        const lookups = (yield* Ref.get(registry.lookups)).length;
        const replay = yield* as(creator)(fresh.create({ ico: ICO } as never, key("c1")));
        // The replay resolved before any registry call.
        expect((yield* Ref.get(registry.lookups)).length).toBe(lookups);
        expect(replay).toEqual(first);
        expect(yield* failure(as(creator)(fresh.create({ ico: ICO } as never, key("c2"))))).toEqual(
          new Unavailable({ dependency: "company_registry" }),
        );
      }),
    ));
});

describe("W5/R1a: a closed Workspace returns no cached write result", () => {
  test("keyed invite, bank-account create and series create are Forbidden after close", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const invite = as(s.admin)(ws.invite("new@example.com", "member", key("i1")));
        const bank = as(s.admin)(
          ws.saveBankAccount({ iban: IBAN_CZ, currency: "CZK" } as never, key("b1")),
        );
        const series = as(s.admin)(
          ws.configureSeries({ kind: "invoice", name: "FV", pattern: "FV-YY-NNN" }, key("s1")),
        );
        yield* invite;
        yield* bank;
        yield* series;
        yield* as(s.owner)(ws.close("Acme s.r.o."));
        expect(yield* failure(invite)).toEqual(forbidden("member.invite"));
        expect(yield* failure(bank)).toEqual(forbidden("workspace.settings"));
        expect(yield* failure(series)).toEqual(forbidden("workspace.settings"));
      }),
    ));
});

describe("C6: recordAccessEvent", () => {
  test("duplicate concurrent hooks write one entry (memory level)", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const event = {
          action: "apiKey.create" as const,
          subject: { entity: "ApiKey" as const, id: "cred-9", name: "CI" },
        };
        yield* Effect.all(
          Array.from({ length: 4 }, () => as(s.admin)(ws.recordAccessEvent(event))),
          { concurrency: "unbounded" },
        );
        const entries = yield* history(s.workspaceId, { entity: "ApiKey", id: "cred-9" });
        expect(entries.length).toBe(1);
      }),
    ));
});

describe("C6: member removal and ownership transfer retries", () => {
  test("repeating a removal succeeds; a never-member stays NotFound; rejoining reactivates", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        yield* as(s.admin)(ws.setRole(MEMBER, null));
        yield* as(s.admin)(ws.setRole(MEMBER, null));
        const removals = (yield* history(s.workspaceId)).filter(
          (e) => e.action === "member.remove",
        );
        expect(removals.length).toBe(1);
        expect(yield* failure(as(s.admin)(ws.setRole(OUTSIDER, null)))).toEqual(
          new NotFound({ entity: "Member", id: OUTSIDER }),
        );
        expect(yield* failure(as(s.admin)(ws.setRole(MEMBER, "admin")))).toEqual(
          new NotFound({ entity: "Member", id: MEMBER }),
        );
        // Removed members are invisible to reads and to enter.
        const ids = () =>
          Effect.map(as(s.admin)(ws.members), (all) => all.map((m) => view(m).userId as UserId));
        expect(yield* ids()).not.toContain(MEMBER);
        expect(
          yield* failure(
            as(accountOf(MEMBER))(
              ws.enter(s.workspaceId, { scopes: "all", channel: "web" } as never),
            ),
          ),
        ).toEqual(new NotFound({ entity: "Workspace", id: s.workspaceId }));
        // Rejoining reactivates the same row with the invited role.
        const back = yield* join(s.admin, MEMBER, "accountant");
        expect(back.role).toBe("accountant");
        expect(yield* ids()).toContain(MEMBER);
        // A member removed later can be removed again by its new role's rules.
        yield* as(s.admin)(ws.setRole(MEMBER, null));
        yield* as(s.admin)(ws.setRole(MEMBER, null));
      }),
    ));

  test("a member who left can be removed again (void); leave twice is void", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        yield* as(s.accountant)(ws.leave);
        yield* as(s.accountant)(ws.leave);
        yield* as(s.admin)(ws.setRole(ACCOUNTANT, null));
        const actions = (yield* history(s.workspaceId)).map((e) => e.action);
        expect(actions.filter((a) => a === "member.leave").length).toBe(1);
        expect(actions).not.toContain("member.remove");
      }),
    ));

  test("repeating the same transfer succeeds; a different target stays Forbidden", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        yield* as(s.owner)(ws.transferOwnership(ADMIN));
        yield* as(s.owner)(ws.transferOwnership(ADMIN));
        const transfers = (yield* history(s.workspaceId)).filter(
          (e) => e.action === "workspace.transferOwnership",
        );
        expect(transfers.length).toBe(1);
        expect(yield* failure(as(s.owner)(ws.transferOwnership(MEMBER)))).toEqual(
          forbidden("workspace.transferOwnership"),
        );
        // Once the new owner transfers on, the old retry is no longer recognized.
        yield* as({ ...s.admin, role: "owner" })(ws.transferOwnership(MEMBER));
        expect(yield* failure(as(s.owner)(ws.transferOwnership(ADMIN)))).toEqual(
          forbidden("workspace.transferOwnership"),
        );
      }),
    ));
});

describe("C6/W3: configureSeries", () => {
  test("a keyed replacement of an existing series applies to the current state", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const invoice = (yield* as(s.admin)(ws.listSeries)).find((x) => x.kind === "invoice");
        if (invoice === undefined) return yield* Effect.die("no invoice series");
        const edit = (name: string, k?: string) =>
          as(s.admin)(
            ws.configureSeries(
              { id: invoice.id, kind: "invoice", name, pattern: invoice.pattern },
              k === undefined ? undefined : key(k),
            ),
          );
        yield* edit("První", "k1");
        yield* edit("Druhá");
        expect((yield* edit("První", "k1")).name).toBe("První");
        const stored = (yield* as(s.admin)(ws.listSeries)).find((x) => x.id === invoice.id);
        expect(stored?.name).toBe("První");
      }),
    ));

  test("nextNumber must be an integer >= 1, through the service and the memory port", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const malformed = new Invalid({
          issues: [{ path: ["nextNumber"], code: "request.malformed" }],
        });
        for (const nextNumber of [1.5, 0, -3]) {
          expect(
            yield* failure(
              as(s.admin)(
                ws.configureSeries({ kind: "invoice", name: "FV", pattern: "FV-NNN", nextNumber }),
              ),
            ),
          ).toEqual(malformed);
        }
        const port = yield* WorkspaceSeries;
        const store = yield* CoreStore;
        expect(
          yield* failure(
            store.transaction(
              port.configure(
                s.workspaceId,
                { kind: "invoice", name: "FV", pattern: "FV-NNN", nextNumber: 2.5 },
                "2026-11-23" as IsoDate,
              ),
            ),
          ),
        ).toEqual(malformed);
        const ok = yield* as(s.admin)(
          ws.configureSeries({ kind: "invoice", name: "FV", pattern: "FV-NNN", nextNumber: 7 }),
        );
        expect(ok.nextCounter).toBe(7);
      }),
    ));
});

describe("W6: a generated slug lost to a concurrent create retries the next suffix", () => {
  test("generated slugs retry; an explicit slug still fails slug_taken", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const repo = yield* WorkspacesRepo;
        const first = yield* as(accountOf(OUTSIDER))(ws.create({ name: "Acme" } as never));
        const taken = view(yield* as(first)(ws.current)).slug as string;
        // A repository whose slug read misses the committed row, as a concurrent create would.
        const stale = yield* makeWorkspaces.pipe(
          Effect.provideService(WorkspacesRepo, {
            ...repo,
            findWorkspaceBySlug: (slug) =>
              slug === taken ? Effect.succeed(Option.none()) : repo.findWorkspaceBySlug(slug),
          }),
        );
        const second = yield* as(accountOf(ADMIN))(stale.create({ name: "Acme" } as never));
        expect(view(yield* as(second)(ws.current)).slug).toBe(`${taken}-2`);
        expect(
          yield* failure(
            as(accountOf(MEMBER))(stale.create({ name: "Acme", slug: taken } as never)),
          ),
        ).toEqual(new Invalid({ issues: [{ path: ["slug"], code: "workspace.slug_taken" }] }));
      }),
    ));
});

describe("J1: a successful start stamps workflowStartedAt for its epoch", () => {
  test("stamped after start, reset on resend, and a late start never stamps a newer epoch", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const repo = yield* WorkspacesRepo;
        const s = yield* seed();
        const row = (id: InvitationId) => repo.getInvitation(s.workspaceId, id);
        // The plain fake: stamped once the invite returns (after commit).
        const plain = yield* as(s.admin)(ws.invite("plain@example.com", "member"));
        expect((yield* row(plain.id)).workflowStartedAt).toBe("2026-11-23T09:00:00.000Z");

        const started = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
        const gates = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
        const gated = yield* makeWorkspaces.pipe(
          Effect.provideService(InvitationDelivery, {
            start: (send) =>
              Effect.andThen(
                Deferred.succeed(started[send.epoch] as Deferred.Deferred<void>, undefined),
                Deferred.await(gates[send.epoch] as Deferred.Deferred<void>),
              ),
          }),
        );
        const invite = yield* Effect.forkChild(
          as(s.admin)(gated.invite("late@example.com", "member")),
        );
        yield* Deferred.await(started[0] as Deferred.Deferred<void>);
        const pending = (yield* as(s.admin)(ws.invitations)).find(
          (i) => i.email === "late@example.com",
        );
        if (pending === undefined) return yield* Effect.die("no invitation");
        expect((yield* row(pending.id)).workflowStartedAt).toBeNull();
        yield* TestClock.adjust("2 minutes");
        const resend = yield* Effect.forkChild(as(s.admin)(gated.resendInvitation(pending.id)));
        yield* Deferred.await(started[1] as Deferred.Deferred<void>);
        expect((yield* row(pending.id)).sendEpoch).toBe(1);
        // The epoch-0 start completes late: it must not stamp epoch 1.
        yield* Deferred.succeed(gates[0] as Deferred.Deferred<void>, undefined);
        yield* Fiber.join(invite);
        expect((yield* row(pending.id)).workflowStartedAt).toBeNull();
        yield* TestClock.adjust("1 minute");
        yield* Deferred.succeed(gates[1] as Deferred.Deferred<void>, undefined);
        yield* Fiber.join(resend);
        expect((yield* row(pending.id)).workflowStartedAt).toBe("2026-11-23T09:03:00.000Z");
      }),
    ));
});

describe("W7: the image signature is checked as soon as the header arrives", () => {
  const badHeader = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00]);
  for (const [label, rest] of [
    ["a stalled stream", Stream.never],
    ["a stream that would die", Stream.die("pulled past the header")],
  ] as const) {
    test(`a bad header followed by ${label} is rejected`, () =>
      scenario(
        Effect.gen(function* () {
          const ws = yield* W;
          const s = yield* seed();
          const bytes = Stream.concat(Stream.succeed(badHeader), rest);
          expect(
            yield* failure(
              as(s.admin)(ws.setBrandingImage("logo", { contentType: "image/png", bytes })),
            ),
          ).toEqual(
            new Invalid({ issues: [{ path: ["file"], code: "branding.image_type_rejected" }] }),
          );
        }),
      ));
  }

  test("a header split across chunks is checked once all 8 bytes arrived", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const png = new Uint8Array(64);
        png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const bytes = Stream.fromIterable([png.slice(0, 3), png.slice(3, 9), png.slice(9)]);
        const ref = yield* as(s.admin)(
          ws.setBrandingImage("logo", { contentType: "image/png", bytes }),
        );
        expect(ref).toMatchObject({ contentType: "image/png", bytes: 64 });
      }),
    ));
});

describe("round 2: stale callers, closed precedence, safe counters, owned chunks", () => {
  test("R1c: a keyed invite replay is refused once the stored role no longer allows it", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const adminInvite = as(s.owner)(ws.invite("boss@example.com", "admin", key("a1")));
        yield* adminInvite;
        yield* as(s.owner)(ws.transferOwnership(ADMIN));
        // The former owner is now admin: may not manage admins, even on a replay.
        expect(yield* failure(adminInvite)).toEqual(forbidden("member.manageAdmins"));
        // Still an admin: a member invitation (fresh key) is allowed.
        yield* as(s.owner)(ws.invite("m@example.com", "member", key("m1")));
      }),
    ));

  test("R1: a demoted admin's in-flight settings writes are Forbidden", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const bank = as(s.admin)(
          ws.saveBankAccount({ iban: IBAN_CZ, currency: "CZK" } as never, key("b1")),
        );
        yield* bank;
        yield* as(s.owner)(ws.setRole(ADMIN, "member"));
        const revision = view(yield* as(s.owner)(ws.current)).revision as number;
        const settings = forbidden("workspace.settings");
        expect(yield* failure(bank)).toEqual(settings);
        expect(
          yield* failure(
            as(s.admin)(ws.saveBankAccount({ iban: IBAN_DE, currency: "EUR" } as never)),
          ),
        ).toEqual(settings);
        expect(
          yield* failure(
            as(s.admin)(ws.configureSeries({ kind: "invoice", name: "FV", pattern: "FV-NNN" })),
          ),
        ).toEqual(settings);
        expect(
          yield* failure(as(s.admin)(ws.updateSettings({ dueDays: 30 } as never, revision))),
        ).toEqual(settings);
      }),
    ));

  test("C6: a former owner who re-entered can retry the completed transfer", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        yield* as(s.owner)(ws.transferOwnership(ADMIN));
        const reentered = yield* as(accountOf(s.owner.userId))(
          ws.enter(s.workspaceId, { scopes: "all", channel: "web" } as never),
        );
        expect(reentered.role).toBe("admin");
        yield* as(reentered)(ws.transferOwnership(ADMIN));
        expect(yield* failure(as(reentered)(ws.transferOwnership(MEMBER)))).toEqual(
          forbidden("workspace.transferOwnership"),
        );
        expect(yield* failure(as(s.member)(ws.transferOwnership(MEMBER)))).toEqual(
          forbidden("workspace.transferOwnership"),
        );
        const transfers = (yield* history(s.workspaceId)).filter(
          (e) => e.action === "workspace.transferOwnership",
        );
        expect(transfers.length).toBe(1);
      }),
    ));

  test("W5: a closed Workspace is Forbidden before field validation", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        yield* as(s.owner)(ws.close("Acme s.r.o."));
        expect(
          yield* failure(
            as(s.admin)(
              ws.configureSeries({ kind: "invoice", name: "FV", pattern: "FV-NNN", nextNumber: 0 }),
            ),
          ),
        ).toEqual(forbidden("workspace.settings"));
        expect(
          yield* failure(
            as(s.admin)(ws.saveBankAccount({ iban: "nope", currency: "CZK" } as never)),
          ),
        ).toEqual(forbidden("workspace.settings"));
        expect(yield* failure(as(s.admin)(ws.invite("not-an-email", "member")))).toEqual(
          forbidden("member.invite"),
        );
      }),
    ));

  test("W3: an unsafe integer counter is Invalid", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const input = {
          kind: "invoice" as const,
          name: "FV",
          pattern: "FV-NNN",
          nextNumber: 2 ** 53,
        };
        const malformed = new Invalid({
          issues: [{ path: ["nextNumber"], code: "request.malformed" }],
        });
        expect(yield* failure(as(s.admin)(ws.configureSeries(input)))).toEqual(malformed);
        const port = yield* WorkspaceSeries;
        const store = yield* CoreStore;
        expect(
          yield* failure(
            store.transaction(port.configure(s.workspaceId, input, "2026-11-23" as IsoDate)),
          ),
        ).toEqual(malformed);
      }),
    ));

  test("W7: a bad JPEG header is rejected after 3 bytes", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const bytes = Stream.concat(
          Stream.succeed(new Uint8Array([0xff, 0xd8, 0x00])),
          Stream.never,
        );
        expect(
          yield* failure(
            as(s.admin)(ws.setBrandingImage("logo", { contentType: "image/jpeg", bytes })),
          ),
        ).toEqual(
          new Invalid({ issues: [{ path: ["file"], code: "branding.image_type_rejected" }] }),
        );
      }),
    ));

  test("W7: a producer that reuses its Buffer does not change the stored bytes", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        const first = Buffer.alloc(16);
        first.set(header);
        const expected = new Uint8Array(32);
        expected.set(first, 0);
        expected.fill(0xaa, 16);
        // Each chunk is produced lazily when pulled, into the same Buffer.
        const buffer = Buffer.alloc(16);
        const bytes = Stream.concat(
          Stream.fromEffect(
            Effect.sync(() => {
              buffer.set(first);
              return buffer;
            }),
          ),
          Stream.fromEffect(Effect.sync(() => buffer.fill(0xaa))),
        );
        const ref = yield* as(s.admin)(
          ws.setBrandingImage("logo", { contentType: "image/png", bytes }),
        );
        expect(ref).toMatchObject({ bytes: 32, sha256: yield* sha256Hex(expected) });
      }),
    ));
});
