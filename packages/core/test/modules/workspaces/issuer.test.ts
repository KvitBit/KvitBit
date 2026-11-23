import { describe, expect, test } from "bun:test";
import type { IsoDate, WorkspaceId } from "@kvitbit/domain/contract";
import { NotFound } from "@kvitbit/domain/contract";
import { Effect } from "effect";
import { czechAccountNumber, IssuerSnapshots } from "../../../src/modules/workspaces";
import { system } from "../../helpers";
import { accountOf, as, failure, OWNER, scenario, seed, W } from "./harness";

describe("czechAccountNumber", () => {
  test("derives prefix-number/bank from a CZ IBAN and null otherwise", () => {
    expect(czechAccountNumber("CZ65 0800 0000 1920 0014 5399")).toBe("19-2000145399/0800");
    expect(czechAccountNumber("CZ6907101781240000004159")).toBe("178124-4159/0710");
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
          ws.saveBankAccount({ iban: "CZ6508000000192000145399", currency: "CZK" } as never),
        );
        yield* as(s.admin)(
          ws.saveBankAccount({ iban: "DE89370400440532013000", currency: "EUR" } as never),
        );
        const ws_ = s.workspaceId as WorkspaceId;
        const today = "2026-11-23" as IsoDate;
        const issuer = yield* as(s.member)(issuers.forDocument(ws_, today));
        expect(issuer.party).toMatchObject({ workspaceId: s.workspaceId, name: "Acme s.r.o." });
        expect(issuer.regime).toBe("non_vat_payer");
        expect(issuer.bankAccounts.map((a) => [a.currency, a.accountNumber, a.isDefault])).toEqual([
          ["CZK", "19-2000145399/0800", true],
          ["EUR", null, true],
        ]);
        expect(issuer.billing.seriesByKind.invoice).toBeDefined();
        // A System caller of the same Workspace (e.g. recurring issuance) reads it too.
        const sys = yield* as(system(undefined, ws_))(issuers.forDocument(ws_, today));
        expect(sys.party.name).toBe("Acme s.r.o.");
        // An existing other Workspace is NotFound for this caller, and vice versa (R2).
        const b = yield* seed("Beta s.r.o.");
        const wsB = b.workspaceId as WorkspaceId;
        expect(yield* failure(as(s.member)(issuers.forDocument(wsB, today)))).toEqual(
          new NotFound({ entity: "Workspace", id: wsB }),
        );
        expect(yield* failure(as(system(undefined, ws_))(issuers.forDocument(wsB, today)))).toEqual(
          new NotFound({ entity: "Workspace", id: wsB }),
        );
        expect((yield* as(b.owner)(issuers.forDocument(wsB, today))).party.name).toBe(
          "Beta s.r.o.",
        );
        // Callers without a Workspace never read one.
        expect(yield* failure(as(accountOf(OWNER))(issuers.forDocument(ws_, today)))).toEqual(
          new NotFound({ entity: "Workspace", id: ws_ }),
        );
      }),
    ));
});
