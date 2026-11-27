/**
 * Shared Tailwind CSS v4 + CVA component recipes and layout utility presets for `@kvitbit/web`.
 * Every color, radius and font utility resolves through `@theme inline` in `src/styles/index.css`
 * to Kvitbit's runtime Material 3 and Elegant/Cozy CSS custom properties.
 */
import { cn, cva, type VariantProps } from "@kvitbit/ui-port/style";

export { cn, cva, type VariantProps };

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-control border font-medium cursor-pointer no-underline whitespace-nowrap transition-[background-color,border-color,color] duration-150 ease-out disabled:opacity-45 disabled:cursor-not-allowed aria-disabled:opacity-45 aria-disabled:cursor-not-allowed data-[disabled]:opacity-45 data-[disabled]:cursor-not-allowed aria-[busy=true]:cursor-progress aria-[busy=true]:opacity-80 data-[pending]:cursor-progress data-[pending]:opacity-80",
  {
    variants: {
      variant: {
        secondary:
          "bg-surface-container-lowest text-on-surface border-outline-variant hover:bg-[color-mix(in_srgb,var(--md-sys-color-surface-container-lowest)_92%,var(--md-sys-color-on-surface))] active:bg-[color-mix(in_srgb,var(--md-sys-color-surface-container-lowest)_86%,var(--md-sys-color-on-surface))]",
        primary:
          "bg-primary text-on-primary border-primary hover:bg-[color-mix(in_srgb,var(--md-sys-color-primary)_88%,var(--md-sys-color-surface))] active:bg-[color-mix(in_srgb,var(--md-sys-color-primary)_82%,var(--md-sys-color-surface))]",
        ghost:
          "bg-transparent text-on-surface border-transparent hover:bg-[color-mix(in_srgb,transparent_92%,var(--md-sys-color-on-surface))] active:bg-[color-mix(in_srgb,transparent_86%,var(--md-sys-color-on-surface))]",
        danger:
          "bg-error text-on-error border-error hover:bg-[color-mix(in_srgb,var(--md-sys-color-error)_90%,var(--md-sys-color-surface))] active:bg-[color-mix(in_srgb,var(--md-sys-color-error)_84%,var(--md-sys-color-surface))]",
      },
      size: {
        default: "min-h-9 px-3.5 text-[0.875rem]",
        small: "min-h-7 px-2.5 text-[0.8125rem]",
        icon: "min-h-9 w-9 p-0 text-[0.875rem]",
      },
      block: {
        true: "w-full",
        false: "",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "default",
      block: false,
    },
  },
);

export const cardVariants = cva(
  "rounded-panel border-[length:var(--kb-panel-border-width,1px)] border-outline-variant p-4",
  {
    variants: {
      flat: {
        false: "bg-surface-container-lowest",
        true: "bg-surface-container-low",
      },
    },
    defaultVariants: { flat: false },
  },
);

export const controlVariants = cva(
  "w-full min-h-9 rounded-control border border-outline bg-surface-container-lowest px-2.5 py-[7px] text-on-surface transition-[border-color,box-shadow] duration-150 ease-out hover:border-on-surface-variant focus-visible:outline-none focus-visible:border-primary focus-visible:shadow-[0_0_0_1px_var(--md-sys-color-primary)] aria-[invalid=true]:border-error [[data-invalid]_&]:border-error disabled:opacity-50 disabled:cursor-not-allowed data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed",
  {
    variants: {
      kind: {
        input: "",
        select: "",
        textarea: "min-h-20 resize-y",
      },
      compact: {
        true: "min-h-[30px] w-auto px-2 py-1 text-[0.8125rem]",
        false: "",
      },
    },
    defaultVariants: { kind: "input", compact: false },
  },
);

