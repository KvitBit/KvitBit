import { describe, expect, test } from "bun:test";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { PgliteClient } from "@effect/sql-pglite";
import { FakePdfEngine } from "@kvitbit/adapters/pdf";
import {
  BrandingPreview,
  DeliveryJobs,
  DocumentRenderer,
  InvitationTokens,
  ReportPdfRenderer,
  type ReportsModule,
  ShareLinkKeys,
} from "@kvitbit/core";
import {
  ContactId,
  ContactSnapshot,
  CurrencyCode,
  DeliveryId,
  DocumentId,
  type DocumentView,
  InvitationId,
  IsoDate,
  IssuerSnapshot,
  LineId,
  LineView,
  type Money,
  ShareToken,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { BlobKey, BlobStorage, EmailSender } from "@kvitbit/domain/ports";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Workflow from "effect/workflow/Workflow";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import {
  deriveInvitationTokenKey,
  deriveShareLinkKey,
  documentViewToRenderModel,
  type EmailWiringConfig,
  makeBlobStorageLayer,
  makeEmailSenderLayer,
  makeInvitationTokensLayer,
  makePdfRenderersLayer,
  makeShareLinkKeysLayer,
  parseSmtpUrl,
} from "../../src/wiring";
import {
  AttachmentInventory,
  localAttachmentInventory,
} from "../../src/wiring/attachmentInventory";
import { DeliveryJobsLive } from "../../src/wiring/workflows";

const money = (amount: string, currency = "CZK"): Money => ({
  amount: BigDecimal.fromStringUnsafe(amount),
  currency: CurrencyCode.make(currency),
});

const sampleDocumentView = (currency: "CZK" | "EUR" = "CZK"): DocumentView => ({
  id: DocumentId.make("01950000-0000-7000-8000-000000000001"),
  kind: "invoice",
  number: "2026-0001",
  status: "issued",
  locked: false,
  settlement: "unpaid",
  overdue: false,
  revision: 1,
  taxDocument: true,
  contact: ContactSnapshot.make({
    contactId: ContactId.make("01950000-0000-7000-8000-000000000002"),
    name: "Odběratel s.r.o.",
    ico: "12345678",
    dic: "CZ12345678",
    legalForm: "s.r.o.",
    address: { street: "Křižíkova 1", city: "Praha", postalCode: "186 00", country: "CZ" },
    billingEmails: ["billing@example.cz"],
  }),
  issuer: IssuerSnapshot.make({
    workspaceId: WorkspaceId.make("01950000-0000-7000-8000-000000000003"),
    name: "Dodavatel s.r.o.",
    ico: "87654321",
    dic: "CZ87654321",
    address: { street: "Vodičkova 2", city: "Praha", postalCode: "110 00", country: "CZ" },
    registerEntry: "Městský soud v Praze, C 12345",
    email: "faktury@dodavatel.cz",
    phone: "+420 123 456 789",
    web: "https://dodavatel.cz",
    regime: "vat_payer",
    bankAccount: {
      id: "01950000-0000-7000-8000-000000000004",
      name: "Hlavní",
      currency: CurrencyCode.make(currency),
      accountNumber: "19-2000145399/0800",
      iban: "CZ6508000000192000145399",
      bic: "GIBACZPX",
    },
  }),
  dates: {
    issuedOn: IsoDate.make("2026-01-15"),
    taxableSupplyOn: IsoDate.make("2026-01-15"),
    dueOn: IsoDate.make("2026-01-29"),
  },
  paymentMethod: "bank_transfer",
  lines: [
    LineView.make({
      id: LineId.make("01950000-0000-7000-8000-000000000005"),
      item: null,
      description: "Vývoj software",
      quantity: BigDecimal.fromStringUnsafe("1"),
      unit: "ks",
      unitPrice: BigDecimal.fromStringUnsafe("1000"),
      treatment: "standard",
      ratePercent: BigDecimal.fromStringUnsafe("21"),
      amount: BigDecimal.fromStringUnsafe("1210"),
      deducts: null,
    }),
  ],
  totals: {
    buckets: [
      {
        treatment: "standard",
        ratePercent: BigDecimal.fromStringUnsafe("21"),
        base: BigDecimal.fromStringUnsafe("1000"),
        vat: BigDecimal.fromStringUnsafe("210"),
        gross: BigDecimal.fromStringUnsafe("1210"),
        vatCzk: currency === "EUR" ? BigDecimal.fromStringUnsafe("5250") : null,
      },
    ],
    net: money("1000", currency),
    vat: money("210", currency),
    gross: money("1210", currency),
    roundingAdjustment: money("0", currency),
    vatCzk: currency === "EUR" ? money("5250", "CZK") : null,
  },
  fx: null,
  statutoryNotes: [],
  paymentQr: null,
  related: [],
  share: null,
  deliveries: [],
});

describe("wiring: secrets (HKDF ShareLinkKeys & InvitationTokens)", () => {
  test("derives distinct deterministic keys per version and builds normalized URLs", async () => {
    const secret = Redacted.make("super-secret-better-auth-key-for-tests");
    const authSecret = Redacted.value(secret);
    const [k1, k1Again, k2, invKey] = await Effect.runPromise(
      Effect.all(
        [
          deriveShareLinkKey(authSecret, 1),
          deriveShareLinkKey(authSecret, 1),
          deriveShareLinkKey(authSecret, 2),
          deriveInvitationTokenKey(authSecret),
        ],
        { concurrency: 1 },
      ),
    );

    // These bytes were produced by the original Node HKDF implementation.
    expect([...k1]).toEqual([
      130, 54, 186, 217, 90, 29, 193, 3, 62, 20, 79, 104, 41, 111, 202, 186, 173, 251, 160, 225, 39,
      211, 138, 188, 162, 224, 246, 48, 231, 109, 37, 202,
    ]);
    expect(Buffer.from(k1).equals(Buffer.from(k1Again))).toBe(true);
    expect(Buffer.from(k1).equals(Buffer.from(k2))).toBe(false);
    expect(Buffer.from(k1).equals(Buffer.from(invKey))).toBe(false);

    const urls = await Effect.runPromise(
      Effect.gen(function* () {
        const keys = yield* ShareLinkKeys;
        const tok = ShareToken.make("tok_abc123");
        return {
          version: keys.version,
          page: keys.pageUrl(tok),
          pdf: keys.pdfUrl(tok),
        };
      }).pipe(
        Effect.provide(
          makeShareLinkKeysLayer({
            authSecret: secret,
            shareKeyVersion: 3,
            appOrigin: "https://kvitbit.cz///",
          }),
        ),
      ),
    );

    expect(urls.version).toBe(3);
    expect(urls.page).toBe("https://kvitbit.cz/s/tok_abc123");
    expect(urls.pdf).toBe("https://kvitbit.cz/s/tok_abc123/pdf");
  });

  test("InvitationTokens produces deterministic distinct tokens per (invitationId, epoch)", async () => {
    const secret = Redacted.make("another-secret");
    const invId = InvitationId.make("01950000-0000-7000-8000-000000000099");

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const tokens = yield* InvitationTokens;
        const t0a = yield* tokens.token(invId, 0);
        const t0b = yield* tokens.token(invId, 0);
        const t1 = yield* tokens.token(invId, 1);
        return { t0a, t0b, t1 };
      }).pipe(Effect.provide(makeInvitationTokensLayer(secret))),
    );

    expect(result.t0a).toBe(result.t0b);
    expect(result.t0a).not.toBe(result.t1);
    // Preserve existing invitation tokens across changes to the HMAC implementation.
    expect([...Buffer.from(result.t0a, "base64url")]).toEqual([
      218, 205, 9, 3, 189, 15, 128, 237, 14, 32, 88, 182, 43, 170, 251, 45, 33, 1, 86, 220, 77, 248,
      187, 68, 22, 237, 29, 92, 151, 75, 247, 184,
    ]);
  });
});

