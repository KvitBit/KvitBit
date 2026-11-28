import { describe, expect, test } from "bun:test";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { PgliteClient } from "@effect/sql-pglite";
import { BotProtection } from "@kvitbit/adapters/altcha";
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
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import * as SqlClient from "effect/sql/SqlClient";
import * as Workflow from "effect/workflow/Workflow";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { BotProtectionLive } from "../../src/app";
import {
  composeRuntimeEnvLayers,
  loadBootRuntimeConfig,
  loadBotProtectionConfig,
  loadKvitbitEnv,
  makeRuntimeEnvLayer,
  resolveEmailConfig,
} from "../../src/config-contract";
import { HttpConfig, HttpConfigLive } from "../../src/http/config";
import {
  deriveInvitationTokenKey,
  deriveShareLinkKey,
  documentViewToRenderModel,
  EmailSenderLive,
  type EmailWiringConfig,
  EmailWiringConfigSchema,
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
import { NoQueriesSqlLive } from "./no-queries-sql";

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
    const prodMissing = await Layer.build(makeEmailSenderLayer(emptyConfig, "production")).pipe(
      Effect.scoped,
      Effect.runPromiseExit,
    );
    expect(prodMissing._tag).toBe("Failure");

    // Production rejects explicit non-prod modes ('capture', 'console', 'disabled').
    for (const mode of ["capture", "console", "disabled"] as const) {
      const prodOptOut = await Layer.build(
        makeEmailSenderLayer({ ...emptyConfig, mode }, "production"),
      ).pipe(Effect.scoped, Effect.runPromiseExit);
      expect(prodOptOut._tag).toBe("Failure");
    }

    // Preview/staging without explicit mode or provider fails fast, catching secret typos.
    for (const env of ["preview", "staging"] as const) {
      const implicitMissing = await Layer.build(makeEmailSenderLayer(emptyConfig, env)).pipe(
        Effect.scoped,
        Effect.runPromiseExit,
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
    const validProdEnv = {
      NODE_ENV: "production",
      KVITBIT_ENV: "",
      DATABASE_URL: "postgres://app:pw@db.internal:5432/kvitbit",
      BETTER_AUTH_SECRET: "synthetic-auth-secret",
      ALTCHA_HMAC_KEY: "synthetic-altcha-hmac-key",
      APP_ORIGIN: "https://kvitbit.cz",
      EMAIL_FROM: "Kvitbit <noreply@kvitbit.cz>",
      RESEND_API_KEY: "re_synthetic_key",
      KVITBIT_BLOB_DRIVER: "gcs",
      KVITBIT_BLOB_BUCKET: "kvitbit-prod-blobs",
    } satisfies Record<string, string>;

    const loadWithLayer = <A>(workload: "server" | "worker", layer: Layer.Layer<A>) =>
      Effect.runPromise(loadBootRuntimeConfig(workload).pipe(Effect.provide(layer), Effect.result));
    const loadWith = (env: Record<string, string>, workload: "server" | "worker" = "server") =>
      loadWithLayer(workload, makeRuntimeEnvLayer(env));

    // Upgrade fixture (NODE_ENV=production, KVITBIT_ENV empty, Resend configured) stays in production with Resend (never capture).
    const upgraded = await loadWith(validProdEnv);
    expect(upgraded._tag).toBe("Success");
    if (upgraded._tag !== "Success") throw new Error("Expected the asserted result");
    expect(upgraded.success.env).toBe("production");
    expect(upgraded.success.email.mode).toBe("resend");
    expect(upgraded.success.blob.driver).toBe("gcs");
    expect(upgraded.success.botProtection).toEqual({
      mode: "altcha",
      hmacKey: "synthetic-altcha-hmac-key",
    });

    // Worker does not serve HTTP/bot-protection routes and boots in production without ALTCHA_HMAC_KEY,
    // while server fails fast when ALTCHA_HMAC_KEY is missing or whitespace-only.
    const { ALTCHA_HMAC_KEY: _omittedAltcha, ...prodWithoutAltcha } = validProdEnv;
    const workerNoAltcha = await loadWith(prodWithoutAltcha, "worker");
    expect(workerNoAltcha._tag).toBe("Success");
    if (workerNoAltcha._tag !== "Success") throw new Error("Expected the asserted result");
    expect(workerNoAltcha.success.botProtection).toBeUndefined();
    for (const [label, overrides] of [
      ["missing ALTCHA_HMAC_KEY", prodWithoutAltcha],
      ["whitespace-only ALTCHA_HMAC_KEY", { ...validProdEnv, ALTCHA_HMAC_KEY: "   " }],
    ] as const) {
      const serverMissingAltcha = await loadWith(overrides, "server");
      expect(serverMissingAltcha._tag, label).toBe("Failure");
      if (serverMissingAltcha._tag !== "Failure") throw new Error("Expected the asserted result");
      expect(String(serverMissingAltcha.failure)).toContain(
        "Invalid runtime config (ALTCHA_HMAC_KEY):",
      );
    }
    for (const workload of ["server", "worker"] as const) {
      for (const badMode of ["none", "disabled", "bogus"] as const) {
        const res = await loadWith(
          { ...validProdEnv, KVITBIT_BOT_PROTECTION_MODE: badMode },
          workload,
        );
        expect(res._tag, `${workload} mode=${badMode}`).toBe("Failure");
        if (res._tag !== "Failure") throw new Error("Expected the asserted result");
        expect(String(res.failure)).toContain(
          "Invalid runtime config (KVITBIT_BOT_PROTECTION_MODE):",
        );
      }
    }

    // Valid RFC 1035 63-octet label boundary, public IPv4-mapped IPv6 origin, permitted scalar KVITBIT_DISABLE,
    // and permitted longer exact-key neighbors are accepted across both makeRuntimeEnvLayer and bare ConfigProvider.
    expect(
      (await loadWith({ ...validProdEnv, EMAIL_FROM: `a@${Str.repeat(63)("b")}.org` }))._tag,
    ).toBe("Success");
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
          { EMAIL_FROM: `a@${Str.repeat(64)("b")}.org` },
          "EMAIL_FROM",
        ],
        [
          "64-char TLD label in EMAIL_FROM",
          { EMAIL_FROM: `a@example.${Str.repeat(64)("c")}` },
          "EMAIL_FROM",
        ],
      ] as const) {
        const res = await loadWith({ ...validProdEnv, ...overrides }, workload);
        expect(res._tag, `expected failure for ${workload} ${label}`).toBe("Failure");
        if (res._tag !== "Failure") throw new Error("Expected the asserted result");
        expect(
          String(res.failure),
          `expected exact marker Invalid runtime config (${expectedKey}): for ${label}`,
        ).toContain(`Invalid runtime config (${expectedKey}):`);
      }

      // Bare ConfigProvider.fromEnv also rejects empty exact KVITBIT_ALLOW_LOCAL_BLOBS alone.
      const bareEmptyExact = await loadWithLayer(
        workload,
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { ...validProdEnv, KVITBIT_ALLOW_LOCAL_BLOBS: "" } }),
        ),
      );
      expect(bareEmptyExact._tag).toBe("Failure");
      if (bareEmptyExact._tag !== "Failure") throw new Error("Expected the asserted result");
      expect(String(bareEmptyExact.failure)).toContain(
        "Invalid runtime config (KVITBIT_ALLOW_LOCAL_BLOBS):",
      );

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
        if (res._tag !== "Failure") throw new Error("Expected the asserted result");
        expect(
          String(res.failure),
          `expected exact marker Invalid runtime config (${expectedKey}): for ${label}`,
        ).toContain(`Invalid runtime config (${expectedKey}):`);
      }
    }
  });

  test("loadBootRuntimeConfig and EmailSenderLive resolve identical effective env and email mode under composeRuntimeEnvLayers", async () => {
    const baseWithoutEnv = {
      DATABASE_URL: "postgres://app:pw@db.internal:5432/kvitbit",
      BETTER_AUTH_SECRET: "synthetic-auth-secret",
      ALTCHA_HMAC_KEY: "synthetic-altcha-hmac-key",
      APP_ORIGIN: "https://kvitbit.cz",
      EMAIL_FROM: "Kvitbit <noreply@kvitbit.cz>",
      RESEND_API_KEY: "re_synthetic_key",
      KVITBIT_BLOB_DRIVER: "gcs",
      KVITBIT_BLOB_BUCKET: "kvitbit-prod-blobs",
    } satisfies Record<string, string>;

    // 1. Whitespace-only primary KVITBIT_ENV=" " with fallback "production":
    // both boot and EmailSenderLive see the same primary value (" " -> trimmed undefined -> development/capture),
    // never claiming production/resend at boot while selecting capture at runtime.
    const spaceLayer = composeRuntimeEnvLayers(
      { ...baseWithoutEnv, KVITBIT_ENV: " " },
      { KVITBIT_ENV: "production" },
    );
    const spaceBoot = await Effect.runPromise(
      loadBootRuntimeConfig("server").pipe(Effect.provide(spaceLayer)),
    );
    const spaceLiveSend = await Effect.runPromise(
      Effect.flatMap(EmailSender, (sender) =>
        sender.send(
          {
            to: ["test@example.cz"],
            replyTo: "info@kvitbit.cz",
            subject: "Parity",
            html: "<p>Parity</p>",
            text: "Parity",
            attachments: [],
            tags: { template: "parity" },
          },
          { idempotencyKey: "parity-space-1" },
        ),
      ).pipe(Effect.provide(EmailSenderLive.pipe(Layer.provideMerge(spaceLayer)))),
    );
    expect(spaceBoot.env).toBe("development");
    expect(spaceBoot.email.mode).toBe("capture");
    expect(spaceLiveSend.provider).toBe(spaceBoot.email.mode);

    // 2. Empty primary KVITBIT_ENV="" falls through to fallback "production" in BOTH boot and live wiring.
    const emptyLayer = composeRuntimeEnvLayers(
      { ...baseWithoutEnv, KVITBIT_ENV: "" },
      { KVITBIT_ENV: "production" },
    );
    const emptyBoot = await Effect.runPromise(
      loadBootRuntimeConfig("server").pipe(Effect.provide(emptyLayer)),
    );
    const emptyLiveResolved = await Effect.runPromise(
      Effect.gen(function* () {
        const env = yield* loadKvitbitEnv;
        const cfg = yield* EmailWiringConfigSchema;
        const resolved = resolveEmailConfig(env, {
          emailMode: cfg.mode,
          emailFrom: cfg.from,
          resendApiKey: Option.getOrUndefined(Option.map(cfg.resendApiKey, Redacted.value)),
          smtpUrl: Option.getOrUndefined(Option.map(cfg.smtpUrl, Redacted.value)),
        });
        return { env, resolved };
      }).pipe(Effect.provide(emptyLayer)),
    );
    expect(emptyBoot.env).toBe("production");
    expect(emptyBoot.email.mode).toBe("resend");
    expect(emptyLiveResolved.env).toBe(emptyBoot.env);
    expect(emptyLiveResolved.resolved.ok).toBe(true);
    if (!emptyLiveResolved.resolved.ok) throw new Error("Expected the asserted result");
    expect(emptyLiveResolved.resolved.value.mode).toBe(emptyBoot.email.mode);

    // 3. Whitespace-only primary KVITBIT_ENV=" " + NODE_ENV="production" resolves production/resend in both.
    const spaceWithProdNodeLayer = composeRuntimeEnvLayers(
      { ...baseWithoutEnv, KVITBIT_ENV: " ", NODE_ENV: "production" },
      { KVITBIT_ENV: "staging" },
    );
    const spaceWithProdBoot = await Effect.runPromise(
      loadBootRuntimeConfig("server").pipe(Effect.provide(spaceWithProdNodeLayer)),
    );
    const spaceWithProdLiveEnv = await Effect.runPromise(
      loadKvitbitEnv.pipe(Effect.provide(spaceWithProdNodeLayer)),
    );
    expect(spaceWithProdBoot.env).toBe("production");
    expect(spaceWithProdBoot.email.mode).toBe("resend");
    expect(spaceWithProdLiveEnv).toBe(spaceWithProdBoot.env);
  });

  test("BotProtectionLive and HttpConfigLive enforce fail-fast typed-mode bot protection and stay in parity", async () => {
    const baseHttpEnv = {
      DATABASE_URL: "postgres://app:pw@db.internal:5432/kvitbit",
      BETTER_AUTH_SECRET: "synthetic-auth-secret",
      APP_ORIGIN: "https://kvitbit.cz",
    };
    const loadHttpBotProtection = (env: Record<string, string>) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const cfg = yield* HttpConfig;
          return cfg.botProtection;
        }).pipe(
          Effect.provide(HttpConfigLive.pipe(Layer.provideMerge(makeRuntimeEnvLayer(env)))),
          Effect.result,
        ),
      );
    const loadLiveBotMode = (env: Record<string, string>) =>
      Effect.runPromise(
        loadBotProtectionConfig.pipe(Effect.provide(makeRuntimeEnvLayer(env)), Effect.result),
      );
    const buildNoopCheck = (env: Record<string, string>) =>
      Effect.runPromise(
        Effect.flatMap(BotProtection, (bp) => bp.issue("sign_up")).pipe(
          Effect.provide(
            BotProtectionLive.pipe(
              Layer.provide(NoQueriesSqlLive),
              Layer.provideMerge(makeRuntimeEnvLayer(env)),
            ),
          ),
          Effect.result,
        ),
      );

    // Production without ALTCHA_HMAC_KEY or with whitespace-only key or mode=none fails in BOTH HttpConfigLive and BotProtectionLive.
    for (const badEnv of [
      { ...baseHttpEnv, KVITBIT_ENV: "production" },
      { ...baseHttpEnv, KVITBIT_ENV: "production", ALTCHA_HMAC_KEY: "   " },
      { ...baseHttpEnv, KVITBIT_ENV: "production", KVITBIT_BOT_PROTECTION_MODE: "none" },
      { ...baseHttpEnv, KVITBIT_ENV: "staging" },
      { ...baseHttpEnv, KVITBIT_ENV: "preview", ALTCHA_HMAC_KEY: "  " },
    ]) {
      expect((await loadHttpBotProtection(badEnv))._tag).toBe("Failure");
      expect((await loadLiveBotMode(badEnv))._tag).toBe("Failure");
      expect((await buildNoopCheck(badEnv))._tag).toBe("Failure");
    }

    // Production with non-empty ALTCHA_HMAC_KEY resolves "altcha" in HttpConfigLive and loadBotProtectionConfig.
    const prodOk = {
      ...baseHttpEnv,
      KVITBIT_ENV: "production",
      ALTCHA_HMAC_KEY: "  synthetic-key  ",
    };
    expect(await loadHttpBotProtection(prodOk)).toMatchObject({
      _tag: "Success",
      success: "altcha",
    });
    expect(await loadLiveBotMode(prodOk)).toMatchObject({
      _tag: "Success",
      success: { mode: "altcha", hmacKey: "synthetic-key" },
    });

    // Staging/preview with explicit KVITBIT_BOT_PROTECTION_MODE=none resolves NoopBotProtection & "none".
    for (const envName of ["staging", "preview"] as const) {
      const explicitNone = {
        ...baseHttpEnv,
        KVITBIT_ENV: envName,
        KVITBIT_BOT_PROTECTION_MODE: "none",
      };
      expect(await loadHttpBotProtection(explicitNone)).toMatchObject({
        _tag: "Success",
        success: "none",
      });
      const noopChallenge = await buildNoopCheck(explicitNone);
      expect(noopChallenge._tag).toBe("Success");
      if (noopChallenge._tag !== "Success") throw new Error("Expected the asserted result");
      expect(noopChallenge.success.parameters.algorithm).toBe("NONE");
    }

    // Development with whitespace-only ALTCHA_HMAC_KEY resolves "none" in BOTH layers (never passing whitespace to ALTCHA).
    const devWhitespace = {
      ...baseHttpEnv,
      KVITBIT_ENV: "development",
      ALTCHA_HMAC_KEY: "   ",
    };
    expect(await loadHttpBotProtection(devWhitespace)).toMatchObject({
      _tag: "Success",
      success: "none",
    });
    const devNoop = await buildNoopCheck(devWhitespace);
    expect(devNoop._tag).toBe("Success");
    if (devNoop._tag !== "Success") throw new Error("Expected the asserted result");
    expect(devNoop.success.parameters.algorithm).toBe("NONE");
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
