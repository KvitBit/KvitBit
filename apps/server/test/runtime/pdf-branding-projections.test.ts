/**
 * Integration and unit verification for Phase 3A Round 1 fixes 6–8:
 * - Finding 6: Credit Note PDFs carry stored correction reason and original document's issue date.
 * - Finding 7: Shared canonical variable symbol (last 10 digits or stored override) and payment QR
 *   agree across HTTP, MCP, Public Share, and PDF rendering.
 * - Finding 8: Issued PDFs and branding previews render workspace branding + logo/stamp images,
 *   `Documents.pdf` defaults to workspace `pdfTemplate`, and cached PDFs key on both document
 *   revision and workspace revision.
 */
import { describe, expect, test } from "bun:test";
import { PdfEngine } from "@kvitbit/adapters/pdf";
import { ALL_SCOPES } from "@kvitbit/api-contract";
import { CoreModulesLive } from "@kvitbit/core";
import {
  CaptureEmailSender,
  CaptureInvitationDelivery,
  CoreReposMemory,
  DeliveryJobsMemory,
  FakeCompanyRegistry,
  FakeExportWorkflow,
  IdGeneratorTest,
  InMemoryCorePorts,
  InvitationTokensFake,
  ShareLinkKeysTest,
  UserDirectoryFake,
} from "@kvitbit/core/testing";
import {
  Caller,
  type ContactId,
  Contacts,
  CurrencyCode,
  CurrentCaller,
  type DocumentId,
  Documents,
  type DocumentView,
  type IsoDate,
  PublicShareLinks,
  UserId,
  type VisitorHash,
  type WorkspaceId,
  Workspaces,
} from "@kvitbit/domain/contract";
import { BlobStorage } from "@kvitbit/domain/ports";
import { BigDecimal, Effect, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import {
  documentPdfCacheKey,
  resolveVariableSymbol,
  ServerDocumentProjectionsLive,
} from "../../src/projections/documents";
import { documentViewToRenderModel, makePdfRenderersLayer } from "../../src/wiring/pdf";
import { makeHarness } from "../http/harness";
import { makeMcpHarness } from "../mcp/harness";

// Minimal valid 1x1 PNG (transparent) and 1x1 PNG (distinct bytes) for logo and stamp tests.
const LOGO_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);
const STAMP_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb0, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

const makeCapturePdfEngine = (capturedHtml: Array<string>) =>
  Layer.succeed(
    PdfEngine,
    PdfEngine.of({
      htmlToPdf: (html) =>
        Effect.sync(() => {
          capturedHtml.push(html);
          return new TextEncoder().encode(`%PDF-1.4\n%render-${capturedHtml.length}\n`);
        }),
    }),
  );

const makeLivePdfCore = (capturedHtml: Array<string>) => {
  const userId = UserId.make("01950000-0000-7000-8000-000000000001");
  const basePorts = InMemoryCorePorts();
  const baseRepos = CoreReposMemory.pipe(Layer.provideMerge(basePorts));
  const otherFakes = Layer.mergeAll(
    UserDirectoryFake.layer([{ userId, name: "Eva", email: "eva@example.cz" }]),
    CaptureInvitationDelivery.layer,
    InvitationTokensFake,
    DeliveryJobsMemory,
    FakeExportWorkflow.layer,
    ShareLinkKeysTest,
    IdGeneratorTest,
    FakeCompanyRegistry.layer(),
    CaptureEmailSender.layer,
  );
  const pdfRenderers = makePdfRenderersLayer(makeCapturePdfEngine(capturedHtml)).pipe(
    Layer.provide(Layer.mergeAll(baseRepos, otherFakes)),
  );
  const core = CoreModulesLive.pipe(
    Layer.provideMerge(Layer.mergeAll(baseRepos, otherFakes, pdfRenderers)),
  );
  return {
    userId,
    layer: ServerDocumentProjectionsLive.pipe(
      Layer.provideMerge(core),
      Layer.provideMerge(TestClock.layer()),
    ),
  };
};

const money = (n: string, currency: CurrencyCode = CurrencyCode.make("CZK")) => ({
  amount: BigDecimal.fromStringUnsafe(n),
  currency,
});

