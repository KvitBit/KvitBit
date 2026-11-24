# Deploy hosted GCP with Alchemy + Neon + Effect Cluster and self-host with Nix flake + Docker SingleRunner

We deploy the hosted SaaS on **GCP via Alchemy** (`infra/alchemy`, Effect 4.1) using **Cloud Run** for the HTTP API, Foldkit web adapter, `/mcp`, and `/app/` PWA, **`@alchemy.run/effect-cluster/GCP` Compute Engine runner pool** for Effect v4.1 Cluster and Workflow execution, **Neon Postgres** for both application data and Cluster/Workflow SQL storage (via `Database.fromUrl`), **GCS** for `BlobStorage`, **Secret Manager** for runtime secrets, and **GCS Alchemy state with GitHub Actions OIDC**. Self-hosted installations ship a **`flake.nix`** (`packages.<system>.server` via `bun2nix`, `nixosModules.default` with systemd and optional nginx reverse proxy, `packages.<system>.ociImage` via `nix2container`) plus a **Bun multi-stage `Dockerfile` and `docker-compose.yml`** running Effect Cluster in `SingleRunner.layer({ runnerStorage: "sql" })` mode against Postgres.

## Considered Options

- **Cloud Run for Effect Cluster runners**: Rejected because Effect routes to explicit `host:port` `RunnerAddress` entries and Cloud Run service URLs only provide best-effort affinity across ephemeral instances.
- **Cloud SQL Postgres 17**: Rejected in favor of Neon Postgres to simplify VPC networking across Cloud Run and Compute Engine runners and enable branch-based dev/preview workflows.

## Consequences

- Domain workflows (`effect/cluster/*`, `effect/workflow/*`) are identical across GCP multi-node runners and self-hosted single-node Postgres; only the top-level runtime layer swaps (`NodeClusterHttp` vs `SingleRunner`).
- `BlobStorage` uses a GCS/S3 adapter on GCP and a local-filesystem or S3 adapter when self-hosted.

## Provisioned bootstrap

Re-bootstrapped on 2026-11-24 for GitHub repo `totalolage/invoicarr` (repository ID `1467990305`, owner ID `41711263`), with no static GCP service account keys. The earlier empty `invoicarr-prod` project was deleted and replaced with `kvitbit-prod`:

- **GCP**: project `kvitbit-prod` (`449188423567`, display name `Kvitbit Prod`), region `europe-west3`, zone `europe-west3-a`, Alchemy state bucket `alchemy-state-kvitbit-prod` (uniform access, public access prevention, versioning), WIF provider `projects/449188423567/locations/global/workloadIdentityPools/github/providers/github` (bound to immutable `repository_id == '1467990305'` and `repository_owner_id == '41711263'`), deployer `kvitbit-deployer@kvitbit-prod.iam.gserviceaccount.com`.
- **Neon**: project `hidden-hall-00717862` (display name `invoicarr`; bootstrapped infra ID, kept) in `aws-eu-central-1`, PostgreSQL 17, default branch `main`.
- **GitHub Actions variables set**: `GCP_PROJECT_ID`, `GCP_PROJECT_NUMBER`, `GCP_REGION`, `GCP_ZONE`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_DEPLOYER_SERVICE_ACCOUNT`, `ALCHEMY_STATE_BUCKET`.
- **GitHub Actions secrets set**: `DATABASE_URL` (pooled), `DATABASE_DIRECT_URL` (direct).
- **Deferred until domain choice**: `APP_ORIGIN` (start on Cloud Run URL), `EMAIL_FROM`, and `RESEND_API_KEY`.
