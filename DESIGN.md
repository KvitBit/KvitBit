# Design System — Kvitbit

Durable visual authority established in Screen 00 (Foundations). Applies across Foldkit Web (`apps/web`), Expo Mobile Android APK & `/app/` PWA (`apps/mobile`), PDF templates, and transactional emails.

## Brand Identity

**Kvitbit** joins the Czech *jsme kvit* ("we're square, nothing owed") with the binary *bit*. Domains: `kvitbit.cz`, `kvitbit.app`. All files live in `assets/brand/`; `assets/icon.svg` is a copy of `kvitbit-mark-light.svg`.

- **Mark (N2 Dual-Bit Notch, A1)**: a notched stem, a `<` chevron, and a square bit on a `256×256` grid (ink box `192` tall, so the mark carries 32 units of built-in padding). The stem and the chevron arms are `48` units wide and the bit is a `44`-unit square. The chevron arms run at `34.5°` from vertical (`66:96` run to rise), to visually match the arm angle of the Clash Display `K` in the wordmark. It ships as two optical masters that differ only in the gap between the shapes, because light ink on a dark ground visually bleeds into the gaps:
  - **Light master (10-unit gap)**: dark ink on light surfaces. `kvitbit-mark-light.svg` (`#111111`), `kvitbit-mark-black.svg` (`#000000`, one-colour print), `kvitbit-mark-current-light.svg` (`currentColor`).
  - **Dark master (14-unit gap)**: light ink on dark surfaces, including every app icon on the `#111111` tile. `kvitbit-mark-dark.svg` (`#FAFAFA`), `kvitbit-mark-white.svg` (`#FFFFFF`), `kvitbit-mark-current-dark.svg` (`currentColor`).
  - Pick the master by background, not by theme name: never use the light master for light-on-dark ink, or the reverse. Never recolour, stroke, rotate, or rebuild the shapes.
