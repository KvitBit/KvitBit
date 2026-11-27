// biome-ignore-all lint/suspicious/noMisplacedAssertion: The storage fixture checks every compare-and-set performed by the tests.
import { describe, expect, test } from "bun:test";
import {
  ExpenseId,
  type WorkspaceSummary,
  WorkspaceSummary as WorkspaceSummarySchema,
} from "@kvitbit/domain/contract";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { buildAppConfig } from "../../../app.config";
import {
  BACKGROUND_CAPTURE_DRAIN_TASK,
  BACKGROUND_DRAIN_MIN_INTERVAL_MINUTES,
  type BackgroundTaskBridge,
  registerBackgroundCaptureDrain,
  unregisterBackgroundCaptureDrain,
} from "../../platform/capture/background-drain";
import * as webBackgroundDrain from "../../platform/capture/background-drain.web";
import type { CaptureStorage } from "../../platform/capture/capture-storage-port";
import { done } from "../../platform/transfer/http";
import { type ApiRunner, credentialsFor, makeApiRunner } from "../../runtime/api-runtime";
import { runBackgroundCaptureDrain } from "./background-drain";
import { type CaptureFields, makeCaptureQueue } from "./capture-queue";
import { readReceipt } from "./receipt-file";

const writableWorkspace: WorkspaceSummary = Schema.decodeEffect(WorkspaceSummarySchema)({
  id: "01937c7a-0000-7000-8000-000000000001",
  slug: "acme",
  role: "member",
  closed: false,
  name: "Acme",
  memberCount: 2,
  taxRegime: "vat_payer",
}).pipe(Effect.runSync);
const accountantWorkspace: WorkspaceSummary = Schema.decodeEffect(WorkspaceSummarySchema)({
  id: "01937c7a-0000-7000-8000-000000000002",
  slug: "readonly",
  role: "accountant",
  closed: false,
  name: "Readonly",
  memberCount: 2,
  taxRegime: "vat_payer",
}).pipe(Effect.runSync);
const closedWorkspace: WorkspaceSummary = Schema.decodeEffect(WorkspaceSummarySchema)({
  id: "01937c7a-0000-7000-8000-000000000003",
  slug: "closed-co",
  role: "owner",
  closed: true,
  name: "Closed Co",
  memberCount: 1,
  taxRegime: "vat_payer",
}).pipe(Effect.runSync);

const expenseId = ExpenseId.make("01937c7a-0000-7000-8000-000000000101");
const fields: CaptureFields = { supplierName: "Shop", total: "100", currency: "CZK", note: "" };
const sampleBytes = Uint8Array.of(37, 80, 68, 70, 45, 49, 46, 52);

function makeQueueFixture() {
  let nextKey = 0;
  const journal = new Map<string, string>();
  const bytes = new Map<string, Uint8Array<ArrayBuffer>>([["src:1", sampleBytes]]);
  const locks = new Map<string, Promise<unknown>>();
  const storage: CaptureStorage = {
    load: async (key) => journal.get(key) ?? null,
    save: (key, value, previous) =>
      Effect.sync(() => {
        expect(journal.get(key) ?? "[]").toBe(previous);
        journal.set(key, value);
      }).pipe(Effect.runPromise),
    lock: (key, work) => {
      const previous = locks.get(key);
      const next = Promise.resolve(previous)
        .catch(() => undefined)
        .then(work);
      locks.set(key, next);
      const clear = () => {
        if (locks.get(key) === next) locks.delete(key);
      };
      next.then(clear, clear);
      return next;
    },
  };
  const queue = makeCaptureQueue({
    storage,
    key: async () => `01937c7a-0000-7000-8000-${Str.padStart(12, "0")(String(++nextKey))}`,
    read: (file) =>
      readReceipt(file, (ref) =>
        Effect.sync(() => {
          const found = bytes.get(ref);
          if (found === undefined) throw new Error("Missing receipt bytes");
          return found.slice();
        }).pipe(Effect.runPromise),
      ),
    saveBytes: (key, _name, data) =>
      Effect.sync(() => {
        const ref = `saved:${key}`;
        bytes.set(ref, data.slice());
        return ref;
      }).pipe(Effect.runPromise),
    removeBytes: (ref) =>
      Effect.sync(() => {
        bytes.delete(ref);
      }).pipe(Effect.runPromise),
  });
  return { queue, bytes };
}

