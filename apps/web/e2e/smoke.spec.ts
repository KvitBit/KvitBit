// @effect-diagnostics-next-line nodeBuiltinImport:off Playwright runs in Node and renders the fixture in Bun.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, type Page, test } from "@playwright/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

const appTitlePattern = /Kvitbit/;
const privacyAnchorPattern = /\/legal\/privacy#main$/;
const rootPathPattern = /\/$/;
const priceListPathPattern = /\/price-list$/;
const filteredPriceListPattern = /\/price-list\?text=UX&archived=1$/;
const retryLabelPattern = /Try again|Retry|Zkusit znovu/i;
const nonEmptyPattern = /.+/;
const termsPathPattern = /\/legal\/terms$/;
const currentInvoiceHeadingPattern = /Current invoice$/;
const earlierInvoiceHeadingPattern = /Earlier invoice$/;
const overdueLabelPattern = /^(Overdue|Po splatnosti)$/;

const DEMO_WS = "novak-design";
const paths = Effect.runSync(Path.Path.pipe(Effect.provide(Path.layer)));
const renderFixture = promisify(execFile);
const hydrationFixture = Schema.fromJsonString(
  Schema.Struct({ html: Schema.String, hydration: Schema.String }),
);
const renderForHydration = async (path: string) => {
  const { stdout } = await renderFixture(
    "bun",
    [paths.resolve(import.meta.dirname, "render.ts"), path],
    { cwd: paths.resolve(import.meta.dirname, ".."), encoding: "utf8" },
  );
  return Effect.runSync(Schema.decodeEffect(hydrationFixture)(stdout));
};

const attachErrorGuards = (page: Page) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });
  return {
    assertClean: () => {
      expect(consoleErrors, `console errors: ${Arr.join(consoleErrors, "; ")}`).toEqual([]);
      expect(pageErrors, `page errors: ${Arr.join(pageErrors, "; ")}`).toEqual([]);
    },
  };
};

