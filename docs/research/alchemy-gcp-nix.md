# Alchemy GCP and self-hosting research

Read 2026-11-22 for [issue #15](https://github.com/totalolage/invoicarr/issues/15) (GitHub repo `totalolage/invoicarr` is a bootstrapped infra ID, kept). Confidence: high; no deploy/build run.

## Answer

Alchemy has the required GCP primitives. Run the HTTP API on Cloud Run and Effect Cluster runners on Compute Engine. Self-hosting outputs should be `packages.<system>.server`, `nixosModules.default`, and `packages.<system>.ociImage`, using `bun2nix` and `nix2container`.

## Facts

- Alchemy GCP exports Cloud Run services/jobs/worker pools; Artifact Registry; Cloud SQL PostgreSQL (`POSTGRES_17`), databases/users; GCS; Secret Manager; IAM; Compute/VPC, VPC Access, Service Networking. Cloud Run builds locally, pushes to Artifact Registry, and reaches Cloud SQL through a socket; Drizzle migrations can use its Data API. [Cloud Run](https://alchemy.run/gcp/compute/cloud-run/), [Cloud SQL + Drizzle](https://alchemy.run/gcp/data/cloud-sql/), [GCP exports](https://raw.githubusercontent.com/alchemy-run/alchemy/main/packages/gcp/src/index.ts)
- `@alchemy.run/effect-cluster/GCP` creates a VPC, persistent-disk Postgres VM, zonal Compute Engine runners, and regional load balancer. Cloud Run can call the cluster but cannot host runners. `Database.fromUrl` accepts reachable Postgres. [Cluster GCP](https://alchemy.run/cluster/gcp/), [Cluster setup](https://alchemy.run/cluster/setup/)
- `GCP.state()` stores Alchemy state in GCS (`alchemy-state-{project}` by default); bootstrap before CI. GitHub Actions can use OIDC/Workload Identity Federation, short-lived tokens, and `bun alchemy deploy --stage …`; CI needs Docker. [State store](https://alchemy.run/providers/gcp/statestore/), [CI/CD](https://alchemy.run/gcp/tutorial/part-5/)
- Current Alchemy main is `@alchemy.run/gcp` `2.0.0-beta.87`; Effect peer range is `^4.1.4` (platform-bun same), so Effect 3 is incompatible. An Effect 4.1 app can share a compatible version; isolate infra only if the app must stay on v3. [Package](https://raw.githubusercontent.com/alchemy-run/alchemy/main/packages/gcp/package.json), [version catalog](https://raw.githubusercontent.com/alchemy-run/alchemy/main/pnpm-workspace.yaml)
- Flake outputs: `packages.{x86_64-linux,aarch64-linux}.server` (plus `default`), `nixosModules.default`, `packages.<system>.ociImage`. Build with `bun2nix.mkDerivation` and generated `bun.nix`/`fetchBunDeps`. Module options: enable/package/port/environment file and optional nginx vhost; systemd runs on loopback behind nginx. [bun2nix](https://nix-community.github.io/bun2nix/building-packages/fetchBunDeps.html), [NixOS modules](https://nixos.org/manual/nixos/stable/#ch-writing-modules), [flake outputs](https://nixos.wiki/wiki/Flake#Flake_schema)
- Nixpkgs `dockerTools.buildLayeredImage` creates a Docker-compatible archive; `pkgs.ociTools` lacks OCI image-spec support. `nix2container.buildImage` accepts OCI image config and offers Docker/registry copy commands. Bun’s multi-stage recipe uses frozen-lockfile installs; install production deps in a fresh stage because `--production` does not prune existing dev dependencies. [Nixpkgs image manual](https://nixos.org/manual/nixpkgs/stable/#sec-pkgs-ociTools), [nix2container](https://github.com/nlewo/nix2container), [Bun Docker](https://bun.sh/guides/ecosystem/docker), [Bun install](https://bun.sh/docs/pm/cli/install)

## Inference

No custom GCP resource is indicated. Cloud SQL can serve the app database; Cluster defaults to its separate Postgres VM. Replace that store only with a Postgres URL reachable by runners.

## Not verified

No package manifest, Dockerfile, or flake exists to validate. `nix --version` failed: `/bin/bash: line 1: nix: command not found`; no build/deploy run. Docker 29.1.3 is installed. App-specific Cluster/Workflow wiring remains unverified.
