import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { RenderedPath } from "../test/support";

const DEMO_WS = "novak-design";
const WEB_ROOT = resolve(import.meta.dirname, "..");
const renderForHydration = (path: string): RenderedPath =>
  JSON.parse(
    execFileSync("bun", [resolve(import.meta.dirname, "render.ts"), path], {
      cwd: WEB_ROOT,
      encoding: "utf8",
    }),
  );

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
      expect(consoleErrors, `console errors: ${consoleErrors.join("; ")}`).toEqual([]);
      expect(pageErrors, `page errors: ${pageErrors.join("; ")}`).toEqual([]);
    },
  };
};

// Guard so `bun test apps/web` (which scans *.spec.ts) does not invoke Playwright's test runner
// outside Node/Playwright; `bun run --cwd apps/web e2e` executes under Node where `Bun` is absent.
if (typeof Bun === "undefined") {
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
        await page.goto(path, { waitUntil: "domcontentloaded" });
        const root = page.locator(".kb-root");
        await expect(root).toBeVisible();
        await expect(page.locator("#kb-theme-vars")).toBeAttached();
        await expect(page.locator("#main")).toBeVisible();
        await expect(page).toHaveTitle(/Kvitbit/);
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
        await page.goto(path, { waitUntil: "domcontentloaded" });
        await expect(page.locator(".kb-root")).toBeVisible();
        await expect(page.locator("#kb-theme-vars")).toBeAttached();
        await expect(page.locator("#main")).toBeVisible();
        await expect(page).toHaveTitle(/Kvitbit/);

        if (testInfo.project.name === "desktop") {
          await expect(page.locator(".kb-sidebar")).toBeVisible();
        } else {
          await expect(page.locator(".kb-bottom-nav")).toBeVisible();
        }
      }

      errors.assertClean();
    });

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
      await expect(root).not.toHaveAttribute("data-theme", /.+/);

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
      const rendered = renderForHydration(path);
      const state = JSON.stringify({ flags: rendered.flags, state: rendered.state }).replaceAll(
        "<",
        "\\u003c",
      );
      await page.route(
        (url) => url.pathname === path,
        async (route) => {
          const response = await route.fetch();
          const html = (await response.text()).replace(
            '<div id="root"></div>',
            `<div id="root">${rendered.html}</div>
           <script type="application/json" id="kb-state">${state}</script>
           <script>window.kbServerControl = document.querySelector("#kb-locale")</script>`,
          );
          await route.fulfill({ response, body: html });
        },
      );
      await page.goto(path, { waitUntil: "domcontentloaded" });
      const locale = page.locator("#kb-locale");
      await expect(locale).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () => Reflect.get(window, "kbServerControl") === document.querySelector("#kb-locale"),
          ),
        )
        .toBe(true);
      await locale.selectOption("en");
      await expect(page.locator(".kb-root")).toHaveAttribute("lang", "en");
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      expect(
        await page.evaluate(
          () => Reflect.get(window, "kbServerControl") === document.querySelector("#kb-locale"),
        ),
      ).toBe(true);
      errors.assertClean();
    });

    test("a late share reply cannot replace the same route after remount", async ({ page }) => {
      const token = "demo-unpaid-czk";
      const sharePath = `/i/${token}`;
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.locator(".kb-landing")).toBeVisible();

      // Delay the first successful API response across two SPA navigations.
      let releaseOld: () => void = () => undefined;
      const release = new Promise<void>((resolve) => {
        releaseOld = resolve;
      });
      let receivedFirst: () => void = () => undefined;
      const received = new Promise<void>((resolve) => {
        receivedFirst = resolve;
      });
      let sentOld: () => void = () => undefined;
      const sent = new Promise<void>((resolve) => {
        sentOld = resolve;
      });
      let requestCount = 0;
      await page.route(
        (url) => url.pathname === `/api/v1/share/${token}`,
        async (route) => {
          const requestNumber = ++requestCount;
          const response = await route.fetch();
          const document = await response.json();
          if (requestNumber === 1) {
            receivedFirst();
            await release;
          }
          try {
            await route.fulfill({
              response,
              json: {
                ...document,
                number: requestNumber === 1 ? "Earlier invoice" : "Current invoice",
              },
            });
          } catch (failure) {
            if (requestNumber !== 1) throw failure;
            // Leaving the component may abort the old request before its reply is sent.
          } finally {
            if (requestNumber === 1) sentOld();
          }
        },
      );

      await page.evaluate((sharePath) => {
        for (const [href, label] of [
          [sharePath, "Open the share"],
          ["/legal/terms", "Open terms"],
        ] as const) {
          const anchor = document.createElement("a");
          anchor.href = href;
          anchor.textContent = label;
          document.body.appendChild(anchor);
        }
      }, sharePath);

      await page.getByRole("link", { name: "Open the share", exact: true }).click();
      await received;
      await page.getByRole("link", { name: "Open terms", exact: true }).click();
      await expect(page).toHaveURL(/\/legal\/terms$/);
      await page.getByRole("link", { name: "Open the share", exact: true }).click();
      await expect(page.getByRole("heading", { name: /Current invoice$/ })).toBeVisible();

      releaseOld();
      await sent;
      await expect(page.getByRole("heading", { name: /Current invoice$/ })).toBeVisible();
      await expect(page.getByRole("heading", { name: /Earlier invoice$/ })).toHaveCount(0);
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
  });
}