export const badgeVariants = cva(
  "inline-flex min-h-5 items-center gap-1 rounded-badge px-2 py-px text-[0.6875rem] font-semibold tracking-[0.02em] whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "bg-surface-container-high text-on-surface-variant",
        paid: "bg-paid-container text-on-paid-container",
        proforma: "bg-proforma-container text-on-proforma-container",
        overdue: "bg-overdue-container text-on-overdue-container",
        draft: "bg-draft-container text-on-draft-container",
        error: "bg-error-container text-on-error-container",
        outline: "border border-outline-variant bg-transparent text-on-surface-variant",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export const bannerVariants = cva("flex items-start gap-2.5 rounded-panel border px-3 py-2.5", {
  variants: {
    tone: {
      neutral: "border-outline-variant bg-surface-container text-on-surface",
      error: "border-transparent bg-error-container text-on-error-container",
      info: "border-transparent bg-primary-container text-on-primary-container",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export const toastVariants = cva(
  "flex items-center justify-between gap-3 rounded-control px-3.5 py-2.5 text-[0.875rem]",
  {
    variants: {
      tone: {
        info: "bg-inverse-surface text-inverse-on-surface",
        error: "bg-error text-on-error",
      },
    },
    defaultVariants: { tone: "info" },
  },
);

export const barToneVariants = cva("w-[min(1rem,45%)] min-h-px rounded-t-[2px]", {
  variants: {
    tone: {
      primary: "bg-primary",
      secondary: "bg-secondary",
      overdue: "bg-error",
    },
  },
  defaultVariants: { tone: "primary" },
});

export const chipVariants = cva(
  "inline-flex min-h-[30px] cursor-pointer items-center gap-1.5 rounded-badge border px-3 text-[0.8125rem] font-medium transition-[background-color,border-color,color] duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-45",
  {
    variants: {
      active: {
        false:
          "border-outline-variant bg-surface-container-lowest text-on-surface-variant hover:border-outline hover:text-on-surface aria-[pressed=true]:border-primary aria-[pressed=true]:bg-primary-container aria-[pressed=true]:text-on-primary-container",
        true: "border-primary bg-primary-container text-on-primary-container",
      },
    },
    defaultVariants: { active: false },
  },
);

export const segmentedButtonVariants = cva(
  "grid cursor-pointer select-none place-items-center border-0 bg-transparent text-center text-[0.8125rem] text-on-surface-variant [&+&]:border-l [&+&]:border-outline-variant data-[checked]:text-on-primary-container aria-[checked=true]:text-on-primary-container [&[aria-checked=true]:not([data-checked])]:bg-primary-container",
  {
    variants: {
      sizing: {
        equal: "flex-1 basis-0 px-2 py-1.5",
        auto: "flex-1 basis-auto px-2.5 py-1.5",
      },
    },
    defaultVariants: { sizing: "equal" },
  },
);

export const botProofVariants = cva(
  "flex items-center justify-between gap-2.5 rounded-control border px-3 py-2.5 text-[0.8125rem] data-[active=false]:invisible",
  {
    variants: {
      state: {
        idle: [
          "border-outline-variant bg-surface-container-low text-on-surface",
          "motion-safe:after:size-[1em] motion-safe:after:flex-none motion-safe:after:rounded-full motion-safe:after:border-2 motion-safe:after:border-outline-variant motion-safe:after:border-s-current",
          "motion-safe:data-[active=true]:after:animate-spin motion-safe:data-[active=true]:after:[--animate-spin:spin_800ms_linear_infinite]",
        ],
        verified: "border-paid bg-paid-container text-on-paid-container",
        failed: "border-error bg-error-container text-on-error-container",
      },
    },
    defaultVariants: { state: "idle" },
  },
);

export const dropzoneVariants = cva(
  "flex flex-wrap items-center justify-between gap-3 rounded-panel border border-dashed px-5 py-4 transition-[background-color,border-color] duration-150 ease-out",
  {
    variants: {
      active: {
        false: "border-outline bg-surface-container-low",
        true: "border-primary bg-primary-container text-on-primary-container",
      },
    },
    defaultVariants: { active: false },
  },
);

export const selectableCardVariants = cva(
  "flex cursor-pointer text-left border rounded-panel transition-[background-color,border-color] duration-150 ease-out",
  {
    variants: {
      layout: {
        column: "flex-col gap-1.5 p-3.5",
        row: "items-center gap-2.5 px-3 py-2.5",
      },
      selected: {
        false: "border-outline-variant bg-surface-container-low hover:bg-surface-container",
        true: "border-primary bg-surface-container-lowest shadow-[inset_0_0_0_1px_var(--md-sys-color-primary)]",
      },
    },
    defaultVariants: { layout: "column", selected: false },
  },
);

/** Common layout & typography utility constants composed via `cn(...)`. */
export const ui = {
  stack: "flex flex-col gap-[var(--kb-gap,12px)]",
  row: "flex flex-wrap items-center gap-[var(--kb-gap,8px)]",
  spread: "flex flex-wrap items-center justify-between gap-3",
  grid: "grid gap-4 grid-cols-[repeat(auto-fit,minmax(var(--kb-grid-min,240px),1fr))]",
  muted: "text-on-surface-variant",
  small: "text-[0.75rem] leading-4",
  footnote: "text-[0.6875rem] leading-[0.875rem] text-on-surface-variant",
  mono: "font-mono text-[0.8125rem] tracking-normal",
  num: "kb-num",
  divider:
    "my-1 block h-px border-0 bg-outline-variant data-[orientation=vertical]:mx-1 data-[orientation=vertical]:my-0 data-[orientation=vertical]:h-auto data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch",
  field: "flex min-w-0 flex-col gap-1",
  fieldLabel: "block text-[0.8125rem] font-medium text-on-surface",
  fieldHint: "block text-[0.75rem] text-on-surface-variant",
  fieldError: "block text-[0.75rem] text-error",
  formGrid: "grid grid-cols-1 gap-3 sm:grid-cols-2",
  formGrid3: "grid grid-cols-1 gap-3 sm:grid-cols-3",
  formGridAuto: "grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3.5",
  menuItem:
    "flex w-full cursor-pointer items-center gap-2 rounded-control border-0 bg-transparent px-2.5 py-2 text-left text-inherit no-underline hover:bg-surface-container focus-visible:bg-surface-container data-[highlighted]:bg-surface-container",
  navItem:
    "flex items-center gap-2.5 rounded-control px-2.5 py-2 font-medium text-on-surface-variant no-underline hover:bg-surface-container hover:text-on-surface aria-[current=page]:bg-primary-container aria-[current=page]:text-on-primary-container",
  navItemMobile:
    "flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-control px-0.5 py-1.5 text-[0.6875rem] font-medium text-on-surface-variant no-underline hover:bg-surface-container hover:text-on-surface aria-[current=page]:bg-primary-container aria-[current=page]:text-on-primary-container",
  kbd: "rounded-[4px] border border-outline-variant bg-surface-container-low px-[5px] py-0.5 font-mono text-[0.6875rem] leading-none text-on-surface-variant",
} as const;
