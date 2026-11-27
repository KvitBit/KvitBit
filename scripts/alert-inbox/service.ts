/**
 * Pure-Effect v4 programmatic monitor for `alerts@kvitbit.com` GCS archive objects.
 *
 * - Lists raw `.eml` objects under `gs://<bucket>/inbound/alerts/` (failing explicitly on
 *   missing `gcloud`, missing buckets, or permissions errors; only returning empty when the
 *   bucket is confirmed reachable).
 * - Cryptographically verifies RFC 6376 / RFC 8301 / RFC 8463 DKIM signatures against an
 *   explicit sender-domain allowlist (default: `google.com,posthog.com`).
 * - Deduplicates authenticated alerts in a scoped SQLite store with exponential retry backoff
 *   (preventing failing objects from starving fresh alerts) and claim + marker reconciliation
 *   (preventing duplicate GitHub issues when a create reply is lost).
 * - Always applies exclusively the `alert` label (never `visual-feedback`).
 */

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { Clock, Context, Data, Effect, Layer } from "effect";
import { parseEmail } from "../../infra/alchemy/src/mail-forwarder/mime";
import { type DnsTxtResolver, DnsTxtResolverLive, verifyAlertDkim } from "./dkim";
import {
  ALERT_ISSUE_LABEL,
  alertIssueMarker,
  type FormattedAlertIssue,
  formatAlertIssue,
} from "./issue";
import {
  type AlertInboxStoreService,
  type AlertStoreError,
  openAlertInboxStore,
  type ProcessedAlertRecord,
} from "./store";

export const DEFAULT_ALERT_BUCKET = "kvitbit-prod-mail-archive-prod";
export const DEFAULT_ALERT_PREFIX = "inbound/alerts/";
export const DEFAULT_ALERT_REPO = "KvitBit/KvitBit";
export const DEFAULT_ALLOWED_DOMAINS = ["google.com", "posthog.com"] as const;

const BASE_RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

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
  readonly ensureLabel: (
    repo: string,
    label: typeof ALERT_ISSUE_LABEL,
  ) => Effect.Effect<void, AlertInboxError>;
  readonly findExistingIssueByMarker: (
    repo: string,
    marker: string,
  ) => Effect.Effect<{ readonly number: number; readonly url: string } | null, AlertInboxError>;
  readonly createIssue: (
    repo: string,
    issue: FormattedAlertIssue,
  ) => Effect.Effect<{ readonly number: number; readonly url: string }, AlertInboxError>;
}

export class AlertIssueTracker extends Context.Service<
  AlertIssueTracker,
  AlertIssueTrackerService
>()("KvitbitAlertIssueTracker") {}

export type SubprocessRunner = (
  cmd: ReadonlyArray<string>,
  stdinBytes?: Uint8Array,
) => Effect.Effect<Uint8Array, AlertInboxError>;

export const runSubprocessLive: SubprocessRunner = (cmd, stdinBytes) =>
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

export const makeGcloudAlertBucket = (run: SubprocessRunner): AlertBucketService => ({
  listObjects: (bucket, prefix) => {
    const cleanPrefix = prefix.replace(/^\/+/, "");
    const uri = `gs://${bucket}/${cleanPrefix}`;
    return run(["gcloud", "storage", "ls", "--recursive", uri]).pipe(
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
        (err) => /One or more URLs matched no objects/i.test(err.reason),
        (listErr) =>
          // Confirm the bucket itself actually exists before treating no-match as an empty prefix.
          run([
            "gcloud",
            "storage",
            "buckets",
            "describe",
            `gs://${bucket}`,
            "--format=value(name)",
          ]).pipe(
            Effect.as([] as ReadonlyArray<string>),
            Effect.mapError(
              (bucketErr) =>
                new AlertInboxError({
                  reason: `Unable to verify bucket '${bucket}' after empty listing (${listErr.reason}): ${bucketErr.reason}`,
                }),
            ),
          ),
      ),
    );
  },
  downloadObject: (bucket, objectKey) =>
    run(["gcloud", "storage", "cat", `gs://${bucket}/${objectKey}`]),
});

