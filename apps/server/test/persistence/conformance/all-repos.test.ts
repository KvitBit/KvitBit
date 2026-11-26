/**
 * End-to-end conformance test of all 12 SQL repositories in `PersistenceLive` over PGlite:
 * Workspaces, Contacts, PriceList, NumberingSeries, Documents (Proforma -> Payment -> PTD ->
 * Final Invoice -> Credit Note), Deliveries, Payments, PublicShareLinks, Expenses (+ attachments),
 * Templates + Recurring Schedules, Reports + Exports, and FxFixingCache.
 */
import { describe, expect, test } from "bun:test";
import { exportJob } from "@kvitbit/core";
import {
  Caller,
  type ContactId,
  Contacts,
  CurrencyCode,
  type DocumentId,
  Documents,
  Expenses,
  IsoDate,
  Payments,
  PriceList,
  PublicShareLinks,
  Reports,
  Templates,
  UserId,
  Workspaces,
} from "@kvitbit/domain/contract";
import { BigDecimal, Effect, Exit, Stream } from "effect";
import { asCaller, runSqlCore } from "./sqlCore";

const OWNER_ID = UserId.make("01900000-0000-7000-8000-0000000000aa");
const OWNER_ACCOUNT = Caller.account({
  userId: OWNER_ID,
  email: "owner@kvitbit.test",
  locale: "cs",
  channel: "web",
});