function makeFakeApi(
  workspaces: readonly WorkspaceSummary[],
  onRecord: (workspaceId: string, key: string) => Promise<ExpenseId> | ExpenseId,
): ApiRunner & { readonly dispose: () => Promise<void> } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api/v1/workspaces") return Response.json(workspaces);
      const workspaceId = Str.split("/")(pathname)[4];
      const key = request.headers.get("idempotency-key");
      if (workspaceId === undefined || key === null) return new Response(null, { status: 400 });
      const id = await onRecord(workspaceId, key);
      return Response.json(
        { id, revision: 1, status: "incomplete", currency: "CZK" },
        { status: 201 },
      );
    },
  });
  server.unref();
  const runner = makeApiRunner(server.url.origin, credentialsFor("tok"), () => "en");
  return {
    ...runner,
    dispose: async () => {
      await runner.dispose();
      server.stop(true);
    },
  };
}

describe("headless Android background capture drain", () => {
  test("reads durable bearer and current workspace permissions without React and drains only writable workspaces", async () => {
    const { queue } = makeQueueFixture();
    const writableScope = {
      principalId: "user-1",
      workspaceId: writableWorkspace.id,
      workspaceSlug: writableWorkspace.slug,
    };
    const accountantScope = {
      principalId: "user-1",
      workspaceId: accountantWorkspace.id,
      workspaceSlug: accountantWorkspace.slug,
    };

    const stagedWritable = await queue.stage({ scope: writableScope, canWrite: () => true }, null, [
      { ref: "src:1", name: "a.pdf", contentType: "application/pdf", size: sampleBytes.length },
    ]);
    const stagedAccountant = await queue.stage(
      { scope: accountantScope, canWrite: () => true },
      null,
      [{ ref: "src:1", name: "b.pdf", contentType: "application/pdf", size: sampleBytes.length }],
    );
    if (stagedWritable.job === undefined || stagedAccountant.job === undefined)
      throw new Error("Missing jobs");

    // Submit while offline so both sit queued in durable storage.
    await queue.submit(
      { scope: writableScope, canWrite: () => true },
      {
        isOnline: async () => false,
        record: async () => done(expenseId),
        upload: async () => done({}),
      },
      stagedWritable.job.key,
      fields,
      () => undefined,
    );
    await queue.submit(
      { scope: accountantScope, canWrite: () => true },
      {
        isOnline: async () => false,
        record: async () => done(expenseId),
        upload: async () => done({}),
      },
      stagedAccountant.job.key,
      fields,
      () => undefined,
    );

    const recordedWorkspaces: string[] = [];
    const uploadedPaths: string[] = [];

    const outcome = await runBackgroundCaptureDrain({
      origin: "https://kvitbit.cz",
      usesBearer: true,
      readToken: async () => "bearer-user-1",
      isOnline: async () => true,
      authFetch: (_origin, getToken) => (path) =>
        Effect.sync(() => {
          expect(path).toBe("/get-session");
          expect(getToken()).toBe("bearer-user-1");
          return {
            status: 200,
            ok: true,
            token: null,
            body: {
              user: { id: "user-1", email: "u1@example.com", name: "U1", emailVerified: true },
            },
          };
        }).pipe(Effect.runPromise),
      createApi: () =>
        makeFakeApi([writableWorkspace, accountantWorkspace, closedWorkspace], (wsId) => {
          recordedWorkspaces.push(wsId);
          return expenseId;
        }),
      createTransfer: () => ({
        upload: (req) =>
          Effect.sync(() => {
            uploadedPaths.push(req.path);
            return done({});
          }).pipe(Effect.runPromise),
      }),
      queue,
    });

    expect(outcome).toEqual({ status: "ok", drainedWorkspaces: 1, completedCount: 1 });
    expect(recordedWorkspaces).toEqual([writableWorkspace.id]);
    expect(uploadedPaths).toEqual([
      `/workspaces/${writableWorkspace.id}/expenses/${expenseId}/attachments`,
    ]);
    expect(await queue.load(writableScope)).toEqual([]);
    // Accountant workspace job was not drained because current permissions are read-only.
    expect(await queue.load(accountantScope)).toHaveLength(1);
  });

  test("stops without writing as another signed-in user when durable bearer changes mid-drain", async () => {
    const { queue } = makeQueueFixture();
    const scope = {
      principalId: "user-1",
      workspaceId: writableWorkspace.id,
      workspaceSlug: writableWorkspace.slug,
    };
    const staged = await queue.stage({ scope, canWrite: () => true }, null, [
      {
        ref: "src:1",
        name: "receipt.pdf",
        contentType: "application/pdf",
        size: sampleBytes.length,
      },
    ]);
    if (staged.job === undefined) throw new Error("Missing job");
    await queue.submit(
      { scope, canWrite: () => true },
      {
        isOnline: async () => false,
        record: async () => done(expenseId),
        upload: async () => done({}),
      },
      staged.job.key,
      fields,
      () => undefined,
    );

    let activeToken: string | null = "bearer-user-1";
    let uploads = 0;

    const outcome = await runBackgroundCaptureDrain({
      origin: "https://kvitbit.cz",
      usesBearer: true,
      readToken: async () => activeToken,
      isOnline: async () => true,
      authFetch: () => async () => ({
        status: 200,
        ok: true,
        token: null,
        body: { user: { id: "user-1", email: "u1@example.com", name: "U1", emailVerified: true } },
      }),
      createApi: () =>
        makeFakeApi([writableWorkspace], () => {
          // Another user signs in while the expense record request is in flight.
          activeToken = "bearer-user-2";
          return expenseId;
        }),
      createTransfer: () => ({
        upload: () =>
          Effect.sync(() => {
            uploads += 1;
            return done({});
          }).pipe(Effect.runPromise),
      }),
      queue,
    });

    expect(outcome.status).toBe("account_changed");
    expect(uploads).toBe(0);
    // Original user's job remains queued (not marked blocked) with its recorded expenseId.
    const remaining = await queue.load(scope);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.expenseId).toBe(expenseId);
    expect(remaining[0]?.submission?.failure).toBeUndefined();
  });

  test("serializes background drain with foreground drain on the same queue", async () => {
    const { queue } = makeQueueFixture();
    const scope = {
      principalId: "user-1",
      workspaceId: writableWorkspace.id,
      workspaceSlug: writableWorkspace.slug,
    };
    const staged = await queue.stage({ scope, canWrite: () => true }, null, [
      {
        ref: "src:1",
        name: "receipt.pdf",
        contentType: "application/pdf",
        size: sampleBytes.length,
      },
    ]);
    if (staged.job === undefined) throw new Error("Missing job");
    await queue.submit(
      { scope, canWrite: () => true },
      {
        isOnline: async () => false,
        record: async () => done(expenseId),
        upload: async () => done({}),
      },
      staged.job.key,
      fields,
      () => undefined,
    );

    let activeRecords = 0;
    let maxConcurrentRecords = 0;
    let totalRecords = 0;
    const firstRecordStarted = Deferred.makeUnsafe<void>();
    const waitToFinishRecord = Deferred.makeUnsafe<void>();

    const foreground = queue.drain(
      { scope, canWrite: () => true },
      {
        record: async () => {
          totalRecords += 1;
          activeRecords += 1;
          maxConcurrentRecords = Math.max(maxConcurrentRecords, activeRecords);
          Deferred.succeed(firstRecordStarted, undefined).pipe(Effect.runSync);
          await Deferred.await(waitToFinishRecord).pipe(Effect.runPromise);
          activeRecords -= 1;
          return done(expenseId);
        },
        upload: async () => done({}),
      },
      { reconnect: true, signedIn: true },
    );

    await Deferred.await(firstRecordStarted).pipe(Effect.runPromise);

    const background = runBackgroundCaptureDrain({
      origin: "https://kvitbit.cz",
      usesBearer: true,
      readToken: async () => "bearer-user-1",
      isOnline: async () => true,
      authFetch: () => async () => ({
        status: 200,
        ok: true,
        token: null,
        body: { user: { id: "user-1", email: "u1@example.com", name: "U1", emailVerified: true } },
      }),
      createApi: () =>
        makeFakeApi([writableWorkspace], () => {
          totalRecords += 1;
          activeRecords += 1;
          maxConcurrentRecords = Math.max(maxConcurrentRecords, activeRecords);
          activeRecords -= 1;
          return expenseId;
        }),
      createTransfer: () => ({ upload: async () => done({}) }),
      queue,
    });

    Deferred.succeed(waitToFinishRecord, undefined).pipe(Effect.runSync);
    const [fgResult, bgResult] = await Promise.all([foreground, background]);

    expect(maxConcurrentRecords).toBe(1);
    expect(totalRecords).toBe(1);
    expect(fgResult.completed).toHaveLength(1);
    expect(bgResult).toEqual({ status: "ok", drainedWorkspaces: 1, completedCount: 0 });
  });

  test("short-circuits when signed out or offline without API calls", async () => {
    let authCalls = 0;
    const authFetch = () => () =>
      Effect.sync(() => {
        authCalls += 1;
        return { status: 200, ok: true, token: null, body: null };
      }).pipe(Effect.runPromise);

    expect(
      await runBackgroundCaptureDrain({
        usesBearer: true,
        readToken: async () => null,
        isOnline: async () => true,
        authFetch,
      }),
    ).toEqual({ status: "signed_out", drainedWorkspaces: 0, completedCount: 0 });

    expect(
      await runBackgroundCaptureDrain({
        usesBearer: true,
        readToken: async () => "token",
        isOnline: async () => false,
        authFetch,
      }),
    ).toEqual({ status: "offline", drainedWorkspaces: 0, completedCount: 0 });

    expect(authCalls).toBe(0);
  });
});

