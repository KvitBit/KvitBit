import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { findReadyUpdate, type OtaUpdateSource } from "./ota-update";

type CheckResult = Awaited<ReturnType<OtaUpdateSource["checkForUpdateAsync"]>>;
type FetchResult = Awaited<ReturnType<OtaUpdateSource["fetchUpdateAsync"]>>;

const available: CheckResult = {
  isAvailable: true,
  isRollBackToEmbedded: false,
};

const unavailable: CheckResult = {
  isAvailable: false,
  isRollBackToEmbedded: false,
};

const fetchedNew: FetchResult = {
  isNew: true,
  isRollBackToEmbedded: false,
  manifest: { id: "update-a" },
};

const rollBack: CheckResult = {
  isAvailable: false,
  isRollBackToEmbedded: true,
};

const fetchedRollBack: FetchResult = {
  isNew: false,
  isRollBackToEmbedded: true,
};

const fetchedNothingNew: FetchResult = {
  isNew: false,
  isRollBackToEmbedded: false,
};

const source = (check: () => Promise<CheckResult>, fetch: () => Promise<FetchResult>) => {
  const calls = { check: 0, fetch: 0 };
  const updates: OtaUpdateSource = {
    checkForUpdateAsync: () => {
      calls.check += 1;
      return check();
    },
    fetchUpdateAsync: () => {
      calls.fetch += 1;
      return fetch();
    },
  };
  return { calls, updates };
};

describe("findReadyUpdate", () => {
  test("downloads an available update and reports it ready", async () => {
    const { calls, updates } = source(
      () => Promise.resolve(available),
      () => Promise.resolve(fetchedNew),
    );
    expect(await Effect.runPromise(findReadyUpdate(updates))).toEqual({
      kind: "update",
      updateId: "update-a",
    });
    expect(calls).toEqual({ check: 1, fetch: 1 });
  });

  test("fetches a rollback directive and reports the embedded update ready", async () => {
    const { calls, updates } = source(
      () => Promise.resolve(rollBack),
      () => Promise.resolve(fetchedRollBack),
    );
    expect(await Effect.runPromise(findReadyUpdate(updates))).toEqual({
      kind: "embedded",
    });
    expect(calls).toEqual({ check: 1, fetch: 1 });
  });

  test("reports nothing when the rollback fetch brings nothing to apply", async () => {
    const { calls, updates } = source(
      () => Promise.resolve(rollBack),
      () => Promise.resolve(fetchedNothingNew),
    );
    expect(await Effect.runPromise(findReadyUpdate(updates))).toBeUndefined();
    expect(calls).toEqual({ check: 1, fetch: 1 });
  });

  // The server may publish between the check and the fetch, so the fetch
  // result decides what is ready.
  test("reports the rollback a download brought after the check found an update", async () => {
    const { updates } = source(
      () => Promise.resolve(available),
      () => Promise.resolve(fetchedRollBack),
    );
    expect(await Effect.runPromise(findReadyUpdate(updates))).toEqual({
      kind: "embedded",
    });
  });

  test("reports the update a download brought after the check found a rollback", async () => {
    const { updates } = source(
      () => Promise.resolve(rollBack),
      () => Promise.resolve(fetchedNew),
    );
    expect(await Effect.runPromise(findReadyUpdate(updates))).toEqual({
      kind: "update",
      updateId: "update-a",
    });
  });

  test("swallows a failed rollback fetch", async () => {
    const { updates } = source(
      () => Promise.resolve(rollBack),
      () => Promise.reject(new Error("signature rejected")),
    );
    expect(await Effect.runPromise(findReadyUpdate(updates))).toBeUndefined();
  });

  test("downloads nothing when the server has no update", async () => {
    const { calls, updates } = source(
      () => Promise.resolve(unavailable),
      () => Promise.resolve(fetchedNew),
    );
    expect(await Effect.runPromise(findReadyUpdate(updates))).toBeUndefined();
    expect(calls).toEqual({ check: 1, fetch: 0 });
  });

  test("reports nothing when the download brings nothing new", async () => {
    const { updates } = source(
      () => Promise.resolve(available),
      () => Promise.resolve(fetchedNothingNew),
    );
    expect(await Effect.runPromise(findReadyUpdate(updates))).toBeUndefined();
  });

  test("swallows a failed check", async () => {
    const { calls, updates } = source(
      () => Promise.reject(new Error("offline")),
      () => Promise.resolve(fetchedNew),
    );
    expect(await Effect.runPromise(findReadyUpdate(updates))).toBeUndefined();
    expect(calls.fetch).toBe(0);
  });

  test("swallows a check that throws before returning a promise", async () => {
    const { updates } = source(
      () => {
        throw new Error("updates disabled");
      },
      () => Promise.resolve(fetchedNew),
    );
    expect(await Effect.runPromise(findReadyUpdate(updates))).toBeUndefined();
  });

  test("swallows a failed download", async () => {
    const { updates } = source(
      () => Promise.resolve(available),
      () => Promise.reject(new Error("signature rejected")),
    );
    expect(await Effect.runPromise(findReadyUpdate(updates))).toBeUndefined();
  });
});
