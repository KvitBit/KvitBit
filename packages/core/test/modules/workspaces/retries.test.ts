/** Retry coverage (C6), replay safety (C3/R1a) and store-outage mapping of the Workspaces module. */

import { describe, expect, test } from "bun:test";
import type { ThemeSource } from "@kvitbit/domain/contract";
import {
  BankAccountId,
  BankAccountInput,
  Conflict,
  Forbidden,
  Invalid,
  RequestKey,
  Unavailable,
  WorkspaceSlug,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as EffectString from "effect/String";
import {
  BankAccountReferencesFake,
  makeWorkspaces,
  WorkspacesRepo,
} from "../../../src/modules/workspaces";
import type { BankAccountFields } from "../../../src/modules/workspaces/model";
import { StoreUnavailable } from "../../../src/store/CoreStore";
import {
  accountOf,
  as,
  bankAccountView,
  failure,
  history,
  join,
  MEMBER,
  OWNER,
  scenario,
  seed,
  W,
} from "./harness";

const key = (k: string) => ({ requestKey: RequestKey.make(k) });
const IBAN = "CZ6508000000192000145399";
const png = () => {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
};

describe("create replay", () => {
  test("an invalid slug with a requestKey is Invalid, not a defect", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const createFailure = yield* ws
          .create(
            { name: "X", slug: WorkspaceSlug.make("Bad Slug", { disableChecks: true }) },
            key("c1"),
          )
          .pipe(as(accountOf(OWNER)), failure);
        expect(createFailure).toEqual(
          Invalid.make({ issues: [{ path: ["slug"], code: "workspace.slug_invalid" }] }),
        );
      }),
    ));

  test("a replay reflects the creator's current membership (R1a)", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const create = () => as(accountOf(OWNER))(ws.create({ name: "Second" }, key("c2")));
        const owner = yield* create();
        yield* join(owner)(MEMBER, "member");
        yield* as(owner)(ws.transferOwnership(MEMBER));
        expect((yield* create()).role).toBe("admin");
        const formerOwner = { ...owner, role: "admin" as const };
        yield* as(formerOwner)(ws.leave);
        const failureResult = yield* failure(create());
        expect(failureResult).toEqual(Forbidden.make({ action: "workspace.enter" }));
      }),
    ));
});

describe("idempotent by state (C6)", () => {
  test("close twice; removeBankAccount twice", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        // The first CZK account is the currency default (always in use); remove the second.
        yield* as(s.admin)(
          ws.saveBankAccount(BankAccountInput.make({ iban: IBAN, currency: "CZK" })),
        );
        const saveBankAccountResult = yield* as(s.admin)(
          ws.saveBankAccount(BankAccountInput.make({ iban: IBAN, currency: "CZK", name: "Druhý" })),
        );
        const account = yield* bankAccountView(saveBankAccountResult);
        yield* as(s.admin)(ws.removeBankAccount(account.id));
        yield* as(s.admin)(ws.removeBankAccount(account.id));
        yield* as(s.owner)(ws.close("Acme s.r.o."));
        yield* as(s.owner)(ws.close("Acme s.r.o."));
        const entries = yield* history(s.workspaceId);
        const actions = EffectArray.map(entries, (e) => e.action);
        expect(EffectArray.filter(actions, (a) => a === "workspace.close").length).toBe(1);
        expect(
          EffectArray.filter(actions, (a) => a === "workspace.bankAccount.remove").length,
        ).toBe(1);
      }),
    ));

  test("setBrandingImage with the same content keeps the ref and the revision", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const set = () =>
          as(s.admin)(
            ws.setBrandingImage("logo", { contentType: "image/png", bytes: Stream.succeed(png()) }),
          );
        const first = yield* set();
        const result = yield* as(s.admin)(ws.current);
        const revision = result.revision;
        const result2 = yield* set();
        expect(result2).toEqual(first);
        const result3 = yield* as(s.admin)(ws.current);
        expect(result3.revision).toBe(revision);
      }),
    ));

  test("saveBankAccount (existing) is a full replacement; an identical repeat changes nothing", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const save = (input: (typeof BankAccountFields)["Encoded"]) =>
          Effect.flatMap(
            as(s.admin)(ws.saveBankAccount(BankAccountInput.make(input))),
            bankAccountView,
          );
        const a = yield* save({ iban: IBAN, currency: "CZK", name: "Hlavní", bic: "GIBACZPX" });
        const same = { id: a.id, iban: IBAN, currency: "CZK", name: "Hlavní", bic: "GIBACZPX" };
        const result = yield* save(same);
        expect(result).toEqual(a);
        const cleared = yield* save({ id: a.id, iban: IBAN, currency: "CZK" });
        expect(cleared).toMatchObject({ name: null, bic: null, revision: a.revision + 1 });
      }),
    ));

  test("a currency change of an account in use is a Conflict", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const refs = yield* BankAccountReferencesFake;
        const s = yield* seed();
        const saveBankAccountResult = yield* as(s.admin)(
          ws.saveBankAccount(BankAccountInput.make({ iban: IBAN, currency: "CZK" })),
        );
        const a = yield* bankAccountView(saveBankAccountResult);
        yield* refs.set(s.workspaceId, BankAccountId.make(a.id), 1);
        const saveBankAccountFailure = yield* ws
          .saveBankAccount(BankAccountInput.make({ id: a.id, iban: IBAN, currency: "EUR" }))
          .pipe(as(s.admin), failure);
        expect(saveBankAccountFailure).toEqual(
          Conflict.make({ reason: "illegal_transition", detail: "bank_account.in_use" }),
        );
        yield* refs.set(s.workspaceId, BankAccountId.make(a.id), 0);
        const saveBankAccountResult2 = yield* as(s.admin)(
          ws.saveBankAccount(BankAccountInput.make({ id: a.id, iban: IBAN, currency: "EUR" })),
        );
        const moved = yield* bankAccountView(saveBankAccountResult2);
        expect(moved).toMatchObject({ currency: "EUR", isDefault: true });
      }),
    ));

  test("configureSeries with the same configuration does not move the Workspace revision", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const series = yield* as(s.admin)(
          ws.configureSeries({ kind: "invoice", name: "EX", pattern: "EX-NNN" }),
        );
        const result = yield* as(s.admin)(ws.current);
        const revision = result.revision;
        const again = yield* as(s.admin)(
          ws.configureSeries({ id: series.id, kind: "invoice", name: "EX", pattern: "EX-NNN" }),
        );
        expect(again).toEqual(series);
        const result2 = yield* as(s.admin)(ws.current);
        expect(result2.revision).toBe(revision);
      }),
    ));
});

