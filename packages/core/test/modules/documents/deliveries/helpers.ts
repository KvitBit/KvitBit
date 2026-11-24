/** Runners for the delivery and reminder tests: Documents with the real `DocumentSenderLive`. */
import type {
  Caller,
  ContactDefaults,
  ContactId,
  CurrentCaller,
  DocumentId,
  IsoDate,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Documents } from "@kvitbit/domain/contract";
import type { Layer } from "effect";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import type { DocumentRecord, IssuerForDocument } from "../../../../src/modules/documents";
import {
  DocumentFixtures,
  DocumentsDeliveryTestLayer,
  DocumentsRepo,
} from "../../../../src/modules/documents";
import { NumberingSeries } from "../../../../src/modules/numbering";
import { CoreStore } from "../../../../src/store/CoreStore";
import type { InMemoryPortsLive } from "../../../../src/testing";
import { member, runTest, WORKSPACE_A, WORKSPACE_B } from "../../../helpers";
import { CZ_BUYER, contact, invoiceInput, issuer, seed } from "../fixtures";

export type DeliveryServices =
  | Layer.Success<typeof DocumentsDeliveryTestLayer>
  | Layer.Success<ReturnType<typeof InMemoryPortsLive>>
  | CurrentCaller;

const NO_SERIES = { seriesByKind: {} };

/** Every kind gets its Workspace default series in both Workspaces (NumberingSeries). */
const defaultSeries = Effect.flatMap(CoreStore, (store) =>
  Effect.andThen(
    Effect.flatMap(DocumentFixtures, (f) =>
      f.putIssuer(issuer(WORKSPACE_B, "non_vat_payer", NO_SERIES)),
    ),
    store.transaction(
      Effect.flatMap(NumberingSeries, (n) =>
        Effect.andThen(
          n.ensureDefaults(WORKSPACE_A, [
            "invoice",
            "proforma",
            "credit_note",
            "payment_tax_document",
          ]),
          n.ensureDefaults(WORKSPACE_B, ["invoice", "proforma", "credit_note"]),
        ),
      ),
    ),
  ),
);

/** Runs `body` as `caller` (default owner) over the delivery test layer after `seed()`. */
export const deliveryScenario = <A, E>(
  body: Effect.Effect<A, E, DeliveryServices>,
  options: { readonly caller?: Caller } = {},
) =>
  runTest(
    options.caller ?? member("owner"),
    Effect.andThen(seed("vat_payer", NO_SERIES), Effect.andThen(defaultSeries, body)).pipe(
      Effect.provide(DocumentsDeliveryTestLayer),
    ),
  );

/** Issues an Invoice (default CZ_BUYER, due 2026-12-07) and returns its id. */
export const issueInvoice = (extra: Parameters<typeof invoiceInput>[0] = {}) =>
  Effect.gen(function* () {
    const view = yield* (yield* Documents).issue({ input: invoiceInput(extra) });
    return view.id as DocumentId;
  });

/** Replaces a Contact's defaults (e.g. its reminder policy). */
export const setContactDefaults = (
  defaults: ContactDefaults,
  id: ContactId = CZ_BUYER,
  workspaceId: WorkspaceId = WORKSPACE_A,
) => Effect.flatMap(DocumentFixtures, (f) => f.putContact(workspaceId, contact(id, { defaults })));

/** Replaces Workspace A's reminder policy. */
export const setWorkspaceReminders = (reminders: IssuerForDocument["reminders"]) =>
  Effect.flatMap(DocumentFixtures, (f) =>
    f.putIssuer({ ...issuer(WORKSPACE_A, "vat_payer", NO_SERIES), reminders }),
  );

/** Moves the TestClock to 09:00 UTC on `date`. */
export const at = (date: string) =>
  TestClock.setTime(Date.parse(`${date}T09:00:00Z`)).pipe(Effect.as(date as IsoDate));

/** Test-only direct write of a document's stored fields (e.g. settlement, dueOn). */
export const patchDocument = (id: DocumentId, patch: Partial<DocumentRecord>) =>
  Effect.flatMap(CoreStore, (store) =>
    store.transaction(
      Effect.gen(function* () {
        const repo = yield* DocumentsRepo;
        const row = yield* repo.lock(WORKSPACE_A, id);
        return yield* repo.update({ ...row, ...patch }, row.revision);
      }),
    ),
  );
