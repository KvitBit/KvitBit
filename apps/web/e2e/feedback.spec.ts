import type { FeedbackSubmission } from "@kvitbit/api-contract";
import { expect, type Page, test } from "@playwright/test";

const overlay = "[data-kb-visual-feedback]";
const dashboard = "/w/novak-design";
const isFeedbackAsset = (url: string) => /\/assets\/feedback-overlay-[^/]+\.js$/.test(url);

const session = (page: Page, feedbackEnabled: boolean) =>
  page.route("**/api/auth/get-session", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), feedbackEnabled } });
  });

if (typeof Bun === "undefined") {
  test.use({ locale: "en-US" });

  test("does not request the picker chunk for a signed-in non-owner", async ({ page }) => {
    const loaded: string[] = [];
    page.on("request", (request) => {
      if (isFeedbackAsset(request.url())) loaded.push(request.url());
    });
    await session(page, false);
    await page.goto(dashboard);
    await expect(page.locator("#main h1")).toBeVisible();
    await expect(page.locator(overlay)).toHaveCount(0);
    expect(loaded).toEqual([]);
  });

  test("lets an owner pick multiple elements and send feedback to GitHub", async ({
    page,
  }, info) => {
    const submissions: FeedbackSubmission[] = [];
    const issueUrl = "https://github.com/example/kvitbit/issues/42";
    await session(page, true);
    await page.route("**/api/feedback", async (route) => {
      submissions.push(route.request().postDataJSON());
      if (submissions.length === 1) await route.fulfill({ status: 502, json: {} });
      else
        await route.fulfill({
          status: 201,
          json: { issueNumber: 42, issueUrl, title: "Dashboard" },
        });
    });
    const loaded = page.waitForRequest((request) => isFeedbackAsset(request.url()));
    await page.goto(`${dashboard}?token=fixture-secret#private-fragment`);
    await loaded;
    const picker = page.locator(overlay);
    const launch = picker.getByRole("button", { name: "Visual feedback" });
    const heading = page.locator("#main h1");
    await expect(launch).toBeVisible();
    await launch.click();
    await expect(picker.getByRole("button", { name: "Stop picking" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.keyboard.press("Escape");
    await expect(launch).toHaveAttribute("aria-pressed", "false");
    await launch.click();
    if (info.project.name === "desktop") {
      await heading.hover();
      await expect(picker.locator("#highlight")).toBeVisible();
      await heading.click();
    } else {
      await heading.tap();
    }
    await expect(picker.getByRole("button", { name: "Pin 1", exact: true })).toBeVisible();
    await expect(picker.getByText("Pin 1 of 1")).toBeVisible();

    const comment = picker.getByRole("textbox", { name: "What should change?" });
    await comment.fill("Align the heading and the summary.");
    await picker.getByRole("button", { name: "Add a pin" }).click();
    await page.locator("#main h2").first().click();
    await expect(picker.getByText("Pin 2 of 2")).toBeVisible();
    await expect(comment).toHaveValue("Align the heading and the summary.");

    await page.evaluate(() => {
      // biome-ignore lint/suspicious/noConsole: Emit browser diagnostics for the redaction test.
      for (let i = 0; i < 23; i++) console.warn("fixture-secret", i);
      // biome-ignore lint/suspicious/noConsole: Exercise the error channel as well as warnings.
      console.error("fixture-secret");
      window.dispatchEvent(new ErrorEvent("error", { message: "fixture-secret" }));
      window.dispatchEvent(
        new PromiseRejectionEvent("unhandledrejection", {
          promise: Promise.resolve(),
          reason: "fixture-secret",
        }),
      );
    });
    const send = picker.getByRole("button", { name: "Send to GitHub" });
    await send.click();
    await expect(picker.getByRole("alert")).toHaveText("Feedback could not be sent. Try again.");
    await expect(comment).toHaveValue("Align the heading and the summary.");
    await send.click();
    await expect(picker.getByRole("link", { name: "GitHub issue #42 created" })).toHaveAttribute(
      "href",
      issueUrl,
    );
    await expect(picker.getByRole("button", { name: "Pin 1", exact: true })).toHaveCount(0);

    const [first, second] = submissions;
    if (first === undefined || second === undefined) throw new Error("Missing feedback requests");
    expect(first.comment).toBe("Align the heading and the summary.");
    expect(first.pins.map((pin) => pin.tag)).toEqual(["h1", "h2"]);
    expect(second.pins).toEqual(first.pins);
    expect(first.page.url).toBe(new URL(dashboard, page.url()).href);
    expect(first.diagnostics).toHaveLength(20);
    expect(first.diagnostics.slice(-4).map((event) => event.kind)).toEqual([
      "warn",
      "error",
      "onerror",
      "unhandledrejection",
    ]);
    expect(JSON.stringify(first)).not.toMatch(/fixture-secret|private-fragment/);
    const firstPin = first.pins[0];
    if (firstPin === undefined) throw new Error("Missing first pin");
    await expect(page.locator(firstPin.selector)).toHaveCount(1);
    expect(
      await page.locator(firstPin.selector).evaluate((element) => element.matches("#main h1")),
    ).toBe(true);
  });

  test("redacts share tokens and suppresses automatic text on token-bearing pages", async ({
    page,
  }) => {
    await session(page, true);
    const issueUrl = "https://github.com/example/kvitbit/issues/43";
    await page.route("**/api/feedback", (route) =>
      route.fulfill({ status: 201, json: { issueNumber: 43, issueUrl, title: "Share page" } }),
    );
    await page.goto("/i/demo-unpaid-czk?fixture-secret=1#private-fragment");
    const picker = page.locator(overlay);
    await picker.getByRole("button", { name: "Visual feedback" }).click();
    await page.locator("#main h1").click();
    await picker.getByRole("textbox", { name: "What should change?" }).fill("Adjust the title.");
    const requested = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/feedback",
    );
    await picker.getByRole("button", { name: "Send to GitHub" }).click();
    const submission: FeedbackSubmission = (await requested).postDataJSON();
    expect(submission.page.url).toBe(`${new URL(page.url()).origin}/[redacted]`);
    expect(submission.pins[0]).toMatchObject({ tag: "h1", accessibleName: "", text: "" });
    expect(JSON.stringify(submission)).not.toMatch(
      /demo-unpaid-czk|fixture-secret|private-fragment/,
    );
  });

  test("disposes the picker when the app signs out", async ({ page }) => {
    await session(page, true);
    await page.goto("/legal/terms");
    const picker = page.locator(overlay);
    await expect(picker).toBeAttached();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(picker).toHaveCount(0);
  });
}
