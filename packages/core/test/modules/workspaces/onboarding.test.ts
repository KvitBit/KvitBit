import { describe, expect, test } from "bun:test";
import type { NewWorkspace } from "@kvitbit/domain/contract";
import {
  Conflict,
  Forbidden,
  Invalid,
  NotFound,
  RequestKey,
  Unavailable,
  WorkspaceId,
  WorkspaceSlug,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as EffectString from "effect/String";
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
  workspaceView,
} from "./harness";

const key = (k: string) => RequestKey.make(k);
const create = (input: NewWorkspace, requestKey?: string) =>
  Effect.flatMap(W, (ws) =>
    ws.create(input, requestKey === undefined ? undefined : { requestKey: key(requestKey) }),
  );

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
        const result = yield* as(caller)(ws.current);
        const current = yield* workspaceView(result);
        expect(current.slug).toBe(WorkspaceSlug.make("kavarna-skoda"));
        expect(current.revision).toBe(1);
        expect(current.taxRegime).toBe("non_vat_payer");
        expect(current.defaults).toMatchObject({ currency: "CZK", dueDays: 14, language: "cs" });
        expect(current.issuingEntity).toMatchObject({
          name: "Kavárna Škoda",
          email: "owner@example.cz",
        });
        // Default series: invoice, proforma, credit note; no Payment Tax Document for non-payers.
        const series = yield* as(caller)(ws.listSeries);
        expect(EffectArray.map(series, (s) => [s.kind, s.pattern, s.isDefault]).sort()).toEqual([
          ["credit_note", "OD-YYYY-NNNN", true],
          ["invoice", "YYYY-NNNN", true],
          ["proforma", "ZF-YYYY-NNNN", true],
        ]);
        const entries = yield* history(caller.workspaceId);
        expect(EffectArray.map(entries, (e) => e.action)).toEqual(["workspace.create"]);
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
        const series = yield* as(caller)(ws.listSeries);
        const kinds = EffectArray.map(series, (s) => s.kind).sort();
        expect(kinds).toEqual(["credit_note", "invoice", "payment_tax_document", "proforma"]);
      }),
    ));

  test("derives a unique slug, validates and rejects taken slugs (W6)", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const a = yield* as(accountOf(OWNER))(create({ name: "Acme" }));
        const b = yield* as(accountOf(OWNER))(create({ name: "Acme" }));
        const result = yield* as(a)(ws.current);
        expect(result.slug).toBe(WorkspaceSlug.make("acme"));
        const result2 = yield* as(b)(ws.current);
        expect(result2.slug).toBe(WorkspaceSlug.make("acme-2"));
        const failureResult = yield* create({
          name: "X",
          slug: WorkspaceSlug.make("Bad Slug", { disableChecks: true }),
        }).pipe(as(accountOf(OWNER)), failure);
        expect(failureResult).toEqual(
          Invalid.make({ issues: [{ path: ["slug"], code: "workspace.slug_invalid" }] }),
        );
        const failureResult2 = yield* create({ name: "X", slug: WorkspaceSlug.make("acme") }).pipe(
          as(accountOf(OWNER)),
          failure,
        );
        expect(failureResult2).toEqual(
          Invalid.make({ issues: [{ path: ["slug"], code: "workspace.slug_taken" }] }),
        );
      }),
    ));

  test("prefills the Issuing Entity from the registry when ico is given", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const caller = yield* as(accountOf(OWNER))(create({ ico: ICO }));
        const result = yield* as(caller)(ws.current);
        const current = yield* workspaceView(result);
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
        const failureResult = yield* create({ name: "X", ico: BAD_ICO }).pipe(
          as(accountOf(OWNER)),
          failure,
        );
        expect(failureResult).toEqual(
          Invalid.make({ issues: [{ path: ["ico"], code: "ico.checksum" }] }),
        );
        const registry = yield* FakeCompanyRegistry;
        yield* Ref.set(registry.unavailable, true);
        const failureResult2 = yield* create({ name: "X", ico: UNKNOWN_ICO }).pipe(
          as(accountOf(OWNER)),
          failure,
        );
        expect(failureResult2).toEqual(Unavailable.make({ dependency: "company_registry" }));
        const failureResult3 = yield* create({}).pipe(as(accountOf(OWNER)), failure);
        expect(failureResult3).toBeInstanceOf(Invalid);
      }),
    ));

  test("only an Account caller may create", () =>
    scenario(
      Effect.gen(function* () {
        const failureResult = yield* create({ name: "X" }).pipe(as(member("owner")), failure);
        expect(failureResult).toEqual(Forbidden.make({ action: "workspace.create" }));
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
        const mismatch = yield* create({ name: "Other" }, "k1").pipe(as(accountOf(OWNER)), failure);
        expect(mismatch).toEqual(Conflict.make({ reason: "idempotency_mismatch" }));
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
            slug: WorkspaceSlug.make("acme-s-r-o"),
            name: "Acme s.r.o.",
            role: "member",
            memberCount: 4,
            taxRegime: "non_vat_payer",
            closed: false,
          },
        ]);
        const result = yield* as(accountOf(OUTSIDER))(ws.listMine);
        expect(result).toEqual([]);
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
        const entries = yield* history(workspaceId);
        // enter writes no audit entry.
        expect(EffectArray.some(entries, (e) => EffectString.includes("enter")(e.action))).toBe(
          false,
        );
      }),
    ));

  test("a non-member and an unknown Workspace are both NotFound (R2)", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const { workspaceId } = yield* seed();
        const enter = (id: WorkspaceId) => ws.enter(id, { scopes: "all", channel: "web" });
        const failureResult = yield* enter(workspaceId).pipe(as(accountOf(OUTSIDER)), failure);
        expect(failureResult).toEqual(NotFound.make({ entity: "Workspace", id: workspaceId }));
        const unknown = WorkspaceId.make("01900000-0000-7000-8000-0000000fffff");
        const failureResult2 = yield* enter(unknown).pipe(as(accountOf(OWNER)), failure);
        expect(failureResult2).toEqual(NotFound.make({ entity: "Workspace", id: unknown }));
        const failureResult3 = yield* enter(workspaceId).pipe(as(member("owner")), failure);
        expect(failureResult3).toEqual(Forbidden.make({ action: "workspace.enter" }));
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
        const lookupCompanyResult = yield* as(accountant)(ws.lookupCompany(ICO));
        expect(lookupCompanyResult).toEqual(viaAccount);
        const lookupCompanyResult2 = yield* as(scoped(["contacts:read"])(accountant))(
          ws.lookupCompany(ICO),
        );
        expect(lookupCompanyResult2).toEqual(viaAccount);
        const lookupCompanyFailure = yield* ws
          .lookupCompany(ICO)
          .pipe(as(scoped(["documents:read"])(accountant)), failure);
        expect(lookupCompanyFailure).toEqual(Forbidden.make({ action: "contact.read" }));
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
        const failureResult = yield* failure(lookup(BAD_ICO));
        expect(failureResult).toEqual(
          Invalid.make({ issues: [{ path: ["ico"], code: "ico.checksum" }] }),
        );
        const getResult = yield* Ref.get(registry.lookups);
        expect(getResult).toEqual([]);
        const failureResult2 = yield* failure(lookup(UNKNOWN_ICO));
        expect(failureResult2).toEqual(NotFound.make({ entity: "Contact", id: UNKNOWN_ICO }));
        yield* Ref.set(registry.unavailable, true);
        const failureResult3 = yield* failure(lookup("45274649"));
        expect(failureResult3).toEqual(Unavailable.make({ dependency: "company_registry" }));
      }),
    ));
});
