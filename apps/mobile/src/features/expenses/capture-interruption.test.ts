// biome-ignore-all lint/suspicious/noMisplacedAssertion: The replay helper asserts invariants at every injected failure boundary.
import { expect, test } from "bun:test";
import { ExpenseId, Invalid, WorkspaceSummary } from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import type { CaptureStorage } from "../../platform/capture/capture-storage-port";
import { done, failed } from "../../platform/transfer/http";
import {
  type CaptureAccess,
  type CaptureFields,
  type CaptureNetwork,
  makeCaptureQueue,
} from "./capture-queue";
import { readReceipt } from "./receipt-file";

const workspace = Schema.decodeEffect(WorkspaceSummary)({
  id: "01937c7a-0000-7000-8000-000000000001",
  slug: "acme",
  role: "member",
  closed: false,
  name: "Acme",
  memberCount: 1,
  taxRegime: "vat_payer",
}).pipe(Effect.runSync);
const access: CaptureAccess = {
  scope: { principalId: "member", workspaceId: workspace.id, workspaceSlug: workspace.slug },
  canWrite: () => true,
};
const fields: CaptureFields = { supplierName: "Acme", currency: "CZK", total: "45", note: "" };
const expenseId = ExpenseId.make("01937c7a-0000-7000-8000-000000000002");
const content = { a: Uint8Array.of(37, 80, 68, 70, 100), b: Uint8Array.of(37, 80, 68, 70, 200) };
const hash = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const noProgress = () => undefined;
const rejectedFile = Invalid.make({
  issues: [{ path: ["attachment"], code: "attachment.type_rejected" }],
});

class Interrupted extends Schema.TaggedError<Interrupted, { readonly brand: unique symbol }>()(
  "Interrupted",
  {
    checkpoint: Schema.optionalKey(Schema.String),
  },
) {}
const decodeScope = Fn.flow(
  Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String))),
  Effect.runSync,
);
const encodePayload = Fn.flow(
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown)),
  Effect.runSync,
);

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
  const tracing = MutableRef.make(false);
  const interrupted = MutableRef.make(false);
  const checkpoints: string[] = [];

  function checkpoint(label: string) {
    if (!MutableRef.get(tracing)) return;
    if (MutableRef.get(interrupted)) throw Interrupted.make();
    checkpoints.push(label);
    if (checkpoints.length === cut) {
      MutableRef.set(interrupted, true);
      throw Interrupted.make({ checkpoint: label });
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
    save: (scope, value, previous) =>
      Effect.sync(() => {
        const label = decodeScope(scope).length === 2 ? "job persist" : "rejection persist";
        boundary(label, () => {
          expect(journal.get(scope) ?? "[]").toBe(previous);
          journal.set(scope, value);
        });
      }).pipe(Effect.runPromise),
    lock: async (_scope, run) => run(),
  };
  const start = () =>
    makeCaptureQueue({
      storage,
      key: async () => `01937c7a-0000-7000-8000-${Str.padStart(12, "0")(String(++nextKey))}`,
      read: (file) =>
        readReceipt(file, (ref) =>
          Effect.sync(() => {
            const bytes = localBytes.get(ref);
            if (bytes === undefined) throw new Error("Missing staged receipt");
            return bytes.slice();
          }).pipe(Effect.runPromise),
        ),
      saveBytes: (key, _name, bytes) =>
        Effect.sync(() => {
          const ref = `staged:${key}`;
          localBytes.set(ref, bytes.slice());
          return ref;
        }).pipe(Effect.runPromise),
      removeBytes: (ref) =>
        Effect.sync(() => {
          boundary("file cleanup", () => localBytes.delete(ref));
        }).pipe(Effect.runPromise),
    });
  const network: CaptureNetwork = {
    record: async (_scope, key, input) =>
      boundary("create request", () => {
        const payload = encodePayload(input);
        const prior = expenseWrites.get(key);
        expect(prior ?? payload).toBe(payload);
        if (prior === undefined) expenseWrites.set(key, payload);
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
        expect(prior ?? sha).toBe(sha);
        if (prior === undefined) attachmentWrites.set(key, sha);
        return done(null);
      }),
  };

  const queue = start();
  const sources = Arr.map(receipts, (kind, index) => {
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

  MutableRef.set(tracing, true);
  if (cut === undefined) {
    await queue.submit(access, network, job.key, fields, noProgress);
  } else {
    // biome-ignore lint/suspicious/noConditionalExpect: The injected interruption rejects while the uninterrupted baseline fulfills.
    await expect(queue.submit(access, network, job.key, fields, noProgress)).rejects.toBeInstanceOf(
      Interrupted,
    );
    // biome-ignore lint/suspicious/noConditionalExpect: Only cut runs have a specified checkpoint.
    expect(checkpoints.length).toBe(cut);
    MutableRef.set(tracing, false);

    const restarted = start();
    const pending = Option.getOrUndefined(
      Arr.findFirst(await restarted.load(access.scope), (candidate) => candidate.key === job.key),
    );
    if (pending !== undefined && pending.submission === undefined) {
      await restarted.submit(access, network, job.key, fields, noProgress);
    }
    await restarted.drain(access, network, { reconnect: true, signedIn: true });
  }

  const reopened = start();
  expect(await reopened.load(access.scope)).toEqual([]);
  expect(expenseWrites.size).toBe(1);
  expect([...attachmentWrites.values()].sort(Order.String)).toEqual(
    [
      ...new Set(
        Arr.map(
          Arr.filter(receipts, (kind) => kind !== rejected),
          (kind) => hash(content[kind]),
        ),
      ),
    ].sort(Order.String),
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
  expect(Arr.filter([...localBytes.keys()], (ref) => Str.startsWith("staged:")(ref))).toEqual([]);
  return checkpoints;
}

test("restarting at each side of every receipt request and persist creates each distinct object once", () => {
  const cases = [["a"], ["a", "a", "b"], ["b", "a", "b"]] as const;
  return Effect.forEach(
    cases,
    Effect.fnUntraced(function* (receipts) {
      const checkpoints = yield* Effect.promise(() => exercise(receipts));
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
      yield* Effect.forEach(
        checkpoints.keys(),
        (index) => Effect.promise(() => exercise(receipts, index + 1)),
        { concurrency: 1, discard: true },
      );
    }),
    { concurrency: 1, discard: true },
  ).pipe(Effect.runPromise);
});

test("restarting at each mixed upload boundary preserves one rejection beside the accepted receipts", async () => {
  const receipts = ["a", "b", "a"] as const;
  const checkpoints = await exercise(receipts, undefined, "b");
  expect(checkpoints).toContain("before rejection persist");
  expect(checkpoints).toContain("after rejection persist");
  await Effect.forEach(
    checkpoints.keys(),
    (index) => Effect.promise(() => exercise(receipts, index + 1, "b")),
    { concurrency: 1, discard: true },
  ).pipe(Effect.runPromise);
});
