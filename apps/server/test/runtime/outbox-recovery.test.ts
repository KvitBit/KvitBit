import { expect, test } from "bun:test";
import { Caller, ExportId, UserId, Workspaces } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { makeCronHandlers } from "../../src/runtime/crons";
import { DataExportWorkflow, makeWorkflowHandlersLayer } from "../../src/runtime/workflows";
import { runSqlCore } from "../persistence/conformance/sqlCore";

test("outbox reconciliation resumes a failed export finalizer under the original workflow key", async () => {
  const owner = {
    userId: UserId.make("01950000-0000-7000-8000-000000000001"),
    name: "Owner",
    email: "owner@example.test",
  };
  const exportId = ExportId.make("01950000-0000-7000-8000-000000000002");
  const workflows = makeWorkflowHandlersLayer().pipe(
    Layer.provideMerge(WorkflowEngine.layerMemory),
  );
  const exit = await runSqlCore({
    effect: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const workspaces = yield* Workspaces;
      const { workspaceId } = yield* workspaces.create(
        Caller.account({ ...owner, channel: "web", locale: "cs" }),
        { name: "Export fixture" },
      );
      yield* sql`INSERT INTO exports (id, workspace_id, created_at)
        VALUES (${exportId}, ${workspaceId}, '2020-01-01T00:00:00Z')`;
      yield* sql`CREATE FUNCTION reject_export_finish() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic export finish failure'; END;
        $$`;
      yield* sql`CREATE TRIGGER fail_export_finish BEFORE UPDATE ON exports
        FOR EACH ROW EXECUTE FUNCTION reject_export_finish()`;

      yield* Effect.gen(function* () {
        const payload = { workspaceId, exportId };
        const executionId = yield* DataExportWorkflow.executionId(payload);
        yield* DataExportWorkflow.execute(payload, { discard: true, detached: true });
        let suspended = false;
        for (let attempts = 0; attempts < 100; attempts++) {
          const result = yield* DataExportWorkflow.poll(executionId);
          if (
            Option.isSome(result) &&
            result.value._tag === "Suspended" &&
            result.value.failed === true
          ) {
            suspended = true;
            break;
          }
          yield* Effect.promise(() => Bun.sleep(20));
        }
        expect(suspended).toBe(true);
        yield* sql`DROP TRIGGER fail_export_finish ON exports`;
        yield* makeCronHandlers().outboxReconcile;
        const recovered = yield* DataExportWorkflow.execute(payload);
        expect(recovered).toBe("ready");
      }).pipe(Effect.provide(workflows));

      const [row] =
        yield* sql`SELECT status, size_bytes > 0 AS nonempty FROM exports WHERE id = ${exportId}`;
      return row;
    }),
    options: { users: [owner] },
  });
  expect(exit).toMatchObject({ _tag: "Success", value: { status: "ready", nonempty: true } });
}, 30_000);
