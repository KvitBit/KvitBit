import { afterEach, describe, expect, test } from "bun:test";
import { MCP_RESOURCES, MCP_TOOLS } from "@kvitbit/api-contract";
import {
  Contacts,
  CurrencyCode,
  CurrentCaller,
  Documents,
  Expenses,
  IsoDate,
  PriceList,
  PublicShareLinks,
  Templates,
  Workspaces,
} from "@kvitbit/domain/contract";
import { BigDecimal, Duration, Effect, Stream } from "effect";
import { TestClock } from "effect/testing";
import { makeMcpHarness } from "./harness";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const SAMPLE_ICO = "27082440";

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

      const supplierContact = yield* contacts.save({
        name: "Office Depot s.r.o.",
        ico: "45274649",
        address: { city: "Praha", country: "CZ" },
        roles: ["supplier", "customer"],
      });

      const bankAccount = yield* ws.saveBankAccount({
        name: "Main CZK",
        currency: CurrencyCode.make("CZK"),
        iban: "CZ6508000000192000145399",
        bic: "GIBACZPX",
        isDefault: true,
      } as never);

      const item = yield* priceList.save({
        name: "Consulting hour",
        unit: "hod",
        unitPrice: BigDecimal.fromStringUnsafe("2000"),
        currency: CurrencyCode.make("CZK"),
        vat: "standard",
      } as never);

      const expense = yield* expenses.record({
        status: "complete",
        supplier: { contact: supplierContact.id },
        issuedOn: IsoDate.make("2026-11-10"),
        taxableSupplyOn: IsoDate.make("2026-11-10"),
        currency: CurrencyCode.make("CZK"),
        total: "1210.00",
        vat: [{ treatment: "standard", base: "1000.00", vat: "210.00" }],
        category: "office",
      } as never);

      const attachment = yield* expenses.attach(
        (expense as unknown as { readonly id: string }).id as never,
        {
          name: "receipt.pdf",
          contentType: "application/pdf",
          bytes: Stream.make(new TextEncoder().encode("%PDF-1.4 receipt")),
        },
      );

      const template = yield* templates.save({
        name: "Monthly Retainer",
        kind: "invoice",
        contact: supplierContact.id,
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
      } as never);

      return { supplierContact, bankAccount, item, expense, attachment, template };
    }).pipe(Effect.provideService(CurrentCaller, ownerCaller)),
  );

  const rw = h.addReadWriteGrant(owner, ownerCaller.workspaceId, "en");
  const ro = h.addReadOnlyGrant(owner, ownerCaller.workspaceId, "en");
  const roCs = h.addReadOnlyGrant(owner, ownerCaller.workspaceId, "cs");

  return { h, owner, ownerCaller, rw, ro, roCs, seeded };
};

