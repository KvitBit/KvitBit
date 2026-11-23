/**
 * Test fixtures for the recurring module: a stub of the domain `Documents` tag whose rows live
 * in `MemoryTables`, so its writes commit and roll back with the caller's transaction (as the
 * real module's do), plus scenario runners over real layers.
 */
import type {
  Caller,
  ContactId,
  CoreError,
  DeliveryId,
  DocumentId,
  DocumentInput,
  DocumentView,
  IsoDate,
  ScheduleId,
  TemplateInput,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { CurrentCaller, Documents, NotFound } from "@kvitbit/domain/contract";
import { BigDecimal, Cause, Context, Effect, Exit, Layer, Ref, Schema } from "effect";
import { RecurringTestLayer } from "../../../src/modules/recurring";
import { authorize } from "../../../src/policy/Policy";
import type { IdGenerator } from "../../../src/shared/ids";
import { newId } from "../../../src/shared/ids";
import { CoreStore } from "../../../src/store/CoreStore";
import type { Row } from "../../../src/store/tables";
import { defineCollection, MemoryTables } from "../../../src/store/tables";
import { runTest, system } from "../../helpers";

export const CONTACT = "01900000-0000-7000-8000-0000000c0a01" as ContactId;
/** Documents.issue fails with NotFound{Contact} for this contact. */
export const MISSING_CONTACT = "01900000-0000-7000-8000-00000000dead" as ContactId;

export const templateInput = (overrides: Partial<TemplateInput> = {}): TemplateInput => ({
  name: "Monthly hosting",
  kind: "invoice",
  contact: CONTACT,
  lines: [
    {
      description: "Hosting",
      quantity: BigDecimal.fromStringUnsafe("1"),
      unitPrice: BigDecimal.fromStringUnsafe("1250.50"),
    },
  ],
  due: { inDays: 14 },
  ...overrides,
});

interface StubDocument extends Row {
  readonly id: DocumentId;
  readonly status: "draft" | "issued";
  readonly kind: string;
  readonly number: string | null;
  readonly issuedOn: IsoDate | null;
  readonly input: DocumentInput;
  /** Who issued it: "Member", or "System:<job tag>". */
  readonly actor: string;
}

interface StubDelivery extends Row {
  readonly id: DeliveryId;
  readonly documentId: DocumentId;
}

const StubDocuments = defineCollection<StubDocument>({
  name: "stub_documents",
  entity: "Document",
  schema: Schema.Unknown as unknown as Schema.Codec<StubDocument, unknown>,
});
const StubDeliveries = defineCollection<StubDelivery>({
  name: "stub_deliveries",
  entity: "Document",
  schema: Schema.Unknown as unknown as Schema.Codec<StubDelivery, unknown>,
});

/** Controls and observations of the Documents stub. */
export class DocumentsStub extends Context.Service<
  DocumentsStub,
  {
    readonly documents: (ws: WorkspaceId) => Effect.Effect<ReadonlyArray<StubDocument>, unknown>;
    readonly deliveries: (ws: WorkspaceId) => Effect.Effect<ReadonlyArray<StubDelivery>, unknown>;
    /** Calls that reached the stub, including ones whose transaction rolled back. */
    readonly attempts: Ref.Ref<{ readonly issue: number; readonly send: number }>;
    /** The next issue fails with this error (once). */
    readonly failNextIssue: Ref.Ref<CoreError | null>;
    /** The next send fails with this error (once). */
    readonly failNextSend: Ref.Ref<CoreError | null>;
    /** The next send dies after queueing its delivery: a crash inside the send step. */
    readonly crashNextSend: Ref.Ref<boolean>;
  }
>()("test/DocumentsStub") {}

const actorOf = (caller: Caller) =>
  caller._tag === "System" ? `System:${caller.job._tag}` : caller._tag;

const viewOf = (row: StubDocument): DocumentView =>
  ({
    id: row.id,
    kind: row.kind,
    number: row.number,
    status: row.status,
    revision: row.revision,
    lines: row.input.lines,
    dates: { issuedOn: row.issuedOn, taxableSupplyOn: row.issuedOn, dueOn: row.issuedOn },
  }) as unknown as DocumentView;

/** `Documents` stub + `DocumentsStub`; needs MemoryTables, CoreStore, IdGenerator. */
export const DocumentsStubLayer = Layer.effectContext(
  Effect.gen(function* () {
    const tables = yield* MemoryTables;
    const store = yield* CoreStore;
    const docs = tables.collection(StubDocuments);
    const deliveries = tables.collection(StubDeliveries);
    const attempts = yield* Ref.make({ issue: 0, send: 0 });
    const failNextIssue = yield* Ref.make<CoreError | null>(null);
    const failNextSend = yield* Ref.make<CoreError | null>(null);
    const crashNextSend = yield* Ref.make(false);
    const takeOnce = <A>(ref: Ref.Ref<A>, empty: A) => Ref.getAndSet(ref, empty);

    const create = (input: DocumentInput, status: "draft" | "issued") =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller;
        const ws = (caller as { readonly workspaceId: WorkspaceId }).workspaceId;
        if (input.contact === MISSING_CONTACT) {
          return yield* new NotFound({ entity: "Contact", id: input.contact });
        }
        return yield* store.transaction(
          Effect.gen(function* () {
            const issuedCount = (yield* docs.list(ws, { where: { status: "issued" } })).length;
            const row = yield* docs.insert({
              id: yield* newId<DocumentId>(),
              workspaceId: ws,
              revision: 1,
              status,
              kind: input.kind,
              number:
                status === "issued" ? `2026-${String(issuedCount + 1).padStart(4, "0")}` : null,
              issuedOn: input.issuedOn ?? null,
              input,
              actor: actorOf(caller),
            });
            return viewOf(row);
          }),
        );
      });

    const documents = {
      discardDraft: (id: DocumentId, expectedRevision: number) =>
        Effect.gen(function* () {
          yield* authorize("document.draft");
          const caller = yield* CurrentCaller;
          const ws = (caller as { readonly workspaceId: WorkspaceId }).workspaceId;
          yield* store.transaction(docs.remove(ws, id, expectedRevision));
        }),
      get: (id: DocumentId) =>
        Effect.gen(function* () {
          yield* authorize("document.read");
          const caller = yield* CurrentCaller;
          const ws = (caller as { readonly workspaceId: WorkspaceId }).workspaceId;
          return viewOf(yield* store.transaction(docs.get(ws, id)));
        }),
      createDraft: (input: DocumentInput) =>
        Effect.andThen(authorize("document.draft"), create(input, "draft")),
      issue: (from: { readonly input: DocumentInput } | { readonly draft: DocumentId }) =>
        Effect.gen(function* () {
          yield* authorize("document.issue");
          yield* Ref.update(attempts, (a) => ({ ...a, issue: a.issue + 1 }));
          const failure = yield* takeOnce(failNextIssue, null);
          if (failure !== null) return yield* Effect.fail(failure);
          if (!("input" in from)) return yield* Effect.die("stub: issue from draft");
          return yield* create(from.input, "issued");
        }),
      send: (id: DocumentId) =>
        Effect.gen(function* () {
          yield* authorize("document.send");
          yield* Ref.update(attempts, (a) => ({ ...a, send: a.send + 1 }));
          const failure = yield* takeOnce(failNextSend, null);
          if (failure !== null) return yield* Effect.fail(failure);
          const caller = yield* CurrentCaller;
          const ws = (caller as { readonly workspaceId: WorkspaceId }).workspaceId;
          const deliveryId = yield* store.transaction(
            Effect.gen(function* () {
              yield* docs.get(ws, id);
              const row = yield* deliveries.insert({
                id: yield* newId<DeliveryId>(),
                workspaceId: ws,
                revision: 1,
                documentId: id,
              });
              return row.id;
            }),
          );
          if (yield* takeOnce(crashNextSend, false)) return yield* Effect.die("crash after send");
          return { deliveryId, status: "queued" as const };
        }),
    };

    return Context.make(Documents, documents as unknown as Documents["Service"]).pipe(
      Context.add(
        DocumentsStub,
        DocumentsStub.of({
          documents: (ws) => store.transaction(docs.list(ws, { orderBy: ["number"] })),
          deliveries: (ws) => store.transaction(deliveries.list(ws)),
          attempts,
          failNextIssue,
          failNextSend,
          crashNextSend,
        }),
      ),
    );
  }),
);

