import * as Compute from "@alchemy.run/gcp/Compute";
import * as Logging from "@alchemy.run/gcp/Logging";
import type { Input } from "alchemy/Input";
import type * as Output from "alchemy/Output";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type { KvitbitEdgeConfig, KvitbitStackConfig } from "../config";
import { declareEdgeBackendService } from "./edge-backend-service";
import { declareEdgeSecurityPolicy, type EdgeSecurityPolicyProps } from "./edge-security-policy";
import { declaredLink } from "./provider-inputs";

/**
 * Immutable build-asset paths served by the static backend (with optional Cloud CDN).
 * Matches #873 (Expo PWA /app/_expo/static/*) and #877 (Vite web /assets/*, /fonts/*).
 */
export const edgeStaticAssetPaths = ["/assets/*", "/fonts/*", "/app/_expo/static/*"] as const;

const edgeResourceName = (config: KvitbitStackConfig, suffix: string) =>
  `kvitbit-${config.stage}-${suffix}`;

export const edgeObjectNames = (config: KvitbitStackConfig) => ({
  address: edgeResourceName(config, "edge"),
  endpointGroup: edgeResourceName(config, "server-neg"),
  securityPolicy: edgeResourceName(config, "edge-armor"),
  dynamicBackend: edgeResourceName(config, "dynamic"),
  staticBackend: edgeResourceName(config, "static"),
  urlMap: edgeResourceName(config, "edge"),
  httpProxy: edgeResourceName(config, "edge-http"),
  httpForwardingRule: edgeResourceName(config, "http"),
  httpsForwardingRule: edgeResourceName(config, "https"),
  tokenRouteExclusion: edgeResourceName(config, "token-route-requests"),
});

/**
 * Routes whose URLs carry bearer/share/invitation/magic-link tokens.
 * Raw request logs for these routes are excluded from Cloud Logging _Default sink.
 */
export const tokenRoutePatterns = [
  "/i/[^/?#]+",
  "/invite/[^/?#]+",
  "/api/v1/share/[^/?#]+",
  "/api/v1/invitations/[^/?#]+",
  "/api/auth/magic-link/verify",
  "/api/auth/reset-password/[^/?#]+",
  "/app/auth/callback",
] as const;

const requestLogSources =
  '(resource.type="http_load_balancer" OR (resource.type="cloud_run_revision" AND log_id("run.googleapis.com/requests")))';

export const tokenRouteExclusionFilter = Arr.join(
  [
    requestLogSources,
    `httpRequest.requestUrl=~"^https?://[^/]+(${Arr.join(tokenRoutePatterns, "|")})([/?#].*|$)"`,
  ],
  " AND ",
);

const evaluateWaf = (ruleSet: string) =>
  `evaluatePreconfiguredWaf('${ruleSet}', {'sensitivity': 1})`;

export const edgeSecurityPolicyProps = ({
  config,
  edge,
}: {
  readonly config: KvitbitStackConfig;
  readonly edge: KvitbitEdgeConfig;
}): EdgeSecurityPolicyProps => ({
  project: config.projectId,
  name: edgeObjectNames(config).securityPolicy,
  description: `Kvitbit ${config.stage} Cloud Armor edge policy`,
  type: "CLOUD_ARMOR",
  rules: [
    {
      action: "deny(403)",
      priority: 1000,
      preview: edge.wafPreview,
      description: "Preconfigured SQL injection rules",
      match: {
        expr: {
          expression: evaluateWaf("sqli-v33-stable"),
        },
      },
    },
    {
      action: "deny(403)",
      priority: 1010,
      preview: edge.wafPreview,
      description: "Preconfigured cross-site scripting rules",
      match: {
        expr: {
          expression: evaluateWaf("xss-v33-stable"),
        },
      },
    },
    {
      action: "throttle",
      priority: 2000,
      description: "Throttle auth endpoints per client IP",
      preview: false,
      match: { expr: { expression: "request.path.startsWith('/api/auth/')" } },
      rateLimitOptions: {
        conformAction: "allow",
        exceedAction: "deny(429)",
        enforceOnKey: "IP",
        rateLimitThreshold: {
          count: edge.authRateLimitPerMinute,
          intervalSec: 60,
        },
      },
    },
    {
      action: "allow",
      priority: 2147483647,
      description: "Default allow",
      preview: false,
      match: { versionedExpr: "SRC_IPS_V1", config: { srcIpRanges: ["*"] } },
    },
  ],
});

