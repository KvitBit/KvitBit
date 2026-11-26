import type { RequestKey } from "@kvitbit/domain/contract";
import { describeError, type UiError, uuidV7 } from "@kvitbit/ui-port/api";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Effect } from "effect";
import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";

interface IntentStorage {
  getItem(slot: string): Promise<string | null>;
  setItem(slot: string, value: string): Promise<void>;
  removeItem(slot: string): Promise<void>;
}

// Wire payloads are JSON. Sort object keys so a rerender or a restored form
// can reconstruct the same intent even when keys were inserted in a different order.
const canonicalPayload = (payload: unknown): string =>
  JSON.stringify(payload, (_key, value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    );
  }) ?? "";

export const makeRequestIntents = (
  storage: IntentStorage,
  digest: (value: string) => Promise<string>,
  mint: () => Promise<RequestKey>,
) => {
  const pending = new Map<string, Promise<void>>();
  const inSlot = async <T>(
    owner: string,
    operation: string,
    work: (slot: string) => Promise<T>,
  ) => {
    const slot = `kvitbit.request-intent.v1.${await digest(JSON.stringify([owner, operation]))}`;
    // Web tabs share local storage. Native uses the same queue within its JS runtime.
    if (typeof navigator !== "undefined" && navigator.locks !== undefined) {
      return navigator.locks.request(slot, () => work(slot));
    }
    const task = (pending.get(slot) ?? Promise.resolve()).then(() => work(slot));
    const settled = task.then(
      () => undefined,
      () => undefined,
    );
    pending.set(slot, settled);
    try {
      return await task;
    } finally {
      if (pending.get(slot) === settled) pending.delete(slot);
    }
  };

  return {
    acquireRequestKey: async (owner: string, operation: string, payload: unknown) => {
      const fingerprint = await digest(canonicalPayload(payload));
      return inSlot(owner, operation, async (slot) => {
        const stored = await storage.getItem(slot);
        const [previousFingerprint, previousKey] = stored?.split(":") ?? [];
        if (previousFingerprint === fingerprint && previousKey) return previousKey as RequestKey;
        const key = await mint();
        await storage.setItem(slot, `${fingerprint}:${key}`);
        return key;
      });
    },
    completeRequestKey: (owner: string, operation: string, key: RequestKey) =>
      inSlot(owner, operation, async (slot) => {
        const stored = await storage.getItem(slot);
        if (stored?.split(":")[1] === key) await storage.removeItem(slot);
      }),
  };
};

export const { acquireRequestKey, completeRequestKey } = makeRequestIntents(
  AsyncStorage,
  (value) => digestStringAsync(CryptoDigestAlgorithm.SHA256, value),
  async () => (await Effect.runPromise(uuidV7)) as RequestKey,
);

export const settlesRequestIntent = (
  result: { readonly _tag: "Ok" } | { readonly _tag: "Err"; readonly error: UiError },
): boolean => result._tag === "Ok" || describeError(result.error).clearRequestKey;
