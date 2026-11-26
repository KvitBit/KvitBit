import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { RequestKey } from "@kvitbit/domain/contract";
import { ok } from "@kvitbit/ui-port/api";
import {
  isRequestIntentExpired,
  makeRequestIntents,
  requestIntentFailure,
  runRequestIntent,
} from "./request-intent";

test("a committed write whose response was lost reuses its key after restart", async () => {
  const persisted = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => persisted.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      persisted.set(key, value);
    },
    removeItem: async (key: string) => {
      persisted.delete(key);
    },
  };
  const digest = async (value: string) => createHash("sha256").update(value).digest("hex");
  let minted = 0;
  const start = () =>
    makeRequestIntents(storage, digest, async () => `test-key-${++minted}` as RequestKey);
  const first = start();
  const owner = "origin-user-workspace";
  const operation = "recordPayment/invoice-1";
  const key = await first.acquireRequestKey(owner, operation, { amount: "321", currency: "CZK" });
  const committed = new Set([key]);
  const retry = start();
  const keys = await Promise.all([
    retry.acquireRequestKey(owner, operation, { currency: "CZK", amount: "321" }),
    retry.acquireRequestKey(owner, operation, { amount: "321", currency: "CZK" }),
  ]);
  for (const retryKey of keys) committed.add(retryKey);
  expect(committed.size).toBe(1);
  expect(
    await retry.acquireRequestKey("other-account", operation, { amount: "321", currency: "CZK" }),
  ).not.toBe(key);
  const edited = await retry.acquireRequestKey(owner, operation, {
    amount: "400",
    currency: "CZK",
  });
  expect(edited).not.toBe(key);
  expect(await retry.acquireRequestKey(owner, operation, { amount: "321", currency: "CZK" })).toBe(
    key,
  );
  await retry.completeRequestKey(owner, operation, key);
  expect(await retry.acquireRequestKey(owner, operation, { amount: "400", currency: "CZK" })).toBe(
    edited,
  );
  await retry.completeRequestKey(owner, operation, edited);
  expect(
    await retry.acquireRequestKey(owner, operation, { amount: "400", currency: "CZK" }),
  ).not.toBe(edited);
});

test("a restarted worker refuses an unresolved key when its server claim may have expired", async () => {
  const persisted = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => persisted.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      persisted.set(key, value);
    },
    removeItem: async (key: string) => {
      persisted.delete(key);
    },
  };
  const digest = async (value: string) => createHash("sha256").update(value).digest("hex");
  const firstAttempt = Date.UTC(2026, 10, 26);
  const retention = 24 * 60 * 60 * 1000;
  let now = firstAttempt;
  let minted = 0;
  const start = () =>
    makeRequestIntents(
      storage,
      digest,
      async () => `test-key-${++minted}` as RequestKey,
      () => now,
    );
  const owner = "user-1";
  const operation = "documents.issue";
  const payload = { draft: "first" };
  const key = await start().acquireRequestKey(owner, operation, payload);
  const retry = start();

  now = firstAttempt + retention - 1;
  expect(await retry.reuseRequestKey(owner, operation, payload, key)).toBe(key);
  expect(await retry.acquireRequestKey(owner, operation, payload)).toBe(key);

  now += 1;
  for (const acquire of [
    () => retry.acquireRequestKey(owner, operation, payload),
    () => retry.reuseRequestKey(owner, operation, payload, key),
  ]) {
    const error = await acquire().catch(requestIntentFailure);
    expect(typeof error !== "string" && isRequestIntentExpired(error)).toBe(true);
  }
  expect(minted).toBe(1);
  expect(await retry.acquireRequestKey(owner, operation, { draft: "another" })).not.toBe(key);
});

test("a failed success checkpoint preserves the key for recovery", async () => {
  const keys: RequestKey[] = [];
  const operation = "templates.use";
  const payload = { template: "test" };
  const call = async (key: RequestKey) => {
    keys.push(key);
    return ok("saved");
  };
  const first = await runRequestIntent("checkpoint-user", operation, payload, call, async () => {
    throw new Error("Interrupted while storing the acknowledgement");
  });
  expect(first._tag).toBe("Err");
  expect(await runRequestIntent("checkpoint-user", operation, payload, call)).toEqual(ok("saved"));
  expect(keys[0]).toBe(keys[1]);
});