export interface EdgeBackendLinks {
  readonly backendGroup: Input<string>;
  readonly securityPolicy: Input<string>;
}

export const edgeDynamicBackendProps = ({
  config,
  links,
}: {
  readonly config: KvitbitStackConfig;
  readonly links: EdgeBackendLinks;
}) => ({
  project: config.projectId,
  name: edgeObjectNames(config).dynamicBackend,
  loadBalancingScheme: "EXTERNAL_MANAGED" as const,
  protocol: "HTTPS" as const,
  ...links,
  logConfig: { enable: false },
});

export const edgeStaticBackendProps = ({
  config,
  edge,
  links,
}: {
  readonly config: KvitbitStackConfig;
  readonly edge: KvitbitEdgeConfig;
  readonly links: EdgeBackendLinks;
}) => {
  const props = {
    project: config.projectId,
    name: edgeObjectNames(config).staticBackend,
    loadBalancingScheme: "EXTERNAL_MANAGED" as const,
    protocol: "HTTPS" as const,
    ...links,
    logConfig: { enable: true, sampleRate: 1 },
  };
  return edge.staticCdnEnabled
    ? {
        ...props,
        cdnPolicy: {
          cacheMode: "USE_ORIGIN_HEADERS" as const,
          negativeCaching: false,
          cacheKeyPolicy: {
            includeHost: true,
            includeProtocol: true,
            includeQueryString: false,
          },
        },
      }
    : props;
};

export const edgeUrlMapProps = ({
  config,
  edge,
  backends,
}: {
  readonly config: KvitbitStackConfig;
  readonly edge: KvitbitEdgeConfig;
  readonly backends: { readonly dynamic: Input<string>; readonly static: Input<string> };
}) => ({
  urlMapName: edgeObjectNames(config).urlMap,
  defaultService: backends.dynamic,
  hostRules: [
    {
      hosts: edge.domains.length > 0 ? [...edge.domains] : ["*"],
      pathMatcher: "kvitbit",
    },
  ],
  pathMatchers: [
    {
      name: "kvitbit",
      defaultService: backends.dynamic,
      pathRules: [{ paths: [...edgeStaticAssetPaths], service: backends.static }],
    },
  ],
});

const edgeHttpsRedirectUrlMapProps = (config: KvitbitStackConfig): Compute.UrlMapProps => ({
  urlMapName: edgeResourceName(config, "https-redirect"),
  defaultUrlRedirect: {
    httpsRedirect: true,
    redirectResponseCode: "MOVED_PERMANENTLY_DEFAULT",
    stripQuery: false,
  },
});

export const declareTokenRouteLogExclusion = Effect.fn("KvitbitStack.excludeTokenLogs")(function* (
  config: KvitbitStackConfig,
) {
  const names = edgeObjectNames(config);
  const exclusion = yield* Logging.Exclusion("EdgeTokenRouteExclusion", {
    exclusionId: names.tokenRouteExclusion,
    description: "Drop raw request logs for token-bearing Kvitbit routes",
    filter: tokenRouteExclusionFilter,
  });
  return exclusion.name;
});

/**
 * Pure-Alchemy External Application Load Balancer in front of Kvitbit Cloud Run:
 * GlobalAddress + Serverless NEG + Cloud Armor EdgeSecurityPolicy + Dynamic/Static
 * EdgeBackendService (with optional Cloud CDN) + Managed SSL Certificate (kvitbit.cz /
 * kvitbit.app) + HTTPS redirect.
 */
// These logical IDs key existing resources in Alchemy state.
const edgeProtocolId = (protocol: "Http" | "Https", component: string) =>
  `Edge${protocol}${component}`;

