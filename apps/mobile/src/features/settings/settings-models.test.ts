import { describe, expect, test } from "bun:test";
import { PreconditionFailed } from "@kvitbit/api-contract";
import {
  BankAccountView,
  Conflict,
  Invalid,
  type RegistryResult,
  UserId,
  WorkspaceSlug,
  WorkspaceView,
} from "@kvitbit/domain/contract";
import { SettingsSection } from "@kvitbit/ui-port/view-models";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import { makeI18n } from "../../i18n/i18n-provider";
import {
  applyAresResult,
  aresAfterIcoEdit,
  aresIdle,
  aresSettled,
  aresStarted,
  computeAresDiffs,
} from "./ares-lookup";
import { formatSeriesNumber, hasCounterToken, previewSeriesNumbers } from "./numbering-preview";
import {
  canCloseWorkspace,
  canEditWorkspaceSettings,
  canLeaveWorkspace,
  canManageApiKeys,
  canManageInvitations,
  canManageMember,
  canRevokeConnectedApp,
  canTransferOwnership,
  invitableRolesFor,
} from "./permissions";
import { fieldErrorText, formErrorFrom } from "./settings-feedback";
import {
  type IssuingEntityData,
  parseBankAccountView,
  parseSettingsSection,
  parseWorkspaceView,
  todayIsoDate,
} from "./workspace-data";

describe("settings permissions", () => {
  test("workspace settings and API key management allow owner and admin unless closed", () => {
    expect(canEditWorkspaceSettings("owner", false)).toBe(true);
    expect(canEditWorkspaceSettings("admin", false)).toBe(true);
    expect(canEditWorkspaceSettings("member", false)).toBe(false);
    expect(canEditWorkspaceSettings("accountant", false)).toBe(false);
    expect(canEditWorkspaceSettings("owner", true)).toBe(false);

    expect(canManageApiKeys("owner", false)).toBe(true);
    expect(canManageApiKeys("admin", false)).toBe(true);
    expect(canManageApiKeys("member", false)).toBe(false);
    expect(canManageApiKeys("admin", true)).toBe(false);

    expect(canManageInvitations("owner", false)).toBe(true);
    expect(canManageInvitations("admin", false)).toBe(true);
    expect(canManageInvitations("member", false)).toBe(false);
  });

  test("invitableRolesFor restricts admins from inviting other admins", () => {
    expect(invitableRolesFor("owner")).toEqual(["admin", "member", "accountant"]);
    expect(invitableRolesFor("admin")).toEqual(["member", "accountant"]);
  });

  test("canManageMember respects owner vs admin hierarchy and never allows managing owner", () => {
    expect(canManageMember("owner", "owner", false)).toBe(false);
    expect(canManageMember("owner", "admin", false)).toBe(true);
    expect(canManageMember("owner", "member", false)).toBe(true);
    expect(canManageMember("admin", "admin", false)).toBe(false);
    expect(canManageMember("admin", "member", false)).toBe(true);
    expect(canManageMember("admin", "accountant", false)).toBe(true);
    expect(canManageMember("member", "accountant", false)).toBe(false);
    expect(canManageMember("owner", "member", true)).toBe(false);
  });

  test("canRevokeConnectedApp allows owner/admin for all, others only for own grants", () => {
    const alice = UserId.make("01950000-0000-7000-8000-000000000001");
    const bob = UserId.make("01950000-0000-7000-8000-000000000002");
    expect(canRevokeConnectedApp("owner", bob, alice, false)).toBe(true);
    expect(canRevokeConnectedApp("admin", bob, alice, false)).toBe(true);
    expect(canRevokeConnectedApp("member", alice, alice, false)).toBe(true);
    expect(canRevokeConnectedApp("member", bob, alice, false)).toBe(false);
    expect(canRevokeConnectedApp("accountant", alice, alice, false)).toBe(true);
    expect(canRevokeConnectedApp("owner", alice, alice, true)).toBe(false);
  });

  test("leave, transfer ownership and close workspace enforce owner rules", () => {
    expect(canLeaveWorkspace("owner")).toBe(false);
    expect(canLeaveWorkspace("admin")).toBe(true);
    expect(canLeaveWorkspace("member")).toBe(true);
    expect(canLeaveWorkspace("accountant")).toBe(true);

    expect(canTransferOwnership("owner", false)).toBe(true);
    expect(canTransferOwnership("admin", false)).toBe(false);
    expect(canTransferOwnership("owner", true)).toBe(false);

    expect(canCloseWorkspace("owner", false)).toBe(true);
    expect(canCloseWorkspace("admin", false)).toBe(false);
    expect(canCloseWorkspace("owner", true)).toBe(false);
  });
});

