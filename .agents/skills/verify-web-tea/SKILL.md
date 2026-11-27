---
name: verify-web-tea
description: >-
  Run the Tier 2 checks for Kvitbit's Effect UI web adapter. Use before merging
  changes to apps/web/src, the web entry or build configuration, or
  packages/ui-port/src/theme.
metadata:
  sync_commit: "5cc565003a2dbaabb860d264f93c23eabaec8d00"
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
event. Auth coverage measures submit position across challenge outcomes and
checks that edits, validation errors, and method changes retain the status
node. Both desktop and mobile profiles use demo responses.
The typed API and server integrations have their own checks.

## Run

PR CI in `.github/workflows/ci.yml` already runs `bun install --frozen-lockfile`,
`lint`, `typecheck`, `test`, `build`, `test:static-mounts`, and `verify:formal`.
Rely on CI for those checks instead of running them locally.

Run the steps below locally only when debugging a web failure or recording a
Tier 2 verification commit for browser checks that PR CI does not run, since
Playwright runs in `.github/workflows/nightly.yml`:

1. Run the single failing test file under `apps/web` with `bun test <file>`, or
   `bun test apps/web` when a full Tier 2 run was requested.
2. If you need to verify the static bundle locally, run
   `bun run --cwd apps/web build` and confirm `dist/index.html` with its hashed
   assets, `dist/assets/brand`, and `dist/fonts`.
3. Run the browser suite on an unused local port with one worker.

   ```sh
   KVITBIT_WEB_E2E_PORT=34181 bun run --cwd apps/web e2e auth.spec.ts smoke.spec.ts feedback.spec.ts --workers=1
   ```

Record the product commit and tool versions after the suite passes. Keep
that record in a verification commit after the product changes.
[ADR-0005](../../../docs/adr/0005-formal-verification.md)

## Verification record

At `5cc565003a2dbaabb860d264f93c23eabaec8d00`, the Tailwind CSS v4 + CVA + `cn`
web migration and Uniwind mobile migration passed PR CI on `15f4d712` (`check`,
`static-mounts`, `formal`, and `changes`), including `@kvitbit/ui-port`,
`@kvitbit/web`, and `@kvitbit/mobile` lint, typecheck, unit tests, and
production builds. The static web build contains `dist/index.html`, hashed
JavaScript and Tailwind CSS v4 output, `dist/assets/brand`, and `dist/fonts`.

The auth, smoke, and feedback Playwright suites (81 passed, 1 mobile-only skip)
passed on port `34197` with one worker across desktop and mobile Chromium
profiles. The suites verify Tailwind v4 + `@layer ui-sdk` layout parity across
stretched and inline `ui-segmented-control` bars, single-line sign-in labels in
English and Czech across Elegant and Cozy styles, onboarding step 4 series
ledger alignment and inline validation, zero-CLS auth human-check transitions,
SSR hydration reuse, theme mode/locale/style switching, and visual feedback
redaction on `[data-slot="share-url"]` and `[data-slot="form-grid"]`.

At `540c8ef4aff250f71ec6d7ffa172f9e7c8c3ff64`, the `@ui-sdk/core` and `@ui-sdk/web`
migration passed `apps/web` Biome checks, `apps/web` TypeScript typecheck, and all
223 tests across 23 `apps/web/test` files (including SSR hydration upgrade without
node replacement, `@ui-sdk/web/agent` discovery and control driving, and headless
`HtmlScene` address-paste splitting). The static build contains `dist/index.html`,
hashed JavaScript and CSS chunks for `@ui-sdk/web` primitives, the lazy feedback
chunk, the ALTCHA worker, `dist/assets/brand`, and `dist/fonts`.

The auth, smoke, and feedback Playwright suites (81 passed, 1 mobile-only skip)
passed on port `34189` with one worker across desktop and mobile Chromium profiles.
The suites verify `ui-select` locale/mode switching and SSR hydration reuse,
`ui-checkbox` search filter preservation, `ui-segmented-control` container fill and
arrow-key navigation without focus loss on `/account/appearance`, `ui-dialog` Escape
dismissal, desktop `ui-menu` workspace switcher open/Escape/shortcut handling,
address-paste splitting on onboarding, cookieless pageviews, and stable auth submit
and status layout.

At the recorded product commit, the Playwright auth tests kept the submit
button in place when sign-in, sign-up, and password reset received a
no-challenge response. The sign-up test also covered validation and retry.
Before this change, the same measurements found 28 to 54 pixels of movement
and the sign-up validation error replaced the status node.

