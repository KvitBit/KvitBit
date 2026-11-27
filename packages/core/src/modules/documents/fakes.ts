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
import { CurrentCaller, NotFound } from "@kvitbit/domain/contract";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
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
>()("@kvitbit/core/modules/documents/fakes/DocumentFixtures") {}

/** Fake renderer output: a recognisable byte string naming the document and options. */
export const fakePdfBytes: {
  (options: RenderOptions): (view: DocumentView) => Uint8Array;
  (view: DocumentView, options: RenderOptions): Uint8Array;
} = Fn.dual(
  2,
  (view: DocumentView, options: RenderOptions): Uint8Array =>
    new TextEncoder().encode(
      `%PDF-fake ${view.id} r${view.revision} ${options.template} ${options.language}`,
    ),
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
      putContact: Effect.fn("DocumentFixtures.putContact")((workspaceId, contact) =>
        Ref.update(contacts, (all) =>
          new Map(all).set(key(workspaceId, contact.party.contactId), contact),
        ),
      ),
      putItem: Effect.fn("DocumentFixtures.putItem")((workspaceId, item) =>
        Ref.update(items, (all) => new Map(all).set(key(workspaceId, item.id), item)),
      ),
      putIssuer: Effect.fn("DocumentFixtures.putIssuer")((issuer) =>
        Ref.update(issuers, (all) => new Map(all).set(issuer.party.workspaceId, issuer)),
      ),
    });
  }),
);

const renderer = Layer.effect(
  DocumentRenderer,
  Effect.map(DocumentFixtures, (f) =>
    DocumentRenderer.of({
      render: Effect.fn("DocumentRenderer.render")((view, options) =>
        Effect.as(
          Ref.update(f.renders, (all) => [...all, { view, options }]),
          fakePdfBytes(view, options),
        ),
      ),
    }),
  ),
);

const ports = Layer.mergeAll(
  Layer.effect(
    DocumentContacts,
    Effect.map(DocumentFixtures, (f) =>
      DocumentContacts.of({
        forDocument: Effect.fn("DocumentContacts.forDocument")(
          (workspaceId: WorkspaceId, id: ContactId) =>
            Effect.flatMap(Ref.get(f.contacts), (all) => {
              const found = all.get(key(workspaceId, id));
              return found !== undefined
                ? Effect.succeed(found)
                : Effect.fail(NotFound.make({ entity: "Contact", id }));
            }),
        ),
      }),
    ),
  ),
  Layer.effect(
    DocumentPriceList,
    Effect.map(DocumentFixtures, (f) =>
      DocumentPriceList.of({
        forLine: Effect.fn("DocumentPriceList.forLine")(
          (workspaceId: WorkspaceId, id: PriceListItemId) =>
            Effect.flatMap(Ref.get(f.items), (all) => {
              const found = all.get(key(workspaceId, id));
              return found !== undefined
                ? Effect.succeed(found)
                : Effect.fail(NotFound.make({ entity: "PriceListItem", id }));
            }),
        ),
      }),
    ),
  ),
  Layer.effect(
    DocumentIssuers,
    Effect.map(DocumentFixtures, (f) =>
      DocumentIssuers.of({
        // As agreed in #418: only the current Member/System caller's Workspace is visible.
        forDocument: Effect.fn("DocumentIssuers.forDocument")(function* (workspaceId: WorkspaceId) {
          const caller = yield* CurrentCaller;
          const found = (yield* Ref.get(f.issuers)).get(workspaceId);
          const own =
            (caller._tag === "Member" || caller._tag === "System") &&
            caller.workspaceId === workspaceId;
          return found !== undefined && own
            ? found
            : yield* NotFound.make({ entity: "Workspace", id: workspaceId });
        }),
      }),
    ),
  ),
  renderer,
);

/** All four fakes plus their `DocumentFixtures` control, empty. */
export const DocumentFakesLive: Layer.Layer<
  DocumentFixtures | DocumentContacts | DocumentPriceList | DocumentIssuers | DocumentRenderer
> = ports.pipe(Layer.provideMerge(fixtures));

/** Only the recording renderer (renders in `DocumentFixtures.renders`), for compositions that bind the read ports for real. */
export const DocumentRendererFake: Layer.Layer<DocumentFixtures | DocumentRenderer> = renderer.pipe(
  Layer.provideMerge(fixtures),
);
