import {
  CONFIRMATION_TTL_SECONDS,
  ConfirmationToken,
  confirmationBoundArgs,
  type McpToolName,
  mcpConfirmRequestKey,
} from "@kvitbit/api-contract";
import { StoreUnavailable } from "@kvitbit/core/ports";
import {
  Conflict,
  type CoreError,
  Invalid,
  NotFound,
  type RequestKey,
  Unavailable,
  type UserId,
  type WorkspaceId,
} from "@kvitbit/domain/contract";
import { CryptoHasher, randomUUIDv7 } from "bun";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { RequestClaimCheck } from "../persistence/CoreStoreSql";

const sha256 = (value: string): string => CryptoHasher.hash("sha256", value, "hex");
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const isJsonArray = (value: Schema.Json): value is Schema.JsonArray => Arr.isArray(value);
const isJsonObject = (value: Schema.Json): value is Schema.JsonObject => Predicate.isObject(value);

const canonicalJson: (value: Schema.Json) => Effect.Effect<string, Schema.SchemaError> = Effect.fn(
  "canonicalConfirmationJson",
)(function* (value) {
  if (isJsonArray(value)) {
    const entries = yield* Effect.forEach(value, canonicalJson, { concurrency: 1 });
    return `[${Arr.join(entries, ",")}]`;
  }
  if (isJsonObject(value)) {
    const encodeEntry = Effect.fnUntraced(function* (key: string) {
      const name = yield* encodeJson(key);
      const nested = yield* canonicalJson(value[key] ?? null);
      return `${name}:${nested}`;
    });
    const entries = yield* Effect.forEach(
      Arr.sort(Rec.keys<string, Schema.Json>(value), Order.String),
      encodeEntry,
      {
        concurrency: 1,
      },
    );
    return `{${Arr.join(entries, ",")}}`;
  }
  return yield* encodeJson(value);
});

// JSON-RPC argument field order is immaterial, array order is bound.
const hashBoundArgs = (args: Schema.JsonObject) =>
  Schema.decodeUnknownEffect(Schema.JsonObject)(confirmationBoundArgs(args)).pipe(
    Effect.flatMap(canonicalJson),
    Effect.map(sha256),
    Effect.orDie,
  );

// Core corrections lock a Payment Tax Document's Proforma first (S4).
const lockCreditProforma = Effect.fn("lockCreditProforma")(function* (
  sql: SqlClient.SqlClient,
  workspaceId: WorkspaceId,
  documentId: string,
) {
  const [parent] = yield* sql<{ readonly to_document_id: string }>`
      SELECT link.to_document_id
      FROM document_relations AS link
      JOIN documents AS source
        ON source.workspace_id = link.workspace_id AND source.id = link.from_document_id
      WHERE link.workspace_id = ${workspaceId} AND link.from_document_id = ${documentId}
        AND link.relation = 'advance_of' AND source.kind = 'payment_tax_document'
    `;
  if (parent !== undefined) {
    yield* sql`
        SELECT id FROM documents WHERE workspace_id = ${workspaceId}
          AND id = ${parent.to_document_id} FOR UPDATE
      `;
  }
});

export interface ConfirmationContext {
  readonly workspaceId: WorkspaceId;
  readonly grantId: string;
  readonly userId: UserId;
  readonly tool: McpToolName;
}

type BoundArgs = Schema.JsonObject;

export interface ConfirmationSubject {
  readonly table: "documents" | "templates";
  readonly id: string;
}

interface ConfirmationRow {
  readonly subject_revision: number | null;
  readonly expires_at: Date | string;
  readonly consumed_at: Date | null;
}

const confirmationError = (
  code:
    | "mcp.confirmation_invalid"
    | "mcp.confirmation_mismatch"
    | "mcp.confirmation_expired"
    | "mcp.confirmation_required",
) => Invalid.make({ issues: [{ path: ["confirmationToken"], code }] });

export const confirmationRequiredError = () => confirmationError("mcp.confirmation_required");

