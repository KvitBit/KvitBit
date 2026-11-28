/**
 * Demo API handlers for the `public` page group (see src/demo/router.ts).
 * Returns ENCODED wire forms matching @kvitbit/api-contract schemas.
 */

import {
  ALL_SCOPES,
  ConfigView,
  ConsentDecision,
  ConsentResult,
  ConsentView,
  READ_SCOPES,
  ReleaseInfo,
} from "@kvitbit/api-contract";
import {
  InvitationPeek,
  RegistryResult,
  SharedDocumentView,
  WorkspaceSlug,
  WorkspaceView,
} from "@kvitbit/domain";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { type DemoRoute, isStatus, status } from "./router";
import { DEMO_USER, DEMO_WORKSPACE, DEMO_WORKSPACES, demoId } from "./shell";

const wire = <S extends Schema.ConstraintCodec<unknown>>(schema: S, value: S["Encoded"]) => {
  const encoded = Schema.decodeResult(schema)(value).pipe(
    Result.flatMap(Schema.encodeResult(schema)),
  );
  if (Result.isFailure(encoded)) return status(500, { message: "Invalid demo response" });
  return encoded.success;
};

const DEMO_CONFIG = wire(ConfigView, {
  version: "0.1.0-demo",
  botProtection: "altcha",
  uploads: {
    attachment: {
      maxBytes: 20 * 1024 * 1024,
      types: ["application/pdf", "image/jpeg", "image/png", "image/heic"],
    },
    brandingImage: {
      maxBytes: 5 * 1024 * 1024,
      types: ["image/png", "image/jpeg", "image/svg+xml"],
    },
    themeJson: { maxBytes: 64 * 1024 },
  },
  features: { signUp: true, mcp: true, apiKeys: true },
});

const DEMO_RELEASE = wire(ReleaseInfo, {
  version: "1.0.0",
  versionCode: 10000,
  releasedAt: "2026-11-20T10:00:00Z",
  apkUrl: "/api/mobile/releases/1.0.0/apk",
  apkSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  sizeBytes: 28_450_000,
  signingCertSha256: Str.repeat(4)("ab12cd34ef567890"),
  minAndroidSdk: 26,
  obtainiumUrl: "obtainium://add/https://kvitbit.cz/api/mobile/releases/latest",
});

const shareCodec = Schema.toCodecJson(SharedDocumentView);

