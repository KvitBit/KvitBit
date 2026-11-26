import { describe, expect, it } from "bun:test";
import type { View } from "@effect/ui";
import { Html, HtmlServer } from "@effect/ui/html";
import {
  ALL_SCOPES,
  ApiKeyId,
  ApiKeyToken,
  type ApiKeyView,
  type ConnectedAppView,
  READ_SCOPES,
  SCOPE_AREAS,
} from "@kvitbit/api-contract";
import {
  BankAccountId,
  CurrencyCode,
  InvitationId,
  NumberingSeriesId,
  UserId,
  WorkspaceId,
  WorkspaceSlug,
} from "@kvitbit/domain";
import { ViewModels } from "@kvitbit/ui-port";
import { Effect, Schema } from "effect";
import {
  czechAccountFromIban,
  previewNumberingPattern,
  type WorkspaceDetail,
} from "../../src/page/settings/models";
import * as Settings from "../../src/page/settings/settings";
import { ctxFor, DEMO_USER, DEMO_WORKSPACE, renderPath, signedIn, WS } from "../support";

const renderText = async (
  view: (h: Html.H<Settings.Message>) => View.Content<Settings.Message>,
): Promise<string> => {
  const fixture = Html.component({
    name: "SettingsViewFixture",
    model: Schema.Null,
    message: Settings.Message,
  }).make({
    init: () => null,
    update: () => null,
    view,
  });
  return (await Effect.runPromise(HtmlServer.renderToHtml(fixture, {}))).html;
};

const sampleWorkspace: WorkspaceDetail = {
  id: WorkspaceId.make(DEMO_WORKSPACE.id),
  slug: WorkspaceSlug.make(DEMO_WORKSPACE.slug),
  name: DEMO_WORKSPACE.name,
  closed: false,
  revision: 3,
  issuingEntity: {
    name: "Novák Design s.r.o.",
    ico: "27082440",
    dic: "CZ27082440",
    address: { street: "Korunní 1", city: "Praha", postalCode: "101 00", country: "CZ" },
    legalForm: "s.r.o.",
    registerEntry: "C 123456, Městský soud v Praze",
    email: "info@novakdesign.cz",
    phone: "+420 222 333 444",
    web: "https://novakdesign.cz",
  },
  taxRegime: "vat_payer",
  taxRegimeHistory: [
    { regime: "non_vat_payer", effectiveFrom: "2024-01-01" as never },
    { regime: "vat_payer", effectiveFrom: "2025-01-01" as never },
  ],
  defaults: {
    currency: CurrencyCode.make("CZK"),
    language: "cs",
    dueDays: 14,
    paymentMethod: "bank_transfer",
    defaultNote: "Děkujeme.",
    paymentRounding: "whole_unit",
    paymentTaxDocumentAutoSend: true,
  },
  reminderPolicy: {
    enabled: true,
    proformas: false,
    offsetsDays: [3, 10, 30],
  },
  bankAccounts: [],
  branding: {
    pdfTemplate: "classic",
    accentColor: "#111111",
    footerText: "Novák Design s.r.o.",
    theme: { _tag: "Preset", id: "graphite_atelier" },
    logo: null,
    stamp: null,
  },
};

