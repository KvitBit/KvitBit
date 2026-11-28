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
import * as Arr from "effect/Array";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { PrincipalResolver } from "../auth/PrincipalResolver";
import { RATE_LIMITS, RateLimiter } from "../http/edge/RateLimiter";
import { requestIdFor } from "../http/edge/requestId";
import { authenticateMcpRequest, wwwAuthenticateHeader } from "./caller";
import type { McpConfigShape } from "./config";
import { encodeToolError, formatCoreErrorText } from "./errors";
import { MCP_SERVER_INSTRUCTIONS } from "./guide";
import {
  listResourceTemplates,
  listStaticResources,
  type McpResourceServices,
  readResource,
} from "./resources";
import { callTool, listTools, type McpToolServices } from "./tools";

const MCP_BODY_MAX_BYTES = 1024 * 1024;

const SUPPORTED_VERSIONS = new Set<string>(MCP_SUPPORTED_PROTOCOL_VERSIONS);

type JsonRpcId = string | number | null;

const jsonRpcSuccess = <A>(
  id: JsonRpcId,
  result: A,
  headers: Record<string, string>,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id, result }, { status: 200, headers });

const jsonRpcError = <A>(
  id: JsonRpcId,
  code: number,
  message: string,
  status: number,
  headers: Record<string, string>,
  data?: A,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(
    {
      jsonrpc: "2.0",
      id,
      error: data === undefined ? { code, message } : { code, message, data },
    },
    { status, headers },
  );

const parseJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeEnvelope = Schema.decodeUnknownOption(
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    method: Schema.String,
    id: Schema.optional(Schema.Unknown),
    params: Schema.optional(Schema.Unknown),
  }),
);
const decodeParams = Schema.decodeUnknownOption(Schema.JsonObject);
const isString = Schema.is(Schema.String);
const isId = Schema.is(Schema.Union([Schema.String, Schema.Finite, Schema.Null]));
const oversizedBody = { BodyTooLarge: true };

export type McpTransportServices =
  | PrincipalResolver
  | RateLimiter
  | McpToolServices
  | McpResourceServices;

