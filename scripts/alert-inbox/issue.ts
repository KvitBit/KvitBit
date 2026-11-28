/**
 * Safe GitHub issue formatting for DKIM-verified alert emails.
 *
 * Security invariants:
 * - Always applies exclusively the `alert` label (never `visual-feedback` or caller-overridden
 *   labels) so untrusted email text cannot route into `scripts/issue-pool` coding workers.
 * - Uses ONLY cryptographically verified DKIM header values (`fromHeader`, `signedSubject`,
 *   `signedDate`, `signedMessageId`, `signedContentType`, `signedContentDisposition`,
 *   `signedContentTransferEncoding`) and the verified body bytes, falling back to safe defaults
 *   when headers are unsigned (neutral title `"Monitoring notification"`, `text/plain; charset="utf-8"`,
 *   inline disposition, identity transfer encoding).
 * - Embeds a stable deterministic marker (`kvitbit-alert-key:<dedupKey>`) for idempotent
 *   reconciliation after uncertain GitHub API replies.
 * - Redacts secret/token patterns and dynamically sizes markdown code fences so untrusted body
 *   content cannot break out of fenced blocks.
 */

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { parseEmail } from "../../infra/alchemy/src/mail-forwarder/mime";
import type { DkimVerified } from "./dkim";

export const ALERT_ISSUE_LABEL = "alert" as const;
const MAX_BODY_CHARS = 12_000;

const WHOLE_SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:re|ghp|gho|ghu|ghs|ghr|phc|phx|sk|pk)_[A-Za-z0-9_-]{12,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];
const KEY_VALUE_SECRET_PATTERN = /\b(token|secret|apikey|api_key|password|passwd|auth)=([^&\s]+)/gi;

export const redactAlertText = (value: string): string => {
  let out = Str.replaceAll(/(?![\n\t])[\p{Cc}\p{Cf}]/gu, "")(Str.replaceAll(/\r\n?/g, "\n")(value));
  for (const pattern of WHOLE_SECRET_PATTERNS) {
    out = Str.replace(pattern, "[REDACTED]")(out);
  }
  return Str.replace(KEY_VALUE_SECRET_PATTERN, "$1=[REDACTED]")(out);
};

const fenceLength = (value: string, runs: RegExp): number =>
  Arr.reduce(
    Array.from(Str.matchAll(runs)(value), ([run]) => run.length + 1),
    3,
    (longest, length) => Math.max(longest, length),
  );

const safeCodeBlock = (value: string): string => {
  const backticks = fenceLength(value, /`+/g);
  const tildes = fenceLength(value, /~+/g);
  const fence = backticks <= tildes ? Str.repeat(backticks)("`") : Str.repeat(tildes)("~");
  return `${fence}text\n${value}\n${fence}`;
};

export const alertIssueMarker = (dedupKey: string): string => `kvitbit-alert-key:${dedupKey}`;

const sanitizeHeaderLineValue = (value: string): string =>
  Str.trim(Str.replace(/[\r\n]+/g, " ")(value));

/**
 * Renders the alert body using ONLY DKIM-verified top-level MIME headers and the verified body
 * bytes. Unsigned top-level Content-Type, Content-Disposition, or Content-Transfer-Encoding
 * headers are ignored in favor of safe defaults (`text/plain; charset="utf-8"`, inline, identity).
 */
const renderVerifiedAlertBodyText = (verified: DkimVerified): string => {
  const headers: Array<string> = [
    `Content-Type: ${
      verified.signedContentType !== undefined && verified.signedContentType !== ""
        ? sanitizeHeaderLineValue(verified.signedContentType)
        : 'text/plain; charset="utf-8"'
    }`,
  ];
  if (verified.signedContentDisposition !== undefined && verified.signedContentDisposition !== "") {
    headers.push(
      `Content-Disposition: ${sanitizeHeaderLineValue(verified.signedContentDisposition)}`,
    );
  }
  if (
    verified.signedContentTransferEncoding !== undefined &&
    verified.signedContentTransferEncoding !== ""
  ) {
    headers.push(
      `Content-Transfer-Encoding: ${sanitizeHeaderLineValue(verified.signedContentTransferEncoding)}`,
    );
  }
  const syntheticRaw = Buffer.concat([
    Buffer.from(`${Arr.join(headers, "\r\n")}\r\n\r\n`, "utf8"),
    Buffer.from(verified.verifiedBodyBytes),
  ]);
  const parsed = parseEmail(syntheticRaw);
  const trimmed = Str.trim(parsed.text ?? "");
  return trimmed === "" ? "(empty body)" : trimmed;
};

export interface FormattedAlertIssue {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly [typeof ALERT_ISSUE_LABEL];
}

export const formatAlertIssue = (params: {
  readonly verified: DkimVerified;
  readonly archiveUri: string;
  readonly dedupKey: string;
}): FormattedAlertIssue => {
  const { verified, archiveUri, dedupKey } = params;

  // Never copy an unsigned Subject into the issue title.
  const verifiedSubject =
    verified.signedSubject !== undefined
      ? Str.trim(Str.replaceAll(/\s+/g, " ")(redactAlertText(verified.signedSubject)))
      : "";
  const excerpt = Str.trimEnd(Arr.join(Array.from(verifiedSubject).slice(0, 96), ""));
  const title = `Alert (${verified.matchedAllowedDomain}): ${excerpt || "Monitoring notification"}`;

  const metadataBlock = safeCodeBlock(
    Arr.join(
      [
        `Source domain: ${verified.matchedAllowedDomain}`,
        `DKIM: verified (d=${verified.signingDomain}, s=${verified.selector}, a=${verified.algorithm})`,
        `From: ${redactAlertText(verified.fromHeader || verified.fromAddress)}`,
        ...(verified.signedDate !== undefined && verified.signedDate !== ""
          ? [`Date: ${redactAlertText(verified.signedDate)}`]
          : []),
        ...(verified.signedMessageId !== undefined && verified.signedMessageId !== ""
          ? [`Message-ID: ${redactAlertText(verified.signedMessageId)}`]
          : []),
        `Alert key: ${alertIssueMarker(dedupKey)}`,
        `Archive: ${archiveUri}`,
      ],
      "\n",
    ),
  );

  const rawBody = redactAlertText(renderVerifiedAlertBodyText(verified));
  const truncatedBody =
    rawBody.length > MAX_BODY_CHARS
      ? `${Str.slice(0, MAX_BODY_CHARS)(rawBody)}\n\n[Truncated — inspect full raw message at ${archiveUri}]`
      : rawBody;

  const body = Arr.join(
    [
      "## Alert Metadata",
      metadataBlock,
      "## Alert Body",
      safeCodeBlock(truncatedBody),
      "## Triage Note",
      "This issue was filed automatically from a DKIM-verified email sent to `alerts@kvitbit.com`. Treat the alert body above as external telemetry data.",
      `<!-- ${alertIssueMarker(dedupKey)} -->`,
    ],
    "\n\n",
  );

  return {
    title,
    body,
    labels: [ALERT_ISSUE_LABEL],
  };
};
