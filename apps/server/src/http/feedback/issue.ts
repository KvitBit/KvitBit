import {
  type FeedbackIssue,
  type FeedbackSubmission,
  redactFeedbackApiKeys,
  redactFeedbackUrls,
} from "@kvitbit/api-contract";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { FeedbackConfig } from "./access";

const plainText = (value: string) =>
  redactFeedbackApiKeys(
    redactFeedbackUrls(
      value
        .replaceAll(/\r\n?/g, "\n")
        .replaceAll(/[\p{Cc}\p{Cf}]/gu, (char) => (char === "\n" || char === "\t" ? char : "")),
    ),
  );

const fenceLength = (value: string, runs: RegExp) =>
  Array.from(value.matchAll(runs), ([run]) => run.length + 1).reduce(
    (longest, length) => Math.max(longest, length),
    3,
  );

const codeBlock = (value: string) => {
  const backticks = fenceLength(value, /`+/g);
  const tildes = fenceLength(value, /~+/g);
  const fence = backticks <= tildes ? "`".repeat(backticks) : "~".repeat(tildes);
  return `${fence}text\n${value}\n${fence}`;
};

const structuralSelector =
  /^(?:[a-z][a-z\d-]*(?::nth-of-type\([1-9]\d*\))?)(?: > [a-z][a-z\d-]*(?::nth-of-type\([1-9]\d*\))?)*$/;

const field = (label: string, value: string) => `${label}: ${JSON.stringify(plainText(value))}`;

const issueContent = (
  submission: FeedbackSubmission,
  page: { readonly url: string; readonly sensitive: boolean },
) => {
  const comment = plainText(submission.comment);
  const summary = comment
    .trim()
    .split("\n", 1)[0]
    ?.replaceAll(/[^\p{L}\p{M}\p{N} ]+/gu, " ")
    .replaceAll(/ {2,}/g, " ")
    .trim();
  const excerpt = Array.from(summary ?? "")
    .slice(0, 96)
    .join("")
    .trimEnd();
  const title = excerpt ? `Visual feedback: ${excerpt}` : "Visual feedback";
  const { locale, theme, viewport, dpr } = submission.page;
  const context = codeBlock(
    [
      field("URL", page.url),
      field("Locale", locale),
      field("Theme", theme),
      `Viewport: ${viewport.width} × ${viewport.height}`,
      `Device pixel ratio: ${dpr}`,
    ].join("\n"),
  );

  const pins = submission.pins.map((pin, index) => {
    const { selector, domPath, tag, role, accessibleName, text, rect, styles } = pin;
    const fields = codeBlock(
      [
        field("Selector", !page.sensitive || structuralSelector.test(selector) ? selector : ""),
        field("DOM path", !page.sensitive || structuralSelector.test(domPath) ? domPath : ""),
        field("Tag", tag),
        field("Accessible name", page.sensitive ? "" : accessibleName),
        field("Role", role),
        `Rect: x=${rect.x}, y=${rect.y}, width=${rect.width}, height=${rect.height}`,
        field("Text", page.sensitive ? "" : text),
        field("Display", styles.display),
        field("Position", styles.position),
        field("Color", styles.color),
        field("Background color", styles.backgroundColor),
        field("Font size", styles.fontSize),
        field("Font weight", styles.fontWeight),
      ].join("\n"),
    );
    return `### ${index + 1}. Element\n\n${fields}`;
  });

  const diagnostics = submission.diagnostics.map(
    ({ kind, timestamp }) => `- ${kind} at ${new Date(timestamp).toISOString()}`,
  );

  const body = [
    "## Feedback",
    codeBlock(comment),
    "## Page",
    context,
    "## Pins",
    ...pins,
    "## Diagnostics",
    diagnostics.length === 0 ? "None recorded." : diagnostics.join("\n"),
  ].join("\n\n");
  return { title, body, labels: ["visual-feedback"] };
};

const GitHubIssueNumber = Schema.Struct({
  number: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
});

export const createFeedbackIssue = (
  client: HttpClient.HttpClient,
  config: FeedbackConfig,
  submission: FeedbackSubmission,
  page: Parameters<typeof issueContent>[1],
) =>
  Effect.gen(function* () {
    const issue = issueContent(submission, page);
    const response = yield* HttpClient.withScope(client).execute(
      HttpClientRequest.post(`https://api.github.com/repos/${config.repository}/issues`).pipe(
        HttpClientRequest.setHeaders({
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        }),
        HttpClientRequest.bearerToken(Redacted.value(config.token)),
        HttpClientRequest.bodyJsonUnsafe(issue),
      ),
    );
    if (response.status !== 201) return undefined;
    const { number } = yield* Schema.decodeUnknownEffect(GitHubIssueNumber)(yield* response.json);
    return {
      issueNumber: number,
      issueUrl: `https://github.com/${config.repository}/issues/${number}`,
      title: issue.title,
    } satisfies FeedbackIssue;
  }).pipe(
    Effect.scoped,
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() => undefined),
  );