- **Wordmark (K4)**: custom outlined `Kvitbit` drawn on `Clash Display` Semibold (`600`), Title Case (units on a `67`-unit cap height). The `K` bridge is tightened to `6.2` units, and `K` and `v` share a waist-cut leg. The `i` dots are `4.2`-unit left-extended parallelograms; the first nestles into a pocket cut into the `v`. Both `i` stems are raised flush to `y=65.8` and shifted `3.0` units left. The `b` has a cranked `15`-unit stem that frames two `24.2`-unit square cutouts of negative space, the `t`–`b` pocket and the `b` counter (deliberately not the mark's `44`-unit bit size). The `t` bar and foot are trimmed by `1.6` units, leaving a `4.0`-unit `t`–`b` gap. The wordmark group uses `fill-rule="evenodd"` so the `b` counter punches through. The lockup SVGs carry this geometry as paths and need no font; never retype the word in the font in its place. `lockup/ClashDisplay-Semibold.woff2` is © 2021 Indian Type Foundry, ITF Free Font License (free for commercial use, fontshare.com/terms). Attribution lives in `lockup/FONT-LICENSE.md`; keep it next to the font. The wordmark font is for the logo only, not for UI text.
- **Lockup `[N2] Kvitbit`**: measured in `u` = mark stem width = ¼ of the mark's ink height. Every SVG artboard is cropped to the ink, so clear space is added around it, not inside it.
  - **Horizontal** (`lockup/kvitbit-lockup-horizontal-{light,dark}.svg`): mark ink height = `1.12 ×` wordmark cap height (`0.75em`), the cap band centred vertically on the mark, a `2u` gap between mark ink and the `K` (`0.375em`). Clear space `2u` (half the mark height) on every side. Minimum size: `16px` total height on screen, `5mm` in print.
  - **Stacked** (`lockup/kvitbit-lockup-stacked-{light,dark}.svg`): mark ink height = `2 ×` cap height (`1.34em`), centred over the word, a `1u` gap from mark ink to cap top. Clear space `2u` on every side. Minimum size: `48px` total height, `14mm` in print.
  - **Mark alone**: minimum `16px` (favicon). Below the horizontal minimum, use the mark alone.
- **Colors**: brand ink `#111111` on light surfaces, `#FAFAFA` on dark surfaces, and the `#111111` icon tile, matching Graphite Atelier `primary`/`onPrimary`. Pure `#000000`/`#FFFFFF` only for one-colour reproduction. The brand mark never takes theme accent or financial status colors.
- **Pattern (T4 Micro-Glyph Graph)**: a seamless `96×96` tile in `pattern/` with a hairline ledger grid, 45° dashed diagonals, and micro N2 primitives (solid ■ bits, a `<■` chevron, notched stem ticks, hollow ▢ bits). Opacity is baked in at the "balanced" level (`0.28` base). Use `kvitbit-pattern-t4.svg` (`currentColor`) inline, or `-light` (`#111111` ink) / `-dark` (`#FAFAFA` ink) as a transparent CSS background tile. It is built to sit quietly behind UI: lower its opacity rather than raise its contrast.
- **Web assets (`assets/brand/web/`)**: `favicon.svg` (switches from the light master in `#111111` to the dark master in `#FAFAFA` through `prefers-color-scheme`), `favicon.ico` (16/32/48) and `favicon-{16,32,48}.png` (light master on transparent), `apple-touch-icon.png` (180, opaque), `icon-192.png`/`icon-512.png` (opaque tiles), `maskable-512.png` (mark inside the 80% safe circle), `site.webmanifest`, and `head-snippet.html` (assumes `assets/brand/web/` is served at `/assets/brand/web/`).
- **Mobile assets (`assets/brand/mobile/`)**: Android adaptive icon `adaptive-foreground.svg` + `adaptive-foreground-1024.png` (`#FAFAFA` dark master inside the 66dp safe circle of the 108dp canvas, transparent), `adaptive-background.svg` (`#111111`), `adaptive-monochrome.svg` (`#FFFFFF`, Android 13 themed icons). `icon-1024.png` is the opaque store/iOS icon. `splash-icon-1024.png` is the light master on transparent, for a light splash background (`#F4F4F5`).

## Color Architecture (Google Material Theme Builder JSON)

Every surface renders strictly through Material 3 semantic color roles (`--md-sys-color-*` on web, typed M3 color tokens on Expo). Raw hex values are forbidden inside components.

- **Default built-in preset**: **Graphite Atelier** (achromatic monochrome chrome; color reserved strictly for financial status).
  - Light: `surface: #F4F4F5`, `surfaceContainerLowest: #FFFFFF`, `surfaceContainerLow: #EFEFF1`, `surfaceContainer: #E8E8EC`, `surfaceContainerHigh: #DCDCE0`, `onSurface: #09090B`, `onSurfaceVariant: #52525B`, `primary: #18181B`, `onPrimary: #FAFAFA`, `primaryContainer: #E4E4E7`, `onPrimaryContainer: #09090B`, `outline: #A1A1AA`, `outlineVariant: #D4D4D8`, `error: #B91C1C`, `onError: #FFFFFF`, `errorContainer: #FEE2E2`, `onErrorContainer: #991B1B`.
  - Dark: `surface: #09090B`, `surfaceContainerLowest: #131316`, `surfaceContainerLow: #101013`, `surfaceContainer: #18181C`, `surfaceContainerHigh: #232329`, `onSurface: #FAFAFA`, `onSurfaceVariant: #A1A1AA`, `primary: #FAFAFA`, `onPrimary: #09090B`, `primaryContainer: #27272A`, `onPrimaryContainer: #FAFAFA`, `outline: #52525B`, `outlineVariant: #27272A`, `error: #F87171`, `onError: #450A0A`, `errorContainer: #351517`, `onErrorContainer: #FECACA`.
- **Additional built-in presets**: **Prague Ledger** (seed `#1D4ED8`, cool slate-blue M3 tonal neutrals) and **Banknote Emerald** (seed `#0F5D42`, calm sage-mineral M3 tonal neutrals).
- **Tonal surface harmonization**: Every theme (built-in preset, custom hex seed, imported `material-theme.json`, or Android Material You) derives not just `primary` but the full Material 3 `neutral` and `neutralVariant` tonal ramps (`surface`, `surfaceContainerLowest`..`Highest`, `onSurface`, `onSurfaceVariant`, `outline`, `outlineVariant`) via HCT so cards, backgrounds, inputs, borders, and secondary text carry a cohesive subtle undertone (true achromatic zinc only for **Graphite Atelier**, cool slate tint for **Prague Ledger**, sage-paper tint for **Banknote Emerald**, warm stone/parchment tint for warm seeds) while keeping WCAG 2.1 AA contrast across light and dark modes.
- **Custom themes**: Users can pick a custom hex seed color or import a Google Material Theme Builder `material-theme.json` (up to 64 KB) using `@material/material-color-utilities`.
- **Harmonized extended financial roles** (`paid`, `proforma`, `overdue`, `draft`): Each carries `{ color, onColor, colorContainer, onColorContainer }`, harmonized against the active scheme's `primary` via HCT (or honoring `extendedColors` entries in an imported `material-theme.json`).
- **Precedence**:
  - App UI: Android 12+ Material You Dynamic Color (enabled by default, toggleable in Account Settings) > Account custom/preset theme > active Workspace theme > Graphite Atelier default.
  - Recipient-facing PDFs and Public Share Link (`/i/:token`): Workspace branding theme only (never the viewing user's personal theme).
- **Contrast**: Light, Dark, and Medium/High contrast schemes target WCAG 2.1 AA minimum across all roles.

## Selectable Styles: `elegant` and `cozy`

Users choose between two orthogonal style profiles (`style: "elegant" | "cozy"`, default `"elegant"`) independent of their Material 3 color palette.

### Style 1: `elegant` (default)
- **Headings / Display**: `Erode` Semibold (`600`, Fontshare, 100% Czech diacritics).
- **Body / UI / Controls**: `Recia` Regular (`400`), Medium (`500`), Semibold (`600`) (Fontshare, 100% Czech diacritics).
- **Numerals**: Enable `font-variant-numeric: lining-nums tabular-nums` and `font-feature-settings: "lnum" 1, "tnum" 1` on all amounts, dates, VAT recaps, and table columns so `Recia` renders lining tabular figures instead of oldstyle figures.
- **Identifiers**: `JetBrains Mono` (`400`, `500`) reserved strictly for document numbers (`2026-0042`), IČO, DIČ, IBAN/BIC, variable symbols, API keys, and JSON previews.
- **Geometry**: Sharp (`4px` cards/panels, `4px` buttons/inputs/sheets, `3px` status badges, `1px` crisp `outlineVariant` borders; flat surfaces with no card drop shadows, while floating modals/popovers use a subtle `outlineVariant` border over a dimmed scrim with gentle depth — never a dark `primary` outer border).

### Style 2: `cozy`
- **Headings / Display**: `Chillax` Semibold (`600`, Fontshare, 100% Czech diacritics).
- **Body / UI / Controls**: `Synonym` Regular (`400`), Medium (`500`), Semibold (`600`) (Fontshare, 100% Czech diacritics).
- **Numerals**: `Synonym` uses lining figures natively; right-aligned ledger/VAT recap columns may optionally use `JetBrains Mono` when strict column alignment is needed.
- **Identifiers**: `JetBrains Mono` (`400`, `500`) for document numbers, IČO, DIČ, IBAN, API keys, and JSON previews.
- **Geometry**: Material Soft (`12px` cards/panels, `8px` buttons/inputs/sheets, `999px` pill status badges, Material 3 tonal surface steps).

## Scale, Density, and Platform Grammar

- **Typography scale**: Fixed `rem` Operate scale (`1.125rem` page title, `0.9375rem` section heading, `0.875rem` primary body/control, `0.8125rem` table/list row, `0.75rem` secondary metadata, `0.6875rem` statutory footnotes/badges). Persuade landing hero may scale up cleanly (`2rem–2.5rem`).
- **Web (`apps/web`)**: Built on `@foldkit/ui` + `@ui-sdk/core` headless behaviors. Every interactive control implements `default`, `hover`, `focus-visible`, `active`, `disabled`, `loading`, and `error`. Motion stays between `150–250ms` for state transitions only and honors `prefers-reduced-motion`.
- **Mobile (`apps/mobile`)**: Native Android Material 3 structure (bottom navigation bar with 3–5 destinations on compact width, navigation rail/drawer on expanded width, `48×48 dp` minimum touch targets with `8 dp` spacing, single primary FAB where appropriate, snackbars for transient feedback, edge-to-edge window insets, system Back gesture, `sp` font scaling up to 200%, 360 dp resilient layouts).
- **Bilingual resilience**: Every layout is stress-tested with Czech strings (typically 20–30% longer than English).
- **Zero-CLS loading states**: Every loading skeleton must mirror the exact chrome, table headers, summary bars, and row/card heights of its loaded state so content resolves in place with zero layout shift. Skeleton blocks share one subtle, narrow viewport-synchronized left-to-right shimmer wave (`~1.15s` linear sweep, ~18% band width, quiet tonal highlight rather than bright white, offsetting each block's sheen by its measured on-screen `x` coordinate) and fall back to a static fill under `prefers-reduced-motion: reduce`.
- **Plain user-facing copy**: Never leak implementation or technical details into UI labels (no "Live" / "Živá", "Local cryptographic", "PoW", or similar qualifiers). Label things simply by what they are (e.g. "Rekapitulace DPH" / "VAT summary", "Náhled faktury" / "Invoice preview", "Ověřování…" / "Verifying…").
