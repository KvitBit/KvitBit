/**
 * The PWA's file store (ui-port-contracts 5.3 Capture.persist, PWA column): queued receipts live
 * in IndexedDB under `idb:<key>` refs so they survive reloads; other refs are object URLs.
 */
const DB = "kvitbit-capture";
const STORE = "blobs";

let opening: Promise<IDBDatabase> | null = null;
const db = (): Promise<IDBDatabase> => {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      opening = null;
      reject(request.error);
    };
  });
  return opening;
};

const run = async <A>(
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<A>,
): Promise<A> => {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = body(database.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

export const blobOf = async (ref: string): Promise<Blob | null> => {
  try {
    if (ref.startsWith("idb:")) {
      const value = await run<unknown>("readonly", (s) => s.get(ref.slice(4)));
      return value instanceof Blob ? value : null;
    }
    const response = await fetch(ref);
    return await response.blob();
  } catch {
    return null;
  }
};

export const putBlob = async (key: string, blob: Blob): Promise<string> => {
  await run("readwrite", (s) => s.put(blob, key));
  return `idb:${key}`;
};

export const deleteBlob = async (ref: string): Promise<void> => {
  if (ref.startsWith("idb:"))
    await run("readwrite", (s) => s.delete(ref.slice(4))).catch(() => undefined);
  else if (ref.startsWith("blob:")) URL.revokeObjectURL(ref);
};
