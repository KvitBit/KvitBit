import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakePdfEngine } from "@kvitbit/adapters/pdf";
import {
  BrandingPreview,
  DocumentRenderer,
  InvitationTokens,
  ReportPdfRenderer,
  type ReportsModule,
  ShareLinkKeys,
} from "@kvitbit/core";
import type {
  ContactId,
  CurrencyCode,
  DocumentId,
  DocumentView,
  InvitationId,
  IsoDate,
  LineId,
  Money,
  ShareToken,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { BlobStorage, EmailSender } from "@kvitbit/domain/ports";
import { BigDecimal, ConfigProvider, Effect, Layer, Option, Redacted, Stream } from "effect";
import {
  composeRuntimeEnvLayers,
  loadBootRuntimeConfig,
  makeRuntimeEnvLayer,
} from "../../src/config-contract";
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

const money = (amount: string, currency = "CZK"): Money => ({
  amount: BigDecimal.fromStringUnsafe(amount),
  currency: currency as CurrencyCode,
});

const sampleDocumentView = (currency: "CZK" | "EUR" = "CZK"): DocumentView => ({
  id: "01950000-0000-7000-8000-000000000001" as DocumentId,
  kind: "invoice",
  number: "2026-0001",
  status: "issued",
  locked: false,
  settlement: "unpaid",
  overdue: false,
  revision: 1,
  taxDocument: true,
  contact: {
    contactId: "01950000-0000-7000-8000-000000000002" as ContactId,
    name: "Odběratel s.r.o.",
    ico: "12345678",
    dic: "CZ12345678",
    legalForm: "s.r.o.",
    address: { street: "Křižíkova 1", city: "Praha", postalCode: "186 00", country: "CZ" },
    billingEmails: ["billing@example.cz"],
  } as unknown as DocumentView["contact"],
  issuer: {
    workspaceId: "01950000-0000-7000-8000-000000000003" as WorkspaceId,
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
      currency: currency as CurrencyCode,
      accountNumber: "19-2000145399/0800",
      iban: "CZ6508000000192000145399",
      bic: "GIBACZPX",
    },
  } as unknown as DocumentView["issuer"],
  dates: {
    issuedOn: "2026-01-15" as IsoDate,
    taxableSupplyOn: "2026-01-15" as IsoDate,
    dueOn: "2026-01-29" as IsoDate,
  },
  paymentMethod: "bank_transfer",
  lines: [
    {
      id: "01950000-0000-7000-8000-000000000005" as LineId,
      item: null,
      description: "Vývoj software",
      quantity: BigDecimal.fromStringUnsafe("1"),
      unit: "ks",
      unitPrice: BigDecimal.fromStringUnsafe("1000"),
      treatment: "standard",
      ratePercent: BigDecimal.fromStringUnsafe("21"),
      amount: BigDecimal.fromStringUnsafe("1210"),
      deducts: null,
    },
  ] as unknown as DocumentView["lines"],
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
    const k1 = deriveShareLinkKey("super-secret-better-auth-key-for-tests", 1);
    const k1Again = deriveShareLinkKey("super-secret-better-auth-key-for-tests", 1);
    const k2 = deriveShareLinkKey("super-secret-better-auth-key-for-tests", 2);
    const invKey = deriveInvitationTokenKey("super-secret-better-auth-key-for-tests");

    expect(k1.length).toBe(32);
    expect(Buffer.from(k1).equals(Buffer.from(k1Again))).toBe(true);
    expect(Buffer.from(k1).equals(Buffer.from(k2))).toBe(false);
    expect(Buffer.from(k1).equals(Buffer.from(invKey))).toBe(false);

    const urls = await Effect.runPromise(
      Effect.gen(function* () {
        const keys = yield* ShareLinkKeys;
        const tok = "tok_abc123" as ShareToken;
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
    const invId = "01950000-0000-7000-8000-000000000099" as InvitationId;

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
    expect(result.t0a.length).toBeGreaterThan(20);
  });
});

describe("wiring: email & SMTP URL parsing", () => {
  test("parses smtp:// and smtps:// URLs with credentials and default ports", () => {
    const plain = parseSmtpUrl("smtp://user%40mail.cz:s3cr3t@smtp.example.cz");
    expect(plain.transport.host).toBe("smtp.example.cz");
    expect(plain.transport.port).toBe(587);
    expect(plain.transport.secure).toBe(false);
    expect(plain.transport.auth).toEqual({ user: "user@mail.cz", pass: "s3cr3t" });

    const tls = parseSmtpUrl("smtps://mail.example.cz:2465");
    expect(tls.transport.port).toBe(2465);
    expect(tls.transport.secure).toBe(true);
    expect(tls.transport.auth).toBeUndefined();
  });

  test("enforces typed-mode email contract: fails fast at boot in prod/preview without explicit mode, captures when explicitly configured", async () => {
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
    const emptyConfig: EmailWiringConfig = {
      from: "Kvitbit <noreply@kvitbit.cz>",
      resendApiKey: Option.none(),
      smtpUrl: Option.none(),
    };
    const sendWith = (env: string, configuration = emptyConfig) =>
      Effect.runPromise(
        send.pipe(Effect.provide(makeEmailSenderLayer(configuration, env)), Effect.result),
      );

    // Development zero-config logs to console; with keys and no explicit mode captures safely.
    expect(await sendWith("development")).toMatchObject({
      _tag: "Success",
      success: { provider: "console" },
    });
    const configured = {
      ...emptyConfig,
      resendApiKey: Option.some(Redacted.make("synthetic-resend-key")),
      smtpUrl: Option.some(Redacted.make("invalid-test-smtp-url")),
    };
    expect(await sendWith("development", configured)).toMatchObject({
      _tag: "Success",
      success: { provider: "capture" },
    });

    // Production without a provider fails fast at layer construction (no runtime reject-stub).
    const prodMissing = await Effect.runPromiseExit(
      Layer.build(makeEmailSenderLayer(emptyConfig, "production")).pipe(Effect.scoped),
    );
    expect(prodMissing._tag).toBe("Failure");

    // Production rejects explicit non-prod modes ('capture', 'console', 'disabled').
    for (const mode of ["capture", "console", "disabled"] as const) {
      const prodOptOut = await Effect.runPromiseExit(
        Layer.build(makeEmailSenderLayer({ ...emptyConfig, mode }, "production")).pipe(
          Effect.scoped,
        ),
      );
      expect(prodOptOut._tag).toBe("Failure");
    }

    // Preview/staging without explicit mode or provider fails fast, catching secret typos.
    for (const env of ["preview", "staging"] as const) {
      const implicitMissing = await Effect.runPromiseExit(
        Layer.build(makeEmailSenderLayer(emptyConfig, env)).pipe(Effect.scoped),
      );
      expect(implicitMissing._tag).toBe("Failure");
    }

    // Preview/staging with explicit KVITBIT_EMAIL_MODE=capture captures even when keys are present.
    expect(await sendWith("preview", { ...configured, mode: "capture" })).toMatchObject({
      _tag: "Success",
      success: { provider: "capture" },
    });
    expect(await sendWith("staging", { ...emptyConfig, mode: "console" })).toMatchObject({
      _tag: "Success",
      success: { provider: "console" },
    });
  });

  test("loadBootRuntimeConfig rejects arbitrary disable flags, trailing-dot localhost, malformed senders, and preserves production on upgrade", async () => {
    const validProdEnv: Record<string, string> = {
      NODE_ENV: "production",
      KVITBIT_ENV: "",
      DATABASE_URL: "postgres://app:pw@db.internal:5432/kvitbit",
      BETTER_AUTH_SECRET: "synthetic-auth-secret",
      APP_ORIGIN: "https://kvitbit.cz",
      EMAIL_FROM: "Kvitbit <noreply@kvitbit.cz>",
      RESEND_API_KEY: "re_synthetic_key",
      KVITBIT_BLOB_DRIVER: "gcs",
      KVITBIT_BLOB_BUCKET: "kvitbit-prod-blobs",
    };

    const loadWithLayer = <A>(workload: "server" | "worker", layer: Layer.Layer<A>) =>
      Effect.runPromise(loadBootRuntimeConfig(workload).pipe(Effect.provide(layer), Effect.result));
    const loadWith = (env: Record<string, string>, workload: "server" | "worker" = "server") =>
      loadWithLayer(workload, makeRuntimeEnvLayer(env));

    // Upgrade fixture (NODE_ENV=production, KVITBIT_ENV empty, Resend configured) stays in production with Resend (never capture).
    const upgraded = await loadWith(validProdEnv);
    expect(upgraded._tag).toBe("Success");
    if (upgraded._tag === "Success") {
      expect(upgraded.success.env).toBe("production");
      expect(upgraded.success.email.mode).toBe("resend");
      expect(upgraded.success.blob.driver).toBe("gcs");
    }

    // Valid RFC 1035 63-octet label boundary, public IPv4-mapped IPv6 origin, permitted scalar KVITBIT_DISABLE,
    // and permitted longer exact-key neighbors are accepted across both makeRuntimeEnvLayer and bare ConfigProvider.
    expect((await loadWith({ ...validProdEnv, EMAIL_FROM: `a@${"b".repeat(63)}.org` }))._tag).toBe(
      "Success",
    );
    expect(
      (await loadWith({ ...validProdEnv, APP_ORIGIN: "https://[::ffff:192.0.2.1]" }))._tag,
    ).toBe("Success");
    for (const workload of ["server", "worker"] as const) {
      for (const [label, extra] of [
        ["permitted scalar KVITBIT_DISABLE=metadata", { KVITBIT_DISABLE: "metadata" }],
        ["permitted empty KVITBIT_DISABLE", { KVITBIT_DISABLE: "" }],
        [
          "permitted KVITBIT_ALLOW_LOCAL_BLOBS_EXTRA empty",
          { KVITBIT_ALLOW_LOCAL_BLOBS_EXTRA: "" },
        ],
        [
          "permitted KVITBIT_ALLOW_LOCAL_BLOBS_EXTRA metadata",
          { KVITBIT_ALLOW_LOCAL_BLOBS_EXTRA: "metadata" },
        ],
      ] as const) {
        expect(
          (await loadWith({ ...validProdEnv, ...extra }, workload))._tag,
          `makeRuntimeEnvLayer ${workload} ${label}`,
        ).toBe("Success");
        expect(
          (
            await loadWithLayer(
              workload,
              ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ...validProdEnv, ...extra } })),
            )
          )._tag,
          `bare ConfigProvider ${workload} ${label}`,
        ).toBe("Success");
      }
    }

    for (const workload of ["server", "worker"] as const) {
      for (const [label, overrides, expectedKey] of [
        ["KVITBIT_DISABLE_BLOB", { KVITBIT_DISABLE_BLOB: "true" }, "KVITBIT_DISABLE_BLOB"],
        ["KVITBIT_DISABLE_CUSTOM", { KVITBIT_DISABLE_CUSTOM: "1" }, "KVITBIT_DISABLE_CUSTOM"],
        [
          "KVITBIT_DISABLE_HTTP_2 (Array node)",
          { KVITBIT_DISABLE_HTTP_2: "true" },
          "KVITBIT_DISABLE_HTTP_2",
        ],
        [
          "sparse Array node (1200=true + 3000 empty)",
          { KVITBIT_DISABLE_HTTP_1200: "true", KVITBIT_DISABLE_HTTP_3000: "" },
          "KVITBIT_DISABLE_HTTP_1200",
        ],
        [
          "very sparse Array node (5000=true + 10000 empty)",
          { KVITBIT_DISABLE_HTTP_5000: "true", KVITBIT_DISABLE_HTTP_10000: "" },
          "KVITBIT_DISABLE_HTTP_5000",
        ],
        [
          "empty forbidden key KVITBIT_DISABLE_OTHER",
          { KVITBIT_DISABLE_OTHER: "" },
          "KVITBIT_DISABLE_OTHER",
        ],
        [
          "empty exact KVITBIT_ALLOW_LOCAL_BLOBS alone",
          { KVITBIT_ALLOW_LOCAL_BLOBS: "" },
          "KVITBIT_ALLOW_LOCAL_BLOBS",
        ],
        [
          "empty exact KVITBIT_ALLOW_LOCAL_BLOBS alongside EXTRA",
          { KVITBIT_ALLOW_LOCAL_BLOBS: "", KVITBIT_ALLOW_LOCAL_BLOBS_EXTRA: "metadata" },
          "KVITBIT_ALLOW_LOCAL_BLOBS",
        ],
        [
          "non-empty exact KVITBIT_ALLOW_LOCAL_BLOBS alongside EXTRA",
          { KVITBIT_ALLOW_LOCAL_BLOBS: "true", KVITBIT_ALLOW_LOCAL_BLOBS_EXTRA: "metadata" },
          "KVITBIT_ALLOW_LOCAL_BLOBS",
        ],
        [
          "KVITBIT_PREVIEW_DISABLE_EMAIL",
          { KVITBIT_PREVIEW_DISABLE_EMAIL: "true" },
          "KVITBIT_PREVIEW_DISABLE_EMAIL",
        ],
        ["trailing-dot localhost", { APP_ORIGIN: "https://localhost." }, "APP_ORIGIN"],
        ["trailing-dot sub.localhost", { APP_ORIGIN: "https://sub.localhost." }, "APP_ORIGIN"],
        ["IPv4-mapped IPv6 loopback", { APP_ORIGIN: "https://[::ffff:127.0.0.1]" }, "APP_ORIGIN"],
        ["IPv4-mapped IPv6 unspecified", { APP_ORIGIN: "https://[::ffff:0.0.0.0]" }, "APP_ORIGIN"],
        ["consecutive dots in EMAIL_FROM", { EMAIL_FROM: "a..b@example.org" }, "EMAIL_FROM"],
        ["leading dot in EMAIL_FROM", { EMAIL_FROM: ".a@example.org" }, "EMAIL_FROM"],
        ["trailing dot in EMAIL_FROM", { EMAIL_FROM: "a.@example.org" }, "EMAIL_FROM"],
        [
          "64-char domain label in EMAIL_FROM",
          { EMAIL_FROM: `a@${"b".repeat(64)}.org` },
          "EMAIL_FROM",
        ],
        [
          "64-char TLD label in EMAIL_FROM",
          { EMAIL_FROM: `a@example.${"c".repeat(64)}` },
          "EMAIL_FROM",
        ],
      ] as const) {
        const res = await loadWith({ ...validProdEnv, ...overrides }, workload);
        expect(res._tag, `expected failure for ${workload} ${label}`).toBe("Failure");
        if (res._tag === "Failure") {
          expect(
            String(res.failure),
            `expected exact marker Invalid runtime config (${expectedKey}): for ${label}`,
          ).toContain(`Invalid runtime config (${expectedKey}):`);
        }
      }

      // Bare ConfigProvider.fromEnv also rejects empty exact KVITBIT_ALLOW_LOCAL_BLOBS alone.
      const bareEmptyExact = await loadWithLayer(
        workload,
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { ...validProdEnv, KVITBIT_ALLOW_LOCAL_BLOBS: "" } }),
        ),
      );
      expect(bareEmptyExact._tag).toBe("Failure");
      if (bareEmptyExact._tag === "Failure") {
        expect(String(bareEmptyExact.failure)).toContain(
          "Invalid runtime config (KVITBIT_ALLOW_LOCAL_BLOBS):",
        );
      }

      // Composed primary + fallback sources preserve key names from both sources and report the exact offending key.
      for (const [label, primaryExtra, fallbackEnv, expectedKey] of [
        [
          "fallback KVITBIT_DISABLE_CUSTOM",
          {},
          { KVITBIT_DISABLE_CUSTOM: "true" },
          "KVITBIT_DISABLE_CUSTOM",
        ],
        [
          "scalar primary KVITBIT_DISABLE=metadata + fallback KVITBIT_DISABLE_CUSTOM=true",
          { KVITBIT_DISABLE: "metadata" },
          { KVITBIT_DISABLE_CUSTOM: "true" },
          "KVITBIT_DISABLE_CUSTOM",
        ],
        [
          "empty primary KVITBIT_DISABLE_OTHER + fallback KVITBIT_DISABLE_CUSTOM=true",
          { KVITBIT_DISABLE_OTHER: "" },
          { KVITBIT_DISABLE_CUSTOM: "true" },
          "KVITBIT_DISABLE_CUSTOM",
        ],
        [
          "empty primary KVITBIT_PREVIEW_DISABLE_OTHER + fallback KVITBIT_PREVIEW_DISABLE_CUSTOM=true",
          { KVITBIT_PREVIEW_DISABLE_OTHER: "" },
          { KVITBIT_PREVIEW_DISABLE_CUSTOM: "true" },
          "KVITBIT_PREVIEW_DISABLE_CUSTOM",
        ],
        [
          "empty primary KVITBIT_ALLOW_LOCAL_BLOBS + EXTRA + fallback KVITBIT_ALLOW_LOCAL_BLOBS=true",
          { KVITBIT_ALLOW_LOCAL_BLOBS: "", KVITBIT_ALLOW_LOCAL_BLOBS_EXTRA: "metadata" },
          { KVITBIT_ALLOW_LOCAL_BLOBS: "true" },
          "KVITBIT_ALLOW_LOCAL_BLOBS",
        ],
        [
          "fallback KVITBIT_DISABLE_HTTP_2",
          {},
          { KVITBIT_DISABLE_HTTP_2: "true" },
          "KVITBIT_DISABLE_HTTP_2",
        ],
        [
          "fallback KVITBIT_PREVIEW_DISABLE_CUSTOM",
          {},
          { KVITBIT_PREVIEW_DISABLE_CUSTOM: "true" },
          "KVITBIT_PREVIEW_DISABLE_CUSTOM",
        ],
      ] as const) {
        const res = await loadWithLayer(
          workload,
          composeRuntimeEnvLayers({ ...validProdEnv, ...primaryExtra }, fallbackEnv),
        );
        expect(res._tag, `expected failure for ${workload} ${label}`).toBe("Failure");
        if (res._tag === "Failure") {
          expect(
            String(res.failure),
            `expected exact marker Invalid runtime config (${expectedKey}): for ${label}`,
          ).toContain(`Invalid runtime config (${expectedKey}):`);
        }
      }
    }
  });
});