const buildShareFixture = (token: string): unknown | null => {
  if (token === "demo-revoked" || token === "expired") return null;

  const isEur = token === "demo-unpaid-eur";
  const isPaid = token === "demo-paid";
  const isOverdue = token === "demo-overdue";
  const isProforma = token === "demo-proforma";
  const isCreditNote = token === "demo-credit-note";
  const currency = isEur ? "EUR" : "CZK";

  const raw = {
    kind: isProforma ? "proforma" : isCreditNote ? "credit_note" : "invoice",
    number: isProforma
      ? "ZF-2026-0018"
      : isCreditNote
        ? "OD-2026-0003"
        : isEur
          ? "2026-0043"
          : "2026-0042",
    status: "issued",
    settlement: isPaid ? "paid" : isCreditNote ? "credited" : "unpaid",
    taxDocument: !isProforma,
    dates: {
      issuedOn: isOverdue ? "2026-09-01" : "2026-11-10",
      taxableSupplyOn: isProforma ? null : isOverdue ? "2026-09-01" : "2026-11-10",
      dueOn: isOverdue ? "2026-09-15" : "2026-11-24",
    },
    issuer: {
      workspaceId: DEMO_WORKSPACE.id,
      name: "Novák Design s.r.o.",
      ico: "01234567",
      dic: "CZ01234567",
      address: {
        street: "Korunní 810/104",
        city: "Praha 10",
        postalCode: "101 00",
        country: "CZ",
      },
      registerEntry: "Spisová značka C 214598 vedená u Městského soudu v Praze",
      email: "fakturace@novakdesign.cz",
      phone: "+420 602 123 456",
      web: "https://novakdesign.cz",
      regime: "vat_payer",
      bankAccount: {
        id: demoId(201),
        name: isEur ? "Fio EUR" : "Fio CZK",
        currency,
        accountNumber: isEur ? null : "2000145399/2010",
        iban: "CZ9320100000002000145399",
        bic: "FIOBCZPPXXX",
      },
    },
    branding: {
      pdfTemplate: "classic",
      accentColor: "#0F5D42",
      footerText: "Děkujeme za spolupráci.",
      theme: token === "demo-branded" ? { _tag: "Preset", id: "forest" } : null,
      logo: null,
      stamp: null,
    },
    contact: {
      contactId: demoId(301),
      name: "Ateliér Stromovka a.s.",
      ico: "27082440",
      dic: "CZ27082440",
      legalForm: "a.s.",
      address: {
        street: "Veletržní 1623/24",
        city: "Praha 7",
        postalCode: "170 00",
        country: "CZ",
      },
      billingEmails: ["uctarna@stromovka.cz"],
    },
    lines: [
      {
        id: demoId(401),
        description: isCreditNote
          ? "Dobropis: návrh vizuální identity"
          : "Návrh vizuální identity a typografie",
        quantity: isCreditNote ? "-1" : "1",
        unit: "ks",
        unitPrice: isEur ? "1500.00" : "40000.00",
        ratePercent: isProforma ? "0" : "21",
        amount: isCreditNote ? (isEur ? "-1500.00" : "-40000.00") : isEur ? "1500.00" : "40000.00",
        treatment: isProforma ? "outside_scope" : "standard",
      },
    ],
    totals: {
      buckets: [
        {
          treatment: isProforma ? "outside_scope" : "standard",
          ratePercent: isProforma ? "0" : "21",
          base: isCreditNote ? "-40000.00" : isEur ? "1500.00" : "40000.00",
          vat: isProforma ? "0.00" : isCreditNote ? "-8400.00" : isEur ? "315.00" : "8400.00",
          gross: isCreditNote
            ? "-48400.00"
            : isEur
              ? "1815.00"
              : isProforma
                ? "40000.00"
                : "48400.00",
          vatCzk: isEur ? "7938.00" : null,
        },
      ],
      net: {
        amount: isCreditNote ? "-40000.00" : isEur ? "1500.00" : "40000.00",
        currency,
      },
      vat: {
        amount: isProforma ? "0.00" : isCreditNote ? "-8400.00" : isEur ? "315.00" : "8400.00",
        currency,
      },
      roundingAdjustment: { amount: "0.00", currency },
      gross: {
        amount: isCreditNote
          ? "-48400.00"
          : isEur
            ? "1815.00"
            : isProforma
              ? "40000.00"
              : "48400.00",
        currency,
      },
      vatCzk: isEur ? { amount: "7938.00", currency: "CZK" } : null,
    },
    statutoryNotes: isProforma
      ? [{ code: "proforma.not_tax_document", text: "Zálohová faktura není daňovým dokladem." }]
      : [],
    paymentQr:
      isPaid || isCreditNote
        ? null
        : isEur
          ? {
              format: "epc",
              payload: Arr.join(
                [
                  "BCD",
                  "002",
                  "1",
                  "SCT",
                  "FIOBCZPPXXX",
                  "Novak Design s.r.o.",
                  "CZ9320100000002000145399",
                  "EUR1815.00",
                  "",
                  "20260043",
                ],
                "\n",
              ),
            }
          : {
              format: "spayd",
              payload:
                "SPD*1.0*ACC:CZ9320100000002000145399*AM:48400.00*CC:CZK*X-VS:20260042*MSG:Faktura 2026-0042",
            },
    language: isEur ? "en" : "cs",
    amountDue: {
      amount:
        isPaid || isCreditNote ? "0.00" : isEur ? "1815.00" : isProforma ? "40000.00" : "48400.00",
      currency,
    },
    correctsNumber: isCreditNote ? "2026-0042" : null,
    note: "Uhraďte prosím na účet s uvedením variabilního symbolu.",
    updatedAt: null,
    pdfUrl: `/api/v1/share/${encodeURIComponent(token)}/pdf`,
    viewerIsIssuer: token === "demo-issuer",
  };

  return wire(shareCodec, raw);
};

