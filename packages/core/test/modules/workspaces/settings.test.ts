import { describe, expect, test } from "bun:test";
import type { NumberingSeriesView, WorkspaceSettingsPatch } from "@kvitbit/domain/contract";
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
  WorkspaceId,
  WorkspaceSlug,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as EffectString from "effect/String";
import * as TestClock from "effect/testing/TestClock";
import { BankAccountReferencesFake, WorkspaceSnapshots } from "../../../src/modules/workspaces";
import type { BankAccountFields } from "../../../src/modules/workspaces/model";
import { MemoryBlobStorage } from "../../../src/testing";
import {
  accountOf,
  as,
  bankAccountView,
  failure,
  history,
  join,
  OUTSIDER,
  scenario,
  scoped,
  seed,
  W,
  workspaceView,
} from "./harness";

const IBAN_CZ = "CZ65 0800 0000 1920 0014 5399";
const IBAN_CZ_2 = "CZ69 0710 1781 2400 0000 4159";
const IBAN_DE = "DE89370400440532013000";
const key = (k: string) => ({ requestKey: RequestKey.make(k) });

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
          const result = yield* as(caller)(ws.current);
          const current = yield* workspaceView(result);
          expect(current.id).toBe(s.workspaceId);
        }
        for (const caller of [s.member, s.accountant]) {
          const updateSettingsFailure = yield* ws
            .updateSettings({ name: "X" }, 1)
            .pipe(as(caller), failure);
          expect(updateSettingsFailure).toEqual(Forbidden.make({ action: "workspace.settings" }));
        }
      }),
    ));

  test("Issuing Entity patch with revision check (C2) and audit", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const patch = { name: "Acme a.s.", ico: "27082440", email: "fakturace@acme.cz" };
        const updateIssuingEntityResult = yield* as(s.admin)(
          ws.updateIssuingEntity(IssuingEntityPatch.make(patch), 1),
        );
        const next = yield* workspaceView(updateIssuingEntityResult);
        expect(next.revision).toBe(2);
        expect(next.issuingEntity).toMatchObject({ name: "Acme a.s.", ico: "27082440" });
        const updateIssuingEntityFailure = yield* ws
          .updateIssuingEntity(IssuingEntityPatch.make(patch), 1)
          .pipe(as(s.admin), failure);
        expect(updateIssuingEntityFailure).toEqual(
          Conflict.make({ reason: "revision_changed", currentRevision: 2 }),
        );
        const updateIssuingEntityFailure2 = yield* ws
          .updateIssuingEntity(IssuingEntityPatch.make({ ico: "27082441" }), 2)
          .pipe(as(s.admin), failure);
        expect(updateIssuingEntityFailure2).toEqual(
          Invalid.make({ issues: [{ path: ["ico"], code: "ico.checksum" }] }),
        );
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
        const change = { taxRegime: { regime: "vat_payer", effectiveFrom: "2027-01-01" } };
        const updateIssuingEntityResult = yield* as(s.owner)(
          ws.updateIssuingEntity(IssuingEntityPatch.make(change), 1),
        );
        const next = yield* workspaceView(updateIssuingEntityResult);
        expect(next.taxRegime).toBe("non_vat_payer"); // today is 2026-11-23
        expect(next.taxRegimeHistory).toEqual([
          { regime: "non_vat_payer", effectiveFrom: IsoDate.make("2026-11-23") },
          { regime: "vat_payer", effectiveFrom: IsoDate.make("2027-01-01") },
        ]);
        expect((yield* snapshots.get(s.workspaceId, IsoDate.make("2026-12-31"))).taxRegime).toBe(
          "non_vat_payer",
        );
        expect((yield* snapshots.get(s.workspaceId, IsoDate.make("2027-01-01"))).taxRegime).toBe(
          "vat_payer",
        );
        const series = yield* as(s.owner)(ws.listSeries);
        // Becoming a payer adds the Payment Tax Document series.
        const kinds = EffectArray.map(series, (x) => x.kind);
        expect(kinds).toContain("payment_tax_document");
        const back = {
          taxRegime: { regime: "non_vat_payer", effectiveFrom: "2026-12-01" },
        };
        const updateIssuingEntityFailure = yield* ws
          .updateIssuingEntity(IssuingEntityPatch.make(back), 2)
          .pipe(as(s.owner), failure);
        expect(updateIssuingEntityFailure).toEqual(
          Invalid.make({
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
        } satisfies WorkspaceSettingsPatch;
        const updateSettingsResult = yield* as(s.admin)(ws.updateSettings(patch, 1));
        const next = yield* workspaceView(updateSettingsResult);
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
          branding: { accentColor: "red", footerText: EffectString.repeat(501)("x") },
          defaults: { dueDays: 1000 },
          reminderPolicy: { offsetsDays: [0] },
        };
        const updateSettingsFailure = yield* ws.updateSettings(bad, 2).pipe(as(s.admin), failure);
        expect(updateSettingsFailure).toEqual(
          Invalid.make({
            issues: [
              { path: ["branding", "accentColor"], code: "branding.accent_invalid" },
              { path: ["branding", "footerText"], code: "request.malformed" },
              { path: ["defaults", "dueDays"], code: "request.malformed" },
              { path: ["reminderPolicy", "offsetsDays"], code: "request.malformed" },
            ],
          }),
        );
        const updateSettingsFailure2 = yield* ws.updateSettings({}, 1).pipe(as(s.admin), failure);
        expect(updateSettingsFailure2).toEqual(
          Conflict.make({ reason: "revision_changed", currentRevision: 2 }),
        );
      }),
    ));

  test("a slug change keeps the old slug reserved as an alias for 90 days (W6)", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        yield* as(s.owner)(ws.updateSettings({ slug: WorkspaceSlug.make("acme-new") }, 1));
        const other = yield* as(accountOf(OUTSIDER))(ws.create({ name: "Other" }));
        const updateSettingsFailure = yield* ws
          .updateSettings({ slug: WorkspaceSlug.make("acme-s-r-o") }, 1)
          .pipe(as(other), failure);
        expect(updateSettingsFailure).toEqual(
          Invalid.make({ issues: [{ path: ["slug"], code: "workspace.slug_taken" }] }),
        );
        const updateSettingsFailure2 = yield* ws
          .updateSettings({ slug: WorkspaceSlug.make("acme-new") }, 1)
          .pipe(as(other), failure);
        expect(updateSettingsFailure2).toEqual(
          Invalid.make({ issues: [{ path: ["slug"], code: "workspace.slug_taken" }] }),
        );
        const updateSettingsResult = yield* as(s.owner)(
          ws.updateSettings({ slug: WorkspaceSlug.make("acme-s-r-o") }, 2),
        );
        // The owner can take the old slug back.
        expect(updateSettingsResult.slug).toBe(WorkspaceSlug.make("acme-s-r-o"));
        yield* TestClock.adjust("91 days");
        const updateSettingsResult2 = yield* as(other)(
          ws.updateSettings({ slug: WorkspaceSlug.make("acme-new") }, 1),
        );
        expect(updateSettingsResult2.slug).toBe(WorkspaceSlug.make("acme-new"));
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
        const result = yield* as(s.admin)(ws.current);
        const rev = result.revision;
        const updateSettingsResult = yield* as(s.admin)(
          ws.updateSettings({ defaults: { preferredSeriesByKind: { invoice: fv.id } } }, rev),
        );
        const next = yield* workspaceView(updateSettingsResult);
        expect(next.defaults.preferredSeriesByKind.invoice).toBe(fv.id);
        const series = yield* as(s.admin)(ws.listSeries);
        const invoices = EffectArray.filter(series, (x) => x.kind === "invoice");
        expect(
          EffectArray.map(
            EffectArray.filter(invoices, (x) => x.isDefault),
            (x) => x.id,
          ),
        ).toEqual([fv.id]);
        const updateSettingsFailure = yield* ws
          .updateSettings({ defaults: { preferredSeriesByKind: { proforma: fv.id } } }, rev + 1)
          .pipe(as(s.admin), failure);
        expect(updateSettingsFailure).toEqual(
          Invalid.make({
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
        const save = (input: (typeof BankAccountFields)["Encoded"]) =>
          as(s.admin)(ws.saveBankAccount(BankAccountInput.make(input)));
        const result = yield* save({ iban: IBAN_CZ, currency: "CZK", name: "Hlavní" });
        const a = yield* bankAccountView(result);
        expect(a).toMatchObject({
          iban: "CZ6508000000192000145399",
          isDefault: true,
          currency: "CZK",
        });
        const result2 = yield* save({ iban: IBAN_CZ_2, currency: "CZK" });
        const b = yield* bankAccountView(result2);
        expect(b.isDefault).toBe(false);
        const result3 = yield* save({ iban: IBAN_DE, currency: "EUR", bic: "cobadeffxxx" });
        const c = yield* bankAccountView(result3);
        expect(c).toMatchObject({ isDefault: true, bic: "COBADEFFXXX" });
        const failureResult = yield* failure(
          save({ iban: "CZ0000000000000000000000", currency: "CZK" }),
        );
        expect(failureResult).toEqual(
          Invalid.make({ issues: [{ path: ["iban"], code: "request.malformed" }] }),
        );
        const result4 = yield* as(s.member)(ws.current);
        const current = yield* workspaceView(result4);
        expect(EffectArray.map(current.bankAccounts, (account) => account.id)).toEqual([
          a.id,
          b.id,
          c.id,
        ]);
        const result5 = yield* save({
          id: b.id,
          iban: IBAN_CZ_2,
          currency: "CZK",
          isDefault: true,
        });
        // Explicit default switch, then an update of an unknown id is NotFound.
        const updated = yield* bankAccountView(result5);
        expect(updated.isDefault).toBe(true);
        const missing = "01900000-0000-7000-8000-0000000fffff";
        const failureResult2 = yield* failure(
          save({ id: missing, iban: IBAN_CZ, currency: "CZK" }),
        );
        expect(failureResult2).toEqual(NotFound.make({ entity: "BankAccount", id: missing }));
      }),
    ));

  test("saveBankAccount replays a requestKey (C3)", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const input = { iban: IBAN_CZ, currency: "CZK" };
        const first = yield* as(s.admin)(
          ws.saveBankAccount(BankAccountInput.make(input), key("b1")),
        );
        const saveBankAccountResult = yield* as(s.admin)(
          ws.saveBankAccount(BankAccountInput.make(input), key("b1")),
        );
        expect(saveBankAccountResult).toEqual(first);
        const result = yield* as(s.admin)(ws.current);
        const current = yield* workspaceView(result);
        expect(current.bankAccounts.length).toBe(1);
      }),
    ));

  test("removing an account in use needs a same-currency replacement", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const refs = yield* BankAccountReferencesFake;
        const s = yield* seed();
        const save = (input: (typeof BankAccountFields)["Encoded"]) =>
          Effect.flatMap(
            as(s.admin)(ws.saveBankAccount(BankAccountInput.make(input))),
            bankAccountView,
          );
        const a = yield* save({ iban: IBAN_CZ, currency: "CZK" });
        const b = yield* save({ iban: IBAN_CZ_2, currency: "CZK" });
        const eur = yield* save({ iban: IBAN_DE, currency: "EUR" });
        const remove = (id: BankAccountId, replacement?: BankAccountId) =>
          as(s.admin)(ws.removeBankAccount(id, replacement));
        const failureResult = yield* failure(remove(a.id));
        // a is the CZK default and b exists: in use.
        expect(failureResult).toEqual(
          Conflict.make({ reason: "illegal_transition", detail: "bank_account.in_use" }),
        );
        const failureResult2 = yield* failure(remove(a.id, eur.id));
        expect(failureResult2).toEqual(
          Invalid.make({
            issues: [{ path: ["replacement"], code: "bank_account.replacement_invalid" }],
          }),
        );
        yield* refs.set(s.workspaceId, BankAccountId.make(a.id), 2);
        yield* remove(a.id, b.id);
        const getResult = yield* refs.get(s.workspaceId, BankAccountId.make(b.id));
        expect(getResult).toBe(2);
        const getResult2 = yield* refs.get(s.workspaceId, BankAccountId.make(a.id));
        expect(getResult2).toBe(0);
        const result = yield* as(s.admin)(ws.current);
        const { bankAccounts } = yield* workspaceView(result);
        expect(EffectArray.map(bankAccounts, (account) => [account.id, account.isDefault])).toEqual(
          [
            [b.id, true],
            [eur.id, true],
          ],
        );
        const failureResult3 = yield* failure(remove(eur.id));
        // The only EUR account is the EUR default: still in use, so it needs a replacement (4.1).
        expect(failureResult3).toEqual(
          Conflict.make({ reason: "illegal_transition", detail: "bank_account.in_use" }),
        );
        // A non-default, unused account is removable without a replacement.
        const c = yield* save({ iban: IBAN_CZ, currency: "CZK", name: "Třetí" });
        yield* remove(c.id);
        yield* remove(c.id); // idempotent by state (C6)
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
        const configureSeriesFailure = yield* ws
          .configureSeries({
            id: created.id,
            kind: "invoice",
            name: "Export",
            pattern: "EX-YYYY-NNN",
            nextNumber: 3,
          })
          .pipe(as(s.admin), failure);
        expect(configureSeriesFailure).toEqual(
          Invalid.make({
            issues: [
              {
                path: ["pattern"],
                code: "numbering.pattern_invalid",
                params: { reason: "below_used", minimum: "5" },
              },
            ],
          }),
        );
        const configureSeriesFailure2 = yield* ws
          .configureSeries({ kind: "invoice", name: "Bad", pattern: "YYYY" })
          .pipe(as(s.admin), failure);
        expect(configureSeriesFailure2).toBeInstanceOf(Invalid);
        const configureSeriesFailure3 = yield* ws
          .configureSeries({ kind: "invoice", name: "X", pattern: "NNN" })
          .pipe(as(s.accountant), failure);
        expect(configureSeriesFailure3).toEqual(Forbidden.make({ action: "workspace.settings" }));
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
        const configureSeriesResult = yield* as(s.admin)(ws.configureSeries(input, key("s1")));
        expect(configureSeriesResult).toEqual(first);
        const series = yield* as(s.admin)(ws.listSeries);
        expect(EffectArray.filter(series, (x) => x.kind === "proforma").length).toBe(2);
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
        const result = yield* as(s.member)(ws.current);
        const current = yield* workspaceView(result);
        expect(current.branding.logo).toEqual(ref);
        expect(current.revision).toBe(2);
        const download = yield* as(s.accountant)(ws.brandingImage("logo"));
        const got = yield* Stream.runCollect(download.bytes);
        expect(EffectArray.reduce(got, 0, (n, c) => n + c.byteLength)).toBe(1000);
        expect(download).toMatchObject({ filename: "logo.png", contentType: "image/png" });
        yield* as(s.admin)(ws.removeBrandingImage("logo"));
        const brandingImageFailure = yield* ws.brandingImage("logo").pipe(as(s.admin), failure);
        expect(brandingImageFailure).toEqual(
          NotFound.make({ entity: "BrandingImage", id: "logo" }),
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
        const failureResult = yield* failure(set("image/gif", png()));
        expect(failureResult).toEqual(
          Invalid.make({
            issues: [{ path: ["contentType"], code: "branding.image_type_rejected" }],
          }),
        );
        const failureResult2 = yield* failure(set("image/jpeg", png()));
        expect(failureResult2).toEqual(
          Invalid.make({ issues: [{ path: ["file"], code: "branding.image_type_rejected" }] }),
        );
        const failureResult3 = yield* failure(set("image/png", png(2 * 1024 * 1024 + 1)));
        expect(failureResult3).toEqual(
          Invalid.make({ issues: [{ path: ["file"], code: "branding.image_too_large" }] }),
        );
        yield* Ref.set(blobs.unavailable, true);
        const failureResult4 = yield* failure(set("image/png", png()));
        expect(failureResult4).toEqual(Unavailable.make({ dependency: "blob_storage" }));
        const removeBrandingImageFailure = yield* ws
          .removeBrandingImage("stamp")
          .pipe(as(s.member), failure);
        expect(removeBrandingImageFailure).toEqual(
          Forbidden.make({ action: "workspace.settings" }),
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
            branding: { accentColor: "#ABCDEF" },
            kind: "invoice",
            language: "en",
          }),
        );
        const body = JSON.parse(
          new TextDecoder().decode((yield* Stream.runCollect(file.bytes))[0] ?? new Uint8Array()),
        );
        expect(body.branding.accentColor).toBe("#ABCDEF");
        expect(body.kind).toBe("invoice");
        const result = yield* as(s.admin)(ws.current);
        expect(result.branding.accentColor).not.toBe("#ABCDEF");
        expect((yield* history(s.workspaceId)).length).toBe(before);
        const previewBrandingFailure = yield* ws
          .previewBranding({
            branding: { accentColor: "nope" },
            kind: "invoice",
            language: "cs",
          })
          .pipe(as(s.admin), failure);
        expect(previewBrandingFailure).toEqual(
          Invalid.make({
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
        const read = scoped(["workspace:read"])(s.admin);
        const write = scoped(["workspace:write"])(s.admin);
        const docs = scoped(["documents:write"])(s.admin);
        const result = yield* as(read)(ws.current);
        const current = yield* workspaceView(result);
        expect(current.id).toBe(s.workspaceId);
        const updateSettingsFailure = yield* ws.updateSettings({}, 1).pipe(as(read), failure);
        expect(updateSettingsFailure).toEqual(Forbidden.make({ action: "workspace.settings" }));
        const failureResult = yield* ws.current.pipe(as(docs), failure);
        expect(failureResult).toEqual(Forbidden.make({ action: "workspace.read" }));
        const failureResult2 = yield* ws.listSeries.pipe(as(docs), failure);
        expect(failureResult2).toEqual(Forbidden.make({ action: "workspace.read" }));
        const updateSettingsResult = yield* as(write)(ws.updateSettings({ name: "Acme 2" }, 1));
        const updated = yield* workspaceView(updateSettingsResult);
        expect(updated.name).toBe("Acme 2");
        const saveBankAccountFailure = yield* ws
          .saveBankAccount(BankAccountInput.make({ iban: IBAN_CZ, currency: "CZK" }))
          .pipe(as(read), failure);
        expect(saveBankAccountFailure).toEqual(Forbidden.make({ action: "workspace.settings" }));
        const closeFailure = yield* ws
          .close("Acme 2")
          .pipe(as(scoped(["workspace:read"])(s.owner)), failure);
        // An owner's token without workspace:write cannot close.
        expect(closeFailure).toEqual(Forbidden.make({ action: "workspace.close" }));
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
        const closeFailure = yield* ws.close("Acme s.r.o.").pipe(as(s.admin), failure);
        expect(closeFailure).toEqual(Forbidden.make({ action: "workspace.close" }));
        const closeFailure2 = yield* ws.close("Acme").pipe(as(s.owner), failure);
        expect(closeFailure2).toEqual(
          Invalid.make({ issues: [{ path: ["confirmName"], code: "request.malformed" }] }),
        );
        yield* as(s.owner)(ws.close("Acme s.r.o."));
        const result = yield* as(s.member)(ws.current);
        const current = yield* workspaceView(result);
        expect(current.closed).toBe(true);
        const updateSettingsFailure = yield* ws
          .updateSettings({ name: "X" }, current.revision)
          .pipe(as(s.admin), failure);
        expect(updateSettingsFailure).toEqual(Forbidden.make({ action: "workspace.settings" }));
        const inviteFailure = yield* ws
          .invite("new@example.cz", "member")
          .pipe(as(s.admin), failure);
        expect(inviteFailure).toEqual(Forbidden.make({ action: "member.invite" }));
        const failureResult = yield* ws.leave.pipe(as(s.member), failure);
        expect(failureResult).toEqual(Forbidden.make({ action: "member.leave" }));
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
        const saveBankAccountResult = yield* as(b.admin)(
          ws.saveBankAccount(BankAccountInput.make({ iban: IBAN_CZ, currency: "CZK" })),
        );
        const account = yield* bankAccountView(saveBankAccountResult);
        const removeBankAccountFailure = yield* ws
          .removeBankAccount(account.id)
          .pipe(as(a.admin), failure);
        expect(removeBankAccountFailure).toEqual(
          NotFound.make({ entity: "BankAccount", id: account.id }),
        );
        const series = yield* as(b.admin)(ws.listSeries);
        const target = series[0];
        if (target === undefined) throw new Error("no series");
        const configureSeriesFailure = yield* ws
          .configureSeries({ id: target.id, kind: target.kind, name: "x", pattern: "NNN" })
          .pipe(as(a.admin), failure);
        expect(configureSeriesFailure).toEqual(
          NotFound.make({ entity: "NumberingSeries", id: target.id }),
        );
        const invitation = yield* as(b.admin)(ws.invite("x@example.cz", "member"));
        const revokeInvitationFailure = yield* ws
          .revokeInvitation(invitation.id)
          .pipe(as(a.admin), failure);
        expect(revokeInvitationFailure).toEqual(
          NotFound.make({ entity: "Invitation", id: invitation.id }),
        );
        yield* join(b.owner)(OUTSIDER, "member");
        const setRoleFailure = yield* ws.setRole(OUTSIDER, null).pipe(as(a.owner), failure);
        expect(setRoleFailure).toEqual(NotFound.make({ entity: "Member", id: OUTSIDER }));
        const snapshots = yield* WorkspaceSnapshots;
        const bankAccountFailure = yield* failure(
          snapshots.bankAccount(WorkspaceId.make(a.workspaceId), account.id),
        );
        expect(bankAccountFailure).toEqual(
          NotFound.make({ entity: "BankAccount", id: account.id }),
        );
      }),
    ));
});
