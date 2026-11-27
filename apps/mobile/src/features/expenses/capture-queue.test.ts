import { describe, expect, test } from "bun:test";
import { PayloadTooLarge } from "@kvitbit/api-contract";
import {
  ExpenseId,
  Invalid,
  WorkspaceId,
  WorkspaceSlug,
  type WorkspaceSummary,
  WorkspaceSummary as WorkspaceSummarySchema,
} from "@kvitbit/domain/contract";
import { UiError } from "@kvitbit/ui-port/api";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import type { CaptureStorage } from "../../platform/capture/capture-storage-port";
import { done, failed } from "../../platform/transfer/http";
import {
  type CaptureAccess,
  type CaptureFields,
  type CaptureNetwork,
  makeCaptureQueue,
  mayCapture,
  summarizeCaptureJobs,
} from "./capture-queue";
import { importSharedReceipts } from "./capture-share";
import { readReceipt } from "./receipt-file";

const workspace: WorkspaceSummary = Schema.decodeEffect(WorkspaceSummarySchema)({
  id: "01937c7a-0000-7000-8000-000000000001",
  slug: "test",
  role: "member",
  closed: false,
  name: "Test",
  memberCount: 1,
  taxRegime: "vat_payer",
}).pipe(Effect.runSync);
const expenseId = ExpenseId.make("01937c7a-0000-7000-8000-000000000002");
const scope = { principalId: "account", workspaceId: workspace.id, workspaceSlug: workspace.slug };
const access: CaptureAccess = { scope, canWrite: () => true };
const first = { ref: "cache:first", name: "receipt.pdf", contentType: "application/pdf", size: 1 };
const second = { ...first, ref: "cache:second" };
const a = Uint8Array.of(97, 98, 99);
const b = Uint8Array.of(0, 255, 7);
const fields: CaptureFields = {
  supplierName: "Supplier",
  currency: "CZK",
  total: "45,50",
  note: "",
};
const progress = () => undefined;