const buildInvitationFixture = (token: string): unknown | null => {
  if (token === "not-found") return null;
  const invStatus =
    token === "demo-expired"
      ? "expired"
      : token === "demo-revoked"
        ? "revoked"
        : token === "demo-accepted"
          ? "accepted"
          : "pending";
  return wire(InvitationPeek, {
    workspaceName: DEMO_WORKSPACE.name,
    inviterName: "Petr Svoboda",
    role: "member",
    email: DEMO_USER.email,
    status: invStatus,
    expiresAt: "2026-12-01T12:00:00Z",
  });
};

const buildConsentFixture = (consentId: string): unknown | null => {
  if (consentId === "expired") return null;
  const workspaces =
    consentId === "demo-empty"
      ? []
      : consentId === "demo-accountant"
        ? [
            {
              id: DEMO_WORKSPACE.id,
              name: DEMO_WORKSPACE.name,
              role: "accountant" as const,
              maxAccess: "read" as const,
              grantableScopes: [...READ_SCOPES],
              offerableScopes: [...READ_SCOPES],
            },
          ]
        : Arr.map(DEMO_WORKSPACES, (w) => ({
            id: w.id,
            name: w.name,
            role: w.role,
            maxAccess: "read_write" as const,
            grantableScopes: [...ALL_SCOPES],
            offerableScopes: [...ALL_SCOPES],
          }));

  return wire(ConsentView, {
    client: {
      id: "claude-desktop",
      name: "Claude Desktop",
      redirectHost: "claude.ai",
      logoUri: null,
    },
    requestedAccess: "read_write",
    requestedScopes: [...ALL_SCOPES],
    workspaces,
  });
};

const DEMO_COMPANIES = new Map<string, typeof RegistryResult.Encoded>([
  [
    "01234567",
    {
      ico: "01234567",
      name: "Novák Design s.r.o.",
      address: {
        street: "Korunní 810/104",
        city: "Praha 10",
        postalCode: "101 00",
        country: "CZ",
      },
      dic: "CZ01234567",
      legalForm: "Společnost s ručením omezeným",
      registerEntry: "Spisová značka C 214598 vedená u Městského soudu v Praze",
      terminatedOn: null,
    },
  ],
  [
    "27082440",
    {
      ico: "27082440",
      name: "Alza.cz a.s.",
      address: {
        street: "Jankovcova 1522/53",
        city: "Praha 7",
        postalCode: "170 00",
        country: "CZ",
      },
      dic: "CZ27082440",
      legalForm: "Akciová společnost",
      registerEntry: "Spisová značka B 8573 vedená u Městského soudu v Praze",
      terminatedOn: null,
    },
  ],
]);

const decodeSignUp = Schema.decodeUnknownOption(
  Schema.Struct({
    email: Schema.optionalKey(Schema.String),
    invitationToken: Schema.optionalKey(Schema.String),
  }),
);
const decodeConsentDecision = Schema.decodeUnknownOption(ConsentDecision);
const decodeWorkspace = Schema.decodeUnknownOption(
  Schema.Struct({
    slug: Schema.optionalKey(WorkspaceSlug),
    name: Schema.optionalKey(Schema.String),
  }),
);

