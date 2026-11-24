/** Runners for the Payments tests: `PaymentsTestLayer` on in-memory ports, documents seeded. */
import type { Caller, CurrentCaller, TaxRegime } from "@kvitbit/domain/contract";
import type { CnbFixing } from "@kvitbit/domain/ports";
import type { Exit, Layer } from "effect";
import { Effect } from "effect";
import { NumberingSeries } from "../../../src/modules/numbering";
import { PaymentsTestLayer } from "../../../src/modules/payments";
import { CoreStore } from "../../../src/store/CoreStore";
import type { InMemoryPortsLive } from "../../../src/testing";
import { member, runTest, WORKSPACE_A, WORKSPACE_B } from "../../helpers";
import { seed } from "../documents/fixtures";

export type Services =
  | Layer.Success<typeof PaymentsTestLayer>
  | Layer.Success<ReturnType<typeof InMemoryPortsLive>>
  | CurrentCaller;

const series = Effect.flatMap(CoreStore, (store) =>
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
).pipe(Effect.orDie);

/** Runs `body` as `caller` (default owner) after seeding Workspaces A and B and their series. */
export const run = <A, E>(
  body: Effect.Effect<A, E, Services>,
  options: {
    readonly caller?: Caller;
    readonly regimeA?: TaxRegime;
    readonly fixings?: ReadonlyArray<CnbFixing>;
  } = {},
): Promise<Exit.Exit<A, E>> =>
  runTest(
    options.caller ?? member("owner"),
    Effect.andThen(Effect.andThen(seed(options.regimeA, { seriesByKind: {} }), series), body).pipe(
      Effect.provide(PaymentsTestLayer),
    ),
    { fixings: options.fixings ?? [] },
  );
