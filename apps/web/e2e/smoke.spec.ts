import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, type Locator, type Page, test } from "@playwright/test";
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

const selectUiOption = async (selectRoot: Locator, value: string) => {
  await selectRoot.locator("ui-select-trigger button").click();
  await selectRoot.locator(`ui-select-item[value="${value}"]`).click();
};

const expectFilledSegments = async (
  group: Locator,
  placement: "stretched" | "inline",
  equalWidths = false,
) => {
  await expect(group).toBeVisible();
  await group.page().evaluate(() => document.fonts.ready.then(() => undefined));
  const layout = await group.evaluate((control) => {
    const bounds = control.getBoundingClientRect();
    const container = control.closest(".kb-card__title") ?? control.parentElement;
    const buttons = [...control.querySelectorAll("ui-segmented-control-item")].map((button) => {
      const box = button.getBoundingClientRect();
      const label = document.createRange();
      label.selectNodeContents(button);
      const text = label.getClientRects().length > 0 ? label.getBoundingClientRect() : box;
      return {
        width: box.width,
        labelFits: text.left >= box.left - 0.5 && text.right <= box.right + 0.5,
        lineCount: label.getClientRects().length,
        horizontalOffset: (text.left + text.right - box.left - box.right) / 2,
        verticalOffset: (text.top + text.bottom - box.top - box.bottom) / 2,
      };
    });
    const buttonWidth = buttons.reduce((total, button) => total + button.width, 0);
    return {
      buttons,
      containerSpace: (container?.clientWidth ?? 0) - bounds.width,
      unfilledWidth: control.clientWidth - buttonWidth,
      overflow: Math.max(
        -bounds.left,
        bounds.right - document.documentElement.clientWidth,
        control.scrollWidth - control.clientWidth,
      ),
    };
  });
  expect(layout.buttons.length).toBeGreaterThan(1);
  expect(Math.abs(layout.unfilledWidth), "unfilled width inside the selector").toBeLessThan(1);
  expect(layout.overflow, "horizontal overflow").toBeLessThan(1);
  if (placement === "stretched") {
    expect(Math.abs(layout.containerSpace), "space in the container").toBeLessThan(1);
  } else {
    expect(layout.containerSpace, "space left for other row items").toBeGreaterThan(1);
  }
  if (equalWidths) {
    const widths = layout.buttons.map((button) => button.width);
    expect(Math.max(...widths) - Math.min(...widths), "option width difference").toBeLessThan(2);
  }
  for (const button of layout.buttons) {
    expect(button.labelFits, "label fits inside its button").toBe(true);
    expect(Math.abs(button.horizontalOffset), "horizontal label alignment").toBeLessThan(2);
    expect(Math.abs(button.verticalOffset), "vertical label alignment").toBeLessThan(2);
  }
  return layout.buttons;
};

