import { describe, expect, test } from "bun:test";
import type { RequestKey, WorkspaceId } from "@kvitbit/domain/contract";
import { Conflict, Forbidden, Invalid, NotFound, Unavailable } from "@kvitbit/domain/contract";
import { Effect, Ref } from "effect";
import { FakeCompanyRegistry } from "../../../src/testing";
import { member } from "../../helpers";
import {
  accountOf,
  as,
  BAD_ICO,
  failure,
  history,
  ICO,
  MEMBER,
  OUTSIDER,
  OWNER,
  RECORD,
  scenario,
  scoped,
  seed,
  UNKNOWN_ICO,
  W,
} from "./harness";

const key = (k: string) => k as RequestKey;
const create = (input: object, requestKey?: string) =>
  Effect.flatMap(W, (ws) =>
    ws.create(
      input as never,
      requestKey === undefined ? undefined : { requestKey: key(requestKey) },
    ),
  );
// biome-ignore lint/suspicious/noExplicitAny: domain views are open structs; tests read their concrete fields
const view = <A>(v: A) => v as unknown as Record<string, any>;

describe("Workspaces.create", () => {
  test("makes the caller the owner and returns their MemberCaller", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const caller = yield* as(accountOf(OWNER))(create({ name: "Kavárna Škoda" }));
        expect(caller).toMatchObject({
          _tag: "Member",
          userId: OWNER,
          role: "owner",
          scopes: "all",
          channel: "web",
          client: null,
        });
        const current = view(yield* as(caller)(ws.current));
        expect(current.slug).toBe("kavarna-skoda");
        expect(current.revision).toBe(1);
        expect(current.taxRegime).toBe("non_vat_payer");
        expect(current.defaults).toMatchObject({ currency: "CZK", dueDays: 14, language: "cs" });
        expect(current.issuingEntity).toMatchObject({
          name: "Kavárna Škoda",
          email: "owner@example.cz",
        });
        // Default series: invoice, proforma, credit note; no Payment Tax Document for non-payers.
        const series = yield* as(caller)(ws.listSeries);
        expect(series.map((s) => [s.kind, s.pattern, s.isDefault]).sort()).toEqual([
          ["credit_note", "OD-YYYY-NNNN", true],
          ["invoice", "YYYY-NNNN", true],
          ["proforma", "ZF-YYYY-NNNN", true],
        ]);
        const entries = yield* history(caller.workspaceId);
        expect(entries.map((e) => e.action)).toEqual(["workspace.create"]);
        expect(entries[0]?.actor).toEqual({
          _tag: "Member",
          userId: OWNER,
          channel: "web",
          client: null,
        });
      }),
    ));

  test("a VAT payer also gets the Payment Tax Document series", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const caller = yield* as(accountOf(OWNER))(
          create({ name: "Plátce", taxRegime: "vat_payer" }),
        );
        const kinds = (yield* as(caller)(ws.listSeries)).map((s) => s.kind).sort();
        expect(kinds).toEqual(["credit_note", "invoice", "payment_tax_document", "proforma"]);
      }),
    ));

  test("derives a unique slug, validates and rejects taken slugs (W6)", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const a = yield* as(accountOf(OWNER))(create({ name: "Acme" }));
        const b = yield* as(accountOf(OWNER))(create({ name: "Acme" }));
        expect(view(yield* as(a)(ws.current)).slug).toBe("acme");
        expect(view(yield* as(b)(ws.current)).slug).toBe("acme-2");
        expect(
          yield* failure(as(accountOf(OWNER))(create({ name: "X", slug: "Bad Slug" }))),
        ).toEqual(new Invalid({ issues: [{ path: ["slug"], code: "workspace.slug_invalid" }] }));
        expect(yield* failure(as(accountOf(OWNER))(create({ name: "X", slug: "acme" })))).toEqual(
          new Invalid({ issues: [{ path: ["slug"], code: "workspace.slug_taken" }] }),
        );
      }),
    ));

  test("prefills the Issuing Entity from the registry when ico is given", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const caller = yield* as(accountOf(OWNER))(create({ ico: ICO }));
        const current = view(yield* as(caller)(ws.current));
        expect(current.name).toBe(RECORD.name);
        expect(current.issuingEntity).toMatchObject({
          name: RECORD.name,
          ico: ICO,
          dic: RECORD.dic,
          address: RECORD.address,
          registerEntry: RECORD.registerEntry,
        });
      }),
    ));

  test("checks the IČO checksum and surfaces a registry outage", () =>
    scenario(
      Effect.gen(function* () {
        expect(yield* failure(as(accountOf(OWNER))(create({ name: "X", ico: BAD_ICO })))).toEqual(
          new Invalid({ issues: [{ path: ["ico"], code: "ico.checksum" }] }),
        );
        const registry = yield* FakeCompanyRegistry;
        yield* Ref.set(registry.unavailable, true);
        expect(
          yield* failure(as(accountOf(OWNER))(create({ name: "X", ico: UNKNOWN_ICO }))),
        ).toEqual(new Unavailable({ dependency: "company_registry" }));
        expect(yield* failure(as(accountOf(OWNER))(create({})))).toBeInstanceOf(Invalid);
      }),
    ));

  test("only an Account caller may create", () =>
    scenario(
      Effect.gen(function* () {
        expect(yield* failure(as(member("owner"))(create({ name: "X" })))).toEqual(
          new Forbidden({ action: "workspace.create" }),
        );
      }),
    ));

  test("a repeated requestKey replays; another payload is a mismatch (C3)", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const first = yield* as(accountOf(OWNER))(create({ name: "Acme" }, "k1"));
        const again = yield* as(accountOf(OWNER))(create({ name: "Acme" }, "k1"));
        expect(again).toEqual(first);
        expect((yield* as(accountOf(OWNER))(ws.listMine)).length).toBe(1);
        // The domain tag omits Conflict on create (reported gap); the method raises it.
        expect(
          (yield* failure(as(accountOf(OWNER))(create({ name: "Other" }, "k1")))) as unknown,
        ).toEqual(new Conflict({ reason: "idempotency_mismatch" }));
      }),
    ));
});

