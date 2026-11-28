/**
 * Shared Uniwind (Tailwind CSS v4) + CVA component recipes for `@kvitbit/mobile`.
 * Every color and radius utility resolves through `global.css` + `ThemeProvider`'s
 * `Uniwind.updateCSSVariables()` sync to Kvitbit's runtime Material 3 + Elegant/Cozy theme.
 */
import { cn, cva, type VariantProps } from "@kvitbit/ui-port/style";

export { cn, cva, type VariantProps };

export const buttonVariants = cva(
  "min-h-12 justify-center rounded-control px-5 active:opacity-85",
  {
    variants: {
      kind: {
        filled: "bg-primary",
        tonal: "bg-secondary-container",
        outlined: "border border-outline bg-transparent",
        text: "bg-transparent",
        danger: "bg-error",
      },
      disabled: {
        true: "opacity-40",
        false: "",
      },
    },
    defaultVariants: {
      kind: "filled",
      disabled: false,
    },
  },
);

export const cardVariants = cva("gap-2 rounded-panel p-4", {
  variants: {
    surface: {
      outlined: "border border-outline-variant bg-surface",
      tonal: "border-0 bg-surface-container-low",
    },
  },
  defaultVariants: { surface: "outlined" },
});

export const badgeVariants = cva("self-start rounded-badge px-2 py-0.5", {
  variants: {
    tone: {
      neutral: "bg-surface-container-highest",
      info: "bg-secondary-container",
      success: "bg-paid-container",
      warning: "bg-overdue-container",
      proforma: "bg-proforma-container",
      draft: "bg-draft-container",
      danger: "bg-error-container",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export const badgeTextVariants = cva("", {
  variants: {
    tone: {
      neutral: "text-on-surface-variant",
      info: "text-on-secondary-container",
      success: "text-on-paid-container",
      warning: "text-on-overdue-container",
      proforma: "text-on-proforma-container",
      draft: "text-on-draft-container",
      danger: "text-on-error-container",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export const bannerVariants = cva("flex-row items-center gap-2 rounded-panel p-3", {
  variants: {
    tone: {
      error: "bg-error-container",
      info: "bg-secondary-container",
      warning: "bg-overdue-container",
    },
  },
  defaultVariants: { tone: "error" },
});

export const chipVariants = cva("min-h-10 justify-center rounded-control border px-4", {
  variants: {
    selected: {
      true: "border-secondary-container bg-secondary-container",
      false: "border-outline bg-transparent",
    },
  },
  defaultVariants: { selected: false },
});

export const fieldBoxVariants = cva("min-h-14 flex-row items-center rounded-control", {
  variants: {
    state: {
      idle: "border border-outline",
      focused: "border-2 border-primary",
      error: "border-2 border-error",
    },
    disabled: {
      true: "bg-surface-container-highest",
      false: "bg-surface",
    },
  },
  defaultVariants: {
    state: "idle",
    disabled: false,
  },
});
