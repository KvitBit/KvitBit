import { lstat, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { GcsAccessToken, GcsAccessTokens } from "@kvitbit/adapters/blob";
import { type BlobKey, BlobUnavailable } from "@kvitbit/domain/ports";
import { Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, UrlParams } from "effect/http";
import { BlobWiringConfigSchema } from "./config";

/** Lists only old Expense attachment objects, including staged objects with no row yet. */
export class AttachmentInventory extends Context.Service<
  AttachmentInventory,
  { readonly olderThan: (cutoffMs: number) => Stream.Stream<BlobKey, BlobUnavailable> }
>()("kvitbit/server/AttachmentInventory") {}

const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const uuid = new RegExp(`^${uuidPattern}$`, "i");
const attachmentKey = new RegExp(
  `^workspaces/${uuidPattern}/expenses/${uuidPattern}/attachments/${uuidPattern}$`,
  "i",
);
const unavailable = (cause: unknown) => new BlobUnavailable({ cause });
const isMissing = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const stat = (path: string) =>
  lstat(path).catch((error: unknown) => {
    if (!isMissing(error)) throw error;
    return undefined;
  });

async function* entries(path: string) {
  const directory = await opendir(path).catch((error: unknown) => {
    if (!isMissing(error)) throw error;
    return undefined;
  });
  if (directory !== undefined) yield* directory;
}

async function* localObjects(rootPath: string, cutoffMs: number): AsyncIterable<BlobKey> {
  const root = await realpath(rootPath);
  const workspaces = join(root, "workspaces");
  if (!(await stat(workspaces))?.isDirectory()) return;
  for await (const workspace of entries(workspaces)) {
    if (!workspace.isDirectory() || !uuid.test(workspace.name)) continue;
    const expenses = join(workspaces, workspace.name, "expenses");
    if (!(await stat(expenses))?.isDirectory()) continue;

    for await (const expense of entries(expenses)) {
      if (!expense.isDirectory() || !uuid.test(expense.name)) continue;
      const attachments = join(expenses, expense.name, "attachments");
      if (!(await stat(attachments))?.isDirectory()) continue;

      for await (const entry of entries(attachments)) {
        if (!entry.isFile() || !uuid.test(entry.name)) continue;
        const stats = await stat(join(attachments, entry.name));
        if (stats?.isFile() && stats.mtimeMs < cutoffMs) {
          yield `workspaces/${workspace.name}/expenses/${expense.name}/attachments/${entry.name}` as BlobKey;
        }
      }
    }
  }
}

export const localAttachmentInventory = (root: string): Layer.Layer<AttachmentInventory> =>
  Layer.succeed(AttachmentInventory, {
    olderThan: (cutoffMs) => Stream.fromAsyncIterable(localObjects(root, cutoffMs), unavailable),
  });

const GcsAttachmentPage = Schema.Struct({
  items: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        timeCreated: Schema.String,
      }),
    ),
  ),
  nextPageToken: Schema.optional(Schema.String),
});

export const gcsAttachmentInventory = (bucket: string) =>
  Layer.effect(
    AttachmentInventory,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const tokens = yield* GcsAccessToken;
      const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o`;
      return AttachmentInventory.of({
        olderThan: (cutoffMs) =>
          Stream.paginate("", (pageToken) =>
            Effect.gen(function* () {
              const params = UrlParams.fromInput({
                prefix: "workspaces/",
                matchGlob: "workspaces/*/expenses/*/attachments/*",
                fields: "items(name,timeCreated),nextPageToken",
                ...(pageToken === "" ? {} : { pageToken }),
              });
              const request = HttpClientRequest.get(url).pipe(
                HttpClientRequest.setUrlParams(params),
              );
              const token = yield* tokens.get;
              let response = yield* client.execute(HttpClientRequest.bearerToken(request, token));
              if (response.status === 401) {
                yield* Effect.ignore(response.arrayBuffer);
                yield* tokens.invalidate(token);
                const freshToken = yield* tokens.get;
                response = yield* client.execute(
                  HttpClientRequest.bearerToken(request, freshToken),
                );
              }
              if (response.status < 200 || response.status >= 300) {
                yield* Effect.ignore(response.arrayBuffer);
                return yield* unavailable({
                  operation: "attachment inventory",
                  status: response.status,
                });
              }
              const page = yield* response.json.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(GcsAttachmentPage)),
              );
              const keys = (page.items ?? []).flatMap(({ name, timeCreated }) =>
                attachmentKey.test(name) && Date.parse(timeCreated) < cutoffMs
                  ? [name as BlobKey]
                  : [],
              );
              const next = page.nextPageToken;
              if (next && next === pageToken) {
                return yield* unavailable("GCS attachment inventory repeated a page token");
              }
              return [keys, next ? Option.some(next) : Option.none()] as const;
            }).pipe(Effect.timeout("30 seconds"), Effect.mapError(unavailable)),
          ),
      });
    }),
  );

export const AttachmentInventoryLive = Layer.unwrap(
  Effect.map(BlobWiringConfigSchema, (config) =>
    config.driver === "local"
      ? localAttachmentInventory(config.localDir)
      : gcsAttachmentInventory(Option.getOrElse(config.gcsBucket, () => "").trim()).pipe(
          Layer.provide(GcsAccessTokens.metadataServer),
          Layer.provide(FetchHttpClient.layer),
        ),
  ),
);
