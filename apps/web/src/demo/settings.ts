/**
 * Demo API handlers for the `settings` page group (Screens 18–22).
 * Stateful in-memory fixtures so every Settings & Account tab works end-to-end in demo mode.
 */
import {
  AccountPreferences,
  AccountPreferencesPatch,
  ApiKeyCreate,
  ApiKeyCreated,
  ApiKeyId,
  ApiKeyToken,
  ApiKeyView,
  BrandingView,
  ConnectedAppView,
  expandAccess,
  READ_SCOPES,
  SeriesInput,
} from "@kvitbit/api-contract";
import {
  BankAccountId,
  BrandingPatch,
  CurrencyCode,
  InvitationId,
  InvitationRole,
  InvitationView,
  IsoDate,
  MemberView,
  NumberingSeriesId,
  NumberingSeriesView,
  RegistryResult,
  UserId,
  WorkspaceId,
  WorkspaceSlug,
} from "@kvitbit/domain";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  BankAccount,
  IssuingEntity,
  PasskeyItem,
  ReminderSchedule,
  SessionItem,
  TaxRegimePeriod,
  WorkspaceDefaults,
  type WorkspaceDetail,
} from "../page/settings/models";
import { type DemoRoute, status } from "./router";
import { DEMO_USER, DEMO_WORKSPACE, demoId } from "./shell";

const wsId = WorkspaceId.make(DEMO_WORKSPACE.id);
const ownerId = UserId.make(DEMO_USER.id);
const adminId = UserId.make(demoId(2));
const accountantId = UserId.make(demoId(3));

const IssuingEntityPatch = Schema.Struct({
  name: Schema.optionalKey(IssuingEntity.fields.name),
  ico: Schema.optionalKey(IssuingEntity.fields.ico),
  dic: Schema.optionalKey(IssuingEntity.fields.dic),
  address: Schema.optionalKey(IssuingEntity.fields.address),
  legalForm: Schema.optionalKey(IssuingEntity.fields.legalForm),
  registerEntry: Schema.optionalKey(IssuingEntity.fields.registerEntry),
  email: Schema.optionalKey(IssuingEntity.fields.email),
  phone: Schema.optionalKey(IssuingEntity.fields.phone),
  web: Schema.optionalKey(IssuingEntity.fields.web),
  taxRegime: Schema.optionalKey(TaxRegimePeriod),
});
const DefaultsPatch = Schema.Struct({
  currency: Schema.optionalKey(WorkspaceDefaults.fields.currency),
  language: Schema.optionalKey(WorkspaceDefaults.fields.language),
  dueDays: Schema.optionalKey(WorkspaceDefaults.fields.dueDays),
  paymentMethod: Schema.optionalKey(WorkspaceDefaults.fields.paymentMethod),
  defaultNote: Schema.optionalKey(WorkspaceDefaults.fields.defaultNote),
  paymentRounding: Schema.optionalKey(WorkspaceDefaults.fields.paymentRounding),
  paymentTaxDocumentAutoSend: Schema.optionalKey(
    WorkspaceDefaults.fields.paymentTaxDocumentAutoSend,
  ),
});
const ReminderPatch = Schema.Struct({
  enabled: Schema.optionalKey(ReminderSchedule.fields.enabled),
  proformas: Schema.optionalKey(ReminderSchedule.fields.proformas),
  offsetsDays: Schema.optionalKey(ReminderSchedule.fields.offsetsDays),
});
const SettingsPatch = Schema.Struct({
  slug: Schema.optionalKey(WorkspaceSlug),
  defaults: DefaultsPatch.pipe(Schema.NullOr, Schema.optionalKey),
  reminderPolicy: ReminderPatch.pipe(Schema.NullOr, Schema.optionalKey),
  branding: BrandingPatch.pipe(Schema.NullOr, Schema.optionalKey),
});
const BankAccountPatch = Schema.Struct({
  name: Schema.optionalKey(BankAccount.fields.name),
  iban: Schema.optionalKey(BankAccount.fields.iban),
  bic: Schema.optionalKey(BankAccount.fields.bic),
  currency: Schema.optionalKey(BankAccount.fields.currency),
  isDefault: Schema.optionalKey(BankAccount.fields.isDefault),
});
const MemberRoleInput = Schema.Struct({ role: InvitationRole });
const InvitationInput = Schema.Struct({ email: Schema.NonEmptyString, role: InvitationRole });
const OwnershipInput = Schema.Struct({ to: UserId });
const DemoApiKeyCreate = ApiKeyCreate.mapMembers(([preset, custom]) => [
  preset,
  custom.pipe(
    Schema.fieldsAssign({
      scopes: custom.fields.scopes.pipe(
        Schema.withDecodingDefaultKey(Effect.succeed(["documents:read"])),
      ),
    }),
  ),
]);
const applyBrandingPatch = (patch: BrandingPatch | null | undefined) => {
  const current = workspaceState.branding;
  return {
    ...current,
    pdfTemplate: patch?.pdfTemplate ?? current.pdfTemplate,
    accentColor: patch?.accentColor ?? current.accentColor,
    footerText: patch?.footerText === undefined ? current.footerText : patch.footerText,
    theme: patch?.theme === undefined ? current.theme : patch.theme,
  };
};
const PasskeyRegistration = Schema.Struct({
  name: Schema.optionalKey(PasskeyItem.fields.name),
  response: Schema.Unknown,
});
const PasskeyUpdate = Schema.Struct({ id: PasskeyItem.fields.id, name: PasskeyItem.fields.name });
const PasskeyDelete = Schema.Struct({ id: PasskeyItem.fields.id });
const SessionRevoke = Schema.Struct({ token: SessionItem.fields.token });

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
    { regime: "non_vat_payer", effectiveFrom: IsoDate.make("2024-01-01") },
    { regime: "vat_payer", effectiveFrom: IsoDate.make("2025-01-01") },
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
    deviceType: "singleDevice",
  },
];

