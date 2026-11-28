# Use Tailwind CSS v4, CVA, cn, and Uniwind for UI styling

Accepted 2026-11-27.

Kvitbit styles both clients with Tailwind CSS v4 utilities, typed `class-variance-authority` (CVA) component recipes, and a shared `cn` helper (`clsx` + `tailwind-merge`) exported from `@kvitbit/ui-port/style`. Every color, radius, and font utility maps to Kvitbit's runtime Material 3 and Elegant/Cozy design tokens rather than Tailwind's default palette.

## Shared token and merge layer (`packages/ui-port/src/style`)

`packages/ui-port/src/style/index.ts` defines the canonical token binding tables:

- `TAILWIND_COLOR_TOKENS`: all 49 Material 3 roles (`--md-sys-color-*`) and 16 extended financial status roles (`paid`, `proforma`, `overdue`, `draft` and their `on-*` / `*-container` variants).
- `TAILWIND_RADIUS_TOKENS`: `panel`, `control`, and `badge` radii driven by the active `elegant` or `cozy` style profile.
- `TAILWIND_FONT_TOKENS`: `display`, `body`, and `mono` font families.
- `cn`: `extendTailwindMerge` configured with Kvitbit's custom `color`, `radius`, and `font` theme groups so utility overrides resolve without silent conflicts.
- `uniwindThemeVariables(effective)`: builds the `--color-*` and `--radius-*` variable map pushed into Uniwind at runtime.

Both clients clear Tailwind's default color palette (`--color-*: initial;`) so views can only reference semantic M3 and financial status tokens.

## Web (`apps/web`)

- Built with `@tailwindcss/vite` in `apps/web/vite.config.ts`.
- `apps/web/src/styles/index.css` declares `@import "tailwindcss";`, `@theme inline` bindings to the runtime CSS variables injected by `Theme.themeStylesheet(...)`, `@layer base` defaults, `@utility kb-num`, and only the minimal CSS that utilities cannot express (`.kb-only-light`/`.kb-only-dark`, `.kb-pattern`, `.kb-skeleton` shimmer).
- `apps/web/src/ui/styles.ts` holds CVA recipes (`buttonVariants`, `cardVariants`, `controlVariants`, `badgeVariants`, `bannerVariants`, `toastVariants`, `barToneVariants`, `chipVariants`, `segmentedButtonVariants`, `botProofVariants`, `dropzoneVariants`, `selectableCardVariants`) and layout presets composed with `cn(...)`.
- Plain page and component stylesheets (`base.css`, `ui.css`, `shell.css`, `styles/pages/*.css`) are removed. `apps/web/src/runtime/feedback/feedback-overlay.css` stays isolated as a `?inline` stylesheet for the ShadowRoot feedback overlay.
- `apps/web/test/verify/tea-invariants.test.ts` checks zero raw hex literals across `apps/web/src/styles/**/*.css` and enforces `@theme inline` parity with `@kvitbit/ui-port/style`.

## Mobile (`apps/mobile`)

- Built with Uniwind (`uniwind/metro` in `apps/mobile/metro.config.cjs`) and Tailwind CSS v4.
- `apps/mobile/global.css` imports `"tailwindcss"` and `"uniwind"`, clears `--color-*`, and registers every color and radius token for both `@variant light` and `@variant dark` with Graphite Atelier defaults.
- `ThemeProvider` syncs `Uniwind.setTheme(...)` and `Uniwind.updateCSSVariables(...)` on every change to light/dark mode, preset, Material You dynamic color, contrast level, or Elegant/Cozy style.
- `apps/mobile/src/ui/styles.ts` holds mobile CVA recipes (`buttonVariants`, `cardVariants`, `badgeVariants`, `badgeTextVariants`, `bannerVariants`, `chipVariants`, `fieldBoxVariants`). `StyleSheet.create` is removed across `apps/mobile/src/**`; inline `style` props remain only for dynamic runtime numbers (window insets, chart bar widths, font metrics, and swatch colors).
- `apps/mobile/src/theme/uniwind-theme.test.tsx` verifies `global.css` token coverage and `syncUniwindTheme` runtime synchronization.
