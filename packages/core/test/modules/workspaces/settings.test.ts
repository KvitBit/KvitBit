import { describe, expect, test } from "bun:test";
import type {
  BankAccountId,
  IsoDate,
  NumberingSeriesView,
  RequestKey,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Conflict, Forbidden, Invalid, NotFound, Unavailable } from "@kvitbit/domain/contract";
import { Effect, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import { BankAccountReferencesFake, WorkspaceSnapshots } from "../../../src/modules/workspaces";
import { MemoryBlobStorage } from "../../../src/testing";
import {
  accountOf,
  as,
  failure,
  history,
  join,
  OUTSIDER,
  scenario,
  scoped,
  seed,
  W,
} from "./harness";

// biome-ignore lint/suspicious/noExplicitAny: domain views are open structs; tests read their concrete fields
const view = <A>(v: A) => v as unknown as Record<string, any>;
const IBAN_CZ = "CZ65 0800 0000 1920 0014 5399";
const IBAN_CZ_2 = "CZ6907101781240000004159";
const IBAN_DE = "DE89370400440532013000";
const key = (k: string) => ({ requestKey: k as RequestKey });

const png = (size = 64) => {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
};
const chunks = (bytes: Uint8Array, parts = 3) => {
  const step = Math.ceil(bytes.length / parts);
  const out: Array<Uint8Array> = [];
  for (let i = 0; i < bytes.length; i += step) out.push(bytes.slice(i, i + step));
  return Stream.fromIterable(out);
};

describe("current, updateIssuingEntity, updateSettings", () => {
  test("every role reads; accountant and member cannot change settings", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        for (const caller of [s.owner, s.admin, s.member, s.accountant]) {
          expect(view(yield* as(caller)(ws.current)).id).toBe(s.workspaceId);
        }
        for (const caller of [s.member, s.accountant]) {
          expect(yield* failure(as(caller)(ws.updateSettings({ name: "X" } as never, 1)))).toEqual(
            new Forbidden({ action: "workspace.settings" }),
          );
        }
      }),
    ));

  test("Issuing Entity patch with revision check (C2) and audit", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const patch = { name: "Acme a.s.", ico: "27082440", email: "fakturace@acme.cz" } as never;
        const next = view(yield* as(s.admin)(ws.updateIssuingEntity(patch, 1)));
        expect(next.revision).toBe(2);
        expect(next.issuingEntity).toMatchObject({ name: "Acme a.s.", ico: "27082440" });
        expect(yield* failure(as(s.admin)(ws.updateIssuingEntity(patch, 1)))).toEqual(
          new Conflict({ reason: "revision_changed", currentRevision: 2 }),
        );
        expect(
          yield* failure(as(s.admin)(ws.updateIssuingEntity({ ico: "27082441" } as never, 2))),
        ).toEqual(new Invalid({ issues: [{ path: ["ico"], code: "ico.checksum" }] }));
        const entry = (yield* history(s.workspaceId)).at(-1);
        expect(entry?.action).toBe("workspace.issuingEntity.update");
        expect(entry?.revision).toBe(2);
        expect(entry?.changes).toContainEqual({
          path: "issuingEntity.name",
          before: "Acme s.r.o.",
          after: "Acme a.s.",
        });
      }),
    ));

  test("a Tax Regime change takes effectiveFrom; earlier tax points keep the old regime (W2)", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const snapshots = yield* WorkspaceSnapshots;
        const s = yield* seed();
        const change = { taxRegime: { regime: "vat_payer", effectiveFrom: "2027-01-01" } } as never;
        const next = view(yield* as(s.owner)(ws.updateIssuingEntity(change, 1)));
        expect(next.taxRegime).toBe("non_vat_payer"); // today is 2026-11-23
        expect(next.taxRegimeHistory).toEqual([
          { regime: "non_vat_payer", effectiveFrom: "2026-11-23" },
          { regime: "vat_payer", effectiveFrom: "2027-01-01" },
        ]);
        expect((yield* snapshots.get(s.workspaceId, "2026-12-31" as IsoDate)).taxRegime).toBe(
          "non_vat_payer",
        );
        expect((yield* snapshots.get(s.workspaceId, "2027-01-01" as IsoDate)).taxRegime).toBe(
          "vat_payer",
        );
        // Becoming a payer adds the Payment Tax Document series.
        const kinds = (yield* as(s.owner)(ws.listSeries)).map((x) => x.kind);
        expect(kinds).toContain("payment_tax_document");
        const back = {
          taxRegime: { regime: "non_vat_payer", effectiveFrom: "2026-12-01" },
        } as never;
        expect(yield* failure(as(s.owner)(ws.updateIssuingEntity(back, 2)))).toEqual(
          new Invalid({
            issues: [{ path: ["taxRegime", "effectiveFrom"], code: "request.malformed" }],
          }),
        );
      }),
    ));

  test("defaults, reminder policy and branding; invalid values are Invalid", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const patch = {
          defaults: {
            dueDays: 30,
            currency: "EUR",
            paymentMethod: "cash",
            defaultNote: "Díky",
            paymentRounding: "whole_unit",
          },
          reminderPolicy: { offsetsDays: [14, 3], proformas: true },
          branding: {
            accentColor: "#112233",
            pdfTemplate: "modern_minimal",
            footerText: "Patička",
          },
        } as never;
        const next = view(yield* as(s.admin)(ws.updateSettings(patch, 1)));
        expect(next.defaults).toMatchObject({
          dueDays: 30,
          currency: "EUR",
          paymentMethod: "cash",
          defaultNote: "Díky",
          paymentRounding: "whole_unit",
        });
        expect(next.reminderPolicy).toEqual({
          enabled: true,
          proformas: true,
          offsetsDays: [3, 14],
        });
        expect(next.branding).toMatchObject({
          accentColor: "#112233",
          pdfTemplate: "modern_minimal",
        });
        const bad = {
          branding: { accentColor: "red", footerText: "x".repeat(501) },
          defaults: { dueDays: 1000 },
          reminderPolicy: { offsetsDays: [0] },
        } as never;
        expect(yield* failure(as(s.admin)(ws.updateSettings(bad, 2)))).toEqual(
          new Invalid({
            issues: [
              { path: ["branding", "accentColor"], code: "branding.accent_invalid" },
              { path: ["branding", "footerText"], code: "request.malformed" },
              { path: ["defaults", "dueDays"], code: "request.malformed" },
              { path: ["reminderPolicy", "offsetsDays"], code: "request.malformed" },
            ],
          }),
        );
        expect(yield* failure(as(s.admin)(ws.updateSettings({} as never, 1)))).toEqual(
          new Conflict({ reason: "revision_changed", currentRevision: 2 }),
        );
      }),
    ));

  test("a slug change keeps the old slug reserved as an alias for 90 days (W6)", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        yield* as(s.owner)(ws.updateSettings({ slug: "acme-new" } as never, 1));
        const other = yield* as(accountOf(OUTSIDER))(ws.create({ name: "Other" } as never));
        expect(
          yield* failure(as(other)(ws.updateSettings({ slug: "acme-s-r-o" } as never, 1))),
        ).toEqual(new Invalid({ issues: [{ path: ["slug"], code: "workspace.slug_taken" }] }));
        expect(
          yield* failure(as(other)(ws.updateSettings({ slug: "acme-new" } as never, 1))),
        ).toEqual(new Invalid({ issues: [{ path: ["slug"], code: "workspace.slug_taken" }] }));
        // The owner can take the old slug back.
        expect(
          view(yield* as(s.owner)(ws.updateSettings({ slug: "acme-s-r-o" } as never, 2))).slug,
        ).toBe("acme-s-r-o");
        yield* TestClock.adjust("91 days");
        expect(
          view(yield* as(other)(ws.updateSettings({ slug: "acme-new" } as never, 1))).slug,
        ).toBe("acme-new");
      }),
    ));

  test("preferredSeriesByKind makes a series the default of its kind (W3)", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const fv = yield* as(s.admin)(
          ws.configureSeries({ kind: "invoice", name: "FV", pattern: "FV-YY-NNN" }),
        );
        expect(fv.isDefault).toBe(false);
        const rev = view(yield* as(s.admin)(ws.current)).revision as number;
        const next = view(
          yield* as(s.admin)(
            ws.updateSettings(
              { defaults: { preferredSeriesByKind: { invoice: fv.id } } } as never,
              rev,
            ),
          ),
        );
        expect(next.defaults.preferredSeriesByKind.invoice).toBe(fv.id);
        const invoices = (yield* as(s.admin)(ws.listSeries)).filter((x) => x.kind === "invoice");
        expect(invoices.filter((x) => x.isDefault).map((x) => x.id)).toEqual([fv.id]);
        expect(
          yield* failure(
            as(s.admin)(
              ws.updateSettings(
                { defaults: { preferredSeriesByKind: { proforma: fv.id } } } as never,
                rev + 1,
              ),
            ),
          ),
        ).toEqual(
          new Invalid({
            issues: [
              {
                path: ["defaults", "preferredSeriesByKind", "proforma"],
                code: "request.malformed",
              },
            ],
          }),
        );
      }),
    ));
});

