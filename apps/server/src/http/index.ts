/**
 * The HTTP edge (http-mcp-contracts section 1): `HttpRoutesLive` registers every route this
 * stream owns on the `effect/http` HttpRouter.
 */
import { Layer } from "effect";
import { AuthRoutesLive } from "../auth/routes";
import { AnalyticsProxyRoutesLive } from "./analyticsProxy";
import { ApiRoutesLive } from "./api";
import { CorsLive } from "./edge/cors";
import { RequestIdsLive } from "./edge/requestId";
import { FeedbackRoutesLive } from "./feedback/routes";
import { HealthRoutesLive } from "./health";
import { StaticRoutesLive } from "./static";

export { HttpConfig, HttpConfigLive, HttpConfigTest } from "./config";
export { RateLimiter, RateLimiterMemory, RateLimiterSql } from "./edge/RateLimiter";
export { HealthRoutesLive } from "./health";
export { StaticRoutesLive } from "./static";

export const HttpRoutesLive = Layer.mergeAll(
  RequestIdsLive,
  CorsLive,
  ApiRoutesLive,
  AuthRoutesLive,
  FeedbackRoutesLive,
  AnalyticsProxyRoutesLive,
  HealthRoutesLive,
  StaticRoutesLive,
);
