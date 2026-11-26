/**
 * The HTTP edge (http-mcp-contracts section 1): `HttpRoutesLive` registers every route this
 * stream owns on the `effect/http` HttpRouter.
 */
import { Layer } from "effect";
import { AuthRoutesLive } from "../auth/routes";
import { ApiRoutesLive } from "./api";
import { RequestIdsLive } from "./edge/requestId";
import { HealthRoutesLive } from "./health";
import { StaticRoutesLive } from "./static";

export { HttpConfig, HttpConfigLive, HttpConfigTest } from "./config";
export { RateLimiter, RateLimiterMemory, RateLimiterSql } from "./edge/RateLimiter";
export { HealthRoutesLive } from "./health";
export { StaticRoutesLive } from "./static";

export const HttpRoutesLive = Layer.mergeAll(
  RequestIdsLive,
  ApiRoutesLive,
  AuthRoutesLive,
  HealthRoutesLive,
  StaticRoutesLive,
);
