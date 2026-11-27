/** Validates Expo Router destinations, including links captured with the /app base. */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { runMobileSync } from "../runtime/request-intent";

const queryOrHash = /[?#]/;
const parseAppUri = (value: string) =>
  Effect.try({
    try: () => decodeURIComponent(value),
    catch: () => "InvalidRouteEncoding" as const,
  }).pipe(
    Effect.orElseSucceed(() => null),
    runMobileSync,
  );

export const safeReturnTo = (raw: string | undefined): string | null => {
  if (raw === undefined || !Str.startsWith("/")(raw) || Str.startsWith("//")(raw)) {
    return null;
  }
  const url = Effect.try({
    try: () => new URL(raw, "https://app.invalid"),
    catch: () => "InvalidRouteUrl" as const,
  }).pipe(
    Effect.orElseSucceed(() => null),
    runMobileSync,
  );
  if (url === null || url.origin !== "https://app.invalid") return null;
  const path = parseAppUri(Str.split(raw, queryOrHash)[0]);
  if (path === null || Str.startsWith("//")(path) || Str.includes("\\")(path)) return null;
  if (
    Arr.some(Array.from(path), (char) => {
      const code = Option.getOrElse(Str.charCodeAt(char, 0), () => Number.NaN);
      return code < 32 || code === 127;
    })
  ) {
    return null;
  }
  if (Arr.some(Str.split(path, "/"), (segment) => segment === ".." || segment === ".")) return null;

  const pathname = Str.startsWith("/app/")(url.pathname)
    ? Str.slice("/app".length)(url.pathname)
    : url.pathname;
  const decoded = parseAppUri(pathname);
  if (decoded === null || Str.startsWith("//")(decoded)) return null;
  return `${pathname}${url.search}${url.hash}`;
};
