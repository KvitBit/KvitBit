import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import type { PostHogConfig, Properties } from "posthog-js/dist/module.slim.no-external.js";

const pathOnlyPattern = /[?#]/;
const pathnamePattern = /\/$/;
const resolveApiHostPattern = /\/+$/;

interface AnalyticsConfig {
  readonly posthog?: { readonly apiKey: string; readonly host: string } | null;
}

interface PageviewSdk {
  init(apiKey: string, options: Partial<PostHogConfig>): unknown;
  capture(event: "$pageview", properties: Properties): unknown;
}

const MAX_PENDING_PAGEVIEWS = 32;

const pathOnly = (path: string): string => Str.split(pathOnlyPattern)(path)[0];

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
  "/legal/terms",
  "/legal/privacy",
  "/android",
  "/sign-in",
  "/sign-up",
  "/check-email",
  "/reset-password",
  "/oauth/consent",
  "/onboarding",
]);

const analyticsPathname = (path: string): string => {
  const pathname =
    Str.replace(pathnamePattern, "")(pathOnly(path)) || (Str.startsWith("/")(path) ? "/" : "");
  if (PUBLIC_PATHS.has(pathname)) return pathname;
  for (const [pattern, template] of ROUTE_PATTERNS) {
    if (pattern.test(pathname)) return Str.replace(pattern, template)(pathname);
  }
  return "/[id]";
};

const resolveApiHost = ({
  host,
  origin,
}: {
  readonly host: string;
  readonly origin: string;
}): string =>
  Str.startsWith("/")(host) && !Str.startsWith("//")(host)
    ? Str.replace(resolveApiHostPattern, "")(new URL(host, origin).toString())
    : host;

const pathnameValue = Schema.is(Schema.String);

export const createPageviewTracker = ({
  origin,
  loadConfig,
  loadSdk = Effect.tryPromise({
    try: () => import("posthog-js/dist/module.slim.no-external.js"),
    catch: () => "AnalyticsImportFailed" as const,
  }).pipe(Effect.map((module) => module.default)),
}: {
  readonly origin: string;
  readonly loadConfig: Effect.Effect<AnalyticsConfig | undefined>;
  readonly loadSdk?: Effect.Effect<PageviewSdk, "AnalyticsImportFailed">;
}) => {
  const pageview = (pathname: string): Properties => ({
    $current_url: origin + pathname,
    $pathname: pathname,
  });

  let sdk: PageviewSdk | null | undefined;
  let lastPath: string | undefined;
  const pending: string[] = [];

  const capture = (client: PageviewSdk, path: string) =>
    Effect.try({
      try: () => client.capture("$pageview", pageview(path)),
      catch: () => "AnalyticsCaptureFailed" as const,
    }).pipe(Effect.ignore);

  const initialize = Effect.gen(function* () {
    const config = (yield* loadConfig)?.posthog;
    if (config === undefined || config === null) return null;

    const client = yield* loadSdk;
    // The SDK adds properties such as the document title, referrer, and previous path.
    // Keep only the pageview and the fields required for cookieless ingestion.
    const sanitize = (properties: Properties): Properties => ({
      ...pageview(
        analyticsPathname(pathnameValue(properties["$pathname"]) ? properties["$pathname"] : ""),
      ),
      token: config.apiKey,
      distinct_id: "$posthog_cookieless",
      $cookieless_mode: true,
      $process_person_profile: false,
      $geoip_disable: true,
    });
    yield* Effect.try({
      try: () =>
        client.init(config.apiKey, {
          api_host: resolveApiHost({ host: config.host, origin }),
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
          before_send: (event) => {
            if (event?.event !== "$pageview") return null;
            const { uuid, timestamp } = event;
            const sanitizedEvent = {
              event: event.event,
              uuid,
              properties: sanitize(event.properties),
            };
            return timestamp === undefined ? sanitizedEvent : { ...sanitizedEvent, timestamp };
          },
        }),
      catch: () => "AnalyticsInitializationFailed" as const,
    });
    return client;
  }).pipe(Effect.orElseSucceed(() => null));

  return Effect.fnUntraced(function* (path: string) {
    const pathname = pathOnly(path);
    if (pathname === lastPath || sdk === null) return;
    lastPath = pathname;
    const safePath = analyticsPathname(pathname);
    if (sdk !== undefined) {
      yield* capture(sdk, safePath);
      return;
    }

    const start = pending.length === 0;
    if (pending.length < MAX_PENDING_PAGEVIEWS) pending.push(safePath);
    if (start) {
      yield* Effect.gen(function* () {
        const client = yield* initialize;
        sdk = client;
        const queued = pending.splice(0);
        if (client !== null) {
          yield* Effect.forEach(queued, (pendingPath) => capture(client, pendingPath), {
            discard: true,
            concurrency: 1,
          });
        }
      }).pipe(Effect.forkDetach);
    }
  });
};
