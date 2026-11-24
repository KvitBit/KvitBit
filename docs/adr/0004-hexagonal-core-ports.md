# Nine domain modules over Postgres, a sealed Caller, and Cluster workflows for the core

`packages/core` exposes nine caller-facing modules named after CONTEXT.md concepts (Workspaces, Contacts, PriceList, Documents, Payments, Expenses, Templates, Reports, PublicShareLinks), each requiring a sealed `Caller` (Member, Account, ShareLinkVisitor, or core-only System) and failing with five shared `Schema.TaggedError`s. Modules rely on Postgres row locks and optimistic revisions instead of Cluster Entities (reached through core-owned ports since Phase 2, see Refinement), and durable jobs run as Effect `Workflow`s on `ClusterWorkflowEngine` with `ClusterCron` sweeps. We chose this because the Czech rules (numbering, VAT per rate bucket, Proforma to Payment Tax Document, statutory text) must sit behind one seam shared by HTTP, MCP, Foldkit, Expo and workflows, and because Postgres transactions give gapless number allocation (with permanent number reservations) and read-your-writes on both Neon and a single self-hosted Postgres. The full contract is in `docs/design/core-ports.md`.

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

## Refinement (Phase 2): a pure core behind `CoreStore` and per-module repository ports

Phase 2 replaced direct `SqlClient` use in modules with a seam owned by the core, so `@kvitbit/core` has no Drizzle, `@effect/sql` or SQL imports.

- `CoreStore` (`packages/core/src/store/CoreStore.ts`) is the persistence port for cross-cutting state: the `transaction(effect)` wrapper (nested calls are savepoints, S4 retries on the outermost only), `afterCommit`, the request log (C3), numbering counters and number reservations (D1, S3), and audit entries.
- Each module declares its own repository port in `modules/<module>/repo.ts` with named operations (lock with expected revision, compare-and-set update, Workspace-scoped `NotFound`, `UniqueViolation`), following `store/tables.ts`. Aggregate rows live behind these ports, not in `CoreStore`.
- The in-memory implementations (`@kvitbit/core/testing`, `TestCore`) share one store's transactions and are what the core's unit, property and formal replay suites run against. `CoreLive` takes the ports as layers.
- The SQL implementations are bound in `apps/server` from `@kvitbit/db` (the Drizzle schema and migrations) and `@kvitbit/adapters/sql` (transactions, row locks at READ COMMITTED, request log, numbering). They must keep the port contracts that the memory store models, including constraint behaviour such as `number_reservations_document_fk`; PGlite tests over the committed migrations check this.

This keeps the original decision (Postgres row locks, revisions, gapless numbering) but makes the "Repository ports: rejected" option above the chosen one for how modules reach Postgres. SQL behaviour is still tested for real, at the adapter and `apps/server` seam instead of inside each module.
