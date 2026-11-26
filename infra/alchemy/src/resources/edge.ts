import * as Compute from "@alchemy.run/gcp/Compute";
import * as Logging from "@alchemy.run/gcp/Logging";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import type { KvitbitEdgeConfig, KvitbitStackConfig } from "../config";
import { EdgeBackendService } from "./edge-backend-service";
import { EdgeSecurityPolicy, type EdgeSecurityPolicyProps } from "./edge-security-policy";

/**
 * Immutable build-asset paths served by the static backend (with optional Cloud CDN).
 * Matches #873 (Expo PWA /app/_expo/static/*) and #877 (Vite web /assets/*, /fonts/*).
 */
export const edgeStaticAssetPaths = ["/assets/*", "/fonts/*", "/app/_expo/static/*"] as const;

export const edgeResourceName = (config: KvitbitStackConfig, suffix: string) =>
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

export const tokenRouteExclusionFilter = [
  requestLogSources,
  `httpRequest.requestUrl=~"^https?://[^/]+(${tokenRoutePatterns.join("|")})([/?#].*|$)"`,
].join(" AND ");

export const edgeSecurityPolicyProps = (
  config: KvitbitStackConfig,
  edge: KvitbitEdgeConfig,
): EdgeSecurityPolicyProps => ({
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
          expression: "evaluatePreconfiguredWaf('sqli-v33-stable', {'sensitivity': 1})",
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
          expression: "evaluatePreconfiguredWaf('xss-v33-stable', {'sensitivity': 1})",
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

export const edgeDynamicBackendProps = (config: KvitbitStackConfig, links: EdgeBackendLinks) => ({
  project: config.projectId,
  name: edgeObjectNames(config).dynamicBackend,
  loadBalancingScheme: "EXTERNAL_MANAGED" as const,
  protocol: "HTTPS" as const,
  ...links,
  logConfig: { enable: false },
});

export const edgeStaticBackendProps = (
  config: KvitbitStackConfig,
  edge: KvitbitEdgeConfig,
  links: EdgeBackendLinks,
) => {
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

export const edgeUrlMapProps = (
  config: KvitbitStackConfig,
  edge: KvitbitEdgeConfig,
  backends: { readonly dynamic: Input<string>; readonly static: Input<string> },
) => ({
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

export const edgeHttpsRedirectUrlMapProps = (config: KvitbitStackConfig): Compute.UrlMapProps => ({
  urlMapName: edgeResourceName(config, "https-redirect"),
  defaultUrlRedirect: {
    httpsRedirect: true,
    redirectResponseCode: "MOVED_PERMANENTLY_DEFAULT",
    stripQuery: false,
  },
});

const declaredLink = (resource: string) =>
  Output.map((link: string | undefined) => {
    if (link === undefined) {
      throw new Error(`${resource} reported no self link`);
    }
    return link;
  });

export const declareTokenRouteLogExclusion = Effect.fn(
  "KvitbitStack.declareTokenRouteLogExclusion",
)(function* (config: KvitbitStackConfig) {
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

  const policy = yield* EdgeSecurityPolicy(
    "EdgeSecurityPolicy",
    edgeSecurityPolicyProps(config, edge),
  );

  const links: EdgeBackendLinks = {
    backendGroup: endpointGroup.selfLink.pipe(declaredLink("EdgeServerEndpointGroup")),
    securityPolicy: policy.selfLink,
  };

  const dynamicBackend = yield* EdgeBackendService(
    "EdgeDynamicBackend",
    edgeDynamicBackendProps(config, links),
  );
  const staticBackend = yield* EdgeBackendService(
    "EdgeStaticBackend",
    edgeStaticBackendProps(config, edge, links),
  );

  const urlMap = yield* Compute.UrlMap(
    "EdgeUrlMap",
    edgeUrlMapProps(config, edge, {
      dynamic: dynamicBackend.selfLink,
      static: staticBackend.selfLink,
    }),
  );
  const urlMapLink = urlMap.selfLink.pipe(declaredLink("EdgeUrlMap"));

  let httpTarget: Input<string>;
  if (edge.enableHttps) {
    const certificate = yield* Compute.SslCertificate("EdgeCertificate", {
      sslCertificateName: edgeResourceName(config, "edge-cert"),
      type: "MANAGED",
      managed: { domains: [...edge.domains] },
    });
    const httpsProxy = yield* Compute.TargetHttpsProxy("EdgeHttpsProxy", {
      targetHttpsProxyName: edgeResourceName(config, "edge-https"),
      urlMap: urlMapLink,
      sslCertificates: [certificate.selfLink.pipe(declaredLink("EdgeCertificate"))],
    });
    yield* Compute.GlobalForwardingRule("EdgeHttpsForwardingRule", {
      forwardingRuleName: names.httpsForwardingRule,
      loadBalancingScheme: "EXTERNAL_MANAGED" as const,
      ipAddress: addressLink,
      portRange: "443",
      target: httpsProxy.selfLink.pipe(declaredLink("EdgeHttpsProxy")),
    });
    const redirectMap = yield* Compute.UrlMap(
      "EdgeHttpsRedirectUrlMap",
      edgeHttpsRedirectUrlMapProps(config),
    );
    const redirectProxy = yield* Compute.TargetHttpProxy("EdgeHttpsRedirectProxy", {
      targetHttpProxyName: edgeResourceName(config, "https-redirect"),
      urlMap: redirectMap.selfLink.pipe(declaredLink("EdgeHttpsRedirectUrlMap")),
    });
    httpTarget = redirectProxy.selfLink.pipe(declaredLink("EdgeHttpsRedirectProxy"));
  } else {
    const httpProxy = yield* Compute.TargetHttpProxy("EdgeHttpProxy", {
      targetHttpProxyName: names.httpProxy,
      urlMap: urlMapLink,
    });
    httpTarget = httpProxy.selfLink.pipe(declaredLink("EdgeHttpProxy"));
  }

  yield* Compute.GlobalForwardingRule("EdgeHttpForwardingRule", {
    forwardingRuleName: names.httpForwardingRule,
    loadBalancingScheme: "EXTERNAL_MANAGED" as const,
    ipAddress: addressLink,
    portRange: "80",
    target: httpTarget,
  });

  return {
    edgeIpAddress: address.address,
    edgeProtocol: edge.enableHttps ? ("https" as const) : ("http" as const),
    securityPolicy: policy.selfLink,
    backendServices: [dynamicBackend.selfLink, staticBackend.selfLink] as const,
  };
});
