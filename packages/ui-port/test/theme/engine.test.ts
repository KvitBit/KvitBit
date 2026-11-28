import { describe, expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import { UiError } from "../../src/api/errors";
import {
  auditScheme,
  CHECKED_ROLE_PAIRS,
  contrastRatio,
  dynamicRoles,
  dynamicSchemeRoles,
  effectiveTheme,
  failingPairs,
  feasibleLuminance,
  Hct,
  harmonizeExtended,
  initialThemeState,
  KvitbitDefaultTheme,
  LocalThemeEngine,
  resolvePreset,
  resolveSeed,
  rgbFromHex,
  SCHEME_VARIANTS,
  StyleTokens,
  ThemeEngine,
  type ThemeState,
  variantOf,
} from "../../src/theme";
import { exhaustiveColor } from "../../src/theme/contrast-check";

const account = resolvePreset("plum");
const workspace = resolvePreset("forest");
/** Bun's default is 5 s; the exhaustive searches below get margin for a loaded CI machine. */
const HEAVY_TIMEOUT = 20_000;
const UPPERCASE_HEX = /^#[0-9A-F]{6}$/;
const dynamic = Result.getOrThrow(dynamicRoles({ _tag: "Seed", seed: "#B3261E" }));

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
    const roles = Result.getOrThrow(
      dynamicRoles({
        _tag: "Roles",
        light: { primary: "#4a6b2f", onPrimary: "#ffffff", surface: "not-a-colour" },
        dark: { primary: "#AFD38D" },
      }),
    );
    expect(roles.light.primary).toBe("#4A6B2F");
    expect(roles.light.onPrimary).toBe("#FFFFFF");
    expect(roles.light.surface).toMatch(UPPERCASE_HEX);
    expect(roles.dark.primary).toBe("#AFD38D");
    expect(Rec.keys(roles.dark)).toHaveLength(
      Rec.keys(KvitbitDefaultTheme.schemes.dark.roles).length,
    );
  });
});

