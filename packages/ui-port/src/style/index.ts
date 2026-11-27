import { EXTENDED_ROLES, M3_COLOR_ROLES } from "@kvitbit/api-contract";
import { cva, type VariantProps } from "class-variance-authority";
import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import type { EffectiveTheme } from "../theme/engine";
import { kebab } from "../theme/serialize";

export type { ClassValue };
export { cva, type VariantProps };

/**
 * Semantic Tailwind v4 token names bound to Kvitbit's Material 3 + Elegant/Cozy CSS variables.
 * Kept in one table so web (`@theme inline`) and mobile (`global.css` + `Uniwind.updateCSSVariables`)
 * expose the exact same utility classes (`bg-surface-container-lowest`, `rounded-panel`, etc.).
 */
export interface TailwindTokenBinding {
  readonly tailwindVar: `--${string}`;
  readonly sourceVar: `--${string}`;
}

export const TAILWIND_COLOR_TOKENS: ReadonlyArray<TailwindTokenBinding> = [
  ...M3_COLOR_ROLES.map((role) => {
    const name = kebab(role);
    return {
      tailwindVar: `--color-${name}` as const,
      sourceVar: `--md-sys-color-${name}` as const,
    };
  }),
  ...EXTENDED_ROLES.flatMap((role) => [
    {
      tailwindVar: `--color-${role}` as const,
      sourceVar: `--kb-color-${role}` as const,
    },
    {
      tailwindVar: `--color-on-${role}` as const,
      sourceVar: `--kb-color-on-${role}` as const,
    },
    {
      tailwindVar: `--color-${role}-container` as const,
      sourceVar: `--kb-color-${role}-container` as const,
    },
    {
      tailwindVar: `--color-on-${role}-container` as const,
      sourceVar: `--kb-color-on-${role}-container` as const,
    },
  ]),
];

export const TAILWIND_RADIUS_TOKENS: ReadonlyArray<TailwindTokenBinding> = [
  { tailwindVar: "--radius-panel", sourceVar: "--kb-shape-panel" },
  { tailwindVar: "--radius-control", sourceVar: "--kb-shape-control" },
  { tailwindVar: "--radius-badge", sourceVar: "--kb-shape-badge" },
];

export const TAILWIND_FONT_TOKENS: ReadonlyArray<TailwindTokenBinding> = [
  { tailwindVar: "--font-display", sourceVar: "--kb-font-display" },
  { tailwindVar: "--font-body", sourceVar: "--kb-font-body" },
  { tailwindVar: "--font-mono", sourceVar: "--kb-font-mono" },
];

export const TAILWIND_COLOR_NAMES: ReadonlyArray<string> = TAILWIND_COLOR_TOKENS.map((t) =>
  t.tailwindVar.slice("--color-".length),
);

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      radius: ["panel", "control", "badge"],
      font: ["display", "body", "mono"],
      color: [...TAILWIND_COLOR_NAMES],
    },
  },
});

/** Merges conditional class values and resolves Tailwind v4 utility conflicts cleanly. */
export const cn = (...inputs: ReadonlyArray<ClassValue>): string => twMerge(clsx(inputs));

/**
 * Runtime CSS variable map for Uniwind (`Uniwind.updateCSSVariables`). Maps every Material 3 role,
 * extended financial role, and active style radius directly to Tailwind v4 `--color-*` / `--radius-*`
 * theme variables so mobile components consume the exact same semantic utility classes as web.
 */
export const uniwindThemeVariables = (
  theme: EffectiveTheme,
): Readonly<Record<`--${string}`, string | number>> => {
  const out: Record<`--${string}`, string | number> = {};
  for (const role of M3_COLOR_ROLES) {
    out[`--color-${kebab(role)}`] = theme.roles[role];
  }
  for (const role of EXTENDED_ROLES) {
    const ext = theme.extended[role];
    out[`--color-${role}`] = ext.color;
    out[`--color-on-${role}`] = ext.onColor;
    out[`--color-${role}-container`] = ext.colorContainer;
    out[`--color-on-${role}-container`] = ext.onColorContainer;
  }
  out["--radius-panel"] = `${theme.tokens.shape.panel}px`;
  out["--radius-control"] = `${theme.tokens.shape.control}px`;
  out["--radius-badge"] = `${theme.tokens.shape.badge}px`;
  return out;
};
