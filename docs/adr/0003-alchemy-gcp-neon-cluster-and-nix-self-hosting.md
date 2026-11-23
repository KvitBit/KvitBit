# Deploy hosted GCP with Alchemy + Neon + Effect Cluster and self-host with Nix flake + Docker SingleRunner

We deploy the hosted SaaS on **GCP via Alchemy** (`infra/alchemy`, Effect 4.1) using **Cloud Run** for the HTTP API, Foldkit web adapter, `/mcp`, and `/app/` PWA, **`@alchemy.run/effect-cluster/GCP` Compute Engine runner pool** for Effect v4.1 Cluster and Workflow execution, **Neon Postgres** for both application data and Cluster/Workflow SQL storage (via `Database.fromUrl`), **GCS** for `BlobStorage`, **Secret Manager** for runtime secrets, and **GCS Alchemy state with GitHub Actions OIDC**. Self-hosted installations ship a **`flake.nix`** (`packages.<system>.server` via `bun2nix`, `nixosModules.default` with systemd and optional nginx reverse proxy, `packages.<system>.ociImage` via `nix2container`) plus a **Bun multi-stage `Dockerfile` and `docker-compose.yml`** running Effect Cluster in `SingleRunner.layer({ runnerStorage: "sql" })` mode against Postgres.

## Considered Options

- **Cloud Run for Effect Cluster runners**: Rejected because Effect routes to explicit `host:port` `RunnerAddress` entries and Cloud Run service URLs only provide best-effort affinity across ephemeral instances.
- **Cloud SQL Postgres 17**: Rejected in favor of Neon Postgres to simplify VPC networking across Cloud Run and Compute Engine runners and enable branch-based dev/preview workflows.

## Consequences

- Domain workflows (`effect/cluster/*`, `effect/workflow/*`) are identical across GCP multi-node runners and self-hosted single-node Postgres; only the top-level runtime layer swaps (`NodeClusterHttp` vs `SingleRunner`).
- `BlobStorage` uses a GCS/S3 adapter on GCP and a local-filesystem or S3 adapter when self-hosted.

## Provisioned bootstrap

Bootstrapped on 2026-11-23 for GitHub repo `totalolage/invoicarr` (bootstrapped infra ID, kept), with no static GCP service account keys. The product is named Kvitbit; the infra IDs below predate the rename and are kept unchanged:

- **GCP**: project `invoicarr-prod` (`556342059394`; bootstrapped infra ID, kept), region `europe-west3`, zone `europe-west3-a`, Alchemy state bucket `alchemy-state-invoicarr-prod` (bootstrapped infra ID, kept; uniform access, public access prevention, versioning), WIF provider `projects/556342059394/locations/global/workloadIdentityPools/github/providers/github`, deployer `invoicarr-deployer@invoicarr-prod.iam.gserviceaccount.com` (bootstrapped infra ID, kept).
- **Neon**: project `hidden-hall-00717862` (display name `invoicarr`; bootstrapped infra ID, kept) in `aws-eu-central-1`, PostgreSQL 17, default branch `main`.
- **GitHub Actions variables set**: `GCP_PROJECT_ID`, `GCP_PROJECT_NUMBER`, `GCP_REGION`, `GCP_ZONE`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_DEPLOYER_SERVICE_ACCOUNT`, `ALCHEMY_STATE_BUCKET`.
- **GitHub Actions secrets set**: `DATABASE_URL` (pooled), `DATABASE_DIRECT_URL` (direct).
- **Deferred until domain choice**: `APP_ORIGIN` (start on Cloud Run URL), `EMAIL_FROM`, and `RESEND_API_KEY`.
