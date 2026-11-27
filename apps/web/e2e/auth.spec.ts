import { expect, type Locator, type Page, test } from "@playwright/test";

const challenge = "**/api/v1/bot-protection/challenges/";
const verifying = /Verifying you're human|Ověřujeme, že nejste robot/;

const holdChallenge = async (page: Page, scope: string, status: number) => {
  const response = Promise.withResolvers<void>();
  await page.route(
    `${challenge}${scope}`,
    async (route) => {
      await response.promise;
      await route.fulfill({ status });
    },
    { times: 1 },
  );
  return response.resolve;
};

const submitTop = (submit: Locator) => submit.evaluate((node) => node.getBoundingClientRect().top);

const mockChallenge = (page: Page) =>
  page.route(`${challenge}*`, (route) =>
    route.fulfill({
      json: { parameters: { algorithm: "SHA-256", nonce: "00112233", keyPrefix: "0" } },
    }),
  );

const mockWorker = (
  page: Page,
  mode: "constructor-error" | "load-error" | "message-error" | "silent" | "stuck",
) =>
  page.addInitScript((mode) => {
    let activeWorkers = 0;
    let startedWorkers = 0;
    Object.defineProperty(globalThis, "altchaWorkers", {
      get: () => ({ active: activeWorkers, started: startedWorkers }),
    });
    Object.defineProperty(globalThis, "Worker", {
      value: class {
        onmessage?: (message: MessageEvent) => void;
        onerror?: (event: ErrorEvent) => void;
        onmessageerror?: () => void;

        constructor() {
          if (mode === "constructor-error") throw new Error("Worker unavailable");
          activeWorkers++;
          startedWorkers++;
        }

        postMessage() {
          queueMicrotask(() => {
            if (mode === "silent") return;
            if (mode === "load-error") {
              this.onerror?.(new ErrorEvent("error"));
              return;
            }
            this.onmessage?.(new MessageEvent("message", { data: { _tag: "Ready" } }));
            if (mode === "message-error") this.onmessageerror?.();
          });
        }

        terminate() {
          activeWorkers--;
        }
      },
    });
  }, mode);

const workerCounts = (page: Page) => page.evaluate(() => Reflect.get(globalThis, "altchaWorkers"));

