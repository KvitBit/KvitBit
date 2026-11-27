import { DocumentId, DocumentView, type Role } from "@kvitbit/domain";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { type PageCommand, RunApi } from "../../src/app/commands";
import { DEMO_WORKSPACES, signedIn } from "../support";

export const DOC_ID = Effect.runSync(
  Schema.decodeEffect(DocumentId)("0193a000-0000-7000-8000-000000000602"),
);
const bd = (n: number) => BigDecimal.fromBigInt(BigInt(n));

export const sampleProforma = Effect.runSync(
  Schema.decodeEffect(DocumentView)({
    id: DOC_ID,
    kind: "proforma",
    number: "ZF-2026-0011",
    status: "issued",
    locked: false,
    settlement: "paid",
    overdue: false,
    revision: 3,
    taxDocument: false,
    contact: {
      contactId: "0193a000-0000-7000-8000-000000000201",
      name: "Alza.cz a.s.",
      ico: "27082440",
      dic: "CZ27082440",
      legalForm: "a.s.",
      address: { street: "Jankovcova 53", city: "Praha 7", postalCode: "170 00", country: "CZ" },
      billingEmails: ["fakturace@alza.example.cz"],
    },
    issuer: {
      workspaceId: "0193a000-0000-7000-8000-000000000100",
      name: "Novák Design s.r.o.",
      ico: "14285714",
      dic: "CZ14285714",
      address: { street: "Křižíkova 34", city: "Praha 8", postalCode: "186 00", country: "CZ" },
      registerEntry: "C 351029",
      email: "fakturace@novakdesign.example.cz",
      phone: null,
      web: null,
      regime: "vat_payer",
      bankAccount: null,
    },
    dates: { issuedOn: "2026-11-01", taxableSupplyOn: null, dueOn: "2026-11-15" },
    paymentMethod: "bank_transfer",
    lines: [],
    totals: {
      buckets: [],
      net: { amount: bd(12000), currency: "CZK" },
      vat: { amount: bd(2520), currency: "CZK" },
      roundingAdjustment: { amount: bd(0), currency: "CZK" },
      gross: { amount: bd(14520), currency: "CZK" },
      vatCzk: null,
    },
    fx: null,
    statutoryNotes: [],
    paymentQr: null,
    related: [],
    share: null,
    deliveries: [],
  }),
);

const encodeDocumentJson = Schema.encodeEffect(Schema.toCodecJson(DocumentView));

export const jsonDocument: {
  (status?: number): (doc: DocumentView) => Response;
  (doc: DocumentView, status?: number): Response;
} = Fn.dual(
  (args) => Predicate.isObject(args[0]),
  (doc: DocumentView, status = 200) =>
    Response.json(Effect.runSync(encodeDocumentJson(doc)), {
      status,
      headers: { etag: `"${doc.revision}"` },
    }),
);

export const commandEffect = <Msg>(commands: ReadonlyArray<PageCommand<Msg>> | undefined) => {
  const command = commands?.[0];
  if (commands?.length !== 1 || command?._tag !== "Effect") {
    throw new Error("Expected one Effect command");
  }
  return command.effect;
};

// @effect-diagnostics-next-line missingPipeableSignature:off Tests run their command directly with an optional fetch fixture.
export const runCommand = <Msg>(
  commands: ReadonlyArray<PageCommand<Msg>> | undefined,
  fetch?: (request: Request) => Response | Promise<Response>,
): Promise<Msg> => {
  const effect = commandEffect(commands).pipe(Effect.provide(RunApi.layer));
  return Effect.runPromise(
    fetch === undefined
      ? effect
      : effect.pipe(
          Effect.provideService(
            FetchHttpClient.Fetch,
            Object.assign(
              (input: RequestInfo | URL, init?: RequestInit) =>
                Promise.resolve().then(() => fetch(new Request(input, init))),
              { preconnect: () => undefined },
            ),
          ),
        ),
  );
};

export const sessionWithRole = (role: Role) => ({
  ...signedIn,
  workspaces: Arr.map(DEMO_WORKSPACES, (workspace) => ({ ...workspace, role })),
});