// Guard so `bun test apps/web` (which scans *.spec.ts) does not invoke Playwright's test runner
// outside Node/Playwright; `bun run --cwd apps/web e2e` executes under Node where `Bun` is absent.
if (!("Bun" in globalThis)) {
  test.describe("web smoke journeys (demo mode)", () => {
    test("navigates public routes with clean rendering and zero errors", async ({ page }) => {
      const errors = attachErrorGuards(page);
      const publicPaths = [
        "/",
        "/legal/terms",
        "/legal/privacy",
        "/sign-in",
        "/sign-up",
        "/android",
      ];

      for (const path of publicPaths) {
        // biome-ignore lint/performance/noAwaitInLoops: Each assertion reads the current route in the same tab.
        await page.goto(path, { waitUntil: "domcontentloaded" });
        const root = page.locator(".kb-root");
        await expect(root).toBeVisible();
        await expect(page.locator("#kb-theme-vars")).toBeAttached();
        await expect(page.locator("#main")).toBeVisible();
        await expect(page).toHaveTitle(appTitlePattern);
      }

      errors.assertClean();
    });

    test("navigates workspace routes with responsive chrome and zero errors", async ({
      page,
    }, testInfo) => {
      const errors = attachErrorGuards(page);
      const workspacePaths = [
        `/w/${DEMO_WS}`,
        `/w/${DEMO_WS}/documents`,
        `/w/${DEMO_WS}/templates`,
        `/w/${DEMO_WS}/expenses`,
        `/w/${DEMO_WS}/contacts`,
        `/w/${DEMO_WS}/price-list`,
        `/w/${DEMO_WS}/reports/revenue?period=2026`,
        `/w/${DEMO_WS}/settings/issuing-entity`,
      ];

      for (const path of workspacePaths) {
        // biome-ignore lint/performance/noAwaitInLoops: Each assertion reads the current route in the same tab.
        await page.goto(path, { waitUntil: "domcontentloaded" });
        await expect(page.locator(".kb-root")).toBeVisible();
        await expect(page.locator("#kb-theme-vars")).toBeAttached();
        await expect(page.locator("#main")).toBeVisible();
        await expect(page).toHaveTitle(appTitlePattern);

        const chrome = testInfo.project.name === "desktop" ? ".kb-sidebar" : ".kb-bottom-nav";
        await expect(page.locator(chrome)).toBeVisible();
      }

      errors.assertClean();
    });

    test("settles SPA navigation with anchor focus, an announcement, and Back scroll", async ({
      page,
    }) => {
      const errors = attachErrorGuards(page);
      await page.goto("/");
      const privacy = page.locator('footer a[href^="/legal/privacy"]');
      await privacy.evaluate((link) => {
        link.setAttribute("href", "/legal/privacy#main");
        globalThis.document.body.dataset.navigationProbe = "same-document";
      });
      await privacy.scrollIntoViewIfNeeded();
      const originalScroll = await page.evaluate(() => window.scrollY);
      expect(originalScroll).toBeGreaterThan(0);
      await privacy.click();

      await expect(page).toHaveURL(privacyAnchorPattern);
      await expect(page.locator("#main")).toBeFocused();
      await expect(page.locator('body > div[aria-live="assertive"]')).toHaveText(appTitlePattern);
      await expect(page.locator("body")).toHaveAttribute("data-navigation-probe", "same-document");

      await page.goBack();
      await expect(page).toHaveURL(rootPathPattern);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(originalScroll);
      errors.assertClean();
    });

    test("applies a price-list search without remounting on input", async ({ page }) => {
      const errors = attachErrorGuards(page);
      await page.goto(`/w/${DEMO_WS}/price-list/`);
      await expect(page).toHaveURL(priceListPathPattern);
      const input = page.getByRole("searchbox");
      const archived = page.locator("#pricelist-include-archived");
      await archived.check();
      await input.pressSequentially("UX");
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("UX");
      await expect(archived).toBeChecked();
      await expect(page).toHaveURL(priceListPathPattern);

      await input.press("Enter");
      await expect(page).toHaveURL(filteredPriceListPattern);
      await expect(page.getByRole("cell", { name: "UX & produktový design" })).toBeVisible();
      await expect(archived).toBeChecked();

      await page.goBack();
      await expect(input).toHaveValue("");
      await page.goForward();
      await expect(input).toHaveValue("UX");
      await expect(archived).toBeChecked();
      errors.assertClean();
    });

    test("returns to a filtered Price List after signing in from a deep link", async ({ page }) => {
      const errors = attachErrorGuards(page);
      const destination = `/w/${DEMO_WS}/price-list?text=UX&archived=1`;
      let authenticated = false;
      await page.route("**/api/auth/get-session", (route) =>
        authenticated ? route.continue() : route.fulfill({ json: null }),
      );
      await page.route("**/api/auth/sign-in/email", async (route) => {
        const response = await route.fetch();
        authenticated = response.ok();
        await route.fulfill({ response });
      });

      await page.goto(destination);
      await expect(page).toHaveURL(
        (url) => url.pathname === "/sign-in" && url.searchParams.get("returnTo") === destination,
      );
      await page.locator("#auth-signin-email").fill("demo@example.com");
      await page.locator("#auth-signin-password").fill("example-password");
      await page.getByTestId("auth-signin-submit").click();

      await expect(page).toHaveURL(destination);
      await expect(page.getByRole("searchbox")).toHaveValue("UX");
      await expect(page.locator("#pricelist-include-archived")).toBeChecked();
      await expect(page.getByRole("cell", { name: "UX & produktový design" })).toBeVisible();
      errors.assertClean();
    });

    for (const [kind, callback, destination] of [
      ["default", "/sign-in?magic=complete", `/w/${DEMO_WS}`],
      ["explicit", `/w/${DEMO_WS}/documents?kind=invoice`, `/w/${DEMO_WS}/documents?kind=invoice`],
    ] as const) {
      test(`recovers the ${kind} magic-link arrival after membership lookup is unavailable`, async ({
        page,
      }) => {
        let failed = false;
        await page.route(
          (url) => url.pathname === "/api/v1/workspaces",
          async (route) => {
            if (route.request().method() !== "GET" || failed) return route.continue();
            failed = true;
            await route.fulfill({ status: 503, json: { _tag: "Unavailable" } });
          },
        );
        await page.goto(callback);
        await expect(page.getByRole("alert")).toBeVisible();
        await expect(page).toHaveURL(callback);
        await page.getByRole("button", { name: retryLabelPattern }).click();
        await expect(page).toHaveURL(destination);
        await expect(page.locator("#main h1")).toBeVisible();
        await expect(page.getByRole("alert")).toHaveCount(0);
      });
    }

    test("toggles light/dark colour mode and locale cleanly", async ({ page }) => {
      const errors = attachErrorGuards(page);
      await page.goto(`/w/${DEMO_WS}`, { waitUntil: "domcontentloaded" });

      const root = page.locator(".kb-root");
      const modeSelect = page.locator("#kb-mode");
      const localeSelect = page.locator("#kb-locale");

      await expect(modeSelect).toBeVisible();
      await modeSelect.selectOption("dark");
      await expect(root).toHaveAttribute("data-theme", "dark");

      await modeSelect.selectOption("light");
      await expect(root).toHaveAttribute("data-theme", "light");

      await modeSelect.selectOption("system");
      await expect(root).not.toHaveAttribute("data-theme", nonEmptyPattern);

      await expect(localeSelect).toBeVisible();
      await localeSelect.selectOption("en");
      await expect(root).toHaveAttribute("lang", "en");

      await localeSelect.selectOption("cs");
      await expect(root).toHaveAttribute("lang", "cs");

      errors.assertClean();
    });

    test("toggles Elegant and Cozy styles and persists across reload", async ({ page }) => {
      const errors = attachErrorGuards(page);
      await page.goto("/account/appearance", { waitUntil: "domcontentloaded" });

      const root = page.locator(".kb-root");
      const cozy = page.getByRole("button", { name: "Cozy", exact: true });
      const elegant = page.getByRole("button", { name: "Elegant", exact: true });

      await expect(cozy).toBeVisible();
      await cozy.click();
      await expect(root).toHaveAttribute("data-style", "cozy");
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(root).toHaveAttribute("data-style", "cozy");
      await expect(cozy).toHaveAttribute("aria-pressed", "true");

      await elegant.click();
      await expect(root).toHaveAttribute("data-style", "elegant");
      errors.assertClean();
    });

    test("hydrates server-rendered shell nodes and handles input through the browser entry", async ({
      page,
    }) => {
      const errors = attachErrorGuards(page);
      const path = `/w/${DEMO_WS}`;
      const rendered = await renderForHydration(path);
      const state = Str.replaceAll("<", "\\u003c")(rendered.hydration);
      await page.route(
        (url) => url.pathname === path,
        async (route) => {
          const response = await route.fetch();
          const html = Str.replace(
            '<div id="root"></div>',
            `<div id="root">${rendered.html}</div>
           <script type="application/json" id="kb-state">${state}</script>
           <script>window.kbServerControl = globalThis.document.querySelector("#kb-locale")</script>`,
          )(await response.text());
          await route.fulfill({ response, body: html });
        },
      );
      await page.goto(path, { waitUntil: "domcontentloaded" });
      const locale = page.locator("#kb-locale");
      await expect(locale).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              Reflect.get(globalThis, "kbServerControl") ===
              globalThis.document.querySelector("#kb-locale"),
          ),
        )
        .toBe(true);
      await locale.selectOption("en");
      await expect(page.locator(".kb-root")).toHaveAttribute("lang", "en");
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      expect(
        await page.evaluate(
          () =>
            Reflect.get(globalThis, "kbServerControl") ===
            globalThis.document.querySelector("#kb-locale"),
        ),
      ).toBe(true);
      errors.assertClean();
    });

    test("a late share reply cannot replace the same route after remount", async ({ page }) => {
      const token = "demo-unpaid-czk";
      const sharePath = `/i/${token}`;
      await page.addInitScript(
        ({ shareToken }) => {
          const transport = globalThis.fetch.bind(globalThis);
          let requests = 0;
          globalThis.fetch = Object.assign(
            async (input: RequestInfo | URL, init?: RequestInit) => {
              const request = input instanceof Request ? input : new Request(input, init);
              if (new URL(request.url).pathname !== `/api/v1/share/${shareToken}`) {
                return transport(input, init);
              }
              const current = ++requests;
              // This transport completes even if the page cancels the request.
              const response = await transport(new Request(request, { signal: null }));
              const invoice = await response.json();
              if (current === 1) {
                // @effect-diagnostics-next-line newPromise:off The browser callback is serialized and keeps its local resolver.
                await new Promise<void>((release) =>
                  Reflect.set(globalThis, "kbReleaseOldShare", release),
                );
                Reflect.set(globalThis, "kbOldShareReturned", true);
              }
              return Response.json({
                ...invoice,
                number: current === 1 ? "Earlier invoice" : "Current invoice",
              });
            },
            { preconnect: () => undefined },
          );
        },
        { shareToken: token },
      );
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.locator(".kb-landing")).toBeVisible();

      await page.evaluate((targetPath) => {
        for (const [href, label] of [
          [targetPath, "Open the share"],
          ["/legal/terms", "Open terms"],
        ] as const) {
          const anchor = globalThis.document.createElement("a");
          anchor.href = href;
          anchor.textContent = label;
          globalThis.document.body.appendChild(anchor);
        }
      }, sharePath);

      await page.getByRole("link", { name: "Open the share", exact: true }).click();
      await page.waitForFunction(() => Reflect.has(globalThis, "kbReleaseOldShare"));
      await page.getByRole("link", { name: "Open terms", exact: true }).click();
      await expect(page).toHaveURL(termsPathPattern);
      await page.getByRole("link", { name: "Open the share", exact: true }).click();
      await expect(page.getByRole("heading", { name: currentInvoiceHeadingPattern })).toBeVisible();

      await page.evaluate(() => Reflect.get(globalThis, "kbReleaseOldShare")());
      await page.waitForFunction(() => Reflect.get(globalThis, "kbOldShareReturned") === true);
      await expect(page.getByRole("heading", { name: currentInvoiceHeadingPattern })).toBeVisible();
      await expect(page.getByRole("heading", { name: earlierInvoiceHeadingPattern })).toHaveCount(
        0,
      );
    });

    test("follows the mobile app link as a native document navigation", async ({ page }) => {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      const native = page.waitForRequest(
        (request) => request.isNavigationRequest() && new URL(request.url()).pathname === "/app/",
      );
      await page.locator('a[href="/app/"]').first().click();
      await native;
      await expect(page.getByText("Mobile app mount")).toBeVisible();
    });

    test("downloads a shared PDF without navigating the web shell", async ({ page }) => {
      const token = "demo-unpaid-czk";
      await page.goto(`/i/${token}`, { waitUntil: "domcontentloaded" });
      const pdf = page.locator('a[href*="/pdf?"]');
      await expect(pdf).toBeVisible();
      const started = page.waitForEvent("download");
      await pdf.click();
      const download = await started;
      expect(await download.failure()).toBeNull();
      expect(download.suggestedFilename()).toBe("invoice.pdf");
      await expect(page).toHaveURL(new RegExp(`/i/${token}$`));
    });

    test("updates an open share when its due date passes at UTC midnight", async ({ page }) => {
      const errors = attachErrorGuards(page);
      let documentRequests = 0;
      page.on("request", (request) => {
        if (request.resourceType() === "document") documentRequests += 1;
      });
      await page.clock.install({ time: "2026-11-24T23:59:30.000Z" });
      await page.goto("/i/demo-unpaid-czk");
      await expect(page.locator('a[href*="/pdf?"]')).toBeVisible();
      const overdue = page.locator("#main").getByText(overdueLabelPattern);
      await expect(overdue).toHaveCount(0);

      await page.clock.fastForward(31_000);
      await expect(overdue).toBeVisible();
      expect(documentRequests).toBe(1);
      errors.assertClean();
    });

    test("refreshes an open share on visibility change when the midnight timer has not run", async ({
      page,
    }) => {
      await page.clock.install({ time: "2026-11-24T23:59:30.000Z" });
      await page.goto("/i/demo-unpaid-czk");
      await expect(page.locator('a[href*="/pdf?"]')).toBeVisible();
      const overdue = page.locator("#main").getByText(overdueLabelPattern);
      let reloaded = false;
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) reloaded = true;
      });

      // Move wall time past midnight without advancing the pending timer.
      await page.clock.setSystemTime("2026-11-25T00:00:01.000Z");
      await expect(overdue).toHaveCount(0);
      await page.evaluate(() => globalThis.document.dispatchEvent(new Event("visibilitychange")));
      await expect(overdue).toBeVisible();
      expect(reloaded).toBe(false);
    });
  });
}
