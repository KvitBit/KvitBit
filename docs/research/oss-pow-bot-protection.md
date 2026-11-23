# Open-source proof-of-work bot protection for Kvitbit

Read 2026-11-22. Scope: self-hosted client-side crypto puzzle, no verification SaaS dependency, Effect backend port, web and Expo Android clients. Issue #14 itself was not retrievable during this pass (GitHub returned 404); this assessment uses the confirmed requirements in the research brief.

## Recommendation

Use **ALTCHA PoW v2** behind a small `BotProtection` port. Its MIT server library creates HMAC-signed, expiring challenges and verifies proofs locally; its MIT web widget uses browser WebCrypto and workers; and ALTCHA publishes a separate React Native widget that documents Android/Expo support with a native crypto module. This is the only named candidate with an official native Expo path. Cap is worth reconsidering if the mobile APK requirement is dropped or a separately maintained native Cap solver is built and validated.

For custom UI, ALTCHA web has a lower-level `solveChallenge` API and lets applications control verification/UI; on Expo, the supported first-party route is `AltchaWidget` with callbacks and styling. I found no official headless RN hook. The RN implementation is not pure JS and does not use `expo-crypto`: it requires `react-native-quick-crypto` native code and `expo prebuild`, so plan for a development/production native build rather than Expo Go. Its maintainers recommend Argon2id over PBKDF2 when targeting iOS and Android because of measured iOS PBKDF2 performance; benchmark chosen parameters on target Android phones too.

## Candidate comparison

| Candidate | License / maintenance | Protocol, expiry, replay | Client and mobile fit | Assessment |
|---|---|---|---|---|
| **ALTCHA** (`altcha`, `altcha-lib`, `react-native-altcha`) | MIT. At retrieval npm latest was `altcha` 3.7.0 and `altcha-lib` 2.10.0; the ALTCHA npm packages showed recent publishes. RN package owner page listed 2.2.0 (published hours earlier), while the repository `package.json` still said 2.0.0, so pin and verify registry/source alignment. | PoW v2 uses KDFs (default PBKDF2/SHA-256; also SHA variants, Argon2id, Scrypt). Challenge parameters are signed `HMAC-SHA-256` by default over canonical JSON. Challenge can carry `expiresAt`; the library checks expiry, signature and proof. A custom integration must record accepted challenge IDs/nonces through an atomic `setIfAbsent`/TTL store to make proof single-use; the library store docs warn get-then-set permits concurrent replay. | Web component is about 34 kB gzip per project README; WebCrypto + worker solver. RN widget supports Expo SDK 50+/RN 0.75+, Android and iOS, but needs `react-native-quick-crypto` and prebuild. RN reports worker parallelism and customizable styling/callbacks. | **Best fit.** Self-host challenge and verification in Kvitbit, bundle web assets, use the first-party RN package. Native module is the main implementation constraint. |
| **Cap / capjs-core** (`capjs-core`, `@cap.js/widget`) | Apache-2.0. Current package sources list `capjs-core` 0.1.19; npm lists widget 0.1.58. GitHub showed active work through Oct 2026. | Signed JWT challenge; `expiresMs` defaults to 600,000; challenge `scope` can bind use. `validateChallenge` supports caller-provided `consumeNonce(sig, ttlMs)` for atomic replay prevention. The normal widget flow also mints a token: caller stores its key/expiry and deletes it atomically when the protected action consumes it. HashWX is default in format 2; SHA-256 format 1 remains. | Web widget uses Web Workers + WASM; its default docs load widget and WASM from jsDelivr, but describe bundling/self-hosting all assets. Official invisible API (`new Cap(...).solve()`) enables custom web UI. No official Expo/RN widget or native solver found; the standalone solver docs say Bun-only. | Strongest web-only alternative, especially if HashWX and instrumentation are wanted. It does **not** meet the Expo Android client requirement as documented. |
| **mCaptcha** | Backend and core are AGPL-3.0; not MIT/Apache. Backend activity shown through Oct 2025; core library updated Jun 2026, while the browser glue repo last updated Jul 2024. | SHA-256 PoW with challenge configurations described as 30-second lifetime and single-use; validated proof yields a token that the target service must verify. Requires a separately hosted mCaptcha service. | JS glue/widget intended for websites; no official React Native/Expo solver established in this review. | Self-hostable, but license, older website glue, and lack of RN client make it a weaker fit. Apache-licensed PoW components do not change the AGPL backend’s license. |
| **Anubis** | MIT and actively maintained (official organization showed updates in Nov 2026). | SHA-256 browser PoW; successful challenge creates a signed JWT cookie with a one-week expiry. This is a request-gating cookie flow, not a short-lived per-action proof API. | Browser-side challenge in a web firewall/reverse proxy; no native mobile app integration found. | Strong project for protecting web origins from scraper/crawler load, but wrong integration layer for signup/auth endpoints and the Expo APK. |