/** The module on in-memory ports with the Documents stub. */
export const TestLayer = RecurringTestLayer.pipe(Layer.provideMerge(DocumentsStubLayer));

type Services = Layer.Success<typeof TestLayer>;

/** Runs `body` on fresh in-memory ports (TestClock at TEST_NOW) as `caller`. */
export const scenario = <A, E>(
  caller: Caller,
  body: Effect.Effect<A, E, Services | CurrentCaller | CoreStore | MemoryTables>,
  layer: Layer.Layer<Services, never, CoreStore | MemoryTables | IdGenerator> = TestLayer,
) => runTest(caller, body.pipe(Effect.provide(layer)));

/** Runs `effect` as `caller` (switches the current caller inside a scenario). */
export const as =
  (caller: Caller) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, CurrentCaller>> =>
    Effect.provideService(effect, CurrentCaller, caller);

/** The sealed System caller of one occurrence's RecurringIssuance job. */
export const job = (scheduleId: ScheduleId, occurrence: IsoDate, workspaceId?: WorkspaceId) =>
  system({ _tag: "RecurringIssuance", scheduleId, occurrence }, workspaceId);

/** The success value of a scenario's Exit, or a thrown error with the pretty cause. */
export const ok = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value;
  throw new Error(Cause.pretty(exit.cause));
};
