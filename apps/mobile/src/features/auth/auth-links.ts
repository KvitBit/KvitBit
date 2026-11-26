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