## Minimal Effect port

Keep the port library-neutral and make verification consume proof exactly once before side effects. `scope` is chosen by the route (for example `signup` or `login`), not trusted from arbitrary client input; tenant/action context should be covered by the signed challenge.

```ts
interface BotProtection {
  issue(input: { scope: BotProtectionScope }): Effect.Effect<BotChallenge, BotProtectionError>;
  verify(input: {
    scope: BotProtectionScope;
    payload: string;
  }): Effect.Effect<void, InvalidOrExpiredBotProof | BotProtectionUnavailable>;
}
```

`issue` creates a fresh challenge with a short configured expiry. `verify` checks HMAC + PoW + expiry, then atomically consumes the challenge ID/nonce in the shared TTL store. The protected HttpApi handler calls it before account creation, email delivery, or other effects. ALTCHA payloads are base64 JSON submitted with the action; Cap can fit the same port by validating the redeem body at the protected action boundary and consuming the challenge nonce there. If implementation instead uses Cap's separate redeem/token flow, the adapter also needs atomic token storage and delete-on-use; keep that behind the port.

## Facts and sources

- ALTCHA widget support, WebCrypto/browser matrix, 34 kB gzip estimate, algorithm/worker options, and MIT license: [official ALTCHA README](https://github.com/altcha-org/altcha/blob/main/README.md), retrieved 2026-11-22. Package version: [npm `altcha`](https://www.npmjs.com/package/altcha), retrieved 2026-11-22.
- ALTCHA server payload verification, local no-API verification, fresh single-use challenges: [official server integration guide](https://altcha.org/docs/integration/server), retrieved 2026-11-22. HMAC format and client solve/server verify flow: [official `altcha-lib` advanced usage](https://github.com/altcha-org/altcha-lib/blob/main/docs/advanced-usage.md), retrieved 2026-11-22.
- ALTCHA expiry and replay-store atomicity / TTL / nonce guidance: [official security recommendations](https://altcha.org/docs/integration/security-recommendations/) and [official store guide](https://github.com/altcha-org/altcha-lib/blob/main/docs/store.md), retrieved 2026-11-22.
- ALTCHA native requirements and behavior: [official RN widget README](https://github.com/altcha-org/altcha-react-native), [package manifest](https://github.com/altcha-org/altcha-react-native/blob/main/package.json), and [publisher’s npm activity](https://www.npmjs.com/~ovx), retrieved 2026-11-22.
- Cap signed stateless challenge, two routes, nonce replay check, token key/delete pattern, defaults and HashWX: [official Core docs](https://trycap.dev/guide/capjs-core), retrieved 2026-11-22. Web worker/WASM and self-hosted assets: [official widget docs](https://trycap.dev/guide/widget); custom invisible API: [official invisible mode docs](https://trycap.dev/guide/invisible). Package versions/licenses: [Core package manifest](https://github.com/tiagozip/cap/blob/main/core/package.json), [widget on npm](https://www.npmjs.com/package/%40cap.js/widget), retrieved 2026-11-22.
- mCaptcha license/activity and component inventory: [official mCaptcha organization](https://github.com/mCaptcha), retrieved 2026-11-22; PoW expiry/replay UX: [official README](https://github.com/mCaptcha/mCaptcha/blob/master/README.md), retrieved 2026-11-22.
- Anubis scope/license/activity: [official Anubis repository](https://github.com/TecharoHQ/anubis), [challenge flow and cookie claims](https://github.com/TecharoHQ/anubis/blob/main/docs/docs/design/how-anubis-works.mdx), and [official organization activity](https://github.com/TecharoHQ), retrieved 2026-11-22.

## Not verified

- GitHub issue #14 returned `404 Not Found`; its contents could not be independently checked. The assessment follows the requirements in the task brief.
- The local checkout only contained `CONTEXT.md`, `README.md`, and an icon, so the existing Effect v4 `HttpApi` types and any `@ui-sdk` API could not be inspected. The port above is an inferred minimal seam, not a compiled repository interface.
- No real-device Expo APK benchmark or integration test was run. ALTCHA’s RN README documents Android and Expo support, but mobile solve times depend on configured KDF parameters and devices.
- No first-party Cap or mCaptcha native Expo solver was found in the official docs/repos checked; absence of a result is not proof no community implementation exists.
