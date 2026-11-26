/**
 * Stateless MCP Streamable HTTP JSON-RPC 2.0 dispatcher (http-mcp-contracts section 6.1, 6.8).
 *
 * - Supported protocol versions: `2025-11-25`, `2025-06-18`, `2025-03-26` (default when header
 *   absent). Unsupported versions answer 400.
 * - JSON response mode only; batches rejected; notifications answer 202 Accepted.
 * - Origin validated when present (foreign origin -> 403).
 * - Body limit 1 MB (413).
 * - Defects answer JSON-RPC `-32603` with `X-Request-Id` and nothing else.
 */
import {
  MCP_DEFAULT_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
} from "@kvitbit/api-contract";
import { CurrentCaller } from "@kvitbit/domain/contract";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";
import type { PrincipalResolver } from "../auth/PrincipalResolver";
import { requestIdFor } from "../http/edge/requestId";
import { authenticateMcpRequest, wwwAuthenticateHeader } from "./caller";
import type { McpConfigShape } from "./config";
import { formatCoreErrorText } from "./errors";
import { MCP_SERVER_INSTRUCTIONS } from "./guide";
import {
  listResourceTemplates,
  listStaticResources,
  type McpResourceServices,
  ResourceInvalidParams,
  readResource,
} from "./resources";
import { callTool, listTools, type McpToolServices, ToolInvalidParams } from "./tools";

export const MCP_BODY_MAX_BYTES = 1024 * 1024;

const SUPPORTED_VERSIONS = new Set<string>(MCP_SUPPORTED_PROTOCOL_VERSIONS);

type JsonRpcId = string | number | null;

const jsonRpcSuccess = (
  id: JsonRpcId,
  result: unknown,
  headers: Record<string, string>,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id, result }, { status: 200, headers });

