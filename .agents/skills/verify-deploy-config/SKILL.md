---
name: verify-deploy-config
description: Exhaustively check the typed-mode runtime and deployment configuration contract across `apps/server`, `infra/alchemy`, and `.github/workflows/deploy.yml` preflight against an independent specification oracle. Use before merging any change to `apps/server/src/{app,config-contract,config,main,worker}.ts`, `apps/server/src/wiring/{config,email,blob}.ts`, `apps/server/src/http/{config,mobile/config}.ts`, `apps/server/src/runtime/workflows.ts`, `infra/alchemy/src/{deploy-preflight,preflight-cli,config,env,bootstrap}.ts`, `infra/alchemy/alchemy.run.ts`, or `.github/workflows/deploy.yml`.
---

# Verify deploy and runtime config

**Property.** Across `apps/server` (HTTP server and Cluster worker), `infra/alchemy`, and `.github/workflows/deploy.yml` preflight, four invariants hold for every combination in the finite bounds below:

1. Zero broken `prod` boots or deploys: `production` (`stage=prod` / `KVITBIT_ENV=production`) requires real email transport (`resend`, `smtp`, or `resend+smtp`) with explicit valid `EMAIL_FROM`, `KVITBIT_BLOB_DRIVER=gcs` with `KVITBIT_BLOB_BUCKET`, explicit HTTPS non-localhost `APP_ORIGIN`, non-empty `ALTCHA_HMAC_KEY` on the HTTP `server` workload (with `BotProtectionLive` and `HttpConfigLive.botProtection` derived from the same validated resolver), database and auth secrets, and in Alchemy/CI normal `prod` deploys, HTTPS `edge` domains, enabled email secrets, and enabled `ALTCHA_HMAC_KEY` (`KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET=true`). No runtime email reject-stub or silent `NoopBotProtection` fallback exists in production.
2. Zero opt-outs in `prod`: non-prod modes (`capture`, `console`, `local`, `none`, `disabled`) and legacy boolean disable flags (`KVITBIT_PREVIEW_DISABLE_*`, `KVITBIT_DISABLE_*`, `KVITBIT_ALLOW_LOCAL_BLOBS`) are rejected at boot, in Alchemy `validateStackConfig`, and in `deploy.yml` preflight (including during bootstrap modes).
3. Explicit-only non-prod modes in `staging` and `preview`: missing email, blob, origin, or `ALTCHA_HMAC_KEY` (on `server`) fails fast by default; non-prod email (`capture` or `console`), `local` blob storage, and `KVITBIT_BOT_PROTECTION_MODE=none` are accepted only when explicitly declared via typed mode variables. `development` and `test` keep zero-config local defaults.
4. Cross-layer soundness: every normal `prod` deploy accepted by `deploy.yml` preflight maps to a `KvitbitStackConfig` accepted by `infra/alchemy` `validateStackConfig`, and every normal `prod` or `staging` stack config accepted by `infra/alchemy` generates Cloud Run server and GCE runner env maps accepted by `apps/server` boot validation (`validateServerRuntimeEnv`), with enabled email secrets marked `required: true` on runners and `ALTCHA_HMAC_KEY` injected on Cloud Run `server` only (never runners).

**Harm.** A silent fallback or missing preflight gate lets production deploy and pass `/healthz` and `/readyz` while sign-up and magic-link calls 500, sign-up bot protection silently disables (`204` / `NoopBotProtection`), blobs land on ephemeral container disk, or links point to `http://localhost:8080`.

This is exhaustive finite enumeration of the real TypeScript functions, not sampling. Every element of each domain below is checked, and each domain's cardinality is asserted so adding a new environment, email mode, blob driver, bot-protection mode, deploy mode, or workload fails the run until the enumeration covers it.

## Does my change touch it?

Covered files and guarded symbols:

