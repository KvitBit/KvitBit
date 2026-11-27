/**
 * Test fixtures for the recurring module: a stub of the domain `Documents` tag whose rows live
 * in `MemoryTables`, so its writes commit and roll back with the caller's transaction (as the
 * real module's do), plus scenario runners over real layers.
 */

import type {
  Caller,
  CoreError,
  ScheduleId,
  TemplateInput,
  TemplateView,
} from "@kvitbit/domain/contract";
import {
  Conflict,
  ContactId,
  ContactSnapshot,
  CurrencyCode,
  CurrentCaller,
  DeliveryId,
  DocumentId,
  DocumentInput,
  Documents,
  type DocumentView,
  IsoDate,
  IssuerSnapshot,
  LineView,
  NotFound,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as EffectString from "effect/String";
import { RecurringTestLayer, TemplateViewSchema } from "../../../src/modules/recurring";
import { authorizeInWorkspace, type WorkspaceCaller } from "../../../src/policy/Policy";
import { orUnavailable } from "../../../src/shared/errors";
import { IdGenerator, newId } from "../../../src/shared/ids";
import { CoreStore, type StoreUnavailable } from "../../../src/store/CoreStore";
import { defineCollection, MemoryTables } from "../../../src/store/tables";
import { runTest, system, WORKSPACE_A } from "../../helpers";

const CONTACT = ContactId.make("01900000-0000-7000-8000-0000000c0a01");
/** Documents.issue fails with NotFound{Contact} for this contact. */
export const MISSING_CONTACT = ContactId.make("01900000-0000-7000-8000-00000000dead");

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

const StubDocument = Schema.Struct({
  id: DocumentId,
  workspaceId: WorkspaceId,
  revision: Schema.Int,
  status: Schema.Literals(["draft", "issued"]),
  kind: DocumentInput.fields.kind,
  number: Schema.NullOr(Schema.String),
  issuedOn: Schema.NullOr(IsoDate),
  input: DocumentInput,
  /** Who issued it: "Member", or "System:<job tag>". */
  actor: Schema.String,
});
type StubDocument = typeof StubDocument.Type;

const StubDelivery = Schema.Struct({
  id: DeliveryId,
  workspaceId: WorkspaceId,
  revision: Schema.Int,
  documentId: DocumentId,
});
type StubDelivery = typeof StubDelivery.Type;

const StubDocuments = defineCollection<StubDocument>({
  name: "stub_documents",
  entity: "Document",
  schema: StubDocument,
});
const StubDeliveries = defineCollection<StubDelivery>({
  name: "stub_deliveries",
  entity: "Document",
  schema: StubDelivery,
});

type SendError = Effect.Error<ReturnType<Documents["Service"]["send"]>>;

/** Controls and observations of the Documents stub. */
export class DocumentsStub extends Context.Service<
  DocumentsStub,
  {
    readonly documents: (
      ws: WorkspaceId,
    ) => Effect.Effect<ReadonlyArray<StubDocument>, StoreUnavailable>;
    readonly deliveries: (
      ws: WorkspaceId,
    ) => Effect.Effect<ReadonlyArray<StubDelivery>, StoreUnavailable>;
    /** Calls that reached the stub, including ones whose transaction rolled back. */
    readonly attempts: Ref.Ref<{ readonly issue: number; readonly send: number }>;
    /** The next issue fails with this error (once). */
    readonly failNextIssue: Ref.Ref<CoreError | null>;
    /** The next send fails with this error (once). */
    readonly failNextSend: Ref.Ref<SendError | null>;
    /** The next send dies after queueing its delivery: a crash inside the send step. */
    readonly crashNextSend: Ref.Ref<boolean>;
  }
>()("@kvitbit/core/test/modules/recurring/fixtures/DocumentsStub") {}

const actorOf = (caller: WorkspaceCaller) =>
  caller._tag === "System" ? `System:${caller.job._tag}` : caller._tag;

const VIEW_DATE = IsoDate.make("2026-11-23");
const ZERO_CZK = { amount: BigDecimal.fromBigInt(0n), currency: CurrencyCode.make("CZK") };

const viewOf = (row: StubDocument): DocumentView => ({
  id: row.id,
  kind: row.kind,
  number: row.number,
  status: row.status,
  revision: row.revision,
  locked: false,
  settlement: "unpaid",
  overdue: false,
  taxDocument: false,
  contact: ContactSnapshot.make({ id: row.input.contact }),
  issuer: IssuerSnapshot.make({}),
  lines: EffectArray.map(row.input.lines, (line) => LineView.make(line)),
  dates: {
    issuedOn: row.issuedOn ?? VIEW_DATE,
    taxableSupplyOn: row.issuedOn,
    dueOn: row.issuedOn ?? VIEW_DATE,
  },
  paymentMethod: "bank_transfer",
  totals: {
    buckets: [],
    net: ZERO_CZK,
    vat: ZERO_CZK,
    roundingAdjustment: ZERO_CZK,
    gross: ZERO_CZK,
    vatCzk: null,
  },
  fx: null,
  statutoryNotes: [],
  paymentQr: null,
  related: [],
  share: null,
  deliveries: [],
});

const unsupported = () => Effect.die("Documents operation is outside the recurring test fixture");

/** `Documents` stub + `DocumentsStub`; needs MemoryTables, CoreStore, IdGenerator. */
export const DocumentsStubLayer = Layer.effectContext(
  Effect.gen(function* () {
    const ids = yield* IdGenerator;
    const tables = yield* MemoryTables;
    const store = yield* CoreStore;
    const docs = tables.collection(StubDocuments);
    const deliveries = tables.collection(StubDeliveries);
    const attempts = yield* Ref.make({ issue: 0, send: 0 });
    const failNextIssue = yield* Ref.make<CoreError | null>(null);
    const failNextSend = yield* Ref.make<SendError | null>(null);
    const crashNextSend = yield* Ref.make(false);
    const takeOnce = <A>(ref: Ref.Ref<A>, empty: A) => Ref.getAndSet(ref, empty);

    const create = (input: DocumentInput, status: "draft" | "issued", caller: WorkspaceCaller) =>
      Effect.gen(function* () {
        const { workspaceId } = caller;
        if (input.contact === MISSING_CONTACT) {
          return yield* NotFound.make({ entity: "Contact", id: input.contact });
        }
        const write = store.transaction(
          Effect.gen(function* () {
            const issuedCount = (yield* docs.list(workspaceId, { where: { status: "issued" } }))
              .length;
            const id = yield* newId(DocumentId.make).pipe(Effect.provideService(IdGenerator, ids));
            const row = yield* docs.insert({
              id,
              workspaceId,
              revision: 1,
              status,
              kind: input.kind,
              number:
                status === "issued"
                  ? `2026-${EffectString.padStart(4, "0")(String(issuedCount + 1))}`
                  : null,
              issuedOn: input.issuedOn ?? null,
              input,
              actor: actorOf(caller),
            });
            return viewOf(row);
          }),
        );
        return yield* orUnavailable(write).pipe(
          Effect.catchTag("UniqueViolation", () =>
            Effect.fail(Conflict.make({ reason: "duplicate" })),
          ),
        );
      });

    const documents = Documents.of({
      preview: unsupported,
      edit: unsupported,
      lock: unsupported,
      unlock: unsupported,
      cancel: unsupported,
      correct: unsupported,
      issueFinalInvoice: unsupported,
      previewSend: unsupported,
      previewFinalInvoice: unsupported,
      previewCorrection: unsupported,
      pdf: unsupported,
      list: unsupported,
      history: unsupported,
      discardDraft: Effect.fn("DocumentsStub.discardDraft")(function* (
        id: DocumentId,
        expectedRevision: number,
      ) {
        const { workspaceId } = yield* authorizeInWorkspace("document.draft");
        yield* orUnavailable(store.transaction(docs.remove(workspaceId, id, expectedRevision)));
      }),
      get: Effect.fn("DocumentsStub.get")(function* (id: DocumentId) {
        const { workspaceId } = yield* authorizeInWorkspace("document.read");
        const row = yield* orUnavailable(store.transaction(docs.get(workspaceId, id)));
        return viewOf(row);
      }),
      createDraft: Effect.fn("DocumentsStub.createDraft")(function* (input: DocumentInput) {
        const { caller } = yield* authorizeInWorkspace("document.draft");
        return yield* create(input, "draft", caller);
      }),
      issue: Effect.fn("DocumentsStub.issue")(function* (
        from: Parameters<Documents["Service"]["issue"]>[0],
      ) {
        const { caller } = yield* authorizeInWorkspace("document.issue");
        yield* Ref.update(attempts, (a) => ({ ...a, issue: a.issue + 1 }));
        const failure = yield* takeOnce(failNextIssue, null);
        if (failure !== null) return yield* failure;
        if (!("input" in from)) return yield* Effect.die("stub: issue from draft");
        return yield* create(from.input, "issued", caller);
      }),
      send: Effect.fn("DocumentsStub.send")(function* (id: DocumentId) {
        const { workspaceId } = yield* authorizeInWorkspace("document.send");
        yield* Ref.update(attempts, (a) => ({ ...a, send: a.send + 1 }));
        const failure = yield* takeOnce(failNextSend, null);
        if (failure !== null) return yield* failure;
        const write = store.transaction(
          Effect.gen(function* () {
            yield* docs.get(workspaceId, id);
            const deliveryId = yield* newId(DeliveryId.make).pipe(
              Effect.provideService(IdGenerator, ids),
            );
            const row = yield* deliveries.insert({
              id: deliveryId,
              workspaceId,
              revision: 1,
              documentId: id,
            });
            return row.id;
          }),
        );
        const deliveryId = yield* orUnavailable(write).pipe(
          Effect.catchTag("UniqueViolation", () =>
            Effect.fail(Conflict.make({ reason: "duplicate" })),
          ),
        );
        if (yield* takeOnce(crashNextSend, false)) return yield* Effect.die("crash after send");
        return { deliveryId, status: "queued" as const };
      }),
    });

    return Context.make(Documents, documents).pipe(
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
const TestLayer = RecurringTestLayer.pipe(Layer.provideMerge(DocumentsStubLayer));

type Services = Layer.Success<typeof TestLayer>;

/** Runs `body` on fresh in-memory ports (TestClock at TEST_NOW) as `caller`. */
export const scenario =
  (caller: Caller) =>
  <A, E>(body: Effect.Effect<A, E, Services | CurrentCaller | CoreStore | MemoryTables>) =>
    runTest(caller, body.pipe(Effect.provide(TestLayer)));

const decodeTemplateView = Schema.decodeUnknownEffect(TemplateViewSchema);
export const templateView = (value: TemplateView) => decodeTemplateView(value).pipe(Effect.orDie);

/** Runs `effect` as `caller` (switches the current caller inside a scenario). */
export const as =
  (caller: Caller) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, CurrentCaller>> =>
    Effect.provideService(effect, CurrentCaller, caller);

/** The sealed System caller of one occurrence's RecurringIssuance job. */
export const job =
  (scheduleId: ScheduleId) =>
  (occurrence: IsoDate, workspaceId: WorkspaceId = WORKSPACE_A) =>
    system({ _tag: "RecurringIssuance", scheduleId, occurrence }, workspaceId);

/** The success value of a scenario's Exit, or a thrown error with the pretty cause. */
export const ok = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value;
  throw new Error(Cause.pretty(exit.cause));
};
