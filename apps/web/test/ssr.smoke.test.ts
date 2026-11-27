/**
 * Tier 2 SSR / hydration smoke checks for every major route group in both Czech (`cs`) and
 * English (`en`). Asserts structural and contract invariants rather than stub placeholder copy so
 * the suite stays valid both on the base scaffold and after all page groups merge.
 */
import { describe, expect, test } from "bun:test";
import { I18n } from "@kvitbit/ui-port";
import type { Locale } from "../src/app/prefs";
import { DEMO_USER, DEMO_WORKSPACE, demoId } from "../src/demo/shell";
import { anonymous, renderPath, signedIn, WS } from "./support";

const LOCALES = I18n.LOCALES;

interface RouteCase {
  readonly name: string;
  readonly path: string;
  readonly expectedChrome: "public" | "workspace";
}

const ROUTE_GROUPS: ReadonlyArray<RouteCase> = [
  { name: "landing", path: "/", expectedChrome: "public" },
  { name: "legal terms", path: "/legal/terms", expectedChrome: "public" },
  { name: "legal privacy", path: "/legal/privacy", expectedChrome: "public" },
  { name: "sign-in", path: "/sign-in", expectedChrome: "public" },
  { name: "sign-up", path: "/sign-up", expectedChrome: "public" },
  { name: "android", path: "/android", expectedChrome: "public" },
  { name: "share", path: "/i/v1.demo-share-token", expectedChrome: "public" },
  { name: "consent", path: "/oauth/consent?consent_id=demo-consent", expectedChrome: "public" },
  { name: "invitation", path: "/invite/demo-invite-token", expectedChrome: "public" },
  { name: "onboarding", path: "/onboarding", expectedChrome: "public" },
  { name: "dashboard", path: `/w/${WS}`, expectedChrome: "workspace" },
  { name: "documents", path: `/w/${WS}/documents`, expectedChrome: "workspace" },
  { name: "document new", path: `/w/${WS}/documents/new/invoice`, expectedChrome: "workspace" },
  {
    name: "document detail",
    path: `/w/${WS}/documents/${demoId(200)}`,
    expectedChrome: "workspace",
  },
  { name: "templates", path: `/w/${WS}/templates`, expectedChrome: "workspace" },
  { name: "expenses", path: `/w/${WS}/expenses`, expectedChrome: "workspace" },
  { name: "contacts", path: `/w/${WS}/contacts`, expectedChrome: "workspace" },
  { name: "price-list", path: `/w/${WS}/price-list`, expectedChrome: "workspace" },
  { name: "reports", path: `/w/${WS}/reports/revenue?period=2026`, expectedChrome: "workspace" },
  { name: "settings", path: `/w/${WS}/settings/issuing-entity`, expectedChrome: "workspace" },
  { name: "account", path: "/account/profile", expectedChrome: "public" },
  { name: "404", path: "/no/such/page", expectedChrome: "public" },
];

const assertCleanSsr = (
  html: string,
  title: string,
  locale: Locale,
  chrome: RouteCase["expectedChrome"],
) => {
  expect(html).toContain('class="kb-root"');
  expect(html).toContain(`lang="${locale}"`);
  expect(html).toContain('id="kb-theme-vars"');
  expect(html).toContain("--md-sys-color-surface");
  expect(html).toContain("--md-sys-color-primary");
  expect(html).toContain('id="main"');
  expect(html).not.toContain("[object Object]");
  expect(html).not.toContain(">undefined<");
  expect(title.trim().length).toBeGreaterThan(0);
  expect(title).toContain("Kvitbit");
  if (chrome === "workspace") {
    expect(html).toContain('data-slot="app"');
    expect(html).toContain('data-slot="sidebar"');
  } else {
    expect(html).toContain('data-slot="public"');
  }
};

describe("server render smoke (all route groups × cs/en)", () => {
  test("discloses cookieless product analytics in Czech and English", async () => {
    const { html: cs } = await renderPath("/legal/privacy", { locale: "cs", session: anonymous });
    const { html: en } = await renderPath("/legal/privacy", { locale: "en", session: anonymous });

    expect(cs).toContain("PostHog EU (Frankfurt nad Mohanem, Německo)");
    expect(cs).toContain("Analytika bez souborů cookie");
    expect(cs).toContain("Nepoužíváme reklamní ani sledovací soubory cookie.");
    expect(cs).toContain("Obsah faktur ani osobní údaje vašich zákazníků");
    expect(en).toContain("PostHog EU (Frankfurt, Germany)");
    expect(en).toContain("Cookieless analytics");
    expect(en).toContain("We do not use advertising or tracking cookies.");
    expect(en).toContain("We do not send invoice contents");
    expect(en).toContain("personal data to PostHog.");
  });

  test("covers all 22 route cases across both locales", () => {
    expect(ROUTE_GROUPS.length).toBe(22);
    expect(LOCALES).toEqual(["cs", "en"]);
  });

  for (const locale of LOCALES) {
    describe(`locale=${locale}`, () => {
      for (const entry of ROUTE_GROUPS) {
        test(`renders ${entry.name} (${entry.path})`, async () => {
          const { html, title } = await renderPath(entry.path, { locale, session: signedIn });
          assertCleanSsr(html, title, locale, entry.expectedChrome);
        });
      }
    });
  }

  test("anonymous viewer of a workspace route redirects to public chrome (sign-in)", async () => {
    for (const locale of LOCALES) {
      const { html, title } = await renderPath(`/w/${WS}/documents`, {
        locale,
        session: anonymous,
      });
      assertCleanSsr(html, title, locale, "public");
      expect(html).not.toContain('data-slot="sidebar"');
    }
  });

  test("anonymous viewer of an account route redirects to public chrome (sign-in)", async () => {
    const { html, title } = await renderPath("/account/profile", {
      locale: "en",
      session: anonymous,
    });
    assertCleanSsr(html, title, "en", "public");
  });

  test("signed-in non-member of a workspace renders public error chrome (no_access)", async () => {
    const { html, title } = await renderPath("/w/foreign-workspace/documents", {
      locale: "cs",
      session: {
        _tag: "SignedIn",
        user: { ...DEMO_USER },
        workspaces: [DEMO_WORKSPACE],
      },
    });
    assertCleanSsr(html, title, "cs", "public");
    expect(html).not.toContain('data-slot="sidebar"');
  });
});