// Matches the active session ID returned by the demo shell's get-session route.
const demoCurrentSessionId = "demo";
let sessionsState: Array<Omit<SessionItem, "current">> = [
  {
    id: demoCurrentSessionId,
    token: "tok-sess-current",
    userAgent: "Chrome 131 · Linux",
    ipAddress: "185.42.110.24",
    updatedAt: "2026-11-24T13:30:00.000Z",
  },
  {
    id: "sess-pixel",
    token: "tok-sess-pixel",
    userAgent: "Kvitbit Android · Pixel 8",
    ipAddress: "185.42.110.24",
    updatedAt: "2026-11-23T20:15:00.000Z",
  },
];

let seqCounter = 500;
const nextId = () => demoId(++seqCounter);

const brandingView = (): BrandingView => ({
  ...workspaceState.branding,
  resolvedTheme: null,
  revision: workspaceState.revision,
});

const invalidBody = () => status(400, { message: "Invalid request body" });

const wire = <S extends Schema.ConstraintEncoder<object>>(
  schema: S,
  value: S["Type"],
  code?: number,
) => {
  const encoded = Schema.encodeOption(schema)(value);
  if (Option.isNone(encoded)) return status(500, { message: "Invalid demo response" });
  return code === undefined ? encoded.value : status(code, encoded.value);
};

const stripWhitespace = Str.replace(/\s+/g, "");
const icoPattern = /^\d{8}$/;
const normalizeIban = (iban: string) => Str.toUpperCase(stripWhitespace(iban));
const nowIso = () => DateTime.formatIso(DateTime.nowUnsafe());

const counterRun = /(N+)/;