describe("Android WorkManager background task registration and web fallback", () => {
  test("registers and unregisters on Android and stays no-op on web", async () => {
    const registered = new Map<string, { readonly minimumInterval?: number } | undefined>();
    const bridge: BackgroundTaskBridge = {
      platformOs: "android",
      isAvailableAsync: async () => true,
      getStatusAsync: async () => 2,
      availableStatus: 2,
      isTaskDefined: (name) => name === BACKGROUND_CAPTURE_DRAIN_TASK,
      isTaskRegisteredAsync: async (name) => registered.has(name),
      registerTaskAsync: (name, options) =>
        Effect.sync(() => {
          registered.set(name, options);
        }).pipe(Effect.runPromise),
      unregisterTaskAsync: (name) =>
        Effect.sync(() => {
          registered.delete(name);
        }).pipe(Effect.runPromise),
    };

    expect(await registerBackgroundCaptureDrain(bridge)).toBe(true);
    expect(registered.get(BACKGROUND_CAPTURE_DRAIN_TASK)).toEqual({
      minimumInterval: BACKGROUND_DRAIN_MIN_INTERVAL_MINUTES,
    });
    // Idempotent second call
    expect(await registerBackgroundCaptureDrain(bridge)).toBe(true);
    expect(await unregisterBackgroundCaptureDrain(bridge)).toBe(true);
    expect(registered.size).toBe(0);

    // Non-Android bridge and web fallback are no-ops
    expect(await registerBackgroundCaptureDrain({ ...bridge, platformOs: "web" })).toBe(false);
    expect(await webBackgroundDrain.registerBackgroundCaptureDrain()).toBe(false);
    expect(await webBackgroundDrain.unregisterBackgroundCaptureDrain()).toBe(false);
  });

  test("app.config.ts includes expo-background-task plugin", () => {
    const resolved = buildAppConfig({
      context: {
        config: { name: "Kvitbit", slug: "kvitbit", version: "0.1.0", plugins: [] },
        projectRoot: "/tmp",
        staticConfigPath: null,
        packageJsonPath: null,
      },
      env: {},
    });
    expect(resolved.plugins).toContain("expo-background-task");
  });
});