describe("bank accounts", () => {
  test("first account per currency is the default; IBAN is validated", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const save = (input: object) => as(s.admin)(ws.saveBankAccount(input as never));
        const a = view(yield* save({ iban: IBAN_CZ, currency: "CZK", name: "Hlavní" }));
        expect(a).toMatchObject({
          iban: "CZ6508000000192000145399",
          isDefault: true,
          currency: "CZK",
        });
        const b = view(yield* save({ iban: IBAN_CZ_2, currency: "CZK" }));
        expect(b.isDefault).toBe(false);
        const c = view(yield* save({ iban: IBAN_DE, currency: "EUR", bic: "cobadeffxxx" }));
        expect(c).toMatchObject({ isDefault: true, bic: "COBADEFFXXX" });
        expect(yield* failure(save({ iban: "CZ0000000000000000000000", currency: "CZK" }))).toEqual(
          new Invalid({ issues: [{ path: ["iban"], code: "request.malformed" }] }),
        );
        const current = view(yield* as(s.member)(ws.current));
        expect(current.bankAccounts.map((x: { id: string }) => x.id)).toEqual([a.id, b.id, c.id]);
        // Explicit default switch, then an update of an unknown id is NotFound.
        expect(
          view(yield* save({ id: b.id, iban: IBAN_CZ_2, currency: "CZK", isDefault: true }))
            .isDefault,
        ).toBe(true);
        const missing = "01900000-0000-7000-8000-0000000fffff";
        expect(yield* failure(save({ id: missing, iban: IBAN_CZ, currency: "CZK" }))).toEqual(
          new NotFound({ entity: "BankAccount", id: missing }),
        );
      }),
    ));

  test("saveBankAccount replays a requestKey (C3)", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const input = { iban: IBAN_CZ, currency: "CZK" } as never;
        const first = yield* as(s.admin)(ws.saveBankAccount(input, key("b1")));
        expect(yield* as(s.admin)(ws.saveBankAccount(input, key("b1")))).toEqual(first);
        expect(view(yield* as(s.admin)(ws.current)).bankAccounts.length).toBe(1);
      }),
    ));

  test("removing an account in use needs a same-currency replacement", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const refs = yield* BankAccountReferencesFake;
        const s = yield* seed();
        const save = (input: object) =>
          Effect.map(as(s.admin)(ws.saveBankAccount(input as never)), view);
        const a = yield* save({ iban: IBAN_CZ, currency: "CZK" });
        const b = yield* save({ iban: IBAN_CZ_2, currency: "CZK" });
        const eur = yield* save({ iban: IBAN_DE, currency: "EUR" });
        const remove = (id: string, replacement?: string) =>
          as(s.admin)(
            ws.removeBankAccount(id as BankAccountId, replacement as BankAccountId | undefined),
          );
        // a is the CZK default and b exists: in use.
        expect(yield* failure(remove(a.id))).toEqual(
          new Conflict({ reason: "illegal_transition", detail: "bank_account.in_use" }),
        );
        expect(yield* failure(remove(a.id, eur.id))).toEqual(
          new Invalid({
            issues: [{ path: ["replacement"], code: "bank_account.replacement_invalid" }],
          }),
        );
        yield* Ref.set(refs.uses, new Map([[a.id as BankAccountId, 2]]));
        yield* remove(a.id, b.id);
        expect((yield* Ref.get(refs.uses)).get(b.id as BankAccountId)).toBe(2);
        const accounts = view(yield* as(s.admin)(ws.current)).bankAccounts;
        expect(
          accounts.map((x: { id: string; isDefault: boolean }) => [x.id, x.isDefault]),
        ).toEqual([
          [b.id, true],
          [eur.id, true],
        ]);
        // The only EUR account, unused: removable without a replacement.
        yield* remove(eur.id);
        yield* remove(eur.id); // idempotent by state (C6)
        expect((yield* history(s.workspaceId)).at(-1)?.action).toBe("workspace.bankAccount.remove");
      }),
    ));
});