The auth, smoke, and feedback suites passed in desktop and mobile Chromium
with one worker on port `36000`. Biome checks on the edited files, the web
and mobile typechecks, the targeted web and mobile auth tests, and the formal
digest check passed.

At `0fd105ebb0533916112db09d3f035ae3d0ac476b` (rebased cleanly from `3372918b`
onto `0f5643de`), the onboarding numbering overhaul passed Biome checks on the
edited files, `apps/web/test/public/consent-invite-onboarding.test.ts`, and
PR CI (`check`, `static-mounts`, `formal`, `changes` on `aeee3ec2`). The
lockfile was unchanged. The static build contained `dist/index.html`, hashed
JavaScript and CSS, `dist/assets/brand`, and `dist/fonts`. All 58 smoke and
feedback Playwright tests passed on `3372918b` on port `34183` with one worker
across desktop and mobile Chromium profiles. The smoke suite verifies the
redesigned `/onboarding?step=4` numbering ledger and document defaults layout
in English and Czech, including per-row alignment, independent live number
previews, inline validation, and zero horizontal overflow.

At `27555299dca87058231afdf2872b9c247091a1d9`, the address paste change passed
Biome checks on all edited files and targeted unit tests for `packages/ui-port`
(`address.test.ts`), `apps/web`
(`consent-invite-onboarding.test.ts`, `settings.test.ts`, `contacts.test.ts`,
`tea-invariants.test.ts`), and `apps/mobile` (`onboarding-screen.test.tsx`).
The lockfile was unchanged. The static build contained `dist/index.html`,
hashed JavaScript and CSS, the ALTCHA worker, `dist/assets/brand`, and
`dist/fonts`. All 58 smoke and feedback Playwright tests passed on port
`34187` with one worker across desktop and mobile Chromium profiles,
covering single-line and multiline address paste splitting on `/onboarding`,
preservation of non-empty fields, and pass-through of single-part pastes.

At `383766ac036a7dfe79ace530bcd508e3c32c3740`, the segmented control change
passed root lint and typecheck, all 183 web tests, and the formal digest
check. The lockfile was unchanged. The static build contained
`dist/index.html`, hashed JavaScript and CSS, brand assets, and fonts.
All 56 smoke and feedback tests passed on port `34181` with one
worker across desktop and mobile Chromium profiles. The smoke suite covers
stretched and inline segmented controls in English and Czech, including
equal-width sign-up options, single-line sign-in labels, and word fit in a
220 px appearance field.

At `204841bb3f0dafd505530b8d4456947b134a3d5a`, the frozen install, root lint
and typecheck, and formal digest check passed. Targeted unit tests passed for
`packages/ui-port`, `apps/web`, and `apps/mobile` auth screens
(`apps/mobile/src/features/auth/auth-screens.test.tsx`). The static web
build contains `dist/index.html`, hashed JavaScript and CSS, the ALTCHA
worker, `dist/assets/brand`, and `dist/fonts`.

The smoke and feedback Playwright suites (46 tests) passed on port `34191`
with one worker across desktop and mobile Chromium profiles. The smoke suite
verifies that `/sign-in` renders concise method selector labels on a single
line without overflow in both English and Czech across Elegant and Cozy
styles while keeping the full passkey action label on the submit button.

At `95fdee1c534309442ab9ab8923a4bab1dbf7e800`, the feedback shortcut passed the frozen
install, root lint and typecheck, `bun test apps/web`, and the formal digest
check. The static build contained the lazy feedback chunk, ALTCHA worker,
hashed JavaScript and CSS, brand assets, and Fontshare TTFs.

The smoke and feedback Playwright suites passed on port `47683` with one
worker across desktop and mobile Chromium profiles. The feedback suite
checks that verified owners can pin elements, retry a submission, and
receive its issue link. It checks that non-owners skip the picker chunk,
that pins omit private links and entered form values, and that signing
out removes the picker. A failed mount restores browser diagnostics.
The selector unit test declines a pin when its bounded path matches
multiple elements.

The shortcut tests exercise `k` toggling, editable fields including the
shadow DOM composer, pending submission, the pin limit, pathname changes,
and listener removal on sign-out. The desktop workspace switcher still
responds to Ctrl+K and Cmd+K.

At `c54559c3a9ab795c44f08d4584e6a28c88074466`, Chromium and Firefox
loaded all bundled fonts without console warnings.
The app's static router served the new font URLs as `font/ttf` with immutable
cache headers. OpenType Sanitizer 9.2.0 reported zero warnings. FontTools
4.69.1 confirmed the replacements preserve every character mapping and
glyph advance width.
