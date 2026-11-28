import * as DateTime from "effect/DateTime";
import * as Fn from "effect/Function";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
/**
 * Pure-Effect v4 programmatic monitor for `alerts@kvitbit.com` GCS archive objects.
 *
 * - Lists raw `.eml` objects under `gs://<bucket>/inbound/alerts/` (failing explicitly on
 *   missing `gcloud`, missing buckets, or permissions errors; only returning empty when the
 *   bucket is confirmed reachable).
 * - Cryptographically verifies RFC 6376 / RFC 8301 / RFC 8463 DKIM signatures against an
 *   explicit sender-domain allowlist (default: `google.com,posthog.com`), passing only verified
 *   header instances (including top-level MIME headers) and verified body bytes to formatting.
 * - Schedules fresh arrivals and due retries fairly (alternating turn persisted in SQLite so
 *   neither queue starves even at `maxPerPass === 1`).
 * - Serializes apply passes with an exclusive per-store apply lock and pairs SQLite claim leases
 *   with a monotonic `claim_generation` fencing token verified/renewed right before posting to
 *   GitHub, so overlapping or stale callers cannot double-post or downgrade created rows.
 * - Reconciles outstanding authenticated claims against GitHub independently of mutable labels
 *   BEFORE re-verifying DKIM (so key rotation cannot discard a committed issue).
 * - Always applies exclusively the `alert` label (never `visual-feedback`).
 */

import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
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
  type SchedulerQueue,
} from "./store";

const decodeParsed = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      number: Schema.optionalKey(Schema.Unknown),
      html_url: Schema.optionalKey(Schema.Unknown),
    }),
  ),
);

const encodeJsonValue = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Fn.flow(encodeJsonValue, Result.getOrThrow);

const cleanPrefixPattern = /^\/+/;
const lineBreakPattern = /\r?\n/;
const oneOrMorePattern = /One or more URLs matched no objects/i;
const alreadyExistsHttpPattern = /already_exists|HTTP 422/i;
const byHashPattern = /(?:^|\/)by-hash\/([a-f0-9]{32})\//i;
const mainPattern = /^[1-9][0-9]*$/;
const trailingDotPattern = /\.$/;

const DEFAULT_ALERT_BUCKET = "kvitbit-prod-mail-archive-prod";
const DEFAULT_ALERT_PREFIX = "inbound/alerts/";
const DEFAULT_ALERT_REPO = "KvitBit/KvitBit";
const DEFAULT_ALLOWED_DOMAINS = ["google.com", "posthog.com"] as const;

const BASE_RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;
const CLAIM_LEASE_MS = 5 * 60 * 1000;

export class AlertInboxError extends Schema.TaggedError<
  AlertInboxError,
  { readonly brand: unique symbol }
>()("AlertInboxError", {
  reason: Schema.String,
}) {}

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
  "kvitbit/scripts/alert-inbox/service/AlertBucket",
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
>()("kvitbit/scripts/alert-inbox/service/AlertIssueTracker") {}

export type SubprocessRunner = (
  cmd: ReadonlyArray<string>,
  stdinBytes?: Uint8Array,
) => Effect.Effect<Uint8Array, AlertInboxError>;