const sampleDocumentView = (overrides: Partial<DocumentView> = {}): DocumentView => ({
  id: "01950000-0000-7000-8000-000000000001" as DocumentId,
  kind: "invoice",
  number: "202612345678",
  status: "issued",
  locked: false,
  settlement: "unpaid",
  overdue: false,
  revision: 1,
  taxDocument: true,
  contact: {
    contactId: "01950000-0000-7000-8000-000000000002",
    name: "Odběratel a.s.",
    ico: "87654321",
    dic: "CZ87654321",
    legalForm: "a.s.",
    address: { street: "Václavské nám. 1", city: "Praha 1", postalCode: "110 00", country: "CZ" },
    billingEmails: ["billing@odberatel.cz"],
  } as unknown as DocumentView["contact"],
  issuer: {
    workspaceId: "01950000-0000-7000-8000-000000000003" as WorkspaceId,
    name: "Ateliér Kalný s.r.o.",
    ico: "12345678",
    dic: "CZ12345678",
    address: { street: "Křižíkova 185/35", city: "Praha 8", postalCode: "186 00", country: "CZ" },
    registerEntry: "Městský soud v Praze, C 12345",
    email: "faktury@kalny.cz",
    phone: "+420 602 111 222",
    web: null,
    regime: "vat_payer",
    bankAccount: {
      id: "01950000-0000-7000-8000-000000000004",
      name: "Hlavní",
      accountNumber: "123456789/0100",
      iban: "CZ6508000000192000145399",
      bic: "GIBACZPX",
      currency: CurrencyCode.make("CZK"),
    },
  } as unknown as DocumentView["issuer"],
  dates: {
    issuedOn: "2026-11-20" as IsoDate,
    taxableSupplyOn: "2026-11-20" as IsoDate,
    dueOn: "2026-12-04" as IsoDate,
  },
  paymentMethod: "bank_transfer",
  lines: [],
  totals: {
    buckets: [],
    net: money("1000"),
    vat: money("210"),
    gross: money("1210"),
    roundingAdjustment: money("0"),
    vatCzk: null,
  },
  fx: null,
  statutoryNotes: [],
  paymentQr: null,
  related: [],
  share: null,
  deliveries: [],
  ...overrides,
});