// Bun also discovers *.spec.ts, so register these tests only under Playwright.
if (typeof Bun === "undefined") {
  for (const { path, scope } of [
    { path: "/sign-in", scope: "sign_in" },
    { path: "/sign-up", scope: "sign_up" },
    { path: "/reset-password", scope: "password_reset" },
  ]) {
    test(`${path} keeps submit in place when no human check is required`, async ({ page }) => {
      const release = await holdChallenge(page, scope, 204);
      await page.goto(path);

      const form = page.locator('[data-slot="auth-form"]');
      const status = form.getByRole("status");
      const submit = form.locator('button[data-variant="primary"]');
      await expect(status.getByText(verifying)).toBeVisible();
      await expect(submit).toBeDisabled();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const top = await submitTop(submit);

      release();
      await expect(submit).toBeEnabled();
      await expect(form.getByText(verifying)).toBeHidden();
      expect(await submitTop(submit)).toBeCloseTo(top, 0);
    });
  }

  test("sign-in retains its status region across methods", async ({ page }) => {
    const release = await holdChallenge(page, "magic_link", 204);
    await page.goto("/sign-in");

    const form = page.locator('[data-slot="auth-form"]');
    const status = form.getByRole("status");
    const submit = page.getByTestId("auth-signin-submit");
    await expect(submit).toBeEnabled();
    const initialStatus = await status.elementHandle();

    const methods = form.getByRole("radiogroup");
    await methods.getByRole("radio", { name: /^(Email link|Odkaz e-mailem)$/ }).click();
    await expect(status.getByText(verifying)).toBeVisible();
    await expect(submit).toBeDisabled();
    const top = await submitTop(submit);
    release();
    await expect(submit).toBeEnabled();
    expect(await submitTop(submit)).toBeCloseTo(top, 0);

    await methods.getByRole("radio", { name: /^(Passkey|Přístupový klíč)$/ }).click();
    await expect(page.getByTestId("auth-passkey-btn")).toBeEnabled();
    await expect(status.getByText(verifying)).toBeHidden();
    expect(await status.evaluate((node, initial) => node === initial, initialStatus)).toBe(true);
  });

  test("sign-up keeps the human check in place through edits, method changes and retry", async ({
    page,
  }) => {
    const release = await holdChallenge(page, "magic_link", 503);
    await page.goto("/sign-up");

    const form = page.locator('[data-slot="auth-form"]');
    const status = form.getByRole("status");
    const submit = page.getByTestId("auth-signup-submit");
    await expect(submit).toBeEnabled();
    const initialStatus = await status.elementHandle();
    await page.locator("#auth-signup-email").pressSequentially("person@example.test");
    await page.locator("#auth-signup-terms").check();
    expect(await status.evaluate((node, initial) => node === initial, initialStatus)).toBe(true);

    await submit.click();
    await expect(form.getByRole("alert")).toBeVisible();
    expect(await status.evaluate((node, initial) => node === initial, initialStatus)).toBe(true);

    await form.getByRole("radio", { name: /Use a passkey|Použít přístupový klíč/ }).click();
    await expect(status.getByText(verifying)).toBeVisible();
    await expect(submit).toBeDisabled();
    const top = await submitTop(submit);

    release();
    const retry = form.getByRole("button", { name: /Retry|Zkusit znovu/ });
    await expect(retry).toBeVisible();
    expect(await submitTop(submit)).toBeCloseTo(top, 0);
    await retry.click();
    await expect(submit).toBeEnabled();
    await expect(retry).toBeHidden();
    expect(await submitTop(submit)).toBeCloseTo(top, 0);
  });

  for (const mode of ["constructor-error", "load-error", "message-error", "silent"] as const) {
    test(`sign-up falls back when the verification worker is ${mode}`, async ({ page }) => {
      if (mode === "silent") await page.clock.install();
      await mockWorker(page, mode);
      await mockChallenge(page);
      await page.goto("/sign-up");

      if (mode === "silent") {
        await expect.poll(() => workerCounts(page)).toEqual({ started: 1, active: 1 });
        await page.clock.fastForward(3_100);
      }
      await expect(page.getByTestId("auth-signup-submit")).toBeEnabled();
      await expect(page.getByRole("status").getByText(/Verified|Ověřeno/)).toBeVisible();
      expect(await workerCounts(page)).toMatchObject({ active: 0 });
    });
  }

  test("sign-in times out a stuck solve, terminates its worker, and allows retry", async ({
    page,
  }) => {
    await page.clock.install();
    await mockWorker(page, "stuck");
    await mockChallenge(page);
    await page.goto("/sign-in");
    const submit = page.getByTestId("auth-signin-submit");
    await expect.poll(() => workerCounts(page)).toEqual({ started: 1, active: 1 });
    await expect(submit).toBeDisabled();
    await page.clock.fastForward(30_100);

    const retry = page.getByRole("button", { name: /Retry|Zkusit znovu/ });
    await expect(retry).toBeVisible();
    await expect.poll(() => workerCounts(page)).toEqual({ started: 1, active: 0 });
    await page.route(`${challenge}sign_in`, (route) => route.fulfill({ status: 204 }));
    await retry.click();
    await expect(submit).toBeEnabled();
  });

  test("reset password offers retry when fetching a challenge stalls", async ({ page }) => {
    await page.clock.install();
    const requested = Promise.withResolvers<void>();
    page.on("request", (request) => {
      if (request.url().endsWith("/bot-protection/challenges/password_reset")) requested.resolve();
    });
    const release = await holdChallenge(page, "password_reset", 204);
    await page.goto("/reset-password");
    await requested.promise;
    await page.clock.fastForward(10_100);
    await expect(page.getByRole("button", { name: /Retry|Zkusit znovu/ })).toBeVisible();
    release();
  });

  test("an auth method switch or route change terminates superseded workers", async ({ page }) => {
    await mockWorker(page, "stuck");
    await mockChallenge(page);
    await page.goto("/sign-in");
    await expect.poll(() => workerCounts(page)).toEqual({ started: 1, active: 1 });

    const methods = page.locator(".kb-auth-form").getByRole("group");
    await methods.getByRole("button", { name: /^(Email link|Odkaz e-mailem)$/ }).click();
    await expect.poll(() => workerCounts(page)).toEqual({ started: 2, active: 1 });
    await methods.getByRole("button", { name: /^(Passkey|Přístupový klíč)$/ }).click();
    await expect.poll(() => workerCounts(page)).toEqual({ started: 2, active: 0 });

    await methods.getByRole("button", { name: /^(Password|Heslo)$/ }).click();
    await expect.poll(() => workerCounts(page)).toEqual({ started: 3, active: 1 });
    await page.route(`${challenge}sign_up`, (route) => route.fulfill({ status: 204 }));
    await page.locator('.kb-auth-footer a[href="/sign-up"]').click();
    await expect(page.getByTestId("auth-signup-submit")).toBeEnabled();
    await expect.poll(() => workerCounts(page)).toEqual({ started: 3, active: 0 });
  });
}