const runSubprocessLive: SubprocessRunner = Effect.fn("AlertInbox.runSubprocess")(
  function* (cmd, stdinBytes) {
    const failed = (cause: unknown) =>
      AlertInboxError.make({ reason: cause instanceof Error ? cause.message : String(cause) });
    const proc = yield* Effect.try({
      try: () =>
        Bun.spawn([...cmd], {
          stdin: stdinBytes !== undefined ? new Response(stdinBytes) : "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      catch: failed,
    });
    const [stdoutBuf, stderrBuf, exitCode] = yield* Effect.all(
      [
        Effect.tryPromise({ try: () => new Response(proc.stdout).arrayBuffer(), catch: failed }),
        Effect.tryPromise({ try: () => new Response(proc.stderr).arrayBuffer(), catch: failed }),
        Effect.tryPromise({ try: () => proc.exited, catch: failed }),
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      const stderrText = Str.trim(Buffer.from(stderrBuf).toString("utf8"));
      return yield* AlertInboxError.make({
        reason: `${cmd[0]} exited ${exitCode}: ${stderrText === "" ? "unknown error" : stderrText}`,
      });
    }
    return new Uint8Array(stdoutBuf);
  },
);

export function makeGcloudAlertBucket(run: SubprocessRunner): AlertBucketService {
  return {
    listObjects: Effect.fn("AlertInbox.listObjects")((bucket, prefix) => {
      const cleanPrefix = Str.replace(cleanPrefixPattern, "")(prefix);
      const uri = `gs://${bucket}/${cleanPrefix}`;
      return run(["gcloud", "storage", "ls", "--recursive", uri]).pipe(
        Effect.map((buf) => {
          const prefixUri = `gs://${bucket}/`;
          return Arr.map(
            Arr.filter(
              Arr.map(Str.split(Buffer.from(buf).toString("utf8"), lineBreakPattern), (line) =>
                Str.trim(line),
              ),
              (line) => Str.startsWith(prefixUri)(line) && Str.endsWith(".eml")(line),
            ),
            (line) => Str.slice(prefixUri.length)(line),
          ).sort(Order.String);
        }),
        Effect.catchIf(
          (err) => oneOrMorePattern.test(err.reason),
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
              Effect.as<ReadonlyArray<string>>([]),
              Effect.mapError((bucketErr) =>
                AlertInboxError.make({
                  reason: `Unable to verify bucket '${bucket}' after empty listing (${listErr.reason}): ${bucketErr.reason}`,
                }),
              ),
            ),
        ),
      );
    }),
    downloadObject: (bucket, objectKey) =>
      run(["gcloud", "storage", "cat", `gs://${bucket}/${objectKey}`]),
  };
}

const GcloudAlertBucketLive: Layer.Layer<AlertBucket> = Layer.succeed(
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
        (err) => alreadyExistsHttpPattern.test(err.reason),
        () => Effect.void,
      ),
    ),

  // Query all repository issues independent of mutable labels so relabeling/triage cannot defeat
  // lost-reply reconciliation.
  findExistingIssueByMarker: (repo, marker) =>
    run([
      "gh",
      "api",
      "--hostname",
      "github.com",
      "--paginate",
      "--slurp",
      `repos/${repo}/issues?state=all&per_page=100`,
    ]).pipe(
      Effect.flatMap((buf) =>
        Effect.try({
          try: () => {
            const pages = Schema.decodeResult(Schema.fromJsonString(Schema.Unknown))(
              Buffer.from(buf).toString("utf8"),
            ).pipe(Result.getOrThrow);
            if (!Arr.isArray(pages)) {
              throw new Error("Unexpected GitHub issues pagination response");
            }
            for (const page of pages) {
              if (!Arr.isArray(page)) continue;
              for (const item of page) {
                if (!Predicate.isObject(item)) continue;
                const rec = {
                  number: Reflect.get(item, "number"),
                  html_url: Reflect.get(item, "html_url"),
                  body: Reflect.get(item, "body"),
                  pull_request: Reflect.get(item, "pull_request"),
                };
                if (rec.pull_request !== undefined) continue;
                if (
                  Predicate.isNumber(rec.number) &&
                  Predicate.isString(rec.body) &&
                  Str.includes(marker)(rec.body)
                ) {
                  return {
                    number: rec.number,
                    url: Predicate.isString(rec.html_url)
                      ? rec.html_url
                      : `https://github.com/${repo}/issues/${rec.number}`,
                  };
                }
              }
            }
            return null;
          },
          catch: (error) =>
            AlertInboxError.make({
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
        encodeJson({
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
            const parsed = decodeParsed(Buffer.from(buf).toString("utf8")).pipe(Result.getOrThrow);
            if (!(Predicate.isNumber(parsed.number) && Number.isSafeInteger(parsed.number))) {
              throw new Error("GitHub issue creation response missing issue number");
            }
            return {
              number: parsed.number,
              url: Predicate.isString(parsed.html_url)
                ? parsed.html_url
                : `https://github.com/${repo}/issues/${parsed.number}`,
            };
          },
          catch: (error) =>
            AlertInboxError.make({
              reason: error instanceof Error ? error.message : String(error),
            }),
        }),
      ),
    ),
});

const GhAlertIssueTrackerLive: Layer.Layer<AlertIssueTracker> = Layer.succeed(
  AlertIssueTracker,
  makeGhAlertIssueTracker(runSubprocessLive),
);

const extractDeliveryHashImpl = (objectKey: string, rawBytes: Uint8Array): string => {
  const match = Option.getOrNull(Str.match(byHashPattern)(objectKey));
  if (match?.[1] !== undefined && match?.[1] !== "") return Str.toLowerCase(match[1]);
  return Str.slice(0, 32)(createHash("sha256").update(rawBytes).digest("hex"));
};

const extractDeliveryHash: {
  (rawBytes: Uint8Array): (objectKey: string) => string;
  (objectKey: string, rawBytes: Uint8Array): string;
} = Fn.dual(2, extractDeliveryHashImpl);

const computeAuthenticatedDedupKeyImpl = (
  deliveryHash: string,
  signedMessageId: string | undefined,
): string => {
  if (signedMessageId !== undefined && signedMessageId.length > 0) {
    return Str.slice(0, 32)(createHash("sha256").update(signedMessageId).digest("hex"));
  }
  return deliveryHash;
};

const computeAuthenticatedDedupKey: {
  (signedMessageId: string | undefined): (deliveryHash: string) => string;
  (deliveryHash: string, signedMessageId: string | undefined): string;
} = Fn.dual(2, computeAuthenticatedDedupKeyImpl);

const computeNextRetryIso = (nowMs: number, priorAttempts: number): string => {
  const exponent = Math.min(Math.max(priorAttempts, 0), 4);
  const delayMs = Math.min(BASE_RETRY_DELAY_MS * 2 ** exponent, MAX_RETRY_DELAY_MS);
  return DateTime.formatIso(DateTime.makeUnsafe(nowMs + delayMs));
};

interface QueuedCandidate {
  readonly objectKey: string;
  readonly prior: ProcessedAlertRecord | null;
  readonly queue: SchedulerQueue;
}

const selectFairBatch = (
  fresh: ReadonlyArray<QueuedCandidate>,
  dueRetries: ReadonlyArray<QueuedCandidate>,
  lastScheduledQueue: SchedulerQueue | null,
  maxPerPass: number,
): {
  readonly batch: ReadonlyArray<QueuedCandidate>;
  readonly nextLastScheduledQueue: SchedulerQueue | null;
} => {
  if (fresh.length === 0 && dueRetries.length === 0) {
    return { batch: [], nextLastScheduledQueue: null };
  }
  if (fresh.length === 0) {
    return { batch: dueRetries.slice(0, maxPerPass), nextLastScheduledQueue: "retry" };
  }
  if (dueRetries.length === 0) {
    return { batch: fresh.slice(0, maxPerPass), nextLastScheduledQueue: "fresh" };
  }

  // Alternate starting queue whenever both queues have ready work so neither fresh arrivals nor
  // due retries can starve, even when maxPerPass === 1.
  const startWith: SchedulerQueue = lastScheduledQueue === "fresh" ? "retry" : "fresh";
  const primary = startWith === "fresh" ? fresh : dueRetries;
  const secondary = startWith === "fresh" ? dueRetries : fresh;
  const batch: Array<QueuedCandidate> = [];
  let p = 0;
  let s = 0;
  while (batch.length < maxPerPass && (p < primary.length || s < secondary.length)) {
    const primaryItem = primary[p];
    if (primaryItem !== undefined) {
      batch.push(primaryItem);
      p += 1;
    }
    if (batch.length >= maxPerPass) break;
    const secondaryItem = secondary[s];
    if (secondaryItem !== undefined) {
      batch.push(secondaryItem);
      s += 1;
    }
  }
  return { batch, nextLastScheduledQueue: startWith };
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

const EMPTY_PASS_RESULT: AlertInboxPassResult = {
  scanned: 0,
  created: [],
  duplicates: [],
  rejected: [],
  failures: [],
};

const runAlertInboxPassUnlocked = (
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
    const nowIso = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    const allObjects = yield* bucketSvc.listObjects(options.bucket, options.prefix);

    const fresh: Array<QueuedCandidate> = [];
    const dueRetries: Array<QueuedCandidate> = [];

    for (const objectKey of allObjects) {
      const prior = yield* options.store.getObject(objectKey);
      if (prior === null) {
        fresh.push({ objectKey, prior: null, queue: "fresh" });
        continue;
      }
      if (
        prior.status === "created" ||
        prior.status === "duplicate" ||
        prior.status === "rejected"
      ) {
        continue;
      }
      if (prior.claimExpiresAt !== null && prior.claimExpiresAt > nowIso) {
        continue;
      }
      if (prior.nextRetryAt !== null && prior.nextRetryAt > nowIso) {
        continue;
      }
      dueRetries.push({ objectKey, prior, queue: "retry" });
    }

    dueRetries.sort((a, b) => {
      const retryA = a.prior?.nextRetryAt ?? "";
      const retryB = b.prior?.nextRetryAt ?? "";
      if (retryA !== retryB) return Str.localeCompare(retryB)(retryA);
      const attemptsA = a.prior?.attemptCount ?? 0;
      const attemptsB = b.prior?.attemptCount ?? 0;
      if (attemptsA !== attemptsB) return attemptsA - attemptsB;
      return Str.localeCompare(b.objectKey)(a.objectKey);
    });

    const lastScheduledQueue = yield* options.store.getLastScheduledQueue;
    const { batch, nextLastScheduledQueue } = selectFairBatch(
      fresh,
      dueRetries,
      lastScheduledQueue,
      options.maxPerPass,
    );
    if (options.apply && nextLastScheduledQueue !== null) {
      yield* options.store.setLastScheduledQueue(nextLastScheduledQueue);
    }

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
      const itemNowIso = DateTime.formatIso(DateTime.makeUnsafe(itemNowMs));
      const leaseUntilIso = DateTime.formatIso(DateTime.makeUnsafe(itemNowMs + CLAIM_LEASE_MS));
      const priorAttempts = prior?.attemptCount ?? 0;

      // If this object already holds an authenticated `claiming` state (from a prior DKIM-verified
      // attempt whose GitHub reply was lost), reconcile against GitHub BEFORE re-verifying DKIM
      // so routine sender key rotation/retirement cannot discard an already-committed issue.
      let claimAlreadyAcquired = false;
      let acquiredHolderObjectKey = objectKey;
      let acquiredClaimGeneration = 0;

      if (options.apply && prior?.status === "claiming" && prior.dedupKey !== null) {
        const claim = yield* options.store.tryClaimForCreation({
          objectKey,
          deliveryHash: prior.deliveryHash,
          dedupKey: prior.dedupKey,
          messageId: prior.messageId,
          nowIso: itemNowIso,
          leaseUntilIso,
        });
        if (claim.outcome === "in_flight") {
          continue;
        }
        if (claim.outcome === "already_created") {
          if (claim.objectKey !== objectKey) {
            yield* options.store.markDuplicate({
              objectKey,
              deliveryHash: prior.deliveryHash,
              dedupKey: prior.dedupKey,
              messageId: prior.messageId,
              issueNumber: claim.issueNumber,
              reason: "Duplicate of already-created claim",
              nowIso: itemNowIso,
            });
            duplicates.push({
              objectKey,
              matchedBy: "dedup_key",
              existingIssueNumber: claim.issueNumber,
            });
          }
          continue;
        }

        claimAlreadyAcquired = true;
        acquiredHolderObjectKey = claim.holderObjectKey;
        acquiredClaimGeneration = claim.claimGeneration;

        const lookupResult = yield* Effect.result(
          tracker.findExistingIssueByMarker(options.repo, alertIssueMarker(prior.dedupKey)),
        );
        if (lookupResult._tag === "Failure") {
          failures.push({ objectKey, reason: lookupResult.failure.reason });
          yield* options.store.markRetry({
            objectKey: acquiredHolderObjectKey,
            deliveryHash: prior.deliveryHash,
            dedupKey: prior.dedupKey,
            messageId: prior.messageId,
            keepClaiming: true,
            expectedClaimGeneration: acquiredClaimGeneration,
            reason: lookupResult.failure.reason,
            nextRetryAt: computeNextRetryIso(itemNowMs, priorAttempts),
            nowIso: itemNowIso,
          });
          continue;
        }
        if (lookupResult.success !== null) {
          const reconciledNumber = lookupResult.success.number;
          const marked = yield* options.store.markCreated({
            objectKey: acquiredHolderObjectKey,
            claimGeneration: acquiredClaimGeneration,
            issueNumber: reconciledNumber,
            nowIso: itemNowIso,
          });
          if (marked) {
            created.push({
              objectKey,
              issueNumber: reconciledNumber,
              title: `Reconciled issue #${reconciledNumber}`,
              signingDomain: "reconciled",
              reconciled: true,
            });
          }
          continue;
        }
      }

      const rawResult = yield* Effect.result(bucketSvc.downloadObject(options.bucket, objectKey));
      if (rawResult._tag === "Failure") {
        failures.push({ objectKey, reason: rawResult.failure.reason });
        if (options.apply) {
          const expectedClaimGenerationFields = claimAlreadyAcquired
            ? { expectedClaimGeneration: acquiredClaimGeneration }
            : {};
          yield* options.store.markRetry({
            objectKey: claimAlreadyAcquired ? acquiredHolderObjectKey : objectKey,
            deliveryHash: prior?.deliveryHash ?? extractDeliveryHash(objectKey, new Uint8Array(0)),
            dedupKey: prior?.dedupKey ?? null,
            messageId: prior?.messageId ?? null,
            keepClaiming: claimAlreadyAcquired || prior?.status === "claiming",
            ...expectedClaimGenerationFields,
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
      // already-created issues before verifying DKIM. Never mark an object as its own duplicate!
      const existingByHash = yield* options.store.findByDeliveryHash(deliveryHash);
      if (existingByHash !== null && existingByHash.status === "created") {
        if (existingByHash.objectKey === objectKey) {
          continue;
        }
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
          const expectedClaimGenerationFields2 = claimAlreadyAcquired
            ? { expectedClaimGeneration: acquiredClaimGeneration }
            : {};
          yield* options.store.markRetry({
            objectKey: claimAlreadyAcquired ? acquiredHolderObjectKey : objectKey,
            deliveryHash,
            dedupKey: prior?.dedupKey ?? null,
            messageId: prior?.messageId ?? null,
            keepClaiming: claimAlreadyAcquired || prior?.status === "claiming",
            ...expectedClaimGenerationFields2,
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

      const dedupKey = computeAuthenticatedDedupKey(deliveryHash, dkim.signedMessageId);
      const marker = alertIssueMarker(dedupKey);

      const existingAuth = yield* options.store.findByDedupKeyOrMessageId(
        dedupKey,
        dkim.signedMessageId,
      );
      if (existingAuth !== null && existingAuth.status === "created") {
        if (existingAuth.objectKey === objectKey) {
          continue;
        }
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

      // Atomically acquire the creation lease + fencing generation for this authenticated dedupKey.
      let holderObjectKey = acquiredHolderObjectKey;
      let claimGeneration = acquiredClaimGeneration;
      let needsReconcile = false;

      if (!claimAlreadyAcquired) {
        const claim = yield* options.store.tryClaimForCreation({
          objectKey,
          deliveryHash,
          dedupKey,
          messageId: dkim.signedMessageId ?? null,
          nowIso: itemNowIso,
          leaseUntilIso,
        });
        if (claim.outcome === "in_flight") {
          continue;
        }
        if (claim.outcome === "already_created") {
          if (claim.objectKey !== objectKey) {
            duplicates.push({
              objectKey,
              matchedBy: "dedup_key",
              existingIssueNumber: claim.issueNumber,
            });
            yield* options.store.markDuplicate({
              objectKey,
              deliveryHash,
              dedupKey,
              messageId: dkim.signedMessageId ?? null,
              issueNumber: claim.issueNumber,
              reason: "Duplicate by dedup_key",
              nowIso: itemNowIso,
            });
          }
          continue;
        }
        holderObjectKey = claim.holderObjectKey;
        claimGeneration = claim.claimGeneration;
        needsReconcile = claim.needsReconcile;
      }

      if (needsReconcile) {
        const lookupResult = yield* Effect.result(
          tracker.findExistingIssueByMarker(options.repo, marker),
        );
        if (lookupResult._tag === "Failure") {
          failures.push({ objectKey, reason: lookupResult.failure.reason });
          yield* options.store.markRetry({
            objectKey: holderObjectKey,
            deliveryHash,
            dedupKey,
            messageId: dkim.signedMessageId ?? null,
            keepClaiming: true,
            expectedClaimGeneration: claimGeneration,
            reason: lookupResult.failure.reason,
            nextRetryAt: computeNextRetryIso(itemNowMs, priorAttempts),
            nowIso: itemNowIso,
          });
          continue;
        }
        if (lookupResult.success !== null) {
          const reconciledNumber = lookupResult.success.number;
          const marked = yield* options.store.markCreated({
            objectKey: holderObjectKey,
            claimGeneration,
            issueNumber: reconciledNumber,
            nowIso: itemNowIso,
          });
          if (!marked) {
            continue;
          }
          if (holderObjectKey === objectKey) {
            created.push({
              objectKey,
              issueNumber: reconciledNumber,
              title: formatted.title,
              signingDomain: dkim.signingDomain,
              reconciled: true,
            });
          } else {
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
            objectKey: holderObjectKey,
            deliveryHash,
            dedupKey,
            messageId: dkim.signedMessageId ?? null,
            keepClaiming: true,
            expectedClaimGeneration: claimGeneration,
            reason: ensureResult.failure.reason,
            nextRetryAt: computeNextRetryIso(itemNowMs, priorAttempts),
            nowIso: itemNowIso,
          });
          continue;
        }
        labelEnsured = true;
      }

      // Re-verify & renew our fencing generation right before posting to GitHub so a paused pass
      // whose lease expired or was superseded can NEVER issue a duplicate POST.
      const prePostNowMs = yield* Clock.currentTimeMillis;
      const stillOwned = yield* options.store.verifyAndRenewClaim({
        objectKey: holderObjectKey,
        claimGeneration,
        nowIso: DateTime.formatIso(DateTime.makeUnsafe(prePostNowMs)),
        leaseUntilIso: DateTime.formatIso(DateTime.makeUnsafe(prePostNowMs + CLAIM_LEASE_MS)),
      });
      if (!stillOwned) {
        continue;
      }

      const createResult = yield* Effect.result(tracker.createIssue(options.repo, formatted));
      if (createResult._tag === "Failure") {
        failures.push({ objectKey, reason: createResult.failure.reason });
        yield* options.store.markRetry({
          objectKey: holderObjectKey,
          deliveryHash,
          dedupKey,
          messageId: dkim.signedMessageId ?? null,
          keepClaiming: true,
          expectedClaimGeneration: claimGeneration,
          reason: createResult.failure.reason,
          nextRetryAt: computeNextRetryIso(itemNowMs, priorAttempts),
          nowIso: itemNowIso,
        });
        continue;
      }

      const marked = yield* options.store.markCreated({
        objectKey: holderObjectKey,
        claimGeneration,
        issueNumber: createResult.success.number,
        nowIso: itemNowIso,
      });
      if (!marked) {
        continue;
      }

      if (holderObjectKey !== objectKey) {
        yield* options.store.markDuplicate({
          objectKey,
          deliveryHash,
          dedupKey,
          messageId: dkim.signedMessageId ?? null,
          issueNumber: createResult.success.number,
          reason: `Created under holder ${holderObjectKey}`,
          nowIso: itemNowIso,
        });
        duplicates.push({
          objectKey,
          matchedBy: "dedup_key",
          existingIssueNumber: createResult.success.number,
        });
      } else {
        created.push({
          objectKey,
          issueNumber: createResult.success.number,
          title: formatted.title,
          signingDomain: dkim.signingDomain,
        });
      }
    }

    return {
      scanned: batch.length,
      created,
      duplicates,
      rejected,
      failures,
    };
  });

export const runAlertInboxPass = (
  options: AlertInboxPassOptions,
): Effect.Effect<
  AlertInboxPassResult,
  AlertInboxError | AlertStoreError,
  AlertBucket | AlertIssueTracker | DnsTxtResolver
> => {
  if (!options.apply) {
    return runAlertInboxPassUnlocked(options);
  }
  return options.store
    .withExclusiveApplyLock(runAlertInboxPassUnlocked(options))
    .pipe(Effect.map((outcome) => (outcome.acquired ? outcome.value : EMPTY_PASS_RESULT)));
};

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
            "allowed-domains": { type: "string", default: Arr.join(DEFAULT_ALLOWED_DOMAINS, ",") },
            state: { type: "string" },
            "max-per-pass": { type: "string", default: "20" },
          },
        }),
      catch: (error) =>
        AlertInboxError.make({
          reason: error instanceof Error ? error.message : String(error),
        }),
    });

    const statePath = values.state;
    if (values.apply && !(statePath !== undefined && statePath !== "")) {
      return yield* AlertInboxError.make({ reason: "--apply requires --state" });
    }
    if (!REPO_SLUG_PATTERN.test(values.repo)) {
      return yield* AlertInboxError.make({ reason: "--repo must be a GitHub owner/name" });
    }
    const maxPerPass = Number(values["max-per-pass"]);
    if (!(mainPattern.test(values["max-per-pass"]) && Number.isSafeInteger(maxPerPass))) {
      return yield* AlertInboxError.make({ reason: "--max-per-pass must be a positive integer" });
    }
    const allowedDomains = Arr.filter(
      Arr.map(Str.split(values["allowed-domains"], ","), (d) =>
        Str.replace(trailingDotPattern, "")(Str.toLowerCase(Str.trim(d))),
      ),
      (d) => d.length > 0,
    );
    if (allowedDomains.length === 0) {
      return yield* AlertInboxError.make({
        reason: "--allowed-domains must contain at least one domain",
      });
    }

    if (values.apply === true && statePath !== undefined && statePath !== "") {
      process.umask(0o077);
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      yield* fs
        .makeDirectory(path.dirname(statePath), { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError((error) => AlertInboxError.make({ reason: error.message })));
    }

    const stateExists =
      statePath !== undefined
        ? yield* Effect.tryPromise({
            try: () => Bun.file(statePath).exists(),
            catch: () => AlertInboxError.make({ reason: "Failed to check state file existence" }),
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
      `${encodeJson({ apply: values.apply, repo: values.repo, bucket: values.bucket, prefix: values.prefix, label: ALERT_ISSUE_LABEL, ...result })}\n`,
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
    BunServices.layer,
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
