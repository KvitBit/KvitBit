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
import { toSvg } from "@kvitbit/adapters/qr";
import { ALL_SCOPES } from "@kvitbit/api-contract";
import {
  CoreModulesLive,
  CoreStore,
  DeliveriesRepo,
  DocumentRenderer,
  DocumentsRepo,
  deliveryJob,
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
  BankAccountInput,
  Caller,
  ContactId,
  ContactSnapshot,
  Contacts,
  CurrencyCode,
  DocumentId,
  Documents,
  type DocumentView,
  IsoDate,
  IssuerSnapshot,
  Payments,
  PublicShareLinks,
  RequestKey,
  ShareToken,
  TemplateId,
  Templates,
  UserId,
  VisitorHash,
  WorkspaceId,
  Workspaces,
} from "@kvitbit/domain/contract";
import { BlobKey, BlobStorage } from "@kvitbit/domain/ports";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import * as TestClock from "effect/testing/TestClock";
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

const makeLivePdfCore = (
  capturedHtml: Array<string>,
  rejectDocumentRead?: (id: DocumentId) => boolean,
) => {
  const userId = UserId.make("01950000-0000-7000-8000-000000000001");
  const basePorts = InMemoryCorePorts();
  const repos = CoreReposMemory.pipe(Layer.provideMerge(basePorts));
  const baseRepos =
    rejectDocumentRead === undefined
      ? repos
      : Layer.effect(
          DocumentsRepo,
          Effect.map(DocumentsRepo, (repo) =>
            DocumentsRepo.of({
              ...repo,
              get: (workspaceId, id) =>
                Effect.suspend(() =>
                  rejectDocumentRead(id) === true
                    ? Effect.fail(StoreUnavailable.make({}))
                    : repo.get(workspaceId, id),
                ),
            }),
          ),
        ).pipe(Layer.provideMerge(repos));
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

const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Fn.flow(Schema.decodeUnknownResult(schema), Result.getOrThrow);

const invoiceNumber = String(202612345678);
const PaymentQrField = Schema.Struct({
  paymentQr: Schema.NullOr(Schema.Struct({ format: Schema.String, payload: Schema.String })),
});
const decodeDocumentQr = decode(PaymentQrField);
const decodeIssuedDocument = decode(Schema.Struct({ id: Schema.String, ...PaymentQrField.fields }));
const decodeToolDocument = decode(
  Schema.Struct({ structuredContent: Schema.Struct({ document: PaymentQrField }) }),
);
const decodeContactId = decode(ContactId);
const decodeTemplateId = decode(TemplateId);
const decodeContact = decode(Schema.Struct({ id: Schema.String }));
const decodeShareLink = decode(Schema.Struct({ url: Schema.String }));
const decodeResource = decode(
  Schema.Struct({ contents: Schema.Array(Schema.Struct({ text: Schema.String })) }),
);
const decodeResourceDocument = decode(Schema.fromJsonString(PaymentQrField));
const encodeJson = Fn.flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Json)),
  Result.getOrThrow,
);
const JsonObjectFromString = Schema.fromJsonString(Schema.JsonObject);
const decodeRenderModel = decode(Schema.Union([JsonObjectFromString, Schema.JsonObject]));
const decodeJsonObject = decode(Schema.JsonObject);

