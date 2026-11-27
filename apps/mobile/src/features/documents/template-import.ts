import {
  ContactId,
  DocumentId,
  type DocumentPatch,
  Locale,
  RequestKey,
  TemplateId,
  TemplateInput,
  type WorkspaceSummary,
} from "@kvitbit/domain/contract";
import { type ApiResult, err, idempotencyHeaders, ok, UiError, uuidV7 } from "@kvitbit/ui-port/api";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Types from "effect/Types";
import type { ApiRunner } from "../../runtime/api-runtime";
import {
  acquireRequestKey,
  completeRequestKey,
  fromMobilePromise,
  isRequestIntentExpired,
  requestIntentFailure,
  reuseRequestKey,
} from "../../runtime/request-intent";
import { runFeatureEffect } from "../ui-effect";
import { parseWorkspaceDefaults } from "./codecs";

const fields = TemplateInput.fields;
const Source = Schema.Struct({
  contact: ContactId,
  kind: fields.kind,
  language: fields.language,
  series: fields.series,
  pricesIncludeVat: fields.pricesIncludeVat,
  bankAccount: fields.bankAccount,
  variableSymbol: fields.variableSymbol,
  orderNumber: fields.orderNumber,
  note: fields.note,
});
const Seed = Schema.Struct({
  contact: ContactId,
  language: Locale,
  series: fields.series,
  pricesIncludeVat: Schema.Boolean,
  bankAccount: fields.bankAccount,
  variableSymbol: fields.variableSymbol,
  orderNumber: fields.orderNumber,
  note: Schema.String,
});
export type TemplateSeed = typeof Seed.Type;

const Draft = Schema.Struct({ id: DocumentId, revision: Schema.Int });
const Pending = Schema.Struct({
  seed: Seed,
  operation: Schema.String,
  key: RequestKey,
  document: Schema.NullOr(Draft),
});
const StoredSeed = Schema.Struct({ seed: Seed, revision: Schema.Int, templateId: TemplateId });

const encodeSlot = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
);
const PendingJson = Schema.fromJsonString(Pending);
const StoredSeedJson = Schema.fromJsonString(StoredSeed);
const decodePending = Schema.decodeEffect(PendingJson);
const encodePending = Schema.encodeEffect(PendingJson);
const decodeStored = Schema.decodeEffect(StoredSeedJson);
const encodeStored = Schema.encodeEffect(StoredSeedJson);

const pendingSlot = (owner: string, templateId: TemplateId) =>
  Effect.map(encodeSlot([owner, templateId]), (slot) => `kvitbit.template-import.v1.${slot}`);
const draftSlot = (owner: string, documentId: DocumentId) =>
  Effect.map(encodeSlot([owner, documentId]), (slot) => `kvitbit.template-draft.v1.${slot}`);

const locks = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>();
const locked = <A, E>(slot: string, work: Effect.Effect<A, E>) => {
  const webLocks = globalThis.navigator?.locks;
  if (webLocks?.request !== undefined) {
    return fromMobilePromise(() =>
      webLocks.request(slot, () => work.pipe(Effect.exit, runFeatureEffect)),
    ).pipe(
      Effect.flatMap((exit) =>
        Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause),
      ),
    );
  }
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const lock = locks.get(slot) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
      lock.users += 1;
      locks.set(slot, lock);
      return lock;
    }),
    (lock) => lock.semaphore.withPermits(1)(work),
    (lock) =>
      Effect.sync(() => {
        lock.users -= 1;
        if (lock.users === 0) locks.delete(slot);
      }),
  );
};

const readPending = Effect.fn("TemplateImport.readPending")(function* (slot: string) {
  const text = yield* fromMobilePromise(() => AsyncStorage.getItem(slot));
  return text === null ? null : yield* decodePending(text);
});

