import { Routes } from "@kvitbit/ui-port/view-models";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import { safeReturnTo } from "../../navigation/return-to";
import { runFeatureSync } from "../ui-effect";

export const inviteReturnTo = (token: string | undefined): string | null =>
  token === undefined ? null : Routes.toPath({ _tag: "Invitation", token }, "/");

export const verifiedSignInHref = (destination: string | null): string => {
  const query = new URLSearchParams({ verified: "1" });
  const returnTo = safeReturnTo(destination ?? undefined);
  if (returnTo !== null) query.set("returnTo", returnTo);
  return `/sign-in?${query}`;
};

export const checkEmailHref: {
  (destination: string | null): (email: string) => string;
  (email: string, destination: string | null): string;
} = Fn.dual(2, (email: string, destination: string | null): string => {
  const query = new URLSearchParams({ email });
  const returnTo = safeReturnTo(destination ?? undefined);
  if (returnTo !== null) query.set("returnTo", returnTo);
  return `/check-email?${query}`;
});

/** Routes an email link from the configured server through the app's bearer-aware client. */
export const nativeAuthPath: {
  (origin: string): (path: string) => string;
  (path: string, origin: string): string;
} = Fn.dual(2, (path: string, origin: string): string =>
  runFeatureSync(
    Effect.try({
      try: () => {
        const url = new URL(path, origin);
        if (url.origin !== origin) return path;
        const kind =
          url.pathname === "/api/auth/verify-email"
            ? "verify"
            : url.pathname === "/api/auth/magic-link/verify"
              ? "magic"
              : null;
        if (kind === null) return path;
        const token = url.searchParams.get("token");
        if (token === null || token === "") return "/sign-in";
        const link = Routes.toPath({ _tag: "AuthLink", kind, token }, "/");
        const callback = new URL(url.searchParams.get("callbackURL") ?? "/", origin);
        if (callback.origin !== origin) return link;
        const destination =
          callback.pathname === "/app/sign-in" && callback.searchParams.get("verified") === "1"
            ? callback.searchParams.get("returnTo")
            : `${callback.pathname}${callback.search}${callback.hash}`;
        const returnTo = safeReturnTo(destination ?? undefined);
        return returnTo === null ? link : `${link}?${new URLSearchParams({ returnTo })}`;
      },
      catch: () => "/sign-in",
    }).pipe(Effect.catch(Effect.succeed)),
  ),
);

export type ErrorKind = "not_found" | "no_access" | "server" | "offline";

export const parseErrorKind = (raw: string | undefined): ErrorKind =>
  raw === "not_found" || raw === "no_access" || raw === "server" || raw === "offline"
    ? raw
    : "not_found";
