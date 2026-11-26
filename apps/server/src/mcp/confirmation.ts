/**
 * Stateless HMAC-SHA256 confirmation tokens for two-step MCP tools (http-mcp-contracts 6.6;
 * board #896).
 *
 * Binary layout (65 bytes -> 87 base64url chars, matching `^mcpc_[A-Za-z0-9_-]{16,128}$`):
 *   [0]      version = 1 (1 byte)
 *   [1..16]  confirmationId = 16 random bytes (32-char hex -> `mcp-confirm:<hex>`)
 *   [17..20] expiresAtEpochSeconds = uint32 BE
 *   [21..24] subjectRevision = int32 BE (-1 when no existing subject revision)
 *   [25..32] argsHashPrefix = first 8 bytes of SHA-256(canonicalJson(boundArgs))
 *   [33..48] contextMac = first 16 bytes of HMAC-SHA256(key, "ctx" || header || context)
 *   [49..64] fullMac    = first 16 bytes of HMAC-SHA256(key, "arg" || header || context || fullArgsHash)
 *
 * Checking `contextMac` before `fullMac` distinguishes `mcp.confirmation_invalid` (tampered or
 * wrong grant/user/workspace/tool) from `mcp.confirmation_mismatch` (valid token for this
 * context, but arguments were modified after preview).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  CONFIRMATION_TTL_SECONDS,
  ConfirmationToken,
  confirmationBoundArgs,
  type McpToolName,
} from "@kvitbit/api-contract";
import { Invalid, type UserId, type WorkspaceId } from "@kvitbit/domain/contract";
import { Effect } from "effect";

const TOKEN_PREFIX = "mcpc_";
const TOKEN_VERSION = 1;
const TOKEN_BYTES = 65;

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return JSON.stringify(value.toString());
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`canonicalJson: non-finite number ${value}`);
    }
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
};

const hashBoundArgs = (args: Readonly<Record<string, unknown>>): Buffer =>
  createHash("sha256")
    .update(canonicalJson(confirmationBoundArgs(args)), "utf8")
    .digest();

const encodeContext = (ctx: ConfirmationContext): Buffer =>
  Buffer.from(`${ctx.workspaceId}\0${ctx.grantId}\0${ctx.userId}\0${ctx.tool}`, "utf8");

const computeContextMac = (key: Uint8Array, header: Buffer, ctxBytes: Buffer): Buffer =>
  createHmac("sha256", key).update("ctx").update(header).update(ctxBytes).digest().subarray(0, 16);

const computeFullMac = (
  key: Uint8Array,
  header: Buffer,
  ctxBytes: Buffer,
  fullArgsHash: Buffer,
): Buffer =>
  createHmac("sha256", key)
    .update("arg")
    .update(header)
    .update(ctxBytes)
    .update(fullArgsHash)
    .digest()
    .subarray(0, 16);

export interface ConfirmationContext {
  readonly workspaceId: WorkspaceId;
  readonly grantId: string;
  readonly userId: UserId;
  readonly tool: McpToolName;
}

export interface MintedConfirmation {
  readonly confirmationId: string;
  readonly token: ConfirmationToken;
  readonly expiresAt: string;
}

export interface VerifiedConfirmation {
  readonly confirmationId: string;
  readonly subjectRevision: number | null;
  readonly expiresAt: string;
  readonly expiresAtSeconds: number;
}

export const mintConfirmationToken = (options: {
  readonly key: Uint8Array;
  readonly context: ConfirmationContext;
  readonly args: Readonly<Record<string, unknown>>;
  readonly subjectRevision: number | null;
  readonly nowMillis: number;
}): MintedConfirmation => {
  const idBytes = randomBytes(16);
  const confirmationId = idBytes.toString("hex");
  const expiresAtSeconds = Math.floor(options.nowMillis / 1000) + CONFIRMATION_TTL_SECONDS;
  const fullArgsHash = hashBoundArgs(options.args);

  const header = Buffer.alloc(33);
  header.writeUInt8(TOKEN_VERSION, 0);
  idBytes.copy(header, 1);
  header.writeUInt32BE(expiresAtSeconds >>> 0, 17);
  header.writeInt32BE(options.subjectRevision === null ? -1 : options.subjectRevision, 21);
  fullArgsHash.subarray(0, 8).copy(header, 25);

  const ctxBytes = encodeContext(options.context);
  const ctxMac = computeContextMac(options.key, header, ctxBytes);
  const fullMac = computeFullMac(options.key, header, ctxBytes, fullArgsHash);

  const raw = Buffer.concat([header, ctxMac, fullMac]);
  const token = ConfirmationToken.make(`${TOKEN_PREFIX}${raw.toString("base64url")}`);
  return {
    confirmationId,
    token,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
  };
};

const confirmationError = (
  code:
    | "mcp.confirmation_invalid"
    | "mcp.confirmation_mismatch"
    | "mcp.confirmation_expired"
    | "mcp.confirmation_required",
) =>
  new Invalid({
    issues: [{ path: ["confirmationToken"], code }],
  });

export const confirmationRequiredError = () => confirmationError("mcp.confirmation_required");
export const confirmationExpiredError = () => confirmationError("mcp.confirmation_expired");

export const verifyConfirmationToken = (options: {
  readonly key: Uint8Array;
  readonly token: ConfirmationToken;
  readonly context: ConfirmationContext;
  readonly args: Readonly<Record<string, unknown>>;
  readonly nowMillis: number;
}): Effect.Effect<VerifiedConfirmation, Invalid> =>
  Effect.suspend(() => {
    if (!options.token.startsWith(TOKEN_PREFIX)) {
      return Effect.fail(confirmationError("mcp.confirmation_invalid"));
    }
    const encoded = options.token.slice(TOKEN_PREFIX.length);
    const raw = Buffer.from(encoded, "base64url");
    if (raw.length !== TOKEN_BYTES || raw.readUInt8(0) !== TOKEN_VERSION) {
      return Effect.fail(confirmationError("mcp.confirmation_invalid"));
    }

    const header = raw.subarray(0, 33);
    const tokenCtxMac = raw.subarray(33, 49);
    const tokenFullMac = raw.subarray(49, 65);

    const ctxBytes = encodeContext(options.context);
    const expectedCtxMac = computeContextMac(options.key, header, ctxBytes);
    if (!timingSafeEqual(tokenCtxMac, expectedCtxMac)) {
      return Effect.fail(confirmationError("mcp.confirmation_invalid"));
    }

    const actualArgsHash = hashBoundArgs(options.args);
    const expectedFullMac = computeFullMac(options.key, header, ctxBytes, actualArgsHash);
    if (!timingSafeEqual(tokenFullMac, expectedFullMac)) {
      return Effect.fail(confirmationError("mcp.confirmation_mismatch"));
    }

    const expiresAtSeconds = header.readUInt32BE(17);
    const nowSeconds = Math.floor(options.nowMillis / 1000);
    if (nowSeconds >= expiresAtSeconds) {
      return Effect.fail(confirmationError("mcp.confirmation_expired"));
    }

    const confirmationId = header.subarray(1, 17).toString("hex");
    const rawRev = header.readInt32BE(21);
    const subjectRevision = rawRev === -1 ? null : rawRev;

    return Effect.succeed({
      confirmationId,
      subjectRevision,
      expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
      expiresAtSeconds,
    });
  });

/**
 * Bounded in-process cache of consumed confirmation IDs (fast-path complement to core's durable
 * request log). Ensures a replayed confirm on tools whose core write bumps the subject's revision
 * (such as `create_final_invoice` and `create_credit_note`) answers `mcp.confirmation_expired`
 * rather than `Conflict{revision_changed}`.
 */
export class ConsumedConfirmationCache {
  private readonly entries = new Map<string, number>();
  private readonly maxEntries: number;

  constructor(maxEntries = 10_000) {
    this.maxEntries = maxEntries;
  }

  has(confirmationId: string, nowSeconds: number): boolean {
    const exp = this.entries.get(confirmationId);
    if (exp === undefined) return false;
    if (nowSeconds >= exp) {
      this.entries.delete(confirmationId);
      return false;
    }
    return true;
  }

  markConsumed(confirmationId: string, expiresAtSeconds: number, nowSeconds: number): void {
    this.entries.set(confirmationId, expiresAtSeconds);
    if (this.entries.size > this.maxEntries) {
      for (const [id, exp] of this.entries) {
        if (nowSeconds >= exp || this.entries.size > this.maxEntries) {
          this.entries.delete(id);
        }
        if (this.entries.size <= this.maxEntries) break;
      }
    }
  }
}