- `apps/server/src/config-contract.ts`: `KVITBIT_ENVS`, `EMAIL_MODES`, `PROD_EMAIL_MODES`, `RESOLVED_EMAIL_MODES`, `BLOB_DRIVERS`, `BOT_PROTECTION_MODES`, `PROD_BOT_PROTECTION_MODES`, `RESOLVED_BOT_PROTECTION_MODES`, `SERVER_WORKLOADS`, `FORBIDDEN_OPT_OUT_ENV_VARS`, `RuntimeEnv`, `mergeRuntimeEnvSources`, `makeRuntimeEnvLayer`, `composeRuntimeEnvLayers`, `resolveKvitbitEnv`, `isLocalhostHostname`, `validateAppOrigin`, `isValidEmailFrom`, `isValidSmtpUrl`, `resolveEmailConfig`, `resolveBlobConfig`, `resolveBotProtectionConfig`, `validateServerRuntimeEnv`, `loadBootRuntimeConfig`, `loadBotProtectionConfig`
- `apps/server/src/app.ts`: `BotProtectionLive`
- `apps/server/src/http/config.ts`: `HttpConfigLive` (`botProtection`)
- `apps/server/src/config.ts`: `ServerConfig`
- `apps/server/src/main.ts`: `serverProgram` boot validation with `makeRuntimeEnvLayer(process.env)` before binding HTTP
- `apps/server/src/worker.ts`: `workerProgram` boot validation with `makeRuntimeEnvLayer(process.env)` before starting Cluster runner
- `apps/server/src/wiring/config.ts`: `EmailWiringConfigSchema`, `BlobWiringConfigSchema`, `ShareSecretsConfigSchema`
- `apps/server/src/wiring/email.ts`: `makeEmailSenderLayer`, `EmailSenderLive` (no reject-stub)
- `apps/server/src/wiring/blob.ts`: `makeBlobStorageLayer`, `BlobStorageLive`
- `apps/server/src/http/mobile/config.ts`: `MobileConfigLive`
- `apps/server/src/runtime/workflows.ts`: `WorkflowHandlersLive`
- `infra/alchemy/src/deploy-preflight.ts`: `DEPLOY_STAGES`, `DEPLOY_MODES`, `BOT_PROTECTION_MODES`, `PROD_BOT_PROTECTION_MODES`, `SECRET_FLAG_ENV_VARS`, `REQUIRED_GCP_VARS`, `validateDeployPreflight`, `validateOriginUrl`, `isValidEmailFrom`, `isValidDomain`, `parseOptionalBoolean`
- `infra/alchemy/src/preflight-cli.ts`: CLI wrapper invoked by `.github/workflows/deploy.yml`
- `infra/alchemy/src/config.ts`: `StackEnv`, `mergeStackEnvSources`, `readAlchemyRawEnv`, `makeStackEnvLayer`, `composeStackEnvLayers`, `defaultSecretBindings`, `validateStackConfigSync`, `validateStackConfig`, `loadStackConfig`
- `infra/alchemy/src/env.ts`: `serverPlainEnv`, `serverSecretEnv`, `runnerPlainEnv`, `buildRunnerWorkerConfig`
- `infra/alchemy/src/bootstrap.ts` & `infra/alchemy/alchemy.run.ts`: `declareKvitbitStack` (targeted feedback/ALTCHA secret bootstraps declare only their single secret container), `assertTargetedSecretSelection`, `altchaSecretFqn`, `feedbackSecretFqn`, `loadAlchemyStackConfig` (preserves Alchemy CLI `--env-file` / `.env` `ConfigProvider`)
- `.github/workflows/deploy.yml`: `"Validate GCP deployment variables"` step (with `KVITBIT_REPO_VARS_JSON: ${{ toJSON(vars) }}`), Secret Manager preflight (including `kvitbit-prod-altcha-hmac-key`), targeted secret bootstraps (`bootstrap_feedback_secret`, `bootstrap_altcha_secret`), and Alchemy env pass-through

If `git diff bc82ac43 -- <those paths>` is non-empty, run the check.

## Run

```sh
bun test --cwd apps/server ./test/runtime/deploy-config.exhaustive.test.ts
```

Passes in about 4–7 seconds (12 tests, 942,484 enumerated cases). `bun run test` runs it as part of `@kvitbit/server`.

Tool: bun 1.4.2 (root `packageManager`; also confirmed on bun 1.4.4), effect 4.1.4.

The repo-wide coverage record is `formal/manifest.json`; this skill's entry is `deploy-config.contract`. `bun run verify:formal --check-digests` reports drift on any covered file. Update the entry when moving the sync commit (`bun run verify:formal --update-digests --only deploy-config.contract`).

