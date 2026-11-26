/**
 * Demo API handlers for the `settings` page group (Screens 18–22).
 * Stateful in-memory fixtures so every Settings & Account tab works end-to-end in demo mode.
 */
import {
  AccountPreferences,
  type ALL_SCOPES,
  ApiKeyCreated,
  ApiKeyId,
  ApiKeyToken,
  ApiKeyView,
  BrandingView,
  ConnectedAppView,
  expandAccess,
  READ_SCOPES,
} from "@kvitbit/api-contract";
import {
  BankAccountId,
  CurrencyCode,
  InvitationId,
  InvitationView,
  MemberView,
  NumberingSeriesId,
  NumberingSeriesView,
  RegistryResult,
  UserId,
  WorkspaceId,
  WorkspaceSlug,
} from "@kvitbit/domain";
import { Schema } from "effect";
import type {
  BankAccount,
  PasskeyItem,
  SessionItem,
  WorkspaceDetail,
} from "../page/settings/models";
import { type DemoRoute, status } from "./router";
import { DEMO_USER, DEMO_WORKSPACE, demoId } from "./shell";

const wsId = WorkspaceId.make(DEMO_WORKSPACE.id);
const ownerId = UserId.make(DEMO_USER.id);
const adminId = UserId.make(demoId(2));
const accountantId = UserId.make(demoId(3));

let workspaceState: WorkspaceDetail = {
  id: wsId,
  slug: WorkspaceSlug.make(DEMO_WORKSPACE.slug),
  name: DEMO_WORKSPACE.name,
  closed: false,
  revision: 4,
  issuingEntity: {
    name: "Novák Design s.r.o.",
    ico: "27082440",
    dic: "CZ27082440",
    address: {
      street: "Korunní 810/104",
      city: "Praha 10",
      postalCode: "101 00",
      country: "CZ",
    },
    legalForm: "Společnost s ručením omezeným",
    registerEntry: "Spisová značka C 123456 vedená u Městského soudu v Praze",
    email: "fakturace@novakdesign.cz",
    phone: "+420 222 333 444",
    web: "https://novakdesign.cz",
  },
  taxRegime: "vat_payer",
  taxRegimeHistory: [
    { regime: "non_vat_payer", effectiveFrom: "2024-01-01" as never },
    { regime: "vat_payer", effectiveFrom: "2025-01-01" as never },
  ],
  defaults: {
    currency: CurrencyCode.make("CZK"),
    language: "cs",
    dueDays: 14,
    paymentMethod: "bank_transfer",
    defaultNote: "Děkujeme za spolupráci.",
    paymentRounding: "whole_unit",
    paymentTaxDocumentAutoSend: true,
  },
  reminderPolicy: {
    enabled: true,
    proformas: false,
    offsetsDays: [3, 10, 30],
  },
  bankAccounts: [
    {
      id: BankAccountId.make(demoId(201)),
      name: "Fio CZK hlavní",
      iban: "CZ6508000000192000145399",
      bic: "GIBACZPX",
      currency: CurrencyCode.make("CZK"),
      isDefault: true,
      revision: 1,
    },
    {
      id: BankAccountId.make(demoId(202)),
      name: "Fio EUR",
      iban: "CZ4220100000002400123456",
      bic: "FIOBCZPPXXX",
      currency: CurrencyCode.make("EUR"),
      isDefault: true,
      revision: 1,
    },
  ],
  branding: {
    pdfTemplate: "classic",
    accentColor: "#111111",
    footerText: "Novák Design s.r.o. · IČO 27082440 · DIČ CZ27082440",
    theme: { _tag: "Preset", id: "graphite_atelier" },
    logo: null,
    stamp: null,
  },
};