describe("dynamic colour hardening", () => {
  test("generated foregrounds reach AA against supplied system backgrounds", () => {
    // A system that supplies a dark surface in its *light* map but no onSurface.
    const roles = Result.getOrThrow(
      dynamicRoles({ _tag: "Roles", light: { primary: "#4A6B2F", surface: "#1A1C18" }, dark: {} }),
    );
    expect(roles.light.surface).toBe("#1A1C18");
    expect(
      contrastRatio(rgbFromHex(roles.light.onSurface), rgbFromHex("#1A1C18")),
    ).toBeGreaterThanOrEqual(4.5);
  });

  test("a dark surface in a light system map yields an AA-clean effective scheme at every contrast", () => {
    const roles = Result.getOrThrow(
      dynamicRoles({ _tag: "Roles", light: { primary: "#4A6B2F", surface: "#1A1C18" }, dark: {} }),
    );
    for (const contrast of ["standard", "medium", "high"] as const) {
      const e = effectiveTheme(
        state({ preference: { contrast }, system: { dynamic: Option.some(roles) } }),
      );
      const failing = Arr.filter(
        auditScheme({ roles: e.roles, extended: e.extended }, variantOf("light", contrast)),
        (i) => !(i.foreground === "primary" && i.background === "surface"),
      );
      expect({ contrast, failing }).toEqual({ contrast, failing: [] });
      expect(e.roles.surface === "#1A1C18" || contrast !== "standard").toBe(true);
    }
  });

  test("a supplied dark onPrimary keeps its pairs AA after repair", () => {
    const roles = Result.getOrThrow(
      dynamicRoles({ _tag: "Roles", light: {}, dark: { onPrimary: "#777777" } }),
    );
    expect(roles.dark.onPrimary).toBe("#777777");
    for (const contrast of ["standard", "medium", "high"] as const) {
      const e = effectiveTheme(
        state({
          preference: { contrast },
          system: { scheme: "dark", dynamic: Option.some(roles) },
        }),
      );
      const variant: ReturnType<typeof variantOf> = variantOf("dark", contrast);
      expect({
        contrast,
        failing: auditScheme({ roles: e.roles, extended: e.extended }, variant),
      }).toEqual({
        contrast,
        failing: [],
      });
    }
  });

  test(
    "fuzz: realistic partial system maps resolve AA-clean in all six variants",
    () => {
      let randomState = 11;
      const rnd = () => {
        randomState = (randomState * 1103515245 + 12345) & 0x7fffffff;
        return randomState / 0x7fffffff;
      };
      const hex = () =>
        `#${Str.toUpperCase(
          Fn.pipe(Math.floor(rnd() * 0xffffff).toString(16), Str.padStart(6, "0")),
        )}`;
      const drop = (m: Record<string, string>) =>
        Rec.fromEntries(Arr.filter(Rec.toEntries(m), () => rnd() > 0.3));
      for (let i = 0; i < 20; i++) {
        const sys = resolveSeed(hex()).schemes;
        const d = Result.getOrThrow(
          dynamicRoles({ _tag: "Roles", light: drop(sys.light.roles), dark: drop(sys.dark.roles) }),
        );
        for (const v of SCHEME_VARIANTS) expect(failingPairs(dynamicSchemeRoles(d, v))).toEqual([]);
      }
    },
    HEAVY_TIMEOUT,
  );

  // The same 20 seeded cases as one loop took seconds under load, so they run in chunks: each test
  // stays well under bun's 5 s default even on a contended CI machine, with an explicit margin.
  const conflictingCases = (() => {
    let randomState = 7;
    const rnd = () => {
      randomState = (randomState * 1103515245 + 12345) & 0x7fffffff;
      return randomState / 0x7fffffff;
    };
    const hex = () =>
      `#${Str.toUpperCase(Fn.pipe(Math.floor(rnd() * 0xffffff).toString(16), Str.padStart(6, "0")))}`;
    const roles = Rec.keys(KvitbitDefaultTheme.schemes.light.roles);
    const pick = () =>
      Rec.fromEntries(
        Arr.map(
          Arr.filter(roles, () => rnd() < 0.08),
          (r) => [r, hex()] as const,
        ),
      );
    return Array.from({ length: 20 }, () => ({ light: pick(), dark: pick() }));
  })();
  const CONFLICTING_CHUNK = 2;
  for (let from = 0; from < conflictingCases.length; from += CONFLICTING_CHUNK) {
    const chunk = conflictingCases.slice(from, from + CONFLICTING_CHUNK);
    test(
      `fuzz: medium and high never fail, even for conflicting system colours (cases ${from}-${from + chunk.length - 1})`,
      () => {
        for (const supplied of chunk) {
          const d = Result.getOrThrow(dynamicRoles({ _tag: "Roles", ...supplied }));
          for (const v of ["lightMedium", "lightHigh", "darkMedium", "darkHigh"] as const)
            expect({ supplied, v, failing: failingPairs(dynamicSchemeRoles(d, v)) }).toEqual({
              supplied,
              v,
              failing: [],
            });
        }
      },
      HEAVY_TIMEOUT,
    );
  }

  test("a single supplied dark surfaceVariant survives and the effective dark scheme passes", () => {
    const roles = Result.getOrThrow(
      dynamicRoles({ _tag: "Roles", light: {}, dark: { surfaceVariant: "#777777" } }),
    );
    const e = effectiveTheme(state({ system: { scheme: "dark", dynamic: Option.some(roles) } }));
    expect(e.roles.surfaceVariant).toBe("#777777");
    expect(auditScheme({ roles: e.roles, extended: e.extended }, "dark")).toEqual([]);
  });

  test("a narrow feasible band between two supplied fixed backgrounds is found", () => {
    const roles = Result.getOrThrow(
      dynamicRoles({
        _tag: "Roles",
        light: { primaryFixed: "#000000", primaryFixedDim: "#FBFBFB" },
        dark: {},
      }),
    );
    const e = effectiveTheme(state({ system: { dynamic: Option.some(roles) } }));
    expect([e.roles.primaryFixed, e.roles.primaryFixedDim]).toEqual(["#000000", "#FBFBFB"]);
    expect(auditScheme({ roles: e.roles, extended: e.extended }, "light")).toEqual([]);
  });

  test("a narrow off-grey band (#000000 + #FBFDE2) is found", () => {
    const roles = Result.getOrThrow(
      dynamicRoles({
        _tag: "Roles",
        light: { primaryFixed: "#000000", primaryFixedDim: "#FBFDE2" },
        dark: {},
      }),
    );
    const e = effectiveTheme(state({ system: { dynamic: Option.some(roles) } }));
    expect([e.roles.primaryFixed, e.roles.primaryFixedDim]).toEqual(["#000000", "#FBFDE2"]);
    expect(auditScheme({ roles: e.roles, extended: e.extended }, "light")).toEqual([]);
  });

  test("an infeasible pair (#000000 + #EEEEEE) skips the exhaustive search", () => {
    const partners = [
      { color: "#000000", required: 4.5 },
      { color: "#EEEEEE", required: 4.5 },
    ];
    expect(feasibleLuminance(partners)).toEqual([]);
    const probe = { visited: 0 };
    expect(exhaustiveColor(Hct.fromRgb(0x757478), partners, probe)).toBeUndefined();
    expect(probe.visited).toBe(0);
    const feasible = { visited: 0 };
    expect(
      exhaustiveColor(
        Hct.fromRgb(0x757478),
        [
          { color: "#000000", required: 4.5 },
          { color: "#FBFDE2", required: 4.5 },
        ],
        feasible,
      ),
    ).toBeDefined();
    expect(feasible.visited).toBe(65536);
  });

  test(
    "two supplied backgrounds of one foreground pass whenever a feasible luminance exists",
    () => {
      const colours = ["#000000", "#FBFBFB", "#777777", "#1A1C18"];
      const byForeground = new Map<string, string[]>();
      for (const p of CHECKED_ROLE_PAIRS)
        byForeground.set(p.foreground, [...(byForeground.get(p.foreground) ?? []), p.background]);
      for (const [fg, bgs] of byForeground) {
        const [bgA, bgB] = bgs;
        if (bgA === undefined || bgB === undefined) continue;
        for (const a of colours)
          for (const b of colours) {
            const supplied = { [bgA]: a, [bgB]: b };
            const required = Arr.map(
              Arr.filter(
                CHECKED_ROLE_PAIRS,
                (p) => p.foreground === fg && (p.background === bgA || p.background === bgB),
              ),
              (p) => ({ color: supplied[p.background] ?? "", required: p.required }),
            );
            if (feasibleLuminance(required).length === 0) continue;
            for (const side of ["light", "dark"] as const) {
              const d = Result.getOrThrow(
                dynamicRoles({
                  _tag: "Roles",
                  light: side === "light" ? supplied : {},
                  dark: side === "dark" ? supplied : {},
                }),
              );
              const failing = Arr.filter(
                failingPairs(d[side]),
                (p) => !(p.foreground in supplied && p.background in supplied),
              );
              expect({ side, bgA, a, bgB, b, failing }).toEqual({
                side,
                bgA,
                a,
                bgB,
                b,
                failing: [],
              });
            }
          }
      }
    },
    HEAVY_TIMEOUT,
  );

  // one test per colour and side keeps each well under bun's default timeout on a loaded machine
  for (const colour of ["#777777", "#FFD600", "#0000FF"])
    for (const side of ["light", "dark"] as const)
      test(
        `any single supplied role leaves a passing standard scheme (${colour}, ${side})`,
        () => {
          for (const role of Rec.keys(KvitbitDefaultTheme.schemes.light.roles)) {
            const input =
              side === "light"
                ? { light: { [role]: colour }, dark: {} }
                : { light: {}, dark: { [role]: colour } };
            const d = Result.getOrThrow(dynamicRoles({ _tag: "Roles", ...input }));
            expect({ role, colour, side, failing: failingPairs(d[side]) }).toEqual({
              role,
              colour,
              side,
              failing: [],
            });
            expect(d[side][role]).toBe(colour);
          }
        },
        HEAVY_TIMEOUT,
      );

  test("a mid-grey system primary gets an onPrimary that reaches AA", () => {
    const roles = Result.getOrThrow(
      dynamicRoles({ _tag: "Roles", light: { primary: "#777774" }, dark: {} }),
    );
    expect(
      contrastRatio(rgbFromHex(roles.light.onPrimary), rgbFromHex("#777774")),
    ).toBeGreaterThanOrEqual(4.5);
  });

  test("a malformed dynamic seed fails with theme.seed_invalid", () => {
    const r = dynamicRoles({ _tag: "Seed", seed: "#12" });
    expect(Result.isFailure(r) && r.failure.issues[0]?.code).toBe("theme.seed_invalid");
  });

  test("requested contrast changes dynamic roles, keeping system hues", () => {
    const s = state({ system: { dynamic: Option.some(dynamic), highContrast: true } });
    const e = effectiveTheme(s);
    expect([e.origin, e.contrast]).toEqual(["dynamic", "medium"]);
    expect(e.roles).toEqual(dynamicSchemeRoles(dynamic, "lightMedium"));
    expect(e.roles.onSurfaceVariant).not.toBe(dynamic.light.onSurfaceVariant);
    expect(auditScheme({ roles: e.roles, extended: e.extended }, "lightMedium")).toEqual([]);
    expect(dynamicSchemeRoles(dynamic, "light")).toEqual(dynamic.light);
  });
});