describe("wiring: blob storage", () => {
  test("local driver stores, reads, and deletes blobs on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kvitbit-blob-test-"));
    try {
      const layer = makeBlobStorageLayer({
        driver: "local",
        localDir: dir,
        gcsBucket: Option.none(),
        gcsProject: Option.none(),
      });
      const bytes = new TextEncoder().encode("hello blob");
      const key = "exports/ws-1/test.txt" as Parameters<BlobStorage["Service"]["put"]>[0];

      const roundtrip = await Effect.runPromise(
        Effect.gen(function* () {
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
        }).pipe(Effect.provide(layer)),
      );

      expect(roundtrip).toEqual({ text: "hello blob", deleted: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("gcs driver fails with ConfigError when KVITBIT_BLOB_BUCKET is absent", async () => {
    const layer = makeBlobStorageLayer({
      driver: "gcs",
      localDir: "/tmp/unused",
      gcsBucket: Option.none(),
      gcsProject: Option.none(),
    });
    const exit = await Effect.runPromiseExit(Layer.build(layer).pipe(Effect.scoped));
    expect(exit._tag).toBe("Failure");
  });
});

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
    const period = { from: "2026-01-01" as IsoDate, to: "2026-12-31" as IsoDate };
    const wsId = "01950000-0000-7000-8000-000000000003" as WorkspaceId;
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
        asOf: "2026-02-01" as IsoDate,
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

    for (const view of views) {
      const pdf = await Effect.runPromise(
        Effect.gen(function* () {
          const renderer = yield* ReportPdfRenderer;
          return yield* renderer.render({ workspaceId: wsId, locale: "cs", view });
        }).pipe(Effect.provide(pdfLayer)),
      );
      expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
    }
  });

  test("BrandingPreview returns PDF FileDownload", async () => {
    const download = await Effect.runPromise(
      Effect.gen(function* () {
        const preview = yield* BrandingPreview;
        const file = yield* preview.render({
          workspaceId: "01950000-0000-7000-8000-000000000003" as WorkspaceId,
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
