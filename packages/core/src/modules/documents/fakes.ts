/**
 * In-memory fakes of the Documents read ports and renderer, seeded through `DocumentFixtures`
 * (tests and stage-2 clones). Records are keyed by Workspace, so another Workspace's id is
 * `NotFound` exactly as the real ports behave.
 */
import type {
  ContactId,
  DocumentView,
  PriceListItemId,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { NotFound } from "@kvitbit/domain/contract";
import { Context, Effect, Layer, Ref } from "effect";
import type {
  ContactForDocument,
  IssuerForDocument,
  PriceListItemForLine,
  RenderOptions,
} from "./ports";
import { DocumentContacts, DocumentIssuers, DocumentPriceList, DocumentRenderer } from "./ports";

const key = (workspaceId: WorkspaceId, id: string) => `${workspaceId}/${id}`;

export interface RenderCall {
  readonly view: DocumentView;
  readonly options: RenderOptions;
}

export class DocumentFixtures extends Context.Service<
  DocumentFixtures,
  {
    readonly contacts: Ref.Ref<ReadonlyMap<string, ContactForDocument>>;
    readonly items: Ref.Ref<ReadonlyMap<string, PriceListItemForLine>>;
    readonly issuers: Ref.Ref<ReadonlyMap<WorkspaceId, IssuerForDocument>>;
    /** Every render, in order. */
    readonly renders: Ref.Ref<ReadonlyArray<RenderCall>>;
    readonly putContact: (
      workspaceId: WorkspaceId,
      contact: ContactForDocument,
    ) => Effect.Effect<void>;
    readonly putItem: (workspaceId: WorkspaceId, item: PriceListItemForLine) => Effect.Effect<void>;
    readonly putIssuer: (issuer: IssuerForDocument) => Effect.Effect<void>;
  }
>()("kvitbit/core/documents/testing/DocumentFixtures") {}

/** Fake renderer output: a recognisable byte string naming the document and options. */
export const fakePdfBytes = (view: DocumentView, options: RenderOptions): Uint8Array =>
  new TextEncoder().encode(
    `%PDF-fake ${view.id} r${view.revision} ${options.template} ${options.language}`,
  );

const fixtures = Layer.effect(
  DocumentFixtures,
  Effect.gen(function* () {
    const contacts = yield* Ref.make<ReadonlyMap<string, ContactForDocument>>(new Map());
    const items = yield* Ref.make<ReadonlyMap<string, PriceListItemForLine>>(new Map());
    const issuers = yield* Ref.make<ReadonlyMap<WorkspaceId, IssuerForDocument>>(new Map());
    const renders = yield* Ref.make<ReadonlyArray<RenderCall>>([]);
    return DocumentFixtures.of({
      contacts,
      items,
      issuers,
      renders,
      putContact: (workspaceId, contact) =>
        Ref.update(contacts, (all) =>
          new Map(all).set(key(workspaceId, contact.party.contactId), contact),
        ),
      putItem: (workspaceId, item) =>
        Ref.update(items, (all) => new Map(all).set(key(workspaceId, item.id), item)),
      putIssuer: (issuer) =>
        Ref.update(issuers, (all) => new Map(all).set(issuer.party.workspaceId, issuer)),
    });
  }),
);

const ports = Layer.mergeAll(
  Layer.effect(
    DocumentContacts,
    Effect.map(DocumentFixtures, (f) =>
      DocumentContacts.of({
        forDocument: (workspaceId: WorkspaceId, id: ContactId) =>
          Effect.flatMap(Ref.get(f.contacts), (all) => {
            const found = all.get(key(workspaceId, id));
            return found
              ? Effect.succeed(found)
              : Effect.fail(new NotFound({ entity: "Contact", id }));
          }),
      }),
    ),
  ),
  Layer.effect(
    DocumentPriceList,
    Effect.map(DocumentFixtures, (f) =>
      DocumentPriceList.of({
        forLine: (workspaceId: WorkspaceId, id: PriceListItemId) =>
          Effect.flatMap(Ref.get(f.items), (all) => {
            const found = all.get(key(workspaceId, id));
            return found
              ? Effect.succeed(found)
              : Effect.fail(new NotFound({ entity: "PriceListItem", id }));
          }),
      }),
    ),
  ),
  Layer.effect(
    DocumentIssuers,
    Effect.map(DocumentFixtures, (f) =>
      DocumentIssuers.of({
        forDocument: (workspaceId: WorkspaceId) =>
          Effect.flatMap(Ref.get(f.issuers), (all) => {
            const found = all.get(workspaceId);
            return found
              ? Effect.succeed(found)
              : Effect.fail(new NotFound({ entity: "Workspace", id: workspaceId }));
          }),
      }),
    ),
  ),
  Layer.effect(
    DocumentRenderer,
    Effect.map(DocumentFixtures, (f) =>
      DocumentRenderer.of({
        render: (view, options) =>
          Effect.as(
            Ref.update(f.renders, (all) => [...all, { view, options }]),
            fakePdfBytes(view, options),
          ),
      }),
    ),
  ),
);

/** All four fakes plus their `DocumentFixtures` control, empty. */
export const DocumentFakesLive: Layer.Layer<
  DocumentFixtures | DocumentContacts | DocumentPriceList | DocumentIssuers | DocumentRenderer
> = ports.pipe(Layer.provideMerge(fixtures));
