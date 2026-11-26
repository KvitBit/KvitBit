import { describe, expect, it, spyOn } from "bun:test";
import type { View } from "@effect/ui";
import { Html, HtmlServer } from "@effect/ui/html";
import { Theme } from "@kvitbit/ui-port";
import { Effect, Schema } from "effect";
import { type PageCommand, RunApi } from "../../src/app/commands";
import * as Account from "../../src/page/settings/account";
import { ctxFor, DEMO_USER, DEMO_WORKSPACE, renderPath, signedIn } from "../support";

const renderText = async (
  view: (h: Html.H<Account.Message>) => View.Content<Account.Message>,
): Promise<string> => {
  const fixture = Html.component({
    name: "AccountViewFixture",
    model: Schema.Null,
    message: Account.Message,
  }).make({
    init: () => null,
    update: () => null,
    view,
  });
  return (await Effect.runPromise(HtmlServer.renderToHtml(fixture, {}))).html;
};

const runCommand = (
  commands: ReadonlyArray<PageCommand<Account.Message>> | undefined,
  name: string,
) => {
  const command = commands?.find((command) => command.name === `Account.${name}`);
  if (command?._tag !== "Effect") throw new Error(`Missing Account.${name} command`);
  return Effect.runPromise(command.effect.pipe(Effect.provide(RunApi.layer)));
};

const mockFetch = (handle: (...args: Parameters<typeof fetch>) => Promise<Response>) =>
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(handle, { preconnect: () => {} }));

