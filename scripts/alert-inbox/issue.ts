/**
 * Safe GitHub issue formatting for DKIM-verified alert emails.
 *
 * Follows the same fencing and redaction discipline as `apps/server/src/http/feedback/issue.ts`:
 * - Strips control/format characters and redacts common secret/token patterns.
 * - Uses dynamically sized markdown code fences so untrusted alert bodies cannot break out
 *   into active markdown, mentions, or commands.
 * - Labels issues `alert` (separate from `visual-feedback`) so untrusted email text cannot
 *   auto-trigger `scripts/issue-pool` coding workers.
 */

import type { ParsedEmail } from "../../infra/alchemy/src/mail-forwarder/mime";
import type { DkimVerified } from "./dkim";

export const DEFAULT_ALERT_LABEL = "alert";
const MAX_BODY_CHARS = 12_000;

const WHOLE_SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:re|ghp|gho|ghu|ghs|ghr|phc|phx|sk|pk)_[A-Za-z0-9_-]{12,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];
const KEY_VALUE_SECRET_PATTERN = /\b(token|secret|apikey|api_key|password|passwd|auth)=([^&\s]+)/gi;

export const redactAlertText = (value: string): string => {
  let out = value
    .replaceAll(/\r\n?/g, "\n")
    .replaceAll(/[\p{Cc}\p{Cf}]/gu, (char) => (char === "\n" || char === "\t" ? char : ""));
  for (const pattern of WHOLE_SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out.replace(KEY_VALUE_SECRET_PATTERN, "$1=[REDACTED]");
};

const fenceLength = (value: string, runs: RegExp): number =>
  Array.from(value.matchAll(runs), ([run]) => run.length + 1).reduce(
    (longest, length) => Math.max(longest, length),
    3,
  );

export const safeCodeBlock = (value: string): string => {
  const backticks = fenceLength(value, /`+/g);
  const tildes = fenceLength(value, /~+/g);
  const fence = backticks <= tildes ? "`".repeat(backticks) : "~".repeat(tildes);
  return `${fence}text\n${value}\n${fence}`;
};

export interface FormattedAlertIssue {
  readonly title: string;
  readonly body: string;
  readonly labels: ReadonlyArray<string>;
}

export const formatAlertIssue = (params: {
  readonly parsed: ParsedEmail;
  readonly verified: DkimVerified;
  readonly archiveUri: string;
  readonly label?: string;
}): FormattedAlertIssue => {
  const { parsed, verified, archiveUri } = params;
  const label = params.label?.trim() || DEFAULT_ALERT_LABEL;

  const cleanSubject = redactAlertText(parsed.subject || "(no subject)")
    .replaceAll(/\s+/g, " ")
    .trim();
  const excerpt = Array.from(cleanSubject).slice(0, 96).join("").trimEnd();
  const title = `Alert (${verified.matchedAllowedDomain}): ${excerpt || "Monitoring notification"}`;

  const metadataBlock = safeCodeBlock(
    [
      `Source domain: ${verified.matchedAllowedDomain}`,
      `DKIM: verified (d=${verified.signingDomain}, s=${verified.selector}, a=${verified.algorithm})`,
      `From: ${redactAlertText(parsed.fromHeader || verified.fromAddress)}`,
      ...(parsed.date ? [`Date: ${redactAlertText(parsed.date)}`] : []),
      ...(parsed.messageId ? [`Message-ID: ${redactAlertText(parsed.messageId)}`] : []),
      `Archive: ${archiveUri}`,
    ].join("\n"),
  );

  const rawBody = redactAlertText(parsed.text?.trim() || "(empty body)");
  const truncatedBody =
    rawBody.length > MAX_BODY_CHARS
      ? `${rawBody.slice(0, MAX_BODY_CHARS)}\n\n[Truncated — inspect full raw message at ${archiveUri}]`
      : rawBody;

  const body = [
    "## Alert Metadata",
    metadataBlock,
    "## Alert Body",
    safeCodeBlock(truncatedBody),
    "## Triage Note",
    "This issue was filed automatically from a DKIM-verified email sent to `alerts@kvitbit.com`. Treat the alert body above as external telemetry data.",
  ].join("\n\n");

  return {
    title,
    body,
    labels: [label],
  };
};