describe("Numbering Series configuration", () => {
  test("configure, list, and the counter only rises (W3)", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const created: NumberingSeriesView = yield* as(s.admin)(
          ws.configureSeries({
            kind: "invoice",
            name: "Export",
            pattern: "EX-YYYY-NNN",
            nextNumber: 5,
          }),
        );
        expect(created).toMatchObject({
          periodKey: "2026",
          nextCounter: 5,
          nextNumber: "EX-2026-005",
        });
        expect(
          yield* failure(
            as(s.admin)(
              ws.configureSeries({
                id: created.id,
                kind: "invoice",
                name: "Export",
                pattern: "EX-YYYY-NNN",
                nextNumber: 3,
              }),
            ),
          ),
        ).toEqual(
          new Invalid({
            issues: [
              {
                path: ["pattern"],
                code: "numbering.pattern_invalid",
                params: { reason: "below_used", minimum: "5" },
              },
            ],
          }),
        );
        expect(
          yield* failure(
            as(s.admin)(ws.configureSeries({ kind: "invoice", name: "Bad", pattern: "YYYY" })),
          ),
        ).toBeInstanceOf(Invalid);
        expect(
          yield* failure(
            as(s.accountant)(ws.configureSeries({ kind: "invoice", name: "X", pattern: "NNN" })),
          ),
        ).toEqual(new Forbidden({ action: "workspace.settings" }));
        expect((yield* as(s.accountant)(ws.listSeries)).length).toBe(4);
        expect((yield* history(s.workspaceId)).at(-1)?.action).toBe("workspace.series.configure");
      }),
    ));

  test("configureSeries replays a requestKey (C3)", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const input = { kind: "proforma" as const, name: "ZF2", pattern: "ZF2-NNNN" };
        const first = yield* as(s.admin)(ws.configureSeries(input, key("s1")));
        expect(yield* as(s.admin)(ws.configureSeries(input, key("s1")))).toEqual(first);
        expect(
          (yield* as(s.admin)(ws.listSeries)).filter((x) => x.kind === "proforma").length,
        ).toBe(2);
      }),
    ));
});

