/**
 * Pure-Effect v4 programmatic monitor for `alerts@kvitbit.com` GCS archive objects.
 *
 * Lists raw `.eml` objects under `gs://<bucket>/inbound/alerts/`, cryptographically verifies
 * RFC 6376 DKIM signatures against an explicit sender-domain allowlist (default:
 * `google.com,posthog.com`), deduplicates in SQLite, and files GitHub issues with label
 * `alert` (separate from `visual-feedback` so untrusted email cannot auto-trigger
 * `scripts/issue-pool` coding workers).
 */

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { Clock, Context, Data, Effect, Layer } from "effect";
import { parseEmail } from "../../infra/alchemy/src/mail-forwarder/mime";
import { type DnsTxtResolver, DnsTxtResolverLive, verifyAlertDkim } from "./dkim";
import { DEFAULT_ALERT_LABEL, type FormattedAlertIssue, formatAlertIssue } from "./issue";
import { AlertInboxStore } from "./store";

export const DEFAULT_ALERT_BUCKET = "kvitbit-prod-mail-archive-prod";
export const DEFAULT_ALERT_PREFIX = "inbound/alerts/";
export const DEFAULT_ALERT_REPO = "KvitBit/KvitBit";
export const DEFAULT_ALLOWED_DOMAINS = ["google.com", "posthog.com"] as const;

export class AlertInboxError extends Data.TaggedError("AlertInboxError")<{
  readonly reason: string;
}> {}

export interface AlertBucketService {
  readonly listObjects: (
    bucket: string,
    prefix: string,
  ) => Effect.Effect<ReadonlyArray<string>, AlertInboxError>;
  readonly downloadObject: (
    bucket: string,
    objectKey: string,
  ) => Effect.Effect<Uint8Array, AlertInboxError>;
}

export class AlertBucket extends Context.Service<AlertBucket, AlertBucketService>()(
  "KvitbitAlertBucket",
) {}

export interface AlertIssueTrackerService {
  readonly ensureLabel: (repo: string, label: string) => Effect.Effect<void, AlertInboxError>;
  readonly createIssue: (
    repo: string,
    issue: FormattedAlertIssue,
  ) => Effect.Effect<{ readonly number: number; readonly url: string }, AlertInboxError>;
}

export class AlertIssueTracker extends Context.Service<
  AlertIssueTracker,
  AlertIssueTrackerService
>()("KvitbitAlertIssueTracker") {}

const runSubprocess = (
  cmd: ReadonlyArray<string>,
  stdinBytes?: Uint8Array,
): Effect.Effect<Uint8Array, AlertInboxError> =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn([...cmd], {
        stdin: stdinBytes ? new Response(stdinBytes) : "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdoutBuf, stderrBuf, exitCode] = await Promise.all([
        new Response(proc.stdout).arrayBuffer(),
        new Response(proc.stderr).arrayBuffer(),
        proc.exited,
      ]);
      if (exitCode !== 0) {
        const stderrText = Buffer.from(stderrBuf).toString("utf8").trim();
        throw new Error(`${cmd[0]} exited ${exitCode}: ${stderrText || "unknown error"}`);
      }
      return new Uint8Array(stdoutBuf);
    },
    catch: (error) =>
      new AlertInboxError({
        reason: error instanceof Error ? error.message : String(error),
      }),
  });

export const GcloudAlertBucketLive: Layer.Layer<AlertBucket> = Layer.succeed(AlertBucket, {
  listObjects: (bucket, prefix) => {
    const cleanPrefix = prefix.replace(/^\/+/, "");
    const uri = `gs://${bucket}/${cleanPrefix}`;
    return runSubprocess(["gcloud", "storage", "ls", "--recursive", uri]).pipe(
      Effect.map((buf) => {
        const prefixUri = `gs://${bucket}/`;
        return Buffer.from(buf)
          .toString("utf8")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.startsWith(prefixUri) && line.endsWith(".eml"))
          .map((line) => line.slice(prefixUri.length))
          .sort();
      }),
      Effect.catchIf(
        (err) =>
          /matched no objects|not found|One or more URLs matched no objects/i.test(err.reason),
        () => Effect.succeed([] as ReadonlyArray<string>),
      ),
    );
  },
  downloadObject: (bucket, objectKey) =>
    runSubprocess(["gcloud", "storage", "cat", `gs://${bucket}/${objectKey}`]),
});