describe("MCP 28 tools, 9 resources, two-step confirmation, and scope enforcement", () => {
  test("tools/list exposes all 28 tools for owner read_write and only 15 read tools for read-only grant", async () => {
    const { h, rw, ro } = await setupSeededWorkspace();

    const rwList = await h.rpc(rw.token, "tools/list");
    const rwTools = (
      rwList.json.result as {
        tools: Array<{ name: string; inputSchema: unknown; outputSchema: unknown }>;
      }
    ).tools;
    expect(rwTools.map((t) => t.name)).toEqual(MCP_TOOLS.map((t) => t.name));
    expect(rwTools).toHaveLength(28);
    for (const t of rwTools) {
      expect(typeof t.inputSchema).toBe("object");
      expect(typeof t.outputSchema).toBe("object");
    }

    const roList = await h.rpc(ro.token, "tools/list");
    const roTools = (
      roList.json.result as {
        tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }>;
      }
    ).tools;
    expect(roTools).toHaveLength(15);
    expect(roTools.every((t) => t.annotations.readOnlyHint)).toBe(true);
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
          contact: seeded.supplierContact.id,
          lines: [{ description: "Work", quantity: "1", unitPrice: "1000", vat: "standard" }],
        },
      },
    });
    expect(enRes.result?.isError).toBe(true);
    expect((enRes.result?.structuredContent?.error as { _tag: string })?._tag).toBe("Forbidden");
    expect((enRes.result?.content?.[0] as { text: string })?.text).toContain(
      "This connection is read only. Reconnect Kvitbit with read and write access",
    );

    const csRes = await h.callTool(roCs.token, "create_draft", {
      kind: "invoice",
      issuedOn: "2026-11-23",
      taxableSupplyOn: "2026-11-23",
      due: { inDays: 14 },
      currency: "CZK",
      contact: seeded.supplierContact.id,
      lines: [{ description: "Work", quantity: "1", unitPrice: "1000", vat: "standard" }],
    });
    expect(csRes.result?.isError).toBe(true);
    expect((csRes.result?.content?.[0] as { text: string })?.text).toContain("pouze pro čtení");
  });

  test("all 28 tools execute end-to-end including two-step confirmation, replay, mismatch, expiry, and stale revision", async () => {
    const { h, ownerCaller, rw, seeded } = await setupSeededWorkspace();

    // 1. get_workspace
    const wsRes = await h.callTool(rw.token, "get_workspace");
    expect(wsRes.result?.isError).toBe(false);
    expect((wsRes.result?.structuredContent?.series as unknown[])?.length).toBeGreaterThan(0);

    // 2. lookup_ares
    const aresRes = await h.callTool(rw.token, "lookup_ares", { ico: SAMPLE_ICO });
    expect(aresRes.result?.isError).toBe(false);
    expect((aresRes.result?.structuredContent as { name: string } | undefined)?.name).toBe(
      "Alza.cz a.s.",
    );

    // 3. upsert_contact (fromIco + create + update)
    const contactFromIco = await h.callTool(rw.token, "upsert_contact", {
      ico: SAMPLE_ICO,
      role: "customer",
    });
    expect(contactFromIco.result?.isError).toBe(false);
    const contactId = (contactFromIco.result?.structuredContent?.contact as { id: string })?.id;
    const contactRev = (
      contactFromIco.result?.structuredContent?.contact as { revision: number } | undefined
    )?.revision;

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
    expect((listContacts.result?.structuredContent?.items as unknown[])?.length).toBe(1);

    // 5. list_price_list_items
    const priceList = await h.callTool(rw.token, "list_price_list_items");
    expect(priceList.result?.isError).toBe(false);
    expect((priceList.result?.structuredContent?.items as unknown[])?.length).toBe(1);

    // 6. list_invoice_templates
    const templatesRes = await h.callTool(rw.token, "list_invoice_templates");
    expect(templatesRes.result?.isError).toBe(false);
    expect((templatesRes.result?.structuredContent?.items as unknown[])?.length).toBe(1);

    // 7. list_expenses & 8. get_expense & 9. record_expense
    const listExp = await h.callTool(rw.token, "list_expenses", { incomplete: false });
    expect(listExp.result?.isError).toBe(false);
    const seededExpenseId = (seeded.expense as unknown as { id: string }).id;
    const getExp = await h.callTool(rw.token, "get_expense", { expenseId: seededExpenseId });
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
    const draftDoc = draftRes.result?.structuredContent?.document as {
      id: string;
      revision: number;
    };

    const updatedDraft = await h.callTool(rw.token, "update_draft", {
      documentId: draftDoc.id,
      revision: draftDoc.revision,
      patch: { note: "Updated via MCP" },
    });
    expect(updatedDraft.result?.isError).toBe(false);
    const draftRev2 = (
      updatedDraft.result?.structuredContent?.document as { revision: number } | undefined
    )?.revision;

    // 13. issue_document (two-step: preview -> malformed -> mismatch -> invalid -> confirm -> replay)
    const issueArgs = { from: { draft: draftDoc.id, revision: draftRev2 } };

    // Malformed confirm (confirm: true without token)
    const malformed = await h.callTool(rw.token, "issue_document", {
      ...issueArgs,
      confirm: true,
    });
    expect(malformed.result?.isError).toBe(true);
    expect(
      (malformed.result?.structuredContent?.error as { issues: Array<{ code: string }> })?.issues[0]
        ?.code,
    ).toBe("mcp.confirmation_required");

    // Preview step
    const issuePreview = await h.callTool(rw.token, "issue_document", issueArgs);
    expect(issuePreview.result?.isError).toBe(false);
    expect(issuePreview.result?.structuredContent?._tag)?.toBe("ConfirmationRequired");
    const issueToken = issuePreview.result?.structuredContent?.confirmationToken as string;
    expect(issueToken).toMatch(/^mcpc_[A-Za-z0-9_-]{16,128}$/);

    // Mismatch (changed args after preview)
    const mismatch = await h.callTool(rw.token, "issue_document", {
      ...issueArgs,
      send: { to: ["changed@example.cz"] },
      confirm: true,
      confirmationToken: issueToken,
    });
    expect(mismatch.result?.isError).toBe(true);
    expect(
      (mismatch.result?.structuredContent?.error as { issues: Array<{ code: string }> })?.issues[0]
        ?.code,
    ).toBe("mcp.confirmation_mismatch");

    // Invalid (wrong tool using issueToken)
    const wrongTool = await h.callTool(rw.token, "send_document", {
      documentId: draftDoc.id,
      confirm: true,
      confirmationToken: issueToken,
    });
    expect(wrongTool.result?.isError).toBe(true);
    expect(
      (wrongTool.result?.structuredContent?.error as { issues: Array<{ code: string }> })?.issues[0]
        ?.code,
    ).toBe("mcp.confirmation_invalid");

    // Confirm step
    const issueConfirmed = await h.callTool(rw.token, "issue_document", {
      ...issueArgs,
      confirm: true,
      confirmationToken: issueToken,
    });
    expect(issueConfirmed.result?.isError).toBe(false);
    expect(issueConfirmed.result?.structuredContent?._tag)?.toBe("Confirmed");
    const issuedDoc = (
      issueConfirmed.result?.structuredContent?.result as
        | {
            document: { id: string; status: string; number: string };
          }
        | undefined
    )?.document;
    if (!issuedDoc) throw new Error("expected issuedDoc");
    expect(issuedDoc.status).toBe("issued");
    expect(issuedDoc.number).toBeTruthy();

    // Replay of same confirmationToken -> Invalid{mcp.confirmation_expired}
    const issueReplay = await h.callTool(rw.token, "issue_document", {
      ...issueArgs,
      confirm: true,
      confirmationToken: issueToken,
    });
    expect(issueReplay.result?.isError).toBe(true);
    expect(
      (
        issueReplay.result?.structuredContent?.error as
          | { issues: Array<{ code: string }> }
          | undefined
      )?.issues[0]?.code,
    ).toBe("mcp.confirmation_expired");

    // update_draft on issued document -> Conflict{illegal_transition}
    const editIssued = await h.callTool(rw.token, "update_draft", {
      documentId: issuedDoc.id,
      revision: 1,
      patch: { note: "Should fail" },
    });
    expect(editIssued.result?.isError).toBe(true);
    expect(
      editIssued.result?.structuredContent?.error as { _tag: string; reason: string } | undefined,
    ).toMatchObject({
      _tag: "Conflict",
      reason: "illegal_transition",
    });

    // 14. list_documents, 15. get_document, 16. get_document_history, 17. get_document_pdf, 18. get_share_link
    const listDocs = await h.callTool(rw.token, "list_documents", { status: "issued" });
    expect(listDocs.result?.isError).toBe(false);
    expect((listDocs.result?.structuredContent?.items as unknown[])?.length).toBeGreaterThanOrEqual(
      1,
    );

    const getDoc = await h.callTool(rw.token, "get_document", { documentId: issuedDoc.id });
    expect(getDoc.result?.isError).toBe(false);

    const history = await h.callTool(rw.token, "get_document_history", {
      documentId: issuedDoc.id,
    });
    expect(history.result?.isError).toBe(false);
    expect((history.result?.structuredContent?.items as unknown[])?.length).toBeGreaterThan(0);

    const pdf = await h.callTool(rw.token, "get_document_pdf", { documentId: issuedDoc.id });
    expect(pdf.result?.isError).toBe(false);
    expect(pdf.result?.structuredContent?.embedded)?.toBe(true);
    expect(pdf.result?.content.some((c) => c.type === "resource_link")).toBe(true);
    expect(pdf.result?.content.some((c) => c.type === "resource")).toBe(true);

    // Create a share link in core and read via get_share_link
    await h.run(
      Effect.gen(function* () {
        const shareLinks = yield* PublicShareLinks;
        return yield* shareLinks.create(issuedDoc.id as never);
      }).pipe(Effect.provideService(CurrentCaller, ownerCaller)),
    );
    const shareRes = await h.callTool(rw.token, "get_share_link", { documentId: issuedDoc.id });
    expect(shareRes.result?.isError).toBe(false);
    expect(shareRes.result?.structuredContent?.share)?.not.toBeNull();

    // 19. send_document (two-step) & 20. send_reminder (two-step)
    const sendPreview = await h.callTool(rw.token, "send_document", {
      documentId: issuedDoc.id,
      to: ["fakturace@alza.cz"],
    });
    expect(sendPreview.result?.isError).toBe(false);
    const sendToken = sendPreview.result?.structuredContent?.confirmationToken as string;
    const sendConfirm = await h.callTool(rw.token, "send_document", {
      documentId: issuedDoc.id,
      to: ["fakturace@alza.cz"],
      confirm: true,
      confirmationToken: sendToken,
    });
    expect(sendConfirm.result?.isError).toBe(false);
    expect(sendConfirm.result?.structuredContent?._tag)?.toBe("Confirmed");

    const remPreview = await h.callTool(rw.token, "send_reminder", {
      documentId: issuedDoc.id,
      to: ["fakturace@alza.cz"],
    });
    expect(remPreview.result?.isError).toBe(false);
    const remToken = remPreview.result?.structuredContent?.confirmationToken as string;
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
    expect(payRes.result?.structuredContent?.settlement)?.toBe("paid");

    const listPay = await h.callTool(rw.token, "list_payments", {
      target: { document: issuedDoc.id },
    });
    expect(listPay.result?.isError).toBe(false);
    expect((listPay.result?.structuredContent?.items as unknown[])?.length).toBe(1);

    // 23. create_credit_note (two-step) & 24. lock_document
    const cnPreview = await h.callTool(rw.token, "create_credit_note", {
      documentId: issuedDoc.id,
      reason: "Discount agreed",
      lines: "full",
      correctedOn: "2026-11-23",
    });
    expect(cnPreview.result?.isError).toBe(false);
    const cnToken = cnPreview.result?.structuredContent?.confirmationToken as string;
    const cnConfirm = await h.callTool(rw.token, "create_credit_note", {
      documentId: issuedDoc.id,
      reason: "Discount agreed",
      lines: "full",
      correctedOn: "2026-11-23",
      confirm: true,
      confirmationToken: cnToken,
    });
    expect(cnConfirm.result?.isError).toBe(false);
    expect(cnConfirm.result?.structuredContent?._tag)?.toBe("Confirmed");

    // Replaying credit note token returns mcp.confirmation_expired even after source revision bumped
    const cnReplay = await h.callTool(rw.token, "create_credit_note", {
      documentId: issuedDoc.id,
      reason: "Discount agreed",
      lines: "full",
      correctedOn: "2026-11-23",
      confirm: true,
      confirmationToken: cnToken,
    });
    expect(cnReplay.result?.isError).toBe(true);
    expect(
      (cnReplay.result?.structuredContent?.error as { issues: Array<{ code: string }> })?.issues[0]
        ?.code,
    ).toBe("mcp.confirmation_expired");

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
    const proformaToken = proformaPreview.result?.structuredContent?.confirmationToken as string;
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
    const proformaId = (
      proformaConfirm.result?.structuredContent?.result as { document: { id: string } } | undefined
    )?.document.id;

    const settleRes = await h.callTool(rw.token, "settle_proforma", {
      proformaId,
      paidOn: "2026-11-23",
      method: "bank_transfer",
      idempotencyKey: "settle-pf-001",
    });
    expect(settleRes.result?.isError).toBe(false);
    expect((settleRes.result?.structuredContent?.issued as unknown[])?.length).toBe(1);

    const fiPreview = await h.callTool(rw.token, "create_final_invoice", { proformaId });
    expect(fiPreview.result?.isError).toBe(false);
    const fiToken = fiPreview.result?.structuredContent?.confirmationToken as string;
    const fiConfirm = await h.callTool(rw.token, "create_final_invoice", {
      proformaId,
      confirm: true,
      confirmationToken: fiToken,
    });
    expect(fiConfirm.result?.isError).toBe(false);
    expect(fiConfirm.result?.structuredContent?._tag)?.toBe("Confirmed");

    // 27. create_from_template (single-call draft + two-step issued)
    const templateId = (seeded.template as unknown as { id: string }).id;
    const tplDraft = await h.callTool(rw.token, "create_from_template", {
      templateId,
      as: "draft",
      patch: { contact: contactId },
      idempotencyKey: "tpl-draft-001",
    });
    expect(tplDraft.result?.isError).toBe(false);
    expect((tplDraft.result?.structuredContent?.document as { status: string })?.status).toBe(
      "draft",
    );

    const tplIssuePreview = await h.callTool(rw.token, "create_from_template", {
      templateId,
      as: "issued",
      patch: { contact: contactId },
    });
    expect(tplIssuePreview.result?.isError).toBe(false);
    expect(tplIssuePreview.result?.structuredContent?._tag)?.toBe("ConfirmationRequired");
    const tplToken = tplIssuePreview.result?.structuredContent?.confirmationToken as string;
    const tplIssueConfirm = await h.callTool(rw.token, "create_from_template", {
      templateId,
      as: "issued",
      patch: { contact: contactId },
      confirm: true,
      confirmationToken: tplToken,
    });
    expect(tplIssueConfirm.result?.isError).toBe(false);
    expect(tplIssueConfirm.result?.structuredContent?._tag)?.toBe("Confirmed");

    // 28. get_report (including `vat` alias -> `vat_summary`)
    const reportRes = await h.callTool(rw.token, "get_report", {
      report: "vat",
      from: "2026-11-01",
      to: "2026-11-30",
    });
    expect(reportRes.result?.isError).toBe(false);
    expect(reportRes.result?.structuredContent?.report)?.toBe("vat_summary");
  });

  test("expired confirmation token and stale revision between preview and confirm fail cleanly", async () => {
    const { h, ownerCaller, rw } = await setupSeededWorkspace();

    const contact = await h.callTool(rw.token, "upsert_contact", {
      ico: SAMPLE_ICO,
      role: "customer",
    });
    const contactId = (contact.result?.structuredContent?.contact as { id: string })?.id;

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
    const tok1 = preview1.result?.structuredContent?.confirmationToken as string;
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
    const doc = (
      confirmed1.result?.structuredContent?.result as
        | { document: { id: string; revision: number } }
        | undefined
    )?.document;
    if (!doc) throw new Error("expected doc");

    // Preview send_document, then edit document in core (bumping revision), then confirm -> Conflict{revision_changed}
    const sendPrev = await h.callTool(rw.token, "send_document", {
      documentId: doc.id,
      to: ["buyer@example.cz"],
    });
    const sendTok = sendPrev.result?.structuredContent?.confirmationToken as string;

    await h.run(
      Effect.gen(function* () {
        const docs = yield* Documents;
        return yield* docs.edit(doc.id as never, { note: "Concurrent edit" }, doc.revision);
      }).pipe(Effect.provideService(CurrentCaller, ownerCaller)),
    );

    const staleConfirm = await h.callTool(rw.token, "send_document", {
      documentId: doc.id,
      to: ["buyer@example.cz"],
      confirm: true,
      confirmationToken: sendTok,
    });
    expect(staleConfirm.result?.isError).toBe(true);
    expect(staleConfirm.result?.structuredContent?.error)?.toMatchObject({
      _tag: "Conflict",
      reason: "revision_changed",
    });

    // Advance TestClock past 10-minute TTL -> Invalid{mcp.confirmation_expired}
    const freshPrev = await h.callTool(rw.token, "send_document", {
      documentId: doc.id,
      to: ["buyer@example.cz"],
    });
    const expTok = freshPrev.result?.structuredContent?.confirmationToken as string;
    await h.run(TestClock.adjust(Duration.minutes(11)));

    const expiredConfirm = await h.callTool(rw.token, "send_document", {
      documentId: doc.id,
      to: ["buyer@example.cz"],
      confirm: true,
      confirmationToken: expTok,
    });
    expect(expiredConfirm.result?.isError).toBe(true);
    expect(
      (
        expiredConfirm.result?.structuredContent?.error as
          | { issues: Array<{ code: string }> }
          | undefined
      )?.issues[0]?.code,
    ).toBe("mcp.confirmation_expired");
  });

  test("all 9 MCP resources list and read properly (4 static + 5 templates)", async () => {
    const { h, rw, seeded } = await setupSeededWorkspace();

    // List 4 static resources
    const staticList = await h.rpc(rw.token, "resources/list");
    const statics = (
      staticList.json.result as { resources: Array<{ uri: string; mimeType: string }> }
    ).resources;
    expect(statics.map((r) => r.uri)).toEqual(
      MCP_RESOURCES.filter((r) => r.kind === "static").map((r) => r.uri),
    );
    expect(statics).toHaveLength(4);

    // List 5 resource templates
    const tmplList = await h.rpc(rw.token, "resources/templates/list");
    const templates = (
      tmplList.json.result as { resourceTemplates: Array<{ uriTemplate: string }> }
    ).resourceTemplates;
    expect(templates.map((r) => r.uriTemplate)).toEqual(
      MCP_RESOURCES.filter((r) => r.kind === "template").map((r) => r.uri),
    );
    expect(templates).toHaveLength(5);

    // Seed contact and document to read template URIs
    const contactRes = await h.callTool(rw.token, "upsert_contact", { ico: SAMPLE_ICO });
    const contactId = (contactRes.result?.structuredContent?.contact as { id: string })?.id;
    const draftRes = await h.callTool(rw.token, "create_draft", {
      kind: "invoice",
      issuedOn: "2026-11-23",
      taxableSupplyOn: "2026-11-23",
      due: { inDays: 14 },
      currency: "CZK",
      contact: contactId,
      lines: [{ description: "Service", quantity: "1", unitPrice: "500", vat: "standard" }],
    });
    const docId = (draftRes.result?.structuredContent?.document as { id: string })?.id;
    const expenseId = (seeded.expense as unknown as { id: string }).id;
    const attachmentId = (seeded.attachment as unknown as { id: string }).id;

    // 1. kvitbit://workspace
    const r1 = await h.readResource(rw.token, "kvitbit://workspace");
    expect(r1.contents?.[0]?.mimeType).toBe("application/json");
    expect(JSON.parse(String(r1.contents?.[0]?.text ?? "{}"))?.name).toBe("Kvitbit Studio s.r.o.");

    // 2. kvitbit://templates
    const r2 = await h.readResource(rw.token, "kvitbit://templates");
    expect(r2.contents?.[0]?.mimeType).toBe("application/json");
    expect(JSON.parse(String(r2.contents?.[0]?.text ?? "[]"))).toHaveLength(1);

    // 3. kvitbit://price-list
    const r3 = await h.readResource(rw.token, "kvitbit://price-list");
    expect(r3.contents?.[0]?.mimeType).toBe("application/json");
    expect(JSON.parse(String(r3.contents?.[0]?.text ?? "[]"))).toHaveLength(1);

    // 4. kvitbit://guide
    const r4 = await h.readResource(rw.token, "kvitbit://guide");
    expect(r4.contents?.[0]?.mimeType).toBe("text/markdown");
    expect(String(r4.contents?.[0]?.text ?? "")).toContain("VatTreatment");

    // 5. kvitbit://documents/{documentId}
    const r5 = await h.readResource(rw.token, `kvitbit://documents/${docId}`);
    expect(r5.contents?.[0]?.mimeType).toBe("application/json");
    expect(JSON.parse(String(r5.contents?.[0]?.text ?? "{}"))?.id).toBe(docId);

    // 6. kvitbit://documents/{documentId}/pdf{?template,language}
    const r6 = await h.readResource(rw.token, `kvitbit://documents/${docId}/pdf?language=en`);
    expect(r6.contents?.[0]?.mimeType).toBe("application/pdf");
    expect(typeof r6.contents?.[0]?.blob).toBe("string");
    expect(String(r6.contents?.[0]?.blob ?? "").length).toBeGreaterThan(0);

    // 7. kvitbit://contacts/{contactId}
    const r7 = await h.readResource(rw.token, `kvitbit://contacts/${contactId}`);
    expect(r7.contents?.[0]?.mimeType).toBe("application/json");
    expect(JSON.parse(String(r7.contents?.[0]?.text ?? "{}"))?.id).toBe(contactId);

    // 8. kvitbit://expenses/{expenseId}
    const r8 = await h.readResource(rw.token, `kvitbit://expenses/${expenseId}`);
    expect(r8.contents?.[0]?.mimeType).toBe("application/json");
    expect(JSON.parse(String(r8.contents?.[0]?.text ?? "{}"))?.id).toBe(expenseId);

    // 9. kvitbit://expenses/{expenseId}/attachments/{attachmentId}
    const r9 = await h.readResource(
      rw.token,
      `kvitbit://expenses/${expenseId}/attachments/${attachmentId}`,
    );
    expect(r9.contents?.[0]?.mimeType).toBe("application/pdf");
    expect(Buffer.from(String(r9.contents?.[0]?.blob ?? ""), "base64").toString("utf8")).toBe(
      "%PDF-1.4 receipt",
    );

    // Unknown URI -> -32602
    const unknown = await h.readResource(rw.token, "kvitbit://unknown/thing");
    expect(unknown.error?.code).toBe(-32602);
  });
});