const sampleDocumentView = (overrides: Partial<DocumentView> = {}): DocumentView => ({
  id: DocumentId.make("01950000-0000-7000-8000-000000000001"),
  kind: "invoice",
  number: invoiceNumber,
  status: "issued",
  locked: false,
  settlement: "unpaid",
  overdue: false,
  revision: 1,
  taxDocument: true,
  contact: ContactSnapshot.make({
    contactId: "01950000-0000-7000-8000-000000000002",
    name: "Odběratel a.s.",
    ico: "87654321",
    dic: "CZ87654321",
    legalForm: "a.s.",
    address: { street: "Václavské nám. 1", city: "Praha 1", postalCode: "110 00", country: "CZ" },
    billingEmails: ["billing@odberatel.cz"],
  }),
  issuer: IssuerSnapshot.make({
    workspaceId: WorkspaceId.make("01950000-0000-7000-8000-000000000003"),
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
  }),
  dates: {
    issuedOn: IsoDate.make("2026-11-20"),
    taxableSupplyOn: IsoDate.make("2026-11-20"),
    dueOn: IsoDate.make("2026-12-04"),
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
    expect(resolveVariableSymbol(null, invoiceNumber)).toBe("2612345678");
    expect(resolveVariableSymbol("998877", invoiceNumber)).toBe("998877");

    const model = documentViewToRenderModel(sampleDocumentView({ number: invoiceNumber }));
    expect(model.variableSymbol).toBe("2612345678");
    expect(model.paymentQr?.format).toBe("spayd");
    expect(model.paymentQr?.payload).toContain("X-VS:2612345678");
    expect(model.paymentQr?.payload).not.toContain("X-VS:2026123456");
  });

  test("Finding 6 & 8 end-to-end: Credit Note PDF has real original issue date + stored reason; branding/images, default template, and revision cache work", async () => {
    const capturedHtml: Array<string> = [];
    let rejectRead: DocumentId | undefined;
    const { userId, layer } = makeLivePdfCore(capturedHtml, (id) => {
      if (id !== rejectRead) return false;
      rejectRead = undefined;
      return true;
    });

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
        const memberCaller = yield* workspaces.create(accountCaller, {
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
        });

        // Add CZK bank account with IBAN, upload logo & stamp, set modern_minimal + accent + footer
        yield* workspaces.saveBankAccount(
          memberCaller,
          BankAccountInput.make({
            name: "Hlavní CZK",
            currency: CurrencyCode.make("CZK"),
            accountNumber: "123456789/0100",
            iban: "CZ6508000000192000145399",
            bic: "GIBACZPX",
            isDefault: true,
          }),
        );
        yield* workspaces.setBrandingImage(memberCaller, "logo", {
          contentType: "image/png",
          bytes: Stream.succeed(LOGO_PNG),
        });
        yield* workspaces.setBrandingImage(memberCaller, "stamp", {
          contentType: "image/png",
          bytes: Stream.succeed(STAMP_PNG),
        });
        const wsBefore = yield* workspaces.current(memberCaller);
        const wsBranded = yield* workspaces.updateSettings(
          memberCaller,
          {
            branding: {
              pdfTemplate: "modern_minimal",
              accentColor: "#0F5D42",
              footerText: "Děkujeme za spolupráci",
            },
          },
          wsBefore.revision,
        );

        // Finding 8a: previewBranding includes uploaded logo + stamp + accent + footer, and is never cached
        const preview1 = yield* workspaces.previewBranding(memberCaller, {
          kind: "invoice",
          language: "cs",
          branding: {},
        });
        yield* Stream.runDrain(preview1.bytes);
        const preview2 = yield* workspaces.previewBranding(memberCaller, {
          kind: "invoice",
          language: "cs",
          branding: {},
        });
        yield* Stream.runDrain(preview2.bytes);
        expect(capturedHtml.length).toBe(2);
        const logoB64 = Buffer.from(LOGO_PNG).toString("base64");
        const stampB64 = Buffer.from(STAMP_PNG).toString("base64");
        expect(capturedHtml[0]).toContain("#0F5D42");
        expect(capturedHtml[0]).toContain("Děkujeme za spolupráci");
        expect(capturedHtml[0]).toContain(`data:image/png;base64,${logoB64}`);
        expect(capturedHtml[0]).toContain(`data:image/png;base64,${stampB64}`);

        // Create contact and issue invoice on 2026-10-05 with custom variableSymbol
        const contact = yield* contacts.save(memberCaller, {
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
        });
        const invoice = yield* documents.issue(memberCaller, {
          input: {
            kind: "invoice",
            contact: decodeContactId(contact["id"]),
            issuedOn: IsoDate.make("2026-10-05"),
            taxableSupplyOn: IsoDate.make("2026-10-05"),
            variableSymbol: "2612345678",
            lines: [
              {
                description: "Vývoj software",
                quantity: BigDecimal.fromStringUnsafe("1"),
                unitPrice: BigDecimal.fromStringUnsafe("1000"),
              },
            ],
          },
        });
        expect(invoice.paymentQr?.format).toBe("spayd");
        expect(invoice.paymentQr?.payload).toContain("X-VS:2612345678");

        // Finding 8b: Documents.pdf without template uses workspace default ("modern_minimal"),
        // embeds workspace branding + logo/stamp, and caches under (docRev, wsRev).
        const countBeforePdf = capturedHtml.length;
        const pdf1 = yield* documents.pdf(memberCaller, invoice.id);
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
        const pdf2 = yield* documents.pdf(memberCaller, invoice.id);
        yield* Stream.runDrain(pdf2.bytes);
        expect(capturedHtml.length).toBe(countBeforePdf + 1);

        // Share link open returns exact same paymentQr; share PDF hits the same cache!
        const createdShare = yield* shareLinks.create(memberCaller, invoice.id);
        const shareToken = Str.split(createdShare.url, "/").pop() ?? "";
        const visitorCaller = Caller.shareLinkVisitor({
          token: ShareToken.make(shareToken),
          visitor: VisitorHash.make("visitor-hash-1"),
          locale: "cs",
        });
        const sharedView = yield* shareLinks.open(visitorCaller);
        expect(sharedView.paymentQr).toEqual(invoice.paymentQr);

        const sharePdf = yield* shareLinks.pdf(visitorCaller);
        yield* Stream.runDrain(sharePdf.bytes);
        expect(capturedHtml.length).toBe(countBeforePdf + 1);

        // Changing workspace branding bumps workspace revision -> cache miss and new accent rendered
        yield* workspaces.updateSettings(
          memberCaller,
          { branding: { accentColor: "#1D4ED8" } },
          wsBranded.revision,
        );
        const pdfAfterBranding = yield* documents.pdf(memberCaller, invoice.id);
        yield* Stream.runDrain(pdfAfterBranding.bytes);
        expect(capturedHtml.length).toBe(countBeforePdf + 2);
        expect(capturedHtml.at(-1)).toContain("#1D4ED8");

        // Explicit template override ("classic") bypasses workspace default
        const pdfClassic = yield* documents.pdf(memberCaller, invoice.id, { template: "classic" });
        yield* Stream.runDrain(pdfClassic.bytes);
        expect(capturedHtml.length).toBe(countBeforePdf + 3);
        expect(capturedHtml.at(-1)).not.toContain("hero-val");

        // Finding 6: Issue Credit Note on a DIFFERENT date (2026-11-20) with a stored reason
        yield* TestClock.setTime(Date.parse("2026-11-20T10:00:00Z"));
        const creditNote = yield* documents.correct(memberCaller, invoice.id, {
          reason: "Vrácení vadného zboží",
          lines: "full",
        });
        expect(String(creditNote.dates.issuedOn)).toBe("2026-11-20");
        expect(creditNote.paymentQr).toBeNull();

        const beforeCreditPdf = capturedHtml.length;
        rejectRead = invoice.id;
        const unavailableOriginal = yield* documents
          .pdf(memberCaller, creditNote.id)
          .pipe(Effect.exit);
        expect(unavailableOriginal._tag).toBe("Failure");
        expect(rejectRead).toBeUndefined();
        expect(capturedHtml).toHaveLength(beforeCreditPdf);

        const cnPdf = yield* documents.pdf(memberCaller, creditNote.id);
        yield* Stream.runDrain(cnPdf.bytes);
        expect(capturedHtml).toHaveLength(beforeCreditPdf + 1);
        const cnHtml = Str.replace(/\u00a0/g, " ")(capturedHtml.at(-1) ?? "");
        // Czech date formatting: 05. 10. 2026 (original) vs 20. 11. 2026 (credit note)
        expect(cnHtml).toContain("Vrácení vadného zboží");
        expect(cnHtml).toContain(invoice.number ?? "");
        expect(cnHtml).toContain("05. 10. 2026");
        expect(cnHtml).toContain("20. 11. 2026");

        const cachedCreditPdf = yield* documents.pdf(memberCaller, creditNote.id);
        yield* Stream.runDrain(cachedCreditPdf.bytes);
        expect(capturedHtml).toHaveLength(beforeCreditPdf + 1);
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
          yield* ws.saveBankAccount(
            member,
            BankAccountInput.make({
              name: "CZK",
              currency: CurrencyCode.make("CZK"),
              accountNumber: "123456789/0100",
              iban: "CZ6508000000192000145399",
              bic: "GIBACZPX",
              isDefault: true,
            }),
          );
        }),
      );

      const contactRes = await http.fetch(`/api/v1/workspaces/${member.workspaceId}/contacts`, {
        method: "POST",
        headers: { ...authHeader, "content-type": "application/json" },
        body: encodeJson({
          name: "Klient s.r.o.",
          address: { street: "Ulice 1", city: "Praha", postalCode: "110 00", country: "CZ" },
        }),
      });
      const contact = decodeContact(await contactRes.json());

      const issueRes = await http.fetch(
        `/api/v1/workspaces/${member.workspaceId}/documents/issue`,
        {
          method: "POST",
          headers: { ...authHeader, "content-type": "application/json" },
          body: encodeJson({
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
      const issued = decodeIssuedDocument(await issueRes.json());
      expect(issued.paymentQr).not.toBeNull();
      expect(issued.paymentQr?.format).toBe("spayd");
      expect(issued.paymentQr?.payload).toContain("X-VS:2612345678");

      const getRes = await http.fetch(
        `/api/v1/workspaces/${member.workspaceId}/documents/${issued.id}`,
        { headers: authHeader },
      );
      expect(getRes.status).toBe(200);
      const fetched = decodeDocumentQr(await getRes.json());
      expect(fetched.paymentQr).toEqual(issued.paymentQr);

      // Share link open returns exact same paymentQr
      const shareRes = await http.fetch(
        `/api/v1/workspaces/${member.workspaceId}/documents/${issued.id}/share-link`,
        { method: "PUT", headers: authHeader },
      );
      expect(shareRes.status).toBe(200);
      const { url } = decodeShareLink(await shareRes.json());
      const token = Str.split(url, "/").pop() ?? "";
      const openRes = await http.fetch(`/api/v1/share/${token}`);
      expect(openRes.status).toBe(200);
      const shared = decodeDocumentQr(await openRes.json());
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
          yield* ws.saveBankAccount(
            member,
            BankAccountInput.make({
              name: "CZK",
              currency: CurrencyCode.make("CZK"),
              accountNumber: "123456789/0100",
              iban: "CZ6508000000192000145399",
              bic: "GIBACZPX",
              isDefault: true,
            }),
          );
          const contact = yield* contacts.save(member, {
            name: "MCP Buyer s.r.o.",
            address: { street: "Ulice 2", city: "Brno", postalCode: "602 00", country: "CZ" },
          });
          const issued = yield* docs.issue(member, {
            input: {
              kind: "invoice",
              contact: decodeContactId(contact["id"]),
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
        }),
      );

      const toolCall = await mcp.callTool(grant.token, "get_document", { documentId: docId });
      const toolDoc = decodeToolDocument(toolCall.result).structuredContent.document;
      expect(toolDoc.paymentQr).not.toBeNull();
      expect(toolDoc.paymentQr?.format).toBe("spayd");
      expect(toolDoc.paymentQr?.payload).toContain("X-VS:2612345678");

      const resCall = await mcp.rpc(grant.token, "resources/read", {
        uri: `kvitbit://documents/${docId}`,
      });
      const resText = decodeResource(resCall.json["result"]).contents[0]?.text;
      const resDoc = decodeResourceDocument(resText);
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
        const memberCaller = yield* workspaces.create(accountCaller, {
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
        });

        yield* workspaces.saveBankAccount(
          memberCaller,
          BankAccountInput.make({
            name: "Hlavní CZK",
            currency: CurrencyCode.make("CZK"),
            accountNumber: "123456789/0100",
            iban: "CZ6508000000192000145399",
            bic: "GIBACZPX",
            isDefault: true,
          }),
        );
        const uploadedLogo = yield* workspaces.setBrandingImage(memberCaller, "logo", {
          contentType: "image/png",
          bytes: Stream.succeed(LOGO_PNG),
        });
        const wsCur = yield* workspaces.current(memberCaller);
        yield* workspaces.updateSettings(
          memberCaller,
          { branding: { pdfTemplate: "modern_minimal" } },
          wsCur.revision,
        );

        const contact = yield* contacts.save(memberCaller, {
          name: "Odběratel a.s.",
          address: { street: "Ulice 1", city: "Praha", postalCode: "110 00", country: "CZ" },
        });

        // 1. C3 request-key replay + J3 queued delivery snapshot
        const issueReqKey = RequestKey.make("rk-c3-issue-001");
        const issued = yield* documents.issue(
          memberCaller,
          {
            input: {
              kind: "invoice",
              contact: decodeContactId(contact["id"]),
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
        );
        expect(issued.paymentQr?.payload).toContain("AM:1000.00");
        expect(issued.paymentQr?.payload).toContain("X-VS:2612345678");

        // Edit variableSymbol and note -> rev 2
        const edited = yield* documents.edit(
          memberCaller,
          issued.id,
          { variableSymbol: "777777", note: "Nová poznámka" },
          issued.revision,
        );
        expect(edited.revision).toBe(issued.revision + 1);
        expect(edited.paymentQr?.payload).toContain("X-VS:777777");

        // C3: Replay original issue requestKey -> must return original rev and original QR symbol!
        const replayed = yield* documents.issue(
          memberCaller,
          {
            input: {
              kind: "invoice",
              contact: decodeContactId(contact["id"]),
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
        );
        expect(replayed.revision).toBe(issued.revision);
        expect(replayed.paymentQr).toEqual(issued.paymentQr);

        // J3: Rendering frozen historical view (rev 1) uses rev 1's variableSymbol & note, not rev 2's,
        // and uses workspace default template ("modern_minimal") when ExplicitPdfTemplate is absent!
        const frozenView = { ...issued, paymentQr: null };
        yield* renderer.render(
          frozenView,
          { template: "classic", language: "cs" },
          memberCaller.workspaceId,
        );
        const frozenHtml = capturedHtml.at(-1) ?? "";
        expect(frozenHtml).toContain("2612345678");
        expect(frozenHtml).not.toContain("777777");
        expect(frozenHtml).toContain("Původní poznámka");
        expect(frozenHtml).not.toContain("Nová poznámka");
        expect(frozenHtml).toContain("hero-val");

        // 2. Partial payment (300 of 1000) -> QR requests 700.00; full payment -> QR is null
        yield* payments.record(memberCaller, {
          target: { document: issued.id },
          amount: money("300"),
          paidOn: IsoDate.make("2026-10-06"),
          method: "bank_transfer",
        });
        const partialDoc = yield* documents.get(memberCaller, issued.id);
        expect(partialDoc.paymentQr?.payload).toContain("AM:700.00");

        const shareCreated = yield* shareLinks.create(memberCaller, issued.id);
        const shareToken = Str.split(shareCreated.url, "/").pop() ?? "";
        const visitorCaller = Caller.shareLinkVisitor({
          token: ShareToken.make(shareToken),
          visitor: VisitorHash.make("visitor-pay-1"),
          locale: "cs",
        });
        const partialShare = yield* shareLinks.open(visitorCaller);
        expect(partialShare.paymentQr).toEqual(partialDoc.paymentQr);

        yield* payments.record(memberCaller, {
          target: { document: issued.id },
          amount: money("700"),
          paidOn: IsoDate.make("2026-10-07"),
          method: "bank_transfer",
        });
        const paidDoc = yield* documents.get(memberCaller, issued.id);
        expect(paidDoc.paymentQr).toBeNull();
        const paidShare = yield* shareLinks.open(visitorCaller);
        expect(paidShare.paymentQr).toBeNull();

        // 3. Templates.use returns projected paymentQr matching Documents.get
        const tpl = yield* templates.save(memberCaller, {
          name: "Měsíční paušál",
          kind: "invoice",
          contact: decodeContactId(contact["id"]),
          lines: [
            {
              description: "Paušál",
              quantity: BigDecimal.fromStringUnsafe("1"),
              unitPrice: BigDecimal.fromStringUnsafe("2000"),
            },
          ],
        });
        const fromTemplate = yield* templates.use(memberCaller, decodeTemplateId(tpl["id"]), {
          as: "issued",
        });
        const fromGet = yield* documents.get(memberCaller, fromTemplate.id);
        expect(fromTemplate.paymentQr).not.toBeNull();
        expect(fromTemplate.paymentQr).toEqual(fromGet.paymentQr);

        // 4. Branding image temporarily unreadable -> incomplete PDF is NOT cached;
        // restoring bytes triggers a fresh render with the logo!
        const logoKey = BlobKey.make(
          `branding/${memberCaller.workspaceId}/logo/${uploadedLogo.sha256}`,
        );
        const logoB64 = Buffer.from(LOGO_PNG).toString("base64");
        yield* blobs.delete(logoKey);

        const rendersBeforeMissing = capturedHtml.length;
        const pdfMissingLogo = yield* documents.pdf(memberCaller, fromTemplate.id);
        yield* Stream.runDrain(pdfMissingLogo.bytes);
        expect(capturedHtml.length).toBe(rendersBeforeMissing + 1);
        expect(capturedHtml.at(-1)).not.toContain(`data:image/png;base64,${logoB64}`);

        // Restore logo bytes -> next call MUST re-render with logo!
        yield* blobs.put(logoKey, Stream.succeed(LOGO_PNG), {
          contentType: "image/png",
          maxBytes: 1024 * 1024,
        });
        const pdfRestoredLogo = yield* documents.pdf(memberCaller, fromTemplate.id);
        yield* Stream.runDrain(pdfRestoredLogo.bytes);
        expect(capturedHtml.length).toBe(rendersBeforeMissing + 2);
        expect(capturedHtml.at(-1)).toContain(`data:image/png;base64,${logoB64}`);

        // Subsequent call now hits the complete cache
        const pdfCachedComplete = yield* documents.pdf(memberCaller, fromTemplate.id);
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
          yield* ws.saveBankAccount(
            httpMember,
            BankAccountInput.make({
              name: "EUR",
              currency: CurrencyCode.make("EUR"),
              iban: "CZ6508000000192000145399",
              bic: "GIBACZPX",
              isDefault: true,
            }),
          );
          const contact = yield* contacts.save(httpMember, {
            name: "EU Client GmbH",
            address: { street: "Strasse 1", city: "Berlin", postalCode: "10115", country: "DE" },
          });
          const issued = yield* docs.issue(httpMember, {
            input: {
              kind: "invoice",
              contact: decodeContactId(contact["id"]),
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
          yield* payments.record(httpMember, {
            target: { document: issued.id },
            amount: money("250", CurrencyCode.make("EUR")),
            paidOn: IsoDate.make("2026-11-23"),
            method: "bank_transfer",
          });
          return issued.id;
        }),
      );

      const httpDocRes = await http.fetch(
        `/api/v1/workspaces/${httpMember.workspaceId}/documents/${httpDocId}`,
        { headers: authHeader },
      );
      expect(httpDocRes.status).toBe(200);
      const httpDoc = decodeDocumentQr(await httpDocRes.json());
      expect(httpDoc.paymentQr?.format).toBe("epc");
      expect(httpDoc.paymentQr?.payload).toContain("EUR750.00");

      const shareRes = await http.fetch(
        `/api/v1/workspaces/${httpMember.workspaceId}/documents/${httpDocId}/share-link`,
        { method: "PUT", headers: authHeader },
      );
      const { url } = decodeShareLink(await shareRes.json());
      const token = Str.split(url, "/").pop() ?? "";
      const shareDocRes = await http.fetch(`/api/v1/share/${token}`);
      const shareDoc = decodeDocumentQr(await shareDocRes.json());
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
          yield* ws.saveBankAccount(
            mcpMember,
            BankAccountInput.make({
              name: "EUR",
              currency: CurrencyCode.make("EUR"),
              iban: "CZ6508000000192000145399",
              bic: "GIBACZPX",
              isDefault: true,
            }),
          );
          const contact = yield* contacts.save(mcpMember, {
            name: "EU Client GmbH",
            address: { street: "Strasse 1", city: "Berlin", postalCode: "10115", country: "DE" },
          });
          const issued = yield* docs.issue(mcpMember, {
            input: {
              kind: "invoice",
              contact: decodeContactId(contact["id"]),
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
          yield* payments.record(mcpMember, {
            target: { document: issued.id },
            amount: money("250", CurrencyCode.make("EUR")),
            paidOn: IsoDate.make("2026-11-23"),
            method: "bank_transfer",
          });
          return issued.id;
        }),
      );

      const toolCall = await mcp.callTool(grant.token, "get_document", { documentId: mcpDocId });
      const toolDoc = decodeToolDocument(toolCall.result).structuredContent.document;
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

    let failSqlAudit = false;
    const persistenceWithAuditSpy = Layer.merge(
      persistence,
      Layer.effect(
        CoreStore,
        Effect.map(CoreStore, (store) =>
          CoreStore.of({
            ...store,
            audit: {
              ...store.audit,
              history: (ws, subject) =>
                failSqlAudit
                  ? Effect.fail(StoreUnavailable.make({}))
                  : store.audit.history(ws, subject),
            },
          }),
        ),
      ).pipe(Layer.provide(persistence)),
    );

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
      Layer.provide(Layer.mergeAll(persistenceWithAuditSpy, otherPorts)),
    );
    const core = CoreModulesLive.pipe(
      Layer.provideMerge(Layer.mergeAll(persistenceWithAuditSpy, otherPorts, pdfRenderers)),
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
        const memberCaller = yield* workspaces.create(accountCaller, {
          name: "SQL Studio s.r.o.",
          issuingEntity: {
            name: "SQL Studio s.r.o.",
            ico: "12345678",
            dic: "CZ12345678",
            address: { street: "Ulice 1", city: "Praha", postalCode: "110 00", country: "CZ" },
          },
          initialTaxRegime: "non_vat_payer",
        });

        yield* workspaces.saveBankAccount(
          memberCaller,
          BankAccountInput.make({
            name: "CZK",
            currency: CurrencyCode.make("CZK"),
            accountNumber: "123456789/0100",
            iban: "CZ6508000000192000145399",
            bic: "GIBACZPX",
            isDefault: true,
          }),
        );
        yield* workspaces.saveBankAccount(
          memberCaller,
          BankAccountInput.make({
            name: "EUR",
            currency: CurrencyCode.make("EUR"),
            iban: "CZ6508000000192000145399",
            bic: "GIBACZPX",
            isDefault: true,
          }),
        );
        yield* workspaces.setBrandingImage(memberCaller, "logo", {
          contentType: "image/png",
          bytes: Stream.succeed(LOGO_PNG),
        });
        const ws1 = yield* workspaces.current(memberCaller);
        yield* workspaces.updateSettings(
          memberCaller,
          { branding: { pdfTemplate: "modern_minimal", footerText: "QUEUE-FOOTER" } },
          ws1.revision,
        );

        const contact = yield* contacts.save(memberCaller, {
          name: "Klient s.r.o.",
          address: { street: "Ulice 2", city: "Brno", postalCode: "602 00", country: "CZ" },
          billingEmails: ["klient@example.cz"],
        });

        // 1. Draft QR consistency: preview, createDraft, and replayed createDraft all return the same eligible QR
        const draftInput = {
          kind: "invoice" as const,
          contact: decodeContactId(contact["id"]),
          note: "Draft poznámka",
          lines: [
            {
              description: "Služba",
              quantity: BigDecimal.fromStringUnsafe("1"),
              unitPrice: BigDecimal.fromStringUnsafe("1000"),
            },
          ] as const,
        };
        const previewDraft = yield* documents.preview(memberCaller, draftInput);
        expect(previewDraft.paymentQr?.format).toBe("spayd");
        expect(previewDraft.paymentQr?.payload).toContain("AM:1000.00");
        const draftReqKey = RequestKey.make("rk-draft-001");
        const createdDraft = yield* documents.createDraft(memberCaller, draftInput, {
          requestKey: draftReqKey,
        });
        expect(createdDraft.paymentQr).toEqual(previewDraft.paymentQr);
        yield* documents.edit(
          memberCaller,
          createdDraft.id,
          { note: "Upravená poznámka" },
          createdDraft.revision,
        );
        const replayedDraft = yield* documents.createDraft(memberCaller, draftInput, {
          requestKey: draftReqKey,
        });
        expect(replayedDraft.revision).toBe(createdDraft.revision);
        expect(replayedDraft.paymentQr).toEqual(createdDraft.paymentQr);

        // 2. Queued delivery snapshot (J3): partial payment (300/1000 -> 700 due), modern_minimal template,
        // then edit note/symbol AND change workspace template to classic BEFORE rendering!
        const invoice = yield* documents.issue(memberCaller, {
          input: {
            kind: "invoice",
            contact: decodeContactId(contact["id"]),
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
        });
        yield* payments.record(memberCaller, {
          target: { document: invoice.id },
          amount: money("300"),
          paidOn: IsoDate.make("2026-10-06"),
          method: "bank_transfer",
        });
        const sent = yield* documents.send(memberCaller, invoice.id, { purpose: "document" });
        const afterPayment = yield* documents.get(memberCaller, invoice.id);
        expect(afterPayment.paymentQr?.payload).toContain("AM:700.00");

        // Mutate document AND switch workspace default back to classic AFTER enqueue
        yield* documents.edit(
          memberCaller,
          invoice.id,
          { variableSymbol: "777777", note: "Edited note" },
          afterPayment.revision,
        );
        // Replace workspace logo + change template/footer AFTER enqueue
        yield* workspaces.setBrandingImage(memberCaller, "logo", {
          contentType: "image/png",
          bytes: Stream.succeed(STAMP_PNG),
        });
        const wsAfterLogoSwap = yield* workspaces.current(memberCaller);
        yield* workspaces.updateSettings(
          memberCaller,
          { branding: { pdfTemplate: "classic", footerText: "LATER-FOOTER" } },
          wsAfterLogoSwap.revision,
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
        const origLogoB64 = Buffer.from(LOGO_PNG).toString("base64");
        const newLogoB64 = Buffer.from(STAMP_PNG).toString("base64");
        expect(deliveryHtml).toContain("hero-val");
        expect(deliveryHtml).toContain("QUEUE-FOOTER");
        expect(deliveryHtml).not.toContain("LATER-FOOTER");
        expect(deliveryHtml).toContain(`data:image/png;base64,${origLogoB64}`);
        expect(deliveryHtml).not.toContain(`data:image/png;base64,${newLogoB64}`);
        expect(deliveryHtml).toContain("2612345678");
        expect(deliveryHtml).not.toContain("777777");
        expect(deliveryHtml).toContain("Frozen note");
        expect(deliveryHtml).not.toContain("Edited note");

        // Legacy queued delivery row (no __snapshot) with warm cache seeded at CURRENT workspace revision:
        // deliveryJob.dispatch returns "failed" normally on the FIRST call (J6), bumps revision,
        // keeps attempts=0, and makes zero EmailSender calls!
        const sql = yield* SqlClient.SqlClient;
        const wsCurrent = yield* workspaces.current(memberCaller);
        const blobs = yield* BlobStorage;
        const emailCapture = yield* CaptureEmailSender;
        const warmCurrentKey = documentPdfCacheKey({
          workspaceId: memberCaller.workspaceId,
          documentId: deliveryRow.documentId,
          documentRevision: deliveryRow.documentRevision,
          workspaceRevision: wsCurrent.revision,
          template: deliveryRow.attachment.template,
          language: deliveryRow.language,
        });
        yield* blobs.put(
          warmCurrentKey,
          Stream.succeed(new TextEncoder().encode("%PDF-1.4\n%warm-live-cache\n")),
          { contentType: "application/pdf", maxBytes: 1024 * 1024 },
        );

        const rawRow = yield* sql<{ readonly render_model: unknown }>`
          select render_model from deliveries where id = ${sent.deliveryId}
        `;
        const { __snapshot, ...parsedModel } = decodeRenderModel(rawRow[0]?.render_model);
        const snapshot = decodeJsonObject(__snapshot);
        const branding = decodeJsonObject(snapshot["branding"]);
        const { updatedAt: _updatedAt, ...malformedLogo } = decodeJsonObject(branding["logo"]);
        const malformedSnapshot = {
          ...snapshot,
          branding: { ...branding, logo: malformedLogo },
        };
        yield* sql`
          update deliveries
          set render_model = ${encodeJson({ ...parsedModel, __snapshot: malformedSnapshot })}::jsonb
          where id = ${sent.deliveryId}
        `;
        const malformedRowExit = yield* deliveriesRepo
          .get(memberCaller.workspaceId, sent.deliveryId)
          .pipe(Effect.exit);
        const malformedRowDefect = malformedRowExit.pipe(Exit.findDefect, Result.getOrThrow);
        expect(Schema.isSchemaError(malformedRowDefect)).toBe(true);

        // Exercise the renderer independently of SQL decoding with the live cache still warm.
        const malformedView = Object.defineProperty(
          { ...deliveryRow.view },
          Symbol.for("kvitbit/server/DeliveryRenderSnapshot"),
          { value: { ...malformedSnapshot, amountDue: money("700").amount } },
        );
        const malformedRenderExit = yield* renderer
          .render(malformedView, {
            template: deliveryRow.attachment.template,
            language: deliveryRow.language,
          })
          .pipe(Effect.exit);
        expect(malformedRenderExit._tag).toBe("Failure");
        const malformedRenderDefect = malformedRenderExit.pipe(Exit.findDefect, Result.getOrThrow);
        const { cause: brandingIssue } = decode(
          Schema.Struct({ cause: Schema.declare(SchemaIssue.isIssue) }),
        )(malformedRenderDefect);
        const { issues } = SchemaIssue.makeFormatterStandardSchemaV1()(brandingIssue);
        expect(issues).toContainEqual({
          path: ["branding", "logo", "updatedAt"],
          message: "Missing key",
        });

        yield* sql`
          update deliveries
          set render_model = ${encodeJson({ ...parsedModel, paymentQr: null })}::jsonb,
              status = 'queued',
              revision = 1,
              attempts = 0,
              failure = null
          where id = ${sent.deliveryId}
        `;
        // Direct legacy renderer call refuses BEFORE consulting the warm cache at attachment.template
        const legacyQueuedRow = yield* deliveriesRepo.get(
          memberCaller.workspaceId,
          sent.deliveryId,
        );
        const directLegacyExit = yield* Effect.exit(
          renderer.render(legacyQueuedRow.view, {
            template: legacyQueuedRow.attachment.template,
            language: legacyQueuedRow.language,
          }),
        );
        expect(directLegacyExit._tag).toBe("Failure");

        // Dispatch of a sending legacy row returns "failed" normally on first call (J6), bumps revision, attempts=0
        yield* sql`
          update deliveries
          set status = 'sending',
              revision = 1,
              attempts = 0,
              failure = null
          where id = ${sent.deliveryId}
        `;
        const sentBeforeDispatch = (yield* Ref.get(emailCapture.sent)).length;
        const firstDispatchOutcome = yield* deliveryJob.dispatch(
          memberCaller.workspaceId,
          sent.deliveryId,
        );
        expect(firstDispatchOutcome).toBe("failed");
        expect((yield* Ref.get(emailCapture.sent)).length).toBe(sentBeforeDispatch);
        const failedDelivery = yield* deliveriesRepo.get(memberCaller.workspaceId, sent.deliveryId);
        expect(failedDelivery.status).toBe("failed");
        expect(failedDelivery.revision).toBe(2);
        expect(failedDelivery.failure).toBe("delivery.snapshot_missing");
        expect(failedDelivery.attempts).toBe(0);

        // Positive-gross SQL invoice with valid null QR (EUR 1,000,000,000 exceeds EPC limit)
        // replayed directly without RequestOutcome returns paymentQr: null cleanly!
        const bigEurInput = {
          kind: "invoice" as const,
          contact: decodeContactId(contact["id"]),
          currency: CurrencyCode.make("EUR"),
          fx: { manual: { rate: BigDecimal.fromStringUnsafe("25"), quantity: 1 } },
          lines: [
            {
              description: "Mega contract",
              quantity: BigDecimal.fromStringUnsafe("1"),
              unitPrice: BigDecimal.fromStringUnsafe("1000000000"),
            },
          ] as const,
        };
        const bigEurKey = RequestKey.make("rk-epc-limit-sql-1");
        const bigEurInv = yield* documents.issue(
          memberCaller,
          { input: bigEurInput },
          { requestKey: bigEurKey },
        );
        expect(bigEurInv.paymentQr).toBeNull();
        yield* documents.edit(
          memberCaller,
          bigEurInv.id,
          { note: "Edited big EUR note" },
          bigEurInv.revision,
        );
        failSqlAudit = true;
        const bigEurReplay = yield* documents.issue(
          memberCaller,
          { input: bigEurInput },
          { requestKey: bigEurKey },
        );
        failSqlAudit = false;
        expect(bigEurReplay.revision).toBe(bigEurInv.revision);
        expect(bigEurReplay.paymentQr).toBeNull();

        // 3. System caller export default template: restore modern_minimal, render without ExplicitPdfTemplate
        const wsAfterClassic = yield* workspaces.current(memberCaller);
        yield* workspaces.updateSettings(
          memberCaller,
          { branding: { pdfTemplate: "modern_minimal" } },
          wsAfterClassic.revision,
        );
        const eurInvoice = yield* documents.issue(memberCaller, {
          input: {
            kind: "invoice",
            contact: decodeContactId(contact["id"]),
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
        yield* payments.record(memberCaller, {
          target: { document: eurInvoice.id },
          amount: money("250", CurrencyCode.make("EUR")),
          paidOn: IsoDate.make("2026-10-06"),
          method: "bank_transfer",
        });
        const eurAfterPay = yield* documents.get(memberCaller, eurInvoice.id);
        expect(eurAfterPay.paymentQr?.format).toBe("epc");
        expect(eurAfterPay.paymentQr?.payload).toContain("EUR750.00");

        // Render EUR PDF as System caller (export path, template="classic")
        yield* renderer.render(
          { ...eurAfterPay, paymentQr: null },
          {
            template: "classic",
            language: "en",
          },
        );
        const eurPdfHtml = capturedHtml.at(-1) ?? "";
        expect(eurPdfHtml).toContain("hero-val");
        const expectedEurSvg = toSvg(eurAfterPay.paymentQr?.payload ?? "", {
          margin: 4,
          color: "#09090B",
        });
        expect(eurPdfHtml).toContain(expectedEurSvg);
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
            failGetMany ? Effect.fail(StoreUnavailable.make({})) : repo.getMany(ws, ids),
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
              failAudit ? Effect.fail(StoreUnavailable.make({})) : store.audit.history(ws, subject),
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
        const memberCaller = yield* workspaces.create(
          Caller.account({ userId, email: "eva@example.cz", locale: "cs", channel: "web" }),
          { name: "Spy Studio", initialTaxRegime: "non_vat_payer" },
        );

        yield* workspaces.saveBankAccount(
          memberCaller,
          BankAccountInput.make({
            name: "CZK",
            currency: CurrencyCode.make("CZK"),
            iban: "CZ6508000000192000145399",
            bic: "GIBACZPX",
            isDefault: true,
          }),
        );
        const contact = yield* contacts.save(memberCaller, {
          name: "Buyer",
          address: { street: "A 1", city: "Praha", postalCode: "110 00", country: "CZ" },
        });
        const inv = yield* documents.issue(
          memberCaller,
          {
            input: {
              kind: "invoice",
              contact: decodeContactId(contact["id"]),
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
          { requestKey: RequestKey.make("rk-spy-1") },
        );

        // R1a: unauthorized caller fails with Forbidden with ZERO WorkspacesRepo reads
        const limitedCaller = { ...memberCaller, scopes: ["contacts:read"] as const };
        const readsBeforeDenied = workspaceReads;
        const deniedExit = yield* Effect.exit(documents.pdf(limitedCaller, inv.id));
        expect(deniedExit._tag).toBe("Failure");
        expect(workspaceReads).toBe(readsBeforeDenied);

        // Failed credit lookup (StoreUnavailable on getMany) must NOT return payable QR
        yield* documents.correct(memberCaller, inv.id, { reason: "Full credit", lines: "full" });
        failGetMany = true;
        const creditFailExit = yield* documents.get(memberCaller, inv.id).pipe(Effect.exit);
        failGetMany = false;
        expect(creditFailExit._tag).toBe("Failure");

        // Keyed replay on memory store preserves the original projected result even during an audit outage,
        // while direct historical rendering of an un-snapshotted older revision fails when audit is unavailable.
        const inv2 = yield* documents.issue(
          memberCaller,
          {
            input: {
              kind: "invoice",
              contact: decodeContactId(contact["id"]),
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
          { requestKey: RequestKey.make("rk-spy-2") },
        );
        yield* documents.edit(memberCaller, inv2.id, { variableSymbol: "777777" }, inv2.revision);
        failAudit = true;
        const replayedDuringAuditOutage = yield* documents.issue(
          memberCaller,
          {
            input: {
              kind: "invoice",
              contact: decodeContactId(contact["id"]),
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
          { requestKey: RequestKey.make("rk-spy-2") },
        );
        expect(replayedDuringAuditOutage.revision).toBe(inv2.revision);
        expect(replayedDuringAuditOutage.paymentQr).toEqual(inv2.paymentQr);

        const spyRenderer = yield* DocumentRenderer;
        const auditFailExit = yield* spyRenderer
          .render(
            { ...inv2, paymentQr: null },
            { template: "classic", language: "cs" },
            memberCaller.workspaceId,
          )
          .pipe(Effect.exit);
        failAudit = false;
        expect(auditFailExit._tag).toBe("Failure");

        // USD invoice (valid paymentQr: null) replayed after note edit succeeds even when audit is unavailable
        const usdInput = {
          kind: "invoice" as const,
          contact: decodeContactId(contact["id"]),
          currency: CurrencyCode.make("USD"),
          fx: { manual: { rate: BigDecimal.fromStringUnsafe("23"), quantity: 1 } },
          lines: [
            {
              description: "USD Work",
              quantity: BigDecimal.fromStringUnsafe("1"),
              unitPrice: BigDecimal.fromStringUnsafe("500"),
            },
          ] as const,
        };
        const usdReqKey = RequestKey.make("rk-spy-usd-1");
        const usdInv = yield* documents.issue(
          memberCaller,
          { input: usdInput },
          { requestKey: usdReqKey },
        );
        expect(usdInv.paymentQr).toBeNull();
        yield* documents.edit(
          memberCaller,
          usdInv.id,
          { note: "Edited USD note" },
          usdInv.revision,
        );
        failAudit = true;
        const usdReplay = yield* documents.issue(
          memberCaller,
          { input: usdInput },
          { requestKey: usdReqKey },
        );
        failAudit = false;
        expect(usdReplay.revision).toBe(usdInv.revision);
        expect(usdReplay.paymentQr).toBeNull();

        // Zero-value CZK invoice with IBAN replayed on memory store after note edit + audit outage succeeds
        const zeroMemInput = {
          kind: "invoice" as const,
          contact: decodeContactId(contact["id"]),
          lines: [
            {
              description: "Zero CZK",
              quantity: BigDecimal.fromStringUnsafe("1"),
              unitPrice: BigDecimal.fromStringUnsafe("0"),
            },
          ] as const,
        };
        const zeroMemKey = RequestKey.make("rk-spy-zero-1");
        const zeroMemInv = yield* documents.issue(
          memberCaller,
          { input: zeroMemInput },
          { requestKey: zeroMemKey },
        );
        expect(zeroMemInv.paymentQr).toBeNull();
        yield* documents.edit(
          memberCaller,
          zeroMemInv.id,
          { note: "Edited zero" },
          zeroMemInv.revision,
        );
        failAudit = true;
        const zeroMemReplay = yield* documents.issue(
          memberCaller,
          { input: zeroMemInput },
          { requestKey: zeroMemKey },
        );
        failAudit = false;
        expect(zeroMemReplay.revision).toBe(zeroMemInv.revision);
        expect(zeroMemReplay.paymentQr).toBeNull();

        // EUR 1,000,000,000 invoice (valid null QR due to EPC limit) replayed on memory store during audit outage
        yield* workspaces.saveBankAccount(
          memberCaller,
          BankAccountInput.make({
            name: "EUR",
            currency: CurrencyCode.make("EUR"),
            iban: "CZ6508000000192000145399",
            bic: "GIBACZPX",
            isDefault: true,
          }),
        );
        const bigEurMemInput = {
          kind: "invoice" as const,
          contact: decodeContactId(contact["id"]),
          currency: CurrencyCode.make("EUR"),
          fx: { manual: { rate: BigDecimal.fromStringUnsafe("25"), quantity: 1 } },
          lines: [
            {
              description: "Mega EUR",
              quantity: BigDecimal.fromStringUnsafe("1"),
              unitPrice: BigDecimal.fromStringUnsafe("1000000000"),
            },
          ] as const,
        };
        const bigEurMemKey = RequestKey.make("rk-spy-epc-limit-1");
        const bigEurMemInv = yield* documents.issue(
          memberCaller,
          { input: bigEurMemInput },
          { requestKey: bigEurMemKey },
        );
        expect(bigEurMemInv.paymentQr).toBeNull();
        yield* documents.edit(
          memberCaller,
          bigEurMemInv.id,
          { note: "Edited mega EUR" },
          bigEurMemInv.revision,
        );
        failAudit = true;
        const bigEurMemReplay = yield* documents.issue(
          memberCaller,
          { input: bigEurMemInput },
          { requestKey: bigEurMemKey },
        );
        failAudit = false;
        expect(bigEurMemReplay.revision).toBe(bigEurMemInv.revision);
        expect(bigEurMemReplay.paymentQr).toBeNull();

        // Expired memory requestKey reused with new payload after 24h must NOT return predecessor invoice
        const reuseKey = RequestKey.make("rk-spy-expire-reuse");
        const firstReuse = yield* documents.issue(
          memberCaller,
          {
            input: {
              kind: "invoice",
              contact: decodeContactId(contact["id"]),
              lines: [
                {
                  description: "First invoice",
                  quantity: BigDecimal.fromStringUnsafe("1"),
                  unitPrice: BigDecimal.fromStringUnsafe("500"),
                },
              ],
            },
          },
          { requestKey: reuseKey },
        );
        yield* TestClock.adjust("25 hours");
        const secondPayload = {
          kind: "invoice" as const,
          contact: decodeContactId(contact["id"]),
          lines: [
            {
              description: "Second invoice after expiry",
              quantity: BigDecimal.fromStringUnsafe("1"),
              unitPrice: BigDecimal.fromStringUnsafe("900"),
            },
          ] as const,
        };
        const secondReuse = yield* documents.issue(
          memberCaller,
          { input: secondPayload },
          { requestKey: reuseKey },
        );
        expect(secondReuse.id).not.toBe(firstReuse.id);
        const secondReuseReplay = yield* documents.issue(
          memberCaller,
          { input: secondPayload },
          { requestKey: reuseKey },
        );
        expect(secondReuseReplay.id).toBe(secondReuse.id);
        expect(secondReuseReplay.paymentQr?.payload).toContain("AM:900.00");
      }).pipe(Effect.provide(spyLayer)),
    );
  });
});