describe("Account & Security page (Screen 22)", () => {
  it("initializes and renders all 5 Account tabs in cs and en", async () => {
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
        const html = await renderText((h) => Account.view(model, ctx, h));
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

  it("renames a passkey and validates a password change", async () => {
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
    expect(await renderText((h) => Account.view(model, ctx, h))).toContain("MacBook");

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
    expect(await renderText((h) => Account.view(model, ctx, h))).toContain("Work MacBook");

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

  it("blocks removing the final passkey while password status is unknown or password is absent", async () => {
    const route: Account.Route = { _tag: "Account", tab: "security" };
    const ctx = ctxFor(route, { locale: "en" });
    const passkeys = [{ id: "key-1", name: null, deviceType: "singleDevice" }];
    let accounts: unknown = [];
    const fetch = mockFetch(async (input) => {
      switch (new URL(String(input)).pathname) {
        case "/api/auth/list-accounts":
          return Response.json(accounts);
        case "/api/auth/passkey/list-user-passkeys":
          return Response.json(passkeys);
        default:
          throw new Error(`Unexpected account request: ${input}`);
      }
    });

    try {
      const init = Account.init(route, ctx);
      const listed = await runCommand(init.commands, "LoadPasskeys");
      let model = Account.update(init.model, listed, ctx).model;
      const ask = Account.Message.ClickedAskRemovePasskey({ id: "key-1" });
      const confirm = Account.Message.ClickedConfirmRemovePasskey();
      expect(Account.update(model, ask, ctx).model.security.removingId).toBeNull();
      expect(model.security.passkeys).toMatchObject({ data: [{ id: "key-1", name: "Passkey" }] });

      const passwordless = await runCommand(init.commands, "LoadAccounts");
      model = Account.update(model, passwordless, ctx).model;
      expect(model.security.hasPassword).toMatchObject({ _tag: "Loaded", data: false });
      expect(Account.update(model, ask, ctx).model.security.removingId).toBeNull();
      const rendered = await renderText((h) => Account.view(model, ctx, h));
      expect(rendered).toMatch(/<button[^>]*disabled[^>]*>Remove<\/button>/);

      accounts = [{ providerId: "credential" }];
      const retry = Account.update(model, Account.Message.ClickedRetry(), ctx);
      const current = await runCommand(retry.commands, "LoadAccounts");
      model = Account.update(retry.model, current, ctx).model;
      model = Account.update(model, await runCommand(retry.commands, "LoadPasskeys"), ctx).model;
      expect(model.security.hasPassword).toMatchObject({ _tag: "Loaded", data: true });
      expect(
        Account.update(model, Account.Message.ClickedAskRemovePasskey({ id: "missing" }), ctx).model
          .security.removingId,
      ).toBeNull();
      const dialog = Account.update(model, ask, ctx).model;
      expect(dialog.security.removingId).toBe("key-1");
      const deletion = Account.update(dialog, confirm, ctx);
      expect(deletion.commands?.map((command) => command.name)).toEqual(["Account.DeletePasskey"]);
      expect(Account.update(deletion.model, confirm, ctx).commands).toBeUndefined();

      const refresh = Account.update(dialog, Account.Message.ClickedRetry(), ctx);
      expect(Account.update(refresh.model, confirm, ctx).commands).toBeUndefined();
    } finally {
      fetch.mockRestore();
    }
  });

  it("reloads the stored list after registering a passkey", async () => {
    const route: Account.Route = { _tag: "Account", tab: "security" };
    const ctx = ctxFor(route, { locale: "en" });
    const { model } = Account.init(route, ctx);
    const started = Account.update(model, Account.Message.ClickedAddPasskey(), ctx);
    expect(started.commands?.map((command) => command.name)).toEqual(["Account.AddPasskey"]);
    expect(
      Account.update(started.model, Account.Message.ClickedAddPasskey(), ctx).commands,
    ).toBeUndefined();
    const previousCredentials = Object.getOwnPropertyDescriptor(navigator, "credentials");
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: {
        create: async ({ publicKey }: CredentialCreationOptions) => {
          expect(publicKey?.challenge).toEqual(Uint8Array.of(1, 2, 3).buffer);
          return {
            id: "BAUG",
            rawId: Uint8Array.of(4, 5, 6).buffer,
            type: "public-key",
            authenticatorAttachment: "platform",
            getClientExtensionResults: () => ({}),
            response: {
              attestationObject: Uint8Array.of(7, 8, 9).buffer,
              clientDataJSON: Uint8Array.of(10, 11, 12).buffer,
            },
          };
        },
      },
    });
    const fetch = mockFetch(async (input, options) => {
      const url = new URL(String(input));
      switch (url.pathname) {
        case "/api/auth/passkey/generate-register-options":
          expect(options?.method).toBe("GET");
          expect(url.searchParams.get("name")).toBe("Passkey");
          return Response.json({
            challenge: "AQID",
            rp: { id: "localhost", name: "Kvitbit" },
            user: { id: "AQID", name: "demo@example.com", displayName: "Demo" },
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          });
        case "/api/auth/passkey/verify-registration":
          expect(options?.method).toBe("POST");
          expect(JSON.parse(String(options?.body))).toMatchObject({
            name: "Passkey",
            response: {
              id: "BAUG",
              response: { attestationObject: "BwgJ", clientDataJSON: "CgsM" },
            },
          });
          return Response.json({ status: true });
        case "/api/auth/passkey/list-user-passkeys":
          expect(options?.method).toBe("GET");
          return Response.json([{ id: "server-id", name: "Laptop", deviceType: "multiDevice" }]);
        default:
          throw new Error(`Unexpected account request: ${input}`);
      }
    });
    try {
      const response = await runCommand(started.commands, "AddPasskey");
      expect(response).toEqual(Account.Message.AddedPasskey());
      const verified = Account.update(started.model, response, ctx);
      expect(verified.model.security.passkeys).toEqual({ _tag: "Loading", seq: 2 });
      expect(verified.model.security.addingPasskey).toBe(false);
      const reply = await runCommand(verified.commands, "LoadPasskeys");
      const reloaded = Account.update(verified.model, reply, ctx).model;
      expect(reloaded.security.passkeys).toMatchObject({
        _tag: "Loaded",
        data: [{ id: "server-id", name: "Laptop" }],
      });
    } finally {
      fetch.mockRestore();
      if (previousCredentials === undefined) Reflect.deleteProperty(navigator, "credentials");
      else Object.defineProperty(navigator, "credentials", previousCredentials);
    }
  });

  it("labels the active Better Auth session and revokes another session by token", async () => {
    const route: Account.Route = { _tag: "Account", tab: "sessions" };
    const ctx = ctxFor(route, { locale: "en" });
    const requests: Array<{ method: string | undefined; path: string; body: RequestInit["body"] }> =
      [];
    const entries = [
      {
        id: "current-id",
        token: "current-token",
        updatedAt: "2026-05-01T00:00:00Z",
        userAgent: null,
      },
      {
        id: "other-id",
        token: "other-token",
        updatedAt: "2026-05-01T00:00:00Z",
        userAgent: "Firefox",
      },
    ];
    const fetch = mockFetch(async (input, options) => {
      const path = new URL(String(input)).pathname;
      requests.push({ method: options?.method, path, body: options?.body });
      switch (path) {
        case "/api/auth/get-session":
          return Response.json({ session: { id: "current-id" } });
        case "/api/auth/list-sessions":
          return Response.json(entries);
        case "/api/auth/revoke-session":
          return Response.json({ status: true });
        default:
          throw new Error(`Unexpected account request: ${input}`);
      }
    });
    try {
      const init = Account.init(route, ctx);
      const reply = await runCommand(init.commands, "LoadSessions");
      const loaded = Account.update(init.model, reply, ctx).model;
      expect(loaded.sessions.list).toMatchObject({
        _tag: "Loaded",
        data: [
          { id: "current-id", userAgent: "Browser session", current: true },
          { id: "other-id", userAgent: "Firefox", current: false },
        ],
      });
      for (const id of ["current-id", "missing-id"]) {
        expect(
          Account.update(loaded, Account.Message.ClickedRevokeSession({ id }), ctx).commands,
        ).toBeUndefined();
      }
      const revoked = Account.update(
        loaded,
        Account.Message.ClickedRevokeSession({ id: "other-id" }),
        ctx,
      );
      const complete = await runCommand(revoked.commands, "RevokeSession");
      expect(Account.update(revoked.model, complete, ctx).model.sessions.list).toMatchObject({
        data: [{ id: "current-id", current: true }],
      });
      expect(requests).toEqual([
        { method: "GET", path: "/api/auth/get-session", body: undefined },
        { method: "GET", path: "/api/auth/list-sessions", body: undefined },
        {
          method: "POST",
          path: "/api/auth/revoke-session",
          body: JSON.stringify({ token: "other-token" }),
        },
      ]);
    } finally {
      fetch.mockRestore();
    }
  });

  it("blocks Account deletion while sole owner of an open workspace and requires confirm phrase", async () => {
    const route: Account.Route = { _tag: "Account", tab: "danger" };
    // Default signedIn session owns a 1-member workspace (jana-osvc) -> shows blocker
    const blockedCtx = ctxFor(route, { locale: "en" });
    const { model: blockedModel } = Account.init(route, blockedCtx);
    const blockedHtml = await renderText((h) => Account.view(blockedModel, blockedCtx, h));
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