describe("workspace-data parsers", () => {
  test("parseSettingsSection maps all kebab-case and camelCase sections", () => {
    expect(parseSettingsSection("issuing-entity")).toBe("issuingEntity");
    expect(parseSettingsSection("tax-regime")).toBe("taxRegime");
    expect(parseSettingsSection("bank-accounts")).toBe("bankAccounts");
    expect(parseSettingsSection("document-defaults")).toBe("documentDefaults");
    expect(parseSettingsSection("api-keys")).toBe("apiKeys");
    expect(parseSettingsSection("connected-apps")).toBe("connectedApps");
    expect(parseSettingsSection("danger-zone")).toBe("dangerZone");
    for (const literal of SettingsSection.literals) {
      expect(parseSettingsSection(literal)).toBe(literal);
    }
    expect(parseSettingsSection("unknown-section")).toBeNull();
    expect(parseSettingsSection(undefined)).toBeNull();
  });

  test("parseWorkspaceView extracts nested core fields with safe defaults", () => {
    const raw = WorkspaceView.make({
      slug: WorkspaceSlug.make("acme-sro"),
      name: "Acme s.r.o.",
      closed: false,
      revision: 4,
      issuingEntity: {
        name: "Acme s.r.o.",
        ico: "12345678",
        dic: "CZ12345678",
        address: { street: "Hlavní 1", city: "Praha", postalCode: "11000", country: "CZ" },
        legalForm: "s.r.o.",
        registerEntry: "C 12345",
        email: "info@acme.cz",
        phone: null,
        web: null,
      },
      taxRegime: "vat_payer",
      taxRegimeHistory: [{ regime: "vat_payer", effectiveFrom: "2026-01-01" }],
      defaults: {
        currency: "EUR",
        language: "en",
        dueDays: 30,
        paymentMethod: "card",
        defaultNote: "Thanks",
        paymentRounding: "whole_unit",
        paymentTaxDocumentAutoSend: false,
      },
      reminderPolicy: { enabled: true, proformas: true, offsetsDays: [5, 15] },
      branding: {
        pdfTemplate: "modern_minimal",
        accentColor: "#111111",
        footerText: null,
        theme: null,
        logo: null,
        stamp: null,
      },
    });

    const parsed = parseWorkspaceView(raw);
    expect(parsed.revision).toBe(4);
    expect(parsed.issuingEntity.ico).toBe("12345678");
    expect(parsed.issuingEntity.address.city).toBe("Praha");
    expect(parsed.taxRegime).toBe("vat_payer");
    expect(parsed.taxRegimeHistory).toHaveLength(1);
    expect(parsed.defaults.dueDays).toBe(30);
    expect(String(parsed.defaults.currency)).toBe("EUR");
    expect(parsed.reminderPolicy.offsetsDays).toEqual([5, 15]);
  });

  test("parseBankAccountView extracts bank account fields", () => {
    const bankAccountId = "01950000-0000-7000-8000-000000000001";
    const parsed = Result.getOrThrow(
      parseBankAccountView(
        BankAccountView.make({
          id: bankAccountId,
          name: "Main CZK",
          iban: "CZ6508000000192000145399",
          bic: "GIBACZPX",
          currency: "CZK",
          isDefault: true,
          revision: 2,
        }),
      ),
    );
    expect(String(parsed.id)).toBe(bankAccountId);
    expect(String(parsed.currency)).toBe("CZK");
    expect(parsed.isDefault).toBe(true);
  });

  test("todayIsoDate formats YYYY-MM-DD", () => {
    const date = DateTime.makeZonedUnsafe("2026-11-05T00:00:00", {
      timeZone: DateTime.zoneMakeLocal(),
    }).pipe(DateTime.toDateUtc);
    expect(todayIsoDate(date)).toBe("2026-11-05");
  });
});

