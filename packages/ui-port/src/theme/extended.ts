/**
 * Financial status colours (`paid`, `proforma`, `overdue`, `draft`), harmonized toward the
 * scheme's primary with `Blend.harmonize` semantics and laid out on the accent tone table, so
 * they reach the same contrast as `primary` / `primaryContainer` in every variant.
 */

import type { ExtendedColor, ExtendedRole, Hex, ResolvedScheme } from "@kvitbit/api-contract";
import * as Fn from "effect/Function";
import { harmonize } from "./color/blend";
import { Hct } from "./color/hct";
import { TonalPalette } from "./color/palette";
import { hexFromRgb, isHex, type Rgb, rgbFromHex } from "./color/utils";
import { ACCENT_TONES, contrastLevelOf, isDarkVariant, type SchemeVariant } from "./scheme";

export type ExtendedScheme = ResolvedScheme["extended"];

/**
 * Source colours before harmonization: a ledger green, a cobalt for pro forma (issued but not a
 * tax document), a burnt vermilion for overdue kept apart from `error`'s red, and a cool slate
 * for drafts.
 */
export const EXTENDED_SOURCE_COLORS: Readonly<Record<ExtendedRole, Hex>> = {
  paid: "#1F8A4C",
  proforma: "#2F5FD0",
  overdue: "#C2410C",
  draft: "#5B6B80",
};

/** Below this chroma a primary has no meaningful hue to harmonize toward (Graphite Atelier). */
const HARMONIZE_MIN_PRIMARY_CHROMA = 8;

/** Harmonize `color` toward `primary`; an achromatic primary leaves it unchanged. */
const harmonizeToward = (color: Rgb, primary: Rgb): Rgb =>
  Hct.fromRgb(primary).chroma < HARMONIZE_MIN_PRIMARY_CHROMA ? color : harmonize(color, primary);

const tonesFor = (variant: SchemeVariant) => {
  const level = contrastLevelOf(variant);
  const side = isDarkVariant(variant) ? "dark" : "light";
  return {
    color: ACCENT_TONES.color[side][level],
    onColor: ACCENT_TONES.onColor[side][level],
    container: ACCENT_TONES.container[side][level],
    onContainer: ACCENT_TONES.onContainer[side][level],
  };
};

/** One extended colour's four roles from an (already harmonized) key colour. */
const extendedColorOf = (key: Rgb, variant: SchemeVariant): ExtendedColor => {
  const palette = TonalPalette.fromRgb(key);
  const t = tonesFor(variant);
  return {
    color: hexFromRgb(palette.tone(t.color)),
    onColor: hexFromRgb(palette.tone(t.onColor)),
    colorContainer: hexFromRgb(palette.tone(t.container)),
    onColorContainer: hexFromRgb(palette.tone(t.onContainer)),
  };
};

export interface ExtendedInput {
  /** The colour to lay out; harmonized toward `primary` when `harmonized` is true. */
  readonly color: Hex;
  readonly harmonized: boolean;
}

/**
 * All four extended colours for one variant against `primary` (a source colour, usually the
 * seed or the light primary). `inputs` replaces the built-in sources, e.g. from a Material Theme
 * Builder file's `extendedColors`.
 */
export const extendedScheme: {
  (
    primary: Hex,
    variant: SchemeVariant,
    inputs?: Partial<Record<ExtendedRole, ExtendedInput>>,
  ): ExtendedScheme;
  (
    variant: SchemeVariant,
    inputs?: Partial<Record<ExtendedRole, ExtendedInput>>,
  ): (primary: Hex) => ExtendedScheme;
} = Fn.dual(
  (args) => typeof args[1] === "string",
  (
    primary: Hex,
    variant: SchemeVariant,
    inputs: Partial<Record<ExtendedRole, ExtendedInput>> = {},
  ): ExtendedScheme => {
    // A malformed primary (e.g. from a platform API) harmonizes nothing rather than toward black.
    const p = isHex(primary) ? rgbFromHex(primary) : undefined;
    const one = (role: ExtendedRole): ExtendedColor => {
      const input = inputs[role] ?? { color: EXTENDED_SOURCE_COLORS[role], harmonized: true };
      const key = rgbFromHex(input.color);
      return extendedColorOf(
        input.harmonized && p !== undefined ? harmonizeToward(key, p) : key,
        variant,
      );
    };
    return {
      paid: one("paid"),
      proforma: one("proforma"),
      overdue: one("overdue"),
      draft: one("draft"),
    };
  },
);
