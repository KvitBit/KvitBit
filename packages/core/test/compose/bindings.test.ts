/** The seam bindings of src/compose/bindings.ts on TestCore (board IDs in each test name). */
import { describe, expect, test } from "bun:test";
import type { MemberCaller, NumberingSeriesId, WorkspaceId } from "@kvitbit/domain/contract";
import { Workspaces } from "@kvitbit/domain/contract";
import type { RegistryRecord } from "@kvitbit/domain/ports";
import { Effect, Exit } from "effect";
import { ContactSeriesLookup } from "../../src/modules/contacts";
import { ExpenseSuppliers } from "../../src/modules/expenses";
import { NumberingSeries } from "../../src/modules/numbering";
import { PaymentSettings } from "../../src/modules/payments";
import { account, asCaller, member, runCore, WORKSPACE_B } from "../helpers";

const ICO = "27082440";
const RECORD: RegistryRecord = {
  name: "Alfa Beta s.r.o.",
  address: { street: "Dlouhá 1", city: "Praha", postalCode: "11000", country: "CZ" },
  dic: "CZ27082440",
  legalForm: "s.r.o.",
  registerEntry: null,
  terminatedOn: null,
};

const newWorkspace = Effect.flatMap(Workspaces, (ws) =>
  ws.create({ name: "Kvitbit s.r.o." } as never),
);

/** The tag of the effect's expected failure. */
const failureTag = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(effect), (e) => e._tag);

describe("bindings", () => {
  test("ContactSeriesLookup reads kinds from the numbering module; foreign ids absent (#389)", async () => {
    const exit = await runCore(
      account(),
      Effect.gen(function* () {
        const owner = yield* newWorkspace;
        const series = yield* asCaller(
          owner,
          Effect.flatMap(Workspaces, (ws) => ws.listSeries),
        );
        const invoice = series.find((s) => s.kind === "invoice");
        const lookup = yield* ContactSeriesLookup;
        const own = yield* lookup.kindsOf(owner.workspaceId, [
          invoice?.id as NumberingSeriesId,
          "01900000-0000-7000-8000-0000000000ff" as NumberingSeriesId,
        ]);
        const foreign = yield* lookup.kindsOf(WORKSPACE_B, [invoice?.id as NumberingSeriesId]);
        return [[...own.values()], foreign.size];
      }),
    );
    expect(exit).toEqual(Exit.succeed([["invoice"], 0]));
  });

  test("WorkspaceSeries and NumberingSeries are the same service (#335)", async () => {
    const exit = await runCore(
      account(),
      Effect.gen(function* () {
        const owner = yield* newWorkspace;
        const numbering = yield* NumberingSeries;
        return (yield* numbering.list(owner.workspaceId, "2026-11-23" as never)).length;
      }),
    );
    expect(exit).toEqual(Exit.succeed(3));
  });

  test("PaymentSettings reads the Workspace setting; another Workspace is NotFound (#581)", async () => {
    const exit = await runCore(
      account(),
      Effect.gen(function* () {
        const owner = yield* newWorkspace;
        const settings = yield* PaymentSettings;
        const own = yield* asCaller(owner, settings.autoSendPaymentTaxDocument(owner.workspaceId));
        const other = yield* failureTag(
          asCaller(owner, settings.autoSendPaymentTaxDocument(WORKSPACE_B as WorkspaceId)),
        );
        return [typeof own, other];
      }),
    );
    expect(exit).toEqual(Exit.succeed(["boolean", "NotFound"]));
  });

  test("ExpenseSuppliers goes through Contacts as the caller: IČO creates a supplier, scope applies", async () => {
    const exit = await runCore(
      account(),
      Effect.gen(function* () {
        const owner = yield* newWorkspace;
        const suppliers = yield* ExpenseSuppliers;
        const created = yield* asCaller(owner, suppliers.fromIco(ICO));
        const again = yield* asCaller(owner, suppliers.contact(created.contactId as never));
        const scoped: MemberCaller = member("owner", {
          workspaceId: owner.workspaceId,
          userId: owner.userId,
          scopes: ["expenses"] as never,
        });
        const denied = yield* failureTag(
          asCaller(scoped, suppliers.contact(created.contactId as never)),
        );
        return [created.name, created.ico, again.contactId === created.contactId, denied];
      }),
      { registry: { [ICO]: RECORD } },
    );
    expect(exit).toEqual(Exit.succeed(["Alfa Beta s.r.o.", ICO, true, "Forbidden"]));
  });
});
