/**
 * Regressions for role-review round 1 on the Workspaces module (one block per finding). The
 * memory store serializes top-level transactions, so races are simulated (a stale caller, a
 * repository that reports a taken slug as free, gated deliveries); a true PostgreSQL race test
 * belongs to the adapters.
 */

import { describe, expect, test } from "bun:test";
import type { InvitationId } from "@kvitbit/domain/contract";
import {
  BankAccountId,
  BankAccountInput,
  Conflict,
  Forbidden,
  Invalid,
  IsoDate,
  IssuingEntityPatch,
  NotFound,
  RequestKey,
  Unavailable,
  WorkspaceSlug,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  BankAccountReferencesFake,
  InvitationDelivery,
  makeWorkspaces,
  WorkspaceSeries,
  WorkspaceSnapshots,
  WorkspacesRepo,
} from "../../../src/modules/workspaces";
import type { BankAccountFields } from "../../../src/modules/workspaces/model";
import { RegistryLookup } from "../../../src/modules/workspaces/registry";
import { sha256Hex } from "../../../src/shared/hash";
import { CoreStore } from "../../../src/store/CoreStore";
import { FakeCompanyRegistry } from "../../../src/testing";
import {
  ACCOUNTANT,
  ADMIN,
  accountOf,
  as,
  bankAccountView,
  failure,
  history,
  historyOf,
  ICO,
  join,
  MEMBER,
  OUTSIDER,
  scenario,
  seed,
  W,
  workspaceView,
} from "./harness";

const IBAN_CZ = "CZ65 0800 0000 1920 0014 5399";
const IBAN_CZ_2 = "CZ69 0710 1781 2400 0000 4159";
const IBAN_DE = "DE89370400440532013000";
const key = (k: string) => ({ requestKey: RequestKey.make(k) });
const forbidden = (action: Forbidden["action"]) => Forbidden.make({ action });

describe("R1/R1c: the actor's stored role decides under the workspace lock", () => {
  test("a former owner's in-flight close and transfer are Forbidden", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        yield* as(s.owner)(ws.transferOwnership(ADMIN));
        const closeFailure = yield* ws.close("Acme s.r.o.").pipe(as(s.owner), failure);
        // s.owner still says role "owner": a request admitted before the transfer.
        expect(closeFailure).toEqual(forbidden("workspace.close"));
        const result = yield* as(s.admin)(ws.current);
        const current = yield* workspaceView(result);
        expect(current.closed).toBe(false);
      }),
    ));

  test("a demoted admin's in-flight setRole, invite, resend and revoke are Forbidden", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const pending = yield* as(s.admin)(ws.invite("new@example.com", "member"));
        yield* as(s.owner)(ws.setRole(ADMIN, "member"));
        const setRoleFailure = yield* ws.setRole(MEMBER, null).pipe(as(s.admin), failure);
        expect(setRoleFailure).toEqual(forbidden("member.setRole"));
        const inviteFailure = yield* ws
          .invite("other@example.com", "member")
          .pipe(as(s.admin), failure);
        expect(inviteFailure).toEqual(forbidden("member.invite"));
        const revokeInvitationFailure = yield* ws
          .revokeInvitation(pending.id)
          .pipe(as(s.admin), failure);
        expect(revokeInvitationFailure).toEqual(forbidden("member.invite"));
        yield* TestClock.adjust("2 minutes");
        const resendInvitationFailure = yield* ws
          .resendInvitation(pending.id)
          .pipe(as(s.admin), failure);
        expect(resendInvitationFailure).toEqual(forbidden("member.invite"));
        const members = yield* as(s.owner)(ws.members);
        const roles = EffectArray.map(members, (m) => m.role);
        expect(roles).toContain("member");
      }),
    ));

  test("a removed admin's in-flight invite is Forbidden", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        yield* as(s.owner)(ws.setRole(ADMIN, null));
        const inviteFailure = yield* ws
          .invite("x@example.com", "member")
          .pipe(as(s.admin), failure);
        expect(inviteFailure).toEqual(forbidden("member.invite"));
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
        const before = (yield* snapshots.get(s.workspaceId, IsoDate.make("2026-11-22"))).taxRegime;
        expect(before).toBe("non_vat_payer");
        const change = { taxRegime: { regime: "vat_payer", effectiveFrom: "2026-11-23" } };
        const updateIssuingEntityResult = yield* as(s.owner)(
          ws.updateIssuingEntity(IssuingEntityPatch.make(change), 1),
        );
        const next = yield* workspaceView(updateIssuingEntityResult);
        expect(next.taxRegime).toBe("vat_payer");
        expect(next.taxRegimeHistory).toEqual([
          { regime: "non_vat_payer", effectiveFrom: IsoDate.make("2026-11-23") },
          { regime: "vat_payer", effectiveFrom: IsoDate.make("2026-11-23") },
        ]);
        expect((yield* snapshots.get(s.workspaceId, IsoDate.make("2026-11-22"))).taxRegime).toBe(
          "non_vat_payer",
        );
        // A second change on the same date replaces the non-first period only.
        const back = { taxRegime: { regime: "non_vat_payer", effectiveFrom: "2026-11-23" } };
        const updateIssuingEntityResult2 = yield* as(s.owner)(
          ws.updateIssuingEntity(IssuingEntityPatch.make(back), next.revision),
        );
        const again = yield* workspaceView(updateIssuingEntityResult2);
        expect(again.taxRegimeHistory).toEqual([
          { regime: "non_vat_payer", effectiveFrom: IsoDate.make("2026-11-23") },
          { regime: "non_vat_payer", effectiveFrom: IsoDate.make("2026-11-23") },
        ]);
      }),
    ));
});

