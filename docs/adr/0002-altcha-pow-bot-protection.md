# Use ALTCHA PoW v2 behind BotProtection

We chose **ALTCHA PoW v2** (`altcha`, `altcha-lib`, `react-native-altcha`, MIT) over Cap (`capjs`) and hosted CAPTCHA providers (Cloudflare Turnstile) for `BotProtection`. ALTCHA runs completely self-hosted with zero third-party SaaS dependency across both GCP and Docker/Nix deployments, verifies HMAC-signed expiring challenges against an atomic Postgres single-use replay store, and is the only evaluated OSS proof-of-work library with an official Expo/React Native solver (`react-native-quick-crypto` + Expo prebuild).

## Consequences

- `apps/mobile` includes `react-native-quick-crypto` via Expo CNG prebuild (already required for local APK builds and native passkeys).
- Self-hosted operators can disable `BotProtection` via configuration (`NoopBotProtection` adapter) without changing application code.
- Choose KDF parameters (preferring Argon2id per ALTCHA RN guidance) and benchmark solve times on mid-range Android devices during implementation.
