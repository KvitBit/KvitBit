import { expect, test } from "bun:test";
import { nativeAuthPath, verifiedSignInHref } from "./auth-links";

const origin = "https://kvitbit.test";

test("native verification links keep the validated invitation after confirming email", () => {
  const outer = new URL("/api/auth/verify-email", origin);
  outer.searchParams.set("token", "verification-token");
  outer.searchParams.set("callbackURL", `/app${verifiedSignInHref("/invite/inv1")}`);
  expect(nativeAuthPath(outer.href, origin)).toBe(
    "/auth/verify/verification-token?returnTo=%2Finvite%2Finv1",
  );
});

test("native magic links preserve an app callback and discard external destinations", () => {
  const outer = new URL("/api/auth/magic-link/verify?token=magic-token", origin);
  outer.searchParams.set("callbackURL", "/app/w/acme/documents?tab=payments");
  expect(nativeAuthPath(outer.href, origin)).toBe(
    "/auth/magic/magic-token?returnTo=%2Fw%2Facme%2Fdocuments%3Ftab%3Dpayments",
  );
  outer.searchParams.set("callbackURL", "https://wrong.test/app/w/private");
  expect(nativeAuthPath(outer.href, origin)).toBe("/auth/magic/magic-token");
  expect(nativeAuthPath("https://wrong.test/api/auth/verify-email?token=untrusted", origin)).toBe(
    "https://wrong.test/api/auth/verify-email?token=untrusted",
  );
});
