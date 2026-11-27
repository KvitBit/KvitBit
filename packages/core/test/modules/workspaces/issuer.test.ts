import { describe, expect, test } from "bun:test";
import { BankAccountInput, IsoDate, NotFound, WorkspaceId } from "@kvitbit/domain/contract";
import * as EffectArray from "effect/Array";
import * as Effect from "effect/Effect";
import { czechAccountNumber, IssuerSnapshots } from "../../../src/modules/workspaces";
import { system } from "../../helpers";
import { accountOf, as, failure, OWNER, scenario, seed, W } from "./harness";

describe("czechAccountNumber", () => {
  test("derives prefix-number/bank from a CZ IBAN and null otherwise", () => {
    expect(czechAccountNumber("CZ65 0800 0000 1920 0014 5399")).toBe("19-2000145399/0800");
    expect(czechAccountNumber("CZ69 0710 1781 2400 0000 4159")).toBe("178124-4159/0710");
    expect(czechAccountNumber("CZ5508000000000123456789")).toBe("123456789/0800");
    expect(czechAccountNumber("DE89370400440532013000")).toBeNull();
  });
});

describe("IssuerSnapshots.forDocument", () => {
  test("maps the Issuing Entity, regime on the date and active bank accounts", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const issuers = yield* IssuerSnapshots;
        const s = yield* seed();
        yield* as(s.admin)(
          ws.saveBankAccount(
            BankAccountInput.make({ iban: "CZ6508000000192000145399", currency: "CZK" }),
          ),
        );
        yield* as(s.admin)(
          ws.saveBankAccount(
            BankAccountInput.make({ iban: "DE89370400440532013000", currency: "EUR" }),
          ),
        );
        const ws_ = WorkspaceId.make(s.workspaceId);
        const today = IsoDate.make("2026-11-23");
        const issuer = yield* as(s.member)(issuers.forDocument(ws_, today));
        expect(issuer.party).toMatchObject({ workspaceId: s.workspaceId, name: "Acme s.r.o." });
        expect(issuer.regime).toBe("non_vat_payer");
        expect(
          EffectArray.map(issuer.bankAccounts, (a) => [a.currency, a.accountNumber, a.isDefault]),
        ).toEqual([
          ["CZK", "19-2000145399/0800", true],
          ["EUR", null, true],
        ]);
        expect(issuer.billing.seriesByKind.invoice).toBeDefined();
        // A System caller of the same Workspace (e.g. recurring issuance) reads it too.
        const sys = yield* as(system(undefined, ws_))(issuers.forDocument(ws_, today));
        expect(sys.party.name).toBe("Acme s.r.o.");
        // An existing other Workspace is NotFound for this caller, and vice versa (R2).
        const b = yield* seed("Beta s.r.o.");
        const wsB = WorkspaceId.make(b.workspaceId);
        const forDocumentFailure = yield* issuers
          .forDocument(wsB, today)
          .pipe(as(s.member), failure);
        expect(forDocumentFailure).toEqual(NotFound.make({ entity: "Workspace", id: wsB }));
        const forDocumentFailure2 = yield* issuers
          .forDocument(wsB, today)
          .pipe(as(system(undefined, ws_)), failure);
        expect(forDocumentFailure2).toEqual(NotFound.make({ entity: "Workspace", id: wsB }));
        expect((yield* as(b.owner)(issuers.forDocument(wsB, today))).party.name).toBe(
          "Beta s.r.o.",
        );
        // A missing Workspace (caller scoped to it, no row) is NotFound, not a defect.
        const missing = WorkspaceId.make("019a0000-0000-7000-8000-000000000000");
        const forDocumentFailure3 = yield* issuers
          .forDocument(missing, today)
          .pipe(as(system(undefined, missing)), failure);
        expect(forDocumentFailure3).toEqual(NotFound.make({ entity: "Workspace", id: missing }));
        const forDocumentFailure4 = yield* issuers
          .forDocument(ws_, today)
          .pipe(as(accountOf(OWNER)), failure);
        // Callers without a Workspace never read one.
        expect(forDocumentFailure4).toEqual(NotFound.make({ entity: "Workspace", id: ws_ }));
      }),
    ));
});