describe("ThemeEngine seam", () => {
  const run = <A, E>(eff: Effect.Effect<A, E, ThemeEngine>) =>
    Effect.runSyncExit(Effect.provide(eff, LocalThemeEngine));
  const withEngine = Effect.fn("withEngine")(function* <A, E>(
    f: (engine: ThemeEngine["Service"]) => Effect.Effect<A, E>,
  ) {
    const engine = yield* ThemeEngine;
    return yield* f(engine);
  });

  test("LocalThemeEngine resolves presets and seeds", () => {
    expect(ThemeEngine.key).toBe("@kvitbit/ui-port/theme/engine/ThemeEngine");
    const exit = run(withEngine((e) => e.resolve({ _tag: "Preset", id: "sand" }, "standard")));
    expect(Exit.isSuccess(exit) && exit.value).toEqual(resolvePreset("sand"));
  });

  test("LocalThemeEngine rejects a malformed seed", () => {
    const exit = run(withEngine((e) => e.resolve({ _tag: "Seed", seed: "teal" }, "standard")));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("LocalThemeEngine fails a bad Theme Builder file with Invalid", () => {
    const exit = run(
      withEngine((e) => e.resolve({ _tag: "MaterialThemeBuilder", json: {} }, "standard")),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("harmonizeExtended matches the seed-resolved theme's extended colours", () => {
    const seed = resolveSeed("#1D4ED8").schemes;
    const primary = { light: seed.lightHigh.roles.primary, dark: seed.darkHigh.roles.primary };
    const exit = run(withEngine((e) => e.harmonizeExtended(primary, "high")));
    expect(Exit.isSuccess(exit) && exit.value).toEqual({
      light: seed.lightHigh.extended,
      dark: seed.darkHigh.extended,
    });
  });

  test("a remote layer can fail with UiError, and callers handle Offline directly", () => {
    const Remote = Layer.succeed(ThemeEngine, {
      resolve: Effect.fn("ThemeEngine.resolve")(() => Effect.fail(UiError.offline)),
      harmonizeExtended: Effect.fn("ThemeEngine.harmonizeExtended")(() =>
        Effect.fail(UiError.timeout),
      ),
    });
    const handled = Effect.runSync(
      Effect.provide(
        withEngine((e) => e.resolve({ _tag: "Preset", id: "plum" }, "standard")).pipe(
          Effect.as("resolved"),
          Effect.catchTag("Offline", () => Effect.succeed("offline")),
          Effect.orElseSucceed(() => "other"),
        ),
        Remote,
      ),
    );
    expect(handled).toBe("offline");
  });
});
