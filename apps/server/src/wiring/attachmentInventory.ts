import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { GcsAccessToken, GcsAccessTokens } from "@kvitbit/adapters/blob";
import { BlobKey, BlobUnavailable } from "@kvitbit/domain/ports";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as UrlParams from "effect/http/UrlParams";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import { BlobWiringConfigSchema } from "./config";

/** Lists only old Expense attachment objects, including staged objects with no row yet. */
export class AttachmentInventory extends Context.Service<
  AttachmentInventory,
  { readonly olderThan: (cutoffMs: number) => Stream.Stream<BlobKey, BlobUnavailable> }
>()("@kvitbit/server/wiring/attachmentInventory") {}

const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const uuid = new RegExp(`^${uuidPattern}$`, "i");
const attachmentKey = new RegExp(
  `^workspaces/${uuidPattern}/expenses/${uuidPattern}/attachments/${uuidPattern}$`,
  "i",
);
const unavailable = (cause: BlobUnavailable["cause"]) => BlobUnavailable.make({ cause });

const decodeErrno = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }));
const isMissingCause = (cause: BlobUnavailable["cause"]): boolean =>
  Option.getOrUndefined(decodeErrno(cause))?.code === "ENOENT";
const isMissing = (error: PlatformError.PlatformError): boolean =>
  isMissingCause(error.reason.cause);

const statAttachment = (target: string) =>
  Effect.tryPromise({ try: () => Bun.file(target).stat(), catch: unavailable }).pipe(
    Effect.asSome,
    Effect.catchIf(
      (error) => isMissingCause(error.cause),
      () => Effect.succeedNone,
    ),
  );

export const localAttachmentInventory = (rootPath: string): Layer.Layer<AttachmentInventory> =>
  Layer.effect(
    AttachmentInventory,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const statIfPresent = (target: string) =>
        fs.lstat(target).pipe(
          Effect.asSome,
          Effect.catchIf(isMissing, () => Effect.succeedNone),
        );

      const readEntries = Effect.fn("AttachmentInventory.readEntries")(function* (
        directory: string,
        type: FileSystem.File.Type,
      ) {
        const stats = yield* statIfPresent(directory);
        if (Option.isNone(stats) || stats.value.type !== "Directory") return [];
        return yield* fs.readDirectoryEntries(directory).pipe(
          Effect.catchIf(isMissing, () =>
            Effect.succeed<ReadonlyArray<FileSystem.DirectoryEntry>>([]),
          ),
          Effect.map((contents) =>
            Arr.filter(contents, (entry) => entry.type === type && uuid.test(entry.name)),
          ),
        );
      });

      const entries = (directory: string, type: FileSystem.File.Type) =>
        Stream.fromIterableEffect(readEntries(directory, type));

      return AttachmentInventory.of({
        olderThan: (cutoffMs) =>
          Stream.fromEffect(fs.realPath(rootPath)).pipe(
            Stream.flatMap((root) => {
              const workspaces = path.join(root, "workspaces");
              return entries(workspaces, "Directory").pipe(
                Stream.flatMap((workspace) => {
                  const expenses = path.join(workspaces, workspace.name, "expenses");
                  return entries(expenses, "Directory").pipe(
                    Stream.flatMap((expense) => {
                      const attachments = path.join(expenses, expense.name, "attachments");
                      return entries(attachments, "File").pipe(
                        Stream.mapEffect(
                          Effect.fn("AttachmentInventory.checkFile")(function* (entry) {
                            const target = path.join(attachments, entry.name);
                            const file = yield* statIfPresent(target);
                            if (Option.isNone(file) || file.value.type !== "File")
                              return Option.none();

                            // Bun retains fractional mtime. Match the non-following stat to reject replacements.
                            const stats = yield* statAttachment(target);
                            if (
                              Option.isNone(stats) ||
                              !stats.value.isFile() ||
                              file.value.dev !== BigInt(stats.value.dev) ||
                              Option.getOrUndefined(file.value.ino) !== BigInt(stats.value.ino) ||
                              !(stats.value.mtimeMs < cutoffMs)
                            )
                              return Option.none();
                            return Option.some(
                              BlobKey.make(
                                `workspaces/${workspace.name}/expenses/${expense.name}/attachments/${entry.name}`,
                              ),
                            );
                          }),
                          { concurrency: 1 },
                        ),
                        Stream.filter(Option.isSome),
                        Stream.map((key) => key.value),
                      );
                    }),
                  );
                }),
              );
            }),
            Stream.mapError((error) =>
              error._tag === "BlobUnavailable" ? error : unavailable(error),
            ),
          ),
      });
    }),
  ).pipe(Layer.provide([BunFileSystem.layer, BunPath.layer]));

const GcsAttachmentPage = Schema.Struct({
  items: Schema.optional(
    Schema.Struct({ name: Schema.String, timeCreated: Schema.String }).pipe(Schema.Array),
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
          Stream.paginate(
            "",
            Effect.fn("AttachmentInventory.listPage")(
              function* (pageToken: string) {
                const params = UrlParams.fromInput({
                  prefix: "workspaces/",
                  matchGlob: "workspaces/*/expenses/*/attachments/*",
                  fields: "items(name,timeCreated),nextPageToken",
                  pageToken: pageToken === "" ? undefined : pageToken,
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
                const keys = Arr.flatMap(page.items ?? [], ({ name, timeCreated }) =>
                  attachmentKey.test(name) && Date.parse(timeCreated) < cutoffMs
                    ? [BlobKey.make(name)]
                    : [],
                );
                const next = page.nextPageToken ?? "";
                if (next !== "" && next === pageToken) {
                  return yield* unavailable("GCS attachment inventory repeated a page token");
                }
                return [keys, Option.liftPredicate(Str.isNonEmpty)(next)] as const;
              },
              Effect.timeout("30 seconds"),
              Effect.mapError(unavailable),
            ),
          ),
      });
    }),
  );

export const AttachmentInventoryLive = Layer.unwrap(
  Effect.map(BlobWiringConfigSchema, (config) =>
    config.driver === "local"
      ? localAttachmentInventory(config.localDir)
      : gcsAttachmentInventory(
          config.gcsBucket.pipe(
            Option.getOrElse(() => ""),
            Str.trim,
          ),
        ).pipe(Layer.provide(GcsAccessTokens.metadataServer), Layer.provide(FetchHttpClient.layer)),
  ),
);