describe("branding images (W7) and preview", () => {
  test("streams, checks and stores under branding/{workspace}/{image}/{sha256}", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const blobs = yield* MemoryBlobStorage;
        const s = yield* seed();
        const bytes = png(1000);
        const ref = yield* as(s.admin)(
          ws.setBrandingImage("logo", { contentType: "image/png", bytes: chunks(bytes) }),
        );
        expect(ref).toMatchObject({ contentType: "image/png", bytes: 1000 });
        const keys: Array<string> = [...(yield* Ref.get(blobs.blobs)).keys()];
        expect(keys).toEqual([`branding/${s.workspaceId}/logo/${ref.sha256}`]);
        const current = view(yield* as(s.member)(ws.current));
        expect(current.branding.logo).toEqual(ref);
        expect(current.revision).toBe(2);
        const download = yield* as(s.accountant)(ws.brandingImage("logo"));
        const got = yield* Stream.runCollect(download.bytes);
        expect(got.reduce((n, c) => n + c.byteLength, 0)).toBe(1000);
        expect(download).toMatchObject({ filename: "logo.png", contentType: "image/png" });
        yield* as(s.admin)(ws.removeBrandingImage("logo"));
        expect(yield* failure(as(s.admin)(ws.brandingImage("logo")))).toEqual(
          new NotFound({ entity: "BrandingImage", id: "logo" }),
        );
        // Content-addressed blobs are not deleted eagerly (housekeeping collects them).
        expect((yield* Ref.get(blobs.blobs)).size).toBe(1);
      }),
    ));

  test("rejects other types, wrong signatures, oversize files, and reports blob outages", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const blobs = yield* MemoryBlobStorage;
        const s = yield* seed();
        const set = (contentType: string, bytes: Uint8Array) =>
          as(s.admin)(ws.setBrandingImage("stamp", { contentType, bytes: chunks(bytes) }));
        expect(yield* failure(set("image/gif", png()))).toEqual(
          new Invalid({
            issues: [{ path: ["contentType"], code: "branding.image_type_rejected" }],
          }),
        );
        expect(yield* failure(set("image/jpeg", png()))).toEqual(
          new Invalid({ issues: [{ path: ["file"], code: "branding.image_type_rejected" }] }),
        );
        expect(yield* failure(set("image/png", png(2 * 1024 * 1024 + 1)))).toEqual(
          new Invalid({ issues: [{ path: ["file"], code: "branding.image_too_large" }] }),
        );
        yield* Ref.set(blobs.unavailable, true);
        expect(yield* failure(set("image/png", png()))).toEqual(
          new Unavailable({ dependency: "blob_storage" }),
        );
        expect(yield* failure(as(s.member)(ws.removeBrandingImage("stamp")))).toEqual(
          new Forbidden({ action: "workspace.settings" }),
        );
      }),
    ));

  test("previewBranding renders merged branding and persists nothing", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const before = (yield* history(s.workspaceId)).length;
        const file = yield* as(s.admin)(
          ws.previewBranding({
            branding: { accentColor: "#ABCDEF" as never },
            kind: "invoice",
            language: "en",
          }),
        );
        const body = JSON.parse(
          new TextDecoder().decode((yield* Stream.runCollect(file.bytes))[0] ?? new Uint8Array()),
        );
        expect(body.branding.accentColor).toBe("#ABCDEF");
        expect(body.kind).toBe("invoice");
        expect(view(yield* as(s.admin)(ws.current)).branding.accentColor).not.toBe("#ABCDEF");
        expect((yield* history(s.workspaceId)).length).toBe(before);
        expect(
          yield* failure(
            as(s.admin)(
              ws.previewBranding({
                branding: { accentColor: "nope" as never },
                kind: "invoice",
                language: "cs",
              }),
            ),
          ),
        ).toEqual(
          new Invalid({
            issues: [{ path: ["branding", "accentColor"], code: "branding.accent_invalid" }],
          }),
        );
      }),
    ));
});

