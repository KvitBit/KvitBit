/**
 * End-to-end conformance test of all 12 SQL repositories in `PersistenceLive` over PGlite:
 * Workspaces, Contacts, PriceList, NumberingSeries, Documents (Proforma -> Payment -> PTD ->
 * Final Invoice -> Credit Note), Deliveries, Payments, PublicShareLinks, Expenses (+ attachments),
 * Templates + Recurring Schedules, Reports + Exports, and FxFixingCache.
 */

import { describe, expect, test } from "bun:test";
import {
  ContactsRepo,
  DeliveriesRepo,
  DocumentsRepo,
  exportJob,
  PaymentsRepo,
  WorkspacesRepo,
} from "@kvitbit/core";
import { StoreUnavailable } from "@kvitbit/core/ports";
import {
  AttachmentId,
  BankAccountId,
  BankAccountInput,
  Caller,
  ContactId,
  Contacts,
  CurrencyCode,
  Documents,
  ExpenseId,
  Expenses,
  IsoDate,
  PaymentId,
  Payments,
  PriceList,
  PriceListItemId,
  PriceListItemInput,
  PublicShareLinks,
  Reports,
  TemplateId,
  Templates,
  UserId,
  Workspaces,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { runSqlCore } from "./sqlCore";

const readBank = Schema.decodeUnknownEffect(Schema.Struct({ id: BankAccountId }));
const readItem = Schema.decodeUnknownEffect(Schema.Struct({ id: PriceListItemId }));
const readAttachment = Schema.decodeUnknownEffect(Schema.Struct({ id: AttachmentId }));
const readContactId = Schema.decodeUnknownEffect(ContactId);
const readExpenseId = Schema.decodeUnknownEffect(ExpenseId);
const readTemplateId = Schema.decodeUnknownEffect(TemplateId);

const OWNER_ID = UserId.make("01900000-0000-7000-8000-0000000000aa");
const OWNER_ACCOUNT = Caller.account({
  userId: OWNER_ID,
  email: "owner@kvitbit.test",
  locale: "cs",
  channel: "web",
});

describe("PersistenceLive SQL conformance (all 12 CoreRepos over PGlite)", () => {
  test("exercises Workspaces, Contacts, PriceList, Documents, Payments, Deliveries, ShareLinks, Expenses, Templates/Recurring, Reports/FX", async () => {
    const exit = await runSqlCore({
      effect: Effect.gen(function* () {
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
        const member = yield* workspaces.create(OWNER_ACCOUNT, {
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

        const bank = yield* workspaces.saveBankAccount(
          member,
          BankAccountInput.make({
            name: "Fio CZK",
            currency: CurrencyCode.make("CZK"),
            iban: "CZ6508000000192000145399",
            bic: "FIOBCZPP",
            isDefault: true,
          }),
        );
        const sql = yield* SqlClient.SqlClient;
        const archivedBankId = BankAccountId.make("01900000-0000-7000-8000-0000000000ba");
        yield* sql`insert into bank_accounts
              (id, workspace_id, label, currency, account_number, bank_code, archived_at)
              values (${archivedBankId}, ${member.workspaceId}, 'Old bank', 'CZK', '123', '0800', now())`;
        const current = yield* workspaces.current(member);
        expect(current["name"]).toBe("Kvitbit SQL Test s.r.o.");
        expect(current["bankAccounts"]).toEqual([bank]);
        const series = yield* workspaces.listSeries(member);

        // 2. Contacts + PriceList
        const customer = yield* contacts.save(member, {
          name: "Odběratel SQL s.r.o.",
          ico: "27082440",
          dic: "CZ27082440",
          address: { city: "Brno", country: "CZ" },
          roles: ["customer", "supplier"],
          billingEmails: ["fakturace@odberatel.cz"],
        });
        const contactId = yield* readContactId(customer["id"]);
        const item = yield* priceList.save(
          member,
          PriceListItemInput.make({
            name: "Vývoj SW",
            unit: "hod",
            unitPrice: BigDecimal.fromStringUnsafe("1500"),
            currency: CurrencyCode.make("CZK"),
            vat: "standard",
          }),
        );

        // 3. Documents chain: Proforma -> Payment -> PTD -> Final Invoice -> Credit Note
        const proforma = yield* documents.issue(member, {
          input: {
            kind: "proforma",
            contact: contactId,
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

        const paymentRes = yield* payments.record(member, {
          target: { document: proforma.id },
          amount: {
            amount: BigDecimal.fromStringUnsafe("12100"),
            currency: CurrencyCode.make("CZK"),
          },
          paidOn: IsoDate.make("2026-11-23"),
          method: "bank_transfer",
        });

        const finalInv = yield* documents.issueFinalInvoice(member, proforma.id, {
          patch: {
            issuedOn: IsoDate.make("2026-11-23"),
            taxableSupplyOn: IsoDate.make("2026-11-23"),
          },
        });

        const creditNote = yield* documents.correct(member, finalInv.id, {
          reason: "Sleva po dokončení",
          lines: "full",
          correctedOn: IsoDate.make("2026-11-23"),
        });

        // 4. Deliveries + ShareLinks
        const delivery = yield* documents.send(member, finalInv.id, {
          to: ["fakturace@odberatel.cz"],
        });
        const share = yield* shareLinks.create(member, finalInv.id);

        // 5. Expenses + Attachment
        const expense = yield* expenses.record(member, {
          status: "complete",
          supplier: { contact: contactId },
          issuedOn: IsoDate.make("2026-11-20"),
          taxableSupplyOn: IsoDate.make("2026-11-20"),
          currency: CurrencyCode.make("CZK"),
          total: "2420.00",
          vat: [{ treatment: "standard", base: "2000.00", vat: "420.00" }],
          category: "office",
        });
        const expenseId = yield* readExpenseId(expense["id"]);
        const attachment = yield* expenses.attach(member, expenseId, {
          name: "uctenka.pdf",
          contentType: "application/pdf",
          bytes: Stream.make(new TextEncoder().encode("%PDF-1.4 test")),
        });

        // 6. Templates + Schedule + use
        const tpl = yield* templates.save(member, {
          name: "Měsíční paušál",
          kind: "invoice",
          contact: contactId,
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
        const templateId = yield* readTemplateId(tpl["id"]);
        const scheduled = yield* templates.schedule(
          member,
          templateId,
          {
            every: { months: 1 },
            startOn: IsoDate.make("2026-12-01"),
            issueAs: "invoice",
            autoSend: false,
          },
          tpl.revision,
        );
        const fromTpl = yield* templates.use(member, templateId, {
          as: "draft",
        });

        // 7. Reports + FX cache
        const fxRate = yield* reports.fxRate(member, {
          currency: CurrencyCode.make("EUR"),
          on: IsoDate.make("2026-11-23"),
        });
        const exportIntent = yield* reports.startExport(member);
        const reportingFiles = yield* exportJob.reportingTables(member.workspaceId, "cs");
        expect(Arr.map(reportingFiles, (file) => file.name)).toEqual([
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

        const documentsRepo = yield* DocumentsRepo;
        const deliveriesRepo = yield* DeliveriesRepo;
        const legacyLineId = "01900000-0000-4000-8000-0000000000bb";
        yield* sql`update document_lines set id = ${legacyLineId}
              where workspace_id = ${member.workspaceId} and document_id = ${fromTpl.id}`;
        yield* sql`update documents
              set contact_snapshot = contact_snapshot || '{"historicalField":"preserve"}'::jsonb
              where workspace_id = ${member.workspaceId} and id = ${fromTpl.id}`;
        const storedDraft = yield* documentsRepo.get(member.workspaceId, fromTpl.id);
        expect<string | undefined>(storedDraft.lines[0]?.id).toBe(legacyLineId);
        yield* documentsRepo.update({ ...storedDraft, note: "updated" }, storedDraft.revision);
        const [storedSnapshot] = yield* sql<{ readonly historical_field: string }>`
              select contact_snapshot->>'historicalField' as historical_field from documents
              where workspace_id = ${member.workspaceId} and id = ${fromTpl.id}`;
        expect(storedSnapshot?.historical_field).toBe("preserve");

        const paymentsRepo = yield* PaymentsRepo;
        const legacyPaymentId = PaymentId.make("01900000-0000-4000-8000-0000000000cc", {
          disableChecks: true,
        });
        yield* sql`update payments set id = ${legacyPaymentId}
              where workspace_id = ${member.workspaceId} and document_id = ${proforma.id}`;
        const storedPayment = yield* paymentsRepo.get(member.workspaceId, legacyPaymentId);
        expect(storedPayment.id).toBe(legacyPaymentId);

        yield* sql`update documents set issuer_snapshot = null
              where workspace_id = ${member.workspaceId} and id = ${finalInv.id}`;
        const missingSnapshot = yield* Effect.flip(
          documentsRepo.get(member.workspaceId, finalInv.id),
        );
        expect(Schema.is(StoreUnavailable)(missingSnapshot)).toBe(true);

        yield* sql`update deliveries set status = 'sending', attachment = null,
                render_model = render_model - '__snapshot'
              where workspace_id = ${member.workspaceId} and id = ${delivery.deliveryId}`;
        const legacyDelivery = yield* deliveriesRepo.get(member.workspaceId, delivery.deliveryId);
        expect(legacyDelivery).toMatchObject({
          status: "failed",
          failure: "delivery.snapshot_missing",
        });

        const workspacesRepo = yield* WorkspacesRepo;
        const archivedMissingIban = yield* Effect.flip(
          workspacesRepo.getBankAccount(member.workspaceId, archivedBankId),
        );
        expect(Schema.is(StoreUnavailable)(archivedMissingIban)).toBe(true);
        const legacyWorkspaceId = "01900000-0000-4000-8000-0000000000ee";
        const legacySlug = "legacy-workspace";
        yield* sql`insert into workspaces (id, slug, name)
              values (${legacyWorkspaceId}, ${legacySlug}, 'Legacy Workspace')`;
        const storedWorkspace = yield* workspacesRepo.findWorkspaceBySlug(legacySlug);
        const storedWorkspaceId = Option.getOrThrow(storedWorkspace).id;
        expect<string>(storedWorkspaceId).toBe(legacyWorkspaceId);

        const legacyContactId = ContactId.make("01900000-0000-7000-8000-0000000000dd");
        yield* sql`insert into contacts (id, workspace_id, name)
              values (${legacyContactId}, ${storedWorkspaceId}, 'Legacy Customer')`;
        const contactsRepo = yield* ContactsRepo;
        const legacyContact = yield* contactsRepo.get(storedWorkspaceId, legacyContactId);
        expect(legacyContact.workspaceId).toBe(storedWorkspaceId);
        const foundContacts = yield* contactsRepo.search(storedWorkspaceId, {
          text: "legacy customer",
          limit: 10,
        });
        expect(foundContacts).toMatchObject([
          { id: legacyContactId, workspaceId: storedWorkspaceId },
        ]);

        yield* sql`insert into bank_accounts (id, workspace_id, label, currency, account_number, bank_code)
              values ('01900000-0000-7000-8000-0000000000ff', ${storedWorkspaceId}, 'Legacy bank', 'CZK', '123', '0800')`;
        const missingIban = yield* Effect.flip(workspacesRepo.listBankAccounts(storedWorkspaceId));
        expect(Schema.is(StoreUnavailable)(missingIban)).toBe(true);

        return {
          bankId: (yield* readBank(bank)).id,
          seriesCount: series.length,
          customerId: customer["id"],
          itemId: (yield* readItem(item)).id,
          proformaNumber: proforma.number,
          ptdNumber: paymentRes.issued[0]?.number ?? null,
          finalNumber: finalInv.number,
          cnNumber: creditNote.number,
          deliveryId: delivery.deliveryId,
          shareToken: share.url,
          attachmentId: (yield* readAttachment(attachment)).id,
          scheduledHasSchedule: scheduled.schedule !== null,
          fromTplStatus: fromTpl.status,
          fxRate: BigDecimal.format(fxRate.rate),
          exportId: exportIntent.id,
        };
      }),
      options: {
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
    });

    const res = await Effect.runPromise(exit);
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
