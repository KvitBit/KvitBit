import { Routes } from "@kvitbit/ui-port/view-models";
import { safeReturnTo } from "../../navigation/return-to";

export const inviteReturnTo = (token: string | undefined): string | null =>
  token === undefined ? null : Routes.toPath({ _tag: "Invitation", token }, "/");

export const verifiedSignInHref = (destination: string | null): string => {
  const query = new URLSearchParams({ verified: "1" });
  const returnTo = safeReturnTo(destination ?? undefined);
  if (returnTo !== null) query.set("returnTo", returnTo);
  return `/sign-in?${query}`;
};

export const checkEmailHref = (email: string, destination: string | null): string => {
  const query = new URLSearchParams({ email });
  const returnTo = safeReturnTo(destination ?? undefined);
  if (returnTo !== null) query.set("returnTo", returnTo);
  return `/check-email?${query}`;
};

/** Routes an email link from the configured server through the app's bearer-aware client. */
export const nativeAuthPath = (path: string, origin: string): string => {
  try {
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
    if (!token) return "/sign-in";
    const link = Routes.toPath({ _tag: "AuthLink", kind, token }, "/");
    const callback = new URL(url.searchParams.get("callbackURL") ?? "/", origin);
    if (callback.origin !== origin) return link;
    const destination =
      callback.pathname === "/app/sign-in" && callback.searchParams.get("verified") === "1"
        ? callback.searchParams.get("returnTo")
        : `${callback.pathname}${callback.search}${callback.hash}`;
    const returnTo = safeReturnTo(destination ?? undefined);
    return returnTo === null ? link : `${link}?${new URLSearchParams({ returnTo })}`;
  } catch {
    return "/sign-in";
  }
};