## Bounds (exact counts, asserted in the test)

- Domain cardinality guards: 5 `KVITBIT_ENVS`, 6 `EMAIL_MODES`, 3 `PROD_EMAIL_MODES`, 5 `RESOLVED_EMAIL_MODES`, 2 `BLOB_DRIVERS`, 3 `BOT_PROTECTION_MODES`, 1 `PROD_BOT_PROTECTION_MODES`, 2 `RESOLVED_BOT_PROTECTION_MODES`, 2 `SERVER_WORKLOADS`, 2 `DEPLOY_STAGES`, 4 `DEPLOY_MODES`, 5 `SECRET_FLAG_ENV_VARS`, 7 `REQUIRED_GCP_VARS`, 9 `FORBIDDEN_OPT_OUT_ENV_VARS`.
- `resolveKvitbitEnv`: 7 `KVITBIT_ENV` values x 7 `NODE_ENV` values = 49 pairs.
- `validateServerRuntimeEnv` (email/blob/origin): 2 workloads x 7 env inputs (5 explicit `KVITBIT_ENV`, implicit `NODE_ENV=production`, unset default) x 11 origin classes (`absent`, `https_public`, `http_public`, `http_localhost`, `https_localhost`, `https_localhost_dot`, `https_sub_localhost_dot`, `https_127`, `https_ipv6_loopback`, `https_ipv6_mapped_loopback`, `invalid_url`) x 8 email modes x 6 email secret states x 5 `EMAIL_FROM` states (`absent`, `valid`, `invalid`, `invalid_double_dot`, `invalid_overlong_label`) x 4 blob driver states x 2 bucket states = 295,680 states.
- Bot protection (`resolveBotProtectionConfig`, `validateServerRuntimeEnv`, `BotProtectionLive`, `HttpConfigLive`): 5 envs x 5 bot modes x 3 key states (`absent`, `whitespace`, `present`) = 75 direct checks; 2 workloads x 7 env inputs x 5 bot modes x 3 key states x 2 email profiles x 2 blob profiles = 840 runtime checks; 5 envs x 5 bot modes x 3 key states = 75 live `HttpConfigLive` + `loadBotProtectionConfig` + `BotProtectionLive` parity checks = 990 states.
- Core secrets, dynamic/fallback opt-out flags, boundaries, and upgrade preservation: 2 workloads x 5 envs x 5 DB/auth states = 50 cases; 2 workloads x 5 envs x 11 opt-out flags (incl. `KVITBIT_DISABLE_BOT_PROTECTION`, `KVITBIT_PREVIEW_DISABLE_BOT_PROTECTION`, `KVITBIT_DISABLE_CUSTOM`, and `KVITBIT_DISABLE_HTTP_2` Array node) across pure `validateServerRuntimeEnv` (110), live `loadBootRuntimeConfig` direct `ConfigProvider.fromEnv` (110), and live `loadBootRuntimeConfig` composed fallback `ConfigProvider.orElse` (110) = 330 cases; plus 1 upgrade preservation check, 4 boundary checks, and 20 live-loader checks (`makeRuntimeEnvLayer` / `composeRuntimeEnvLayers`) asserting exact `Invalid runtime config (<key>):` markers across server and worker = 405 cases.
- Real Effect layer construction: `makeEmailSenderLayer` over 5 envs x 7 modes x 4 secret states x 2 `EMAIL_FROM` states = 280 real layer builds (plus live `.send()` verification on every accepted `capture`/`console` layer); `makeBlobStorageLayer` over 5 envs x 2 drivers x 2 bucket states = 20 real layer builds; `MobileConfigLive` over 5 envs x 4 origins x 2 mobile bucket x 2 mobile dir x 3 blob driver x 2 blob bucket states = 480 real Effect runs (780 total).
- `infra/alchemy` `validateStackConfigSync` and Alchemy-to-server cross-layer soundness: 215,040 email/blob/origin/edge states + 2,688 bot-protection & all-bootstrap states (2 stages x 7 deploy/conflict modes x 4 bot modes x 2 ALTCHA secret x 2 feedback secret x 3 email modes x 2 Resend secret x 2 blob drivers) + 38 core consumer & live `loadStackConfig` opt-out checks = 217,766 states. Every accepted normal deploy materializes both Cloud Run server and GCE runner env maps and verifies `validateServerRuntimeEnv` accepts both (and that `ALTCHA_HMAC_KEY` is server-only).
- `deploy.yml` `validateDeployPreflight` and 3-layer soundness: 423,360 email/blob/origin/edge states + 3,360 bot-protection & all-bootstrap states (2 stages x 7 deploy/conflict modes x 5 bot modes x 2 ALTCHA secret x 2 feedback secret x 3 email modes x 2 Resend secret x 2 origins) + 94 GCP/bool/opt-out/repo-vars checks = 426,814 states. Every accepted normal `prod` preflight state is mapped into Alchemy and through to `apps/server` server and worker validation.