const makeConfirmations = (sql: SqlClient.SqlClient) => ({
  mint: Effect.fn("mintMcpConfirmation")(
    function* (context: ConfirmationContext, args: BoundArgs, subjectRevision: number | null) {
      const now = yield* Clock.currentTimeMillis;
      const expiresAt = DateTime.toDateUtc(
        DateTime.makeUnsafe(now + CONFIRMATION_TTL_SECONDS * 1000),
      );
      const token = ConfirmationToken.make(
        `mcpc_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`,
      );
      const argsHash = yield* hashBoundArgs(args);
      yield* sql`
        INSERT INTO mcp_confirmations
          (id, token_hash, grant_id, user_id, workspace_id, tool, args_hash, subject_revision,
           created_at, expires_at)
        VALUES
          (${randomUUIDv7()}, ${sha256(token)}, ${context.grantId}, ${context.userId},
           ${context.workspaceId}, ${context.tool}, ${argsHash}, ${subjectRevision},
           ${DateTime.toDateUtc(DateTime.makeUnsafe(now))}, ${expiresAt})
      `;
      return { token, expiresAt: expiresAt.toISOString() };
    },
    Effect.catchTag("SqlError", () => Unavailable.make({ dependency: "database" })),
  ),

  confirm: Effect.fn("confirmMcpMutation")(function* <A, R>(
    context: ConfirmationContext,
    args: BoundArgs,
    token: ConfirmationToken,
    subject: ConfirmationSubject | undefined,
    execute: (requestKey: RequestKey) => Effect.Effect<A, CoreError, R>,
  ) {
    const binding = sql`
        token_hash = ${sha256(token)} AND grant_id = ${context.grantId}
        AND user_id = ${context.userId} AND workspace_id = ${context.workspaceId}
        AND tool = ${context.tool}
      `;
    const [approval] = yield* sql<{ readonly id: string; readonly args_hash: string }>`
        SELECT id, args_hash FROM mcp_confirmations WHERE ${binding}
      `.pipe(Effect.catchTag("SqlError", () => Unavailable.make({ dependency: "database" })));
    if (approval === undefined) return yield* confirmationError("mcp.confirmation_invalid");
    if (approval.args_hash !== (yield* hashBoundArgs(args))) {
      return yield* confirmationError("mcp.confirmation_mismatch");
    }

    const requestKey = mcpConfirmRequestKey(approval.id);
    const rejection = yield* Ref.make<Invalid | Conflict | NotFound | null>(null);
    const check = Effect.fn("checkMcpConfirmation")(
      function* (replayed: boolean) {
        // Core has claimed the request key. Re-read under lock in that transaction so
        // revocation, expiry and concurrent confirms cannot race the mutation.
        const [row] = yield* sql<ConfirmationRow>`
            SELECT subject_revision, expires_at, consumed_at
            FROM mcp_confirmations WHERE id = ${approval.id} AND ${binding}
            FOR UPDATE
          `;
        if (row === undefined) return yield* confirmationError("mcp.confirmation_invalid");
        if (row.consumed_at !== null) {
          // A pruned or expired log entry yields a fresh claim. Reject it before core runs.
          if (!replayed) return yield* confirmationError("mcp.confirmation_expired");
          return;
        }

        const now = yield* Clock.currentTimeMillis;
        if (now >= DateTime.toEpochMillis(DateTime.makeUnsafe(row.expires_at))) {
          return yield* confirmationError("mcp.confirmation_expired");
        }
        if (subject !== undefined && row.subject_revision !== null) {
          // The draft issue port takes expectedRevision directly. Keep the other
          // subjects stable until core finishes the write inside this transaction.
          if (context.tool === "create_credit_note") {
            yield* lockCreditProforma(sql, context.workspaceId, subject.id);
          }
          const [current] = yield* sql<{ readonly revision: number }>`
              SELECT revision FROM ${sql(subject.table)}
              WHERE workspace_id = ${context.workspaceId} AND id = ${subject.id}
              FOR UPDATE
            `;
          if (current === undefined) {
            return yield* NotFound.make({
              entity: subject.table === "documents" ? "Document" : "Template",
              id: subject.id,
            });
          }
          if (current.revision !== row.subject_revision) {
            return yield* Conflict.make({
              reason: "revision_changed",
              currentRevision: current.revision,
            });
          }
        }

        // This update rolls back if core fails. The approval, write, and replay result
        // become visible together, including when the client loses the response.
        yield* sql`UPDATE mcp_confirmations SET consumed_at = ${DateTime.toDateUtc(DateTime.makeUnsafe(now))} WHERE id = ${approval.id}`;
      },
      Effect.tapError((error) =>
        error._tag === "SqlError" ? Effect.void : Ref.set(rejection, error),
      ),
      Effect.mapError((cause) => StoreUnavailable.make({ cause })),
    );

    return yield* execute(requestKey).pipe(
      Effect.provideService(RequestClaimCheck, {
        requestKey,
        workspaceId: context.workspaceId,
        check,
      }),
      // The core's storage port fails the transaction with StoreUnavailable. Restore
      // the MCP validation error at the edge once the rollback is complete.
      Effect.catch((error) =>
        Effect.flatMap(Ref.get(rejection), (rejected) => Effect.fail(rejected ?? error)),
      ),
    );
  }),
});

export class McpConfirmations extends Context.Service<
  McpConfirmations,
  ReturnType<typeof makeConfirmations>
>()("@kvitbit/server/mcp/confirmation/McpConfirmations") {}

export const McpConfirmationsLive = Layer.effect(
  McpConfirmations,
  Effect.map(SqlClient.SqlClient, makeConfirmations),
);
