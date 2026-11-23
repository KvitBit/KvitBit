# Nine domain modules over Postgres, a sealed Caller, and Cluster workflows for the core

`packages/core` exposes nine caller-facing modules named after CONTEXT.md concepts (Workspaces, Contacts, PriceList, Documents, Payments, Expenses, Templates, Reports, PublicShareLinks), each requiring a sealed `Caller` (Member, Account, ShareLinkVisitor, or core-only System) and failing with five shared `Schema.TaggedError`s. Modules use `SqlClient` directly with row locks and optimistic revisions instead of repository ports or Cluster Entities, and durable jobs run as Effect `Workflow`s on `ClusterWorkflowEngine` with `ClusterCron` sweeps. We chose this because the Czech rules (numbering, VAT per rate bucket, Proforma to Payment Tax Document, statutory text) must sit behind one seam shared by HTTP, MCP, Foldkit, Expo and workflows, and because Postgres transactions give gapless number allocation (with permanent number reservations) and read-your-writes on both Neon and a single self-hosted Postgres. The full contract is in `docs/design/core-ports.md`.

## Considered Options

- **One generic Ledger service (`put`/`act`/`read`)**: smallest surface, but every caller learns a tagged-union catalogue and domain locality is lost.
- **Command/Query bus over Cluster Entities (DocumentEntity, WorkspaceEntity)**: per-aggregate ordering for free, but every edit becomes a persisted cluster message and a hop from Cloud Run to a Compute Engine runner, with more Neon writes and weaker read-your-writes. A Postgres row lock already serializes writers per document.
- **Repository ports**: rejected; Postgres is committed, and SQL behaviour (row locks, unique numbers, request-key dedupe) must be tested for real.

## Consequences

- Workspace scope comes only from the `Caller`; domain methods take no `workspaceId`, and records of other Workspaces read as `NotFound`.
- Tests need PGlite or a scratch Postgres database; contention tests need real Postgres.
- Domain rows act as the outbox for workflow starts, with an `OutboxReconcile` cron; workflows use no compensation in v1 because issued numbers and sent emails cannot be undone.
- On Neon, application SQL uses the pooled endpoint and Cluster storage uses the direct endpoint (advisory locks).
- Errors are wire-visible, so changing an error shape is an API change for HttpApi (#19) and ui-port (#20).
- `@kvitbit/core/contract` and `/engines` are browser and React Native safe; ui-port depends on them and on the HttpApi contract, never on the server core.