let seriesState: Array<NumberingSeriesView> = [
  {
    id: NumberingSeriesId.make(demoId(301)),
    kind: "invoice",
    name: "Faktury 2026",
    pattern: "YYYY-NNNN",
    isDefault: true,
    periodKey: "2026",
    nextCounter: 42,
    nextNumber: "2026-0042",
  },
  {
    id: NumberingSeriesId.make(demoId(302)),
    kind: "proforma",
    name: "Zálohové faktury",
    pattern: "ZF-YYYY-NNNN",
    isDefault: true,
    periodKey: "2026",
    nextCounter: 11,
    nextNumber: "ZF-2026-0011",
  },
  {
    id: NumberingSeriesId.make(demoId(303)),
    kind: "payment_tax_document",
    name: "Daňové doklady k platbě",
    pattern: "DD-YYYY-NNNN",
    isDefault: true,
    periodKey: "2026",
    nextCounter: 8,
    nextNumber: "DD-2026-0008",
  },
  {
    id: NumberingSeriesId.make(demoId(304)),
    kind: "credit_note",
    name: "Opravné daňové doklady",
    pattern: "OD-YYYY-NNNN",
    isDefault: true,
    periodKey: "2026",
    nextCounter: 3,
    nextNumber: "OD-2026-0003",
  },
];

let membersState: Array<MemberView> = [
  {
    userId: ownerId,
    name: DEMO_USER.name,
    email: DEMO_USER.email,
    role: "owner",
    joinedAt: "2024-01-10T09:00:00.000Z",
  },
  {
    userId: adminId,
    name: "Petr Dvořák",
    email: "petr.dvorak@example.cz",
    role: "member",
    joinedAt: "2025-02-14T11:30:00.000Z",
  },
  {
    userId: accountantId,
    name: "Ing. Marie Svobodová",
    email: "marie@ucetni-kancelar.cz",
    role: "accountant",
    joinedAt: "2025-03-01T08:15:00.000Z",
  },
];

let invitationsState: Array<InvitationView> = [
  {
    id: InvitationId.make(demoId(401)),
    email: "tomas.kral@example.cz",
    role: "member",
    status: "pending",
    invitedBy: { userId: ownerId, name: DEMO_USER.name },
    createdAt: "2026-11-20T10:00:00.000Z",
    expiresAt: "2026-11-27T10:00:00.000Z",
  },
];

let apiKeysState: Array<ApiKeyView> = [
  {
    id: ApiKeyId.make("k9x4m2p8q1r7"),
    name: "Pohoda export script",
    prefix: "kvb_k9x4m2p8q1r7",
    access: "read",
    scopes: [...READ_SCOPES],
    createdBy: { userId: ownerId, name: DEMO_USER.name },
    createdAt: "2026-09-12T10:00:00.000Z",
    lastUsedAt: "2026-11-23T18:45:00.000Z",
    expiresAt: null,
  },
  {
    id: ApiKeyId.make("b3v7n5w2z8c4"),
    name: "E-shop webhook",
    prefix: "kvb_b3v7n5w2z8c4",
    access: "custom",
    scopes: ["contacts:read", "contacts:write", "documents:read", "documents:write"],
    createdBy: { userId: ownerId, name: DEMO_USER.name },
    createdAt: "2026-10-05T14:20:00.000Z",
    lastUsedAt: "2026-11-24T09:12:00.000Z",
    expiresAt: "2027-10-05T00:00:00.000Z",
  },
];

let connectedAppsState: Array<ConnectedAppView> = [
  {
    grantId: "grant-claude-desktop-1",
    client: {
      id: "claude-desktop",
      name: "Claude Desktop (MCP)",
      redirectHost: "claude.ai",
    },
    member: { userId: ownerId, name: DEMO_USER.name },
    access: "custom",
    scopes: ["contacts:read", "documents:read", "reports:read"],
    createdAt: "2026-11-01T12:00:00.000Z",
    lastUsedAt: "2026-11-24T11:20:00.000Z",
  },
];

let preferencesState: AccountPreferences = {
  locale: "cs",
  theme: {
    mode: "system",
    style: "elegant",
    contrast: "standard",
    dynamicColor: false,
    source: { _tag: "Preset", id: "graphite_atelier" },
  },
  resolvedTheme: null,
  revision: 2,
};