describe("bank accounts", () => {
  const setup = Effect.gen(function* () {
    const ws = yield* W;
    const s = yield* seed();
    const save = (input: (typeof BankAccountFields)["Encoded"]) =>
      Effect.flatMap(
        as(s.admin)(ws.saveBankAccount(BankAccountInput.make(input))),
        bankAccountView,
      );
    const remove = (id: BankAccountId, replacement?: BankAccountId) =>
      as(s.admin)(ws.removeBankAccount(id, replacement));
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
        const getResult = yield* refs.get(s.workspaceId, a.id);
        expect(getResult).toBe(2);
        const getResult2 = yield* refs.get(s.workspaceId, b.id);
        expect(getResult2).toBe(0);
        const result = yield* as(s.admin)(ws.current);
        const current = yield* workspaceView(result);
        const ids = EffectArray.map(current.bankAccounts, (account) => account.id);
        expect(ids).toEqual([a.id, b.id]);
      }),
    ));

  test("4.1: the sole account of a currency is its default and needs a replacement", () =>
    scenario(
      Effect.gen(function* () {
        const { save, remove } = yield* setup;
        const a = yield* save({ iban: IBAN_CZ, currency: "CZK" });
        const failureResult = yield* failure(remove(a.id));
        expect(failureResult).toEqual(
          Conflict.make({ reason: "illegal_transition", detail: "bank_account.in_use" }),
        );
      }),
    ));

  test("R2: a foreign or unknown replacement is NotFound; archived or self is Invalid", () =>
    scenario(
      Effect.gen(function* () {
        const { ws, save, remove } = yield* setup;
        const other = yield* as(accountOf(OUTSIDER))(ws.create({ name: "Jiná s.r.o." }));
        const saveBankAccountResult = yield* as(other)(
          ws.saveBankAccount(BankAccountInput.make({ iban: IBAN_CZ, currency: "CZK" })),
        );
        const foreign = yield* bankAccountView(saveBankAccountResult);
        const a = yield* save({ iban: IBAN_CZ, currency: "CZK" });
        const b = yield* save({ iban: IBAN_CZ_2, currency: "CZK" });
        const c = yield* save({ iban: IBAN_CZ_2, currency: "CZK", name: "Třetí" });
        const eur = yield* save({ iban: IBAN_DE, currency: "EUR" });
        const failureResult = yield* failure(remove(a.id, foreign.id));
        expect(failureResult).toEqual(NotFound.make({ entity: "BankAccount", id: foreign.id }));
        const unknown = BankAccountId.make("unknown", { disableChecks: true });
        const failureResult2 = yield* failure(remove(a.id, unknown));
        expect(failureResult2).toEqual(NotFound.make({ entity: "BankAccount", id: unknown }));
        const replacementInvalid = Invalid.make({
          issues: [{ path: ["replacement"], code: "bank_account.replacement_invalid" }],
        });
        const failureResult3 = yield* failure(remove(a.id, a.id));
        expect(failureResult3).toEqual(replacementInvalid);
        const failureResult4 = yield* failure(remove(a.id, eur.id));
        expect(failureResult4).toEqual(replacementInvalid);
        yield* remove(c.id);
        const failureResult5 = yield* failure(remove(a.id, c.id));
        expect(failureResult5).toEqual(replacementInvalid);
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
              BankAccountInput.make({ id: a.id, iban: IBAN_CZ, currency: "CZK", name }),
              k === undefined ? undefined : key(k),
            ),
          );
        yield* edit("První", "k1");
        yield* edit("Druhý");
        const result = yield* edit("První", "k1");
        const repeated = yield* bankAccountView(result);
        expect(repeated.name).toBe("První");
        const result2 = yield* as(s.admin)(ws.current);
        const current = yield* workspaceView(result2);
        const stored = current.bankAccounts[0];
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
        const first = yield* as(creator)(ws.create({ ico: ICO }, key("c1")));
        yield* Ref.set(registry.unavailable, true);
        // A fresh lookup cache, as on another server instance.
        const fresh = yield* makeWorkspaces.pipe(Effect.provide(Layer.fresh(RegistryLookup.layer)));
        const lookups = (yield* Ref.get(registry.lookups)).length;
        const replay = yield* as(creator)(fresh.create({ ico: ICO }, key("c1")));
        // The replay resolved before any registry call.
        expect((yield* Ref.get(registry.lookups)).length).toBe(lookups);
        expect(replay).toEqual(first);
        const createFailure = yield* fresh
          .create({ ico: ICO }, key("c2"))
          .pipe(as(creator), failure);
        expect(createFailure).toEqual(Unavailable.make({ dependency: "company_registry" }));
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
          ws.saveBankAccount(BankAccountInput.make({ iban: IBAN_CZ, currency: "CZK" }), key("b1")),
        );
        const series = as(s.admin)(
          ws.configureSeries({ kind: "invoice", name: "FV", pattern: "FV-YY-NNN" }, key("s1")),
        );
        yield* invite;
        yield* bank;
        yield* series;
        yield* as(s.owner)(ws.close("Acme s.r.o."));
        const failureResult = yield* failure(invite);
        expect(failureResult).toEqual(forbidden("member.invite"));
        const failureResult2 = yield* failure(bank);
        expect(failureResult2).toEqual(forbidden("workspace.settings"));
        const failureResult3 = yield* failure(series);
        expect(failureResult3).toEqual(forbidden("workspace.settings"));
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
        const entries = yield* historyOf({ entity: "ApiKey", id: "cred-9" })(s.workspaceId);
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
        const entries = yield* history(s.workspaceId);
        const removals = EffectArray.filter(entries, (e) => e.action === "member.remove");
        expect(removals.length).toBe(1);
        const setRoleFailure = yield* ws.setRole(OUTSIDER, null).pipe(as(s.admin), failure);
        expect(setRoleFailure).toEqual(NotFound.make({ entity: "Member", id: OUTSIDER }));
        const setRoleFailure2 = yield* ws.setRole(MEMBER, "admin").pipe(as(s.admin), failure);
        expect(setRoleFailure2).toEqual(NotFound.make({ entity: "Member", id: MEMBER }));
        // Removed members are invisible to reads and to enter.
        const ids = () =>
          Effect.map(as(s.admin)(ws.members), (all) => EffectArray.map(all, (m) => m.userId));
        const result = yield* ids();
        expect(result).not.toContain(MEMBER);
        const enterFailure = yield* ws
          .enter(s.workspaceId, { scopes: "all", channel: "web" })
          .pipe(as(accountOf(MEMBER)), failure);
        expect(enterFailure).toEqual(NotFound.make({ entity: "Workspace", id: s.workspaceId }));
        // Rejoining reactivates the same row with the invited role.
        const back = yield* join(s.admin)(MEMBER, "accountant");
        expect(back.role).toBe("accountant");
        const result2 = yield* ids();
        expect(result2).toContain(MEMBER);
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
        const entries = yield* history(s.workspaceId);
        const actions = EffectArray.map(entries, (e) => e.action);
        expect(EffectArray.filter(actions, (a) => a === "member.leave").length).toBe(1);
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
        const entries = yield* history(s.workspaceId);
        const transfers = EffectArray.filter(
          entries,
          (e) => e.action === "workspace.transferOwnership",
        );
        expect(transfers.length).toBe(1);
        const transferOwnershipFailure = yield* ws
          .transferOwnership(MEMBER)
          .pipe(as(s.owner), failure);
        expect(transferOwnershipFailure).toEqual(forbidden("workspace.transferOwnership"));
        // Once the new owner transfers on, the old retry is no longer recognized.
        yield* as({ ...s.admin, role: "owner" })(ws.transferOwnership(MEMBER));
        const transferOwnershipFailure2 = yield* ws
          .transferOwnership(ADMIN)
          .pipe(as(s.owner), failure);
        expect(transferOwnershipFailure2).toEqual(forbidden("workspace.transferOwnership"));
      }),
    ));
});