describe("ares-lookup state machine", () => {
  const current: IssuingEntityData = {
    name: "Old Name s.r.o.",
    ico: "27082440",
    dic: null,
    address: { street: "Old 1", city: "Brno", postalCode: "60200", country: "CZ" },
    legalForm: null,
    registerEntry: null,
    email: "billing@old.cz",
    phone: null,
    web: null,
  };
  const registry: RegistryResult = {
    ico: "27082440",
    name: "Alza.cz a.s.",
    dic: "CZ27082440",
    address: { street: "Jankovcova 1522/53", city: "Praha", postalCode: "17000", country: "CZ" },
    legalForm: "Akciová společnost",
    registerEntry: "B 8573 vedená u Městského soudu v Praze",
    terminatedOn: null,
  };

  test("computes field diffs and applies ARES result without clearing contact fields", () => {
    const started = aresStarted(" 27082440 ");
    expect(started).toEqual({ _tag: "LookingUp", ico: "27082440" });

    const diffs = computeAresDiffs(current, registry);
    expect(Arr.map(diffs, (d) => d.field)).toEqual([
      "name",
      "dic",
      "street",
      "city",
      "postalCode",
      "legalForm",
      "registerEntry",
    ]);

    const settled = aresSettled("27082440", current, { _tag: "Ok", value: registry });
    expect(settled._tag).toBe("Found");

    const applied = applyAresResult(current, registry);
    expect(applied.name).toBe("Alza.cz a.s.");
    expect(applied.dic).toBe("CZ27082440");
    expect(applied.email).toBe("billing@old.cz");

    // Editing IČO resets stale lookup state
    expect(aresAfterIcoEdit(settled, "27082440")).toBe(settled);
    expect(aresAfterIcoEdit(settled, "99999999")).toEqual(aresIdle);
  });
});

describe("numbering-preview", () => {
  const fixedDate = DateTime.toDate(
    DateTime.makeZonedUnsafe("2026-11-24T00:00:00", { timeZone: DateTime.zoneMakeLocal() }),
  ); // 2026-11-24

  test("validates N counter tokens and previews next 3 numbers", () => {
    expect(hasCounterToken("YYYY-NNNN")).toBe(true);
    expect(hasCounterToken("YYYY-MM")).toBe(false);

    expect(formatSeriesNumber("ZF-YYMM-NNN", 7, fixedDate)).toBe("ZF-2611-007");
    expect(previewSeriesNumbers("YYYY-NNNN", 41, fixedDate)).toEqual([
      "2026-0041",
      "2026-0042",
      "2026-0043",
    ]);
    expect(previewSeriesNumbers("YYYY-MM", 1, fixedDate)).toBeNull();
    expect(previewSeriesNumbers("YYYY-NNNN", 0, fixedDate)).toBeNull();
  });
});

describe("settings-feedback", () => {
  const i18n = makeI18n("en", () => undefined);

  test("marks revision conflicts and 412 as staleRevision", () => {
    const c = formErrorFrom(Conflict.make({ reason: "revision_changed" }), i18n);
    expect(c.staleRevision).toBe(true);
    expect(c.banner).not.toBeNull();

    const p = formErrorFrom(PreconditionFailed.make({ currentRevision: 4 }), i18n);
    expect(p.staleRevision).toBe(true);
  });

  test("maps field issues by path", () => {
    const err = formErrorFrom(
      Invalid.make({ issues: [{ path: ["ico"], code: "ico.checksum" }] }),
      i18n,
    );
    expect(fieldErrorText(err, ["ico"], i18n)).not.toBeNull();
    expect(fieldErrorText(err, ["name"], i18n)).toBeNull();
  });
});
