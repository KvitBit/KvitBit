import { describe, expect, it } from "bun:test";
import {
  AccountPreferences,
  ApiKeyCreated,
  BrandingView,
  ConnectedAppView,
} from "@kvitbit/api-contract";
import { NumberingSeriesView, RegistryResult } from "@kvitbit/domain";
import { Schema } from "effect";
import { match } from "../../src/demo/router";
import { routes } from "../../src/demo/settings";
import { DEMO_WORKSPACE } from "../../src/demo/shell";

const callDemo = (method: string, path: string, body: unknown = null) => {
  const found = match(routes, method, path);
  expect(found).toBeDefined();
  if (found === undefined) throw new Error(`No route for ${method} ${path}`);
  return found.route.respond({
    method,
    path,
    params: found.params,
    query: new URLSearchParams(),
    body,
  });
};

describe("Settings & Account demo routes", () => {
  const ws = DEMO_WORKSPACE.id;

  it("serves workspace detail, ARES lookup, branding, numbering series, and connected apps", () => {
    const detail = callDemo("GET", `/api/v1/workspaces/${ws}`) as {
      slug: string;
      revision: number;
    };
    expect(detail.slug).toBe(DEMO_WORKSPACE.slug);

    const ares = callDemo("GET", "/api/v1/registry/companies/27082440");
    const decodedAres = Schema.decodeUnknownSync(RegistryResult)(ares);
    expect(decodedAres.ico).toBe("27082440");

    const branding = callDemo("GET", `/api/v1/workspaces/${ws}/branding`);
    const decodedBranding = Schema.decodeUnknownSync(BrandingView)(branding);
    expect(decodedBranding.pdfTemplate).toBe("classic");

    const series = callDemo("GET", `/api/v1/workspaces/${ws}/numbering-series`);
    const decodedSeries = Schema.decodeUnknownSync(Schema.Array(NumberingSeriesView))(series);
    expect(decodedSeries.length).toBeGreaterThanOrEqual(4);

    const apps = callDemo("GET", `/api/v1/workspaces/${ws}/connected-apps`);
    const decodedApps = Schema.decodeUnknownSync(Schema.Array(ConnectedAppView))(apps);
    expect(decodedApps.length).toBeGreaterThanOrEqual(1);
  });

  it("creates an API key with a valid one-time kvb_ token and serves account preferences", () => {
    const createdResp = callDemo("POST", `/api/v1/workspaces/${ws}/api-keys`, {
      name: "Test Key",
      access: "custom",
      scopes: ["documents:read", "documents:write"],
    }) as { status: number; body: unknown };
    expect(createdResp.status).toBe(201);
    const decoded = Schema.decodeUnknownSync(ApiKeyCreated)(createdResp.body);
    expect(decoded.secret.startsWith("kvb_")).toBe(true);
    expect(decoded.key.scopes).toContain("documents:write");

    const prefs = callDemo("GET", "/api/v1/me/preferences");
    const decodedPrefs = Schema.decodeUnknownSync(AccountPreferences)(prefs);
    expect(decodedPrefs.theme.style).toBe("elegant");
  });
});
