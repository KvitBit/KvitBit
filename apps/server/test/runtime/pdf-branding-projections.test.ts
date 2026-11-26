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
import {
  CoreModulesLive,
  CoreStore,
  DeliveriesRepo,
  DocumentRenderer,
  DocumentsRepo,
  StoreUnavailable,
  WorkspacesRepo,
} from "@kvitbit/core";
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
  Payments,
  PublicShareLinks,
  type RequestKey,
  type TemplateId,
  Templates,
  UserId,
  type VisitorHash,
  type WorkspaceId,
  Workspaces,
} from "@kvitbit/domain/contract";
import { type BlobKey, BlobStorage } from "@kvitbit/domain/ports";
import { BigDecimal, Effect, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import { PersistenceLive, PgliteTestDatabase } from "../../src/persistence";
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

  test("Round 2 fixes: outstanding balance QR (CZK & EUR), Templates.use, C3 replay, J3 snapshot, branding retry cache, default template for delivery/export, and R1a auth order", async () => {
    const capturedHtml: Array<string> = [];
    const { userId, layer } = makeLivePdfCore(capturedHtml);

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-10-05T10:00:00Z"));
        const workspaces = yield* Workspaces;
        const contacts = yield* Contacts;
        const documents = yield* Documents;
        const payments = yield* Payments;
        const templates = yield* Templates;
        const shareLinks = yield* PublicShareLinks;
        const renderer = yield* DocumentRenderer;
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
            initialTaxRegime: "non_vat_payer",
          })
          .pipe(Effect.provideService(CurrentCaller, accountCaller));

        const asMember = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
          Effect.provideService(eff, CurrentCaller, memberCaller);

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
        const uploadedLogo = yield* asMember(
          workspaces.setBrandingImage("logo", {
            contentType: "image/png",
            bytes: Stream.succeed(LOGO_PNG),
          }),
        );
        const wsCur = yield* asMember(workspaces.current);
        yield* asMember(
          workspaces.updateSettings(
            { branding: { pdfTemplate: "modern_minimal" } },
            wsCur.revision,
          ),
        );

        const contact = yield* asMember(
          contacts.save({
            name: "Odběratel a.s.",
            address: { street: "Ulice 1", city: "Praha", postalCode: "110 00", country: "CZ" },
          } as never),
        );

        // 1. C3 request-key replay + J3 queued delivery snapshot
        const issueReqKey = "rk-c3-issue-001" as RequestKey;
        const issued = yield* asMember(
          documents.issue(
            {
              input: {
                kind: "invoice",
                contact: contact.id as ContactId,
                variableSymbol: "2612345678",
                note: "Původní poznámka",
                lines: [
                  {
                    description: "Konzultace",
                    quantity: BigDecimal.fromStringUnsafe("1"),
                    unitPrice: BigDecimal.fromStringUnsafe("1000"),
                  },
                ],
              },
            },
            { requestKey: issueReqKey },
          ),
        );
        expect(issued.paymentQr?.payload).toContain("AM:1000.00");
        expect(issued.paymentQr?.payload).toContain("X-VS:2612345678");

        // Edit variableSymbol and note -> rev 2
        const edited = yield* asMember(
          documents.edit(
            issued.id,
            { variableSymbol: "777777", note: "Nová poznámka" },
            issued.revision,
          ),
        );
        expect(edited.revision).toBe(issued.revision + 1);
        expect(edited.paymentQr?.payload).toContain("X-VS:777777");

        // C3: Replay original issue requestKey -> must return original rev and original QR symbol!
        const replayed = yield* asMember(
          documents.issue(
            {
              input: {
                kind: "invoice",
                contact: contact.id as ContactId,
                variableSymbol: "2612345678",
                note: "Původní poznámka",
                lines: [
                  {
                    description: "Konzultace",
                    quantity: BigDecimal.fromStringUnsafe("1"),
                    unitPrice: BigDecimal.fromStringUnsafe("1000"),
                  },
                ],
              },
            },
            { requestKey: issueReqKey },
          ),
        );
        expect(replayed.revision).toBe(issued.revision);
        expect(replayed.paymentQr).toEqual(issued.paymentQr);

        // J3: Rendering frozen historical view (rev 1) uses rev 1's variableSymbol & note, not rev 2's,
        // and uses workspace default template ("modern_minimal") when ExplicitPdfTemplate is absent!
        const frozenView = { ...issued, paymentQr: null };
        yield* asMember(renderer.render(frozenView, { template: "classic", language: "cs" }));
        const frozenHtml = capturedHtml.at(-1) ?? "";
        expect(frozenHtml).toContain("2612345678");
        expect(frozenHtml).not.toContain("777777");
        expect(frozenHtml).toContain("Původní poznámka");
        expect(frozenHtml).not.toContain("Nová poznámka");
        expect(frozenHtml).toContain("hero-val");

        // 2. Partial payment (300 of 1000) -> QR requests 700.00; full payment -> QR is null
        yield* asMember(
          payments.record({
            target: { document: issued.id },
            amount: money("300"),
            paidOn: "2026-10-06" as IsoDate,
            method: "bank_transfer",
          }),
        );
        const partialDoc = yield* asMember(documents.get(issued.id));
        expect(partialDoc.paymentQr?.payload).toContain("AM:700.00");

        const shareCreated = yield* asMember(shareLinks.create(issued.id));
        const shareToken = shareCreated.url.split("/").pop() ?? "";
        const visitorCaller = Caller.shareLinkVisitor({
          token: shareToken as never,
          visitor: "visitor-pay-1" as VisitorHash,
          locale: "cs",
        });
        const partialShare = yield* shareLinks.open.pipe(
          Effect.provideService(CurrentCaller, visitorCaller),
        );
        expect(partialShare.paymentQr).toEqual(partialDoc.paymentQr);

        yield* asMember(
          payments.record({
            target: { document: issued.id },
            amount: money("700"),
            paidOn: "2026-10-07" as IsoDate,
            method: "bank_transfer",
          }),
        );
        const paidDoc = yield* asMember(documents.get(issued.id));
        expect(paidDoc.paymentQr).toBeNull();
        const paidShare = yield* shareLinks.open.pipe(
          Effect.provideService(CurrentCaller, visitorCaller),
        );
        expect(paidShare.paymentQr).toBeNull();

        // 3. Templates.use returns projected paymentQr matching Documents.get
        const tpl = yield* asMember(
          templates.save({
            name: "Měsíční paušál",
            kind: "invoice",
            contact: contact.id as ContactId,
            lines: [
              {
                description: "Paušál",
                quantity: BigDecimal.fromStringUnsafe("1"),
                unitPrice: BigDecimal.fromStringUnsafe("2000"),
              },
            ],
          } as never),
        );
        const fromTemplate = yield* asMember(templates.use(tpl.id as TemplateId, { as: "issued" }));
        const fromGet = yield* asMember(documents.get(fromTemplate.id));
        expect(fromTemplate.paymentQr).not.toBeNull();
        expect(fromTemplate.paymentQr).toEqual(fromGet.paymentQr);

        // 4. Branding image temporarily unreadable -> incomplete PDF is NOT cached;
        // restoring bytes triggers a fresh render with the logo!
        const logoKey =
          `branding/${memberCaller.workspaceId}/logo/${uploadedLogo.sha256}` as BlobKey;
        const logoB64 = Buffer.from(LOGO_PNG).toString("base64");
        yield* blobs.delete(logoKey);

        const rendersBeforeMissing = capturedHtml.length;
        const pdfMissingLogo = yield* asMember(documents.pdf(fromTemplate.id));
        yield* Stream.runDrain(pdfMissingLogo.bytes);
        expect(capturedHtml.length).toBe(rendersBeforeMissing + 1);
        expect(capturedHtml.at(-1)).not.toContain(`data:image/png;base64,${logoB64}`);

        // Restore logo bytes -> next call MUST re-render with logo!
        yield* blobs.put(logoKey, Stream.succeed(LOGO_PNG), {
          contentType: "image/png",
          maxBytes: 1024 * 1024,
        });
        const pdfRestoredLogo = yield* asMember(documents.pdf(fromTemplate.id));
        yield* Stream.runDrain(pdfRestoredLogo.bytes);
        expect(capturedHtml.length).toBe(rendersBeforeMissing + 2);
        expect(capturedHtml.at(-1)).toContain(`data:image/png;base64,${logoB64}`);

        // Subsequent call now hits the complete cache
        const pdfCachedComplete = yield* asMember(documents.pdf(fromTemplate.id));
        yield* Stream.runDrain(pdfCachedComplete.bytes);
        expect(capturedHtml.length).toBe(rendersBeforeMissing + 2);
      }).pipe(Effect.provide(layer)),
    );
  });

  test("EUR parity across HTTP, MCP, Share, and PDF with partial payment remaining balance", async () => {
    const http = makeHarness();
    const mcp = makeMcpHarness();
    try {
      await http.run(TestClock.setTime(Date.parse("2026-11-23T10:00:00Z")));
      const httpOwner = http.addUser("Hana");
      const httpMember = await http.createWorkspace(httpOwner, {
        name: "EUR Studio s.r.o.",
        initialTaxRegime: "non_vat_payer",
      });
      const authHeader = { authorization: `Bearer session:${httpOwner.id}` };

      const httpDocId = await http.run(
        Effect.gen(function* () {
          const ws = yield* Workspaces;
          const contacts = yield* Contacts;
          const docs = yield* Documents;
          const payments = yield* Payments;
          yield* ws.saveBankAccount({
            name: "EUR",
            currency: CurrencyCode.make("EUR"),
            iban: "CZ6508000000192000145399",
            bic: "GIBACZPX",
            isDefault: true,
          } as never);
          const contact = yield* contacts.save({
            name: "EU Client GmbH",
            address: { street: "Strasse 1", city: "Berlin", postalCode: "10115", country: "DE" },
          } as never);
          const issued = yield* docs.issue({
            input: {
              kind: "invoice",
              contact: contact.id as ContactId,
              currency: CurrencyCode.make("EUR"),
              fx: { manual: { rate: BigDecimal.fromStringUnsafe("25"), quantity: 1 } },
              lines: [
                {
                  description: "Advisory",
                  quantity: BigDecimal.fromStringUnsafe("1"),
                  unitPrice: BigDecimal.fromStringUnsafe("1000"),
                },
              ],
            },
          });
          yield* payments.record({
            target: { document: issued.id },
            amount: money("250", CurrencyCode.make("EUR")),
            paidOn: "2026-11-23" as IsoDate,
            method: "bank_transfer",
          });
          return issued.id;
        }).pipe(Effect.provideService(CurrentCaller, httpMember)),
      );

      const httpDocRes = await http.fetch(
        `/api/v1/workspaces/${httpMember.workspaceId}/documents/${httpDocId}`,
        { headers: authHeader },
      );
      expect(httpDocRes.status).toBe(200);
      const httpDoc = (await httpDocRes.json()) as {
        paymentQr: { format: string; payload: string } | null;
      };
      expect(httpDoc.paymentQr?.format).toBe("epc");
      expect(httpDoc.paymentQr?.payload).toContain("EUR750.00");

      const shareRes = await http.fetch(
        `/api/v1/workspaces/${httpMember.workspaceId}/documents/${httpDocId}/share-link`,
        { method: "PUT", headers: authHeader },
      );
      const { url } = (await shareRes.json()) as { url: string };
      const token = url.split("/").pop() ?? "";
      const shareDocRes = await http.fetch(`/api/v1/share/${token}`);
      const shareDoc = (await shareDocRes.json()) as {
        paymentQr: { format: string; payload: string } | null;
      };
      expect(shareDoc.paymentQr).toEqual(httpDoc.paymentQr);

      // MCP EUR parity with identical partial payment
      const mcpOwner = mcp.addUser("Marek");
      const mcpMember = await mcp.createWorkspace(mcpOwner, {
        name: "EUR Studio s.r.o.",
        initialTaxRegime: "non_vat_payer",
      });
      const grant = mcp.addGrant({
        user: mcpOwner,
        workspaceId: mcpMember.workspaceId,
        grantId: "grant-eur-test",
        clientId: "client-eur-test",
        clientName: "EUR Test Client",
        scopes: [...ALL_SCOPES],
      });
      const mcpDocId = await mcp.run(
        Effect.gen(function* () {
          const ws = yield* Workspaces;
          const contacts = yield* Contacts;
          const docs = yield* Documents;
          const payments = yield* Payments;
          yield* ws.saveBankAccount({
            name: "EUR",
            currency: CurrencyCode.make("EUR"),
            iban: "CZ6508000000192000145399",
            bic: "GIBACZPX",
            isDefault: true,
          } as never);
          const contact = yield* contacts.save({
            name: "EU Client GmbH",
            address: { street: "Strasse 1", city: "Berlin", postalCode: "10115", country: "DE" },
          } as never);
          const issued = yield* docs.issue({
            input: {
              kind: "invoice",
              contact: contact.id as ContactId,
              currency: CurrencyCode.make("EUR"),
              fx: { manual: { rate: BigDecimal.fromStringUnsafe("25"), quantity: 1 } },
              lines: [
                {
                  description: "Advisory",
                  quantity: BigDecimal.fromStringUnsafe("1"),
                  unitPrice: BigDecimal.fromStringUnsafe("1000"),
                },
              ],
            },
          });
          yield* payments.record({
            target: { document: issued.id },
            amount: money("250", CurrencyCode.make("EUR")),
            paidOn: "2026-11-23" as IsoDate,
            method: "bank_transfer",
          });
          return issued.id;
        }).pipe(Effect.provideService(CurrentCaller, mcpMember)),
      );

      const toolCall = await mcp.callTool(grant.token, "get_document", { documentId: mcpDocId });
      const toolDoc = (
        toolCall.result as unknown as {
          structuredContent: {
            document: { paymentQr: { format: string; payload: string } | null };
          };
        }
      ).structuredContent.document;
      expect(toolDoc.paymentQr?.format).toBe("epc");
      expect(toolDoc.paymentQr?.payload).toContain("EUR750.00");
      expect(toolDoc.paymentQr).toEqual(httpDoc.paymentQr);
    } finally {
      await http.dispose();
      await mcp.dispose();
    }
  });

  test("Round 3 SQL & failure-path verification: queued delivery snapshot (balance + template + fields), draft replay, StoreUnavailable propagation, EUR PDF, and R1a workspace-read order", async () => {
    const capturedHtml: Array<string> = [];
    const userId = UserId.make("01950000-0000-7000-8000-000000000099");
    const { SqlClient } = await import("effect/sql");
    const { FixtureRates, MemoryBlobStorage } = await import("@kvitbit/core/testing");
    const database = PgliteTestDatabase.pipe(Layer.orDie);
    const persistence = Layer.merge(
      PersistenceLive,
      Layer.effectDiscard(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`insert into auth."user" (id, name, email) values (${userId}, ${"Eva"}, ${"eva@example.cz"})`;
        }).pipe(Effect.orDie),
      ),
    ).pipe(Layer.provideMerge(database));

    const otherPorts = Layer.mergeAll(
      CaptureInvitationDelivery.layer,
      InvitationTokensFake,
      DeliveryJobsMemory,
      FakeExportWorkflow.layer,
      ShareLinkKeysTest,
      IdGeneratorTest,
      FakeCompanyRegistry.layer(),
      FixtureRates.layer(),
      CaptureEmailSender.layer,
      MemoryBlobStorage.layer,
    );
    const pdfRenderers = makePdfRenderersLayer(makeCapturePdfEngine(capturedHtml)).pipe(
      Layer.provide(Layer.mergeAll(persistence, otherPorts)),
    );
    const core = CoreModulesLive.pipe(
      Layer.provideMerge(Layer.mergeAll(persistence, otherPorts, pdfRenderers)),
    );
    const layer = ServerDocumentProjectionsLive.pipe(
      Layer.provideMerge(core),
      Layer.provideMerge(TestClock.layer()),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-10-05T10:00:00Z"));
        const workspaces = yield* Workspaces;
        const contacts = yield* Contacts;
        const documents = yield* Documents;
        const payments = yield* Payments;
        const deliveriesRepo = yield* DeliveriesRepo;
        const renderer = yield* DocumentRenderer;

        const accountCaller = Caller.account({
          userId,
          email: "eva@example.cz",
          locale: "cs",
          channel: "web",
        });
        const memberCaller = yield* workspaces
          .create({
            name: "SQL Studio s.r.o.",
            issuingEntity: {
              name: "SQL Studio s.r.o.",
              ico: "12345678",
              dic: "CZ12345678",
              address: { street: "Ulice 1", city: "Praha", postalCode: "110 00", country: "CZ" },
            },
            initialTaxRegime: "non_vat_payer",
          })
          .pipe(Effect.provideService(CurrentCaller, accountCaller));

        const asMember = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
          Effect.provideService(eff, CurrentCaller, memberCaller);

        yield* asMember(
          workspaces.saveBankAccount({
            name: "CZK",
            currency: CurrencyCode.make("CZK"),
            accountNumber: "123456789/0100",
            iban: "CZ6508000000192000145399",
            bic: "GIBACZPX",
            isDefault: true,
          } as never),
        );
        yield* asMember(
          workspaces.saveBankAccount({
            name: "EUR",
            currency: CurrencyCode.make("EUR"),
            iban: "CZ6508000000192000145399",
            bic: "GIBACZPX",
            isDefault: true,
          } as never),
        );
        const ws1 = yield* asMember(workspaces.current);
        const wsModern = yield* asMember(
          workspaces.updateSettings({ branding: { pdfTemplate: "modern_minimal" } }, ws1.revision),
        );

        const contact = yield* asMember(
          contacts.save({
            name: "Klient s.r.o.",
            address: { street: "Ulice 2", city: "Brno", postalCode: "602 00", country: "CZ" },
            billingEmails: ["klient@example.cz"],
          } as never),
        );

        // 1. Draft QR consistency: preview, createDraft, and replayed createDraft all return paymentQr: null
        const draftInput = {
          kind: "invoice" as const,
          contact: contact.id as ContactId,
          note: "Draft poznámka",
          lines: [
            {
              description: "Služba",
              quantity: BigDecimal.fromStringUnsafe("1"),
              unitPrice: BigDecimal.fromStringUnsafe("1000"),
            },
          ] as const,
        };
        const previewDraft = yield* asMember(documents.preview(draftInput));
        expect(previewDraft.paymentQr).toBeNull();
        const draftReqKey = "rk-draft-001" as RequestKey;
        const createdDraft = yield* asMember(
          documents.createDraft(draftInput, { requestKey: draftReqKey }),
        );
        expect(createdDraft.paymentQr).toBeNull();
        yield* asMember(
          documents.edit(createdDraft.id, { note: "Upravená poznámka" }, createdDraft.revision),
        );
        const replayedDraft = yield* asMember(
          documents.createDraft(draftInput, { requestKey: draftReqKey }),
        );
        expect(replayedDraft.revision).toBe(createdDraft.revision);
        expect(replayedDraft.paymentQr).toBeNull();

        // 2. Queued delivery snapshot (J3): partial payment (300/1000 -> 700 due), modern_minimal template,
        // then edit note/symbol AND change workspace template to classic BEFORE rendering!
        const invoice = yield* asMember(
          documents.issue({
            input: {
              kind: "invoice",
              contact: contact.id as ContactId,
              variableSymbol: "2612345678",
              note: "Frozen note",
              lines: [
                {
                  description: "Vývoj",
                  quantity: BigDecimal.fromStringUnsafe("1"),
                  unitPrice: BigDecimal.fromStringUnsafe("1000"),
                },
              ],
            },
          }),
        );
        yield* asMember(
          payments.record({
            target: { document: invoice.id },
            amount: money("300"),
            paidOn: "2026-10-06" as IsoDate,
            method: "bank_transfer",
          }),
        );
        const sent = yield* asMember(documents.send(invoice.id, { purpose: "document" }));
        const afterPayment = yield* asMember(documents.get(invoice.id));
        expect(afterPayment.paymentQr?.payload).toContain("AM:700.00");

        // Mutate document AND switch workspace default back to classic AFTER enqueue
        yield* asMember(
          documents.edit(
            invoice.id,
            { variableSymbol: "777777", note: "Edited note" },
            afterPayment.revision,
          ),
        );
        yield* asMember(
          workspaces.updateSettings({ branding: { pdfTemplate: "classic" } }, wsModern.revision),
        );

        const deliveryRow = yield* deliveriesRepo.get(memberCaller.workspaceId, sent.deliveryId);
        expect(deliveryRow.attachment.template).toBe("modern_minimal");
        expect(deliveryRow.view.paymentQr?.payload).toContain("AM:700.00");
        expect(deliveryRow.view.paymentQr?.payload).toContain("X-VS:2612345678");

        yield* renderer.render(deliveryRow.view, {
          template: deliveryRow.attachment.template,
          language: deliveryRow.language,
        });
        const deliveryHtml = capturedHtml.at(-1) ?? "";
        expect(deliveryHtml).toContain("hero-val");
        expect(deliveryHtml).toContain("2612345678");
        expect(deliveryHtml).not.toContain("777777");
        expect(deliveryHtml).toContain("Frozen note");
        expect(deliveryHtml).not.toContain("Edited note");

        // 3. System caller export default template: restore modern_minimal, render without ExplicitPdfTemplate
        const wsAfterClassic = yield* asMember(workspaces.current);
        yield* asMember(
          workspaces.updateSettings(
            { branding: { pdfTemplate: "modern_minimal" } },
            wsAfterClassic.revision,
          ),
        );
        const eurInvoice = yield* asMember(
          documents.issue({
            input: {
              kind: "invoice",
              contact: contact.id as ContactId,
              currency: CurrencyCode.make("EUR"),
              fx: { manual: { rate: BigDecimal.fromStringUnsafe("25"), quantity: 1 } },
              lines: [
                {
                  description: "Advisory",
                  quantity: BigDecimal.fromStringUnsafe("1"),
                  unitPrice: BigDecimal.fromStringUnsafe("1000"),
                },
              ],
            },
          }),
        );
        yield* asMember(
          payments.record({
            target: { document: eurInvoice.id },
            amount: money("250", CurrencyCode.make("EUR")),
            paidOn: "2026-10-06" as IsoDate,
            method: "bank_transfer",
          }),
        );
        const eurAfterPay = yield* asMember(documents.get(eurInvoice.id));
        expect(eurAfterPay.paymentQr?.format).toBe("epc");
        expect(eurAfterPay.paymentQr?.payload).toContain("EUR750.00");

        // Render EUR PDF as System caller (export path, no CurrentCaller Member, template="classic")
        yield* renderer.render(
          { ...eurAfterPay, paymentQr: null },
          {
            template: "classic",
            language: "en",
          },
        );
        const eurPdfHtml = capturedHtml.at(-1) ?? "";
        expect(eurPdfHtml).toContain("hero-val");
        expect(eurPdfHtml).toContain("<svg");
      }).pipe(Effect.provide(layer)),
    );

    // 4. R1a workspace-read ordering on denied PDF + StoreUnavailable propagation on getMany & audit.history
    let workspaceReads = 0;
    const basePorts = InMemoryCorePorts();
    const baseRepos = CoreReposMemory.pipe(Layer.provideMerge(basePorts));
    const spyWorkspacesRepo = Layer.effect(
      WorkspacesRepo,
      Effect.map(WorkspacesRepo, (repo) =>
        WorkspacesRepo.of({
          ...repo,
          getWorkspace: (id) =>
            Effect.sync(() => {
              workspaceReads += 1;
            }).pipe(Effect.andThen(repo.getWorkspace(id))),
        }),
      ),
    ).pipe(Layer.provide(baseRepos));
    let failGetMany = false;
    const spyDocumentsRepo = Layer.effect(
      DocumentsRepo,
      Effect.map(DocumentsRepo, (repo) =>
        DocumentsRepo.of({
          ...repo,
          getMany: (ws, ids) =>
            failGetMany ? Effect.fail(new StoreUnavailable({})) : repo.getMany(ws, ids),
        }),
      ),
    ).pipe(Layer.provide(baseRepos));
    let failAudit = false;
    const spyCoreStore = Layer.effect(
      CoreStore,
      Effect.map(CoreStore, (store) =>
        CoreStore.of({
          ...store,
          audit: {
            ...store.audit,
            history: (ws, subject) =>
              failAudit ? Effect.fail(new StoreUnavailable({})) : store.audit.history(ws, subject),
          },
        }),
      ),
    ).pipe(Layer.provide(baseRepos));

    const spyRepos = Layer.mergeAll(baseRepos, spyWorkspacesRepo, spyDocumentsRepo, spyCoreStore);
    const spyFakes = Layer.mergeAll(
      UserDirectoryFake.layer([{ userId, name: "Eva", email: "eva@example.cz" }]),
      CaptureInvitationDelivery.layer,
      InvitationTokensFake,
      DeliveryJobsMemory,
      FakeExportWorkflow.layer,
      ShareLinkKeysTest,
      IdGeneratorTest,
      FakeCompanyRegistry.layer(),
      FixtureRates.layer(),
      CaptureEmailSender.layer,
    );
    const spyPdf = makePdfRenderersLayer(makeCapturePdfEngine([])).pipe(
      Layer.provide(Layer.mergeAll(spyRepos, spyFakes)),
    );
    const spyCore = CoreModulesLive.pipe(
      Layer.provideMerge(Layer.mergeAll(spyRepos, spyFakes, spyPdf)),
    );
    const spyLayer = ServerDocumentProjectionsLive.pipe(
      Layer.provideMerge(spyCore),
      Layer.provideMerge(TestClock.layer()),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-10-05T10:00:00Z"));
        const workspaces = yield* Workspaces;
        const contacts = yield* Contacts;
        const documents = yield* Documents;
        const memberCaller = yield* workspaces
          .create({ name: "Spy Studio", initialTaxRegime: "non_vat_payer" })
          .pipe(
            Effect.provideService(
              CurrentCaller,
              Caller.account({ userId, email: "eva@example.cz", locale: "cs", channel: "web" }),
            ),
          );
        const asMember = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
          Effect.provideService(eff, CurrentCaller, memberCaller);
        yield* asMember(
          workspaces.saveBankAccount({
            name: "CZK",
            currency: CurrencyCode.make("CZK"),
            iban: "CZ6508000000192000145399",
            bic: "GIBACZPX",
            isDefault: true,
          } as never),
        );
        const contact = yield* asMember(
          contacts.save({
            name: "Buyer",
            address: { street: "A 1", city: "Praha", postalCode: "110 00", country: "CZ" },
          } as never),
        );
        const inv = yield* asMember(
          documents.issue(
            {
              input: {
                kind: "invoice",
                contact: contact.id as ContactId,
                variableSymbol: "2612345678",
                lines: [
                  {
                    description: "Work",
                    quantity: BigDecimal.fromStringUnsafe("1"),
                    unitPrice: BigDecimal.fromStringUnsafe("1000"),
                  },
                ],
              },
            },
            { requestKey: "rk-spy-1" as RequestKey },
          ),
        );

        // R1a: unauthorized caller fails with Forbidden with ZERO WorkspacesRepo reads
        const limitedCaller = { ...memberCaller, scopes: ["contacts:read"] as never };
        const readsBeforeDenied = workspaceReads;
        const deniedExit = yield* Effect.exit(
          documents.pdf(inv.id).pipe(Effect.provideService(CurrentCaller, limitedCaller)),
        );
        expect(deniedExit._tag).toBe("Failure");
        expect(workspaceReads).toBe(readsBeforeDenied);

        // Failed credit lookup (StoreUnavailable on getMany) must NOT return payable QR
        yield* asMember(documents.correct(inv.id, { reason: "Full credit", lines: "full" }));
        failGetMany = true;
        const creditFailExit = yield* Effect.exit(asMember(documents.get(inv.id)));
        failGetMany = false;
        expect(creditFailExit._tag).toBe("Failure");

        // Failed audit read on historical replay must NOT silently return newer symbol
        const inv2 = yield* asMember(
          documents.issue(
            {
              input: {
                kind: "invoice",
                contact: contact.id as ContactId,
                variableSymbol: "2612345678",
                lines: [
                  {
                    description: "Work 2",
                    quantity: BigDecimal.fromStringUnsafe("1"),
                    unitPrice: BigDecimal.fromStringUnsafe("1000"),
                  },
                ],
              },
            },
            { requestKey: "rk-spy-2" as RequestKey },
          ),
        );
        yield* asMember(documents.edit(inv2.id, { variableSymbol: "777777" }, inv2.revision));
        failAudit = true;
        const auditFailExit = yield* Effect.exit(
          asMember(
            documents.issue(
              {
                input: {
                  kind: "invoice",
                  contact: contact.id as ContactId,
                  variableSymbol: "2612345678",
                  lines: [
                    {
                      description: "Work 2",
                      quantity: BigDecimal.fromStringUnsafe("1"),
                      unitPrice: BigDecimal.fromStringUnsafe("1000"),
                    },
                  ],
                },
              },
              { requestKey: "rk-spy-2" as RequestKey },
            ),
          ),
        );
        failAudit = false;
        expect(auditFailExit._tag).toBe("Failure");
      }).pipe(Effect.provide(spyLayer)),
    );
  });
});
