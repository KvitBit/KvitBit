import { expect, type Page, test } from "@playwright/test";

const DEMO_WS = "novak-design";
const PREFS_STORAGE_KEY = "kvitbit.prefs";

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
        await page.goto(path, { waitUntil: "networkidle" });
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
        await page.goto(path, { waitUntil: "networkidle" });
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
      await page.goto(`/w/${DEMO_WS}`, { waitUntil: "networkidle" });

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
      await page.goto("/account/appearance", { waitUntil: "networkidle" });

      const root = page.locator(".kb-root");
      const styleSelect = page.locator("#kb-appearance-style");

      if ((await styleSelect.count()) > 0) {
        await styleSelect.selectOption("cozy");
        await expect(root).toHaveAttribute("data-style", "cozy");
        await page.reload({ waitUntil: "networkidle" });
        await expect(root).toHaveAttribute("data-style", "cozy");

        await styleSelect.selectOption("elegant");
        await expect(root).toHaveAttribute("data-style", "elegant");
      } else {
        // Fallback for scaffold states before the appearance form mounts on /account/appearance:
        // exercise the real localStorage prefs persistence and inline stylesheet regeneration.
        await page.evaluate((key) => {
          const current = JSON.parse(
            window.localStorage.getItem(key) ??
              JSON.stringify({
                locale: "cs",
                style: "elegant",
                mode: "system",
                contrast: "standard",
                theme: { _tag: "Preset", id: "graphite_atelier" },
              }),
          );
          window.localStorage.setItem(key, JSON.stringify({ ...current, style: "cozy" }));
        }, PREFS_STORAGE_KEY);
        await page.reload({ waitUntil: "networkidle" });
        await expect(root).toHaveAttribute("data-style", "cozy");

        await page.evaluate((key) => {
          const current = JSON.parse(window.localStorage.getItem(key) ?? "{}");
          window.localStorage.setItem(key, JSON.stringify({ ...current, style: "elegant" }));
        }, PREFS_STORAGE_KEY);
        await page.reload({ waitUntil: "networkidle" });
        await expect(root).toHaveAttribute("data-style", "elegant");
      }

      errors.assertClean();
    });
  });
}
