import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { MCP_RESOURCES, MCP_TOOLS } from "@kvitbit/api-contract";
import { CoreStore } from "@kvitbit/core/ports";
import { StartedDeliveries } from "@kvitbit/core/testing";
import {
  BankAccountInput,
  ContactId,
  Contacts,
  CurrencyCode,
  DocumentId,
  Documents,
  ExpenseId,
  Expenses,
  IsoDate,
  PriceList,
  PriceListItemInput,
  PublicShareLinks,
  RequestKey,
  Templates,
  type WorkspaceId,
  Workspaces,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { RequestClaimCheck } from "../../src/persistence/CoreStoreSql";
import { makeMcpHarness } from "./harness";

setDefaultTimeout(15_000);

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const SAMPLE_ICO = "27082440";
const CONFIRMATION_TOKEN = /^mcpc_[A-Za-z0-9_-]{16,128}$/;
const DOCUMENTS_FROM = /\bFROM\s+"?documents\b/i;
const FOR_UPDATE = /\bFOR UPDATE\b/i;
const UUID_V7_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const IdField = Schema.Struct({ id: Schema.String });
const decodeId = Schema.decodeUnknownPromise(IdField);
const decodeRevisioned = Schema.decodeUnknownPromise(
  Schema.Struct({ id: Schema.String, revision: Schema.Int }),
);
const decodeRevision = Schema.decodeUnknownPromise(Schema.Struct({ revision: Schema.Int }));
const decodeConfirmationToken = Schema.decodeUnknownPromise(Schema.String);
const decodeList = Schema.decodeUnknownPromise(Schema.Array(Schema.Unknown));
const decodeIssues = Schema.decodeUnknownPromise(
  Schema.Struct({ issues: Schema.Array(Schema.Struct({ code: Schema.String })) }),
);
const decodeResourceId = Schema.decodeUnknownPromise(Schema.fromJsonString(IdField));
const decodeResourceList = Schema.decodeUnknownPromise(
  Schema.fromJsonString(Schema.Array(Schema.Unknown)),
);

const setupSeededWorkspace = async () => {
  const h = makeMcpHarness({
    registry: {
      [SAMPLE_ICO]: {
        name: "Alza.cz a.s.",
        dic: "CZ27082440",
        legalForm: "a.s.",
        address: {
          street: "Jankovcova 1522/53",
          city: "Praha 7",
          postalCode: "17000",
          country: "CZ",
        },
        registerEntry: "B 8573 vedená u Městského soudu v Praze",
        terminatedOn: null,
      },
    },
    fixings: [
      {
        fixingDate: IsoDate.make("2026-11-23"),
        sequence: 227,
        rates: [
          {
            code: CurrencyCode.make("EUR"),
            quantity: 1,
            rate: BigDecimal.fromStringUnsafe("25.35"),
          },
        ],
      },
    ],
  });
  cleanup = h.dispose;

  const owner = h.addUser("Owner");
  const ownerCaller = await h.createWorkspace(owner, {
    name: "Kvitbit Studio s.r.o.",
    taxRegime: "vat_payer",
    ico: "25596641",
    dic: "CZ25596641",
    address: { street: "Václavská 1", city: "Praha", postalCode: "11000", country: "CZ" },
  });

  // Seed a bank account, a price list item, a template, and an expense with attachment.
  const seeded = await h.run(
    Effect.gen(function* () {
      const ws = yield* Workspaces;
      const contacts = yield* Contacts;
      const priceList = yield* PriceList;
      const templates = yield* Templates;
      const expenses = yield* Expenses;

      const supplierContact = yield* contacts.save(ownerCaller, {
        name: "Office Depot s.r.o.",
        ico: "45274649",
        address: { city: "Praha", country: "CZ" },
        roles: ["supplier", "customer"],
      });
      const supplierContactId = yield* Schema.decodeUnknownEffect(ContactId)(supplierContact["id"]);

      yield* ws.saveBankAccount(
        ownerCaller,
        BankAccountInput.make({
          name: "Main CZK",
          currency: CurrencyCode.make("CZK"),
          iban: "CZ6508000000192000145399",
          bic: "GIBACZPX",
          isDefault: true,
        }),
      );

      yield* priceList.save(
        ownerCaller,
        PriceListItemInput.make({
          name: "Consulting hour",
          unit: "hod",
          unitPrice: BigDecimal.fromStringUnsafe("2000"),
          currency: CurrencyCode.make("CZK"),
          vat: "standard",
        }),
      );

      const expense = yield* expenses.record(ownerCaller, {
        status: "complete",
        supplier: { contact: supplierContactId },
        issuedOn: IsoDate.make("2026-11-10"),
        taxableSupplyOn: IsoDate.make("2026-11-10"),
        currency: CurrencyCode.make("CZK"),
        total: "1210.00",
        vat: [{ treatment: "standard", base: "1000.00", vat: "210.00" }],
        category: "office",
      });
      const expenseId = yield* Schema.decodeUnknownEffect(ExpenseId)(expense["id"]);

      const attachment = yield* expenses.attach(ownerCaller, expenseId, {
        name: "receipt.pdf",
        contentType: "application/pdf",
        bytes: Stream.make(new TextEncoder().encode("%PDF-1.4 receipt")),
      });
      const { id: attachmentId } = yield* Schema.decodeUnknownEffect(IdField)(attachment);

      const template = yield* templates.save(ownerCaller, {
        name: "Monthly Retainer",
        kind: "invoice",
        contact: supplierContactId,
        currency: CurrencyCode.make("CZK"),
        due: { inDays: 14 },
        lines: [
          {
            description: "Monthly advisory",
            quantity: BigDecimal.fromStringUnsafe("1"),
            unitPrice: BigDecimal.fromStringUnsafe("10000"),
            vat: "standard",
          },
        ],
      });
      const { id: templateId } = yield* Schema.decodeUnknownEffect(IdField)(template);

      return { supplierContactId, expenseId, attachmentId, templateId };
    }),
  );

  const rw = h.addReadWriteGrant(owner, ownerCaller.workspaceId, "en");
  const ro = h.addReadOnlyGrant(owner, ownerCaller.workspaceId, "en");
  const roCs = h.addReadOnlyGrant(owner, ownerCaller.workspaceId, "cs");

  return { h, ownerCaller, rw, ro, roCs, seeded };
};

describe("MCP 28 tools, 9 resources, two-step confirmation, and scope enforcement", () => {
  test("tools/list exposes all 28 tools for owner read_write and only 15 read tools for read-only grant", async () => {
    const { h, rw, ro } = await setupSeededWorkspace();

    const rwList = await h.rpc(rw.token, "tools/list");
    const { tools: rwTools } = await Schema.decodeUnknownPromise(
      Schema.Struct({
        tools: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            inputSchema: Schema.Unknown,
            outputSchema: Schema.Unknown,
          }),
        ),
      }),
    )(rwList.json["result"]);
    expect(Arr.map(rwTools, (t) => t.name)).toEqual(Arr.map(MCP_TOOLS, (t) => t.name));
    expect(rwTools).toHaveLength(28);
    for (const t of rwTools) {
      expect(t.inputSchema).toEqual(expect.any(Object));
      expect(t.outputSchema).toEqual(expect.any(Object));
    }

    const roList = await h.rpc(ro.token, "tools/list");
    const { tools: roTools } = await Schema.decodeUnknownPromise(
      Schema.Struct({
        tools: Schema.Array(
          Schema.Struct({ annotations: Schema.Struct({ readOnlyHint: Schema.Boolean }) }),
        ),
      }),
    )(roList.json["result"]);
    expect(roTools).toHaveLength(15);
    expect(Arr.every(roTools, (t) => t.annotations.readOnlyHint)).toBe(true);
  });

  test("read-only grant calling a write tool gets Forbidden with read-only reconnect wording (en & cs)", async () => {
    const { h, ro, roCs, seeded } = await setupSeededWorkspace();

    const enRes = await h.callTool(ro.token, "issue_document", {
      from: {
        input: {
          kind: "invoice",
          issuedOn: "2026-11-23",
          taxableSupplyOn: "2026-11-23",
          due: { inDays: 14 },
          currency: "CZK",
          contact: seeded.supplierContactId,
          lines: [{ description: "Work", quantity: "1", unitPrice: "1000", vat: "standard" }],
        },
      },
    });
    expect(enRes.result?.isError).toBe(true);
    expect(enRes.result?.structuredContent?.["error"]).toMatchObject({ _tag: "Forbidden" });
    expect(enRes.result?.content[0]?.["text"]).toContain(
      "This connection is read only. Reconnect Kvitbit with read and write access",
    );

    const csRes = await h.callTool(roCs.token, "create_draft", {
      kind: "invoice",
      issuedOn: "2026-11-23",
      taxableSupplyOn: "2026-11-23",
      due: { inDays: 14 },
      currency: "CZK",
      contact: seeded.supplierContactId,
      lines: [{ description: "Work", quantity: "1", unitPrice: "1000", vat: "standard" }],
    });
    expect(csRes.result?.isError).toBe(true);
    expect(csRes.result?.content[0]?.["text"]).toContain("pouze pro čtení");
  });

  test("all 28 tools execute end-to-end including two-step confirmation, replay, mismatch, expiry, and stale revision", async () => {
    const { h, ownerCaller, rw, seeded } = await setupSeededWorkspace();

    // 1. get_workspace
    const wsRes = await h.callTool(rw.token, "get_workspace");
    expect(wsRes.result?.isError).toBe(false);
    expect((await decodeList(wsRes.result?.structuredContent?.["series"])).length).toBeGreaterThan(
      0,
    );

    // 2. lookup_ares
    const aresRes = await h.callTool(rw.token, "lookup_ares", { ico: SAMPLE_ICO });
    expect(aresRes.result?.isError).toBe(false);
    expect(aresRes.result?.structuredContent).toMatchObject({ name: "Alza.cz a.s." });

    // 3. upsert_contact (fromIco + create + update)
    const contactFromIco = await h.callTool(rw.token, "upsert_contact", {
      ico: SAMPLE_ICO,
      role: "customer",
    });
    expect(contactFromIco.result?.isError).toBe(false);
    const { id: contactId, revision: contactRev } = await decodeRevisioned(
      contactFromIco.result?.structuredContent?.["contact"],
    );

    const contactUpdated = await h.callTool(rw.token, "upsert_contact", {
      contactId,
      revision: contactRev,
      contact: {
        name: "Alza.cz a.s.",
        ico: SAMPLE_ICO,
        dic: "CZ27082440",
        billingEmails: ["fakturace@alza.cz"],
        roles: ["customer"],
      },
      idempotencyKey: "upsert-contact-key-01",
    });
    expect(contactUpdated.result?.isError).toBe(false);

    // 4. list_contacts
    const listContacts = await h.callTool(rw.token, "list_contacts", { text: "Alza" });
    expect(listContacts.result?.isError).toBe(false);
    expect(listContacts.result?.structuredContent?.["items"]).toHaveLength(1);

    // 5. list_price_list_items
    const priceList = await h.callTool(rw.token, "list_price_list_items");
    expect(priceList.result?.isError).toBe(false);
    expect(priceList.result?.structuredContent?.["items"]).toHaveLength(1);

    // 6. list_invoice_templates
    const templatesRes = await h.callTool(rw.token, "list_invoice_templates");
    expect(templatesRes.result?.isError).toBe(false);
    expect(templatesRes.result?.structuredContent?.["items"]).toHaveLength(1);

    // 7. list_expenses & 8. get_expense & 9. record_expense
    const listExp = await h.callTool(rw.token, "list_expenses", { incomplete: false });
    expect(listExp.result?.isError).toBe(false);
    const getExp = await h.callTool(rw.token, "get_expense", { expenseId: seeded.expenseId });
    expect(getExp.result?.isError).toBe(false);
    const recExp = await h.callTool(rw.token, "record_expense", {
      expense: {
        status: "incomplete",
        supplier: { manual: { name: "Taxi" } },
        issuedOn: "2026-11-20",
        currency: "CZK",
      },
      idempotencyKey: "record-exp-0001",
    });
    expect(recExp.result?.isError).toBe(false);

    // 10. get_fx_rate
    const fxRes = await h.callTool(rw.token, "get_fx_rate", {
      currency: "EUR",
      on: "2026-11-23",
    });
    expect(fxRes.result?.isError).toBe(false);

    // 11. create_draft & 12. update_draft
    const draftRes = await h.callTool(rw.token, "create_draft", {
      kind: "invoice",
      issuedOn: "2026-11-23",
      taxableSupplyOn: "2026-11-23",
      due: { inDays: 14 },
      currency: "CZK",
      contact: contactId,
      lines: [{ description: "Consulting", quantity: "2", unitPrice: "2000", vat: "standard" }],
      idempotencyKey: "draft-key-00001",
    });
    expect(draftRes.result?.isError).toBe(false);
    const draftDoc = await decodeRevisioned(draftRes.result?.structuredContent?.["document"]);

    const updatedDraft = await h.callTool(rw.token, "update_draft", {
      documentId: draftDoc.id,
      revision: draftDoc.revision,
      patch: { note: "Updated via MCP" },
    });
    expect(updatedDraft.result?.isError).toBe(false);
    const { revision: draftRev2 } = await decodeRevision(
      updatedDraft.result?.structuredContent?.["document"],
    );

    // 13. issue_document (two-step: preview -> malformed -> mismatch -> invalid -> confirm -> replay)
    const issueArgs = { from: { draft: draftDoc.id, revision: draftRev2 } };

    // Malformed confirm (confirm: true without token)
    const malformed = await h.callTool(rw.token, "issue_document", {
      ...issueArgs,
      confirm: true,
    });
    expect(malformed.result?.isError).toBe(true);
    expect(
      (await decodeIssues(malformed.result?.structuredContent?.["error"])).issues[0]?.code,
    ).toBe("mcp.confirmation_required");

    // Preview step
    const issuePreview = await h.callTool(rw.token, "issue_document", issueArgs);
    expect(issuePreview.result?.isError).toBe(false);
    expect(issuePreview.result?.structuredContent?.["_tag"]).toBe("ConfirmationRequired");
    const issueToken = await decodeConfirmationToken(
      issuePreview.result?.structuredContent?.["confirmationToken"],
    );
    expect(issueToken).toMatch(CONFIRMATION_TOKEN);

    // Mismatch (changed args after preview)
    const mismatch = await h.callTool(rw.token, "issue_document", {
      ...issueArgs,
      send: { to: ["changed@example.cz"] },
      confirm: true,
      confirmationToken: issueToken,
    });
    expect(mismatch.result?.isError).toBe(true);
    expect(
      (await decodeIssues(mismatch.result?.structuredContent?.["error"])).issues[0]?.code,
    ).toBe("mcp.confirmation_mismatch");

    // Invalid (wrong tool using issueToken)
    const wrongTool = await h.callTool(rw.token, "send_document", {
      documentId: draftDoc.id,
      confirm: true,
      confirmationToken: issueToken,
    });
    expect(wrongTool.result?.isError).toBe(true);
    expect(
      (await decodeIssues(wrongTool.result?.structuredContent?.["error"])).issues[0]?.code,
    ).toBe("mcp.confirmation_invalid");

    // Confirm step
    const issueConfirmed = await h.callTool(rw.token, "issue_document", {
      ...issueArgs,
      confirm: true,
      confirmationToken: issueToken,
    });
    expect(issueConfirmed.result?.isError).toBe(false);
    expect(issueConfirmed.result?.structuredContent?.["_tag"]).toBe("Confirmed");
    const { document: issuedDoc } = await Schema.decodeUnknownPromise(
      Schema.Struct({
        document: Schema.Struct({ id: DocumentId, status: Schema.String, number: Schema.String }),
      }),
    )(issueConfirmed.result?.structuredContent?.["result"]);
    expect(issuedDoc.status).toBe("issued");
    expect(issuedDoc.number).toBeTruthy();

    const issueReplay = await h.callTool(rw.token, "issue_document", {
      ...issueArgs,
      confirm: true,
      confirmationToken: issueToken,
    });
    expect(issueReplay.result).toEqual(issueConfirmed.result);

    // update_draft on issued document -> Conflict{illegal_transition}
    const editIssued = await h.callTool(rw.token, "update_draft", {
      documentId: issuedDoc.id,
      revision: 1,
      patch: { note: "Should fail" },
    });
    expect(editIssued.result?.isError).toBe(true);
    expect(editIssued.result?.structuredContent?.["error"]).toMatchObject({
      _tag: "Conflict",
      reason: "illegal_transition",
    });

    // 14. list_documents, 15. get_document, 16. get_document_history, 17. get_document_pdf, 18. get_share_link
    const listDocs = await h.callTool(rw.token, "list_documents", { status: "issued" });
    expect(listDocs.result?.isError).toBe(false);
    expect(
      (await decodeList(listDocs.result?.structuredContent?.["items"])).length,
    ).toBeGreaterThanOrEqual(1);

    const getDoc = await h.callTool(rw.token, "get_document", { documentId: issuedDoc.id });
    expect(getDoc.result?.isError).toBe(false);

    const history = await h.callTool(rw.token, "get_document_history", {
      documentId: issuedDoc.id,
    });
    expect(history.result?.isError).toBe(false);
    expect((await decodeList(history.result?.structuredContent?.["items"])).length).toBeGreaterThan(
      0,
    );

    const pdf = await h.callTool(rw.token, "get_document_pdf", { documentId: issuedDoc.id });
    expect(pdf.result?.isError).toBe(false);
    expect(pdf.result?.structuredContent?.["embedded"]).toBe(true);
    expect(Arr.some(pdf.result?.content ?? [], (c) => c["type"] === "resource_link")).toBe(true);
    expect(Arr.some(pdf.result?.content ?? [], (c) => c["type"] === "resource")).toBe(true);

    // Create a share link in core and read via get_share_link
    await h.run(
      Effect.gen(function* () {
        const shareLinks = yield* PublicShareLinks;
        return yield* shareLinks.create(ownerCaller, issuedDoc.id);
      }),
    );
    const shareRes = await h.callTool(rw.token, "get_share_link", { documentId: issuedDoc.id });
    expect(shareRes.result?.isError).toBe(false);
    expect(shareRes.result?.structuredContent).toMatchObject({
      share: { url: expect.any(String) },
    });

    // 19. send_document (two-step) & 20. send_reminder (two-step)
    const sendPreview = await h.callTool(rw.token, "send_document", {
      documentId: issuedDoc.id,
      to: ["fakturace@alza.cz"],
    });
    expect(sendPreview.result?.isError).toBe(false);
    const sendToken = await decodeConfirmationToken(
      sendPreview.result?.structuredContent?.["confirmationToken"],
    );
    const sendConfirm = await h.callTool(rw.token, "send_document", {
      documentId: issuedDoc.id,
      to: ["fakturace@alza.cz"],
      confirm: true,
      confirmationToken: sendToken,
    });
    expect(sendConfirm.result?.isError).toBe(false);
    expect(sendConfirm.result?.structuredContent?.["_tag"]).toBe("Confirmed");

    const remPreview = await h.callTool(rw.token, "send_reminder", {
      documentId: issuedDoc.id,
      to: ["fakturace@alza.cz"],
    });
    expect(remPreview.result?.isError).toBe(false);
    const remToken = await decodeConfirmationToken(
      remPreview.result?.structuredContent?.["confirmationToken"],
    );
    const remConfirm = await h.callTool(rw.token, "send_reminder", {
      documentId: issuedDoc.id,
      to: ["fakturace@alza.cz"],
      confirm: true,
      confirmationToken: remToken,
    });
    expect(remConfirm.result?.isError).toBe(false);

    // 21. record_payment & 22. list_payments
    const payRes = await h.callTool(rw.token, "record_payment", {
      target: { document: issuedDoc.id },
      paidOn: "2026-11-23",
      method: "bank_transfer",
      idempotencyKey: "pay-key-00001",
    });
    expect(payRes.result?.isError).toBe(false);
    expect(payRes.result?.structuredContent?.["settlement"]).toBe("paid");

    const listPay = await h.callTool(rw.token, "list_payments", {
      target: { document: issuedDoc.id },
    });
    expect(listPay.result?.isError).toBe(false);
    expect(listPay.result?.structuredContent?.["items"]).toHaveLength(1);

    // 23. create_credit_note (two-step) & 24. lock_document
    const cnPreview = await h.callTool(rw.token, "create_credit_note", {
      documentId: issuedDoc.id,
      reason: "Discount agreed",
      lines: "full",
      correctedOn: "2026-11-23",
    });
    expect(cnPreview.result?.isError).toBe(false);
    const cnToken = await decodeConfirmationToken(
      cnPreview.result?.structuredContent?.["confirmationToken"],
    );
    const cnConfirm = await h.callTool(rw.token, "create_credit_note", {
      documentId: issuedDoc.id,
      reason: "Discount agreed",
      lines: "full",
      correctedOn: "2026-11-23",
      confirm: true,
      confirmationToken: cnToken,
    });
    expect(cnConfirm.result?.isError).toBe(false);
    expect(cnConfirm.result?.structuredContent?.["_tag"]).toBe("Confirmed");

    // The request log must replay even when correction changes the source revision.
    const cnReplay = await h.callTool(rw.token, "create_credit_note", {
      documentId: issuedDoc.id,
      reason: "Discount agreed",
      lines: "full",
      correctedOn: "2026-11-23",
      confirm: true,
      confirmationToken: cnToken,
    });
    expect(cnReplay.result).toEqual(cnConfirm.result);

    const lockRes = await h.callTool(rw.token, "lock_document", { documentId: issuedDoc.id });
    expect(lockRes.result?.isError).toBe(false);

    // 25. settle_proforma & 26. create_final_invoice (two-step)
    const proformaPreview = await h.callTool(rw.token, "issue_document", {
      from: {
        input: {
          kind: "proforma",
          issuedOn: "2026-11-23",
          due: { inDays: 14 },
          currency: "CZK",
          contact: contactId,
          lines: [{ description: "Advance", quantity: "1", unitPrice: "5000", vat: "standard" }],
        },
      },
    });
    const proformaToken = await decodeConfirmationToken(
      proformaPreview.result?.structuredContent?.["confirmationToken"],
    );
    const proformaConfirm = await h.callTool(rw.token, "issue_document", {
      from: {
        input: {
          kind: "proforma",
          issuedOn: "2026-11-23",
          due: { inDays: 14 },
          currency: "CZK",
          contact: contactId,
          lines: [{ description: "Advance", quantity: "1", unitPrice: "5000", vat: "standard" }],
        },
      },
      confirm: true,
      confirmationToken: proformaToken,
    });
    expect(proformaConfirm.result?.isError).toBe(false);
    const {
      document: { id: proformaId },
    } = await Schema.decodeUnknownPromise(Schema.Struct({ document: IdField }))(
      proformaConfirm.result?.structuredContent?.["result"],
    );

    const settleRes = await h.callTool(rw.token, "settle_proforma", {
      proformaId,
      paidOn: "2026-11-23",
      method: "bank_transfer",
      idempotencyKey: "settle-pf-001",
    });
    expect(settleRes.result?.isError).toBe(false);
    expect(settleRes.result?.structuredContent?.["issued"]).toHaveLength(1);

    const fiPreview = await h.callTool(rw.token, "create_final_invoice", { proformaId });
    expect(fiPreview.result?.isError).toBe(false);
    const fiToken = await decodeConfirmationToken(
      fiPreview.result?.structuredContent?.["confirmationToken"],
    );
    const fiConfirm = await h.callTool(rw.token, "create_final_invoice", {
      proformaId,
      confirm: true,
      confirmationToken: fiToken,
    });
    expect(fiConfirm.result?.isError).toBe(false);
    expect(fiConfirm.result?.structuredContent?.["_tag"]).toBe("Confirmed");

    // 27. create_from_template (single-call draft + two-step issued)
    const { templateId } = seeded;
    const tplDraft = await h.callTool(rw.token, "create_from_template", {
      templateId,
      as: "draft",
      patch: { contact: contactId },
      idempotencyKey: "tpl-draft-001",
    });
    expect(tplDraft.result?.isError).toBe(false);
    expect(tplDraft.result?.structuredContent?.["document"]).toMatchObject({ status: "draft" });

    const tplIssueArgs = {
      templateId,
      as: "issued",
      patch: {
        contact: contactId,
        due: { inDays: 7 },
        lines: [
          { description: "Adjusted retainer", quantity: "1", unitPrice: "2000", vat: "standard" },
        ],
      },
    };
    const tplIssuePreview = await h.callTool(rw.token, "create_from_template", tplIssueArgs);
    expect(tplIssuePreview.result?.isError).toBe(false);
    expect(tplIssuePreview.result?.structuredContent?.["_tag"]).toBe("ConfirmationRequired");
    expect(tplIssuePreview.result?.structuredContent?.["summary"]).toMatchObject({
      document: { contact: "Alza.cz a.s.", currency: "CZK", total: "2420", dueOn: "2026-11-30" },
    });
    const tplToken = await decodeConfirmationToken(
      tplIssuePreview.result?.structuredContent?.["confirmationToken"],
    );
    const tplIssueConfirm = await h.callTool(rw.token, "create_from_template", {
      ...tplIssueArgs,
      confirm: true,
      confirmationToken: tplToken,
    });
    expect(tplIssueConfirm.result?.isError).toBe(false);
    expect(tplIssueConfirm.result?.structuredContent?.["_tag"]).toBe("Confirmed");

    // 28. get_report (including `vat` alias -> `vat_summary`)
    const reportRes = await h.callTool(rw.token, "get_report", {
      report: "vat",
      from: "2026-11-01",
      to: "2026-11-30",
    });
    expect(reportRes.result?.isError).toBe(false);
    expect(reportRes.result?.structuredContent?.["report"]).toBe("vat_summary");
  });

  test("confirming a Payment Tax Document credit locks its Proforma first", async () => {
    const { h, rw, ownerCaller, seeded } = await setupSeededWorkspace();
    const proforma = await h.run(
      Effect.flatMap(Documents, (documents) =>
        documents.issue(ownerCaller, {
          input: {
            kind: "proforma",
            contact: seeded.supplierContactId,
            lines: [
              {
                description: "Advance",
                unitPrice: BigDecimal.fromStringUnsafe("5000"),
                vat: "standard",
              },
            ],
          },
        }),
      ),
    );
    const settled = await h.callTool(rw.token, "settle_proforma", {
      proformaId: proforma.id,
      paidOn: "2026-11-23",
      method: "bank_transfer",
    });
    expect(settled.result?.isError).toBe(false);
    const issued = await Schema.decodeUnknownPromise(Schema.Array(IdField))(
      settled.result?.structuredContent?.["issued"],
    );
    const ptdId = issued[0]?.id;
    expect(ptdId).toBeDefined();

    const args = { documentId: ptdId, lines: "full", reason: "Refund agreed" };
    const preview = await h.callTool(rw.token, "create_credit_note", args);
    expect(preview.result?.structuredContent?.["_tag"]).toBe("ConfirmationRequired");
    const locked: unknown[] = [];
    const instance = h.createInstance((statement) => {
      const [query, params] = statement.compile();
      if (DOCUMENTS_FROM.test(query) && FOR_UPDATE.test(query)) {
        locked.push(
          Option.getOrUndefined(Arr.findFirst(params, (id) => id === proforma.id || id === ptdId)),
        );
      }
      return Effect.succeed(statement);
    });
    const confirmed = await instance.callTool(rw.token, "create_credit_note", {
      ...args,
      confirmationToken: preview.result?.structuredContent?.["confirmationToken"],
      confirm: true,
    });
    expect(confirmed.result?.structuredContent?.["_tag"]).toBe("Confirmed");
    expect(locked.slice(0, 2)).toEqual([proforma.id, ptdId]);
  });

  test("separate instances replay the same write through expiry and reject an expired log", async () => {
    const { h, rw, ro, seeded } = await setupSeededWorkspace();
    const second = h.createInstance();
    const args = {
      from: {
        input: {
          kind: "invoice",
          contact: seeded.supplierContactId,
          currency: "EUR",
          lines: [{ description: "Consulting", quantity: "1", unitPrice: "100", vat: "standard" }],
        },
      },
      send: { to: ["recipient@example.cz"], language: "cs" },
    };
    const preview = await h.callTool(rw.token, "issue_document", args);
    expect(preview.result?.structuredContent?.["warnings"]).toEqual([
      "document.no_bank_account_for_currency",
    ]);
    const token = preview.result?.structuredContent?.["confirmationToken"];
    expect(token).toEqual(expect.any(String));

    const inspect = () =>
      h.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [confirmation] = yield* sql<{
            id: string;
            token_hash: string;
            consumed_at: Date | null;
          }>`SELECT id, token_hash, consumed_at FROM mcp_confirmations`;
          const [writes] = yield* sql<{ documents: number; deliveries: number; requests: number }>`
          SELECT
            (SELECT count(*)::int FROM documents) documents,
            (SELECT count(*)::int FROM deliveries) deliveries,
            (SELECT count(*)::int FROM request_log WHERE request_key LIKE 'mcp-confirm:%') requests
        `;
          return { confirmation, writes };
        }),
      );

    const before = await inspect();
    expect(before.confirmation?.id).toMatch(UUID_V7_PREFIX);
    expect(before.confirmation?.token_hash).toMatch(SHA256_HEX);
    expect(before.confirmation?.token_hash).not.toBe(token);
    expect(before.confirmation?.consumed_at).toBeNull();
    expect(before.writes).toEqual({ documents: 0, deliveries: 0, requests: 0 });

    // Object key order does not change the canonical approval hash.
    const confirm = { confirmationToken: token, confirm: true, send: args.send, from: args.from };
    const wrongGrant = await second.callTool(ro.token, "issue_document", confirm);
    expect(wrongGrant.result?.structuredContent?.["error"]).toMatchObject({
      issues: [{ code: "mcp.confirmation_invalid" }],
    });
    const [first, concurrent] = await Promise.all([
      h.callTool(rw.token, "issue_document", confirm),
      second.callTool(rw.token, "issue_document", confirm),
    ]);
    expect(first.result?.structuredContent?.["_tag"]).toBe("Confirmed");
    expect(concurrent.result).toEqual(first.result);
    const committed = await inspect();
    expect(committed.confirmation?.consumed_at).toBeInstanceOf(Date);
    expect(committed.writes).toEqual({ documents: 1, deliveries: 1, requests: 1 });
    expect(await h.run(Effect.flatMap(StartedDeliveries, Ref.get))).toHaveLength(1);

    await second.dispose();
    await h.run(TestClock.adjust(Duration.minutes(11)));
    const restarted = h.createInstance();
    const replay = await restarted.callTool(rw.token, "issue_document", confirm);
    expect(replay.result).toEqual(first.result);
    const reducedGrant = h.addGrant({ ...rw, scopes: ro.scopes, token: "reduced-scopes" });
    const forbiddenReplay = await restarted.callTool(reducedGrant.token, "issue_document", confirm);
    expect(forbiddenReplay.result?.structuredContent?.["error"]).toMatchObject({
      _tag: "Forbidden",
      action: "document.issue",
    });

    await h.run(TestClock.adjust(Duration.hours(24)));
    const expired = await restarted.callTool(rw.token, "issue_document", confirm);
    expect(expired.result?.structuredContent?.["error"]).toMatchObject({
      issues: [{ code: "mcp.confirmation_expired" }],
    });
    expect(await inspect()).toEqual(committed);

    // Housekeeping can also have purged the result already.
    await h.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM request_log WHERE request_key LIKE 'mcp-confirm:%'`;
      }),
    );
    const missing = await restarted.callTool(rw.token, "issue_document", confirm);
    expect(missing.result).toEqual(expired.result);
    expect((await inspect()).writes).toEqual({ documents: 1, deliveries: 1, requests: 0 });
  });

  test("a failed core commit leaves approval, number and outbox available for retry", async () => {
    const { h, rw, seeded } = await setupSeededWorkspace();
    const args = {
      from: {
        input: {
          kind: "invoice",
          contact: seeded.supplierContactId,
          lines: [{ description: "Consulting", quantity: "1", unitPrice: "100", vat: "standard" }],
        },
      },
      send: { to: ["recipient@example.cz"] },
    };
    const preview = await h.callTool(rw.token, "issue_document", args);
    expect(preview.result?.structuredContent?.["warnings"]).toEqual([]);
    const confirm = {
      ...args,
      confirm: true,
      confirmationToken: preview.result?.structuredContent?.["confirmationToken"],
    };

    await h.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
        CREATE FUNCTION reject_test_confirmation_completion() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'test: request completion failed';
        END;
        $$
      `;
        yield* sql`
        CREATE TRIGGER reject_test_confirmation_completion BEFORE UPDATE ON request_log
        FOR EACH ROW WHEN (NEW.request_key LIKE 'mcp-confirm:%')
        EXECUTE FUNCTION reject_test_confirmation_completion()
      `;
      }),
    );

    const failed = await h.callTool(rw.token, "issue_document", confirm);
    expect(failed.result?.structuredContent?.["error"]).toMatchObject({ _tag: "Unavailable" });
    const rollback = await h.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql`
        SELECT consumed_at,
          (SELECT count(*)::int FROM documents) documents,
          (SELECT count(*)::int FROM deliveries) deliveries,
          (SELECT count(*)::int FROM request_log WHERE request_key LIKE 'mcp-confirm:%') requests
        FROM mcp_confirmations
      `;
      }),
    );
    expect(rollback).toEqual([{ consumed_at: null, documents: 0, deliveries: 0, requests: 0 }]);
    expect(await h.run(Effect.flatMap(StartedDeliveries, Ref.get))).toEqual([]);
    await h.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DROP TRIGGER reject_test_confirmation_completion ON request_log`;
      }),
    );

    const retry = await h.createInstance().callTool(rw.token, "issue_document", confirm);
    expect(retry.result?.structuredContent?.["_tag"]).toBe("Confirmed");
    expect(await h.run(Effect.flatMap(StartedDeliveries, Ref.get))).toHaveLength(1);
  });

  test("the claim check runs after the matching workspace claim in its transaction", async () => {
    const h = makeMcpHarness();
    cleanup = h.dispose;
    const first = await h.createWorkspace(h.addUser("Owner A"), { name: "Workspace A" });
    const other = await h.createWorkspace(h.addUser("Owner B"), { name: "Workspace B" });
    const requestKey = RequestKey.make("mcp-confirm:claim-hook-test");
    const now = "2026-11-23T10:00:00.000Z";
    const observed: Array<{ inTransaction: boolean; replayed: boolean; hasClaim: boolean }> = [];

    await h.run(
      Effect.gen(function* () {
        const store = yield* CoreStore;
        const sql = yield* SqlClient.SqlClient;
        const claim = (workspaceId: WorkspaceId, key: RequestKey) =>
          store.transaction(
            Effect.gen(function* () {
              const scope = { _tag: "Workspace", workspaceId } as const;
              const outcome = yield* store.requestLog.claim(scope, key, now);
              if (outcome._tag === "Claimed") {
                yield* store.requestLog.complete({
                  scope,
                  key,
                  method: "test",
                  fingerprint: "test",
                  result: null,
                  createdAt: now,
                  expiresAt: "2026-11-24T10:00:00.000Z",
                });
              }
            }),
          );

        yield* Effect.gen(function* () {
          yield* claim(other.workspaceId, requestKey);
          yield* claim(first.workspaceId, RequestKey.make("unrelated"));
          expect(observed).toEqual([]);
          yield* claim(first.workspaceId, requestKey);
          yield* claim(first.workspaceId, requestKey);
        }).pipe(
          Effect.provideService(RequestClaimCheck, {
            workspaceId: first.workspaceId,
            requestKey,
            check: (replayed) =>
              Effect.gen(function* () {
                const transaction = yield* Effect.serviceOption(sql.transactionService);
                const matching = yield* sql`
                  SELECT 1 FROM request_log
                  WHERE workspace_id = ${first.workspaceId} AND request_key = ${requestKey}
                `.pipe(Effect.orDie);
                observed.push({
                  inTransaction: Option.isSome(transaction) && transaction.value[1] === 0,
                  replayed,
                  hasClaim: matching.length === 1,
                });
              }),
          }),
        );
      }),
    );
    expect(observed).toEqual([
      { inTransaction: true, replayed: false, hasClaim: true },
      { inTransaction: true, replayed: true, hasClaim: true },
    ]);
  });

  test("expired confirmation token and stale revision between preview and confirm fail cleanly", async () => {
    const { h, ownerCaller, rw } = await setupSeededWorkspace();

    const contact = await h.callTool(rw.token, "upsert_contact", {
      ico: SAMPLE_ICO,
      role: "customer",
    });
    const { id: contactId } = await decodeId(contact.result?.structuredContent?.["contact"]);

    // Issue a document first so we can test send_document stale revision + token expiry
    const preview1 = await h.callTool(rw.token, "issue_document", {
      from: {
        input: {
          kind: "invoice",
          issuedOn: "2026-11-23",
          taxableSupplyOn: "2026-11-23",
          due: { inDays: 14 },
          currency: "CZK",
          contact: contactId,
          lines: [{ description: "Item", quantity: "1", unitPrice: "100", vat: "standard" }],
        },
      },
    });
    const tok1 = await decodeConfirmationToken(
      preview1.result?.structuredContent?.["confirmationToken"],
    );
    const confirmed1 = await h.callTool(rw.token, "issue_document", {
      from: {
        input: {
          kind: "invoice",
          issuedOn: "2026-11-23",
          taxableSupplyOn: "2026-11-23",
          due: { inDays: 14 },
          currency: "CZK",
          contact: contactId,
          lines: [{ description: "Item", quantity: "1", unitPrice: "100", vat: "standard" }],
        },
      },
      confirm: true,
      confirmationToken: tok1,
    });
    const { document: doc } = await Schema.decodeUnknownPromise(
      Schema.Struct({ document: Schema.Struct({ id: DocumentId, revision: Schema.Int }) }),
    )(confirmed1.result?.structuredContent?.["result"]);

    // Preview send_document, then edit document in core (bumping revision), then confirm -> Conflict{revision_changed}
    const sendPrev = await h.callTool(rw.token, "send_document", {
      documentId: doc.id,
      to: ["buyer@example.cz"],
    });
    const sendTok = await decodeConfirmationToken(
      sendPrev.result?.structuredContent?.["confirmationToken"],
    );

    await h.run(
      Effect.gen(function* () {
        const docs = yield* Documents;
        return yield* docs.edit(ownerCaller, doc.id, { note: "Concurrent edit" }, doc.revision);
      }),
    );

    const staleConfirm = await h.callTool(rw.token, "send_document", {
      documentId: doc.id,
      to: ["buyer@example.cz"],
      confirm: true,
      confirmationToken: sendTok,
    });
    expect(staleConfirm.result?.isError).toBe(true);
    expect(staleConfirm.result?.structuredContent?.["error"]).toMatchObject({
      _tag: "Conflict",
      reason: "revision_changed",
    });

    // Advance TestClock past 10-minute TTL -> Invalid{mcp.confirmation_expired}
    const freshPrev = await h.callTool(rw.token, "send_document", {
      documentId: doc.id,
      to: ["buyer@example.cz"],
    });
    const expTok = await decodeConfirmationToken(
      freshPrev.result?.structuredContent?.["confirmationToken"],
    );
    await h.run(TestClock.adjust(Duration.minutes(11)));

    const expiredConfirm = await h.callTool(rw.token, "send_document", {
      documentId: doc.id,
      to: ["buyer@example.cz"],
      confirm: true,
      confirmationToken: expTok,
    });
    expect(expiredConfirm.result?.isError).toBe(true);
    expect(
      (await decodeIssues(expiredConfirm.result?.structuredContent?.["error"])).issues[0]?.code,
    ).toBe("mcp.confirmation_expired");
  });

  test("all 9 MCP resources list and read properly (4 static + 5 templates)", async () => {
    const { h, rw, seeded } = await setupSeededWorkspace();

    // List 4 static resources
    const staticList = await h.rpc(rw.token, "resources/list");
    const { resources: statics } = await Schema.decodeUnknownPromise(
      Schema.Struct({ resources: Schema.Array(Schema.Struct({ uri: Schema.String })) }),
    )(staticList.json["result"]);
    expect(Arr.map(statics, (r) => r.uri)).toEqual(
      Arr.map(
        Arr.filter(MCP_RESOURCES, (r) => r.kind === "static"),
        (r) => r.uri,
      ),
    );
    expect(statics).toHaveLength(4);

    // List 5 resource templates
    const tmplList = await h.rpc(rw.token, "resources/templates/list");
    const { resourceTemplates: templates } = await Schema.decodeUnknownPromise(
      Schema.Struct({
        resourceTemplates: Schema.Array(Schema.Struct({ uriTemplate: Schema.String })),
      }),
    )(tmplList.json["result"]);
    expect(Arr.map(templates, (r) => r.uriTemplate)).toEqual(
      Arr.map(
        Arr.filter(MCP_RESOURCES, (r) => r.kind === "template"),
        (r) => r.uri,
      ),
    );
    expect(templates).toHaveLength(5);

    // Seed contact and document to read template URIs
    const contactRes = await h.callTool(rw.token, "upsert_contact", { ico: SAMPLE_ICO });
    const { id: contactId } = await decodeId(contactRes.result?.structuredContent?.["contact"]);
    const draftRes = await h.callTool(rw.token, "create_draft", {
      kind: "invoice",
      issuedOn: "2026-11-23",
      taxableSupplyOn: "2026-11-23",
      due: { inDays: 14 },
      currency: "CZK",
      contact: contactId,
      lines: [{ description: "Service", quantity: "1", unitPrice: "500", vat: "standard" }],
    });
    const { id: docId } = await decodeId(draftRes.result?.structuredContent?.["document"]);
    const { expenseId, attachmentId } = seeded;

    // 1. kvitbit://workspace
    const r1 = await h.readResource(rw.token, "kvitbit://workspace");
    expect(r1.contents?.[0]?.["mimeType"]).toBe("application/json");
    const workspace = await Schema.decodeUnknownPromise(
      Schema.fromJsonString(Schema.Struct({ name: Schema.String })),
    )(r1.contents?.[0]?.["text"]);
    expect(workspace.name).toBe("Kvitbit Studio s.r.o.");

    // 2. kvitbit://templates
    const r2 = await h.readResource(rw.token, "kvitbit://templates");
    expect(r2.contents?.[0]?.["mimeType"]).toBe("application/json");
    expect(await decodeResourceList(r2.contents?.[0]?.["text"])).toHaveLength(1);

    // 3. kvitbit://price-list
    const r3 = await h.readResource(rw.token, "kvitbit://price-list");
    expect(r3.contents?.[0]?.["mimeType"]).toBe("application/json");
    expect(await decodeResourceList(r3.contents?.[0]?.["text"])).toHaveLength(1);

    // 4. kvitbit://guide
    const r4 = await h.readResource(rw.token, "kvitbit://guide");
    expect(r4.contents?.[0]?.["mimeType"]).toBe("text/markdown");
    expect(String(r4.contents?.[0]?.["text"] ?? "")).toContain("VatTreatment");

    // 5. kvitbit://documents/{documentId}
    const r5 = await h.readResource(rw.token, `kvitbit://documents/${docId}`);
    expect(r5.contents?.[0]?.["mimeType"]).toBe("application/json");
    expect((await decodeResourceId(r5.contents?.[0]?.["text"])).id).toBe(docId);

    // 6. kvitbit://documents/{documentId}/pdf{?template,language}
    const r6 = await h.readResource(rw.token, `kvitbit://documents/${docId}/pdf?language=en`);
    expect(r6.contents?.[0]?.["mimeType"]).toBe("application/pdf");
    expect(r6.contents?.[0]?.["blob"]).toEqual(expect.any(String));
    expect(String(r6.contents?.[0]?.["blob"] ?? "").length).toBeGreaterThan(0);

    // 7. kvitbit://contacts/{contactId}
    const r7 = await h.readResource(rw.token, `kvitbit://contacts/${contactId}`);
    expect(r7.contents?.[0]?.["mimeType"]).toBe("application/json");
    expect((await decodeResourceId(r7.contents?.[0]?.["text"])).id).toBe(contactId);

    // 8. kvitbit://expenses/{expenseId}
    const r8 = await h.readResource(rw.token, `kvitbit://expenses/${expenseId}`);
    expect(r8.contents?.[0]?.["mimeType"]).toBe("application/json");
    expect((await decodeResourceId(r8.contents?.[0]?.["text"])).id).toBe(expenseId);

    // 9. kvitbit://expenses/{expenseId}/attachments/{attachmentId}
    const r9 = await h.readResource(
      rw.token,
      `kvitbit://expenses/${expenseId}/attachments/${attachmentId}`,
    );
    expect(r9.contents?.[0]?.["mimeType"]).toBe("application/pdf");
    expect(Buffer.from(String(r9.contents?.[0]?.["blob"] ?? ""), "base64").toString("utf8")).toBe(
      "%PDF-1.4 receipt",
    );

    // Unknown URI -> -32602
    const unknown = await h.readResource(rw.token, "kvitbit://unknown/thing");
    expect(unknown.error?.code).toBe(-32602);
  });
});