const resolveSeed = Effect.fn("TemplateImport.resolveSeed")(function* (
  run: ApiRunner["run"],
  workspace: WorkspaceSummary,
  templateId: TemplateId,
): Effect.fn.Return<ApiResult<TemplateSeed>, Effect.Error<ReturnType<typeof fromMobilePromise>>> {
  const scope = { workspaceId: workspace.id };
  const template = yield* fromMobilePromise(() =>
    run((api) => api.templates.get({ params: { ...scope, templateId } })),
  );
  if (template._tag === "Err") return template;
  const decoded = Schema.decodeUnknownOption(Source)(template.value.input);
  if (Option.isNone(decoded)) return err(UiError.unexpected());
  const source = decoded.value;
  const [contact, workspaceView, series] = yield* Effect.all(
    [
      fromMobilePromise(() =>
        run((api) => api.contacts.get({ params: { ...scope, contactId: source.contact } })),
      ),
      fromMobilePromise(() => run((api) => api.workspace.current({ params: scope }))),
      fromMobilePromise(() => run((api) => api.workspace.listSeries({ params: scope }))),
    ],
    { concurrency: "unbounded" },
  );
  if (contact._tag === "Err") return contact;
  if (workspaceView._tag === "Err") return workspaceView;
  if (series._tag === "Err") return series;
  const defaults = parseWorkspaceDefaults(workspaceView.value, workspace.taxRegime);
  const resolvedSeries =
    source.series ??
    contact.value.defaults.preferredSeriesByKind?.[source.kind] ??
    Option.getOrUndefined(
      Arr.findFirst(series.value, (row) => row.kind === source.kind && row.isDefault),
    )?.id;
  const seed: Types.Mutable<TemplateSeed> = {
    contact: source.contact,
    language: source.language ?? contact.value.defaults.language ?? defaults.language,
    pricesIncludeVat: source.pricesIncludeVat ?? false,
    note: source.note ?? contact.value.defaults.defaultNote ?? defaults.note ?? "",
  };
  if (resolvedSeries !== undefined) seed.series = resolvedSeries;
  if (source.bankAccount !== undefined) seed.bankAccount = source.bankAccount;
  if (source.variableSymbol !== undefined) seed.variableSymbol = source.variableSymbol;
  if (source.orderNumber !== undefined) seed.orderNumber = source.orderNumber;
  return ok(seed);
});

const payloadFor = (patch: TemplateSeed) => ({ as: "draft" as const, patch });

export const importTemplate = Effect.fn("TemplateImport.import")(
  function* (
    owner: string,
    workspace: WorkspaceSummary,
    templateId: TemplateId,
    run: ApiRunner["run"],
  ) {
    const slot = yield* pendingSlot(owner, templateId);
    return yield* locked(
      slot,
      Effect.gen(function* () {
        let pending = yield* readPending(slot);
        if (pending !== null && pending.document !== null) return ok(pending.document);
        if (pending === null) {
          const resolved = yield* resolveSeed(run, workspace, templateId);
          if (resolved._tag === "Err") return resolved;
          const requestId = yield* uuidV7;
          const operation = `templates.use:${templateId}:${requestId}`;
          const key = yield* fromMobilePromise(() =>
            acquireRequestKey(owner, operation, payloadFor(resolved.value)),
          );
          pending = { seed: resolved.value, key, operation, document: null };
          const serialized = yield* encodePending(pending);
          yield* fromMobilePromise(() => AsyncStorage.setItem(slot, serialized));
        } else {
          // A stored import may already have created its draft. Retry only within the replay window.
          const { operation, seed, key } = pending;
          yield* fromMobilePromise(() => reuseRequestKey(owner, operation, payloadFor(seed), key));
        }
        const { seed, key, operation } = pending;
        const result = yield* fromMobilePromise(() =>
          run((api) =>
            api.templates.use({
              params: { workspaceId: workspace.id, templateId },
              headers: idempotencyHeaders(key),
              payload: payloadFor(seed),
            }),
          ),
        );
        if (result._tag === "Err") return result;
        const { id, revision } = result.value;
        const snapshotSlot = yield* draftSlot(owner, id);
        const snapshot = yield* encodeStored({ seed, revision, templateId });
        yield* fromMobilePromise(() => AsyncStorage.setItem(snapshotSlot, snapshot));
        const completed = yield* encodePending({ ...pending, document: { id, revision } });
        yield* fromMobilePromise(() => AsyncStorage.setItem(slot, completed));
        yield* Effect.ignore(fromMobilePromise(() => completeRequestKey(owner, operation, key)));
        return ok({ id, revision });
      }),
    );
  },
  Effect.catchTags({
    MobileBridgeError: (error) => Effect.succeed(err(requestIntentFailure(error.cause))),
    SchemaError: () => Effect.succeed(err(UiError.offline)),
  }),
);

export const discardExpiredTemplateImport = Effect.fn("TemplateImport.discardExpired")(function* (
  owner: string,
  templateId: TemplateId,
) {
  const slot = yield* pendingSlot(owner, templateId);
  yield* locked(
    slot,
    Effect.gen(function* () {
      const pending = yield* readPending(slot);
      if (pending === null || pending.document !== null) return;
      yield* fromMobilePromise(() =>
        reuseRequestKey(owner, pending.operation, payloadFor(pending.seed), pending.key),
      ).pipe(
        Effect.asVoid,
        Effect.catchIf(
          (error) => isRequestIntentExpired(requestIntentFailure(error.cause)),
          () =>
            fromMobilePromise(() => AsyncStorage.removeItem(slot)).pipe(
              Effect.andThen(
                Effect.ignore(
                  fromMobilePromise(() =>
                    completeRequestKey(owner, pending.operation, pending.key),
                  ),
                ),
              ),
            ),
        ),
      );
    }),
  );
});

