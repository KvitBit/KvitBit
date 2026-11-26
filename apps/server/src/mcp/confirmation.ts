import { createHash, randomBytes } from "node:crypto";
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
import { randomUUIDv7 } from "bun";
import { Clock, Context, Effect, Layer, Ref } from "effect";
import { SqlClient } from "effect/sql";

import { RequestClaimCheck } from "../persistence/CoreStoreSql";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

// The input is the JSON-RPC arguments object. Object order is immaterial, array order is bound.
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
};

const hashBoundArgs = (args: Readonly<Record<string, unknown>>): string =>
  sha256(canonicalJson(confirmationBoundArgs(args)));

// Core corrections lock a Payment Tax Document's Proforma first (S4).
const lockCreditProforma = (
  sql: SqlClient.SqlClient,
  workspaceId: WorkspaceId,
  documentId: string,
) =>
  Effect.gen(function* () {
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

type BoundArgs = Readonly<Record<string, unknown>>;

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
) => new Invalid({ issues: [{ path: ["confirmationToken"], code }] });

export const confirmationRequiredError = () => confirmationError("mcp.confirmation_required");

const makeConfirmations = (sql: SqlClient.SqlClient) => ({
  mint: (context: ConfirmationContext, args: BoundArgs, subjectRevision: number | null) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const expiresAt = new Date(now + CONFIRMATION_TTL_SECONDS * 1000);
      const token = ConfirmationToken.make(`mcpc_${randomBytes(32).toString("base64url")}`);
      yield* sql`
        INSERT INTO mcp_confirmations
          (id, token_hash, grant_id, user_id, workspace_id, tool, args_hash, subject_revision,
           created_at, expires_at)
        VALUES
          (${randomUUIDv7()}, ${sha256(token)}, ${context.grantId}, ${context.userId},
           ${context.workspaceId}, ${context.tool}, ${hashBoundArgs(args)}, ${subjectRevision},
           ${new Date(now)}, ${expiresAt})
      `;
      return { token, expiresAt: expiresAt.toISOString() };
    }).pipe(Effect.catchTag("SqlError", () => new Unavailable({ dependency: "database" }))),

  confirm: <A, R>(
    context: ConfirmationContext,
    args: BoundArgs,
    token: ConfirmationToken,
    subject: ConfirmationSubject | undefined,
    execute: (requestKey: RequestKey) => Effect.Effect<A, CoreError, R>,
  ) =>
    Effect.gen(function* () {
      const binding = sql`
        token_hash = ${sha256(token)} AND grant_id = ${context.grantId}
        AND user_id = ${context.userId} AND workspace_id = ${context.workspaceId}
        AND tool = ${context.tool}
      `;
      const [approval] = yield* sql<{ readonly id: string; readonly args_hash: string }>`
        SELECT id, args_hash FROM mcp_confirmations WHERE ${binding}
      `.pipe(Effect.catchTag("SqlError", () => new Unavailable({ dependency: "database" })));
      if (approval === undefined) return yield* confirmationError("mcp.confirmation_invalid");
      if (approval.args_hash !== hashBoundArgs(args)) {
        return yield* confirmationError("mcp.confirmation_mismatch");
      }

      const requestKey = mcpConfirmRequestKey(approval.id);
      const rejection = yield* Ref.make<Invalid | Conflict | NotFound | null>(null);
      const check = (replayed: boolean) =>
        Effect.gen(function* () {
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
          if (now >= new Date(row.expires_at).getTime()) {
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
              return yield* new NotFound({
                entity: subject.table === "documents" ? "Document" : "Template",
                id: subject.id,
              });
            }
            if (current.revision !== row.subject_revision) {
              return yield* new Conflict({
                reason: "revision_changed",
                currentRevision: current.revision,
              });
            }
          }

          // This update rolls back if core fails. The approval, write, and replay result
          // become visible together, including when the client loses the response.
          yield* sql`UPDATE mcp_confirmations SET consumed_at = ${new Date(now)} WHERE id = ${approval.id}`;
        }).pipe(
          Effect.tapError((error) =>
            error._tag === "SqlError" ? Effect.void : Ref.set(rejection, error),
          ),
          Effect.mapError((cause) => new StoreUnavailable({ cause })),
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
>()("kvitbit/server/mcp/McpConfirmations") {}

export const McpConfirmationsLive = Layer.effect(
  McpConfirmations,
  Effect.map(SqlClient.SqlClient, makeConfirmations),
);