let passkeysState: Array<PasskeyItem> = [
  {
    id: "pk-macbook-1",
    name: "MacBook Pro Touch ID",
    createdAt: "2026-05-14T09:30:00.000Z",
    deviceType: "platform",
  },
];

let sessionsState: Array<SessionItem> = [
  {
    id: "sess-current",
    token: "tok-sess-current",
    userAgent: "Chrome 131 · Linux",
    ipAddress: "185.42.110.24",
    updatedAt: "2026-11-24T13:30:00.000Z",
    current: true,
  },
  {
    id: "sess-pixel",
    token: "tok-sess-pixel",
    userAgent: "Kvitbit Android · Pixel 8",
    ipAddress: "185.42.110.24",
    updatedAt: "2026-11-23T20:15:00.000Z",
    current: false,
  },
];

let seqCounter = 500;
const nextId = () => demoId(++seqCounter);

const brandingView = (): BrandingView => ({
  ...workspaceState.branding,
  resolvedTheme: null,
  revision: workspaceState.revision,
});

export const routes: ReadonlyArray<DemoRoute> = [
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId",
    respond: () => workspaceState,
  },
  {
    method: "PATCH",
    path: "/api/v1/workspaces/:workspaceId/issuing-entity",
    respond: ({ body }) => {
      const patch = (body ?? {}) as Record<string, unknown>;
      const nextEntity = {
        ...workspaceState.issuingEntity,
        ...(typeof patch.name === "string" ? { name: patch.name } : {}),
        ...(patch.ico !== undefined ? { ico: patch.ico as string | null } : {}),
        ...(patch.dic !== undefined ? { dic: patch.dic as string | null } : {}),
        ...(patch.legalForm !== undefined ? { legalForm: patch.legalForm as string | null } : {}),
        ...(patch.registerEntry !== undefined
          ? { registerEntry: patch.registerEntry as string | null }
          : {}),
        ...(patch.email !== undefined ? { email: patch.email as string | null } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone as string | null } : {}),
        ...(patch.web !== undefined ? { web: patch.web as string | null } : {}),
        ...(typeof patch.address === "object" && patch.address !== null
          ? { address: patch.address as WorkspaceDetail["issuingEntity"]["address"] }
          : {}),
      };
      let taxRegimeHistory = [...workspaceState.taxRegimeHistory];
      let taxRegime = workspaceState.taxRegime;
      if (typeof patch.taxRegime === "object" && patch.taxRegime !== null) {
        const tr = patch.taxRegime as {
          regime: WorkspaceDetail["taxRegime"];
          effectiveFrom: string;
        };
        taxRegimeHistory = [
          ...taxRegimeHistory.filter((p) => p.effectiveFrom !== tr.effectiveFrom),
          { regime: tr.regime, effectiveFrom: tr.effectiveFrom as never },
        ].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
        taxRegime = tr.regime;
      }
      workspaceState = {
        ...workspaceState,
        name: nextEntity.name,
        issuingEntity: nextEntity,
        taxRegime,
        taxRegimeHistory,
        revision: workspaceState.revision + 1,
      };
      return workspaceState;
    },
  },
  {
    method: "PATCH",
    path: "/api/v1/workspaces/:workspaceId/settings",
    respond: ({ body }) => {
      const patch = (body ?? {}) as Record<string, unknown>;
      const defaultsPatch = (patch.defaults ?? {}) as Partial<WorkspaceDetail["defaults"]>;
      const remPatch = (patch.reminderPolicy ?? {}) as Partial<WorkspaceDetail["reminderPolicy"]>;
      const brandingPatch = (patch.branding ?? {}) as Partial<WorkspaceDetail["branding"]>;
      workspaceState = {
        ...workspaceState,
        ...(typeof patch.slug === "string" ? { slug: WorkspaceSlug.make(patch.slug) } : {}),
        defaults: { ...workspaceState.defaults, ...defaultsPatch },
        reminderPolicy: { ...workspaceState.reminderPolicy, ...remPatch },
        branding: { ...workspaceState.branding, ...brandingPatch },
        revision: workspaceState.revision + 1,
      };
      return workspaceState;
    },
  },
  {
    method: "GET",
    path: "/api/v1/registry/companies/:ico",
    respond: ({ params }) => {
      const ico = (params.ico ?? "").replace(/\s+/g, "");
      if (!/^\d{8}$/.test(ico)) {
        return status(422, {
          _tag: "Invalid",
          issues: [{ path: ["ico"], code: "ico.checksum" }],
        });
      }
      const result: RegistryResult = {
        ico,
        name: ico === "27082440" ? "Alza.cz a.s." : `Ukázková firma ${ico} s.r.o.`,
        address: {
          street: "Jankovcova 1522/53",
          city: "Praha 7",
          postalCode: "170 00",
          country: "CZ",
        },
        dic: `CZ${ico}`,
        legalForm: "Akciová společnost",
        registerEntry: "Spisová značka B 8573 vedená u Městského soudu v Praze",
        terminatedOn: null,
      };
      return Schema.encodeSync(RegistryResult)(result);
    },
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/bank-accounts",
    respond: () => workspaceState.bankAccounts,
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/bank-accounts",
    respond: ({ body }) => {
      const input = (body ?? {}) as Partial<BankAccount>;
      const currency = input.currency ?? CurrencyCode.make("CZK");
      const makeDefault =
        input.isDefault === true ||
        !workspaceState.bankAccounts.some((b) => b.currency === currency);
      const created: BankAccount = {
        id: BankAccountId.make(nextId()),
        name: input.name ?? null,
        iban: String(input.iban ?? "")
          .replace(/\s+/g, "")
          .toUpperCase(),
        bic: input.bic ?? null,
        currency,
        isDefault: makeDefault,
        revision: 1,
      };
      const others = makeDefault
        ? workspaceState.bankAccounts.map((b) =>
            b.currency === currency ? { ...b, isDefault: false } : b,
          )
        : workspaceState.bankAccounts;
      workspaceState = { ...workspaceState, bankAccounts: [...others, created] };
      return status(201, created);
    },
  },
  {
    method: "PUT",
    path: "/api/v1/workspaces/:workspaceId/bank-accounts/:bankAccountId",
    respond: ({ params, body }) => {
      const input = (body ?? {}) as Partial<BankAccount>;
      const id = params.bankAccountId ?? "";
      const existing = workspaceState.bankAccounts.find((b) => b.id === id);
      if (existing === undefined)
        return status(404, { _tag: "NotFound", entity: "BankAccount", id });
      const currency = input.currency ?? existing.currency;
      const makeDefault = input.isDefault ?? existing.isDefault;
      const updated: BankAccount = {
        ...existing,
        name: input.name !== undefined ? input.name : existing.name,
        iban:
          input.iban !== undefined
            ? String(input.iban).replace(/\s+/g, "").toUpperCase()
            : existing.iban,
        bic: input.bic !== undefined ? input.bic : existing.bic,
        currency,
        isDefault: makeDefault,
        revision: existing.revision + 1,
      };
      workspaceState = {
        ...workspaceState,
        bankAccounts: workspaceState.bankAccounts.map((b) => {
          if (b.id === id) return updated;
          if (makeDefault && b.currency === currency) return { ...b, isDefault: false };
          return b;
        }),
      };
      return updated;
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/workspaces/:workspaceId/bank-accounts/:bankAccountId",
    respond: ({ params }) => {
      workspaceState = {
        ...workspaceState,
        bankAccounts: workspaceState.bankAccounts.filter((b) => b.id !== params.bankAccountId),
      };
      return undefined;
    },
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/branding",
    respond: () => Schema.encodeSync(BrandingView)(brandingView()),
  },
  {
    method: "PATCH",
    path: "/api/v1/workspaces/:workspaceId/branding",
    respond: ({ body }) => {
      const patch = (body ?? {}) as Partial<WorkspaceDetail["branding"]>;
      workspaceState = {
        ...workspaceState,
        branding: { ...workspaceState.branding, ...patch },
        revision: workspaceState.revision + 1,
      };
      return Schema.encodeSync(BrandingView)(brandingView());
    },
  },
  {
    method: "PUT",
    path: "/api/v1/workspaces/:workspaceId/branding/:image",
    respond: ({ params }) => {
      const kind = params.image === "stamp" ? "stamp" : "logo";
      const ref = {
        contentType: "image/png" as const,
        sizeBytes: 4096,
        updatedAt: new Date().toISOString(),
      };
      workspaceState = {
        ...workspaceState,
        branding: { ...workspaceState.branding, [kind]: ref },
        revision: workspaceState.revision + 1,
      };
      return ref;
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/workspaces/:workspaceId/branding/:image",
    respond: ({ params }) => {
      const kind = params.image === "stamp" ? "stamp" : "logo";
      workspaceState = {
        ...workspaceState,
        branding: { ...workspaceState.branding, [kind]: null },
        revision: workspaceState.revision + 1,
      };
      return undefined;
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/branding/preview-pdf",
    respond: () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/numbering-series",
    respond: () => Schema.encodeSync(Schema.Array(NumberingSeriesView))(seriesState),
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/numbering-series",
    respond: ({ body }) => {
      const input = (body ?? {}) as {
        kind: NumberingSeriesView["kind"];
        name: string;
        pattern: string;
        nextNumber?: number;
        isDefault?: boolean;
      };
      const counter = input.nextNumber ?? 1;
      const isDefault = input.isDefault === true || !seriesState.some((s) => s.kind === input.kind);
      const created: NumberingSeriesView = {
        id: NumberingSeriesId.make(nextId()),
        kind: input.kind,
        name: input.name,
        pattern: input.pattern,
        isDefault,
        periodKey: "2026",
        nextCounter: counter,
        nextNumber: `${input.pattern
          .replace(/YYYY/g, "2026")
          .replace(/YY/g, "26")
          .replace(/MM/g, "11")
          .replace(/N+/g, (m) => String(counter).padStart(m.length, "0"))}`,
      };
      if (isDefault) {
        seriesState = seriesState.map((s) =>
          s.kind === input.kind ? { ...s, isDefault: false } : s,
        );
      }
      seriesState = [...seriesState, created];
      return status(201, Schema.encodeSync(NumberingSeriesView)(created));
    },
  },
  {
    method: "PUT",
    path: "/api/v1/workspaces/:workspaceId/numbering-series/:seriesId",
    respond: ({ params, body }) => {
      const input = (body ?? {}) as {
        kind: NumberingSeriesView["kind"];
        name: string;
        pattern: string;
        nextNumber?: number;
        isDefault?: boolean;
      };
      const existing = seriesState.find((s) => s.id === params.seriesId);
      if (existing === undefined) {
        return status(404, { _tag: "NotFound", entity: "NumberingSeries", id: params.seriesId });
      }
      const counter = input.nextNumber ?? existing.nextCounter;
      const isDefault = input.isDefault ?? existing.isDefault;
      const updated: NumberingSeriesView = {
        ...existing,
        name: input.name,
        pattern: input.pattern,
        isDefault,
        nextCounter: counter,
        nextNumber: `${input.pattern
          .replace(/YYYY/g, "2026")
          .replace(/YY/g, "26")
          .replace(/MM/g, "11")
          .replace(/N+/g, (m) => String(counter).padStart(m.length, "0"))}`,
      };
      seriesState = seriesState.map((s) => {
        if (s.id === existing.id) return updated;
        if (isDefault && s.kind === existing.kind) return { ...s, isDefault: false };
        return s;
      });
      return Schema.encodeSync(NumberingSeriesView)(updated);
    },
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/members",
    respond: () => Schema.encodeSync(Schema.Array(MemberView))(membersState),
  },
  {
    method: "PUT",
    path: "/api/v1/workspaces/:workspaceId/members/:userId/role",
    respond: ({ params, body }) => {
      const role = (body as { role?: MemberView["role"] } | null)?.role;
      if (role !== undefined) {
        membersState = membersState.map((m) => (m.userId === params.userId ? { ...m, role } : m));
      }
      return undefined;
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/workspaces/:workspaceId/members/:userId",
    respond: ({ params }) => {
      membersState = membersState.filter((m) => m.userId !== params.userId);
      return undefined;
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/members/me/leave",
    respond: () => undefined,
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/invitations",
    respond: () => Schema.encodeSync(Schema.Array(InvitationView))(invitationsState),
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/invitations",
    respond: ({ body }) => {
      const input = (body ?? {}) as { email: string; role: InvitationView["role"] };
      const created: InvitationView = {
        id: InvitationId.make(nextId()),
        email: input.email,
        role: input.role,
        status: "pending",
        invitedBy: { userId: ownerId, name: DEMO_USER.name },
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      };
      invitationsState = [created, ...invitationsState];
      return status(201, Schema.encodeSync(InvitationView)(created));
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/workspaces/:workspaceId/invitations/:invitationId",
    respond: ({ params }) => {
      invitationsState = invitationsState.filter((i) => i.id !== params.invitationId);
      return undefined;
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/invitations/:invitationId/resend",
    respond: () => status(202, null),
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/ownership-transfer",
    respond: ({ body }) => {
      const to = (body as { to?: string } | null)?.to;
      if (typeof to === "string") {
        membersState = membersState.map((m) => {
          if (m.userId === to) return { ...m, role: "owner" };
          if (m.role === "owner") return { ...m, role: "admin" };
          return m;
        });
      }
      return undefined;
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/close",
    respond: () => {
      workspaceState = { ...workspaceState, closed: true, revision: workspaceState.revision + 1 };
      return undefined;
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/exports",
    respond: () =>
      status(202, {
        id: nextId(),
        status: "running",
        createdAt: new Date().toISOString(),
        downloadUrl: null,
      }),
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/api-keys",
    respond: () => Schema.encodeSync(Schema.Array(ApiKeyView))(apiKeysState),
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/api-keys",
    respond: ({ body }) => {
      const input = (body ?? {}) as {
        name: string;
        access: "read" | "read_write" | "custom";
        scopes?: ReadonlyArray<(typeof ALL_SCOPES)[number]>;
        expiresOn?: string;
      };
      const expanded =
        input.access === "custom"
          ? expandAccess({
              access: "custom",
              scopes: (input.scopes ?? ["documents:read"]) as [
                (typeof ALL_SCOPES)[number],
                ...(typeof ALL_SCOPES)[number][],
              ],
            })
          : expandAccess({ access: input.access });
      const keyId = ApiKeyId.make(`demo${++seqCounter}abcd`);
      const secret = ApiKeyToken.make(`kvb_${keyId}_9fK2mP7xQ4vL8nR1wT6yB3cH5jD0sA2eF4g`);
      const key: ApiKeyView = {
        id: keyId,
        name: input.name,
        prefix: `kvb_${keyId}`,
        access: expanded.access,
        scopes: [...expanded.scopes],
        createdBy: { userId: ownerId, name: DEMO_USER.name },
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        expiresAt: input.expiresOn ? `${input.expiresOn}T00:00:00.000Z` : null,
      };
      apiKeysState = [key, ...apiKeysState];
      return status(201, Schema.encodeSync(ApiKeyCreated)({ key, secret }));
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/workspaces/:workspaceId/api-keys/:keyId",
    respond: ({ params }) => {
      apiKeysState = apiKeysState.filter((k) => k.id !== params.keyId);
      return undefined;
    },
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/connected-apps",
    respond: () => Schema.encodeSync(Schema.Array(ConnectedAppView))(connectedAppsState),
  },
  {
    method: "DELETE",
    path: "/api/v1/workspaces/:workspaceId/connected-apps/:grantId",
    respond: ({ params }) => {
      connectedAppsState = connectedAppsState.filter((g) => g.grantId !== params.grantId);
      return undefined;
    },
  },
  {
    method: "GET",
    path: "/api/v1/me/preferences",
    respond: () => Schema.encodeSync(AccountPreferences)(preferencesState),
  },
  {
    method: "PATCH",
    path: "/api/v1/me/preferences",
    respond: ({ body }) => {
      const patch = (body ?? {}) as Partial<AccountPreferences>;
      preferencesState = {
        ...preferencesState,
        ...(patch.locale !== undefined ? { locale: patch.locale } : {}),
        ...(patch.theme !== undefined ? { theme: patch.theme } : {}),
        revision: preferencesState.revision + 1,
      };
      return Schema.encodeSync(AccountPreferences)(preferencesState);
    },
  },
  // Better Auth demo endpoints for Account & Security
  { method: "POST", path: "/api/auth/update-user", respond: () => ({ status: true }) },
  { method: "POST", path: "/api/auth/change-email", respond: () => ({ status: true }) },
  { method: "POST", path: "/api/auth/change-password", respond: () => ({ status: true }) },
  {
    method: "GET",
    path: "/api/auth/list-accounts",
    respond: () => [{ id: "acc-cred-1", providerId: "credential" }],
  },
  {
    method: "GET",
    path: "/api/auth/passkey/list-user-passkeys",
    respond: () => passkeysState,
  },
  {
    method: "GET",
    path: "/api/auth/passkey/generate-register-options",
    respond: () => ({
      challenge: "ZGVtby1yZWdpc3Rlci1jaGFsbGVuZ2U",
      rp: { name: "Kvitbit", id: "localhost" },
      user: { id: "ZGVtby11c2VyLWlk", name: "jana@novak.cz", displayName: "Jana Nováková" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    }),
  },
  {
    method: "POST",
    path: "/api/auth/passkey/verify-registration",
    respond: ({ body }) => {
      const name = (body as { name?: string } | null)?.name ?? "Passkey";
      const created: PasskeyItem = {
        id: `pk-${++seqCounter}`,
        name,
        createdAt: new Date().toISOString(),
        deviceType: "platform",
      };
      passkeysState = [...passkeysState, created];
      return created;
    },
  },
  {
    method: "POST",
    path: "/api/auth/passkey/update-passkey",
    respond: ({ body }) => {
      const { id, name } = (body ?? {}) as { id?: string; name?: string };
      if (id !== undefined && name !== undefined) {
        passkeysState = passkeysState.map((p) => (p.id === id ? { ...p, name } : p));
      }
      return { status: true };
    },
  },
  {
    method: "POST",
    path: "/api/auth/passkey/delete-passkey",
    respond: ({ body }) => {
      const id = (body as { id?: string } | null)?.id;
      if (id !== undefined) passkeysState = passkeysState.filter((p) => p.id !== id);
      return { status: true };
    },
  },
  { method: "GET", path: "/api/auth/list-sessions", respond: () => sessionsState },
  {
    method: "POST",
    path: "/api/auth/revoke-session",
    respond: ({ body }) => {
      const { token, id } = (body ?? {}) as { token?: string; id?: string };
      if (token !== undefined) {
        sessionsState = sessionsState.filter((s) => s.token !== token);
      } else if (id !== undefined) {
        sessionsState = sessionsState.filter((s) => s.id !== id);
      }
      return { status: true };
    },
  },
  {
    method: "POST",
    path: "/api/auth/revoke-other-sessions",
    respond: () => {
      sessionsState = sessionsState.filter((s) => s.current);
      return { status: true };
    },
  },
  { method: "POST", path: "/api/auth/delete-user", respond: () => ({ status: true }) },
];