describe("PersistenceLive SQL conformance (all 12 CoreRepos over PGlite)", () => {
  test("exercises Workspaces, Contacts, PriceList, Documents, Payments, Deliveries, ShareLinks, Expenses, Templates/Recurring, Reports/FX", async () => {
    const exit = await runSqlCore(
      OWNER_ACCOUNT,
      Effect.gen(function* () {
        const workspaces = yield* Workspaces;
        const contacts = yield* Contacts;
        const priceList = yield* PriceList;
        const documents = yield* Documents;
        const payments = yield* Payments;
        const shareLinks = yield* PublicShareLinks;
        const expenses = yield* Expenses;
        const templates = yield* Templates;
        const reports = yield* Reports;

        // 1. Workspaces + bank account + numbering series
        const member = yield* workspaces.create({
          name: "Kvitbit SQL Test s.r.o.",
          taxRegime: "vat_payer",
          ico: "25596641",
          dic: "CZ25596641",
          address: {
            street: "Václavská 1",
            city: "Praha",
            postalCode: "11000",
            country: "CZ",
          },
        });

        return yield* asCaller(
          member,
          Effect.gen(function* () {
            const bank = yield* workspaces.saveBankAccount({
              name: "Fio CZK",
              currency: CurrencyCode.make("CZK"),
              iban: "CZ6508000000192000145399",
              bic: "FIOBCZPP",
              isDefault: true,
            } as never);
            const series = yield* workspaces.listSeries;

            // 2. Contacts + PriceList
            const customer = yield* contacts.save({
              name: "Odběratel SQL s.r.o.",
              ico: "27082440",
              dic: "CZ27082440",
              address: { city: "Brno", country: "CZ" },
              roles: ["customer", "supplier"],
              billingEmails: ["fakturace@odberatel.cz"],
            });
            const item = yield* priceList.save({
              name: "Vývoj SW",
              unit: "hod",
              unitPrice: BigDecimal.fromStringUnsafe("1500"),
              currency: CurrencyCode.make("CZK"),
              vat: "standard",
            } as never);

            // 3. Documents chain: Proforma -> Payment -> PTD -> Final Invoice -> Credit Note
            const proforma = yield* documents.issue({
              input: {
                kind: "proforma",
                contact: customer.id as ContactId,
                issuedOn: IsoDate.make("2026-11-20"),
                due: { inDays: 14 },
                currency: CurrencyCode.make("CZK"),
                lines: [
                  {
                    description: "Záloha na projekt",
                    quantity: BigDecimal.fromStringUnsafe("1"),
                    unitPrice: BigDecimal.fromStringUnsafe("10000"),
                    vat: "standard",
                  },
                ],
              },
            });

            const paymentRes = yield* payments.record({
              target: { document: proforma.id as DocumentId },
              amount: {
                amount: BigDecimal.fromStringUnsafe("12100"),
                currency: CurrencyCode.make("CZK"),
              },
              paidOn: IsoDate.make("2026-11-23"),
              method: "bank_transfer",
            });

            const finalInv = yield* documents.issueFinalInvoice(proforma.id as DocumentId, {
              patch: {
                issuedOn: IsoDate.make("2026-11-23"),
                taxableSupplyOn: IsoDate.make("2026-11-23"),
              },
            });

            const creditNote = yield* documents.correct(finalInv.id as DocumentId, {
              reason: "Sleva po dokončení",
              lines: "full",
              correctedOn: IsoDate.make("2026-11-23"),
            });

            // 4. Deliveries + ShareLinks
            const delivery = yield* documents.send(finalInv.id as DocumentId, {
              to: ["fakturace@odberatel.cz"],
            });
            const share = yield* shareLinks.create(finalInv.id as DocumentId);

            // 5. Expenses + Attachment
            const expense = yield* expenses.record({
              status: "complete",
              supplier: { contact: customer.id },
              issuedOn: IsoDate.make("2026-11-20"),
              taxableSupplyOn: IsoDate.make("2026-11-20"),
              currency: CurrencyCode.make("CZK"),
              total: "2420.00",
              vat: [{ treatment: "standard", base: "2000.00", vat: "420.00" }],
              category: "office",
            } as never);
            const attachment = yield* expenses.attach(
              (expense as unknown as { id: string }).id as never,
              {
                name: "uctenka.pdf",
                contentType: "application/pdf",
                bytes: Stream.make(new TextEncoder().encode("%PDF-1.4 test")),
              },
            );

            // 6. Templates + Schedule + use
            const tpl = yield* templates.save({
              name: "Měsíční paušál",
              kind: "invoice",
              contact: customer.id as ContactId,
              currency: CurrencyCode.make("CZK"),
              due: { inDays: 14 },
              lines: [
                {
                  description: "Paušál",
                  quantity: BigDecimal.fromStringUnsafe("1"),
                  unitPrice: BigDecimal.fromStringUnsafe("5000"),
                  vat: "standard",
                },
              ],
            });
            const scheduled = yield* templates.schedule(
              (tpl as unknown as { id: string }).id as never,
              {
                every: { months: 1 },
                startOn: IsoDate.make("2026-12-01"),
                issueAs: "invoice",
                autoSend: false,
              },
              tpl.revision,
            );
            const fromTpl = yield* templates.use((tpl as unknown as { id: string }).id as never, {
              as: "draft",
            });

            // 7. Reports + FX cache
            const fxRate = yield* reports.fxRate({
              currency: CurrencyCode.make("EUR"),
              on: IsoDate.make("2026-11-23"),
            });
            const exportIntent = yield* reports.startExport();
            const reportingFiles = yield* exportJob.reportingTables(
              member.workspaceId,
              exportIntent.id,
              "cs",
            );
            expect(reportingFiles.map((file) => file.name)).toEqual([
              "reports/issued-documents.csv",
              "reports/payments.csv",
              "reports/complete-expenses.csv",
            ]);
            const documentPdf = yield* exportJob.documentPdf(
              member.workspaceId,
              exportIntent.id,
              finalInv.id,
            );
            expect(documentPdf.contentType).toBe("application/pdf");

            return {
              bankId: (bank as unknown as { id: string }).id,
              seriesCount: series.length,
              customerId: customer.id,
              itemId: (item as unknown as { id: string }).id,
              proformaNumber: proforma.number,
              ptdNumber: paymentRes.issued[0]?.number ?? null,
              finalNumber: finalInv.number,
              cnNumber: creditNote.number,
              deliveryId: delivery.deliveryId,
              shareToken: share.url,
              attachmentId: (attachment as unknown as { id: string }).id,
              scheduledHasSchedule: scheduled.schedule !== null,
              fromTplStatus: fromTpl.status,
              fxRate: BigDecimal.format(fxRate.rate),
              exportId: exportIntent.id,
            };
          }),
        );
      }),
      {
        users: [{ userId: OWNER_ID, name: "Owner", email: "owner@kvitbit.test" }],
        fixings: [
          {
            fixingDate: IsoDate.make("2026-11-23"),
            sequence: 227,
            rates: [
              {
                code: CurrencyCode.make("EUR"),
                quantity: 1,
                rate: BigDecimal.fromStringUnsafe("25.30"),
              },
            ],
          },
        ],
      },
    );

    if (Exit.isFailure(exit)) {
      throw exit.cause;
    }
    const res = exit.value;
    expect(res.seriesCount).toBeGreaterThanOrEqual(4);
    expect(res.proformaNumber).toBeTruthy();
    expect(res.ptdNumber).toBeTruthy();
    expect(res.finalNumber).toBeTruthy();
    expect(res.cnNumber).toBeTruthy();
    expect(res.deliveryId).toBeTruthy();
    expect(res.shareToken).toBeTruthy();
    expect(res.attachmentId).toBeTruthy();
    expect(res.scheduledHasSchedule).toBe(true);
    expect(res.fromTplStatus).toBe("draft");
    expect(res.fxRate).toBe("25.3");
    expect(res.exportId).toBeTruthy();
  }, 30_000);
});