describe("scope-limited API key callers (R1)", () => {
  test("each method area needs its scope", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const read = scoped(s.admin, ["workspace:read"]);
        const write = scoped(s.admin, ["workspace:write"]);
        const docs = scoped(s.admin, ["documents:write"]);
        expect(view(yield* as(read)(ws.current)).id).toBe(s.workspaceId);
        expect(yield* failure(as(read)(ws.updateSettings({} as never, 1)))).toEqual(
          new Forbidden({ action: "workspace.settings" }),
        );
        expect(yield* failure(as(docs)(ws.current))).toEqual(
          new Forbidden({ action: "workspace.read" }),
        );
        expect(yield* failure(as(docs)(ws.listSeries))).toEqual(
          new Forbidden({ action: "workspace.read" }),
        );
        expect(view(yield* as(write)(ws.updateSettings({ name: "Acme 2" } as never, 1))).name).toBe(
          "Acme 2",
        );
        expect(
          yield* failure(as(read)(ws.saveBankAccount({ iban: IBAN_CZ, currency: "CZK" } as never))),
        ).toEqual(new Forbidden({ action: "workspace.settings" }));
        // An owner's token without workspace:write cannot close.
        expect(yield* failure(as(scoped(s.owner, ["workspace:read"]))(ws.close("Acme 2")))).toEqual(
          new Forbidden({ action: "workspace.close" }),
        );
        const entry = (yield* history(s.workspaceId)).at(-1);
        expect(entry?.actor).toEqual({
          _tag: "Member",
          userId: s.admin.userId,
          channel: "api",
          client: write.client,
        });
      }),
    ));
});

