---
name: verify-web-tea
description: Tier 2 verification for @kvitbit/web: exhaustive WCAG 2.1 AA contrast checks across all 6 presets × 6 scheme variants + Elegant/Cozy stylesheet generation, fast-check + deterministic TEA invariants (routing, Shell access gates, Remote<A> sequence guards, Shell update, prefs round-trip, static architecture), SSR smoke checks across all route groups in cs/en, and the Playwright nightly E2E suite. Use before merging changes to apps/web/src/app/**, apps/web/src/main.ts, apps/web/src/page/**, apps/web/src/styles/pages/**, or packages/ui-port/src/theme/**.
---

# Verify Web TEA, Contrast, and SSR (Tier 2)

**Property (contrast).** Every built-in theme preset (`graphite_atelier`, `forest`, `ocean`, `plum`, `sand`, `graphite`) across both light and dark modes and all three contrast levels (`standard`, `medium`, `high`) satisfies WCAG 2.1 AA contrast ratios (>= 4.5:1 for text pairs, >= 3.0:1 for primary/error on surface UI pairs) across all checked M3 color roles and all four extended financial status roles (`paid`, `proforma`, `overdue`, `draft`). Both Elegant and Cozy stylesheets emit scoped `.kb-root` CSS variables and dark/contrast rules.

**Harm (contrast).** Unreadable text or indistinguishable financial status badges (paid, proforma, overdue, draft) in light, dark, or high-contrast modes — an accessibility failure.

**Property (TEA invariants).**
- **Routing & gates:** `routeFromPath(href(route))` round-trips every canonical `Route`; unknown paths resolve to `NOT_FOUND`. `gate(route, session)` enforces public/account/workspace access across `Unknown`, `Anonymous`, `Unavailable`, signed-in member, and signed-in non-member states.
- **Sequence guards (`Remote<A>`):** `seq` is monotonically non-decreasing; out-of-order, stale, future, or post-settlement `succeed`/`fail` replies are dropped without overwriting newer loads or shown data; `load` from `Loaded`/`Refreshing` preserves shown data (zero-CLS).
- **Shell update & prefs:** `GotPage` messages addressed to an unmounted page (or while on `Splash`) are dropped; workspace switcher toggles/closes and resets on navigation; `serializePrefs`/`parsePrefs` round-trips every locale × style × mode × contrast × preset and random custom hex seeds.
- **Static architecture:** Zero React imports anywhere in `apps/web/src/`, zero direct `document.`/`window.` DOM mutations in `apps/web/src/page/**` outside `Command` effects, and zero raw hex color literals in `apps/web/src/styles/pages/**`.

**Harm (TEA invariants).** Stale async replies overwriting newer invoice/document data, broken deep links or leaked workspace screens, cross-page message corruption after navigation, or styling regressions that bypass Material 3 theme tokens.

**Property (SSR & E2E).** Every major route group server-renders clean HTML with `.kb-root`, `lang`, inline `#kb-theme-vars` stylesheet, and non-empty Kvitbit title in both `cs` and `en`. Nightly Playwright E2E verifies desktop (1280×800) and mobile (390×844) journeys, light/dark and Elegant/Cozy toggles, and zero console/page errors under `VITE_KVITBIT_DEMO=1`.

## Does my change touch it?

Covered files and guarded areas:

- `apps/web/src/main.ts` (Shell `init`, `update`, `view`, `mountRoute`, `applyIntent`)
- `apps/web/src/app/{theme,routing,remote,prefs,pages,shell,root,session}.ts`
- `apps/web/src/page/**` (static architecture & SSR smoke)
- `apps/web/src/styles/pages/**` (zero raw hex literals)
- `packages/ui-port/src/theme/**` (preset palettes, contrast audit, stylesheet serialization)
- `packages/ui-port/src/view-models/routes.ts` (route codec and `requires` access scopes)

## Run

Tier 2 unit, exhaustive, property, and SSR checks (PR CI):

```sh
bun test apps/web/test/verify/contrast.test.ts
bun test apps/web/test/verify/tea-invariants.test.ts
bun test apps/web/test/ssr.smoke.test.ts
```

Or run the full `apps/web` suite, typecheck, lint, and build:

```sh
bunx biome check apps/web
bun run --cwd apps/web typecheck
bun test apps/web
bun run --cwd apps/web build
```

Nightly Playwright E2E suite (demo mode, no external server required):

```sh
bun run --cwd apps/web e2e
```

## Bounds and Classification

Per `docs/adr/0005-formal-verification.md`, distinguish exhaustive enumeration from sampled property tests:

- **Exhaustive enumeration (verification):**
  - Contrast matrix: all 6 presets × 6 scheme variants (light/dark × standard/medium/high) = 36 schemes × 50 checked pairs (42 M3 role pairs + 8 extended financial status pairs) = 1,800 pairs verified against an independent WCAG 2.1 sRGB relative-luminance oracle.
  - Stylesheet matrix: all 6 presets × 2 styles (`elegant`, `cozy`) = 12 stylesheets.
  - Shell access gates: all 30 route tags × 5 session states = 150 gate combinations.
  - Prefs preset round-trip: 2 locales × 2 styles × 3 modes × 3 contrasts × 6 presets = 216 combinations.
  - SSR smoke matrix: 22 route cases × 2 locales (`cs`, `en`) = 44 server renders + access-gate redirect renders.
  - Static architecture scan: all source files in `apps/web/src/**` and CSS files in `apps/web/src/styles/pages/**`.
- **Sampled property tests (fast-check):**
  - Route `toPath -> fromPath` round-trip over generated `Route` values across all 30 route tags (200 runs, deterministic seed).
  - `Remote<A>` sequence-guard state machine over random load/succeed/fail operation sequences with current, stale, and future sequence numbers (200 runs).
  - Prefs round-trip over random custom `#RRGGBB` seeds (100 runs).
- **End-to-end smoke (Playwright nightly):**
  - Desktop (1280×800) and mobile (390×844) projects against `VITE_KVITBIT_DEMO=1`, asserting public/workspace navigation, mode/locale/style toggles, and zero console or uncaught page errors.

## Assumptions and What Is Not Covered

- Contrast checks verify computed hex color pairs from `Theme.resolvePreset` / `Theme.resolveSeed`, not browser-composited alpha blending or font-size-specific large-text exceptions (body text pairs are held to the stricter 4.5:1 AA threshold).
- `outline` is intentionally excluded from `CHECKED_ROLE_PAIRS` per `DESIGN.md` (Graphite Atelier hairline borders never carry meaning alone).
- Static DOM-mutation checks in `src/page/**` use lexical scanning outside `Command.define` blocks; they guard against accidental side effects in `init`/`update`/`view` but are not a full AST taint analysis.
- Playwright E2E runs against the in-browser demo fetch router (`VITE_KVITBIT_DEMO=1`), not a live Postgres/Better Auth backend.

## Drift or Bug?

1. If a contrast test fails, check the printed `preset / variant / fg on bg (ratio < required)` against the WCAG 2.1 formula. Do not weaken thresholds; fix the preset palette or contrast repair in `packages/ui-port/src/theme/`.
2. If a route round-trip or gate test fails, check `packages/ui-port/src/view-models/routes.ts` and `apps/web/src/app/routing.ts` for schema or path-codec drift.
3. If the static architecture check fails, move DOM access into a `Command.define` effect or replace raw hex literals in `src/styles/pages/*.css` with `var(--md-sys-color-*)` / `var(--kb-color-*)` tokens.