describe("wiring: email & SMTP URL parsing", () => {
  test("parses smtp:// and smtps:// URLs with credentials and default ports", () => {
    const password = "s3cr3t";
    const plain = parseSmtpUrl(`smtp://user%40mail.cz:${password}@smtp.example.cz`);
    expect(plain.transport.host).toBe("smtp.example.cz");
    expect(plain.transport.port).toBe(587);
    expect(plain.transport.secure).toBe(false);
    expect(plain.transport.auth).toEqual({ user: "user@mail.cz", pass: password });

    const tls = parseSmtpUrl("smtps://mail.example.cz:2465");
    expect(tls.transport.port).toBe(2465);
    expect(tls.transport.secure).toBe(true);
    expect(tls.transport.auth).toBeUndefined();
  });

  test("captures preview mail even with a production provider configured", async () => {
    const send = Effect.flatMap(EmailSender, (sender) =>
      sender.send(
        {
          to: ["test@example.cz"],
          replyTo: "info@kvitbit.cz",
          subject: "Test",
          html: "<p>Test</p>",
          text: "Test",
          attachments: [],
          tags: { template: "test" },
        },
        { idempotencyKey: "k-1" },
      ),
    );
    const config: EmailWiringConfig = {
      from: "Kvitbit <noreply@kvitbit.cz>",
      resendApiKey: Option.none(),
      smtpUrl: Option.none(),
    };
    const sendWith = (nodeEnv: string, configuration = config) =>
      Effect.runPromise(
        send.pipe(Effect.provide(makeEmailSenderLayer(configuration, nodeEnv)), Effect.result),
      );

    expect(await sendWith("development")).toMatchObject({
      _tag: "Success",
      success: { provider: "console" },
    });
    expect(await sendWith("production")).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "EmailRejected" },
    });
    const configured = {
      ...config,
      resendApiKey: Option.some(Redacted.make("synthetic-resend-key")),
      smtpUrl: Option.some(Redacted.make("invalid-test-smtp-url")),
    };
    expect(await sendWith("development", configured)).toMatchObject({
      _tag: "Success",
      success: { provider: "capture" },
    });
    expect(await sendWith("preview", configured)).toMatchObject({
      _tag: "Success",
      success: { provider: "capture" },
    });
  });
});