describe("close (W5)", () => {
  test("owner only, name confirmed; afterwards writes are Forbidden and reads work", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        expect(yield* failure(as(s.admin)(ws.close("Acme s.r.o.")))).toEqual(
          new Forbidden({ action: "workspace.close" }),
        );
        expect(yield* failure(as(s.owner)(ws.close("Acme")))).toEqual(
          new Invalid({ issues: [{ path: ["confirmName"], code: "request.malformed" }] }),
        );
        yield* as(s.owner)(ws.close("Acme s.r.o."));
        const current = view(yield* as(s.member)(ws.current));
        expect(current.closed).toBe(true);
        expect(
          yield* failure(as(s.admin)(ws.updateSettings({ name: "X" } as never, current.revision))),
        ).toEqual(new Forbidden({ action: "workspace.settings" }));
        expect(yield* failure(as(s.admin)(ws.invite("new@example.cz", "member")))).toEqual(
          new Forbidden({ action: "member.invite" }),
        );
        expect(yield* failure(as(s.member)(ws.leave))).toEqual(
          new Forbidden({ action: "member.leave" }),
        );
        expect((yield* as(s.member)(ws.members)).length).toBe(4);
        expect((yield* as(accountOf(s.owner.userId))(ws.listMine))[0]?.closed).toBe(true);
      }),
    ));
});

describe("cross-workspace access is NotFound (R2)", () => {
  test("ids of another Workspace are never visible", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const a = yield* seed("Alpha");
        const b = yield* seed("Beta");
        const account = view(
          yield* as(b.admin)(ws.saveBankAccount({ iban: IBAN_CZ, currency: "CZK" } as never)),
        );
        expect(yield* failure(as(a.admin)(ws.removeBankAccount(account.id)))).toEqual(
          new NotFound({ entity: "BankAccount", id: account.id }),
        );
        const series = yield* as(b.admin)(ws.listSeries);
        const target = series[0];
        if (target === undefined) throw new Error("no series");
        expect(
          yield* failure(
            as(a.admin)(
              ws.configureSeries({ id: target.id, kind: target.kind, name: "x", pattern: "NNN" }),
            ),
          ),
        ).toEqual(new NotFound({ entity: "NumberingSeries", id: target.id }));
        const invitation = yield* as(b.admin)(ws.invite("x@example.cz", "member"));
        expect(yield* failure(as(a.admin)(ws.revokeInvitation(invitation.id)))).toEqual(
          new NotFound({ entity: "Invitation", id: invitation.id }),
        );
        yield* join(b.owner, OUTSIDER, "member");
        expect(yield* failure(as(a.owner)(ws.setRole(OUTSIDER, null)))).toEqual(
          new NotFound({ entity: "Member", id: OUTSIDER }),
        );
        const snapshots = yield* WorkspaceSnapshots;
        expect(
          yield* failure(snapshots.bankAccount(a.workspaceId as WorkspaceId, account.id)),
        ).toEqual(new NotFound({ entity: "BankAccount", id: account.id }));
      }),
    ));
});
