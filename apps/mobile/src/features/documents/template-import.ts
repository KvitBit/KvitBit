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
import { Effect, Option, Schema } from "effect";
import type { ApiRunner } from "../../runtime/api-runtime";
import {
  acquireRequestKey,
  completeRequestKey,
  isRequestIntentExpired,
  requestIntentFailure,
  reuseRequestKey,
} from "../../runtime/request-intent";
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

const pendingSlot = (owner: string, templateId: TemplateId) =>
  `kvitbit.template-import.v1.${JSON.stringify([owner, templateId])}`;
const draftSlot = (owner: string, documentId: DocumentId) =>
  `kvitbit.template-draft.v1.${JSON.stringify([owner, documentId])}`;

const locks = new Map<string, Promise<void>>();
const locked = async <A>(slot: string, work: () => Promise<A>): Promise<A> => {
  if (typeof navigator !== "undefined" && typeof navigator.locks?.request === "function") {
    return navigator.locks.request(slot, work);
  }
  const task = (locks.get(slot) ?? Promise.resolve()).then(work);
  const done = task.then(
    () => undefined,
    () => undefined,
  );
  locks.set(slot, done);
  try {
    return await task;
  } finally {
    if (locks.get(slot) === done) locks.delete(slot);
  }
};

const readPending = async (slot: string): Promise<typeof Pending.Type | null> => {
  const text = await AsyncStorage.getItem(slot);
  return text === null ? null : Schema.decodeUnknownSync(Pending)(JSON.parse(text));
};

const resolveSeed = async (
  run: ApiRunner["run"],
  workspace: WorkspaceSummary,
  templateId: TemplateId,
): Promise<ApiResult<TemplateSeed>> => {
  const scope = { workspaceId: workspace.id };
  const template = await run((api) => api.templates.get({ params: { ...scope, templateId } }));
  if (template._tag === "Err") return template;
  const decoded = Schema.decodeUnknownOption(Source)(template.value.input);
  if (Option.isNone(decoded)) return err(UiError.unexpected());
  const source = decoded.value;
  const [contact, workspaceView, series] = await Promise.all([
    run((api) => api.contacts.get({ params: { ...scope, contactId: source.contact } })),
    run((api) => api.workspace.current({ params: scope })),
    run((api) => api.workspace.listSeries({ params: scope })),
  ]);
  if (contact._tag === "Err") return contact;
  if (workspaceView._tag === "Err") return workspaceView;
  if (series._tag === "Err") return series;
  const defaults = parseWorkspaceDefaults(workspaceView.value, workspace.taxRegime);
  const resolvedSeries =
    source.series ??
    contact.value.defaults.preferredSeriesByKind?.[source.kind] ??
    series.value.find((row) => row.kind === source.kind && row.isDefault)?.id;
  return ok({
    contact: source.contact,
    language: source.language ?? contact.value.defaults.language ?? defaults.language,
    ...(resolvedSeries === undefined ? {} : { series: resolvedSeries }),
    pricesIncludeVat: source.pricesIncludeVat ?? false,
    ...(source.bankAccount === undefined ? {} : { bankAccount: source.bankAccount }),
    ...(source.variableSymbol === undefined ? {} : { variableSymbol: source.variableSymbol }),
    ...(source.orderNumber === undefined ? {} : { orderNumber: source.orderNumber }),
    note: source.note ?? contact.value.defaults.defaultNote ?? defaults.note ?? "",
  });
};

const payloadFor = (patch: TemplateSeed) => ({ as: "draft" as const, patch });

export async function importTemplate(
  owner: string,
  workspace: WorkspaceSummary,
  templateId: TemplateId,
  run: ApiRunner["run"],
): Promise<ApiResult<typeof Draft.Type>> {
  const slot = pendingSlot(owner, templateId);
  try {
    return await locked(slot, async () => {
      let pending = await readPending(slot);
      if (pending?.document != null) return ok(pending.document);
      if (pending === null) {
        const resolved = await resolveSeed(run, workspace, templateId);
        if (resolved._tag === "Err") return resolved;
        const operation = `templates.use:${templateId}:${Effect.runSync(uuidV7)}`;
        const key = await acquireRequestKey(owner, operation, payloadFor(resolved.value));
        pending = { seed: resolved.value, key, operation, document: null };
        await AsyncStorage.setItem(slot, JSON.stringify(pending));
      } else {
        // A stored import may already have created its draft. Resend it only within the replay window.
        await reuseRequestKey(owner, pending.operation, payloadFor(pending.seed), pending.key);
      }
      const { seed, key, operation } = pending;
      const result = await run((api) =>
        api.templates.use({
          params: { workspaceId: workspace.id, templateId },
          headers: idempotencyHeaders(key),
          payload: payloadFor(seed),
        }),
      );
      if (result._tag === "Err") return result;
      const { id, revision } = result.value;
      await AsyncStorage.setItem(
        draftSlot(owner, id),
        JSON.stringify({ seed, revision, templateId }),
      );
      await AsyncStorage.setItem(slot, JSON.stringify({ ...pending, document: { id, revision } }));
      await completeRequestKey(owner, operation, key).catch(() => undefined);
      return ok({ id, revision });
    });
  } catch (error) {
    return err(requestIntentFailure(error));
  }
}

