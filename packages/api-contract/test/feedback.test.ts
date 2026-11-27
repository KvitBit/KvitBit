import { expect, test } from "bun:test";
import { redactFeedbackUrls } from "../src/index";

test("redacts absolute and root-relative document share URLs inside feedback", () => {
  expect(
    redactFeedbackUrls(
      'Open <https://kvitbit.test/i/v1.comment-secret?download=private#preview> or "/s/v1.relative-secret/pdf"',
    ),
  ).toBe('Open <[redacted]> or "[redacted]"');
  expect(redactFeedbackUrls("Download /api/v1/share/v1.api-secret/pdf")).toBe(
    "Download [redacted]",
  );
});

test("redacts share paths with encoded separators, nested escapes and dot segments", () => {
  const share = "https://kvitbit.test/i/v1.share-secret?copy=private";
  for (const url of [
    "https://kvitbit.test/app/%69%2Fv1.share-secret",
    "https://kvitbit.test/x/%252e%252e/app/%2569%252Fv1.share-secret",
    "/app/%73/v1.share-secret%zz",
    "%2Fi%2Fv1.share-secret",
    encodeURIComponent(share),
    encodeURIComponent(encodeURIComponent(share)),
    "https:%2F%2Fkvitbit.test/i/v1.share-secret",
  ]) {
    expect(redactFeedbackUrls(`Open (${url})`)).toBe("Open ([redacted])");
  }
});

test("redacts embedded invite, password reset and authentication URLs", () => {
  for (const url of [
    "https://kvitbit.test/invite/private-invite",
    "http://[::1]/reset-password?token=private-reset",
    "/api/auth/magic-link/verify?token=private-magic",
    "/app/%61pi/auth/callback/provider?code=private-code",
  ]) {
    expect(redactFeedbackUrls(`Open (${url})`)).toBe("Open ([redacted])");
  }
});

test("preserves ordinary links and page URL placeholders", () => {
  const workspace = "https://kvitbit.test/w/alfa";
  const text = `See ${workspace}, ${encodeURIComponent(workspace)}, /docs/i/example and https://kvitbit.test/[redacted]`;
  expect(redactFeedbackUrls(text)).toBe(text);
});
