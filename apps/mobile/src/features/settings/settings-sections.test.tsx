import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import {
  type Role,
  WorkspaceId,
  WorkspaceSlug,
  type WorkspaceSummary,
} from "@kvitbit/domain/contract";
import { PRESET_IDS } from "@kvitbit/ui-port/theme";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import type { ReactElement } from "react";
import { I18nProvider } from "../../i18n/i18n-provider";
import { ApiProvider } from "../../runtime/api-runtime";
import { SessionProvider } from "../../session/session-provider";
import { clientRoot } from "../../testing/client-root";
import { allText, hostTree } from "../../testing/element-tree";
import { eventually } from "../../testing/eventually";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import { TestProviders } from "../../testing/providers";
import { recordedOverlay } from "../../testing/recorded-overlay";
import { ThemeProvider } from "../../theme/theme-provider";
import { DEFAULT_PREFERENCE, type ThemePreference } from "../../theme/theme-state";
import { OverlayContextProvider } from "../../ui/overlay";
import { WorkspaceProvider } from "../../workspace/workspace-provider";
import { uiShim } from "../documents/test-ui-shim";

mock.module("expo-router", () => ({
  ...expoRouterStandIn(),
  router: {
    back: () => undefined,
    canGoBack: () => false,
    push: () => undefined,
    replace: () => undefined,
  },
}));

const realUi = { ...(await import("../../ui")) };

const { ApiKeysSection } = await import("./api-keys-section");
const { BrandingSection } = await import("./branding-section");
const { DangerZoneSection } = await import("./danger-zone-section");
const { IssuingEntitySection } = await import("./issuing-entity-section");
const { SettingsScreen } = await import("./settings-screen");

const TRAILING_SLASH = /\/$/;
const decodePreferences = Schema.decodeUnknownOption(
  Schema.Struct({
    locale: Schema.String.pipe(Schema.NullOr, Schema.optional),
    theme: Schema.optional(Schema.JsonObject),
  }),
);
const WORKSPACE_ID = WorkspaceId.make("0193a1a2-b3c4-7d5e-8f90-1234567890ab");