export const declareKvitbitEdge = Effect.fn("KvitbitStack.declareKvitbitEdge")(function* (
  config: KvitbitStackConfig,
  edge: KvitbitEdgeConfig,
  serverServiceId: Input<string>,
) {
  const names = edgeObjectNames(config);
  const address = yield* Compute.GlobalAddress("EdgeAddress", {
    addressName: names.address,
  });
  const addressLink = address.selfLink.pipe(declaredLink("EdgeAddress"));

  const endpointGroup = yield* Compute.RegionNetworkEndpointGroup("EdgeServerEndpointGroup", {
    networkEndpointGroupName: names.endpointGroup,
    region: config.region,
    networkEndpointType: "SERVERLESS",
    cloudRun: { service: serverServiceId },
  });

  const policy = yield* declareEdgeSecurityPolicy("EdgeSecurityPolicy")(
    edgeSecurityPolicyProps({ config, edge }),
  );

  const links: EdgeBackendLinks = {
    backendGroup: endpointGroup.selfLink.pipe(declaredLink("EdgeServerEndpointGroup")),
    securityPolicy: policy.selfLink,
  };

  const dynamicBackend = yield* declareEdgeBackendService("EdgeDynamicBackend")(
    edgeDynamicBackendProps({ config, links }),
  );
  const staticBackend = yield* declareEdgeBackendService("EdgeStaticBackend")(
    edgeStaticBackendProps({ config, edge, links }),
  );

  const urlMap = yield* Compute.UrlMap(
    "EdgeUrlMap",
    edgeUrlMapProps({
      config,
      edge,
      backends: {
        dynamic: dynamicBackend.selfLink,
        static: staticBackend.selfLink,
      },
    }),
  );
  const urlMapLink = urlMap.selfLink.pipe(declaredLink("EdgeUrlMap"));

  let httpTarget: Input<string>;
  let httpsForwardingRule: Output.Output<string | undefined> | undefined;
  if (edge.enableHttps) {
    const certificate = yield* Compute.SslCertificate("EdgeCertificate", {
      sslCertificateName: edgeResourceName(config, "edge-cert"),
      type: "MANAGED",
      managed: { domains: [...edge.domains] },
    });
    const httpsProxy = yield* Compute.TargetHttpsProxy(edgeProtocolId("Https", "Proxy"), {
      targetHttpsProxyName: edgeResourceName(config, "edge-https"),
      urlMap: urlMapLink,
      sslCertificates: [certificate.selfLink.pipe(declaredLink("EdgeCertificate"))],
    });
    const https = yield* Compute.GlobalForwardingRule(edgeProtocolId("Https", "ForwardingRule"), {
      forwardingRuleName: names.httpsForwardingRule,
      loadBalancingScheme: "EXTERNAL_MANAGED" as const,
      ipAddress: addressLink,
      portRange: "443",
      target: httpsProxy.selfLink.pipe(declaredLink(edgeProtocolId("Https", "Proxy"))),
    });
    httpsForwardingRule = https.selfLink;
    const redirectMap = yield* Compute.UrlMap(
      edgeProtocolId("Https", "RedirectUrlMap"),
      edgeHttpsRedirectUrlMapProps(config),
    );
    const redirectProxy = yield* Compute.TargetHttpProxy("EdgeHttpsRedirectProxy", {
      targetHttpProxyName: edgeResourceName(config, "https-redirect"),
      urlMap: redirectMap.selfLink.pipe(declaredLink(edgeProtocolId("Https", "RedirectUrlMap"))),
    });
    httpTarget = redirectProxy.selfLink.pipe(declaredLink("EdgeHttpsRedirectProxy"));
  } else {
    const httpProxy = yield* Compute.TargetHttpProxy(edgeProtocolId("Http", "Proxy"), {
      targetHttpProxyName: names.httpProxy,
      urlMap: urlMapLink,
    });
    httpTarget = httpProxy.selfLink.pipe(declaredLink(edgeProtocolId("Http", "Proxy")));
  }

  yield* Compute.GlobalForwardingRule(edgeProtocolId("Http", "ForwardingRule"), {
    forwardingRuleName: names.httpForwardingRule,
    loadBalancingScheme: "EXTERNAL_MANAGED" as const,
    ipAddress: addressLink,
    portRange: "80",
    target: httpTarget,
  });

  return {
    edgeIpAddress: address.address,
    httpsForwardingRule,
    edgeProtocol: edge.enableHttps ? ("https" as const) : ("http" as const),
    securityPolicy: policy.selfLink,
    backendServices: [dynamicBackend.selfLink, staticBackend.selfLink] as const,
  };
});