const jsonRpcError = (
  id: JsonRpcId,
  code: number,
  message: string,
  status: number,
  headers: Record<string, string>,
  data?: unknown,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(
    {
      jsonrpc: "2.0",
      id,
      error: data === undefined ? { code, message } : { code, message, data },
    },
    { status, headers },
  );

const parseOrigin = (header: string): string | null => {
  try {
    return new URL(header).origin;
  } catch {
    return null;
  }
};

export type McpTransportServices = PrincipalResolver | McpToolServices | McpResourceServices;

export const handleMcpPost = (
  request: HttpServerRequest,
  config: McpConfigShape,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, McpTransportServices> => {
  const requestId = requestIdFor(request.headers["x-request-id"]);
  const baseHeaders: Record<string, string> = {
    "x-request-id": requestId,
    "cache-control": "no-store",
  };

  return Effect.gen(function* () {
    // 1. Origin validation when present (section 6.1).
    const originHeader = request.headers.origin;
    if (originHeader !== undefined) {
      const normalized = parseOrigin(originHeader);
      if (normalized === null || !config.trustedOrigins.has(normalized)) {
        return jsonRpcError(null, -32000, `Invalid Origin: ${originHeader}`, 403, baseHeaders);
      }
    }

    // 2. MCP-Protocol-Version validation (section 6.1).
    const requestedVersion = request.headers["mcp-protocol-version"];
    if (requestedVersion !== undefined && !SUPPORTED_VERSIONS.has(requestedVersion)) {
      return jsonRpcError(
        null,
        -32600,
        `Unsupported MCP-Protocol-Version: ${requestedVersion}`,
        400,
        baseHeaders,
      );
    }
    const activeProtocolVersion = requestedVersion ?? MCP_DEFAULT_PROTOCOL_VERSION;
    const responseHeaders: Record<string, string> = {
      ...baseHeaders,
      "mcp-protocol-version": activeProtocolVersion,
    };

    // 3. OAuth 2.1 Bearer authentication strictly via PrincipalResolver.fromMcpBearer (rule A1).
    const authResult = yield* authenticateMcpRequest(request, config).pipe(Effect.result);
    if (authResult._tag === "Failure") {
      const reason = authResult.failure.reason;
      return HttpServerResponse.jsonUnsafe(
        {
          error: reason === "missing" ? "unauthorized" : "invalid_token",
          reason,
        },
        {
          status: 401,
          headers: {
            ...baseHeaders,
            "www-authenticate": wwwAuthenticateHeader(config.appOrigin, reason),
          },
        },
      );
    }
    const auth = authResult.success;

    // 4. Body size limit (1 MB).
    const contentLengthHeader = request.headers["content-length"];
    if (contentLengthHeader !== undefined) {
      const declaredLength = Number(contentLengthHeader);
      if (Number.isFinite(declaredLength) && declaredLength > MCP_BODY_MAX_BYTES) {
        return jsonRpcError(null, -32600, "Request body exceeds 1 MB limit", 413, responseHeaders);
      }
    }

    const rawBytes = yield* request.arrayBuffer.pipe(
      Effect.map((buf) => new Uint8Array(buf)),
      Effect.catch(() => Effect.succeed(null)),
    );
    if (rawBytes === null) {
      return jsonRpcError(null, -32700, "Failed to read request body", 400, responseHeaders);
    }
    if (rawBytes.byteLength > MCP_BODY_MAX_BYTES) {
      return jsonRpcError(null, -32600, "Request body exceeds 1 MB limit", 413, responseHeaders);
    }

    // 5. Parse JSON-RPC envelope; reject batches.
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(rawBytes));
    } catch {
      return jsonRpcError(null, -32700, "Parse error: invalid JSON", 400, responseHeaders);
    }

    if (Array.isArray(parsed)) {
      return jsonRpcError(
        null,
        -32600,
        "Invalid Request: JSON-RPC batches are not supported",
        400,
        responseHeaders,
      );
    }
    if (typeof parsed !== "object" || parsed === null) {
      return jsonRpcError(null, -32600, "Invalid Request", 400, responseHeaders);
    }

    const envelope = parsed as Record<string, unknown>;
    if (envelope.jsonrpc !== "2.0" || typeof envelope.method !== "string") {
      return jsonRpcError(null, -32600, "Invalid Request", 400, responseHeaders);
    }

    const hasId = "id" in envelope && envelope.id !== undefined;
    const id: JsonRpcId =
      typeof envelope.id === "string" || typeof envelope.id === "number" || envelope.id === null
        ? envelope.id
        : null;
    const method = envelope.method;
    const params =
      typeof envelope.params === "object" &&
      envelope.params !== null &&
      !Array.isArray(envelope.params)
        ? (envelope.params as Record<string, unknown>)
        : {};

    // Notifications (no `id`) receive 202 Accepted with empty body.
    if (!hasId) {
      return HttpServerResponse.empty({ status: 202, headers: responseHeaders });
    }

    // 6. Dispatch MCP methods.
    switch (method) {
      case "initialize": {
        const clientVersion =
          typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
        const negotiatedVersion =
          clientVersion !== undefined && SUPPORTED_VERSIONS.has(clientVersion)
            ? clientVersion
            : MCP_PROTOCOL_VERSION;
        return jsonRpcSuccess(
          id,
          {
            protocolVersion: negotiatedVersion,
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
            },
            serverInfo: {
              name: MCP_SERVER_NAME,
              version: config.version,
            },
            instructions: MCP_SERVER_INSTRUCTIONS,
          },
          { ...responseHeaders, "mcp-protocol-version": negotiatedVersion },
        );
      }

      case "ping":
        return jsonRpcSuccess(id, {}, responseHeaders);

      case "tools/list":
        return jsonRpcSuccess(id, { tools: listTools(auth.caller) }, responseHeaders);

      case "tools/call": {
        if (typeof params.name !== "string" || params.name.length === 0) {
          return jsonRpcError(
            id,
            -32602,
            "Invalid params: missing tool name",
            200,
            responseHeaders,
          );
        }
        const result = yield* callTool(params.name, params.arguments, auth).pipe(
          Effect.provideService(CurrentCaller, auth.caller),
          Effect.result,
        );
        if (result._tag === "Failure") {
          const err = result.failure;
          return jsonRpcError(
            id,
            -32602,
            err.message,
            200,
            responseHeaders,
            err instanceof ToolInvalidParams ? err.issues : undefined,
          );
        }
        return jsonRpcSuccess(id, result.success, responseHeaders);
      }

      case "resources/list":
        return jsonRpcSuccess(id, { resources: listStaticResources(auth.caller) }, responseHeaders);

      case "resources/templates/list":
        return jsonRpcSuccess(
          id,
          { resourceTemplates: listResourceTemplates(auth.caller) },
          responseHeaders,
        );

      case "resources/read": {
        if (typeof params.uri !== "string" || params.uri.length === 0) {
          return jsonRpcError(
            id,
            -32602,
            "Invalid params: missing resource uri",
            200,
            responseHeaders,
          );
        }
        const result = yield* readResource(params.uri, auth.caller).pipe(
          Effect.provideService(CurrentCaller, auth.caller),
          Effect.result,
        );
        if (result._tag === "Failure") {
          const err = result.failure;
          if (err instanceof ResourceInvalidParams) {
            return jsonRpcError(id, -32602, err.message, 200, responseHeaders);
          }
          return jsonRpcError(
            id,
            -32002,
            formatCoreErrorText(err, auth.caller),
            200,
            responseHeaders,
            { error: err },
          );
        }
        return jsonRpcSuccess(id, { contents: result.success }, responseHeaders);
      }

      default:
        return jsonRpcError(id, -32601, `Method not found: ${method}`, 200, responseHeaders);
    }
  }).pipe(
    Effect.catchDefect(() =>
      Effect.succeed(
        jsonRpcError(null, -32603, `Internal error (requestId: ${requestId})`, 500, baseHeaders),
      ),
    ),
  );
};