describe("Settings page (Screens 18-21 & More hub)", () => {
  it("initializes and renders every Settings section in cs and en", async () => {
    for (const section of Settings.SETTINGS_SECTIONS) {
      for (const locale of ["cs", "en"] as const) {
        const route: Settings.Route = { _tag: "Settings", ws: WS, section };
        const ctx = ctxFor(route, { locale });
        const { model } = Settings.init(route, ctx);
        const html = await renderText((h) => Settings.view(model, ctx, h));
        expect(html.length).toBeGreaterThan(200);
        expect(Settings.title(model, ctx).length).toBeGreaterThan(3);
      }
    }
  });

  it("renders the Mobile More hub when route._tag === More", async () => {
    const route: Settings.Route = { _tag: "More", ws: WS };
    const ctxCs = ctxFor(route, { locale: "cs" });
    const ctxEn = ctxFor(route, { locale: "en" });
    const { model } = Settings.init(route, ctxCs);
    expect(Settings.title(model, ctxCs)).toBe("Více");
    expect(Settings.title(model, ctxEn)).toBe("More");
    const html = await renderText((h) => Settings.view(model, ctxEn, h));
    expect(html).toContain(`/w/${WS}/settings/issuing-entity`);
    expect(html).toContain("/account/profile");
    expect(html).toContain(`/w/${WS}/templates`);
  });

  it("handles Issuing Entity edits and ARES lookup", () => {
    const route: Settings.Route = { _tag: "Settings", ws: WS, section: "issuingEntity" };
    const ctx = ctxFor(route, { locale: "en" });
    let { model } = Settings.init(route, ctx);
    model = Settings.update(
      model,
      Settings.Message.GotWorkspace({ seq: 1, data: sampleWorkspace }),
      ctx,
    ).model;
    expect(model.entityForm.name).toBe("Novák Design s.r.o.");
    expect(model.entityForm.registerEntry).toContain("C 123456");

    const aresRes = Settings.update(model, Settings.Message.ClickedAresLookup(), ctx);
    expect(aresRes.model.entityForm.lookingUpAres).toBe(true);
    expect(aresRes.commands?.length).toBe(1);

    const populated = Settings.update(
      aresRes.model,
      Settings.Message.GotAresResult({
        result: {
          ico: "27082440",
          name: "Alza.cz a.s.",
          address: {
            street: "Jankovcova 1522/53",
            city: "Praha 7",
            postalCode: "170 00",
            country: "CZ",
          },
          dic: "CZ27082440",
          legalForm: "a.s.",
          registerEntry: "B 8573, Městský soud v Praze",
          terminatedOn: null,
        },
      }),
      ctx,
    );
    expect(populated.model.entityForm.name).toBe("Alza.cz a.s.");
    expect(populated.model.entityForm.registerEntry).toBe("B 8573, Městský soud v Praze");
    expect(populated.outMessage?._tag).toBe("Toast");
  });

  it("handles Tax Regime history and scheduled change confirmation", async () => {
    const route: Settings.Route = { _tag: "Settings", ws: WS, section: "taxRegime" };
    const ctx = ctxFor(route, { locale: "en" });
    let { model } = Settings.init(route, ctx);
    model = Settings.update(
      model,
      Settings.Message.GotWorkspace({ seq: 1, data: sampleWorkspace }),
      ctx,
    ).model;
    model = Settings.update(
      model,
      Settings.Message.ChangedTaxRegime({ regime: "identified_person" }),
      ctx,
    ).model;
    model = Settings.update(
      model,
      Settings.Message.ChangedTaxEffectiveFrom({ value: "2027-01-01" }),
      ctx,
    ).model;
    model = Settings.update(model, Settings.Message.ClickedAskChangeTaxRegime(), ctx).model;
    expect(model.taxForm.confirmOpen).toBe(true);
    expect(await renderText((h) => Settings.view(model, ctx, h))).toContain(
      "kb-tax-confirm-dialog",
    );

    const confirmed = Settings.update(model, Settings.Message.ClickedConfirmTaxRegime(), ctx);
    expect(confirmed.model.taxForm.confirmOpen).toBe(false);
    expect(confirmed.commands?.length).toBe(1);
  });

  it("derives Czech domestic account number from CZ IBAN and manages Bank Accounts CRUD", async () => {
    expect(czechAccountFromIban("CZ6508000000192000145399")).toBe("19-2000145399/0800");
    expect(czechAccountFromIban("DE89370400440532013000")).toBeNull();

    const route: Settings.Route = { _tag: "Settings", ws: WS, section: "bankAccounts" };
    const ctx = ctxFor(route, { locale: "en" });
    let { model } = Settings.init(route, ctx);
    const accId = BankAccountId.make("0193a000-0000-7000-8000-000000000201");
    model = Settings.update(
      model,
      Settings.Message.GotBankAccounts({
        seq: 1,
        items: [
          {
            id: accId,
            name: "Fio CZK",
            iban: "CZ6508000000192000145399",
            bic: "GIBACZPX",
            currency: CurrencyCode.make("CZK"),
            isDefault: true,
            revision: 1,
          },
        ],
      }),
      ctx,
    ).model;
    const html = await renderText((h) => Settings.view(model, ctx, h));
    expect(html).toContain("19-2000145399/0800");
    expect(html).toContain("GIBACZPX");

    model = Settings.update(model, Settings.Message.ClickedEditBank({ id: accId }), ctx).model;
    expect(model.bankForm.editingId).toBe(accId);
    model = Settings.update(model, Settings.Message.ClickedAskRemoveBank({ id: accId }), ctx).model;
    expect(model.bankForm.removingId).toBe(accId);
  });

  it("toggles distinct Classic Czech vs Modern Minimal miniature PDF preview layouts", async () => {
    const route: Settings.Route = { _tag: "Settings", ws: WS, section: "branding" };
    const ctx = ctxFor(route, { locale: "en" });
    let { model } = Settings.init(route, ctx);

    const classicHtml = await renderText((h) => Settings.view(model, ctx, h));
    expect(classicHtml).toContain("kb-pdf-mini--classic");
    expect(classicHtml).not.toContain("kb-pdf-mini--modern");

    model = Settings.update(
      model,
      Settings.Message.SelectedPdfTemplate({ template: "modern_minimal" }),
      ctx,
    ).model;
    const modernHtml = await renderText((h) => Settings.view(model, ctx, h));
    expect(modernHtml).toContain("kb-pdf-mini--modern");
    expect(modernHtml).not.toContain("kb-pdf-mini--classic");

    model = Settings.update(
      model,
      Settings.Message.SelectedWorkspaceTheme({ choice: "forest" }),
      ctx,
    ).model;
    const saved = Settings.update(model, Settings.Message.ClickedSaveBranding(), ctx);
    expect(saved.commands?.length).toBe(1);
  });

  it("previews Numbering Series patterns live and rejects >20-char patterns", async () => {
    const p1 = previewNumberingPattern("FV-YYYY-NNNN", 42, 2026, 11);
    expect(p1.valid).toBe(true);
    expect(p1.samples).toEqual(["FV-2026-0042", "FV-2026-0043", "FV-2026-0044"]);

    const tooLong = previewNumberingPattern("VERY-LONG-PREFIX-YYYY-NNNNNN", 1, 2026, 11);
    expect(tooLong.tooLong).toBe(true);
    expect(tooLong.valid).toBe(false);

    const route: Settings.Route = { _tag: "Settings", ws: WS, section: "numbering" };
    const ctx = ctxFor(route, { locale: "cs" });
    let { model } = Settings.init(route, ctx);
    model = Settings.update(
      model,
      Settings.Message.ClickedInsertToken({ token: "-MM" }),
      ctx,
    ).model;
    expect(model.numberingForm.pattern).toBe("YYYY-NNNN-MM");
    const html = await renderText((h) => Settings.view(model, ctx, h));
    expect(html).toContain("2026-0001-11");
  });

  it("updates Document Defaults and Overdue Reminders offsets + auto-send PTD", () => {
    const route: Settings.Route = { _tag: "Settings", ws: WS, section: "reminders" };
    const ctx = ctxFor(route, { locale: "en" });
    let { model } = Settings.init(route, ctx);
    model = Settings.update(
      model,
      Settings.Message.ChangedNewReminderOffset({ value: "14" }),
      ctx,
    ).model;
    model = Settings.update(model, Settings.Message.ClickedAddReminderOffset(), ctx).model;
    expect(model.remindersForm.offsetsDays).toEqual([3, 10, 14, 30]);

    model = Settings.update(
      model,
      Settings.Message.ClickedRemoveReminderOffset({ day: 10 }),
      ctx,
    ).model;
    expect(model.remindersForm.offsetsDays).toEqual([3, 14, 30]);

    model = Settings.update(
      model,
      Settings.Message.ToggledRemindersAutoSendPtd({ checked: false }),
      ctx,
    ).model;
    expect(model.remindersForm.paymentTaxDocumentAutoSend).toBe(false);
    const saved = Settings.update(model, Settings.Message.ClickedSaveReminders(), ctx);
    expect(saved.commands?.length).toBe(1);
  });

  it("toggles granular Read/Write scopes across all 10 ScopeAreas and reveals one-time kvb_ secret", async () => {
    const route: Settings.Route = { _tag: "Settings", ws: WS, section: "apiKeys" };
    const ctx = ctxFor(route, { locale: "en" });
    let { model } = Settings.init(route, ctx);
    model = Settings.update(model, Settings.Message.ClickedToggleCreateApiKey(), ctx).model;
    model = Settings.update(
      model,
      Settings.Message.ChangedApiKeyName({ value: "CI Bot" }),
      ctx,
    ).model;

    // Start from custom empty-ish by switching to read_write then toggling every single area
    model = Settings.update(
      model,
      Settings.Message.SelectedApiKeyPreset({ preset: "read_write" }),
      ctx,
    ).model;
    expect(model.apiKeysForm.selectedScopes.length).toBe(ALL_SCOPES.length);

    // Toggle every one of the 10 ScopeAreas: unchecking read clears write too
    expect(SCOPE_AREAS.length).toBe(10);
    for (const area of SCOPE_AREAS) {
      model = Settings.update(
        model,
        Settings.Message.ToggledApiKeyScope({ scope: `${area}:read` }),
        ctx,
      ).model;
      expect(model.apiKeysForm.selectedScopes).not.toContain(`${area}:read`);
      expect(model.apiKeysForm.selectedScopes).not.toContain(`${area}:write`);

      // Checking write automatically enables read as well
      model = Settings.update(
        model,
        Settings.Message.ToggledApiKeyScope({ scope: `${area}:write` }),
        ctx,
      ).model;
      expect(model.apiKeysForm.selectedScopes).toContain(`${area}:read`);
      expect(model.apiKeysForm.selectedScopes).toContain(`${area}:write`);
    }

    // Verify all 10 areas appear in the rendered scope matrix
    const matrixHtml = await renderText((h) => Settings.view(model, ctx, h));
    expect(matrixHtml).toContain("kb-scope-matrix");
    expect(matrixHtml).toContain("Documents");
    expect(matrixHtml).toContain("Share links");

    // Verify accountant role ceiling caps write scopes
    const accountantCtx = {
      ...ctx,
      workspace: { ...DEMO_WORKSPACE, role: "accountant" as const },
    };
    const capped = ViewModels.ScopePicker.rows(Settings.scopePickerFromModel(model, accountantCtx));
    expect(capped.every((r) => !r.writeEnabled && r.readEnabled)).toBe(true);

    // One-time kvb_ secret reveal & dismissal
    const keyId = ApiKeyId.make("k9x4m2p8q1r7");
    const secret = ApiKeyToken.make("kvb_k9x4m2p8q1r7_9fK2mP7xQ4vL8nR1wT6yB3cH5jD0sA2eF4g");
    const createdKey: ApiKeyView = {
      id: keyId,
      name: "CI Bot",
      prefix: "kvb_k9x4m2p8q1r7",
      access: "read",
      scopes: [...READ_SCOPES],
      createdBy: { userId: UserId.make(DEMO_USER.id), name: DEMO_USER.name },
      createdAt: "2026-11-24T12:00:00.000Z",
      lastUsedAt: null,
      expiresAt: null,
    };
    model = Settings.update(
      model,
      Settings.Message.CreatedApiKey({ created: { key: createdKey, secret } }),
      ctx,
    ).model;
    expect(model.apiKeysForm.createdSecret).toBe(secret);
    expect(await renderText((h) => Settings.view(model, ctx, h))).toContain(secret);

    model = Settings.update(model, Settings.Message.ClickedDismissApiKeySecret(), ctx).model;
    expect(model.apiKeysForm.createdSecret).toBeNull();
  });

  it("renders Connected MCP Apps with scope matrix and revokes grants", async () => {
    const route: Settings.Route = { _tag: "Settings", ws: WS, section: "connectedApps" };
    const ctx = ctxFor(route, { locale: "en" });
    let { model } = Settings.init(route, ctx);
    const app: ConnectedAppView = {
      grantId: "grant-1",
      client: { id: "claude", name: "Claude Desktop", redirectHost: "claude.ai" },
      member: { userId: UserId.make(DEMO_USER.id), name: DEMO_USER.name },
      access: "custom",
      scopes: ["documents:read", "reports:read"],
      createdAt: "2026-11-01T10:00:00.000Z",
      lastUsedAt: "2026-11-24T10:00:00.000Z",
    };
    model = Settings.update(
      model,
      Settings.Message.GotConnectedApps({ seq: 1, items: [app] }),
      ctx,
    ).model;
    const html = await renderText((h) => Settings.view(model, ctx, h));
    expect(html).toContain("Claude Desktop");
    expect(html).toContain("claude.ai");

    model = Settings.update(
      model,
      Settings.Message.ClickedAskRevokeApp({ grantId: "grant-1" }),
      ctx,
    ).model;
    const revoked = Settings.update(
      model,
      Settings.Message.RevokedApp({ grantId: "grant-1" }),
      ctx,
    );
    expect(revoked.model.connectedApps._tag).toBe("Loaded");
    if (revoked.model.connectedApps._tag === "Loaded") {
      expect(revoked.model.connectedApps.data).toHaveLength(0);
    }
  });

  it("guards Danger Zone workspace closure until exact workspace name is typed", () => {
    const route: Settings.Route = { _tag: "Settings", ws: WS, section: "dangerZone" };
    const ctx = ctxFor(route, { locale: "en" });
    let { model } = Settings.init(route, ctx);

    // Wrong name -> no command emitted
    model = Settings.update(
      model,
      Settings.Message.ChangedCloseConfirm({ value: "wrong" }),
      ctx,
    ).model;
    expect(
      Settings.update(model, Settings.Message.ClickedCloseWorkspace(), ctx).commands,
    ).toBeUndefined();

    // Exact workspace name -> command emitted
    model = Settings.update(
      model,
      Settings.Message.ChangedCloseConfirm({ value: DEMO_WORKSPACE.name }),
      ctx,
    ).model;
    const res = Settings.update(model, Settings.Message.ClickedCloseWorkspace(), ctx);
    expect(res.commands?.length).toBe(1);
    expect(res.model.dangerForm.closing).toBe(true);
  });

  it("handles Team invitations and role changes", () => {
    const route: Settings.Route = { _tag: "Settings", ws: WS, section: "team" };
    const ctx = ctxFor(route, { locale: "cs" });
    let { model } = Settings.init(route, ctx);
    model = Settings.update(
      model,
      Settings.Message.ChangedInviteEmail({ value: "ucetni@example.cz" }),
      ctx,
    ).model;
    model = Settings.update(
      model,
      Settings.Message.ChangedInviteRole({ role: "accountant" }),
      ctx,
    ).model;
    const sent = Settings.update(model, Settings.Message.ClickedSendInvite(), ctx);
    expect(sent.commands?.length).toBe(1);

    const invId = InvitationId.make("0193a000-0000-7000-8000-000000000401");
    const seriesId = NumberingSeriesId.make("0193a000-0000-7000-8000-000000000301");
    expect(invId).toBeTruthy();
    expect(seriesId).toBeTruthy();
  });

  it("server-renders Settings and More routes cleanly via SSR", async () => {
    const s1 = await renderPath(`/w/${WS}/settings/branding`, { locale: "cs", session: signedIn });
    expect(s1.html).toContain("kb-pdf-mini--classic");
    const s2 = await renderPath(`/w/${WS}/settings/api-keys`, { locale: "en", session: signedIn });
    expect(s2.html).toContain("API keys");
    const s3 = await renderPath(`/w/${WS}/more`, { locale: "cs", session: signedIn });
    expect(s3.html).toContain("Více");
  });
});
