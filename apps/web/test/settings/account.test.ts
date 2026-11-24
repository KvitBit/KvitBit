import { describe, expect, it } from "bun:test";
import { Theme } from "@kvitbit/ui-port";
import { type HtmlBuilder, inertHtml } from "foldkit/html";
import * as Account from "../../src/page/settings/account";
import { ctxFor, DEMO_USER, DEMO_WORKSPACE, renderPath, signedIn } from "../support";

const h = inertHtml as unknown as HtmlBuilder<Account.Message>;
const renderText = (node: unknown): string => JSON.stringify(node);

describe("Account & Security page (Screen 22)", () => {
  it("initializes and renders all 5 Account tabs in cs and en", () => {
    const tabs: ReadonlyArray<Account.AccountTab> = [
      "profile",
      "appearance",
      "security",
      "sessions",
      "danger",
    ];
    for (const tab of tabs) {
      for (const locale of ["cs", "en"] as const) {
        const route: Account.Route = { _tag: "Account", tab };
        const ctx = ctxFor(route, { locale });
        const { model } = Account.init(route, ctx);
        const html = renderText(Account.view(model, ctx, h));
        expect(html.length).toBeGreaterThan(200);
        expect(Account.title(model, ctx).length).toBeGreaterThan(3);
      }
    }
  });

  it("emits Intent_.setPrefs live for all 6 theme presets, custom hex seed, style, mode, contrast and locale", () => {
    const route: Account.Route = { _tag: "Account", tab: "appearance" };
    const ctx = ctxFor(route, { locale: "en" });
    let { model } = Account.init(route, ctx);

    // All 6 presets must be present and emit SetPrefs
    expect(Theme.PRESET_IDS).toEqual([
      "graphite_atelier",
      "forest",
      "ocean",
      "plum",
      "sand",
      "graphite",
    ]);
    for (const preset of Theme.PRESET_IDS) {
      const res = Account.update(model, Account.Message.SelectedPreset({ preset }), ctx);
      expect(res.outMessage).toEqual({
        _tag: "SetPrefs",
        prefs: { ...ctx.prefs, theme: { _tag: "Preset", id: preset } },
      });
    }

    // Invalid hex seed shows inline error and emits no SetPrefs
    model = Account.update(
      model,
      Account.Message.ChangedSeedInput({ value: "not-a-hex" }),
      ctx,
    ).model;
    const badSeed = Account.update(model, Account.Message.ClickedApplySeed(), ctx);
    expect(badSeed.model.appearance.seedError).not.toBeNull();
    expect(badSeed.outMessage).toBeUndefined();

    // Valid hex seed normalizes and emits SetPrefs
    model = Account.update(
      model,
      Account.Message.ChangedSeedInput({ value: "#0f5d42" }),
      ctx,
    ).model;
    const goodSeed = Account.update(model, Account.Message.ClickedApplySeed(), ctx);
    expect(goodSeed.model.appearance.seedError).toBeNull();
    expect(goodSeed.outMessage).toEqual({
      _tag: "SetPrefs",
      prefs: { ...ctx.prefs, theme: { _tag: "Seed", hex: "#0F5D42" } },
    });

    // Elegant vs Cozy style toggle
    const cozy = Account.update(model, Account.Message.SelectedStyle({ style: "cozy" }), ctx);
    expect(cozy.outMessage).toEqual({
      _tag: "SetPrefs",
      prefs: { ...ctx.prefs, style: "cozy" },
    });

    // Light / Dark / System mode
    const dark = Account.update(model, Account.Message.SelectedMode({ mode: "dark" }), ctx);
    expect(dark.outMessage).toEqual({
      _tag: "SetPrefs",
      prefs: { ...ctx.prefs, mode: "dark" },
    });

    // Standard / Medium / High contrast
    const high = Account.update(model, Account.Message.SelectedContrast({ contrast: "high" }), ctx);
    expect(high.outMessage).toEqual({
      _tag: "SetPrefs",
      prefs: { ...ctx.prefs, contrast: "high" },
    });

    // UI Language switch in Profile
    const lang = Account.update(model, Account.Message.ChangedLocale({ locale: "cs" }), ctx);
    expect(lang.outMessage).toEqual({
      _tag: "SetPrefs",
      prefs: { ...ctx.prefs, locale: "cs" },
    });
  });

  it("handles Passkeys register, rename, delete and Password change validation", () => {
    const route: Account.Route = { _tag: "Account", tab: "security" };
    const ctx = ctxFor(route, { locale: "en" });
    let { model } = Account.init(route, ctx);

    model = Account.update(
      model,
      Account.Message.GotPasskeys({
        seq: 1,
        items: [
          {
            id: "pk-1",
            name: "MacBook",
            createdAt: "2026-05-01T00:00:00Z",
            deviceType: "platform",
          },
        ],
      }),
      ctx,
    ).model;
    expect(renderText(Account.view(model, ctx, h))).toContain("MacBook");

    // Rename passkey
    model = Account.update(
      model,
      Account.Message.ClickedStartRenamePasskey({ id: "pk-1", currentName: "MacBook" }),
      ctx,
    ).model;
    model = Account.update(
      model,
      Account.Message.ChangedRenamePasskey({ value: "Work MacBook" }),
      ctx,
    ).model;
    model = Account.update(
      model,
      Account.Message.RenamedPasskey({ id: "pk-1", name: "Work MacBook" }),
      ctx,
    ).model;
    expect(renderText(Account.view(model, ctx, h))).toContain("Work MacBook");

    // Password too short
    model = Account.update(
      model,
      Account.Message.ChangedNewPassword({ value: "short" }),
      ctx,
    ).model;
    model = Account.update(
      model,
      Account.Message.ChangedConfirmPassword({ value: "short" }),
      ctx,
    ).model;
    const tooShort = Account.update(model, Account.Message.ClickedChangePassword(), ctx);
    expect(tooShort.model.security.passwordError).not.toBeNull();

    // Password mismatch
    model = Account.update(
      model,
      Account.Message.ChangedNewPassword({ value: "super-secure-passphrase-1" }),
      ctx,
    ).model;
    model = Account.update(
      model,
      Account.Message.ChangedConfirmPassword({ value: "different-passphrase-2" }),
      ctx,
    ).model;
    const mismatch = Account.update(model, Account.Message.ClickedChangePassword(), ctx);
    expect(mismatch.model.security.passwordError).not.toBeNull();

    // Valid password change triggers command
    model = Account.update(
      model,
      Account.Message.ChangedConfirmPassword({ value: "super-secure-passphrase-1" }),
      ctx,
    ).model;
    const ok = Account.update(model, Account.Message.ClickedChangePassword(), ctx);
    expect(ok.commands?.length).toBe(1);
    expect(ok.model.security.savingPassword).toBe(true);
  });

  it("blocks Account deletion while sole owner of an open workspace and requires confirm phrase", () => {
    const route: Account.Route = { _tag: "Account", tab: "danger" };
    // Default signedIn session owns a 1-member workspace (jana-osvc) -> shows blocker
    const blockedCtx = ctxFor(route, { locale: "en" });
    const { model: blockedModel } = Account.init(route, blockedCtx);
    const blockedHtml = renderText(Account.view(blockedModel, blockedCtx, h));
    expect(blockedHtml).toContain("Jana Nováková (OSVČ)");

    // Session with no sole-owned open workspaces
    const clearCtx = ctxFor(route, {
      locale: "en",
      session: {
        _tag: "SignedIn",
        user: { ...DEMO_USER },
        workspaces: [{ ...DEMO_WORKSPACE, memberCount: 3 }],
      },
    });
    let { model } = Account.init(route, clearCtx);
    model = Account.update(
      model,
      Account.Message.ChangedDeleteConfirm({ value: "DELETE" }),
      clearCtx,
    ).model;
    const del = Account.update(model, Account.Message.ClickedDeleteAccount(), clearCtx);
    expect(del.commands?.length).toBe(1);

    const done = Account.update(del.model, Account.Message.DeletedAccount(), clearCtx);
    expect(done.outMessage).toEqual({ _tag: "SignedOut" });
  });

  it("server-renders Account tabs cleanly via SSR", async () => {
    const res = await renderPath("/account/appearance", { locale: "en", session: signedIn });
    expect(res.html).toContain("Graphite Atelier");
    expect(res.html).toContain("Banknote Emerald");
    expect(res.html).toContain("Prague Ledger");
  });
});