export const GhAlertIssueTrackerLive: Layer.Layer<AlertIssueTracker> = Layer.succeed(
  AlertIssueTracker,
  {
    ensureLabel: (repo, label) =>
      runSubprocess([
        "gh",
        "api",
        "--hostname",
        "github.com",
        "--method",
        "POST",
        `repos/${repo}/labels`,
        "-f",
        `name=${label}`,
        "-f",
        "color=d93f0b",
        "-f",
        "description=Automated production alert from DKIM-verified email",
      ]).pipe(
        Effect.asVoid,
        Effect.catchIf(
          (err) => /already_exists|HTTP 422/i.test(err.reason),
          () => Effect.void,
        ),
      ),
    createIssue: (repo, issue) =>
      runSubprocess(
        [
          "gh",
          "api",
          "--hostname",
          "github.com",
          "--method",
          "POST",
          `repos/${repo}/issues`,
          "--input",
          "-",
        ],
        Buffer.from(
          JSON.stringify({
            title: issue.title,
            body: issue.body,
            labels: [...issue.labels],
          }),
          "utf8",
        ),
      ).pipe(
        Effect.flatMap((buf) =>
          Effect.try({
            try: () => {
              const parsed = JSON.parse(Buffer.from(buf).toString("utf8")) as {
                number?: unknown;
                html_url?: unknown;
              };
              if (typeof parsed.number !== "number" || !Number.isSafeInteger(parsed.number)) {
                throw new Error("GitHub issue creation response missing issue number");
              }
              return {
                number: parsed.number,
                url:
                  typeof parsed.html_url === "string"
                    ? parsed.html_url
                    : `https://github.com/${repo}/issues/${parsed.number}`,
              };
            },
            catch: (error) =>
              new AlertInboxError({
                reason: error instanceof Error ? error.message : String(error),
              }),
          }),
        ),
      ),
  },
);