describe("wiring: blob storage", () => {
  test("local driver stores, reads, and deletes blobs on disk", async () => {
    const roundtrip = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "kvitbit-blob-test-" });
        const layer = makeBlobStorageLayer({
          driver: "local",
          localDir: dir,
          gcsBucket: Option.none(),
          gcsProject: Option.none(),
        });
        const bytes = new TextEncoder().encode("hello blob");
        const key = BlobKey.make("exports/ws-1/test.txt");

        return yield* Effect.gen(function* () {
          const store = yield* BlobStorage;
          yield* store.put(key, Stream.succeed(bytes), {
            contentType: "text/plain",
            maxBytes: 1024,
          });
          const stream = yield* store.get(key);
          const chunks = yield* Stream.runCollect(stream);
          yield* store.delete(key);
          const afterDelete = yield* store.get(key).pipe(
            Effect.as(false),
            Effect.catchTag("BlobMissing", () => Effect.succeed(true)),
          );
          return {
            text: new TextDecoder().decode(chunks[0]),
            deleted: afterDelete,
          };
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)),
    );
    expect(roundtrip).toEqual({ text: "hello blob", deleted: true });
  });

  test("gcs driver fails with ConfigError when KVITBIT_BLOB_BUCKET is absent", async () => {
    const layer = makeBlobStorageLayer({
      driver: "gcs",
      localDir: "/tmp/unused",
      gcsBucket: Option.none(),
      gcsProject: Option.none(),
    });
    const exit = await Effect.runPromiseExit(layer.pipe(Layer.build, Effect.scoped));
    expect(exit._tag).toBe("Failure");
  });
});