function fixture() {
  let nextKey = 0;
  let clock = 0;
  const journal = new Map<string, string>();
  const bytes = new Map<string, Uint8Array<ArrayBuffer>>([
    [first.ref, a],
    [second.ref, b],
  ]);
  const writes = { beforeSave: (_value: string): void => undefined };
  const storage: CaptureStorage = {
    load: async (key) => journal.get(key) ?? null,
    save: (key, value, previous) =>
      Effect.sync(() => {
        if ((journal.get(key) ?? "[]") !== previous) {
          throw new Error("Compare-and-set used an outdated journal value");
        }
        writes.beforeSave(value);
        journal.set(key, value);
      }).pipe(Effect.runPromise),
    lock: async (_key, run) => run(),
  };
  const start = () =>
    makeCaptureQueue({
      storage,
      key: async () => `01937c7a-0000-7000-8000-${Str.padStart(12, "0")(String(++nextKey))}`,
      read: (file) =>
        readReceipt(file, (ref) =>
          Effect.sync(() => {
            const captured = bytes.get(ref);
            if (captured === undefined) throw new Error("Missing file");
            return captured.slice();
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
      now: () => clock,
    });
  return {
    start,
    bytes,
    writes,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("expense capture replay", () => {
  test("restores exact bytes and stable keys after record and attachment responses are lost", async () => {
    const disk = fixture();
    const initial = disk.start();
    const { job } = await initial.stage(access, null, [first, second]);
    if (job === undefined) throw new Error("Missing staged job");
    expect(job.scope).toEqual(scope);
    const [one, two] = job.files;
    if (one === undefined || two === undefined) throw new Error("Missing receipts");
    expect(one.file.sha256).toBe(
      // biome-ignore lint/security/noSecrets: Known SHA-256 digest of the synthetic abc receipt.
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(one.file.size).toBe(3);
    expect(two.file.sha256).not.toBe(one.file.sha256);
    expect(one.key).not.toBe(two.key);
    disk.bytes.delete(first.ref);
    disk.bytes.delete(second.ref);

    const records = new Map<string, ExpenseId>();
    const attached = new Map<string, string>();
    const createKeys: string[] = [];
    const sentKeys: string[] = [];
    const network: CaptureNetwork = {
      record: async (operationScope, key, payload) => {
        expect(operationScope).toEqual(scope);
        const [persisted] = await disk.start().load(scope);
        expect(persisted?.submission?.payload).toEqual(payload);
        expect(payload).toEqual({
          status: "incomplete",
          total: "45.50",
          currency: "CZK",
          supplier: { manual: { name: "Supplier" } },
        });
        createKeys.push(key);
        if (records.has(key)) return done(expenseId);
        records.set(key, expenseId);
        return failed(UiError.timeout);
      },
      upload: async (request) => {
        const [persisted] = await disk.start().load(scope);
        expect(persisted?.expenseId).toBe(expenseId);
        const key = request.headers?.["idempotency-key"];
        if (key === undefined) throw new Error("Missing attachment key");
        sentKeys.push(key);
        expect(disk.bytes.get(request.file.ref)).toEqual(key === one.key ? a : b);
        expect(request.path).toBe(`/workspaces/${workspace.id}/expenses/${expenseId}/attachments`);
        if (attached.has(key)) return done({});
        attached.set(key, request.file.sha256);
        return key === two.key ? failed(UiError.offline) : done({});
      },
    };

    expect(
      (await initial.submit(access, network, job.key, fields, progress))?.submission?.failure?.kind,
    ).toBe("retry");
    const firstRestart = disk.start();
    await firstRestart.submit(
      access,
      network,
      job.key,
      { ...fields, note: "must stay frozen" },
      progress,
    );
    const [checkpoint] = await disk.start().load(scope);
    expect(Arr.map(checkpoint?.files ?? [], (file) => file.result?.kind)).toEqual([
      "uploaded",
      undefined,
    ]);

    const secondRestart = disk.start();
    expect((await secondRestart.drain(access, network)).completed).toEqual([]);
    disk.advance(5_000);
    expect(
      Arr.map((await secondRestart.drain(access, network)).completed, (item) => item.expenseId),
    ).toEqual([expenseId]);
    expect(createKeys).toEqual([job.key, job.key]);
    expect(sentKeys).toEqual([one.key, two.key, two.key]);
    expect(records.size).toBe(1);
    expect(attached.size).toBe(2);
    expect(await secondRestart.load(scope)).toEqual([]);
    expect(disk.bytes.size).toBe(0);
  });

  test("replays a committed create when persisting its response was interrupted", async () => {
    const disk = fixture();
    const queue = disk.start();
    const { job } = await queue.stage(access, null, [first]);
    if (job === undefined) throw new Error("Missing staged job");
    const requests: string[] = [];
    const network: CaptureNetwork = {
      record: (_scope, key) =>
        Effect.sync(() => {
          requests.push(key);
          return done(expenseId);
        }).pipe(Effect.runPromise),
      upload: async () => done({}),
    };
    disk.writes.beforeSave = (value) => {
      if (Str.includes(`"expenseId":"${expenseId}"`)(value)) throw new Error("Interrupted commit");
    };
    await expect(queue.submit(access, network, job.key, fields, progress)).rejects.toThrow(
      "Interrupted commit",
    );
    disk.writes.beforeSave = () => undefined;
    const result = await disk.start().drain(access, network);
    expect(result.completed[0]?.expenseId).toBe(expenseId);
    expect(requests).toEqual([job.key, job.key]);
  });

  test("pauses ambiguous creates after the server replay window, but allows a long offline draft", async () => {
    const disk = fixture();
    const queue = disk.start();
    const { job } = await queue.stage(access, null, [first]);
    if (job === undefined) throw new Error("Missing staged job");
    let connected = false;
    let calls = 0;
    const network: CaptureNetwork = {
      isOnline: async () => connected,
      record: () =>
        Effect.sync(() => {
          calls++;
          return failed(UiError.timeout);
        }).pipe(Effect.runPromise),
      upload: () =>
        Effect.sync(() => {
          throw new Error("No confirmed expense exists");
        }).pipe(Effect.runPromise),
    };
    const offline = await queue.submit(access, network, job.key, fields, progress);
    expect(offline?.recordAttemptAt).toBeUndefined();
    const day = 24 * 60 * 60 * 1000;
    disk.advance(day * 2);
    connected = true;
    await disk.start().drain(access, network, { reconnect: true });
    expect(calls).toBe(1);
    disk.advance(day);
    await disk.start().drain(access, network);
    const [stopped] = await disk.start().load(scope);
    expect(stopped?.submission?.failure?.kind).toBe("expired");
    await queue.submit(access, network, job.key, fields, progress);
    expect(calls).toBe(1);
    await queue.discard(access, job.key);
    expect(await queue.load(scope)).toEqual([]);
  });

  test("does not send a damaged stored file or create a second expense on retry", async () => {
    const disk = fixture();
    const queue = disk.start();
    const { job } = await queue.stage(access, expenseId, [first]);
    const receipt = job?.files[0];
    if (job === undefined || receipt === undefined) throw new Error("Missing staged receipt");
    disk.bytes.set(receipt.file.ref, b);
    const network: CaptureNetwork = {
      record: () =>
        Effect.sync(() => {
          throw new Error("Existing expenses cannot be created again");
        }).pipe(Effect.runPromise),
      upload: () =>
        Effect.sync(() => {
          throw new Error("Damaged file cannot be uploaded");
        }).pipe(Effect.runPromise),
    };
    const blocked = await queue.submit(access, network, job.key, fields, progress);
    expect(blocked?.expenseId).toBe(expenseId);
    expect(blocked?.submission?.failure?.kind).toBe("blocked");
    expect((await disk.start().load(scope))[0]?.files[0]?.file.sha256).toBe(receipt.file.sha256);
  });

  test("pins jobs to their principal and workspace and rechecks write access between requests", async () => {
    const disk = fixture();
    const queue = disk.start();
    const { job } = await queue.stage(access, null, [first]);
    if (job === undefined) throw new Error("Missing staged receipt");
    let allowed = true;
    const live = { scope, canWrite: () => allowed };
    const network: CaptureNetwork = {
      record: () =>
        Effect.sync(() => {
          allowed = false;
          return done(expenseId);
        }).pipe(Effect.runPromise),
      upload: () =>
        Effect.sync(() => {
          throw new Error("Revoked access cannot upload");
        }).pipe(Effect.runPromise),
    };
    await queue.submit(live, network, job.key, fields, progress);
    expect((await queue.load(scope))[0]?.expenseId).toBe(expenseId);
    expect(await queue.load({ ...scope, principalId: "different-account" })).toEqual([]);
    expect(
      await queue.load({
        ...scope,
        workspaceId: WorkspaceId.make("01937c7a-0000-7000-8000-000000000003"),
      }),
    ).toEqual([]);
    expect(await queue.submit(live, network, job.key, fields, progress)).toBeUndefined();
    expect((await queue.drain(live, network)).completed).toEqual([]);
    expect(mayCapture("account", workspace)).toBe(true);
    expect(mayCapture("account", { ...workspace, role: "accountant" })).toBe(false);
    expect(mayCapture("account", { ...workspace, closed: true })).toBe(false);
    expect(mayCapture(null, workspace)).toBe(false);
  });

  test("preserves rejected receipt filenames and issues across mixed job cleanup and restart", async () => {
    const disk = fixture();
    const queue = disk.start();
    const acceptedFile = { ...first, name: "valid-receipt.pdf" };
    const rejectedFile = { ...second, name: "spoofed-receipt.pdf" };
    const { job } = await queue.stage(access, null, [acceptedFile, rejectedFile]);
    if (job === undefined) throw new Error("Missing staged job");

    const mimeMismatch = Invalid.make({
      issues: [{ path: ["file"], code: "attachment.type_rejected" }],
    });
    const tooLarge = PayloadTooLarge.make({ limitBytes: 20 * 1024 * 1024 });

    const network: CaptureNetwork = {
      record: async () => done(expenseId),
      upload: async (request) =>
        request.file.name === rejectedFile.name ? failed(mimeMismatch) : done({}),
    };

    const completed = await queue.submit(access, network, job.key, fields, progress);
    expect(completed?.done).toBe(true);
    expect(await disk.start().load(scope)).toEqual([]);
    expect(Arr.filter([...disk.bytes.keys()], (key) => Str.startsWith("saved:")(key))).toEqual([]);

    const reopened = disk.start();
    const persisted = await reopened.loadRejected(scope, expenseId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.name).toBe("spoofed-receipt.pdf");
    expect(persisted[0]?.error._tag).toBe("Invalid");
    expect(await reopened.loadRejected({ ...scope, principalId: "other-user" }, expenseId)).toEqual(
      [],
    );

    // Additional rejection on the same expense appends without losing earlier ones.
    disk.bytes.set("cache:third", Uint8Array.of(1, 2, 3, 4));
    const secondStage = await reopened.stage(access, expenseId, [
      { ref: "cache:third", name: "huge-scan.pdf", contentType: "application/pdf", size: 4 },
    ]);
    if (secondStage.job === undefined) throw new Error("Missing second job");
    await reopened.submit(
      access,
      { record: async () => done(expenseId), upload: async () => failed(tooLarge) },
      secondStage.job.key,
      fields,
      progress,
    );

    const both = await disk.start().loadRejected(scope, expenseId);
    expect(Arr.map(both, (item) => item.name)).toEqual(["spoofed-receipt.pdf", "huge-scan.pdf"]);
    expect(both[1]?.error._tag).toBe("PayloadTooLarge");

    const firstKey = both[0]?.key;
    if (firstKey === undefined) throw new Error("Missing rejected key");
    await disk.start().dismissRejected(access, expenseId, firstKey);
    expect(Arr.map(await disk.start().loadRejected(scope, expenseId), (i) => i.name)).toEqual([
      "huge-scan.pdf",
    ]);

    await disk.start().clearRejected(access, expenseId);
    expect(await disk.start().loadRejected(scope, expenseId)).toEqual([]);
  });

  test("summarizes cross-workspace pending counts and blocked states", async () => {
    const disk = fixture();
    const queue = disk.start();
    const secondWorkspaceScope = {
      principalId: scope.principalId,
      workspaceId: WorkspaceId.make("01937c7a-0000-7000-8000-000000000099"),
      workspaceSlug: WorkspaceSlug.make("beta"),
    };
    const secondAccess: CaptureAccess = { scope: secondWorkspaceScope, canWrite: () => true };

    const firstStage = await queue.stage(access, null, [first]);
    const secondStage = await queue.stage(secondAccess, null, [second]);
    if (firstStage.job === undefined || secondStage.job === undefined)
      throw new Error("Missing staged jobs");

    expect(
      summarizeCaptureJobs([
        { jobs: await queue.load(scope), canWrite: true },
        { jobs: await queue.load(secondWorkspaceScope), canWrite: true },
      ]),
    ).toEqual({ pendingCount: 2, blockedCount: 0, hasBlocked: false });

    await queue.submit(
      secondAccess,
      {
        record: async () =>
          failed(Invalid.make({ issues: [{ path: ["total"], code: "expense.incomplete" }] })),
        upload: async () => done({}),
      },
      secondStage.job.key,
      fields,
      progress,
    );

    expect(
      summarizeCaptureJobs([
        { jobs: await queue.load(scope), canWrite: true },
        { jobs: await queue.load(secondWorkspaceScope), canWrite: true },
      ]),
    ).toEqual({ pendingCount: 2, blockedCount: 1, hasBlocked: true });
  });
});

describe("Android receipt-share intake", () => {
  test("acknowledges only after bytes and draft are saved, and dedupes re-delivery", async () => {
    const disk = fixture();
    const share = {
      uri: first.ref,
      filename: first.name,
      mimeType: first.contentType,
      sizeBytes: first.size,
    };
    let reads = 0;
    const list = () =>
      Effect.sync(() => {
        reads++;
        return [share];
      }).pipe(Effect.runPromise);
    let attempts = 0;
    const acknowledge = async (refs: readonly string[]) => {
      expect(refs).toEqual([share.uri]);
      const [persisted] = await disk.start().load(scope);
      const file = persisted?.files[0]?.file;
      expect(file?.size).toBe(a.byteLength);
      expect(file !== undefined && disk.bytes.get(file.ref)).toEqual(a);
      if (++attempts === 1) throw new Error("App stopped before acknowledgement");
    };
    expect(
      await importSharedReceipts({ ...access, canWrite: () => false }, disk.start(), {
        list,
        acknowledge,
      }),
    ).toBeNull();
    expect(reads).toBe(0);
    await expect(
      importSharedReceipts(access, disk.start(), { list, acknowledge }),
    ).rejects.toThrow();
    const imported = await importSharedReceipts(access, disk.start(), { list, acknowledge });
    expect(imported?.job?.files).toHaveLength(1);
    expect(attempts).toBe(2);
    expect(Arr.filter([...disk.bytes.keys()], (key) => Str.startsWith("saved:")(key))).toHaveLength(
      1,
    );
  });
});
