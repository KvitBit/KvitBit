import {
  type FeedbackIssue,
  type FeedbackSubmission,
  redactFeedbackApiKeys,
  redactFeedbackUrls,
} from "@kvitbit/api-contract";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import type { FeedbackConfig } from "./access";

const plainText = (value: string) =>
  redactFeedbackApiKeys(
    redactFeedbackUrls(
      Str.replaceAll(/(?![\n\t])[\p{Cc}\p{Cf}]/gu, "")(Str.replaceAll(/\r\n?/g, "\n")(value)),
    ),
  );

const fenceLength = (value: string, runs: RegExp) =>
  Arr.reduce(
    Array.from(Str.matchAll(runs)(value), ([run]) => run.length + 1),
    3,
    (longest, length) => Math.max(longest, length),
  );

const codeBlock = (value: string) => {
  const backticks = fenceLength(value, /`+/g);
  const tildes = fenceLength(value, /~+/g);
  const fence = backticks <= tildes ? Str.repeat(backticks)("`") : Str.repeat(tildes)("~");
  return `${fence}text\n${value}\n${fence}`;
};

const structuralSelector =
  /^(?:[a-z][a-z\d-]*(?::nth-of-type\([1-9]\d*\))?)(?: > [a-z][a-z\d-]*(?::nth-of-type\([1-9]\d*\))?)*$/;

const quote = Schema.encodeOption(Schema.fromJsonString(Schema.String));
const field = (label: string, value: string) =>
  `${label}: ${Option.getOrElse(quote(plainText(value)), () => '""')}`;

const issueContent = (
  submission: FeedbackSubmission,
  page: { readonly url: string; readonly sensitive: boolean },
) => {
  const comment = plainText(submission.comment);
  const summary = Str.split(Str.trim(comment), "\n")[0];
  const words = Str.trim(
    Str.replaceAll(/ {2,}/g, " ")(Str.replaceAll(/[^\p{L}\p{M}\p{N} ]+/gu, " ")(summary)),
  );
  const excerpt = Str.trimEnd(Arr.join(Array.from(words).slice(0, 96), ""));
  const title = excerpt.length > 0 ? `Visual feedback: ${excerpt}` : "Visual feedback";
  const { locale, theme, viewport, dpr } = submission.page;
  const context = codeBlock(
    Arr.join(
      [
        field("URL", page.url),
        field("Locale", locale),
        field("Theme", theme),
        `Viewport: ${viewport.width} × ${viewport.height}`,
        `Device pixel ratio: ${dpr}`,
      ],
      "\n",
    ),
  );

  const pins = Arr.map(submission.pins, (pin, index) => {
    const { selector, domPath, tag, role, accessibleName, text, rect, styles } = pin;
    const fields = codeBlock(
      Arr.join(
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
        ],
        "\n",
      ),
    );
    return `### ${index + 1}. Element\n\n${fields}`;
  });

  const diagnostics = Arr.map(
    submission.diagnostics,
    ({ kind, timestamp }) => `- ${kind} at ${DateTime.formatIso(DateTime.makeUnsafe(timestamp))}`,
  );

  const body = Arr.join(
    [
      "## Feedback",
      codeBlock(comment),
      "## Page",
      context,
      "## Pins",
      ...pins,
      "## Diagnostics",
      diagnostics.length === 0 ? "None recorded." : Arr.join(diagnostics, "\n"),
    ],
    "\n\n",
  );
  return { title, body, labels: ["visual-feedback"] };
};

const GitHubIssueNumber = Schema.Struct({
  number: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
});

export const createFeedbackIssue = Effect.fnUntraced(
  function* (
    client: HttpClient.HttpClient,
    config: FeedbackConfig,
    submission: FeedbackSubmission,
    page: Parameters<typeof issueContent>[1],
  ) {
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
    if (response.status !== 201) return;
    const rawIssue = yield* response.json;
    const { number } = yield* Schema.decodeUnknownEffect(GitHubIssueNumber)(rawIssue);
    return {
      issueNumber: number,
      issueUrl: `https://github.com/${config.repository}/issues/${number}`,
      title: issue.title,
    } satisfies FeedbackIssue;
  },
  Effect.scoped,
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
  Effect.timeout("10 seconds"),
  Effect.orElseSucceed(() => undefined),
);
