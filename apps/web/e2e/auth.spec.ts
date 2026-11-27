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

      const form = page.locator(".kb-auth-form");
      const status = form.getByRole("status");
      const submit = form.locator("button.kb-btn--primary");
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

    const form = page.locator(".kb-auth-form");
    const status = form.getByRole("status");
    const submit = page.getByTestId("auth-signin-submit");
    await expect(submit).toBeEnabled();
    const initialStatus = await status.elementHandle();

    const methods = form.getByRole("group");
    await methods.getByRole("button", { name: /^(Email link|Odkaz e-mailem)$/ }).click();
    await expect(status.getByText(verifying)).toBeVisible();
    await expect(submit).toBeDisabled();
    const top = await submitTop(submit);
    release();
    await expect(submit).toBeEnabled();
    expect(await submitTop(submit)).toBeCloseTo(top, 0);

    await methods.getByRole("button", { name: /^(Passkey|Přístupový klíč)$/ }).click();
    await expect(page.getByTestId("auth-passkey-btn")).toBeEnabled();
    await expect(status.getByText(verifying)).toBeHidden();
    expect(await status.evaluate((node, initial) => node === initial, initialStatus)).toBe(true);
  });

  test("sign-up keeps the human check in place through edits, method changes and retry", async ({
    page,
  }) => {
    const release = await holdChallenge(page, "magic_link", 503);
    await page.goto("/sign-up");

    const form = page.locator(".kb-auth-form");
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

    await form.getByRole("button", { name: /Use a passkey|Použít přístupový klíč/ }).click();
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
}