export const routes: ReadonlyArray<DemoRoute> = [
  {
    method: "GET",
    path: "/api/v1/config",
    respond: () => DEMO_CONFIG,
  },
  {
    method: "GET",
    path: "/api/v1/bot-protection/challenges/:scope",
    respond: ({ params }) => ({
      parameters: {
        algorithm: "SHA-256",
        nonce: `demo-${params["scope"] ?? "sign_up"}-nonce`,
        keyPrefix: "0",
        cost: 1,
        keyLength: 32,
      },
      signature: "demo-signature",
    }),
  },
  // Better Auth demo routes
  {
    method: "POST",
    path: "/api/auth/sign-up/email",
    respond: ({ body }) => {
      const input = Option.getOrUndefined(decodeSignUp(body));
      const invited = input?.invitationToken !== undefined;
      return {
        token: invited ? "demo-invited-session" : null,
        user: {
          ...DEMO_USER,
          email: input?.email ?? DEMO_USER.email,
          emailVerified: invited,
        },
      };
    },
  },
  {
    method: "POST",
    path: "/api/auth/sign-in/email",
    respond: () => ({ user: DEMO_USER }),
  },
  {
    method: "POST",
    path: "/api/auth/sign-in/magic-link",
    respond: () => ({ status: true }),
  },
  {
    method: "POST",
    path: "/api/auth/send-verification-email",
    respond: () => ({ status: true }),
  },
  {
    method: "GET",
    path: "/api/auth/verify-email",
    respond: ({ query }) =>
      query.get("token") === "expired"
        ? status(400, { _tag: "Invalid", issues: [] })
        : { status: true },
  },
  {
    method: "GET",
    path: "/api/auth/magic-link/verify",
    respond: ({ query }) =>
      query.get("token") === "expired"
        ? status(400, { _tag: "Invalid", issues: [] })
        : { user: DEMO_USER },
  },
  {
    method: "POST",
    path: "/api/auth/request-password-reset",
    respond: () => ({ status: true }),
  },
  {
    method: "POST",
    path: "/api/auth/reset-password",
    respond: () => ({ status: true }),
  },
  {
    method: "GET",
    path: "/api/auth/passkey/generate-authenticate-options",
    respond: () => ({
      challenge: "ZGVtby13ZWJhdXRobi1jaGFsbGVuZ2U",
      rpId: "localhost",
    }),
  },
  {
    method: "POST",
    path: "/api/auth/passkey/verify-authentication",
    respond: () => ({ user: DEMO_USER }),
  },
  // Android releases
  {
    method: "GET",
    path: "/api/mobile/releases/latest",
    respond: () => DEMO_RELEASE,
  },
  // Public share links
  {
    method: "GET",
    path: "/api/v1/share/:token",
    respond: ({ params }) => {
      const found = buildShareFixture(params["token"] ?? "demo-unpaid-czk");
      if (found === null) {
        return status(404, { _tag: "NotFound", entity: "ShareLink", id: params["token"] ?? "" });
      }
      return found;
    },
  },
  // Invitations
  {
    method: "GET",
    path: "/api/v1/invitations/:token",
    respond: ({ params }) => {
      const found = buildInvitationFixture(params["token"] ?? "demo-pending");
      if (found === null) {
        return status(404, { _tag: "NotFound", entity: "Invitation", id: params["token"] ?? "" });
      }
      return found;
    },
  },
  {
    method: "POST",
    path: "/api/v1/invitations/:token/accept",
    respond: () => DEMO_WORKSPACE,
  },
  // MCP OAuth 2.1 consent
  {
    method: "GET",
    path: "/api/v1/oauth/consents/:consentId",
    respond: ({ params }) => {
      const found = buildConsentFixture(params["consentId"] ?? "demo-consent");
      if (found === null) {
        return status(404, { _tag: "NotFound", entity: "McpGrant", id: params["consentId"] ?? "" });
      }
      return found;
    },
  },
  {
    method: "POST",
    path: "/api/v1/oauth/consents/:consentId",
    respond: ({ body }) => {
      const decision = Option.getOrUndefined(decodeConsentDecision(body));
      return wire(ConsentResult, {
        redirectTo:
          decision?._tag === "Deny"
            ? "https://claude.ai/oauth/callback?error=access_denied"
            : "https://claude.ai/oauth/callback?code=demo-auth-code",
      });
    },
  },
  // ARES registry lookup
  {
    method: "GET",
    path: "/api/v1/registry/companies/:ico",
    respond: ({ params }) => {
      const ico = params["ico"] ?? "";
      if (ico === "99999999") {
        return status(503, { _tag: "Unavailable", dependency: "company_registry" });
      }
      const hit = DEMO_COMPANIES.get(ico);
      if (hit === undefined) {
        return status(404, { _tag: "NotFound", entity: "Contact", id: ico });
      }
      return wire(RegistryResult, hit);
    },
  },
  // Workspace creation (onboarding)
  {
    method: "POST",
    path: "/api/v1/workspaces",
    respond: ({ body }) => {
      const input = Option.getOrUndefined(decodeWorkspace(body));
      const created = wire(WorkspaceView, {
        id: demoId(105),
        slug: input?.slug ?? "novy-prostor",
        name: input?.name ?? "Nový prostor",
        branding: {
          pdfTemplate: "classic",
          accentColor: "#111111",
          footerText: null,
          theme: null,
          logo: null,
          stamp: null,
        },
        revision: 1,
      });
      return isStatus(created) ? created : status(201, created);
    },
  },
];
