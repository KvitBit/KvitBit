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

    test("sign-in method selector stays single-line in English and Czech across styles", async ({
      page,
    }) => {
      const errors = attachErrorGuards(page);
      const cases = [
        {
          locale: "en",
          labels: ["Password", "Email link", "Passkey"],
          passkeyCta: "Sign in with a passkey",
        },
        {
          locale: "cs",
          labels: ["Heslo", "Odkaz e-mailem", "Přístupový klíč"],
          passkeyCta: "Přihlásit se přístupovým klíčem",
        },
      ] as const;

      await page.goto("/sign-in", { waitUntil: "domcontentloaded" });

      for (const style of ["elegant", "cozy"] as const) {
        for (const { locale, labels, passkeyCta } of cases) {
          await page.evaluate(
            ({ loc, sty }) => {
              window.localStorage.setItem(
                "kvitbit.prefs",
                JSON.stringify({
                  locale: loc,
                  style: sty,
                  mode: "system",
                  contrast: "standard",
                  theme: { _tag: "Preset", id: "graphite_atelier" },
                }),
              );
            },
            { loc: locale, sty: style },
          );
          await page.reload({ waitUntil: "domcontentloaded" });
          await page.evaluate(() => document.fonts.ready);
          await expect(page.locator(".kb-root")).toHaveAttribute("lang", locale);
          await expect(page.locator(".kb-root")).toHaveAttribute("data-style", style);

          const segmented = page.locator(".kb-auth-form .kb-segmented");
          const buttons = segmented.locator("button");
          await expect(buttons).toHaveText([...labels]);

          const layout = await segmented.evaluate((el) => {
            const groupRect = el.getBoundingClientRect();
            const btns = [...el.querySelectorAll("button")];
            return {
              groupRight: groupRect.right,
              lastBtnRight: btns.at(-1)?.getBoundingClientRect().right ?? 0,
              items: btns.map((btn) => {
                const range = document.createRange();
                range.selectNodeContents(btn);
                const lineCount = range.getClientRects().length;
                return {
                  text: btn.textContent?.trim() ?? "",
                  lineCount,
                  overflowX: btn.scrollWidth > btn.clientWidth + 1,
                };
              }),
            };
          });

          for (const item of layout.items) {
            expect(item.lineCount, `${style}/${locale} "${item.text}" wrapped`).toBe(1);
            expect(item.overflowX, `${style}/${locale} "${item.text}" overflowed`).toBe(false);
          }
          expect(Math.abs(layout.groupRight - layout.lastBtnRight)).toBeLessThanOrEqual(2);

          await buttons.nth(2).click();
          await expect(page.getByTestId("auth-passkey-btn")).toHaveText(passkeyCta);
        }
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

    test("settles SPA navigation with anchor focus, an announcement, and Back scroll", async ({
      page,
    }) => {
      const errors = attachErrorGuards(page);
      await page.goto("/");
      const privacy = page.locator('footer a[href^="/legal/privacy"]');
      await privacy.evaluate((link) => {
        link.setAttribute("href", "/legal/privacy#main");
        document.body.dataset.navigationProbe = "same-document";
      });
      await privacy.scrollIntoViewIfNeeded();
      const originalScroll = await page.evaluate(() => window.scrollY);
      expect(originalScroll).toBeGreaterThan(0);
      await privacy.click();

      await expect(page).toHaveURL(/\/legal\/privacy#main$/);
      await expect(page.locator("#main")).toBeFocused();
      await expect(page.locator('body > div[aria-live="assertive"]')).toHaveText(/Kvitbit/);
      await expect(page.locator("body")).toHaveAttribute("data-navigation-probe", "same-document");

      await page.goBack();
      await expect(page).toHaveURL(/\/$/);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(originalScroll);
      errors.assertClean();
    });

    test("applies a price-list search without remounting on input", async ({ page }) => {
      const errors = attachErrorGuards(page);
      await page.goto(`/w/${DEMO_WS}/price-list/`);
      await expect(page).toHaveURL(/\/price-list$/);
      const input = page.getByRole("searchbox");
      const archived = page.locator("#pricelist-include-archived");
      await archived.check();
      await input.pressSequentially("UX");
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("UX");
      await expect(archived).toBeChecked();
      await expect(page).toHaveURL(/\/price-list$/);

      await input.press("Enter");
      await expect(page).toHaveURL(/\/price-list\?text=UX&archived=1$/);
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
        await page.getByRole("button", { name: /Try again|Retry|Zkusit znovu/i }).click();
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
      await page.addInitScript(
        ({ token }) => {
          const transport = window.fetch.bind(window);
          let requests = 0;
          window.fetch = Object.assign(
            async (input: RequestInfo | URL, init?: RequestInit) => {
              const request = input instanceof Request ? input : new Request(input, init);
              if (new URL(request.url).pathname !== `/api/v1/share/${token}`) {
                return transport(input, init);
              }
              const current = ++requests;
              // This transport completes even if the page cancels the request.
              const response = await transport(new Request(request, { signal: null }));
              const invoice = await response.json();
              if (current === 1) {
                await new Promise<void>((release) =>
                  Reflect.set(window, "kbReleaseOldShare", release),
                );
                Reflect.set(window, "kbOldShareReturned", true);
              }
              return Response.json({
                ...invoice,
                number: current === 1 ? "Earlier invoice" : "Current invoice",
              });
            },
            { preconnect: () => undefined },
          );
        },
        { token },
      );
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.locator(".kb-landing")).toBeVisible();

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
      await page.waitForFunction(
        () => typeof Reflect.get(window, "kbReleaseOldShare") === "function",
      );
      await page.getByRole("link", { name: "Open terms", exact: true }).click();
      await expect(page).toHaveURL(/\/legal\/terms$/);
      await page.getByRole("link", { name: "Open the share", exact: true }).click();
      await expect(page.getByRole("heading", { name: /Current invoice$/ })).toBeVisible();

      await page.evaluate(() => Reflect.get(window, "kbReleaseOldShare")());
      await page.waitForFunction(() => Reflect.get(window, "kbOldShareReturned") === true);
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

    test("updates an open share when its due date passes at UTC midnight", async ({ page }) => {
      const errors = attachErrorGuards(page);
      let documentRequests = 0;
      page.on("request", (request) => {
        if (request.resourceType() === "document") documentRequests += 1;
      });
      await page.clock.install({ time: new Date("2026-11-24T23:59:30.000Z") });
      await page.goto("/i/demo-unpaid-czk");
      await expect(page.locator('a[href*="/pdf?"]')).toBeVisible();
      const overdue = page.locator("#main").getByText(/^(Overdue|Po splatnosti)$/);
      await expect(overdue).toHaveCount(0);

      await page.clock.fastForward(31_000);
      await expect(overdue).toBeVisible();
      expect(documentRequests).toBe(1);
      errors.assertClean();
    });

    test("refreshes an open share on visibility change when the midnight timer has not run", async ({
      page,
    }) => {
      await page.clock.install({ time: new Date("2026-11-24T23:59:30.000Z") });
      await page.goto("/i/demo-unpaid-czk");
      await expect(page.locator('a[href*="/pdf?"]')).toBeVisible();
      const overdue = page.locator("#main").getByText(/^(Overdue|Po splatnosti)$/);
      let reloaded = false;
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) reloaded = true;
      });

      // Move wall time past midnight without advancing the pending timer.
      await page.clock.setSystemTime(new Date("2026-11-25T00:00:01.000Z"));
      await expect(overdue).toHaveCount(0);
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await expect(overdue).toBeVisible();
      expect(reloaded).toBe(false);
    });
  });
}
