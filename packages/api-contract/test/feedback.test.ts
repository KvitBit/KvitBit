import { expect, test } from "bun:test";
import { redactFeedbackShareUrls } from "../src/index";

test("redacts absolute and root-relative document share URLs inside feedback", () => {
  expect(
    redactFeedbackShareUrls(
      'Open <https://kvitbit.test/i/v1.comment-secret?download=private#preview> or "/s/v1.relative-secret/pdf"',
    ),
  ).toBe('Open <[redacted]> or "[redacted]"');
  expect(redactFeedbackShareUrls("Download /api/v1/share/v1.api-secret/pdf")).toBe(
    "Download [redacted]",
  );
});

test("redacts share paths with encoded separators, nested escapes and dot segments", () => {
  for (const url of [
    "https://kvitbit.test/app/%69%2Fv1.share-secret",
    "https://kvitbit.test/x/%252e%252e/app/%2569%252Fv1.share-secret",
    "/app/%73/v1.share-secret%zz",
    "%2Fi%2Fv1.share-secret",
  ]) {
    expect(redactFeedbackShareUrls(`Open (${url})`)).toBe("Open ([redacted])");
  }
});

test("preserves ordinary links and page URL placeholders", () => {
  const text =
    "See https://kvitbit.test/w/alfa or /docs/i/example and https://kvitbit.test/[redacted]";
  expect(redactFeedbackShareUrls(text)).toBe(text);
});
