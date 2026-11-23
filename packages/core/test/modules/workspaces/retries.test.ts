/** Retry coverage (C6), replay safety (C3/R1a) and store-outage mapping of the Workspaces module. */
import { describe, expect, test } from "bun:test";
import type { BankAccountId, RequestKey } from "@kvitbit/domain/contract";
import { Conflict, Forbidden, Invalid, Unavailable } from "@kvitbit/domain/contract";
import { Effect, Stream } from "effect";
import {
  BankAccountReferencesFake,
  makeWorkspaces,
  WorkspacesRepo,
} from "../../../src/modules/workspaces";
import { StoreUnavailable } from "../../../src/store/CoreStore";
import { accountOf, as, failure, history, join, MEMBER, OWNER, scenario, seed, W } from "./harness";

// biome-ignore lint/suspicious/noExplicitAny: domain views are open structs; tests read their concrete fields
const view = <A>(v: A) => v as unknown as Record<string, any>;
const key = (k: string) => ({ requestKey: k as RequestKey });
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
        expect(
          yield* failure(
            as(accountOf(OWNER))(ws.create({ name: "X", slug: "Bad Slug" } as never, key("c1"))),
          ),
        ).toEqual(new Invalid({ issues: [{ path: ["slug"], code: "workspace.slug_invalid" }] }));
      }),
    ));

  test("a replay reflects the creator's current membership (R1a)", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const create = () =>
          as(accountOf(OWNER))(ws.create({ name: "Second" } as never, key("c2")));
        const owner = yield* create();
        yield* join(owner, MEMBER, "member");
        yield* as(owner)(ws.transferOwnership(MEMBER));
        expect((yield* create()).role).toBe("admin");
        const formerOwner = { ...owner, role: "admin" as const };
        yield* as(formerOwner)(ws.leave);
        expect(yield* failure(create())).toEqual(new Forbidden({ action: "workspace.enter" }));
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
        yield* as(s.admin)(ws.saveBankAccount({ iban: IBAN, currency: "CZK" } as never));
        const account = view(
          yield* as(s.admin)(
            ws.saveBankAccount({ iban: IBAN, currency: "CZK", name: "Druhý" } as never),
          ),
        );
        yield* as(s.admin)(ws.removeBankAccount(account.id));
        yield* as(s.admin)(ws.removeBankAccount(account.id));
        yield* as(s.owner)(ws.close("Acme s.r.o."));
        yield* as(s.owner)(ws.close("Acme s.r.o."));
        const actions = (yield* history(s.workspaceId)).map((e) => e.action);
        expect(actions.filter((a) => a === "workspace.close").length).toBe(1);
        expect(actions.filter((a) => a === "workspace.bankAccount.remove").length).toBe(1);
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
        const revision = view(yield* as(s.admin)(ws.current)).revision;
        expect(yield* set()).toEqual(first);
        expect(view(yield* as(s.admin)(ws.current)).revision).toBe(revision);
      }),
    ));

  test("saveBankAccount (existing) is a full replacement; an identical repeat changes nothing", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const save = (input: object) =>
          Effect.map(as(s.admin)(ws.saveBankAccount(input as never)), view);
        const a = yield* save({ iban: IBAN, currency: "CZK", name: "Hlavní", bic: "GIBACZPX" });
        const same = { id: a.id, iban: IBAN, currency: "CZK", name: "Hlavní", bic: "GIBACZPX" };
        expect(yield* save(same)).toEqual(a);
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
        const a = view(
          yield* as(s.admin)(ws.saveBankAccount({ iban: IBAN, currency: "CZK" } as never)),
        );
        yield* refs.set(s.workspaceId, a.id as BankAccountId, 1);
        expect(
          yield* failure(
            as(s.admin)(ws.saveBankAccount({ id: a.id, iban: IBAN, currency: "EUR" } as never)),
          ),
        ).toEqual(new Conflict({ reason: "illegal_transition", detail: "bank_account.in_use" }));
        yield* refs.set(s.workspaceId, a.id as BankAccountId, 0);
        const moved = view(
          yield* as(s.admin)(
            ws.saveBankAccount({ id: a.id, iban: IBAN, currency: "EUR" } as never),
          ),
        );
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
        const revision = view(yield* as(s.admin)(ws.current)).revision;
        const again = yield* as(s.admin)(
          ws.configureSeries({ id: series.id, kind: "invoice", name: "EX", pattern: "EX-NNN" }),
        );
        expect(again).toEqual(series);
        expect(view(yield* as(s.admin)(ws.current)).revision).toBe(revision);
      }),
    ));
});

describe("theme validation", () => {
  test("seed, Material Theme Builder JSON shape and size", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const update = (theme: unknown) =>
          as(s.admin)(ws.updateSettings({ branding: { theme } } as never, 1));
        const code = (theme: unknown) =>
          Effect.map(failure(update(theme)), (e) => (e as Invalid).issues[0]?.code);
        expect(yield* code({ _tag: "Seed", seed: "blue" })).toBe("theme.seed_invalid");
        expect(yield* code({ _tag: "MaterialThemeBuilder", json: "nope" })).toBe(
          "theme.json_invalid",
        );
        expect(yield* code({ _tag: "MaterialThemeBuilder", json: { x: "y".repeat(70_000) } })).toBe(
          "theme.too_large",
        );
        expect(yield* code({ _tag: "Preset", id: "neon" })).toBe("request.malformed");
        const next = view(yield* update({ _tag: "Preset", id: "forest" }));
        expect(next.branding.theme).toEqual({ _tag: "Preset", id: "forest" });
      }),
    ));
});

describe("store outages", () => {
  test("StoreUnavailable from the repository is Unavailable{database}, not a defect", () =>
    scenario(
      Effect.gen(function* () {
        const s = yield* seed();
        const repo = yield* WorkspacesRepo;
        const broken = { ...repo, lockWorkspace: () => Effect.fail(new StoreUnavailable({})) };
        const ws = yield* Effect.provideService(makeWorkspaces, WorkspacesRepo, broken);
        expect(yield* failure(as(s.owner)(ws.close("Acme s.r.o.")))).toEqual(
          new Unavailable({ dependency: "database" }),
        );
        expect(yield* failure(as(s.admin)(ws.invite("x@example.cz", "member")))).toEqual(
          new Unavailable({ dependency: "database" }),
        );
      }),
    ));
});