describe("C6/W3: configureSeries", () => {
  test("a keyed replacement of an existing series applies to the current state", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const series = yield* as(s.admin)(ws.listSeries);
        const invoice = Option.getOrUndefined(
          EffectArray.findFirst(series, (x) => x.kind === "invoice"),
        );
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
        const updatedSeries = yield* as(s.admin)(ws.listSeries);
        const stored = Option.getOrUndefined(
          EffectArray.findFirst(updatedSeries, (x) => x.id === invoice.id),
        );
        expect(stored?.name).toBe("První");
      }),
    ));

  test("nextNumber must be an integer >= 1, through the service and the memory port", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const malformed = Invalid.make({
          issues: [{ path: ["nextNumber"], code: "request.malformed" }],
        });
        for (const nextNumber of [1.5, 0, -3]) {
          const configureSeriesFailure = yield* ws
            .configureSeries({ kind: "invoice", name: "FV", pattern: "FV-NNN", nextNumber })
            .pipe(as(s.admin), failure);
          expect(configureSeriesFailure).toEqual(malformed);
        }
        const port = yield* WorkspaceSeries;
        const store = yield* CoreStore;
        const transactionFailure = yield* failure(
          store.transaction(
            port.configure(
              s.workspaceId,
              { kind: "invoice", name: "FV", pattern: "FV-NNN", nextNumber: 2.5 },
              IsoDate.make("2026-11-23"),
            ),
          ),
        );
        expect(transactionFailure).toEqual(malformed);
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
        const first = yield* as(accountOf(OUTSIDER))(ws.create({ name: "Acme" }));
        const result = yield* as(first)(ws.current);
        const taken = result.slug;
        // A repository whose slug read misses the committed row, as a concurrent create would.
        const stale = yield* makeWorkspaces.pipe(
          Effect.provideService(WorkspacesRepo, {
            ...repo,
            findWorkspaceBySlug: (slug) =>
              slug === taken ? Effect.succeedNone : repo.findWorkspaceBySlug(slug),
          }),
        );
        const second = yield* as(accountOf(ADMIN))(stale.create({ name: "Acme" }));
        const result2 = yield* as(second)(ws.current);
        expect(result2.slug).toBe(WorkspaceSlug.make(`${taken}-2`));
        const createFailure = yield* stale
          .create({ name: "Acme", slug: taken })
          .pipe(as(accountOf(MEMBER)), failure);
        expect(createFailure).toEqual(
          Invalid.make({ issues: [{ path: ["slug"], code: "workspace.slug_taken" }] }),
        );
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

        const started = [yield* Deferred.make<void>(), yield* Deferred.make<void>()] as const;
        const gates = [yield* Deferred.make<void>(), yield* Deferred.make<void>()] as const;
        const gated = yield* makeWorkspaces.pipe(
          Effect.provideService(InvitationDelivery, {
            start: (send) => {
              const signal = started[send.epoch];
              const gate = gates[send.epoch];
              if (signal === undefined || gate === undefined) {
                return Effect.die(new Error(`Unexpected invitation epoch ${send.epoch}`));
              }
              return Effect.andThen(Deferred.succeed(signal, undefined), Deferred.await(gate));
            },
          }),
        );
        const invite = yield* gated
          .invite("late@example.com", "member")
          .pipe(as(s.admin), Effect.forkChild);
        yield* Deferred.await(started[0]);
        const invitations = yield* as(s.admin)(ws.invitations);
        const pending = Option.getOrUndefined(
          EffectArray.findFirst(invitations, (i) => i.email === "late@example.com"),
        );
        if (pending === undefined) return yield* Effect.die("no invitation");
        expect((yield* row(pending.id)).workflowStartedAt).toBeNull();
        yield* TestClock.adjust("2 minutes");
        const resend = yield* gated
          .resendInvitation(pending.id)
          .pipe(as(s.admin), Effect.forkChild);
        yield* Deferred.await(started[1]);
        expect((yield* row(pending.id)).sendEpoch).toBe(1);
        // The epoch-0 start completes late: it must not stamp epoch 1.
        yield* Deferred.succeed(gates[0], undefined);
        yield* Fiber.join(invite);
        expect((yield* row(pending.id)).workflowStartedAt).toBeNull();
        yield* TestClock.adjust("1 minute");
        yield* Deferred.succeed(gates[1], undefined);
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
          const setBrandingImageFailure = yield* ws
            .setBrandingImage("logo", { contentType: "image/png", bytes })
            .pipe(as(s.admin), failure);
          expect(setBrandingImageFailure).toEqual(
            Invalid.make({ issues: [{ path: ["file"], code: "branding.image_type_rejected" }] }),
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
        const failureResult = yield* failure(adminInvite);
        // The former owner is now admin: may not manage admins, even on a replay.
        expect(failureResult).toEqual(forbidden("member.manageAdmins"));
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
          ws.saveBankAccount(BankAccountInput.make({ iban: IBAN_CZ, currency: "CZK" }), key("b1")),
        );
        yield* bank;
        yield* as(s.owner)(ws.setRole(ADMIN, "member"));
        const result = yield* as(s.owner)(ws.current);
        const revision = result.revision;
        const settings = forbidden("workspace.settings");
        const failureResult = yield* failure(bank);
        expect(failureResult).toEqual(settings);
        const saveBankAccountFailure = yield* ws
          .saveBankAccount(BankAccountInput.make({ iban: IBAN_DE, currency: "EUR" }))
          .pipe(as(s.admin), failure);
        expect(saveBankAccountFailure).toEqual(settings);
        const configureSeriesFailure = yield* ws
          .configureSeries({ kind: "invoice", name: "FV", pattern: "FV-NNN" })
          .pipe(as(s.admin), failure);
        expect(configureSeriesFailure).toEqual(settings);
        const updateSettingsFailure = yield* ws
          .updateSettings({ dueDays: 30 }, revision)
          .pipe(as(s.admin), failure);
        expect(updateSettingsFailure).toEqual(settings);
      }),
    ));

  test("C6: a former owner who re-entered can retry the completed transfer", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        yield* as(s.owner)(ws.transferOwnership(ADMIN));
        const reentered = yield* as(accountOf(s.owner.userId))(
          ws.enter(s.workspaceId, { scopes: "all", channel: "web" }),
        );
        expect(reentered.role).toBe("admin");
        yield* as(reentered)(ws.transferOwnership(ADMIN));
        const transferOwnershipFailure = yield* ws
          .transferOwnership(MEMBER)
          .pipe(as(reentered), failure);
        expect(transferOwnershipFailure).toEqual(forbidden("workspace.transferOwnership"));
        const transferOwnershipFailure2 = yield* ws
          .transferOwnership(MEMBER)
          .pipe(as(s.member), failure);
        expect(transferOwnershipFailure2).toEqual(forbidden("workspace.transferOwnership"));
        const entries = yield* history(s.workspaceId);
        const transfers = EffectArray.filter(
          entries,
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
        const configureSeriesFailure = yield* ws
          .configureSeries({ kind: "invoice", name: "FV", pattern: "FV-NNN", nextNumber: 0 })
          .pipe(as(s.admin), failure);
        expect(configureSeriesFailure).toEqual(forbidden("workspace.settings"));
        const saveBankAccountFailure = yield* ws
          .saveBankAccount(BankAccountInput.make({ iban: "nope", currency: "CZK" }))
          .pipe(as(s.admin), failure);
        expect(saveBankAccountFailure).toEqual(forbidden("workspace.settings"));
        const inviteFailure = yield* ws.invite("not-an-email", "member").pipe(as(s.admin), failure);
        expect(inviteFailure).toEqual(forbidden("member.invite"));
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
        const malformed = Invalid.make({
          issues: [{ path: ["nextNumber"], code: "request.malformed" }],
        });
        const configureSeriesFailure = yield* ws.configureSeries(input).pipe(as(s.admin), failure);
        expect(configureSeriesFailure).toEqual(malformed);
        const port = yield* WorkspaceSeries;
        const store = yield* CoreStore;
        const transactionFailure = yield* failure(
          store.transaction(port.configure(s.workspaceId, input, IsoDate.make("2026-11-23"))),
        );
        expect(transactionFailure).toEqual(malformed);
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
        const setBrandingImageFailure = yield* ws
          .setBrandingImage("logo", { contentType: "image/jpeg", bytes })
          .pipe(as(s.admin), failure);
        expect(setBrandingImageFailure).toEqual(
          Invalid.make({ issues: [{ path: ["file"], code: "branding.image_type_rejected" }] }),
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

describe("round 3: transfer needs the caller's own role; access before revision", () => {
  test("a request that entered as admin cannot transfer after being promoted to owner", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        yield* as(s.owner)(ws.transferOwnership(ADMIN));
        const transferOwnershipFailure = yield* ws
          .transferOwnership(MEMBER)
          .pipe(as(s.admin), failure);
        // s.admin entered as admin; ADMIN is the stored owner now.
        expect(transferOwnershipFailure).toEqual(forbidden("workspace.transferOwnership"));
        const members = yield* as(s.member)(ws.members);
        const roles = new Map(EffectArray.map(members, (m) => [m.userId, m.role]));
        expect(roles.get(ADMIN)).toBe("owner");
        expect(roles.get(MEMBER)).toBe("member");
        const entries = yield* history(s.workspaceId);
        const transfers = EffectArray.filter(
          entries,
          (e) => e.action === "workspace.transferOwnership",
        );
        expect(transfers.length).toBe(1);
      }),
    ));

  test("a stale revision yields Forbidden after removal or closure, Conflict otherwise", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const settings = { dueDays: 30 };
        const entity = { name: "Acme a.s." };
        // An authorized caller with a stale revision still gets the C2 conflict.
        yield* as(s.owner)(ws.updateSettings({ dueDays: 21 }, 1));
        const updateSettingsFailure = yield* ws
          .updateSettings(settings, 1)
          .pipe(as(s.admin), failure);
        expect(updateSettingsFailure).toEqual(
          Conflict.make({ reason: "revision_changed", currentRevision: 2 }),
        );
        yield* as(s.owner)(ws.setRole(ADMIN, null));
        const denied = forbidden("workspace.settings");
        const updateSettingsFailure2 = yield* ws
          .updateSettings(settings, 1)
          .pipe(as(s.admin), failure);
        expect(updateSettingsFailure2).toEqual(denied);
        const updateIssuingEntityFailure = yield* ws
          .updateIssuingEntity(IssuingEntityPatch.make(entity), 1)
          .pipe(as(s.admin), failure);
        expect(updateIssuingEntityFailure).toEqual(denied);
        yield* as(s.owner)(ws.close("Acme s.r.o."));
        const updateSettingsFailure3 = yield* ws
          .updateSettings(settings, 1)
          .pipe(as(s.owner), failure);
        expect(updateSettingsFailure3).toEqual(denied);
        const updateIssuingEntityFailure2 = yield* ws
          .updateIssuingEntity(IssuingEntityPatch.make(entity), 1)
          .pipe(as(s.owner), failure);
        expect(updateIssuingEntityFailure2).toEqual(denied);
      }),
    ));
});
