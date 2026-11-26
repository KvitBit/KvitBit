import { DocumentId, DocumentView, type Role } from "@kvitbit/domain";
import { BigDecimal, Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { type PageCommand, RunApi } from "../../src/app/commands";
import { DEMO_WORKSPACES, signedIn } from "../support";

export const DOC_ID = Schema.decodeUnknownSync(DocumentId)("0193a000-0000-7000-8000-000000000602");
const bd = (n: number) => BigDecimal.fromBigInt(BigInt(n));

export const sampleProforma = Schema.decodeUnknownSync(DocumentView)({
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
});

const encodeDocumentJson = Schema.encodeSync(Schema.toCodecJson(DocumentView));

export const jsonDocument = (doc: DocumentView, status = 200) =>
  Response.json(encodeDocumentJson(doc), { status, headers: { etag: `"${doc.revision}"` } });

export const commandEffect = <Msg>(commands: ReadonlyArray<PageCommand<Msg>> | undefined) => {
  const command = commands?.[0];
  if (commands?.length !== 1 || command?._tag !== "Effect") {
    throw new Error("Expected one Effect command");
  }
  return command.effect;
};

export const runCommand = <Msg>(
  commands: ReadonlyArray<PageCommand<Msg>> | undefined,
  fetch?: (request: Request) => Response | Promise<Response>,
): Promise<Msg> => {
  const effect = commandEffect(commands).pipe(Effect.provide(RunApi.layer));
  return Effect.runPromise(
    fetch === undefined
      ? effect
      : effect.pipe(
          Effect.provideService(FetchHttpClient.Fetch, (async (
            input: RequestInfo | URL,
            init?: RequestInit,
          ) => fetch(new Request(input, init))) as typeof globalThis.fetch),
        ),
  );
};

export const sessionWithRole = (role: Role) => ({
  ...signedIn,
  workspaces: DEMO_WORKSPACES.map((workspace) => ({ ...workspace, role })),
});