describe("Workspaces.listMine and enter", () => {
  test("lists the caller's Workspaces with role and member count", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const { workspaceId } = yield* seed();
        const mine = yield* as(accountOf(MEMBER))(ws.listMine);
        expect(mine).toEqual([
          {
            id: workspaceId,
            slug: "acme-s-r-o" as never,
            name: "Acme s.r.o.",
            role: "member",
            memberCount: 4,
            taxRegime: "non_vat_payer",
            closed: false,
          },
        ]);
        expect(yield* as(accountOf(OUTSIDER))(ws.listMine)).toEqual([]);
      }),
    ));

  test("enter builds the MemberCaller from membership, scopes, channel and client", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const { workspaceId } = yield* seed();
        const client = { kind: "mcp" as const, id: "grant-9", name: "Claude" };
        const caller = yield* as(accountOf(MEMBER))(
          ws.enter(workspaceId, { scopes: ["documents:read"], channel: "mcp", client }),
        );
        expect(caller).toEqual({
          _tag: "Member",
          userId: MEMBER,
          workspaceId,
          role: "member",
          scopes: ["documents:read"],
          locale: "cs",
          channel: "mcp",
          client,
        });
        const session = yield* as(accountOf(MEMBER))(
          ws.enter(workspaceId, { scopes: "all", channel: "web" }),
        );
        expect(session.client).toBeNull();
        // enter writes no audit entry.
        expect((yield* history(workspaceId)).some((e) => e.action.includes("enter"))).toBe(false);
      }),
    ));

  test("a non-member and an unknown Workspace are both NotFound (R2)", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const { workspaceId } = yield* seed();
        const enter = (id: WorkspaceId) => ws.enter(id, { scopes: "all", channel: "web" });
        expect(yield* failure(as(accountOf(OUTSIDER))(enter(workspaceId)))).toEqual(
          new NotFound({ entity: "Workspace", id: workspaceId }),
        );
        const unknown = "01900000-0000-7000-8000-0000000fffff" as WorkspaceId;
        expect(yield* failure(as(accountOf(OWNER))(enter(unknown)))).toEqual(
          new NotFound({ entity: "Workspace", id: unknown }),
        );
        expect(yield* failure(as(member("owner"))(enter(workspaceId)))).toEqual(
          new Forbidden({ action: "workspace.enter" }),
        );
      }),
    ));
});

describe("Workspaces.lookupCompany", () => {
  test("Account (registry.lookup) and Member (contact.read) callers; nothing is audited", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const { workspaceId, accountant } = yield* seed();
        const viaAccount = yield* as(accountOf(OUTSIDER))(ws.lookupCompany(ICO));
        expect(viaAccount).toEqual({ ico: ICO, ...RECORD });
        expect(yield* as(accountant)(ws.lookupCompany(ICO))).toEqual(viaAccount);
        expect(yield* as(scoped(accountant, ["contacts:read"]))(ws.lookupCompany(ICO))).toEqual(
          viaAccount,
        );
        expect(
          yield* failure(as(scoped(accountant, ["documents:read"]))(ws.lookupCompany(ICO))),
        ).toEqual(new Forbidden({ action: "contact.read" }));
        const before = (yield* history(workspaceId)).length;
        yield* as(accountant)(ws.lookupCompany(ICO));
        expect((yield* history(workspaceId)).length).toBe(before);
      }),
    ));

  test("checksum first, NotFound without a record, Unavailable on outage", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const registry = yield* FakeCompanyRegistry;
        const lookup = (ico: string) => as(accountOf(OWNER))(ws.lookupCompany(ico));
        expect(yield* failure(lookup(BAD_ICO))).toEqual(
          new Invalid({ issues: [{ path: ["ico"], code: "ico.checksum" }] }),
        );
        expect(yield* Ref.get(registry.lookups)).toEqual([]);
        expect(yield* failure(lookup(UNKNOWN_ICO))).toEqual(
          new NotFound({ entity: "Contact", id: UNKNOWN_ICO }),
        );
        yield* Ref.set(registry.unavailable, true);
        expect(yield* failure(lookup("45274649"))).toEqual(
          new Unavailable({ dependency: "company_registry" }),
        );
      }),
    ));
});
