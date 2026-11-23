import { describe, expect, test } from "bun:test";
import { Effect, Exit, Option } from "effect";
import {
  dynamicRoles,
  effectiveTheme,
  harmonizeExtended,
  initialThemeState,
  KvitbitDefaultTheme,
  LocalThemeEngine,
  resolvePreset,
  resolveSeed,
  StyleTokens,
  ThemeEngine,
  type ThemeState,
} from "../../src/theme";

const account = resolvePreset("plum");
const workspace = resolvePreset("forest");
const dynamic = dynamicRoles({ _tag: "Seed", seed: "#B3261E" });

const state = (patch: {
  preference?: Partial<ThemeState["preference"]>;
  system?: Partial<ThemeState["system"]>;
  account?: ThemeState["account"];
  workspace?: ThemeState["workspace"];
  draft?: ThemeState["draft"];
}): ThemeState => {
  const base = initialThemeState();
  return {
    ...base,
    ...patch,
    preference: { ...base.preference, ...patch.preference },
    system: { ...base.system, ...patch.system },
  };
};

describe("effectiveTheme precedence (spec 4.1)", () => {
  test("falls back to Graphite Atelier", () => {
    const e = effectiveTheme(state({}));
    expect(e.origin).toBe("default");
    expect(e.roles).toEqual(KvitbitDefaultTheme.schemes.light.roles);
  });

  test("workspace, then account", () => {
    expect(effectiveTheme(state({ workspace: Option.some(workspace) })).origin).toBe("workspace");
    const e = effectiveTheme(
      state({ workspace: Option.some(workspace), account: Option.some(account) }),
    );
    expect(e.origin).toBe("account");
    expect(e.roles).toEqual(account.schemes.light.roles);
  });

  test("dynamic colour wins when enabled and available, with harmonized extended colours", () => {
    const s = state({ account: Option.some(account), system: { dynamic: Option.some(dynamic) } });
    const e = effectiveTheme(s);
    expect(e.origin).toBe("dynamic");
    expect(e.roles).toEqual(dynamic.light);
    expect(e.extended).toEqual(
      harmonizeExtended({ light: dynamic.light.primary, dark: dynamic.dark.primary }, "standard")
        .light,
    );
    expect(Option.isNone(e.theme)).toBe(true);
    expect(
      effectiveTheme({ ...s, preference: { ...s.preference, dynamicColor: false } }).origin,
    ).toBe("account");
  });

  test("a draft wins while previewed", () => {
    const draft = resolveSeed("#FF8A00");
    const s = state({
      account: Option.some(account),
      system: { dynamic: Option.some(dynamic) },
      draft: Option.some({ _tag: "Branding", theme: draft }),
    });
    expect(effectiveTheme(s).origin).toBe("draft");
    expect(effectiveTheme(s).roles).toEqual(draft.schemes.light.roles);
  });

  test("style follows an Appearance draft, never a Branding draft", () => {
    const appearance = state({
      account: Option.some(account),
      draft: Option.some({ _tag: "Appearance", theme: Option.none(), style: "cozy" }),
    });
    const e = effectiveTheme(appearance);
    expect([e.origin, e.style, e.tokens]).toEqual(["account", "cozy", StyleTokens.cozy]);
    const branding = state({ draft: Option.some({ _tag: "Branding", theme: workspace }) });
    expect(effectiveTheme(branding).style).toBe("elegant");
  });

  test("dynamic dark harmonizes toward the dark system primary", () => {
    const s = state({ system: { dynamic: Option.some(dynamic), scheme: "dark" } });
    expect(effectiveTheme(s).extended).toEqual(
      harmonizeExtended({ light: dynamic.light.primary, dark: dynamic.dark.primary }, "standard")
        .dark,
    );
  });

  test("mode and contrast pick the scheme variant", () => {
    const dark = effectiveTheme(
      state({ account: Option.some(account), system: { scheme: "dark" } }),
    );
    expect([dark.scheme, dark.roles]).toEqual(["dark", account.schemes.dark.roles]);
    const forcedLight = effectiveTheme(
      state({
        account: Option.some(account),
        preference: { mode: "light" },
        system: { scheme: "dark" },
      }),
    );
    expect(forcedLight.scheme).toBe("light");
    const raised = effectiveTheme(
      state({ account: Option.some(account), system: { highContrast: true } }),
    );
    expect([raised.contrast, raised.roles]).toEqual(["medium", account.schemes.lightMedium.roles]);
    const high = effectiveTheme(
      state({
        account: Option.some(account),
        preference: { contrast: "high" },
        system: { highContrast: true },
      }),
    );
    expect(high.contrast).toBe("high");
  });
});

describe("dynamic colour input", () => {
  test("a partial system role map is completed from its primary", () => {
    const roles = dynamicRoles({
      _tag: "Roles",
      light: { primary: "#4a6b2f", onPrimary: "#ffffff", surface: "not-a-colour" },
      dark: { primary: "#AFD38D" },
    });
    expect(roles.light.primary).toBe("#4A6B2F");
    expect(roles.light.onPrimary).toBe("#FFFFFF");
    expect(roles.light.surface).toMatch(/^#[0-9A-F]{6}$/);
    expect(roles.dark.primary).toBe("#AFD38D");
    expect(Object.keys(roles.dark)).toHaveLength(
      Object.keys(KvitbitDefaultTheme.schemes.dark.roles).length,
    );
  });
});

describe("ThemeEngine seam", () => {
  const run = <A, E>(eff: Effect.Effect<A, E, ThemeEngine>) =>
    Effect.runSyncExit(Effect.provide(eff, LocalThemeEngine));
  const withEngine = <A, E>(f: (engine: ThemeEngine["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      return yield* f(yield* ThemeEngine);
    });

  test("LocalThemeEngine resolves presets and seeds", () => {
    const exit = run(withEngine((e) => e.resolve({ _tag: "Preset", id: "sand" }, "standard")));
    expect(Exit.isSuccess(exit) && exit.value).toEqual(resolvePreset("sand"));
  });

  test("LocalThemeEngine fails a bad Theme Builder file with Invalid", () => {
    const exit = run(
      withEngine((e) => e.resolve({ _tag: "MaterialThemeBuilder", json: {} }, "standard")),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("harmonizeExtended matches the seed-resolved theme's extended colours", () => {
    const seed = resolveSeed("#1D4ED8");
    const exit = run(
      withEngine((e) => e.harmonizeExtended({ light: "#1D4ED8", dark: "#1D4ED8" }, "high")),
    );
    expect(Exit.isSuccess(exit) && exit.value).toEqual({
      light: seed.schemes.lightHigh.extended,
      dark: seed.schemes.darkHigh.extended,
    });
  });
});