describe("Phase 3A Round 1 fixes 6–8: PDF, branding, and document/share read projections", () => {
  test("Finding 7 unit: variableSymbol uses last 10 digits (Numbering.variableSymbol) and matches SPAYD QR", () => {
    expect(resolveVariableSymbol(null, "202612345678")).toBe("2612345678");
    expect(resolveVariableSymbol("998877", "202612345678")).toBe("998877");

    const model = documentViewToRenderModel(sampleDocumentView({ number: "202612345678" }));
    expect(model.variableSymbol).toBe("2612345678");
    expect(model.paymentQr?.format).toBe("spayd");
    expect(model.paymentQr?.payload).toContain("X-VS:2612345678");
    expect(model.paymentQr?.payload).not.toContain("X-VS:2026123456");
  });

  test("Finding 6 & 8 end-to-end: Credit Note PDF has real original issue date + stored reason; branding/images, default template, and revision cache work", async () => {
    const capturedHtml: Array<string> = [];
    const { userId, layer } = makeLivePdfCore(capturedHtml);

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-10-05T10:00:00Z"));
        const workspaces = yield* Workspaces;
        const contacts = yield* Contacts;
        const documents = yield* Documents;
        const shareLinks = yield* PublicShareLinks;
        const blobs = yield* BlobStorage;

        const accountCaller = Caller.account({
          userId,
          email: "eva@example.cz",
          locale: "cs",
          channel: "web",
        });
        const memberCaller = yield* workspaces
          .create({
            name: "Ateliér Kalný s.r.o.",
            issuingEntity: {
              name: "Ateliér Kalný s.r.o.",
              ico: "12345678",
              dic: "CZ12345678",
              address: {
                street: "Křižíkova 185/35",
                city: "Praha 8",
                postalCode: "186 00",
                country: "CZ",
              },
            },
            initialTaxRegime: "vat_payer",
          })
          .pipe(Effect.provideService(CurrentCaller, accountCaller));

        const asMember = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
          Effect.provideService(eff, CurrentCaller, memberCaller);

        // Add CZK bank account with IBAN, upload logo & stamp, set modern_minimal + accent + footer
        yield* asMember(
          workspaces.saveBankAccount({
            name: "Hlavní CZK",
            currency: CurrencyCode.make("CZK"),
            accountNumber: "123456789/0100",
            iban: "CZ6508000000192000145399",
            bic: "GIBACZPX",
            isDefault: true,
          } as never),
        );
        yield* asMember(
          workspaces.setBrandingImage("logo", {
            contentType: "image/png",
            bytes: Stream.succeed(LOGO_PNG),
          }),
        );
        yield* asMember(
          workspaces.setBrandingImage("stamp", {
            contentType: "image/png",
            bytes: Stream.succeed(STAMP_PNG),
          }),
        );
        const wsBefore = yield* asMember(workspaces.current);
        const wsBranded = yield* asMember(
          workspaces.updateSettings(
            {
              branding: {
                pdfTemplate: "modern_minimal",
                accentColor: "#0F5D42",
                footerText: "Děkujeme za spolupráci",
              },
            },
            wsBefore.revision,
          ),
        );

        // Finding 8a: previewBranding includes uploaded logo + stamp + accent + footer, and is never cached
        const preview1 = yield* asMember(
          workspaces.previewBranding({
            kind: "invoice",
            language: "cs",
            branding: {},
          }),
        );
        yield* Stream.runDrain(preview1.bytes);
        const preview2 = yield* asMember(
          workspaces.previewBranding({
            kind: "invoice",
            language: "cs",
            branding: {},
          }),
        );
        yield* Stream.runDrain(preview2.bytes);
        expect(capturedHtml.length).toBe(2);
        const logoB64 = Buffer.from(LOGO_PNG).toString("base64");
        const stampB64 = Buffer.from(STAMP_PNG).toString("base64");
        expect(capturedHtml[0]).toContain("#0F5D42");
        expect(capturedHtml[0]).toContain("Děkujeme za spolupráci");
        expect(capturedHtml[0]).toContain(`data:image/png;base64,${logoB64}`);
        expect(capturedHtml[0]).toContain(`data:image/png;base64,${stampB64}`);

        // Create contact and issue invoice on 2026-10-05 with custom variableSymbol
        const contact = yield* asMember(
          contacts.save({
            name: "Odběratel a.s.",
            ico: "27074358",
            dic: "CZ27074358",
            address: {
              street: "Václavské nám. 1",
              city: "Praha 1",
              postalCode: "110 00",
              country: "CZ",
            },
            billingEmails: ["billing@odberatel.cz"],
          } as never),
        );
        const invoice = yield* asMember(
          documents.issue({
            input: {
              kind: "invoice",
              contact: contact.id as ContactId,
              issuedOn: "2026-10-05" as IsoDate,
              taxableSupplyOn: "2026-10-05" as IsoDate,
              variableSymbol: "2612345678",
              lines: [
                {
                  description: "Vývoj software",
                  quantity: BigDecimal.fromStringUnsafe("1"),
                  unitPrice: BigDecimal.fromStringUnsafe("1000"),
                },
              ],
            },
          }),
        );
        expect(invoice.paymentQr?.format).toBe("spayd");
        expect(invoice.paymentQr?.payload).toContain("X-VS:2612345678");

        // Finding 8b: Documents.pdf without template uses workspace default ("modern_minimal"),
        // embeds workspace branding + logo/stamp, and caches under (docRev, wsRev).
        const countBeforePdf = capturedHtml.length;
        const pdf1 = yield* asMember(documents.pdf(invoice.id));
        yield* Stream.runDrain(pdf1.bytes);
        expect(capturedHtml.length).toBe(countBeforePdf + 1);
        const invoiceHtml = capturedHtml.at(-1) ?? "";
        expect(invoiceHtml).toContain("#0F5D42");
        expect(invoiceHtml).toContain("Děkujeme za spolupráci");
        expect(invoiceHtml).toContain(`data:image/png;base64,${logoB64}`);
        expect(invoiceHtml).toContain(`data:image/png;base64,${stampB64}`);
        expect(invoiceHtml).toContain("2612345678");
        // Modern Minimal renders hero-val class (distinct from Classic Czech)
        expect(invoiceHtml).toContain("hero-val");

        // Cache key exists in BlobStorage
        const expectedCacheKey = documentPdfCacheKey({
          workspaceId: memberCaller.workspaceId,
          documentId: invoice.id,
          documentRevision: invoice.revision,
          workspaceRevision: wsBranded.revision,
          template: "modern_minimal",
          language: "cs",
        });
        const cachedStream = yield* blobs.get(expectedCacheKey);
        const cachedChunks = yield* Stream.runCollect(cachedStream);
        expect(cachedChunks.length).toBeGreaterThan(0);

        // Second call at same docRev + wsRev hits cache (no new render)
        const pdf2 = yield* asMember(documents.pdf(invoice.id));
        yield* Stream.runDrain(pdf2.bytes);
        expect(capturedHtml.length).toBe(countBeforePdf + 1);

        // Share link open returns exact same paymentQr; share PDF hits the same cache!
        const createdShare = yield* asMember(shareLinks.create(invoice.id));
        const shareToken = createdShare.url.split("/").pop() ?? "";
        const visitorCaller = Caller.shareLinkVisitor({
          token: shareToken as never,
          visitor: "visitor-hash-1" as VisitorHash,
          locale: "cs",
        });
        const sharedView = yield* shareLinks.open.pipe(
          Effect.provideService(CurrentCaller, visitorCaller),
        );
        expect(sharedView.paymentQr).toEqual(invoice.paymentQr);

        const sharePdf = yield* shareLinks
          .pdf()
          .pipe(Effect.provideService(CurrentCaller, visitorCaller));
        yield* Stream.runDrain(sharePdf.bytes);
        expect(capturedHtml.length).toBe(countBeforePdf + 1);

        // Changing workspace branding bumps workspace revision -> cache miss and new accent rendered
        yield* asMember(
          workspaces.updateSettings({ branding: { accentColor: "#1D4ED8" } }, wsBranded.revision),
        );
        const pdfAfterBranding = yield* asMember(documents.pdf(invoice.id));
        yield* Stream.runDrain(pdfAfterBranding.bytes);
        expect(capturedHtml.length).toBe(countBeforePdf + 2);
        expect(capturedHtml.at(-1)).toContain("#1D4ED8");

        // Explicit template override ("classic") bypasses workspace default
        const pdfClassic = yield* asMember(documents.pdf(invoice.id, { template: "classic" }));
        yield* Stream.runDrain(pdfClassic.bytes);
        expect(capturedHtml.length).toBe(countBeforePdf + 3);
        expect(capturedHtml.at(-1)).not.toContain("hero-val");

        // Finding 6: Issue Credit Note on a DIFFERENT date (2026-11-20) with a stored reason
        yield* TestClock.setTime(Date.parse("2026-11-20T10:00:00Z"));
        const creditNote = yield* asMember(
          documents.correct(invoice.id, {
            reason: "Vrácení vadného zboží",
            lines: "full",
          }),
        );
        expect(String(creditNote.dates.issuedOn)).toBe("2026-11-20");
        expect(creditNote.paymentQr).toBeNull();

        const cnPdf = yield* asMember(documents.pdf(creditNote.id));
        yield* Stream.runDrain(cnPdf.bytes);
        const cnHtml = (capturedHtml.at(-1) ?? "").replace(/\u00a0/g, " ");
        // Czech date formatting: 05. 10. 2026 (original) vs 20. 11. 2026 (credit note)
        expect(cnHtml).toContain("Vrácení vadného zboží");
        expect(cnHtml).toContain(invoice.number ?? "");
        expect(cnHtml).toContain("05. 10. 2026");
        expect(cnHtml).toContain("20. 11. 2026");
      }).pipe(Effect.provide(layer)),
    );
  });

  test("Finding 7 across HTTP, MCP, and Share: issued CZK invoice returns identical canonical paymentQr everywhere", async () => {
    // 1. HTTP + Public Share via HTTP harness
    const http = makeHarness();
    try {
      await http.run(TestClock.setTime(Date.parse("2026-11-23T10:00:00Z")));
      const owner = http.addUser("Petra");
      const member = await http.createWorkspace(owner, {
        name: "HTTP Studio s.r.o.",
        initialTaxRegime: "vat_payer",
      });
      const authHeader = { authorization: `Bearer session:${owner.id}` };

      await http.run(
        Effect.gen(function* () {
          const ws = yield* Workspaces;
          yield* ws.saveBankAccount({
            name: "CZK",
            currency: CurrencyCode.make("CZK"),
            accountNumber: "123456789/0100",
            iban: "CZ6508000000192000145399",
            bic: "GIBACZPX",
            isDefault: true,
          } as never);
        }).pipe(Effect.provideService(CurrentCaller, member)),
      );

      const contactRes = await http.fetch(`/api/v1/workspaces/${member.workspaceId}/contacts`, {
        method: "POST",
        headers: { ...authHeader, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Klient s.r.o.",
          address: { street: "Ulice 1", city: "Praha", postalCode: "110 00", country: "CZ" },
        }),
      });
      const contact = (await contactRes.json()) as { id: string };

      const issueRes = await http.fetch(
        `/api/v1/workspaces/${member.workspaceId}/documents/issue`,
        {
          method: "POST",
          headers: { ...authHeader, "content-type": "application/json" },
          body: JSON.stringify({
            input: {
              kind: "invoice",
              contact: contact.id,
              variableSymbol: "2612345678",
              lines: [{ description: "Služba", quantity: "1", unitPrice: "1000" }],
            },
          }),
        },
      );
      expect(issueRes.status).toBe(201);
      const issued = (await issueRes.json()) as {
        id: string;
        paymentQr: { format: string; payload: string } | null;
      };
      expect(issued.paymentQr).not.toBeNull();
      expect(issued.paymentQr?.format).toBe("spayd");
      expect(issued.paymentQr?.payload).toContain("X-VS:2612345678");

      const getRes = await http.fetch(
        `/api/v1/workspaces/${member.workspaceId}/documents/${issued.id}`,
        { headers: authHeader },
      );
      expect(getRes.status).toBe(200);
      const fetched = (await getRes.json()) as {
        paymentQr: { format: string; payload: string } | null;
      };
      expect(fetched.paymentQr).toEqual(issued.paymentQr);

      // Share link open returns exact same paymentQr
      const shareRes = await http.fetch(
        `/api/v1/workspaces/${member.workspaceId}/documents/${issued.id}/share-link`,
        { method: "PUT", headers: authHeader },
      );
      expect(shareRes.status).toBe(200);
      const { url } = (await shareRes.json()) as { url: string };
      const token = url.split("/").pop() ?? "";
      const openRes = await http.fetch(`/api/v1/share/${token}`);
      expect(openRes.status).toBe(200);
      const shared = (await openRes.json()) as {
        paymentQr: { format: string; payload: string } | null;
      };
      expect(shared.paymentQr).toEqual(issued.paymentQr);
    } finally {
      await http.dispose();
    }

    // 2. MCP via MCP harness (get_document tool + kvitbit://documents/{id} resource)
    const mcp = makeMcpHarness();
    try {
      const owner = mcp.addUser("Karel");
      const member = await mcp.createWorkspace(owner, {
        name: "MCP Studio s.r.o.",
        initialTaxRegime: "vat_payer",
      });
      const grant = mcp.addGrant({
        user: owner,
        workspaceId: member.workspaceId,
        grantId: "grant-qr-test",
        clientId: "client-qr-test",
        clientName: "QR Test Client",
        scopes: [...ALL_SCOPES],
      });

      const docId = await mcp.run(
        Effect.gen(function* () {
          const ws = yield* Workspaces;
          const contacts = yield* Contacts;
          const docs = yield* Documents;
          yield* ws.saveBankAccount({
            name: "CZK",
            currency: CurrencyCode.make("CZK"),
            accountNumber: "123456789/0100",
            iban: "CZ6508000000192000145399",
            bic: "GIBACZPX",
            isDefault: true,
          } as never);
          const contact = yield* contacts.save({
            name: "MCP Buyer s.r.o.",
            address: { street: "Ulice 2", city: "Brno", postalCode: "602 00", country: "CZ" },
          } as never);
          const issued = yield* docs.issue({
            input: {
              kind: "invoice",
              contact: contact.id as ContactId,
              variableSymbol: "2612345678",
              lines: [
                {
                  description: "Konzultace",
                  quantity: BigDecimal.fromStringUnsafe("1"),
                  unitPrice: BigDecimal.fromStringUnsafe("1000"),
                },
              ],
            },
          });
          return issued.id;
        }).pipe(Effect.provideService(CurrentCaller, member)),
      );

      const toolCall = await mcp.callTool(grant.token, "get_document", { documentId: docId });
      const toolDoc = (
        toolCall.result as unknown as {
          structuredContent: {
            document: { paymentQr: { format: string; payload: string } | null };
          };
        }
      ).structuredContent.document;
      expect(toolDoc.paymentQr).not.toBeNull();
      expect(toolDoc.paymentQr?.format).toBe("spayd");
      expect(toolDoc.paymentQr?.payload).toContain("X-VS:2612345678");

      const resCall = await mcp.rpc(grant.token, "resources/read", {
        uri: `kvitbit://documents/${docId}`,
      });
      const resText = (resCall.json.result as { contents: Array<{ text: string }> }).contents[0]
        ?.text;
      const resDoc = JSON.parse(resText ?? "{}") as {
        paymentQr: { format: string; payload: string } | null;
      };
      expect(resDoc.paymentQr).toEqual(toolDoc.paymentQr);
    } finally {
      await mcp.dispose();
    }
  });
});
