import type { CaptureStorage } from "./capture-storage-port";

const storage = async () => (await import("@react-native-async-storage/async-storage")).default;
const keyFor = (scope: string) => `expense-capture:v1:${scope}`;
const locks = new Map<string, Promise<unknown>>();

export const captureStorage: CaptureStorage = {
  load: async (scope) => (await storage()).getItem(keyFor(scope)),
  save: async (scope, value, previous) => {
    const store = await storage();
    const key = keyFor(scope);
    const latest = (await store.getItem(key)) ?? "[]";
    if (latest !== previous) throw new Error("Receipt queue changed while saving");
    await store.setItem(key, value);
  },
  lock: async (scope, work) => {
    const previous = locks.get(scope);
    const next = Promise.resolve(previous)
      .catch(() => undefined)
      .then(work);
    locks.set(scope, next);
    const clear = () => {
      if (locks.get(scope) === next) locks.delete(scope);
    };
    void next.then(clear, clear);
    return next;
  },
};
