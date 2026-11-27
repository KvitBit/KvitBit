import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { MCP_PROTOCOL_VERSION, OAUTH_SCOPES_SUPPORTED } from "@kvitbit/api-contract";
import { MCP_ORIGIN, makeMcpHarness } from "./harness";

setDefaultTimeout(15_000);

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe("MCP Streamable HTTP transport, OAuth metadata, and authentication", () => {
  test("GET /.well-known/oauth-protected-resource and /mcp return RFC 9728 metadata", async () => {
    const h = makeMcpHarness();
    cleanup = h.dispose;

    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const res = await h.fetch(path);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({
        resource: `${MCP_ORIGIN}/mcp`,
        authorization_servers: [`${MCP_ORIGIN}/api/auth`],
        scopes_supported: [...OAUTH_SCOPES_SUPPORTED],
        bearer_methods_supported: ["header"],
        resource_name: "kvitbit",
        resource_documentation: `${MCP_ORIGIN}/docs/mcp`,
      });
    }
  });

  test("GET /mcp and DELETE /mcp answer 405 with Allow: POST", async () => {
    const h = makeMcpHarness();
    cleanup = h.dispose;

    for (const method of ["GET", "DELETE"]) {
      const res = await h.fetch("/mcp", { method });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  test("401 WWW-Authenticate distinguishes missing token vs invalid/expired/cookie/kvb_ key", async () => {
    const h = makeMcpHarness();
    cleanup = h.dispose;

    // Missing header -> no error="invalid_token"
    const missing = await h.postMcp(null, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="kvitbit:read"`,
    );

    // Expired token -> error="invalid_token"
    const expired = await h.postMcp("expired-token", { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(expired.status).toBe(401);
    expect(expired.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="kvitbit:read", error="invalid_token"`,
    );

    // Cookie-only request (rule A1) -> rejected as missing
    const cookieOnly = await h.fetch("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "__Secure-kvitbit.session_token=session:123",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(cookieOnly.status).toBe(401);

    // kvb_ API key (rule A1) -> rejected as invalid_token
    const apiKey = await h.postMcp("kvb_some_api_key", { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(apiKey.status).toBe(401);
    expect(apiKey.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  test("non-member grant maps Workspaces.enter NotFound to 401 invalid_token", async () => {
    const h = makeMcpHarness();
    cleanup = h.dispose;

    const owner = h.addUser("Owner");
    const outsider = h.addUser("Outsider");
    const ws = await h.createWorkspace(owner);
    const outsiderGrant = h.addReadWriteGrant(outsider, ws.workspaceId);

    const res = await h.postMcp(outsiderGrant.token, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  test("Origin validation, MCP-Protocol-Version, 1 MB limit, batch rejection, initialize, ping, notifications", async () => {
    const h = makeMcpHarness();
    cleanup = h.dispose;

    const owner = h.addUser("Owner");
    const ws = await h.createWorkspace(owner);
    const grant = h.addReadWriteGrant(owner, ws.workspaceId);

    // Foreign Origin -> 403
    const foreign = await h.postMcp(
      grant.token,
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { origin: "https://evil.example" },
    );
    expect(foreign.status).toBe(403);

    // Trusted Origin -> 200
    const trusted = await h.rpc(grant.token, "ping", undefined, 1, { origin: MCP_ORIGIN });
    expect(trusted.res.status).toBe(200);
    expect(trusted.json.result).toEqual({});

    // Unsupported MCP-Protocol-Version -> 400
    const badVersion = await h.postMcp(
      grant.token,
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { "mcp-protocol-version": "2020-01-01" },
    );
    expect(badVersion.status).toBe(400);

    // Absent MCP-Protocol-Version defaults to 2025-03-26
    expect(trusted.res.headers.get("mcp-protocol-version")).toBe("2025-03-26");

    // initialize negotiates protocol version and advertises capabilities + instructions
    const init = await h.rpc(
      grant.token,
      "initialize",
      { protocolVersion: MCP_PROTOCOL_VERSION },
      42,
      { "mcp-protocol-version": MCP_PROTOCOL_VERSION },
    );
    expect(init.res.status).toBe(200);
    expect(init.res.headers.get("mcp-protocol-version")).toBe(MCP_PROTOCOL_VERSION);
    expect(init.json.result).toMatchObject({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
      },
      serverInfo: { name: "kvitbit", version: "0.0.0-test" },
    });
    expect((init.json.result as { readonly instructions: string }).instructions).toContain(
      "kvitbit://guide",
    );

    // Notification (no id) -> 202 Accepted
    const notif = await h.postMcp(grant.token, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(notif.status).toBe(202);

    // JSON-RPC batch -> 400 -32600
    const batch = await h.postMcp(grant.token, [{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    expect(batch.status).toBe(400);
    expect(((await batch.json()) as { error: { code: number } }).error.code).toBe(-32600);

    // Invalid JSON -> 400 -32700
    const badJson = await h.postMcp(grant.token, "{not-json");
    expect(badJson.status).toBe(400);
    expect(((await badJson.json()) as { error: { code: number } }).error.code).toBe(-32700);

    // > 1 MB body -> 413
    const huge = await h.postMcp(grant.token, "x".repeat(1024 * 1024 + 10));
    expect(huge.status).toBe(413);

    // Unknown method -> -32601
    const unknown = await h.rpc(grant.token, "prompts/list");
    expect((unknown.json.error as { code: number }).code).toBe(-32601);
  });
});