const readStored = Effect.fn("TemplateImport.readStored")(function* (key: string) {
  const text = yield* fromMobilePromise(() => AsyncStorage.getItem(key));
  return text === null ? null : yield* decodeStored(text);
});

// Keep acknowledged writes recoverable across editor remounts while local storage is unavailable.
const unsavedSnapshots = new Map<string, typeof StoredSeed.Type>();

const saveSnapshot = Effect.fn("TemplateImport.saveSnapshot")(function* (
  key: string,
  snapshot: typeof StoredSeed.Type,
) {
  unsavedSnapshots.set(key, snapshot);
  const serialized = yield* encodeStored(snapshot);
  yield* fromMobilePromise(() => AsyncStorage.setItem(key, serialized));
  unsavedSnapshots.delete(key);
});

class StaleImportedDraft extends Schema.TaggedError<
  StaleImportedDraft,
  { readonly brand: unique symbol }
>()("StaleImportedDraft", {}) {}

// DocumentView does not carry the imported values, so this cache is their only record.
// It applies only at the revision it was recorded for: a newer revision came from a write
// this client did not record. Do not let the editor replace its unknown values with defaults.
export const openImportedDraft = Effect.fn("TemplateImport.openDraft")(function* (
  owner: string,
  documentId: DocumentId,
  revision: number,
) {
  const key = yield* draftSlot(owner, documentId);
  const cached = yield* readStored(key);
  if (cached === null) return null;
  const slot = yield* pendingSlot(owner, cached.templateId);
  return yield* locked(
    slot,
    Effect.gen(function* () {
      const pending = yield* readPending(slot);
      if (pending?.document?.id === documentId)
        yield* fromMobilePromise(() => AsyncStorage.removeItem(slot));
      const latest = (yield* readStored(key)) ?? cached;
      const unsaved = unsavedSnapshots.get(key);
      if (unsaved?.revision === revision && latest.revision < revision) {
        yield* saveSnapshot(key, unsaved);
        return unsaved.seed;
      }
      if (unsaved !== undefined && latest.revision >= unsaved.revision)
        unsavedSnapshots.delete(key);
      if (latest.revision !== revision) return yield* StaleImportedDraft.make();
      return latest.seed;
    }),
  );
});

// Mirrors the PATCH semantics: a field the patch omits keeps its stored value.
const seedAfterPatch = (seed: TemplateSeed, patch: DocumentPatch): TemplateSeed => {
  const updated = { ...seed };
  if (patch.contact !== undefined) updated.contact = patch.contact;
  if (patch.language !== undefined) updated.language = patch.language;
  if (patch.series !== undefined) updated.series = patch.series;
  if (patch.pricesIncludeVat !== undefined) updated.pricesIncludeVat = patch.pricesIncludeVat;
  if (patch.bankAccount !== undefined) updated.bankAccount = patch.bankAccount;
  if (patch.variableSymbol !== undefined) updated.variableSymbol = patch.variableSymbol;
  if (patch.orderNumber !== undefined) updated.orderNumber = patch.orderNumber;
  if (patch.note !== undefined) updated.note = patch.note;
  return updated;
};

/**
 * Carries the imported values forward after the server accepted a write made at
 * `baseRevision` and returned `revision`. Pass the applied patch, or null when the write
 * changed no imported field (issuing). The cache moves only when it was recorded at
 * `baseRevision`, so a write the client cannot account for still invalidates it.
 */
export const recordImportedDraftWrite = Effect.fn("TemplateImport.recordWrite")(function* (
  owner: string,
  documentId: DocumentId,
  patch: DocumentPatch | null,
  baseRevision: number,
  revision: number,
) {
  const key = yield* draftSlot(owner, documentId);
  const cached = yield* readStored(key);
  if (cached === null) return;
  const slot = yield* pendingSlot(owner, cached.templateId);
  yield* locked(
    slot,
    Effect.gen(function* () {
      const latest = yield* readStored(key);
      if (latest === null) return;
      if (latest.revision === revision) {
        unsavedSnapshots.delete(key);
        return;
      }
      if (latest.revision !== baseRevision) return yield* StaleImportedDraft.make();
      const seed = patch === null ? latest.seed : seedAfterPatch(latest.seed, patch);
      yield* saveSnapshot(key, { ...latest, seed, revision });
    }),
  );
});