const makeWorkspace = (overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary => ({
  id: WORKSPACE_ID,
  slug: WorkspaceSlug.make("acme"),
  name: "Acme s.r.o.",
  role: "owner",
  memberCount: 2,
  taxRegime: "vat_payer",
  closed: false,
  ...overrides,
});

describe("SettingsScreen & static guards", () => {
  const wrap =
    (role: Role, closed = false) =>
    (node: ReactElement) => (
      <TestProviders locale="en">
        <SessionProvider origin="http://localhost">
          <ApiProvider token={null} origin="http://localhost">
            <WorkspaceProvider
              workspace={makeWorkspace({ role, closed })}
              workspaces={[makeWorkspace({ role, closed })]}
              reload={() => undefined}
            >
              {node}
            </WorkspaceProvider>
          </ApiProvider>
        </SessionProvider>
      </TestProviders>
    );

  test("renders not-found empty state for unknown settings section", () => {
    const tree = hostTree(<SettingsScreen sectionParam="does-not-exist" />, wrap("owner"));
    expect(allText(tree)).toContain("Settings section not found");
  });

  test("ApiKeysSection renders read-only banner for member role", () => {
    const tree = hostTree(<ApiKeysSection />, wrap("member"));
    expect(allText(tree)).toContain("Only owners and admins can change these settings.");
  });

  test("DangerZoneSection restricts non-owners", () => {
    const tree = hostTree(<DangerZoneSection />, wrap("admin"));
    expect(allText(tree)).toContain("Only the workspace owner can manage these actions.");
  });
});

describe("Settings sections wired to KvitbitApi", () => {
  const root = clientRoot({ keepFetch: true });
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  let lastIfMatch: string | null = null;
  let prefsRequested = false;

  beforeAll(() => {
    mock.module("../../ui", () => uiShim);
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const path = Str.replace(TRAILING_SLASH, "")(url.pathname);
        if (path === `/api/v1/workspaces/${WORKSPACE_ID}/branding` && req.method === "GET") {
          return Response.json({
            pdfTemplate: "classic",
            accentColor: "#1F5FAF",
            footerText: "Thank you",
            theme: null,
            resolvedTheme: null,
            logo: null,
            stamp: null,
            revision: 2,
          });
        }
        if (path === "/api/v1/me/preferences" && req.method === "GET") {
          prefsRequested = true;
          return Response.json({
            locale: "en",
            theme: {
              source: null,
              mode: "system",
              style: "elegant",
              contrast: "standard",
              dynamicColor: true,
            },
            resolvedTheme: null,
            revision: 1,
          });
        }
        if (path === "/api/v1/me/preferences" && req.method === "PATCH") {
          const body = Option.getOrUndefined(decodePreferences(await req.json()));
          return Response.json({
            locale: body?.locale ?? "en",
            theme: body?.theme ?? {
              source: null,
              mode: "system",
              style: "elegant",
              contrast: "standard",
              dynamicColor: true,
            },
            resolvedTheme: null,
            revision: 2,
          });
        }
        if (path === `/api/v1/workspaces/${WORKSPACE_ID}` && req.method === "GET") {
          return Response.json({
            id: WORKSPACE_ID,
            slug: "acme",
            name: "Acme s.r.o.",
            closed: false,
            revision: 3,
            issuingEntity: {
              name: "Acme s.r.o.",
              ico: "27082440",
              dic: "CZ27082440",
              address: { street: "Old 1", city: "Praha", postalCode: "11000", country: "CZ" },
              legalForm: "s.r.o.",
              registerEntry: "C 12345",
              email: "info@acme.cz",
              phone: null,
              web: null,
            },
            taxRegime: "vat_payer",
            taxRegimeHistory: [{ regime: "vat_payer", effectiveFrom: "2026-01-01" }],
            defaults: {
              currency: "CZK",
              language: "cs",
              dueDays: 14,
              paymentMethod: "bank_transfer",
              defaultNote: null,
              paymentRounding: "none",
              paymentTaxDocumentAutoSend: true,
              preferredSeriesByKind: {},
            },
            reminderPolicy: { enabled: true, proformas: false, offsetsDays: [3, 10, 30] },
            bankAccounts: [],
            branding: {
              pdfTemplate: "classic",
              accentColor: "#1F5FAF",
              footerText: null,
              theme: null,
              logo: null,
              stamp: null,
            },
          });
        }
        if (path === "/api/v1/registry/companies/27082440" && req.method === "GET") {
          return Response.json({
            ico: "27082440",
            name: "Acme Updated s.r.o.",
            address: { street: "New 99", city: "Praha", postalCode: "11000", country: "CZ" },
            dic: "CZ27082440",
            legalForm: "s.r.o.",
            registerEntry: "C 12345",
            terminatedOn: null,
          });
        }
        if (
          path === `/api/v1/workspaces/${WORKSPACE_ID}/issuing-entity` &&
          req.method === "PATCH"
        ) {
          lastIfMatch = req.headers.get("if-match");
          const body = Option.getOrNull(
            Schema.decodeUnknownOption(Schema.JsonObject)(await req.json()),
          );
          return Response.json({
            id: WORKSPACE_ID,
            slug: "acme",
            name: "Acme Updated s.r.o.",
            closed: false,
            revision: 4,
            issuingEntity: body,
            taxRegime: "vat_payer",
            taxRegimeHistory: [{ regime: "vat_payer", effectiveFrom: "2026-01-01" }],
            defaults: {
              currency: "CZK",
              language: "cs",
              dueDays: 14,
              paymentMethod: "bank_transfer",
              defaultNote: null,
              paymentRounding: "none",
              paymentTaxDocumentAutoSend: true,
              preferredSeriesByKind: {},
            },
            reminderPolicy: { enabled: true, proformas: false, offsetsDays: [3, 10, 30] },
            bankAccounts: [],
            branding: {
              pdfTemplate: "classic",
              accentColor: "#1F5FAF",
              footerText: null,
              theme: null,
              logo: null,
              stamp: null,
            },
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
    mock.module("../../ui", () => realUi);
  });

  test("BrandingSection renders all 6 theme presets and appearance + language controls", async () => {
    let latestPref: ThemePreference = DEFAULT_PREFERENCE;
    let latestLocale = "en";
    prefsRequested = false;
    const overlay = recordedOverlay();

    await root.render(
      <I18nProvider
        initialLocale="en"
        onLocaleChange={(l) => {
          latestLocale = l;
        }}
      >
        <ThemeProvider
          initialPreference={DEFAULT_PREFERENCE}
          onPreferenceChange={(p) => {
            latestPref = p;
          }}
        >
          <OverlayContextProvider value={overlay}>
            <ApiProvider token={null} origin={origin}>
              <WorkspaceProvider
                workspace={makeWorkspace()}
                workspaces={[makeWorkspace()]}
                reload={() => undefined}
              >
                <BrandingSection />
              </WorkspaceProvider>
            </ApiProvider>
          </OverlayContextProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    await Effect.runPromise(
      eventually(
        () => {
          const content = root.container().textContent ?? "";
          return prefsRequested && Str.includes("Graphite Atelier")(content);
        },
        () =>
          `prefsRequested=${prefsRequested} text=${Str.slice(0, 200)(root.container().textContent ?? "")}`,
      ),
    );
    expect(prefsRequested).toBe(true);
    {
      const content = root.container().textContent ?? "";
      expect(content).toContain("Graphite Atelier");
      expect(content).toContain("Banknote Emerald");
      expect(content).toContain("Ocean");
      expect(content).toContain("Plum");
      expect(content).toContain("Prague Ledger");
      expect(content).toContain("Pure Graphite");
    }
    // Let both initial useRemote responses finish decoding before unmounting ApiProvider.
    await Effect.runPromise(Effect.sleep("50 millis"));

    expect(PRESET_IDS).toHaveLength(6);
    const content = root.container().textContent ?? "";
    expect(content).toContain("Elegant");
    expect(content).toContain("Cozy");
    expect(content).toContain("System");
    expect(content).toContain("Light");
    expect(content).toContain("Dark");
    expect(content).toContain("Standard");
    expect(content).toContain("Medium");
    expect(content).toContain("High");
    expect(content).toContain("Use wallpaper colours");
    expect(content).toContain("Čeština");
    expect(content).toContain("English");
    expect(latestPref.style).toBe("elegant");
    expect(latestLocale).toBe("en");
  });

  test("IssuingEntitySection loads workspace from KvitbitApi and displays ARES refresh and save controls", async () => {
    const overlay = recordedOverlay();
    lastIfMatch = null;

    await root.render(
      <TestProviders locale="en" overlay={overlay}>
        <ApiProvider token={null} origin={origin}>
          <WorkspaceProvider
            workspace={makeWorkspace()}
            workspaces={[makeWorkspace()]}
            reload={() => undefined}
          >
            <IssuingEntitySection />
          </WorkspaceProvider>
        </ApiProvider>
      </TestProviders>,
    );

    await Effect.runPromise(
      eventually(() => {
        const content = root.container().textContent ?? "";
        return Str.includes("Refresh from ARES")(content) && Str.includes("Save changes")(content);
      }),
    );
    {
      const content = root.container().textContent ?? "";
      expect(content).toContain("Refresh from ARES");
      expect(content).toContain("Save changes");
    }
    await Effect.runPromise(Effect.sleep("50 millis"));

    expect(lastIfMatch).toBeNull();
  });
});