// Guard so `bun test apps/web` (which scans *.spec.ts) does not invoke Playwright's test runner
// outside Node/Playwright; `bun run --cwd apps/web e2e` executes under Node where `Bun` is absent.
if (typeof Bun === "undefined") {
  for (const locale of ["en", "cs"]) {
    test.describe(`segmented controls in ${locale}`, () => {
      test.use({ locale });

      test("fill their containers in forms", async ({ page }) => {
        const forms = [
          ["/sign-up", 1],
          ["/sign-in", 1],
          ["/account/profile", 1],
          ["/account/appearance", 3],
          ["/oauth/consent?consent_id=demo", 1],
        ] as const;

        for (const [path, count] of forms) {
          await test.step(path, async () => {
            await page.goto(path);
            await expect(page.locator(".kb-root")).toHaveAttribute("lang", locale);
            const groups = page.locator(".kb-segmented");
            await expect(groups).toHaveCount(count);
            for (const group of await groups.all()) {
              await expectFilledSegments(group, "stretched", path === "/sign-up");
            }
          });
        }

        await page.goto(`/w/${DEMO_WS}/settings/api-keys`);
        await page.getByRole("button", { name: /^(Create API key|Vytvořit API klíč)$/ }).click();
        await expectFilledSegments(page.locator(".kb-segmented"), "stretched");
      });

      test("keep inline controls compact and fill the export dialog selector", async ({ page }) => {
        await page.goto("/i/demo-unpaid-czk");
        await expect(page.locator(".kb-root")).toHaveAttribute("lang", locale);
        await expectFilledSegments(page.locator(".kb-segmented"), "inline");

        await page.goto(`/w/${DEMO_WS}/settings/branding`);
        await expectFilledSegments(page.locator(".kb-segmented"), "inline");

        await page.goto(`/w/${DEMO_WS}/expenses/new?mode=edit`);
        await expectFilledSegments(page.locator(".kb-field > .kb-segmented"), "stretched");
        await expectFilledSegments(page.locator(".kb-spread > .kb-segmented"), "inline");

        await page.goto(`/w/${DEMO_WS}/reports/revenue?period=2026`);
        await expectFilledSegments(page.locator(".kb-report-controls .kb-segmented"), "inline");
        await page.getByRole("button", { name: /^(Export|Exportovat)$/ }).click();
        await expectFilledSegments(page.getByRole("dialog").locator(".kb-segmented"), "stretched");
      });
    });
  }

  test.describe("segmented controls in narrow appearance fields", () => {
    test.use({ locale: "cs" });

    test("center wrapped Czech labels and keep single words intact", async ({ page }) => {
      await page.goto("/account/appearance");
      const mode = page.getByRole("radiogroup", { name: "Režim", exact: true });
      const contrast = page.getByRole("radiogroup", { name: "Kontrast", exact: true });
      // Exercise the settings grid's minimum track width in both viewport profiles.
      const grid = page.locator(".kb-form-grid").filter({ has: mode });
      await grid.evaluate((element) => {
        element.style.gridTemplateColumns = "repeat(auto-fit, 220px)";
      });

      const modes = await expectFilledSegments(mode, "stretched");
      expect(modes.some((button) => button.lineCount > 1)).toBe(true);
      const contrasts = await expectFilledSegments(contrast, "stretched");
      expect(contrasts.every((button) => button.lineCount === 1)).toBe(true);
    });
  });

  test.describe("web smoke journeys (demo mode)", () => {
    test("sends only cookieless pageviews after a single startup config request", async ({
      page,
    }) => {
      const host = "https://eu.i.posthog.com";
      let configRequests = 0;
      const uploads: { event: string; properties: Record<string, unknown> }[] = [];
      // Exercise actual ingestion while keeping PostHog's bot filter enabled in production.
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        Object.defineProperty(navigator, "userAgentData", { get: () => undefined });
      });
      await page.route("**/api/v1/config", async (route) => {
        configRequests += 1;
        const response = await route.fetch();
        await route.fulfill({
          response,
          json: {
            ...(await response.json()),
            analytics: { posthog: { apiKey: "phc_smoke", host } },
          },
        });
      });
      await page.route(`${host}/**`, async (route) => {
        const request = route.request();
        if (request.method() === "POST") {
          const data = request.postDataBuffer();
          if (data === null) throw new Error("PostHog request has no body");
          const formData = new URLSearchParams(data.toString()).get("data");
          const body =
            data[0] === 0x1f
              ? gunzipSync(data).toString()
              : formData
                ? Buffer.from(formData, "base64").toString()
                : data.toString();
          const payload = JSON.parse(body);
          uploads.push(...(payload.batch ?? [payload]));
        }
        await route.fulfill({
          json: { status: 1 },
          headers: { "access-control-allow-origin": "*" },
        });
      });

      await page.goto("/?email=private@example.test#private");
      await expect.poll(() => uploads.length).toBe(1);
      await page.locator('a[href="/legal/privacy"]').first().click();
      await expect.poll(() => uploads.length).toBe(2);
      expect(configRequests).toBe(1);

      const origin = new URL(page.url()).origin;
      expect(uploads.map(({ event, properties }) => ({ event, properties }))).toEqual(
        ["/", "/legal/privacy"].map((path) => ({
          event: "$pageview",
          properties: {
            $current_url: origin + path,
            $pathname: path,
            token: "phc_smoke",
            distinct_id: "$posthog_cookieless",
            $cookieless_mode: true,
            $process_person_profile: false,
            $geoip_disable: true,
          },
        })),
      );
      expect(await page.context().cookies()).toEqual([]);
      expect(
        await page.evaluate(() =>
          [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((key) =>
            /posthog|^ph_/i.test(key),
          ),
        ),
      ).toEqual([]);
    });

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
          const buttons = segmented.locator("ui-segmented-control-item");
          await expect(buttons).toHaveText([...labels]);

          const layout = await segmented.evaluate((el) => {
            const groupRect = el.getBoundingClientRect();
            const btns = [...el.querySelectorAll("ui-segmented-control-item")];
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

    test("onboarding numbering step groups each series with its pattern, starting number, and preview", async ({
      page,
    }, testInfo) => {
      const errors = attachErrorGuards(page);

      for (const locale of ["en", "cs"] as const) {
        await page.goto("/onboarding?step=4", { waitUntil: "domcontentloaded" });
        await page.evaluate((loc) => {
          window.localStorage.setItem(
            "kvitbit.prefs",
            JSON.stringify({
              locale: loc,
              style: "elegant",
              mode: "dark",
              contrast: "standard",
              theme: { _tag: "Preset", id: "graphite_atelier" },
            }),
          );
        }, locale);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.evaluate(() => document.fonts.ready);
        await expect(page.locator(".kb-root")).toHaveAttribute("lang", locale);

        const ledger = page.locator(".kb-series-ledger");
        const rows = ledger.locator(".kb-series-row");
        await expect(rows).toHaveCount(3);

        const geometry = await page.evaluate(() => {
          const card = document.querySelector(".kb-onboarding .kb-card");
          const defaults = document.querySelector(".kb-onboarding-defaults");
          const rowEls = [...document.querySelectorAll(".kb-series-row")];
          const cardBox = card?.getBoundingClientRect();
          const defaultsBox = defaults?.getBoundingClientRect();
          const ledgerBox = document.querySelector(".kb-series-ledger")?.getBoundingClientRect();
          return {
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            defaultsBelowLedger:
              defaultsBox !== undefined &&
              ledgerBox !== undefined &&
              defaultsBox.top >= ledgerBox.bottom,
            rows: rowEls.map((row) => {
              const title = row.querySelector(".kb-series-row__title")?.getBoundingClientRect();
              const pattern = row
                .querySelector('input[id^="onb-pattern-"]')
                ?.getBoundingClientRect();
              const start = row.querySelector('input[id^="onb-start-"]')?.getBoundingClientRect();
              const preview = row.querySelector(".kb-series-row__preview")?.getBoundingClientRect();
              const box = row.getBoundingClientRect();
              return {
                top: box.top,
                bottom: box.bottom,
                fitsCard:
                  cardBox !== undefined &&
                  box.left >= cardBox.left - 1 &&
                  box.right <= cardBox.right + 1,
                sameDesktopLine:
                  title !== undefined &&
                  pattern !== undefined &&
                  start !== undefined &&
                  preview !== undefined &&
                  Math.abs(pattern.top - start.top) <= 2 &&
                  Math.abs((title.top + title.bottom) / 2 - (pattern.top + pattern.bottom) / 2) <=
                    16 &&
                  Math.abs((preview.top + preview.bottom) / 2 - (start.top + start.bottom) / 2) <=
                    16,
                patternAndStartAligned:
                  pattern !== undefined &&
                  start !== undefined &&
                  Math.abs(pattern.top - start.top) <= 2 &&
                  start.left >= pattern.right,
              };
            }),
          };
        });

        expect(geometry.overflow, `${locale} page overflow`).toBeLessThanOrEqual(1);
        expect(geometry.defaultsBelowLedger, `${locale} defaults below series ledger`).toBe(true);
        for (let i = 0; i < geometry.rows.length; i += 1) {
          const row = geometry.rows[i];
          if (row === undefined) throw new Error("Missing row geometry");
          expect(row.fitsCard, `${locale} row ${i} fits card`).toBe(true);
          expect(row.patternAndStartAligned, `${locale} row ${i} pattern and start paired`).toBe(
            true,
          );
          if (testInfo.project.name === "desktop") {
            expect(row.sameDesktopLine, `${locale} row ${i} single horizontal ledger row`).toBe(
              true,
            );
          }
          const prev = geometry.rows[i - 1];
          if (prev !== undefined) {
            expect(row.top, `${locale} row ${i} below previous row`).toBeGreaterThanOrEqual(
              prev.bottom - 1,
            );
          }
        }
      }

      // Live per-series preview updates independently and flags invalid entries inline.
      await page.locator("#onb-pattern-proforma").fill("PRO-YY-NNN");
      await page.locator("#onb-start-proforma").fill("15");
      await expect(page.locator("#onb-series-preview-proforma")).toContainText("PRO-26-015");
      await expect(page.locator("#onb-series-preview-proforma")).toContainText("PRO-26-016");
      await expect(page.locator("#onb-series-preview-invoice")).toContainText("2026-0001");

      await page.locator("#onb-start-credit_note").fill("0");
      await expect(page.locator("#onb-start-credit_note")).toHaveAttribute("aria-invalid", "true");
      await expect(
        page.locator("#onb-series-preview-credit_note .kb-series-row__error"),
      ).toBeVisible();

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
      await expect(
        page.locator('body > div[aria-live="assertive"]:not([data-ui-sdk-announcer])'),
      ).toHaveText(/Kvitbit/);
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
        await expect(page.locator("#main").getByRole("alert")).toBeVisible();
        await expect(page).toHaveURL(callback);
        await page.getByRole("button", { name: /Try again|Retry|Zkusit znovu/i }).click();
        await expect(page).toHaveURL(destination);
        await expect(page.locator("#main h1")).toBeVisible();
        await expect(page.locator("#main").getByRole("alert")).toHaveCount(0);
      });
    }

    test("toggles light/dark colour mode and locale cleanly", async ({ page }) => {
      const errors = attachErrorGuards(page);
      await page.goto(`/w/${DEMO_WS}`, { waitUntil: "domcontentloaded" });

      const root = page.locator(".kb-root");
      const modeSelect = page.locator("#kb-mode");
      const localeSelect = page.locator("#kb-locale");

      await expect(modeSelect).toBeVisible();
      await selectUiOption(modeSelect, "dark");
      await expect(root).toHaveAttribute("data-theme", "dark");

      await selectUiOption(modeSelect, "light");
      await expect(root).toHaveAttribute("data-theme", "light");

      await selectUiOption(modeSelect, "system");
      await expect(root).not.toHaveAttribute("data-theme", /.+/);

      await expect(localeSelect).toBeVisible();
      await selectUiOption(localeSelect, "en");
      await expect(root).toHaveAttribute("lang", "en");

      await selectUiOption(localeSelect, "cs");
      await expect(root).toHaveAttribute("lang", "cs");

      errors.assertClean();
    });

    test("toggles Elegant and Cozy styles and persists across reload", async ({ page }) => {
      const errors = attachErrorGuards(page);
      await page.goto("/account/appearance", { waitUntil: "domcontentloaded" });

      const root = page.locator(".kb-root");
      const cozy = page.getByRole("radio", { name: "Cozy", exact: true });
      const elegant = page.getByRole("radio", { name: "Elegant", exact: true });

      await expect(cozy).toBeVisible();
      await cozy.click();
      await expect(root).toHaveAttribute("data-style", "cozy");
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(root).toHaveAttribute("data-style", "cozy");
      await expect(cozy).toHaveAttribute("aria-checked", "true");

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
      await selectUiOption(locale, "en");
      await expect(page.locator(".kb-root")).toHaveAttribute("lang", "en");
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      expect(
        await page.evaluate(
          () => Reflect.get(window, "kbServerControl") === document.querySelector("#kb-locale"),
        ),
      ).toBe(true);
      errors.assertClean();
    });

    test("supports keyboard navigation on ui-sdk segmented controls, dialogs, and workspace menu", async ({
      page,
    }, testInfo) => {
      const errors = attachErrorGuards(page);
      await page.goto("/account/appearance", { waitUntil: "domcontentloaded" });
      const elegant = page.getByRole("radio", { name: "Elegant", exact: true });
      await elegant.focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.locator(".kb-root")).toHaveAttribute("data-style", "cozy");
      await page.keyboard.press("ArrowLeft");
      await expect(page.locator(".kb-root")).toHaveAttribute("data-style", "elegant");

      await page.goto(`/w/${DEMO_WS}/reports/revenue?period=2026`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByRole("button", { name: /^(Export|Exportovat)$/ }).click();
      const exportDialog = page.getByRole("dialog");
      await expect(exportDialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(exportDialog).toHaveCount(0);

      if (testInfo.project.name === "desktop") {
        const switcher = page.getByTestId("workspace-switcher");
        await switcher.click();
        await expect(switcher).toHaveAttribute("aria-expanded", "true");
        await expect(page.getByRole("menu")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(switcher).toHaveAttribute("aria-expanded", "false");
      }

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

    test("pasting a full address on onboarding splits into empty address inputs", async ({
      page,
    }) => {
      const errors = attachErrorGuards(page);
      await page.goto("/onboarding", { waitUntil: "domcontentloaded" });

      const street = page.locator("#onb-street");
      const city = page.locator("#onb-city");
      const postal = page.locator("#onb-postal");
      await expect(street).toBeVisible();

      const dispatchPaste = async (selector: string, text: string) =>
        page.evaluate(
          ({ sel, clip }) => {
            const el = document.querySelector(sel);
            if (!(el instanceof HTMLInputElement)) throw new Error(`missing input ${sel}`);
            el.focus();
            const data = new DataTransfer();
            data.setData("text/plain", clip);
            const event = new ClipboardEvent("paste", {
              clipboardData: data,
              bubbles: true,
              cancelable: true,
            });
            el.dispatchEvent(event);
            return event.defaultPrevented;
          },
          { sel: selector, clip: text },
        );

      // Single-line full address splits across Street, City, and Postal code.
      expect(await dispatchPaste("#onb-street", "Jankovcova 1522/53, 170 00 Praha 7")).toBe(true);
      await expect(street).toHaveValue("Jankovcova 1522/53");
      await expect(city).toHaveValue("Praha 7");
      await expect(postal).toHaveValue("170 00");

      // Multiline address respects non-empty fields and fills only empty siblings.
      await street.fill("");
      await city.fill("Brno");
      await postal.fill("");
      expect(await dispatchPaste("#onb-street", "Na Florenci 2116/15\n110 00 Praha 1")).toBe(true);
      await expect(street).toHaveValue("Na Florenci 2116/15");
      await expect(city).toHaveValue("Brno");
      await expect(postal).toHaveValue("110 00");

      // Plain single-part street text is not intercepted.
      await street.fill("");
      expect(await dispatchPaste("#onb-street", "Korunní 810/104")).toBe(false);

      errors.assertClean();
    });
  });
}
