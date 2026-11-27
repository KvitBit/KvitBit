import type { CaptureStorage } from "./capture-storage-port";

const STORE = "jobs";
let opening: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("kvitbit-expense-capture", 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return opening.catch((error: unknown) => {
    opening = undefined;
    throw error;
  });
}

async function transaction<A>(
  mode: IDBTransactionMode,
  requestFor: (store: IDBObjectStore) => IDBRequest<A>,
): Promise<A> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode, { durability: "strict" });
    const request = requestFor(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error ?? new Error("Receipt queue changed while saving"));
  });
}

export const captureStorage: CaptureStorage = {
  load: async (scope) => (await transaction("readonly", (store) => store.get(scope))) ?? null,
  save: async (scope, value, previous) => {
    await transaction("readwrite", (store) => {
      const latest = store.get(scope);
      latest.onsuccess = () => {
        if ((latest.result ?? "[]") === previous) store.put(value, scope);
        else store.transaction.abort();
      };
      return latest;
    });
  },
  lock: async (scope, work) => {
    if (navigator.locks === undefined) return work();
    return navigator.locks.request(`kvitbit-expense-capture:${scope}`, work);
  },
};
