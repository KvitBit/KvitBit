---
name: verify-web-tea
description: >-
  Run the Tier 2 checks for Kvitbit's Effect UI web adapter. Use before merging
  changes to apps/web/src, the web entry or build configuration, or
  packages/ui-port/src/theme.
metadata:
  sync_commit: "204841bb3f0dafd505530b8d4456947b134a3d5a"
  bun: "1.4.4"
  node: "24.18.0"
  effect: "4.1.4"
  effect_ui_snapshot: "5f8b3576288a5aa3e69eaa8def155b17c76f1776"
  typescript: "6.0.2"
  biome: "2.6.8"
  fast_check: "4.11.0"
  vite: "8.3.8"
  playwright: "1.65.1"
  chromium: "159.0.8154.6"
  firefox: "159.0"
---

# Verify the Effect UI web adapter

## Coverage

The access test enumerates every route tag against signed-out, loading,
unavailable, signed-in member, and signed-in non-member sessions. Its
expected access table is independent of the production route gate. Seeded
property tests exercise route round trips, asynchronous reply sequencing,
and custom preference values. A delayed share response is delivered after
leaving and remounting that route in Playwright.

The contrast test checks six built-in presets, six light/dark and contrast
variants, and 50 role pairs per variant. It computes luminance independently
and uses 4.5:1 for text and 3:1 for non-text controls. This measures the
resolved colors before browser compositing.

The TypeScript syntax scan inspects web code and tests for forbidden
dependencies and the page modules for imperative DOM access. It checks
static and dynamic imports, property access, and string-keyed access. It
is limited to the syntax in each file. Page side effects run in Commands
through Effect services.

`HtmlServer` smoke tests render route groups in cs and en. Playwright
hydrates server markup through the production browser entry, asserts DOM
node reuse, and changes a preference through the adopted control. It also
covers in-app focus and Back scroll restoration, Price List search history,
sign-in from a filtered Price List URL, native mobile-app navigation,
public PDF downloads, and appearance changes. It covers default and explicit
magic-link callbacks that recover from a failed membership request, and
open shares that update after UTC midnight via a timer or a visibility
event. Both desktop and mobile profiles use demo responses.
The typed API and server integrations have their own checks.

## Run

1. Run `bun install --frozen-lockfile`, `bun run lint`, and `bun run typecheck`.
2. Run `bun test apps/web`. Inspect any failing case by route, preset, or generated seed.
3. Run `bun run --cwd apps/web build`. Confirm `dist/index.html` and its hashed
   assets, `dist/assets/brand`, and `dist/fonts`.
4. Run the browser suite on an unused local port with one worker.

   ```sh
   KVITBIT_WEB_E2E_PORT=34181 bun run --cwd apps/web e2e smoke.spec.ts feedback.spec.ts --workers=1
   ```

5. Run `bun run verify:formal --check-digests` for coverage maintained by ADR-0005.

Record the product commit and tool versions after the suite passes. Keep
that record in a verification commit after the product changes.
[ADR-0005](../../../docs/adr/0005-formal-verification.md)

## Verification record

The recorded product commit passed the frozen install, root lint and
typecheck, and the formal digest check. Targeted unit tests passed for
`packages/ui-port`, `apps/web`, and `apps/mobile` auth screens
(`apps/mobile/src/features/auth/auth-screens.test.tsx`). The static web
build contains `dist/index.html`, hashed JavaScript and CSS, the ALTCHA
worker, `dist/assets/brand`, and `dist/fonts`.

The smoke and feedback Playwright suites (46 tests) passed on port `34191`
with one worker across desktop and mobile Chromium profiles. The smoke suite
verifies that `/sign-in` renders concise method selector labels on a single
line without overflow in both English and Czech across Elegant and Cozy
styles while keeping the full passkey action label on the submit button.

At `c54559c3a9ab795c44f08d4584e6a28c88074466`, Chromium and Firefox
loaded all bundled fonts without console warnings.
The app's static router served the new font URLs as `font/ttf` with immutable
cache headers. OpenType Sanitizer 9.2.0 reported zero warnings. FontTools
4.69.1 confirmed the replacements preserve every character mapping and
glyph advance width.
