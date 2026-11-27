import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { type ExpenseId, Invalid, WorkspaceSummary } from "@kvitbit/domain/contract";
import { Schema } from "effect";
import type { CaptureStorage } from "../../platform/capture/capture-storage-port";
import { done, failed } from "../../platform/transfer/http";
import {
  type CaptureAccess,
  type CaptureFields,
  type CaptureNetwork,
  makeCaptureQueue,
} from "./capture-queue";
import { readReceipt } from "./receipt-file";

const workspace = Schema.decodeUnknownSync(WorkspaceSummary)({
  id: "01937c7a-0000-7000-8000-000000000001",
  slug: "acme",
  role: "member",
  closed: false,
  name: "Acme",
  memberCount: 1,
  taxRegime: "vat_payer",
});
const access: CaptureAccess = {
  scope: { principalId: "member", workspaceId: workspace.id, workspaceSlug: workspace.slug },
  canWrite: () => true,
};
const fields: CaptureFields = { supplierName: "Acme", currency: "CZK", total: "45", note: "" };
const expenseId = "01937c7a-0000-7000-8000-000000000002" as ExpenseId;
const content = { a: Uint8Array.of(37, 80, 68, 70, 100), b: Uint8Array.of(37, 80, 68, 70, 200) };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const noProgress = () => undefined;
const rejectedFile = new Invalid({
  issues: [{ path: ["attachment"], code: "attachment.type_rejected" }],
});

class Interrupted extends Error {}

async function exercise(
  receipts: readonly (keyof typeof content)[],
  cut?: number,
  rejected?: keyof typeof content,
) {
  const journal = new Map<string, string>();
  const localBytes = new Map<string, Uint8Array<ArrayBuffer>>();
  const expenseWrites = new Map<string, string>();
  const attachmentWrites = new Map<string, string>();
  let nextKey = 0;
  let tracing = false;
  let interrupted = false;
  const checkpoints: string[] = [];

  function checkpoint(label: string) {
    if (!tracing) return;
    if (interrupted) throw new Interrupted();
    checkpoints.push(label);
    if (checkpoints.length === cut) {
      interrupted = true;
      throw new Interrupted(label);
    }
  }

  function boundary<A>(label: string, work: () => A): A {
    checkpoint(`before ${label}`);
    const value = work();
    checkpoint(`after ${label}`);
    return value;
  }

  const storage: CaptureStorage = {
    load: async (scope) => journal.get(scope) ?? null,
    save: async (scope, value, previous) => {
      const label = JSON.parse(scope).length === 2 ? "job persist" : "rejection persist";
      boundary(label, () => {
        expect(journal.get(scope) ?? "[]").toBe(previous);
        journal.set(scope, value);
      });
    },
    lock: async (_scope, run) => run(),
  };
  const start = () =>
    makeCaptureQueue({
      storage,
      key: async () => `01937c7a-0000-7000-8000-${String(++nextKey).padStart(12, "0")}`,
      read: (file) =>
        readReceipt(file, async (ref) => {
          const bytes = localBytes.get(ref);
          if (!bytes) throw new Error("Missing staged receipt");
          return bytes.slice();
        }),
      saveBytes: async (key, _name, bytes) => {
        const ref = `staged:${key}`;
        localBytes.set(ref, bytes.slice());
        return ref;
      },
      removeBytes: async (ref) => {
        boundary("file cleanup", () => localBytes.delete(ref));
      },
    });
  const network: CaptureNetwork = {
    record: async (_scope, key, input) =>
      boundary("create request", () => {
        const payload = JSON.stringify(input);
        const prior = expenseWrites.get(key);
        if (prior === undefined) expenseWrites.set(key, payload);
        else expect(prior).toBe(payload);
        return done(expenseId);
      }),
    upload: async ({ headers, path, file }) =>
      boundary("upload request", () => {
        expect(path).toEndWith(`/expenses/${expenseId}/attachments`);
        const bytes = localBytes.get(file.ref);
        if (bytes === undefined) throw new Error("Missing bytes for upload");
        const sha = hash(bytes);
        expect(file.sha256).toBe(sha);
        if (rejected !== undefined && sha === hash(content[rejected])) return failed(rejectedFile);
        const key = headers?.["idempotency-key"];
        if (key === undefined) throw new Error("Missing upload key");
        const prior = attachmentWrites.get(key);
        if (prior === undefined) attachmentWrites.set(key, sha);
        else expect(prior).toBe(sha);
        return done(null);
      }),
  };

  const queue = start();
  const sources = receipts.map((kind, index) => {
    const bytes = content[kind];
    const ref = `source:${index}`;
    localBytes.set(ref, bytes);
    return {
      ref,
      name: `receipt-${index}.pdf`,
      contentType: "application/pdf",
      size: bytes.length,
    };
  });
  const { job } = await queue.stage(access, null, sources);
  if (job === undefined) throw new Error("No capture was staged");

  tracing = true;
  if (cut === undefined) {
    await queue.submit(access, network, job.key, fields, noProgress);
  } else {
    await expect(queue.submit(access, network, job.key, fields, noProgress)).rejects.toBeInstanceOf(
      Interrupted,
    );
    expect(checkpoints.length).toBe(cut);
    tracing = false;

    const restarted = start();
    const pending = (await restarted.load(access.scope)).find(
      (candidate) => candidate.key === job.key,
    );
    if (pending !== undefined && pending.submission === undefined) {
      await restarted.submit(access, network, job.key, fields, noProgress);
    }
    await restarted.drain(access, network, { reconnect: true, signedIn: true });
  }

  const reopened = start();
  expect(await reopened.load(access.scope)).toEqual([]);
  expect(expenseWrites.size).toBe(1);
  expect([...attachmentWrites.values()].sort()).toEqual(
    [
      ...new Set(receipts.filter((kind) => kind !== rejected).map((kind) => hash(content[kind]))),
    ].sort(),
  );
  const rejectedIndex = rejected === undefined ? -1 : receipts.indexOf(rejected);
  expect(await reopened.loadRejected(access.scope, expenseId)).toEqual(
    rejectedIndex === -1
      ? []
      : [
          expect.objectContaining({
            name: `receipt-${rejectedIndex}.pdf`,
            error: expect.objectContaining({ _tag: "Invalid", issues: rejectedFile.issues }),
          }),
        ],
  );
  expect([...localBytes.keys()].filter((ref) => ref.startsWith("staged:"))).toEqual([]);
  return checkpoints;
}

test("restarting at each side of every receipt request and persist creates each distinct object once", async () => {
  for (const receipts of [["a"], ["a", "a", "b"], ["b", "a", "b"]] as const) {
    const checkpoints = await exercise(receipts);
    expect(new Set(checkpoints)).toEqual(
      new Set([
        "before job persist",
        "after job persist",
        "before create request",
        "after create request",
        "before upload request",
        "after upload request",
        "before file cleanup",
        "after file cleanup",
      ]),
    );
    for (const index of checkpoints.keys()) await exercise(receipts, index + 1);
  }
});

test("restarting at each mixed upload boundary preserves one rejection beside the accepted receipts", async () => {
  const receipts = ["a", "b", "a"] as const;
  const checkpoints = await exercise(receipts, undefined, "b");
  expect(checkpoints).toContain("before rejection persist");
  expect(checkpoints).toContain("after rejection persist");
  for (const index of checkpoints.keys()) await exercise(receipts, index + 1, "b");
});
