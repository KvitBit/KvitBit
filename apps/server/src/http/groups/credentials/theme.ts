/**
 * Local Material 3 theme resolution for `me` account preferences (http-mcp-contracts 3.5.2,
 * rules T1-T3). Returns `null` when `source` is `null`; validates Material Theme Builder JSON
 * size and structure, generates all six contrast schemes, and emits `theme.low_contrast` when
 * a supplied scheme fails the 4.5:1 floor on `onPrimary`/`primary` or `onSurface`/`surface`.
 */
import {
  type ExtendedColor,
  type Hex,
  M3_COLOR_ROLES,
  type M3ColorRole,
  type ResolvedScheme,
  type ResolvedTheme,
  THEME_JSON_MAX_BYTES,
  ThemePresets,
  type ThemeSource,
  type ThemeWarning,
} from "@kvitbit/api-contract";
import { Invalid } from "@kvitbit/domain/contract";
import { Effect } from "effect";

const HEX_PATTERN = /^#[0-9A-Fa-f]{6}$/;

const isHex = (value: unknown): value is Hex =>
  typeof value === "string" && HEX_PATTERN.test(value);

const parseRgb = (hex: Hex): readonly [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

const toHex = (r: number, g: number, b: number): Hex =>
  `#${[r, g, b]
    .map((n) =>
      Math.max(0, Math.min(255, Math.round(n)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")
    .toUpperCase()}` as Hex;

const mix = (a: Hex, b: Hex, t: number): Hex => {
  const [ar, ag, ab] = parseRgb(a);
  const [br, bg, bb] = parseRgb(b);
  return toHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
};

const channelLuminance = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const relativeLuminance = (hex: Hex): number => {
  const [r, g, b] = parseRgb(hex);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
};

const contrastRatio = (fg: Hex, bg: Hex): number => {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
};

const pickOnColor = (bg: Hex): Hex =>
  contrastRatio("#FFFFFF", bg) >= contrastRatio("#111111", bg) ? "#FFFFFF" : "#111111";

const extendedFromSeed = (seed: Hex, dark: boolean): ExtendedColor => {
  const color = dark ? mix(seed, "#FFFFFF", 0.35) : mix(seed, "#000000", 0.12);
  const colorContainer = dark ? mix(seed, "#000000", 0.55) : mix(seed, "#FFFFFF", 0.82);
  return {
    color,
    onColor: pickOnColor(color),
    colorContainer,
    onColorContainer: pickOnColor(colorContainer),
  };
};

const buildSchemeFromSeed = (
  seed: Hex,
  dark: boolean,
  contrast: "standard" | "medium" | "high",
): ResolvedScheme => {
  const contrastBoost = contrast === "high" ? 0.22 : contrast === "medium" ? 0.1 : 0;
  const primary = dark
    ? mix(seed, "#FFFFFF", Math.min(0.85, 0.45 + contrastBoost))
    : mix(seed, "#000000", Math.min(0.85, 0.15 + contrastBoost));
  const onPrimary = pickOnColor(primary);
  const primaryContainer = dark ? mix(seed, "#000000", 0.45) : mix(seed, "#FFFFFF", 0.8);
  const onPrimaryContainer = pickOnColor(primaryContainer);
  const secondary = dark ? mix(seed, "#CBD5E1", 0.55) : mix(seed, "#475569", 0.45);
  const onSecondary = pickOnColor(secondary);
  const secondaryContainer = dark
    ? mix(secondary, "#000000", 0.55)
    : mix(secondary, "#FFFFFF", 0.82);
  const onSecondaryContainer = pickOnColor(secondaryContainer);
  const tertiary = dark ? mix(seed, "#E2E8F0", 0.65) : mix(seed, "#334155", 0.55);
  const onTertiary = pickOnColor(tertiary);
  const tertiaryContainer = dark ? mix(tertiary, "#000000", 0.55) : mix(tertiary, "#FFFFFF", 0.84);
  const onTertiaryContainer = pickOnColor(tertiaryContainer);

  const surface: Hex = dark ? "#121316" : "#FAFAFB";
  const onSurface: Hex = dark ? "#F4F4F5" : "#111111";
  const surfaceVariant: Hex = dark ? "#27272A" : "#E4E4E7";
  const onSurfaceVariant: Hex = dark ? "#D4D4D8" : "#3F3F46";

  const roles: Record<M3ColorRole, Hex> = {
    primary,
    onPrimary,
    primaryContainer,
    onPrimaryContainer,
    primaryFixed: mix(seed, "#FFFFFF", 0.8),
    primaryFixedDim: mix(seed, "#FFFFFF", 0.6),
    onPrimaryFixed: "#111111",
    onPrimaryFixedVariant: "#27272A",
    inversePrimary: dark ? mix(seed, "#000000", 0.2) : mix(seed, "#FFFFFF", 0.5),
    secondary,
    onSecondary,
    secondaryContainer,
    onSecondaryContainer,
    secondaryFixed: mix(secondary, "#FFFFFF", 0.82),
    secondaryFixedDim: mix(secondary, "#FFFFFF", 0.62),
    onSecondaryFixed: "#111111",
    onSecondaryFixedVariant: "#27272A",
    tertiary,
    onTertiary,
    tertiaryContainer,
    onTertiaryContainer,
    tertiaryFixed: mix(tertiary, "#FFFFFF", 0.84),
    tertiaryFixedDim: mix(tertiary, "#FFFFFF", 0.64),
    onTertiaryFixed: "#111111",
    onTertiaryFixedVariant: "#27272A",
    error: dark ? "#FCA5A5" : "#B91C1C",
    onError: dark ? "#450A0A" : "#FFFFFF",
    errorContainer: dark ? "#7F1D1D" : "#FEE2E2",
    onErrorContainer: dark ? "#FEE2E2" : "#7F1D1D",
    background: surface,
    onBackground: onSurface,
    surface,
    onSurface,
    surfaceVariant,
    onSurfaceVariant,
    surfaceDim: dark ? "#0E0F12" : "#E4E4E7",
    surfaceBright: dark ? "#2E3036" : "#FFFFFF",
    surfaceContainerLowest: dark ? "#09090B" : "#FFFFFF",
    surfaceContainerLow: dark ? "#18181B" : "#F4F4F5",
    surfaceContainer: dark ? "#1E1F23" : "#EFEFF1",
    surfaceContainerHigh: dark ? "#27282D" : "#E8E8EC",
    surfaceContainerHighest: dark ? "#323339" : "#E2E2E7",
    surfaceTint: primary,
    inverseSurface: dark ? "#F4F4F5" : "#18181B",
    inverseOnSurface: dark ? "#18181B" : "#F4F4F5",
    outline: dark ? "#71717A" : "#71717A",
    outlineVariant: dark ? "#3F3F46" : "#D4D4D8",
    shadow: "#000000",
    scrim: "#000000",
  };

  return {
    roles,
    extended: {
      paid: extendedFromSeed("#15803D", dark),
      proforma: extendedFromSeed("#1D4ED8", dark),
      overdue: extendedFromSeed("#B91C1C", dark),
      draft: extendedFromSeed("#52525B", dark),
    },
  };
};

const schemesFromSeed = (seed: Hex): ResolvedTheme["schemes"] => ({
  light: buildSchemeFromSeed(seed, false, "standard"),
  dark: buildSchemeFromSeed(seed, true, "standard"),
  lightMedium: buildSchemeFromSeed(seed, false, "medium"),
  lightHigh: buildSchemeFromSeed(seed, false, "high"),
  darkMedium: buildSchemeFromSeed(seed, true, "medium"),
  darkHigh: buildSchemeFromSeed(seed, true, "high"),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const mergeSuppliedScheme = (
  fallback: ResolvedScheme,
  raw: unknown,
): { readonly scheme: ResolvedScheme; readonly lowContrast: boolean } => {
  if (!isRecord(raw)) return { scheme: fallback, lowContrast: false };
  const roles = { ...fallback.roles };
  for (const role of M3_COLOR_ROLES) {
    const candidate = raw[role];
    if (isHex(candidate)) {
      roles[role] = candidate;
    }
  }
  const lowContrast =
    contrastRatio(roles.onPrimary, roles.primary) < 4.5 ||
    contrastRatio(roles.onSurface, roles.surface) < 4.5;
  return {
    scheme: { roles, extended: fallback.extended },
    lowContrast,
  };
};

const resolveMaterialThemeBuilder = (
  source: Extract<ThemeSource, { readonly _tag: "MaterialThemeBuilder" }>,
): Effect.Effect<ResolvedTheme, Invalid> =>
  Effect.suspend(() => {
    const encoded = JSON.stringify(source.json);
    if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > THEME_JSON_MAX_BYTES) {
      return Effect.fail(
        new Invalid({
          issues: [{ path: ["theme", "source", "json"], code: "theme.too_large" }],
        }),
      );
    }
    if (!isRecord(source.json) || !isRecord(source.json.schemes)) {
      return Effect.fail(
        new Invalid({
          issues: [{ path: ["theme", "source", "json"], code: "theme.json_invalid" }],
        }),
      );
    }
    const seed = isHex(source.json.seed) ? source.json.seed : ThemePresets.graphite_atelier.seed;
    const base = schemesFromSeed(seed);
    const rawSchemes = source.json.schemes;
    if (!isRecord(rawSchemes.light) || !isRecord(rawSchemes.dark)) {
      return Effect.fail(
        new Invalid({
          issues: [{ path: ["theme", "source", "json"], code: "theme.json_invalid" }],
        }),
      );
    }
    const light = mergeSuppliedScheme(base.light, rawSchemes.light);
    const dark = mergeSuppliedScheme(base.dark, rawSchemes.dark);
    const lightMedium = mergeSuppliedScheme(
      base.lightMedium,
      rawSchemes["light-medium-contrast"] ?? rawSchemes.lightMedium,
    );
    const lightHigh = mergeSuppliedScheme(
      base.lightHigh,
      rawSchemes["light-high-contrast"] ?? rawSchemes.lightHigh,
    );
    const darkMedium = mergeSuppliedScheme(
      base.darkMedium,
      rawSchemes["dark-medium-contrast"] ?? rawSchemes.darkMedium,
    );
    const darkHigh = mergeSuppliedScheme(
      base.darkHigh,
      rawSchemes["dark-high-contrast"] ?? rawSchemes.darkHigh,
    );

    const anyLowContrast =
      light.lowContrast ||
      dark.lowContrast ||
      lightMedium.lowContrast ||
      lightHigh.lowContrast ||
      darkMedium.lowContrast ||
      darkHigh.lowContrast;
    const warnings: ReadonlyArray<ThemeWarning> | undefined = anyLowContrast
      ? ["theme.low_contrast"]
      : undefined;

    return Effect.succeed({
      source,
      schemes: {
        light: light.scheme,
        dark: dark.scheme,
        lightMedium: lightMedium.scheme,
        lightHigh: lightHigh.scheme,
        darkMedium: darkMedium.scheme,
        darkHigh: darkHigh.scheme,
      },
      ...(warnings === undefined ? {} : { warnings }),
    });
  });

/** Resolves a `ThemeSource` (or `null`) into a `ResolvedTheme` (or `null`). */
export const resolveThemeSource = (
  source: ThemeSource | null,
): Effect.Effect<ResolvedTheme | null, Invalid> => {
  if (source === null) return Effect.succeed(null);
  switch (source._tag) {
    case "Preset":
      return Effect.succeed({
        source,
        schemes: schemesFromSeed(ThemePresets[source.id].seed),
      });
    case "Seed":
      return Effect.succeed({
        source,
        schemes: schemesFromSeed(source.seed),
      });
    case "MaterialThemeBuilder":
      return resolveMaterialThemeBuilder(source);
  }
};
