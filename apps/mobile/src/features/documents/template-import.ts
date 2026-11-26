import {
  ContactId,
  DocumentId,
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
import { acquireRequestKey, completeRequestKey } from "../../runtime/request-intent";
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
  } catch {
    return err(UiError.unexpected());
  }
}

export async function openImportedDraft(
  owner: string,
  documentId: DocumentId,
  revision: number,
): Promise<TemplateSeed | null> {
  const key = draftSlot(owner, documentId);
  const text = await AsyncStorage.getItem(key);
  if (text === null) return null;
  const cached = Schema.decodeUnknownSync(StoredSeed)(JSON.parse(text));
  const slot = pendingSlot(owner, cached.templateId);
  return locked(slot, async () => {
    const pending = await readPending(slot);
    if (pending?.document?.id === documentId) await AsyncStorage.removeItem(slot);
    if (cached.revision === revision) return cached.seed;
    await AsyncStorage.removeItem(key);
    return null;
  });
}