export const handleMcpPost = Effect.fn("handleMcpPost")(
  (
    request: HttpServerRequest.HttpServerRequest,
    config: McpConfigShape,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, never, McpTransportServices> => {
    const requestId = requestIdFor(request.headers["x-request-id"]);
    const baseHeaders = {
      "x-request-id": requestId,
      "cache-control": "no-store",
    };

    return Effect.gen(function* () {
      // 1. Origin validation when present (section 6.1).
      const originHeader = request.headers["origin"];
      if (originHeader !== undefined) {
        const normalized = URL.parse(originHeader)?.origin;
        if (normalized === undefined || !config.trustedOrigins.has(normalized)) {
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
      const responseHeaders = {
        ...baseHeaders,
        "mcp-protocol-version": activeProtocolVersion,
      };

      // 3. OAuth 2.1 Bearer authentication strictly via PrincipalResolver.fromMcpBearer (rule A1).
      const authResult = yield* authenticateMcpRequest(config)(request).pipe(Effect.result);
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
              "www-authenticate": wwwAuthenticateHeader(config.appOrigin)(reason),
            },
          },
        );
      }
      const auth = authResult.success;

      // 3b. Per-grant rate limit (http-mcp-contracts section 2.5: 300/min per grant, trailing window).
      const rateLimiter = yield* RateLimiter;
      const rateDecision = yield* rateLimiter.consume(
        `mcp-grant:${auth.grant.grantId}`,
        RATE_LIMITS.mcpGrant,
      );
      if (!rateDecision.allowed) {
        return HttpServerResponse.jsonUnsafe(
          {
            _tag: "RateLimited",
            retryAfterSeconds: rateDecision.retryAfterSeconds,
          },
          {
            status: 429,
            headers: {
              ...responseHeaders,
              "retry-after": String(Math.ceil(rateDecision.retryAfterSeconds)),
            },
          },
        );
      }

      // 4. Body size limit (1 MB).
      const contentLengthHeader = request.headers["content-length"];
      if (contentLengthHeader !== undefined) {
        const declaredLength = Number(contentLengthHeader);
        if (Number.isFinite(declaredLength) && declaredLength > MCP_BODY_MAX_BYTES) {
          return jsonRpcError(
            null,
            -32600,
            "Request body exceeds 1 MB limit",
            413,
            responseHeaders,
          );
        }
      }

      const rawBody = yield* request.arrayBuffer.pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MCP_BODY_MAX_BYTES)),
        Effect.result,
      );
      if (rawBody._tag === "Failure") {
        const reason = rawBody.failure.reason;
        if (
          reason._tag === "RequestParseError" &&
          reason.reason !== undefined &&
          reason.reason in oversizedBody
        ) {
          return jsonRpcError(
            null,
            -32600,
            "Request body exceeds 1 MB limit",
            413,
            responseHeaders,
          );
        }
        return jsonRpcError(null, -32700, "Failed to read request body", 400, responseHeaders);
      }
      const rawBytes = new Uint8Array(rawBody.success);

      // 5. Parse JSON-RPC envelope; reject batches.
      const parsed = yield* parseJson(new TextDecoder().decode(rawBytes)).pipe(Effect.result);
      if (parsed._tag === "Failure") {
        return jsonRpcError(null, -32700, "Parse error: invalid JSON", 400, responseHeaders);
      }

      if (Arr.isArray(parsed.success)) {
        return jsonRpcError(
          null,
          -32600,
          "Invalid Request: JSON-RPC batches are not supported",
          400,
          responseHeaders,
        );
      }
      const envelope = decodeEnvelope(parsed.success);
      if (Option.isNone(envelope)) {
        return jsonRpcError(null, -32600, "Invalid Request", 400, responseHeaders);
      }

      const { id: rawId, method, params: rawParams } = envelope.value;
      const hasId = rawId !== undefined;
      const id = isId(rawId) ? rawId : null;
      const params: Schema.JsonObject = Option.getOrElse(decodeParams(rawParams), () => ({}));

      // Notifications (no `id`) receive 202 Accepted with empty body.
      if (!hasId) {
        return HttpServerResponse.empty({ status: 202, headers: responseHeaders });
      }

      // 6. Dispatch MCP methods.
      switch (method) {
        case "initialize": {
          const clientVersion = isString(params["protocolVersion"])
            ? params["protocolVersion"]
            : undefined;
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
          if (!isString(params["name"]) || params["name"].length === 0) {
            return jsonRpcError(
              id,
              -32602,
              "Invalid params: missing tool name",
              200,
              responseHeaders,
            );
          }
          const result = yield* callTool(params["name"], params["arguments"], auth).pipe(
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
              err._tag === "ToolInvalidParams" ? err.issues : undefined,
            );
          }
          return jsonRpcSuccess(id, result.success, responseHeaders);
        }

        case "resources/list":
          return jsonRpcSuccess(
            id,
            { resources: listStaticResources(auth.caller) },
            responseHeaders,
          );

        case "resources/templates/list":
          return jsonRpcSuccess(
            id,
            { resourceTemplates: listResourceTemplates(auth.caller) },
            responseHeaders,
          );

        case "resources/read": {
          if (!isString(params["uri"]) || params["uri"].length === 0) {
            return jsonRpcError(
              id,
              -32602,
              "Invalid params: missing resource uri",
              200,
              responseHeaders,
            );
          }
          const result = yield* readResource(params["uri"], auth.caller).pipe(Effect.result);
          if (result._tag === "Failure") {
            const err = result.failure;
            if (err._tag === "ResourceInvalidParams") {
              return jsonRpcError(id, -32602, err.message, 200, responseHeaders);
            }
            const data = yield* encodeToolError(err);
            return jsonRpcError(
              id,
              -32002,
              formatCoreErrorText(auth.caller)(err),
              200,
              responseHeaders,
              data,
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
  },
);