## Assumptions and what is not covered

- Representative values stand for each equivalence class (for example one valid HTTPS origin `https://kvitbit.cz`, one valid `EMAIL_FROM`, one valid `smtps://` URL, one invalid URL). Exotic URL edge cases, DNS/RFC 5322 corner cases, and live network/credential validity (whether a Resend API key or SMTP password actually authenticates, or whether a Secret Manager version is `ENABLED` in GCP) are not checked here.
- Cross-layer soundness substitutes synthetic valid non-empty strings for GCP Secret Manager references (`serverSecretEnv` and `RunnerWorkerConfig.secrets`). Live Secret Manager availability is checked by the `gcloud secrets versions describe latest` step in `.github/workflows/deploy.yml` and tested in `infra/alchemy/test/selfhost.test.ts`.
- YAML wiring between `.github/workflows/deploy.yml` and `infra/alchemy/src/preflight-cli.ts` is checked by `infra/alchemy/test/selfhost.test.ts` (which executes the workflow step directly), not by the pure TypeScript enumeration alone.
- `main.ts` and `worker.ts` provide `makeRuntimeEnvLayer(process.env)` and `alchemy.run.ts` provides `StackEnv` via `readAlchemyRawEnv(process.argv, process.env)` (without overwriting Alchemy CLI's `--env-file` / `.env` `ConfigProvider`) so raw env key presence (including empty exact keys alongside longer names) and composed source keys are validated losslessly before Effect `ConfigProvider` normalization.

## Drift or bug?

1. Read the failing case printed by the test (`expected ok=..., got ok=...` or `cross-layer ... failure`).
2. Compare against Issue #31 and the typed-mode contract above.
3. If the product code accepts a broken prod state, accepts a prod opt-out, silently falls back in staging/preview, or breaks cross-layer soundness, it is a real bug: fix the product code and leave the oracle strict.
4. If the contract changed intentionally (for example a new environment or email provider), update the oracle and domain-size assertions from the updated spec, re-run the able-to-fail check, and update the sync commit and digests in a separate maintenance commit.

## Coverage record

- Sync commit: `bc82ac43` (product contract confirmed at this commit).
- Able-to-fail, recorded 2026-11-27, each reverted with `git checkout` and re-run green:
  - `apps/server/src/config-contract.ts`: disabled prod `driver !== "gcs"` guard -> fails (`server KVITBIT_ENV=production ... blob=local/absent: expected ok=false, got ok=true`).
  - `apps/server/src/config-contract.ts`: removed `"staging"` from strict email branch -> fails (`server KVITBIT_ENV=staging ... emailMode=absent secrets=none ...: expected ok=false, got ok=true`).
  - `apps/server/src/config-contract.ts`: allowed `production` bot protection without `ALTCHA_HMAC_KEY` -> fails (`resolveBotProtectionConfig production absent absent` + `HttpConfigLive` / `BotProtectionLive`).
  - `infra/alchemy/src/config.ts`: disabled `!hasResend && !hasSmtp` guard in `prod` -> fails (`alchemy prod normal ... secrets=none ...: expected=false, got=true`).
  - `infra/alchemy/src/deploy-preflight.ts`: disabled `!isProdEmailMode(emailMode)` guard -> fails (`preflight prod normal ... emailMode=capture ...: expected=false, got=true`).
  - `infra/alchemy/src/env.ts`: dropped `APP_ORIGIN` from `serverPlainEnv` -> fails (`cross-layer server failure for prod ...: APP_ORIGIN must be explicitly set when KVITBIT_ENV=production`).