test("local attachment inventory keeps fractional milliseconds in cutoff comparisons", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "kvitbit-attachment-test-" });
      const prefix =
        "workspaces/01950000-0000-7000-8000-000000000001/expenses/01950000-0000-7000-8000-000000000002/attachments";
      const key = BlobKey.make(`${prefix}/01950000-0000-7000-8000-000000000003`);
      const file = `${root}/${key}`;
      const modifiedAtSeconds = 1_700_000_000.123866;
      yield* fs.makeDirectory(`${root}/${prefix}`, { recursive: true });
      yield* fs.writeFileString(file, "fixture");
      yield* fs.utimes(file, modifiedAtSeconds, modifiedAtSeconds);
      yield* fs.symlink(file, `${root}/${prefix}/01950000-0000-7000-8000-000000000004`);
      yield* Effect.gen(function* () {
        const inventory = yield* AttachmentInventory;
        const newer = yield* Stream.runCollect(inventory.olderThan(1_700_000_000_123.5));
        const older = yield* Stream.runCollect(inventory.olderThan(1_700_000_000_124));
        const invalidCutoff = yield* Stream.runCollect(inventory.olderThan(Number.NaN));
        expect(newer).toEqual([]);
        expect(older).toEqual([key]);
        expect(invalidCutoff).toEqual([]);
      }).pipe(Effect.provide(localAttachmentInventory(root)));
    }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)),
  );
});

test("delivery reconciliation leaves a workflow suspended when failed is false", async () => {
  let resumeCount = 0;
  const engine = Layer.effect(
    WorkflowEngine.WorkflowEngine,
    Effect.map(WorkflowEngine.WorkflowEngine, (base) => ({
      ...base,
      poll: () => Effect.succeedSome(Workflow.Suspended.make({ failed: false })),
      resume: () =>
        Effect.sync(() => {
          resumeCount += 1;
        }),
    })),
  ).pipe(Layer.provide(WorkflowEngine.layerMemory));
  const layer = DeliveryJobsLive.pipe(Layer.provideMerge([engine, PgliteClient.layer({})]));
  const workspaceId = WorkspaceId.make("01950000-0000-7000-8000-000000000001");
  const deliveryId = DeliveryId.make("01950000-0000-7000-8000-000000000002");

  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const jobs = yield* DeliveryJobs;
      yield* sql`CREATE TABLE deliveries (id uuid, workspace_id uuid, status text, workflow_attempt integer)`;
      yield* sql`INSERT INTO deliveries VALUES (${deliveryId}, ${workspaceId}, 'queued', 0)`;
      yield* jobs.start(workspaceId, deliveryId);
    }).pipe(Effect.provide(layer)),
  );
  expect(resumeCount).toBe(0);
}, 30_000);

