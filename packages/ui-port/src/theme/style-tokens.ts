/**
 * Typography and shape tokens per style (DESIGN.md "Selectable Styles"; spec 4.2 `StyleTokens`).
 * Style is orthogonal to colour: it never changes a role.
 */

import type { ThemeStyle } from "@kvitbit/api-contract";
import * as Fn from "effect/Function";

export const TYPE_SCALE_NAMES = [
  "displayLarge",
  "displayMedium",
  "displaySmall",
  "headlineLarge",
  "headlineMedium",
  "headlineSmall",
  "titleLarge",
  "titleMedium",
  "titleSmall",
  "bodyLarge",
  "bodyMedium",
  "bodySmall",
  "labelLarge",
  "labelMedium",
  "labelSmall",
] as const;
export type TypeScaleName = (typeof TYPE_SCALE_NAMES)[number];

/** DESIGN.md "Scale, Density": the fixed Operate scale for app screens. */
export const OPERATE_SCALE_NAMES = [
  "pageTitle",
  "sectionHeading",
  "body",
  "row",
  "meta",
  "footnote",
] as const;
export type OperateScaleName = (typeof OPERATE_SCALE_NAMES)[number];

export type FontRole = "display" | "body" | "mono";

/** One text style; sizes in px (CSS adapters divide by 16 for rem, RN uses them as dp/sp). */
export interface TypeStyle {
  readonly font: FontRole;
  readonly weight: 400 | 500 | 600;
  readonly size: number;
  readonly lineHeight: number;
  /** px. */
  readonly letterSpacing: number;
}

export interface StyleTokens {
  readonly font: {
    readonly display: { readonly family: string; readonly weight: 600 };
    readonly body: { readonly family: string; readonly weights: readonly [400, 500, 600] };
    readonly mono: { readonly family: "JetBrains Mono"; readonly weights: readonly [400, 500] };
    /** Elegant: lining tabular figures on amounts, dates and tables (Recia defaults to oldstyle). */
    readonly tabularNumerals: boolean;
    /** CSS `font-feature-settings` for numerals; "normal" when the face is lining by default. */
    readonly numericFeatureSettings: string;
  };
  readonly shape: {
    /** px: cards and panels. */
    readonly panel: number;
    /** px: buttons, inputs, sheets. */
    readonly control: number;
    /** px: status badges; 9999 renders as a pill. */
    readonly badge: number;
  };
  /** Elegant is flat with 1px `outlineVariant` borders; cozy uses M3 tonal surface steps. */
  readonly surface: "flat" | "tonal";
  /** px border width for panels in flat style; 0 when tonal steps separate surfaces. */
  readonly panelBorder: number;
  readonly typeScale: Readonly<Record<TypeScaleName, TypeStyle>>;
  readonly operateScale: Readonly<Record<OperateScaleName, TypeStyle>>;
}

const t = (
  font: FontRole,
  weight: TypeStyle["weight"],
  size: number,
  lineHeight: number,
  letterSpacing = 0,
): TypeStyle => ({ font, weight, size, lineHeight, letterSpacing });

/**
 * Material 3 type scale sizes and line heights. Display, headline and title use the display face
 * at 600 (DESIGN.md), body styles the body face at 400, labels the body face at 500.
 */
const M3_TYPE_SCALE: Readonly<Record<TypeScaleName, TypeStyle>> = {
  displayLarge: t("display", 600, 57, 64, -0.25),
  displayMedium: t("display", 600, 45, 52),
  displaySmall: t("display", 600, 36, 44),
  headlineLarge: t("display", 600, 32, 40),
  headlineMedium: t("display", 600, 28, 36),
  headlineSmall: t("display", 600, 24, 32),
  titleLarge: t("display", 600, 22, 28),
  titleMedium: t("body", 500, 16, 24, 0.15),
  titleSmall: t("body", 500, 14, 20, 0.1),
  bodyLarge: t("body", 400, 16, 24, 0.5),
  bodyMedium: t("body", 400, 14, 20, 0.25),
  bodySmall: t("body", 400, 12, 16, 0.4),
  labelLarge: t("body", 500, 14, 20, 0.1),
  labelMedium: t("body", 500, 12, 16, 0.5),
  labelSmall: t("body", 500, 11, 16, 0.5),
};

/** 1.125 / 0.9375 / 0.875 / 0.8125 / 0.75 / 0.6875 rem at a 16px root. */
const OPERATE_SCALE: Readonly<Record<OperateScaleName, TypeStyle>> = {
  pageTitle: t("display", 600, 18, 24),
  sectionHeading: t("display", 600, 15, 20),
  body: t("body", 400, 14, 20),
  row: t("body", 400, 13, 18),
  meta: t("body", 400, 12, 16),
  footnote: t("body", 400, 11, 14),
};

const MONO = { family: "JetBrains Mono", weights: [400, 500] } as const;
const BODY_WEIGHTS = [400, 500, 600] as const;

export const StyleTokens: Readonly<Record<ThemeStyle, StyleTokens>> = {
  elegant: {
    font: {
      display: { family: "Erode", weight: 600 },
      body: { family: "Recia", weights: BODY_WEIGHTS },
      mono: MONO,
      tabularNumerals: true,
      numericFeatureSettings: '"lnum" 1, "tnum" 1',
    },
    shape: { panel: 4, control: 4, badge: 3 },
    surface: "flat",
    panelBorder: 1,
    typeScale: M3_TYPE_SCALE,
    operateScale: OPERATE_SCALE,
  },
  cozy: {
    font: {
      display: { family: "Chillax", weight: 600 },
      body: { family: "Synonym", weights: BODY_WEIGHTS },
      mono: MONO,
      tabularNumerals: false,
      numericFeatureSettings: "normal",
    },
    shape: { panel: 12, control: 8, badge: 9999 },
    surface: "tonal",
    panelBorder: 0,
    typeScale: M3_TYPE_SCALE,
    operateScale: OPERATE_SCALE,
  },
};

const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO_STACK = 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';

/** CSS fallback stacks behind each style's Fontshare faces (Erode is a serif, Chillax a sans). */
export const FONT_FALLBACKS: Readonly<Record<ThemeStyle, Readonly<Record<FontRole, string>>>> = {
  elegant: { display: 'Georgia, "Times New Roman", serif', body: SANS, mono: MONO_STACK },
  cozy: { display: SANS, body: SANS, mono: MONO_STACK },
};

export const familyOf: {
  (font: FontRole): (tokens: StyleTokens) => string;
  (tokens: StyleTokens, font: FontRole): string;
} = Fn.dual(2, (tokens: StyleTokens, font: FontRole): string =>
  font === "display"
    ? tokens.font.display.family
    : font === "body"
      ? tokens.font.body.family
      : tokens.font.mono.family,
);
