import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { RequestKey } from "@kvitbit/domain/contract";
import { makeRequestIntents } from "./request-intent";

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
  await retry.completeRequestKey(owner, operation, key);
  expect(await retry.acquireRequestKey(owner, operation, { amount: "400", currency: "CZK" })).toBe(
    edited,
  );
  await retry.completeRequestKey(owner, operation, edited);
  expect(
    await retry.acquireRequestKey(owner, operation, { amount: "400", currency: "CZK" }),
  ).not.toBe(edited);
});