export const extractDeliveryHash = (objectKey: string, rawBytes: Uint8Array): string => {
  const match = objectKey.match(/(?:^|\/)by-hash\/([a-f0-9]{32})\//i);
  if (match?.[1]) return match[1].toLowerCase();
  return createHash("sha256").update(rawBytes).digest("hex").slice(0, 32);
};

export interface AlertInboxPassOptions {
  readonly apply: boolean;
  readonly bucket: string;
  readonly prefix: string;
  readonly repo: string;
  readonly allowedDomains: ReadonlyArray<string>;
  readonly label: string;
  readonly maxPerPass: number;
  readonly store: AlertInboxStore;
}

export interface AlertInboxPassResult {
  readonly scanned: number;
  readonly created: ReadonlyArray<{
    readonly objectKey: string;
    readonly issueNumber: number | null;
    readonly title: string;
    readonly signingDomain: string;
  }>;
  readonly duplicates: ReadonlyArray<{
    readonly objectKey: string;
    readonly matchedBy: "delivery_hash" | "message_id";
    readonly existingIssueNumber: number | null;
  }>;
  readonly rejected: ReadonlyArray<{
    readonly objectKey: string;
    readonly reason: string;
  }>;
  readonly failures: ReadonlyArray<{
    readonly objectKey: string;
    readonly reason: string;
  }>;
}

export const runAlertInboxPass = (
  options: AlertInboxPassOptions,
): Effect.Effect<
  AlertInboxPassResult,
  AlertInboxError,
  AlertBucket | AlertIssueTracker | DnsTxtResolver
> =>
  Effect.gen(function* () {
    const bucketSvc = yield* AlertBucket;
    const tracker = yield* AlertIssueTracker;
    const allObjects = yield* bucketSvc.listObjects(options.bucket, options.prefix);
    const unseen = allObjects
      .filter((objectKey) => !options.store.hasObjectKey(objectKey))
      .slice(0, options.maxPerPass);

    const created: Array<{
      readonly objectKey: string;
      readonly issueNumber: number | null;
      readonly title: string;
      readonly signingDomain: string;
    }> = [];
    const duplicates: Array<{
      readonly objectKey: string;
      readonly matchedBy: "delivery_hash" | "message_id";
      readonly existingIssueNumber: number | null;
    }> = [];
    const rejected: Array<{ readonly objectKey: string; readonly reason: string }> = [];
    const failures: Array<{ readonly objectKey: string; readonly reason: string }> = [];

    let labelEnsured = false;

    for (const objectKey of unseen) {
      const nowIso = new Date(yield* Clock.currentTimeMillis).toISOString();
      const rawResult = yield* Effect.result(bucketSvc.downloadObject(options.bucket, objectKey));
      if (rawResult._tag === "Failure") {
        failures.push({ objectKey, reason: rawResult.failure.reason });
        continue;
      }
      const rawBytes = rawResult.success;
      const deliveryHash = extractDeliveryHash(objectKey, rawBytes);
      const parsed = parseEmail(rawBytes);

      const existing = options.store.findCreatedByHashOrMessageId(deliveryHash, parsed.messageId);
      if (existing !== null) {
        duplicates.push({
          objectKey,
          matchedBy: existing.matchedBy,
          existingIssueNumber: existing.issueNumber,
        });
        if (options.apply) {
          options.store.record({
            objectKey,
            deliveryHash,
            messageId: parsed.messageId ?? null,
            status: "duplicate",
            issueNumber: existing.issueNumber,
            reason: `Duplicate by ${existing.matchedBy}`,
            processedAt: nowIso,
          });
        }
        continue;
      }

      const dkim = yield* verifyAlertDkim(rawBytes, options.allowedDomains);
      if (dkim._tag === "DkimTransientError") {
        failures.push({ objectKey, reason: dkim.reason });
        continue;
      }
      if (dkim._tag === "DkimRejected") {
        rejected.push({ objectKey, reason: dkim.reason });
        if (options.apply) {
          options.store.record({
            objectKey,
            deliveryHash,
            messageId: parsed.messageId ?? null,
            status: "rejected",
            issueNumber: null,
            reason: dkim.reason,
            processedAt: nowIso,
          });
        }
        continue;
      }

      const formatted = formatAlertIssue({
        parsed,
        verified: dkim,
        archiveUri: `gs://${options.bucket}/${objectKey}`,
        label: options.label,
      });

      if (!options.apply) {
        created.push({
          objectKey,
          issueNumber: null,
          title: formatted.title,
          signingDomain: dkim.signingDomain,
        });
        continue;
      }

      if (!labelEnsured) {
        const ensureResult = yield* Effect.result(tracker.ensureLabel(options.repo, options.label));
        if (ensureResult._tag === "Failure") {
          failures.push({ objectKey, reason: ensureResult.failure.reason });
          continue;
        }
        labelEnsured = true;
      }

      const createResult = yield* Effect.result(tracker.createIssue(options.repo, formatted));
      if (createResult._tag === "Failure") {
        failures.push({ objectKey, reason: createResult.failure.reason });
        continue;
      }

      options.store.record({
        objectKey,
        deliveryHash,
        messageId: parsed.messageId ?? null,
        status: "created",
        issueNumber: createResult.success.number,
        reason: null,
        processedAt: nowIso,
      });
      created.push({
        objectKey,
        issueNumber: createResult.success.number,
        title: formatted.title,
        signingDomain: dkim.signingDomain,
      });
    }

    return {
      scanned: unseen.length,
      created,
      duplicates,
      rejected,
      failures,
    };
  });

const REPO_SLUG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/(?!\.{1,2}$)[a-zA-Z0-9_.-]{1,100}$/;

const main = Effect.gen(function* () {
  const { values } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      bucket: { type: "string", default: DEFAULT_ALERT_BUCKET },
      prefix: { type: "string", default: DEFAULT_ALERT_PREFIX },
      repo: { type: "string", default: DEFAULT_ALERT_REPO },
      "allowed-domains": { type: "string", default: DEFAULT_ALLOWED_DOMAINS.join(",") },
      label: { type: "string", default: DEFAULT_ALERT_LABEL },
      state: { type: "string" },
      "max-per-pass": { type: "string", default: "20" },
    },
  });

  if (values.apply && !values.state) {
    return yield* new AlertInboxError({ reason: "--apply requires --state" });
  }
  if (!REPO_SLUG_PATTERN.test(values.repo)) {
    return yield* new AlertInboxError({ reason: "--repo must be a GitHub owner/name" });
  }
  const maxPerPass = Number(values["max-per-pass"]);
  if (!/^[1-9][0-9]*$/.test(values["max-per-pass"]) || !Number.isSafeInteger(maxPerPass)) {
    return yield* new AlertInboxError({ reason: "--max-per-pass must be a positive integer" });
  }
  const allowedDomains = values["allowed-domains"]
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/\.$/, ""))
    .filter((d) => d.length > 0);
  if (allowedDomains.length === 0) {
    return yield* new AlertInboxError({
      reason: "--allowed-domains must contain at least one domain",
    });
  }

  const statePath = values.state;
  if (values.apply && statePath) {
    process.umask(0o077);
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(statePath), { recursive: true, mode: 0o700 }),
      catch: (error) =>
        new AlertInboxError({
          reason: error instanceof Error ? error.message : String(error),
        }),
    });
  }

  const stateExists =
    statePath !== undefined
      ? yield* Effect.tryPromise({
          try: () => Bun.file(statePath).exists(),
          catch: () => new AlertInboxError({ reason: "Failed to check state file existence" }),
        })
      : false;

  const store =
    statePath !== undefined && (values.apply || stateExists)
      ? new AlertInboxStore(statePath, !values.apply)
      : new AlertInboxStore(":memory:", false);

  const result = yield* runAlertInboxPass({
    apply: values.apply,
    bucket: values.bucket,
    prefix: values.prefix,
    repo: values.repo,
    allowedDomains,
    label: values.label,
    maxPerPass,
    store,
  }).pipe(Effect.ensuring(Effect.sync(() => store.close())));

  process.stdout.write(
    `${JSON.stringify({ apply: values.apply, repo: values.repo, bucket: values.bucket, prefix: values.prefix, ...result })}\n`,
  );
  if (result.failures.length > 0) {
    process.exitCode = 1;
  }
});

if (import.meta.main) {
  const LiveLayer = Layer.mergeAll(
    GcloudAlertBucketLive,
    GhAlertIssueTrackerLive,
    DnsTxtResolverLive,
  );
  await Effect.runPromise(
    main.pipe(
      Effect.provide(LiveLayer),
      Effect.catch((error) =>
        Effect.sync(() => {
          process.stderr.write(`${error.reason}\n`);
          process.exitCode = 1;
        }),
      ),
    ),
  );
}