describe("theme validation", () => {
  test("seed, Material Theme Builder JSON shape and size", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const update = (theme: ThemeSource) =>
          as(s.admin)(ws.updateSettings({ branding: { theme } }, 1));
        const issue = (error: Effect.Error<ReturnType<typeof update>>) =>
          error._tag === "Invalid" ? error.issues[0]?.code : undefined;
        const code = (theme: ThemeSource) => update(theme).pipe(failure, Effect.map(issue));
        const result = yield* code({ _tag: "Seed", seed: "blue" });
        expect(result).toBe("theme.seed_invalid");
        const result2 = yield* code({ _tag: "MaterialThemeBuilder", json: "nope" });
        expect(result2).toBe("theme.json_invalid");
        const repeatResult = yield* code({
          _tag: "MaterialThemeBuilder",
          json: { x: EffectString.repeat(70000)("y") },
        });
        expect(repeatResult).toBe("theme.too_large");
        // Send a preset outside the contract to check the service's malformed-input handling.
        const invalidPreset: ReturnType<typeof ws.updateSettings> = Reflect.apply(
          ws.updateSettings,
          ws,
          [{ branding: { theme: { _tag: "Preset", id: "neon" } } }, 1],
        );
        const presetFailure = yield* invalidPreset.pipe(as(s.admin), failure);
        const presetIssue = issue(presetFailure);
        expect(presetIssue).toBe("request.malformed");
        const result4 = yield* update({ _tag: "Preset", id: "forest" });
        expect(result4.branding.theme).toEqual({ _tag: "Preset", id: "forest" });
      }),
    ));
});

describe("store outages", () => {
  test("StoreUnavailable from the repository is Unavailable{database}, not a defect", () =>
    scenario(
      Effect.gen(function* () {
        const s = yield* seed();
        const repo = yield* WorkspacesRepo;
        const broken = { ...repo, lockWorkspace: () => Effect.fail(StoreUnavailable.make({})) };
        const ws = yield* Effect.provideService(makeWorkspaces, WorkspacesRepo, broken);
        const closeFailure = yield* ws.close("Acme s.r.o.").pipe(as(s.owner), failure);
        expect(closeFailure).toEqual(Unavailable.make({ dependency: "database" }));
        const inviteFailure = yield* ws.invite("x@example.cz", "member").pipe(as(s.admin), failure);
        expect(inviteFailure).toEqual(Unavailable.make({ dependency: "database" }));
      }),
    ));
});