describe("wiring: PDF renderers (DocumentRenderer, ReportPdfRenderer, BrandingPreview)", () => {
  const pdfLayer = makePdfRenderersLayer(FakePdfEngine);

  test("DocumentRenderer computes SPAYD QR for CZK and EPC QR for EUR and renders PDF bytes", async () => {
    const czkModel = documentViewToRenderModel(sampleDocumentView("CZK"));
    expect(czkModel.paymentQr?.format).toBe("spayd");
    expect(czkModel.paymentQr?.payload).toContain("SPD*1.0*");

    const eurModel = documentViewToRenderModel(sampleDocumentView("EUR"));
    expect(eurModel.paymentQr?.format).toBe("epc");
    expect(eurModel.paymentQr?.payload).toContain("BCD\n002");

    const bytes = await Effect.runPromise(
      Effect.gen(function* () {
        const renderer = yield* DocumentRenderer;
        return yield* renderer.render(sampleDocumentView("CZK"), {
          template: "classic",
          language: "cs",
        });
      }).pipe(Effect.provide(pdfLayer)),
    );
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  test("ReportPdfRenderer renders all 6 report kinds", async () => {
    const period = { from: IsoDate.make("2026-01-01"), to: IsoDate.make("2026-12-31") };
    const wsId = WorkspaceId.make("01950000-0000-7000-8000-000000000003");
    const views: ReadonlyArray<ReportsModule.ReportViewData> = [
      {
        report: "revenue",
        period,
        groupBy: "month",
        rows: [
          {
            key: "2026-01",
            label: "2026-01",
            count: 2,
            net: money("1000"),
            vat: money("210"),
            gross: money("1210"),
            original: null,
          },
        ],
        totals: { count: 2, net: money("1000"), vat: money("210"), gross: money("1210") },
      },
      {
        report: "expenses",
        period,
        groupBy: "category",
        rows: [],
        totals: { count: 0, net: money("0"), vat: money("0"), gross: money("0") },
        incomplete: 0,
      },
      {
        report: "profit",
        period,
        rows: [
          {
            month: "2026-01",
            revenue: money("1000"),
            expenses: money("400"),
            profit: money("600"),
          },
        ],
        totals: { revenue: money("1000"), expenses: money("400"), profit: money("600") },
      },
      {
        report: "cashflow",
        period,
        points: [{ month: "2026-01", in: money("1000"), out: money("400"), net: money("600") }],
        totals: { in: money("1000"), out: money("400"), net: money("600") },
      },
      {
        report: "receivables",
        period,
        asOf: IsoDate.make("2026-02-01"),
        buckets: [{ bucket: "1_30", count: 1, total: money("1210"), documents: [] }],
        total: money("1210"),
        overdue: { total: money("1210"), count: 1 },
      },
      {
        report: "vat_summary",
        period,
        output: [],
        input: [],
        totals: { output: money("210"), input: money("84"), payable: money("126") },
      },
    ];

    const pdfs = await Effect.runPromise(
      Effect.gen(function* () {
        const renderer = yield* ReportPdfRenderer;
        return yield* Effect.forEach(
          views,
          (view) => renderer.render({ workspaceId: wsId, locale: "cs", view }),
          { concurrency: 1 },
        );
      }).pipe(Effect.provide(pdfLayer)),
    );
    for (const pdf of pdfs) {
      expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
    }
  });

  test("BrandingPreview returns PDF FileDownload", async () => {
    const download = await Effect.runPromise(
      Effect.gen(function* () {
        const preview = yield* BrandingPreview;
        const file = yield* preview.render({
          workspaceId: WorkspaceId.make("01950000-0000-7000-8000-000000000003"),
          branding: {
            pdfTemplate: "modern_minimal",
            accentColor: "#0F5D42",
            footerText: "Děkujeme",
            theme: null,
            logo: null,
            stamp: null,
          },
          issuingEntity: {
            name: "Ateliér Kalný s.r.o.",
            ico: "12345678",
            dic: "CZ12345678",
            address: { street: "Křižíkova 1", city: "Praha", postalCode: "186 00", country: "CZ" },
            legalForm: "s.r.o.",
            registerEntry: null,
            email: "info@kalny.cz",
            phone: null,
            web: null,
          },
          kind: "invoice",
          language: "cs",
        });
        const chunks = yield* Stream.runCollect(file.bytes);
        return {
          filename: file.filename,
          contentType: file.contentType,
          bytes: chunks[0] ?? new Uint8Array(0),
        };
      }).pipe(Effect.provide(pdfLayer)),
    );

    expect(download.filename).toBe("preview-invoice.pdf");
    expect(download.contentType).toBe("application/pdf");
    expect(new TextDecoder().decode(download.bytes.slice(0, 5))).toBe("%PDF-");
  });
});