const demoSeriesNumber = (pattern: string, counter: number) =>
  Fn.pipe(
    pattern,
    Str.replace(/YYYY/g, "2026"),
    Str.replace(/YY/g, "26"),
    Str.replace(/MM/g, "11"),
    Str.split(counterRun),
    Arr.map((part, index) =>
      index % 2 === 0 ? part : Str.padStart(part.length, "0")(String(counter)),
    ),
    Arr.join(""),
  );

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
      const decoded = Schema.decodeOption(IssuingEntityPatch)(body ?? {});
      if (Option.isNone(decoded)) return invalidBody();
      const { taxRegime, ...entityPatch } = decoded.value;
      const nextEntity = { ...workspaceState.issuingEntity, ...entityPatch };
      let taxRegimeHistory = workspaceState.taxRegimeHistory;
      if (taxRegime !== undefined) {
        const otherPeriods = Arr.filter(
          taxRegimeHistory,
          (period) => period.effectiveFrom !== taxRegime.effectiveFrom,
        );
        taxRegimeHistory = Arr.sortWith(
          [...otherPeriods, taxRegime],
          (period) => period.effectiveFrom,
          Order.String,
        );
      }
      workspaceState = {
        ...workspaceState,
        name: nextEntity.name,
        issuingEntity: nextEntity,
        taxRegime: taxRegime?.regime ?? workspaceState.taxRegime,
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
      const decoded = Schema.decodeOption(SettingsPatch)(body ?? {});
      if (Option.isNone(decoded)) return invalidBody();
      const patch = decoded.value;
      workspaceState = {
        ...workspaceState,
        slug: patch.slug ?? workspaceState.slug,
        defaults: { ...workspaceState.defaults, ...patch.defaults },
        reminderPolicy: { ...workspaceState.reminderPolicy, ...patch.reminderPolicy },
        branding: applyBrandingPatch(patch.branding),
        revision: workspaceState.revision + 1,
      };
      return workspaceState;
    },
  },
  {
    method: "GET",
    path: "/api/v1/registry/companies/:ico",
    respond: ({ params }) => {
      const ico = stripWhitespace(params["ico"] ?? "");
      if (!icoPattern.test(ico)) {
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
      return wire(RegistryResult, result);
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
      const decoded = Schema.decodeOption(BankAccountPatch)(body ?? {});
      if (Option.isNone(decoded)) return invalidBody();
      const input = decoded.value;
      const currency = input.currency ?? CurrencyCode.make("CZK");
      const makeDefault =
        input.isDefault === true ||
        !Arr.some(workspaceState.bankAccounts, (b) => b.currency === currency);
      const created: BankAccount = {
        id: BankAccountId.make(nextId()),
        name: input.name ?? null,
        iban: normalizeIban(input.iban ?? ""),
        bic: input.bic ?? null,
        currency,
        isDefault: makeDefault,
        revision: 1,
      };
      const others = makeDefault
        ? Arr.map(workspaceState.bankAccounts, (b) =>
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
      const id = params["bankAccountId"] ?? "";
      const found = Arr.findFirst(workspaceState.bankAccounts, (b) => b.id === id);
      if (Option.isNone(found)) return status(404, { _tag: "NotFound", entity: "BankAccount", id });
      const decoded = Schema.decodeOption(BankAccountPatch)(body ?? {});
      if (Option.isNone(decoded)) return invalidBody();
      const existing = found.value;
      const input = decoded.value;
      const currency = input.currency ?? existing.currency;
      const makeDefault = input.isDefault ?? existing.isDefault;
      const updated: BankAccount = {
        ...existing,
        name: input.name !== undefined ? input.name : existing.name,
        iban: input.iban === undefined ? existing.iban : normalizeIban(input.iban),
        bic: input.bic !== undefined ? input.bic : existing.bic,
        currency,
        isDefault: makeDefault,
        revision: existing.revision + 1,
      };
      workspaceState = {
        ...workspaceState,
        bankAccounts: Arr.map(workspaceState.bankAccounts, (b) => {
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
        bankAccounts: Arr.filter(
          workspaceState.bankAccounts,
          (b) => b.id !== params["bankAccountId"],
        ),
      };
    },
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/branding",
    respond: () => wire(BrandingView, brandingView()),
  },
  {
    method: "PATCH",
    path: "/api/v1/workspaces/:workspaceId/branding",
    respond: ({ body }) => {
      const decoded = Schema.decodeOption(BrandingPatch)(body ?? {});
      if (Option.isNone(decoded)) return invalidBody();
      workspaceState = {
        ...workspaceState,
        branding: applyBrandingPatch(decoded.value),
        revision: workspaceState.revision + 1,
      };
      return wire(BrandingView, brandingView());
    },
  },
  {
    method: "PUT",
    path: "/api/v1/workspaces/:workspaceId/branding/:image",
    respond: ({ params }) => {
      const kind = params["image"] === "stamp" ? "stamp" : "logo";
      const ref = {
        contentType: "image/png" as const,
        sizeBytes: 4096,
        updatedAt: nowIso(),
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
      const kind = params["image"] === "stamp" ? "stamp" : "logo";
      workspaceState = {
        ...workspaceState,
        branding: { ...workspaceState.branding, [kind]: null },
        revision: workspaceState.revision + 1,
      };
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
    respond: () => wire(Schema.Array(NumberingSeriesView), seriesState),
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/numbering-series",
    respond: ({ body }) => {
      const decoded = Schema.decodeUnknownOption(SeriesInput)(body);
      if (Option.isNone(decoded)) return invalidBody();
      const input = decoded.value;
      const counter = input.nextNumber ?? 1;
      const isDefault =
        input.isDefault === true || !Arr.some(seriesState, (s) => s.kind === input.kind);
      const created: NumberingSeriesView = {
        id: NumberingSeriesId.make(nextId()),
        kind: input.kind,
        name: input.name,
        pattern: input.pattern,
        isDefault,
        periodKey: "2026",
        nextCounter: counter,
        nextNumber: demoSeriesNumber(input.pattern, counter),
      };
      if (isDefault) {
        seriesState = Arr.map(seriesState, (s) =>
          s.kind === input.kind ? { ...s, isDefault: false } : s,
        );
      }
      seriesState = [...seriesState, created];
      return wire(NumberingSeriesView, created, 201);
    },
  },
  {
    method: "PUT",
    path: "/api/v1/workspaces/:workspaceId/numbering-series/:seriesId",
    respond: ({ params, body }) => {
      const found = Arr.findFirst(seriesState, (s) => s.id === params["seriesId"]);
      if (Option.isNone(found)) {
        return status(404, { _tag: "NotFound", entity: "NumberingSeries", id: params["seriesId"] });
      }
      const decoded = Schema.decodeUnknownOption(SeriesInput)(body);
      if (Option.isNone(decoded)) return invalidBody();
      const existing = found.value;
      const input = decoded.value;
      const counter = input.nextNumber ?? existing.nextCounter;
      const isDefault = input.isDefault ?? existing.isDefault;
      const updated: NumberingSeriesView = {
        ...existing,
        name: input.name,
        pattern: input.pattern,
        isDefault,
        nextCounter: counter,
        nextNumber: demoSeriesNumber(input.pattern, counter),
      };
      seriesState = Arr.map(seriesState, (s) => {
        if (s.id === existing.id) return updated;
        if (isDefault && s.kind === existing.kind) return { ...s, isDefault: false };
        return s;
      });
      return wire(NumberingSeriesView, updated);
    },
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/members",
    respond: () => wire(Schema.Array(MemberView), membersState),
  },
  {
    method: "PUT",
    path: "/api/v1/workspaces/:workspaceId/members/:userId/role",
    respond: ({ params, body }) => {
      const decoded = Schema.decodeUnknownOption(MemberRoleInput)(body);
      if (Option.isNone(decoded)) return invalidBody();
      const { role } = decoded.value;
      membersState = Arr.map(membersState, (m) =>
        m.userId === params["userId"] ? { ...m, role } : m,
      );
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/workspaces/:workspaceId/members/:userId",
    respond: ({ params }) => {
      membersState = Arr.filter(membersState, (m) => m.userId !== params["userId"]);
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
    respond: () => wire(Schema.Array(InvitationView), invitationsState),
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/invitations",
    respond: ({ body }) => {
      const decoded = Schema.decodeUnknownOption(InvitationInput)(body);
      if (Option.isNone(decoded)) return invalidBody();
      const input = decoded.value;
      const now = DateTime.nowUnsafe();
      const created: InvitationView = {
        id: InvitationId.make(nextId()),
        email: input.email,
        role: input.role,
        status: "pending",
        invitedBy: { userId: ownerId, name: DEMO_USER.name },
        createdAt: DateTime.formatIso(now),
        expiresAt: DateTime.formatIso(DateTime.add(now, { days: 7 })),
      };
      invitationsState = [created, ...invitationsState];
      return wire(InvitationView, created, 201);
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/workspaces/:workspaceId/invitations/:invitationId",
    respond: ({ params }) => {
      invitationsState = Arr.filter(invitationsState, (i) => i.id !== params["invitationId"]);
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
      const decoded = Schema.decodeUnknownOption(OwnershipInput)(body);
      if (Option.isNone(decoded)) return invalidBody();
      const { to } = decoded.value;
      membersState = Arr.map(membersState, (m) => {
        if (m.userId === to) return { ...m, role: "owner" };
        if (m.role === "owner") return { ...m, role: "admin" };
        return m;
      });
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/close",
    respond: () => {
      workspaceState = { ...workspaceState, closed: true, revision: workspaceState.revision + 1 };
    },
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/exports",
    respond: () =>
      status(202, {
        id: nextId(),
        status: "running",
        createdAt: nowIso(),
        downloadUrl: null,
      }),
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/api-keys",
    respond: () => wire(Schema.Array(ApiKeyView), apiKeysState),
  },
  {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/api-keys",
    respond: ({ body }) => {
      const decoded = Schema.decodeUnknownOption(DemoApiKeyCreate)(body);
      if (Option.isNone(decoded)) return invalidBody();
      const input = decoded.value;
      const expanded = expandAccess(input);
      const keyId = ApiKeyId.make(`demo${++seqCounter}abcd`);
      const secret = ApiKeyToken.make(`kvb_${keyId}_9fK2mP7xQ4vL8nR1wT6yB3cH5jD0sA2eF4g`);
      const key: ApiKeyView = {
        id: keyId,
        name: input.name,
        prefix: `kvb_${keyId}`,
        access: expanded.access,
        scopes: [...expanded.scopes],
        createdBy: { userId: ownerId, name: DEMO_USER.name },
        createdAt: nowIso(),
        lastUsedAt: null,
        expiresAt: input.expiresOn === undefined ? null : `${input.expiresOn}T00:00:00.000Z`,
      };
      apiKeysState = [key, ...apiKeysState];
      return wire(ApiKeyCreated, { key, secret }, 201);
    },
  },
  {
    method: "DELETE",
    path: "/api/v1/workspaces/:workspaceId/api-keys/:keyId",
    respond: ({ params }) => {
      apiKeysState = Arr.filter(apiKeysState, (k) => k.id !== params["keyId"]);
    },
  },
  {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/connected-apps",
    respond: () => wire(Schema.Array(ConnectedAppView), connectedAppsState),
  },
  {
    method: "DELETE",
    path: "/api/v1/workspaces/:workspaceId/connected-apps/:grantId",
    respond: ({ params }) => {
      connectedAppsState = Arr.filter(connectedAppsState, (g) => g.grantId !== params["grantId"]);
    },
  },
  {
    method: "GET",
    path: "/api/v1/me/preferences",
    respond: () => wire(AccountPreferences, preferencesState),
  },
  {
    method: "PATCH",
    path: "/api/v1/me/preferences",
    respond: ({ body }) => {
      const decoded = Schema.decodeOption(AccountPreferencesPatch)(body ?? {});
      if (Option.isNone(decoded)) return invalidBody();
      const patch = decoded.value;
      preferencesState = {
        ...preferencesState,
        locale: patch.locale === undefined ? preferencesState.locale : patch.locale,
        theme: patch.theme ?? preferencesState.theme,
        revision: preferencesState.revision + 1,
      };
      return wire(AccountPreferences, preferencesState);
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
      user: { id: btoa("demo-user-id"), name: "jana@novak.cz", displayName: "Jana Nováková" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    }),
  },
  {
    method: "POST",
    path: "/api/auth/passkey/verify-registration",
    respond: ({ body }) => {
      const input = Option.getOrUndefined(Schema.decodeUnknownOption(PasskeyRegistration)(body));
      if (input?.response === undefined)
        return status(400, { message: "Registration response is required" });
      const created: PasskeyItem = {
        id: `pk-${++seqCounter}`,
        name: input.name ?? "Passkey",
        createdAt: nowIso(),
        deviceType: "singleDevice",
      };
      passkeysState = [...passkeysState, created];
      return created;
    },
  },
  {
    method: "POST",
    path: "/api/auth/passkey/update-passkey",
    respond: ({ body }) => {
      const input = Option.getOrUndefined(Schema.decodeUnknownOption(PasskeyUpdate)(body));
      if (input !== undefined) {
        const { id, name } = input;
        passkeysState = Arr.map(passkeysState, (p) => (p.id === id ? { ...p, name } : p));
      }
      return { status: true };
    },
  },
  {
    method: "POST",
    path: "/api/auth/passkey/delete-passkey",
    respond: ({ body }) => {
      const id = Option.getOrUndefined(Schema.decodeUnknownOption(PasskeyDelete)(body))?.id;
      if (id !== undefined) passkeysState = Arr.filter(passkeysState, (p) => p.id !== id);
      return { status: true };
    },
  },
  { method: "GET", path: "/api/auth/list-sessions", respond: () => sessionsState },
  {
    method: "POST",
    path: "/api/auth/revoke-session",
    respond: ({ body }) => {
      const token = Option.getOrUndefined(Schema.decodeUnknownOption(SessionRevoke)(body))?.token;
      if (token === undefined) return status(400, { message: "Session token is required" });
      sessionsState = Arr.filter(sessionsState, (s) => s.token !== token);
      return { status: true };
    },
  },
  {
    method: "POST",
    path: "/api/auth/revoke-other-sessions",
    respond: () => {
      sessionsState = Arr.filter(sessionsState, (s) => s.id === demoCurrentSessionId);
      return { status: true };
    },
  },
  { method: "POST", path: "/api/auth/delete-user", respond: () => ({ status: true }) },
];