export async function discardExpiredTemplateImport(
  owner: string,
  templateId: TemplateId,
): Promise<void> {
  const slot = pendingSlot(owner, templateId);
  await locked(slot, async () => {
    const pending = await readPending(slot);
    if (pending === null || pending.document !== null) return;
    try {
      await reuseRequestKey(owner, pending.operation, payloadFor(pending.seed), pending.key);
    } catch (error) {
      if (!isRequestIntentExpired(requestIntentFailure(error))) throw error;
      await AsyncStorage.removeItem(slot);
      await completeRequestKey(owner, pending.operation, pending.key).catch(() => undefined);
    }
  });
}

const readStored = async (key: string): Promise<typeof StoredSeed.Type | null> => {
  const text = await AsyncStorage.getItem(key);
  return text === null ? null : Schema.decodeUnknownSync(StoredSeed)(JSON.parse(text));
};

// Keep acknowledged writes recoverable across editor remounts while local storage is unavailable.
const unsavedSnapshots = new Map<string, typeof StoredSeed.Type>();

async function saveSnapshot(key: string, snapshot: typeof StoredSeed.Type) {
  unsavedSnapshots.set(key, snapshot);
  await AsyncStorage.setItem(key, JSON.stringify(snapshot));
  unsavedSnapshots.delete(key);
}

export class ImportedDraftRevisionMismatch extends Error {}

// DocumentView does not carry the imported values, so this cache is their only record.
// It applies only at the revision it was recorded for: a newer revision came from a write
// this client did not record. Do not let the editor replace its unknown values with defaults.
export async function openImportedDraft(
  owner: string,
  documentId: DocumentId,
  revision: number,
): Promise<TemplateSeed | null> {
  const key = draftSlot(owner, documentId);
  const cached = await readStored(key);
  if (cached === null) return null;
  const slot = pendingSlot(owner, cached.templateId);
  return locked(slot, async () => {
    const pending = await readPending(slot);
    if (pending?.document?.id === documentId) await AsyncStorage.removeItem(slot);
    const latest = (await readStored(key)) ?? cached;
    const unsaved = unsavedSnapshots.get(key);
    if (unsaved?.revision === revision && latest.revision < revision) {
      await saveSnapshot(key, unsaved);
      return unsaved.seed;
    }
    if (unsaved !== undefined && latest.revision >= unsaved.revision) unsavedSnapshots.delete(key);
    if (latest.revision !== revision) throw new ImportedDraftRevisionMismatch();
    return latest.seed;
  });
}

// Mirrors the PATCH semantics: a field the patch omits keeps its stored value.
const seedAfterPatch = (seed: TemplateSeed, patch: DocumentPatch): TemplateSeed => ({
  ...seed,
  ...(patch.contact === undefined ? {} : { contact: patch.contact }),
  ...(patch.language === undefined ? {} : { language: patch.language }),
  ...(patch.series === undefined ? {} : { series: patch.series }),
  ...(patch.pricesIncludeVat === undefined ? {} : { pricesIncludeVat: patch.pricesIncludeVat }),
  ...(patch.bankAccount === undefined ? {} : { bankAccount: patch.bankAccount }),
  ...(patch.variableSymbol === undefined ? {} : { variableSymbol: patch.variableSymbol }),
  ...(patch.orderNumber === undefined ? {} : { orderNumber: patch.orderNumber }),
  ...(patch.note === undefined ? {} : { note: patch.note }),
});

/**
 * Carries the imported values forward after the server accepted a write made at
 * `baseRevision` and returned `revision`. Pass the applied patch, or null when the write
 * changed no imported field (issuing). The cache moves only when it was recorded at
 * `baseRevision`, so a write the client cannot account for still invalidates it.
 */
export async function recordImportedDraftWrite(
  owner: string,
  documentId: DocumentId,
  patch: DocumentPatch | null,
  baseRevision: number,
  revision: number,
): Promise<void> {
  const key = draftSlot(owner, documentId);
  const cached = await readStored(key);
  if (cached === null) return;
  await locked(pendingSlot(owner, cached.templateId), async () => {
    const latest = await readStored(key);
    if (latest === null) return;
    if (latest.revision === revision) {
      unsavedSnapshots.delete(key);
      return;
    }
    if (latest.revision !== baseRevision) throw new ImportedDraftRevisionMismatch();
    const seed = patch === null ? latest.seed : seedAfterPatch(latest.seed, patch);
    await saveSnapshot(key, { ...latest, seed, revision });
  });
}
