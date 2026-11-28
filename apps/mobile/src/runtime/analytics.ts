import type { PostHogConfig, Properties } from "posthog-js/dist/module.slim.no-external.js";
import { ROUTE_BASE } from "../config/env";

interface AnalyticsConfig {
  readonly posthog?: { readonly apiKey: string; readonly host: string } | null;
}

interface PageviewSdk {
  init(apiKey: string, options: Partial<PostHogConfig>): unknown;
  capture(event: "$pageview", properties: Properties): unknown;
}

const MAX_PENDING_PAGEVIEWS = 32;

const pathOnly = (path: string): string => path.split(/[?#]/, 1)[0] ?? "";

const ROUTE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/(i|s|share|invite|invitations)\/[^/]+$/, "/$1/[token]"],
  [/^\/auth\/(verify|magic|reset)\/[^/]+$/, "/auth/$1/[token]"],
  [/^\/auth\/[^/]+\/[^/]+$/, "/auth/[kind]/[token]"],
  [/^\/(reset-password|magic-link)\/[^/]+$/, "/$1/[token]"],
  [/^\/consent\/[^/]+$/, "/consent/[id]"],
  [/^\/w\/[^/]+$/, "/w/[id]"],
  [
    /^\/w\/[^/]+\/(documents|templates|expenses|contacts|price-list|reports|settings|more)$/,
    "/w/[id]/$1",
  ],
  [/^\/w\/[^/]+\/documents\/new\/[^/]+$/, "/w/[id]/documents/new/[kind]"],
  [/^\/w\/[^/]+\/documents\/[^/]+\/edit$/, "/w/[id]/documents/[id]/edit"],
  [/^\/w\/[^/]+\/expenses\/capture$/, "/w/[id]/expenses/capture"],
  [/^\/w\/[^/]+\/(documents|templates|expenses|contacts)\/[^/]+$/, "/w/[id]/$1/[id]"],
  [/^\/w\/[^/]+\/reports\/[^/]+$/, "/w/[id]/reports/[report]"],
  [/^\/w\/[^/]+\/settings\/[^/]+$/, "/w/[id]/settings/[section]"],
  [/^\/account\/[^/]+$/, "/account/[tab]"],
  [/^\/error\/[^/]+$/, "/error/[kind]"],
];

const PUBLIC_PATHS = new Set([
  "/",
  "/sign-in",
  "/sign-up",
  "/check-email",
  "/reset-password",
  "/onboarding",
  "/passkey-setup",
]);

export const analyticsPathname = (path: string): string => {
  const input = pathOnly(path);
  const base = ROUTE_BASE.slice(0, -1);
  const local = input === base ? "/" : input.startsWith(ROUTE_BASE) ? input.slice(base.length) : "";
  const pathname = local === "/" ? local : local.replace(/\/$/, "");
  if (PUBLIC_PATHS.has(pathname)) return base + pathname;
  for (const [pattern, template] of ROUTE_PATTERNS) {
    if (pattern.test(pathname)) return base + pathname.replace(pattern, template);
  }
  return `${base}/[id]`;
};

const resolveApiHost = (host: string, origin: string): string =>
  host.startsWith("/") && !host.startsWith("//")
    ? new URL(host, origin).toString().replace(/\/+$/, "")
    : host;

export const createPageviewTracker = (
  origin: string,
  loadConfig: () => Promise<AnalyticsConfig | undefined>,
  loadSdk: () => Promise<PageviewSdk> = async () =>
    (await import("posthog-js/dist/module.slim.no-external.js")).default,
): ((path: string) => void) => {
  const pageview = (pathname: string): Properties => ({
    $current_url: origin + pathname,
    $pathname: pathname,
  });

  let sdk: PageviewSdk | null | undefined;
  let lastPath: string | undefined;
  const pending: string[] = [];

  const capture = (client: PageviewSdk, path: string) => {
    try {
      client.capture("$pageview", pageview(path));
    } catch {
      // Analytics must never interfere with navigation.
    }
  };

  const initialize = async (): Promise<PageviewSdk | null> => {
    try {
      const config = (await loadConfig())?.posthog;
      if (!config) return null;

      const client = await loadSdk();
      // The SDK adds properties such as the document title, referrer, and previous path.
      // Keep only the pageview and the fields required for cookieless ingestion.
      const sanitize = (properties: Properties): Properties => ({
        ...pageview(
          analyticsPathname(typeof properties.$pathname === "string" ? properties.$pathname : ""),
        ),
        token: config.apiKey,
        distinct_id: "$posthog_cookieless",
        $cookieless_mode: true,
        $process_person_profile: false,
        $geoip_disable: true,
      });
      client.init(config.apiKey, {
        api_host: resolveApiHost(config.host, origin),
        api_transport: "fetch",
        cookieless_mode: "always",
        persistence: "memory",
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        disable_session_recording: true,
        disable_surveys: true,
        person_profiles: "never",
        advanced_disable_flags: true,
        disable_external_dependency_loading: true,
        disable_beacon: true,
        disableDeviceModel: true,
        save_referrer: false,
        save_campaign_params: false,
        sanitize_properties: sanitize,
        before_send: (event) =>
          event?.event === "$pageview"
            ? {
                event: event.event,
                uuid: event.uuid,
                ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }),
                properties: sanitize(event.properties),
              }
            : null,
      });
      return client;
    } catch {
      return null;
    }
  };

  return (path) => {
    const pathname = pathOnly(path);
    if (pathname === lastPath || sdk === null) return;
    lastPath = pathname;
    const safePath = analyticsPathname(pathname);
    if (sdk !== undefined) {
      capture(sdk, safePath);
      return;
    }

    if (pending.length === 0) {
      void initialize().then((client) => {
        sdk = client;
        for (const queued of pending.splice(0)) {
          if (client !== null) capture(client, queued);
        }
      });
    }
    if (pending.length < MAX_PENDING_PAGEVIEWS) pending.push(safePath);
  };
};