export const GcloudAlertBucketLive: Layer.Layer<AlertBucket> = Layer.succeed(
  AlertBucket,
  makeGcloudAlertBucket(runSubprocessLive),
);

export const makeGhAlertIssueTracker = (run: SubprocessRunner): AlertIssueTrackerService => ({
  ensureLabel: (repo, label) =>
    run([
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

  findExistingIssueByMarker: (repo, marker) =>
    run([
      "gh",
      "api",
      "--hostname",
      "github.com",
      "--paginate",
      "--slurp",
      `repos/${repo}/issues?state=all&labels=${encodeURIComponent(ALERT_ISSUE_LABEL)}&per_page=100`,
    ]).pipe(
      Effect.flatMap((buf) =>
        Effect.try({
          try: () => {
            const pages = JSON.parse(Buffer.from(buf).toString("utf8")) as unknown;
            if (!Array.isArray(pages)) {
              throw new Error("Unexpected GitHub issues pagination response");
            }
            for (const page of pages) {
              if (!Array.isArray(page)) continue;
              for (const item of page) {
                if (typeof item !== "object" || item === null) continue;
                const rec = item as {
                  number?: unknown;
                  html_url?: unknown;
                  body?: unknown;
                  pull_request?: unknown;
                };
                if (rec.pull_request !== undefined) continue;
                if (
                  typeof rec.number === "number" &&
                  typeof rec.body === "string" &&
                  rec.body.includes(marker)
                ) {
                  return {
                    number: rec.number,
                    url:
                      typeof rec.html_url === "string"
                        ? rec.html_url
                        : `https://github.com/${repo}/issues/${rec.number}`,
                  };
                }
              }
            }
            return null;
          },
          catch: (error) =>
            new AlertInboxError({
              reason: error instanceof Error ? error.message : String(error),
            }),
        }),
      ),
    ),

  createIssue: (repo, issue) =>
    run(
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
          labels: [ALERT_ISSUE_LABEL],
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
});

export const GhAlertIssueTrackerLive: Layer.Layer<AlertIssueTracker> = Layer.succeed(
  AlertIssueTracker,
  makeGhAlertIssueTracker(runSubprocessLive),
);

export const extractDeliveryHash = (objectKey: string, rawBytes: Uint8Array): string => {
  const match = objectKey.match(/(?:^|\/)by-hash\/([a-f0-9]{32})\//i);
  if (match?.[1]) return match[1].toLowerCase();
  return createHash("sha256").update(rawBytes).digest("hex").slice(0, 32);
};

export const computeAuthenticatedDedupKey = (
  deliveryHash: string,
  signedMessageId: string | undefined,
): string => {
  if (signedMessageId !== undefined && signedMessageId.length > 0) {
    return createHash("sha256").update(signedMessageId).digest("hex").slice(0, 32);
  }
  return deliveryHash;
};

const computeNextRetryIso = (nowMs: number, priorAttempts: number): string => {
  const exponent = Math.min(Math.max(priorAttempts, 0), 4);
  const delayMs = Math.min(BASE_RETRY_DELAY_MS * 2 ** exponent, MAX_RETRY_DELAY_MS);
  return new Date(nowMs + delayMs).toISOString();
};

export interface AlertInboxPassOptions {
  readonly apply: boolean;
  readonly bucket: string;
  readonly prefix: string;
  readonly repo: string;
  readonly allowedDomains: ReadonlyArray<string>;
  readonly maxPerPass: number;
  readonly store: AlertInboxStoreService;
}

export interface AlertInboxPassResult {
  readonly scanned: number;
  readonly created: ReadonlyArray<{
    readonly objectKey: string;
    readonly issueNumber: number | null;
    readonly title: string;
    readonly signingDomain: string;
    readonly reconciled?: boolean;
  }>;
  readonly duplicates: ReadonlyArray<{
    readonly objectKey: string;
    readonly matchedBy: "delivery_hash" | "dedup_key" | "message_id";
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
  AlertInboxError | AlertStoreError,
  AlertBucket | AlertIssueTracker | DnsTxtResolver
> =>
  Effect.gen(function* () {
    const bucketSvc = yield* AlertBucket;
    const tracker = yield* AlertIssueTracker;
    const nowMs = yield* Clock.currentTimeMillis;
    const nowIso = new Date(nowMs).toISOString();
    const allObjects = yield* bucketSvc.listObjects(options.bucket, options.prefix);

    // Separate fresh unseen objects from due retries so a failing object never starves new alerts.
    const fresh: Array<{ readonly objectKey: string; readonly prior: null }> = [];
    const dueRetries: Array<{
      readonly objectKey: string;
      readonly prior: ProcessedAlertRecord;
    }> = [];

    for (const objectKey of allObjects) {
      const prior = yield* options.store.getObject(objectKey);
      if (prior === null) {
        fresh.push({ objectKey, prior: null });
        continue;
      }
      if (
        prior.status === "created" ||
        prior.status === "duplicate" ||
        prior.status === "rejected"
      ) {
        continue;
      }
      if (prior.nextRetryAt !== null && prior.nextRetryAt > nowIso) {
        continue;
      }
      dueRetries.push({ objectKey, prior });
    }

    dueRetries.sort((a, b) => {
      if (a.prior.attemptCount !== b.prior.attemptCount) {
        return a.prior.attemptCount - b.prior.attemptCount;
      }
      return a.objectKey.localeCompare(b.objectKey);
    });

    const batch = [...fresh, ...dueRetries].slice(0, options.maxPerPass);

    const created: Array<{
      readonly objectKey: string;
      readonly issueNumber: number | null;
      readonly title: string;
      readonly signingDomain: string;
      readonly reconciled?: boolean;
    }> = [];
    const duplicates: Array<{
      readonly objectKey: string;
      readonly matchedBy: "delivery_hash" | "dedup_key" | "message_id";
      readonly existingIssueNumber: number | null;
    }> = [];
    const rejected: Array<{ readonly objectKey: string; readonly reason: string }> = [];
    const failures: Array<{ readonly objectKey: string; readonly reason: string }> = [];

    let labelEnsured = false;

    for (const { objectKey, prior } of batch) {
      const itemNowMs = yield* Clock.currentTimeMillis;
      const itemNowIso = new Date(itemNowMs).toISOString();
      const priorAttempts = prior?.attemptCount ?? 0;

      const rawResult = yield* Effect.result(bucketSvc.downloadObject(options.bucket, objectKey));
      if (rawResult._tag === "Failure") {
        failures.push({ objectKey, reason: rawResult.failure.reason });
        if (options.apply) {
          yield* options.store.markRetry({
            objectKey,
            deliveryHash: prior?.deliveryHash ?? extractDeliveryHash(objectKey, new Uint8Array(0)),
            dedupKey: prior?.dedupKey ?? null,
            messageId: prior?.messageId ?? null,
            keepClaiming: prior?.status === "claiming",
            reason: rawResult.failure.reason,
            nextRetryAt: computeNextRetryIso(itemNowMs, priorAttempts),
            nowIso: itemNowIso,
          });
        }
        continue;
      }

      const rawBytes = rawResult.success;
      const deliveryHash = extractDeliveryHash(objectKey, rawBytes);

      // Delivery hash is a cryptographic SHA-256 of the wire bytes; safe to check against
      // already-created issues before verifying DKIM. Cross-delivery Message-ID deduplication
      // happens strictly AFTER DKIM verification using the authenticated signed Message-ID.
      const existingByHash = yield* options.store.findByDeliveryHash(deliveryHash);
      if (existingByHash !== null && existingByHash.status === "created") {
        duplicates.push({
          objectKey,
          matchedBy: "delivery_hash",
          existingIssueNumber: existingByHash.issueNumber,
        });
        if (options.apply) {
          yield* options.store.markDuplicate({
            objectKey,
            deliveryHash,
            dedupKey: null,
            messageId: null,
            issueNumber: existingByHash.issueNumber,
            reason: "Duplicate by delivery_hash",
            nowIso: itemNowIso,
          });
        }
        continue;
      }

      const dkim = yield* verifyAlertDkim(rawBytes, options.allowedDomains);
      if (dkim._tag === "DkimTransientError") {
        failures.push({ objectKey, reason: dkim.reason });
        if (options.apply) {
          yield* options.store.markRetry({
            objectKey,
            deliveryHash,
            dedupKey: prior?.dedupKey ?? null,
            messageId: prior?.messageId ?? null,
            keepClaiming: prior?.status === "claiming",
            reason: dkim.reason,
            nextRetryAt: computeNextRetryIso(itemNowMs, priorAttempts),
            nowIso: itemNowIso,
          });
        }
        continue;
      }
      if (dkim._tag === "DkimRejected") {
        rejected.push({ objectKey, reason: dkim.reason });
        if (options.apply) {
          yield* options.store.markRejected({
            objectKey,
            deliveryHash,
            reason: dkim.reason,
            nowIso: itemNowIso,
          });
        }
        continue;
      }

      const parsed = parseEmail(rawBytes);
      const dedupKey = computeAuthenticatedDedupKey(deliveryHash, dkim.signedMessageId);
      const marker = alertIssueMarker(dedupKey);

      const existingAuth = yield* options.store.findByDedupKeyOrMessageId(
        dedupKey,
        dkim.signedMessageId,
      );
      if (existingAuth !== null && existingAuth.status === "created") {
        duplicates.push({
          objectKey,
          matchedBy: existingAuth.matchedBy,
          existingIssueNumber: existingAuth.issueNumber,
        });
        if (options.apply) {
          yield* options.store.markDuplicate({
            objectKey,
            deliveryHash,
            dedupKey,
            messageId: dkim.signedMessageId ?? null,
            issueNumber: existingAuth.issueNumber,
            reason: `Duplicate by ${existingAuth.matchedBy}`,
            nowIso: itemNowIso,
          });
        }
        continue;
      }

      const formatted = formatAlertIssue({
        parsed,
        verified: dkim,
        archiveUri: `gs://${options.bucket}/${objectKey}`,
        dedupKey,
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

      // If this object or another object with the same authenticated dedupKey is in `claiming`
      // state (e.g. from a lost GitHub reply), reconcile against GitHub before creating.
      const needsReconcile = prior?.status === "claiming" || existingAuth?.status === "claiming";
      if (needsReconcile) {
        const lookupResult = yield* Effect.result(
          tracker.findExistingIssueByMarker(options.repo, marker),
        );
        if (lookupResult._tag === "Failure") {
          failures.push({ objectKey, reason: lookupResult.failure.reason });
          yield* options.store.markRetry({
            objectKey,
            deliveryHash,
            dedupKey,
            messageId: dkim.signedMessageId ?? null,
            keepClaiming: true,
            reason: lookupResult.failure.reason,
            nextRetryAt: computeNextRetryIso(itemNowMs, priorAttempts),
            nowIso: itemNowIso,
          });
          continue;
        }
        if (lookupResult.success !== null) {
          const reconciledNumber = lookupResult.success.number;
          if (prior?.status === "claiming") {
            yield* options.store.markCreated({
              objectKey,
              issueNumber: reconciledNumber,
              nowIso: itemNowIso,
            });
            created.push({
              objectKey,
              issueNumber: reconciledNumber,
              title: formatted.title,
              signingDomain: dkim.signingDomain,
              reconciled: true,
            });
          } else {
            if (existingAuth !== null) {
              yield* options.store.markCreated({
                objectKey: existingAuth.objectKey,
                issueNumber: reconciledNumber,
                nowIso: itemNowIso,
              });
            }
            yield* options.store.markDuplicate({
              objectKey,
              deliveryHash,
              dedupKey,
              messageId: dkim.signedMessageId ?? null,
              issueNumber: reconciledNumber,
              reason: `Reconciled existing issue #${reconciledNumber}`,
              nowIso: itemNowIso,
            });
            duplicates.push({
              objectKey,
              matchedBy: existingAuth?.matchedBy ?? "dedup_key",
              existingIssueNumber: reconciledNumber,
            });
          }
          continue;
        }
      }

      if (!labelEnsured) {
        const ensureResult = yield* Effect.result(
          tracker.ensureLabel(options.repo, ALERT_ISSUE_LABEL),
        );
        if (ensureResult._tag === "Failure") {
          failures.push({ objectKey, reason: ensureResult.failure.reason });
          yield* options.store.markRetry({
            objectKey,
            deliveryHash,
            dedupKey,
            messageId: dkim.signedMessageId ?? null,
            keepClaiming: prior?.status === "claiming",
            reason: ensureResult.failure.reason,
            nextRetryAt: computeNextRetryIso(itemNowMs, priorAttempts),
            nowIso: itemNowIso,
          });
          continue;
        }
        labelEnsured = true;
      }

      // Persist claim BEFORE posting so a lost reply reconciles instead of creating a duplicate.
      yield* options.store.claimForCreation({
        objectKey,
        deliveryHash,
        dedupKey,
        messageId: dkim.signedMessageId ?? null,
        nowIso: itemNowIso,
      });

      const createResult = yield* Effect.result(tracker.createIssue(options.repo, formatted));
      if (createResult._tag === "Failure") {
        failures.push({ objectKey, reason: createResult.failure.reason });
        yield* options.store.markRetry({
          objectKey,
          deliveryHash,
          dedupKey,
          messageId: dkim.signedMessageId ?? null,
          keepClaiming: true,
          reason: createResult.failure.reason,
          nextRetryAt: computeNextRetryIso(itemNowMs, priorAttempts),
          nowIso: itemNowIso,
        });
        continue;
      }

      yield* options.store.markCreated({
        objectKey,
        issueNumber: createResult.success.number,
        nowIso: itemNowIso,
      });
      created.push({
        objectKey,
        issueNumber: createResult.success.number,
        title: formatted.title,
        signingDomain: dkim.signingDomain,
      });
    }

    return {
      scanned: batch.length,
      created,
      duplicates,
      rejected,
      failures,
    };
  });

const REPO_SLUG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/(?!\.{1,2}$)[a-zA-Z0-9_.-]{1,100}$/;

const main = Effect.scoped(
  Effect.gen(function* () {
    const { values } = yield* Effect.try({
      try: () =>
        parseArgs({
          options: {
            apply: { type: "boolean", default: false },
            bucket: { type: "string", default: DEFAULT_ALERT_BUCKET },
            prefix: { type: "string", default: DEFAULT_ALERT_PREFIX },
            repo: { type: "string", default: DEFAULT_ALERT_REPO },
            "allowed-domains": { type: "string", default: DEFAULT_ALLOWED_DOMAINS.join(",") },
            state: { type: "string" },
            "max-per-pass": { type: "string", default: "20" },
          },
        }),
      catch: (error) =>
        new AlertInboxError({
          reason: error instanceof Error ? error.message : String(error),
        }),
    });

    const statePath = values.state;
    if (values.apply && !statePath) {
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
        ? yield* openAlertInboxStore(statePath, !values.apply)
        : yield* openAlertInboxStore(":memory:", false);

    const result = yield* runAlertInboxPass({
      apply: values.apply,
      bucket: values.bucket,
      prefix: values.prefix,
      repo: values.repo,
      allowedDomains,
      maxPerPass,
      store,
    });

    process.stdout.write(
      `${JSON.stringify({ apply: values.apply, repo: values.repo, bucket: values.bucket, prefix: values.prefix, label: ALERT_ISSUE_LABEL, ...result })}\n`,
    );
    if (result.failures.length > 0) {
      process.exitCode = 1;
    }
  }),
);

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
