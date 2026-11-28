import { FEEDBACK_LIMITS, FeedbackSubmission } from "@kvitbit/api-contract";
import { expect, type Page, test } from "@playwright/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const feedbackAssetPattern = /\/assets\/feedback-overlay-[^/]+\.js$/;
const privateFeedbackPattern = /fixture-secret|private-fragment/;
const privateSharePattern = /demo-unpaid-czk|fixture-secret|private-fragment/;
const hiddenTextPattern = /fixture-hidden-text/i;
const signInPathPattern = /\/sign-in$/;

const submissionJson = Schema.fromJsonString(FeedbackSubmission);
const jsonBody = Schema.fromJsonString(Schema.Json);
const decodeSubmission = Schema.decodeEffect(submissionJson);
const decodeBody = Schema.decodeEffect(jsonBody);
const encodeBody = Schema.encodeEffect(jsonBody);

const readSubmission = (payload: string | null) => {
  if (payload === null) throw new Error("Missing feedback request body");
  const submission = decodeSubmission(payload).pipe(Effect.runSync);
  // Preserve every wire field when checking for private text.
  const body = decodeBody(payload).pipe(Effect.flatMap(encodeBody), Effect.runSync);
  return { submission, body };
};

const overlay = "[data-kb-visual-feedback]";
const dashboard = "/w/novak-design";
const isFeedbackAsset = (url: string) => feedbackAssetPattern.test(url);

const session = (page: Page, feedbackEnabled: boolean) =>
  page.route("**/api/auth/get-session", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), feedbackEnabled } });
  });

const captureSubmission = async (page: Page, comment: string) => {
  const issueUrl = "https://github.com/example/kvitbit/issues/43";
  await page.route("**/api/feedback", (route) =>
    route.fulfill({ status: 201, json: { issueNumber: 43, issueUrl, title: "Visual feedback" } }),
  );
  const picker = page.locator(overlay);
  await picker.getByRole("textbox", { name: "What should change?" }).fill(comment);
  const requested = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/feedback",
  );
  await picker.getByRole("button", { name: "Send to GitHub" }).click();
  return readSubmission((await requested).postData());
};

if (!("Bun" in globalThis)) {
  test.use({ locale: "en-US" });

  test("does not request the picker chunk for a signed-in non-owner", async ({ page }) => {
    const loaded: string[] = [];
    page.on("request", (request) => {
      if (isFeedbackAsset(request.url())) loaded.push(request.url());
    });
    await session(page, false);
    await page.goto(dashboard);
    await expect(page.locator("#main h1")).toBeVisible();
    await page.keyboard.press("k");
    await expect(page.locator(overlay)).toHaveCount(0);
    expect(loaded).toEqual([]);
  });

  test("toggles picking with k and leaves text entry alone", async ({ page }, info) => {
    await session(page, true);
    await page.goto(dashboard);
    const picker = page.locator(overlay);
    const launch = picker.getByRole("button", { name: "Visual feedback", exact: true });
    const stop = picker.getByRole("button", { name: "Stop picking", exact: true });
    const hint = picker.locator("#pick kbd");
    await expect(launch).toHaveAttribute("aria-keyshortcuts", "k");
    await expect(hint).toHaveText("K");
    await expect(hint).toBeVisible({ visible: info.project.name === "desktop" });

    await page.keyboard.press("k");
    await expect(stop).toHaveAttribute("aria-pressed", "true");
    await expect(hint).toHaveText("K");
    await page.keyboard.press("k");
    await expect(launch).toHaveAttribute("aria-pressed", "false");
    await expect(launch).toBeFocused();

    await page.evaluate(() => {
      const input = document.createElement("input");
      input.id = "shortcut-input";
      const textarea = document.createElement("textarea");
      textarea.id = "shortcut-textarea";
      const editor = document.createElement("div");
      editor.id = "shortcut-editor";
      editor.contentEditable = "true";
      document.body.append(input, textarea, editor);
    });
    for (const id of ["shortcut-input", "shortcut-textarea", "shortcut-editor"]) {
      const field = page.locator(`#${id}`);
      await field.focus();
      await page.keyboard.press("k");
      const contents = () => (id === "shortcut-editor" ? field.textContent() : field.inputValue());
      await expect.poll(contents).toBe("k");
      await expect(launch).toHaveAttribute("aria-pressed", "false");
    }

    await launch.focus();
    await page.keyboard.press("k");
    await page.locator("#main h1").click();
    const comment = picker.getByRole("textbox", { name: "What should change?" });
    await expect(comment).toBeFocused();
    await page.keyboard.press("k");
    await expect(comment).toHaveValue("k");
    await expect(launch).toHaveAttribute("aria-pressed", "false");

    await picker.getByRole("button", { name: "Close" }).focus();
    await page.keyboard.press("k");
    await expect(stop).toHaveAttribute("aria-pressed", "true");
    await expect(comment).toBeHidden();
  });

  test("keeps Ctrl+K and Cmd+K for the workspace switcher", { tag: "@desktop" }, async ({
    page,
  }) => {
    await session(page, true);
    await page.goto(dashboard);
    const launch = page.locator(overlay).getByRole("button", { name: "Visual feedback" });
    const switcher = page.getByTestId("workspace-switcher");
    await expect(launch).toBeVisible();
    for (const [platform, key] of [
      ["Linux x86_64", "Control+k"],
      ["MacIntel", "Meta+k"],
    ] as const) {
      await page.evaluate((navigatorPlatform) => {
        Object.defineProperty(navigator, "platform", {
          value: navigatorPlatform,
          configurable: true,
        });
      }, platform);
      await page.keyboard.press(key);
      await expect(switcher).toHaveAttribute("aria-expanded", "true");
      await expect(launch).toHaveAttribute("aria-pressed", "false");
      await switcher.click();
      await expect(switcher).toHaveAttribute("aria-expanded", "false");
    }
  });

  test("ignores k after the pathname changes and at the pin limit", async ({ page }) => {
    await session(page, true);
    await page.goto(dashboard);
    const picker = page.locator(overlay);
    const launch = picker.getByRole("button", { name: "Visual feedback", exact: true });
    await expect(launch).toBeEnabled();
    const unhandled = await page.evaluate((pinLimit) => {
      const originalUrl = location.href;
      history.replaceState(history.state, "", "/legal/terms");
      const unhandledKey = document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true }),
      );
      history.replaceState(history.state, "", originalUrl);

      const targets = document.createElement("section");
      for (let i = 1; i <= pinLimit; i++) {
        const target = document.createElement("p");
        target.id = `shortcut-pin-${i}`;
        target.tabIndex = -1;
        target.textContent = `Shortcut pin ${i}`;
        targets.append(target);
      }
      document.querySelector("#main")?.append(targets);
      return unhandledKey;
    }, FEEDBACK_LIMITS.pins);
    expect(unhandled).toBe(true);
    await expect(launch).toHaveAttribute("aria-pressed", "false");

    for (let i = 1; i <= FEEDBACK_LIMITS.pins; i++) {
      await launch.focus();
      await page.keyboard.press("k");
      await page.locator(`#shortcut-pin-${i}`).press("Enter");
      await expect(picker.getByText(`Pin ${i} of ${i}`)).toBeVisible();
    }
    const comment = picker.getByRole("textbox", { name: "What should change?" });
    await expect(launch).toBeDisabled();
    await picker.getByRole("button", { name: "Close" }).focus();
    await page.keyboard.press("k");
    await expect(launch).toHaveAttribute("aria-pressed", "false");
    await expect(comment).toBeVisible();
  });

  test.describe("Czech labels", () => {
    test.use({ locale: "cs-CZ" });

    test("keeps the picker button's translated accessible names", async ({ page }) => {
      await session(page, true);
      await page.goto(dashboard);
      const picker = page.locator(overlay);
      await expect(
        picker.getByRole("button", { name: "Vizuální zpětná vazba", exact: true }),
      ).toHaveAttribute("aria-keyshortcuts", "k");
      await page.keyboard.press("k");
      await expect(
        picker.getByRole("button", { name: "Ukončit výběr", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
    });
  });

  test("lets an owner pick multiple elements and send feedback to GitHub", async ({
    page,
  }, info) => {
    const submissions: ReturnType<typeof readSubmission>[] = [];
    const issueUrl = "https://github.com/example/kvitbit/issues/42";
    const firstResponse = Promise.withResolvers<void>();
    await session(page, true);
    await page.route("**/api/feedback", async (route) => {
      submissions.push(readSubmission(route.request().postData()));
      if (submissions.length === 1) {
        await firstResponse.promise;
        await route.fulfill({ status: 502, json: {} });
      } else {
        await route.fulfill({
          status: 201,
          json: { issueNumber: 42, issueUrl, title: "Dashboard" },
        });
      }
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
      await picker.locator("#highlight").waitFor({ state: "visible" });
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
      const browserConsole = globalThis.console;
      for (let i = 0; i < 23; i++) {
        browserConsole.warn("fixture-secret", i);
      }

      browserConsole.error("fixture-secret");
      globalThis.dispatchEvent(new ErrorEvent("error", { message: "fixture-secret" }));
      globalThis.dispatchEvent(
        new PromiseRejectionEvent("unhandledrejection", {
          promise: Promise.resolve(),
          reason: "fixture-secret",
        }),
      );
    });
    const send = picker.getByRole("button", { name: "Send to GitHub" });
    try {
      await send.click();
      await expect(launch).toBeDisabled();
      expect(
        await page.evaluate(() =>
          document.body.dispatchEvent(
            new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true }),
          ),
        ),
      ).toBe(true);
      await expect(launch).toHaveAttribute("aria-pressed", "false");
      await expect(comment).toBeVisible();
    } finally {
      firstResponse.resolve();
    }
    await expect(picker.getByRole("alert")).toHaveText("Feedback could not be sent. Try again.");
    await expect(comment).toHaveValue("Align the heading and the summary.");
    await send.click();
    await expect(picker.getByRole("link", { name: "GitHub issue #42 created" })).toHaveAttribute(
      "href",
      issueUrl,
    );
    await expect(picker.getByRole("button", { name: "Pin 1", exact: true })).toHaveCount(0);

    const [firstRequest, secondRequest] = submissions;
    if (firstRequest === undefined || secondRequest === undefined)
      throw new Error("Missing feedback requests");
    const { submission: first } = firstRequest;
    const { submission: second } = secondRequest;
    expect(first.comment).toBe("Align the heading and the summary.");
    expect(Arr.map(first.pins, (pin) => pin.tag)).toEqual(["h1", "h2"]);
    expect(second.pins).toEqual(first.pins);
    expect(first.page.url).toBe(new URL(dashboard, page.url()).href);
    expect(first.diagnostics).toHaveLength(20);
    expect(Arr.map(first.diagnostics.slice(-4), (event) => event.kind)).toEqual([
      "warn",
      "error",
      "onerror",
      "unhandledrejection",
    ]);
    expect(firstRequest.body).not.toMatch(privateFeedbackPattern);
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
    await page.goto("/i/demo-unpaid-czk?fixture-secret=1#private-fragment");
    const picker = page.locator(overlay);
    await picker.getByRole("button", { name: "Visual feedback" }).click();
    await page.locator("#main h1").click();
    const { submission, body } = await captureSubmission(page, "Adjust the title.");
    expect(submission.page.url).toBe(`${new URL(page.url()).origin}/[redacted]`);
    expect(submission.pins[0]).toMatchObject({ tag: "h1", accessibleName: "", text: "" });
    expect(body).not.toMatch(privateSharePattern);
  });

  test("omits an active private link and its enclosing text on the document Share tab", async ({
    page,
  }) => {
    await session(page, true);
    await page.goto(`${dashboard}/documents/0193a000-0000-7000-8000-000000000259?tab=share`);
    const row = page.locator('[data-slot="share-url"]');
    const link = row.locator("span[data-feedback-private]");
    await expect(link).toContainText("/i/demo-share-token-0041");
    const picker = page.locator(overlay);
    await picker.getByRole("button", { name: "Visual feedback" }).click();
    await link.click();
    await picker.getByRole("button", { name: "Add a pin" }).click();
    await row.click({ position: { x: 2, y: 2 } });
    const { submission, body } = await captureSubmission(page, "Adjust the share controls.");
    expect(
      Arr.map(submission.pins, ({ tag, accessibleName, text }) => ({ tag, accessibleName, text })),
    ).toEqual([
      { tag: "span", accessibleName: "", text: "" },
      { tag: "div", accessibleName: "", text: "" },
    ]);
    expect(body).not.toContain("demo-share-token-0041");
  });

  test("omits typed values when pinning an ordinary form container", async ({ page }) => {
    await session(page, true);
    await page.goto(`${dashboard}/settings/issuing-entity`);
    const field = page.locator("#kb-entity-name");
    await field.fill("fixture-private-form-value");
    const formGrid = page.locator('[data-slot="form-grid"]').filter({ has: field });
    await page.locator(overlay).getByRole("button", { name: "Visual feedback" }).click();
    await formGrid.scrollIntoViewIfNeeded();
    await formGrid.dispatchEvent("click");
    const { submission, body } = await captureSubmission(page, "Adjust the form layout.");
    expect(submission.pins[0]).toMatchObject({ tag: "div", accessibleName: "", text: "" });
    expect(body).not.toContain("fixture-private-form-value");
  });

  test("captures rendered text and omits hidden descendants", async ({ page }) => {
    await session(page, true);
    await page.goto(dashboard);
    const heading = page.locator("#main h1");
    await heading.evaluate((element) => {
      const hidden = document.createElement("span");
      hidden.style.display = "none";
      hidden.textContent = "fixture-hidden-text";
      element.style.textTransform = "uppercase";
      element.replaceChildren("Visible title", hidden);
    });
    await page.locator(overlay).getByRole("button", { name: "Visual feedback" }).click();
    await heading.dispatchEvent("click");
    const { submission, body } = await captureSubmission(page, "Adjust the title.");
    expect(submission.pins[0]).toMatchObject({
      tag: "h1",
      accessibleName: "VISIBLE TITLE",
      text: "VISIBLE TITLE",
    });
    expect(body).not.toMatch(hiddenTextPattern);
  });

  test("disposes the picker when the app signs out", async ({ page }) => {
    await session(page, true);
    await page.goto("/legal/terms");
    const picker = page.locator(overlay);
    await expect(picker).toBeAttached();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(signInPathPattern);
    await expect(picker).toHaveCount(0);
    expect(
      await page.evaluate(() => {
        // Return to the former path without remounting so a leaked listener would handle k.
        const signedOutUrl = location.href;
        history.replaceState(history.state, "", "/legal/terms");
        const unhandled = document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true }),
        );
        history.replaceState(history.state, "", signedOutUrl);
        return unhandled;
      }),
    ).toBe(true);
  });

  test("restores diagnostic handlers if the picker fails to mount", async ({ page }) => {
    await session(page, true);
    await page.addInitScript(() => {
      const browserConsole = globalThis.console;
      const { warn, error } = browserConsole;
      const append = Element.prototype.append;
      Element.prototype.append = function (this: Element, ...nodes: Array<Node | string>) {
        let containsOverlay = false;
        for (const node of nodes) {
          if (node instanceof HTMLElement && node.hasAttribute("data-kb-visual-feedback")) {
            containsOverlay = true;
            break;
          }
        }
        if (this === document.body && containsOverlay) {
          const attached = browserConsole.warn !== warn && browserConsole.error !== error;
          Element.prototype.append = append;
          queueMicrotask(() => {
            document.documentElement.dataset["feedbackMountCleaned"] = String(
              attached && browserConsole.warn === warn && browserConsole.error === error,
            );
          });
          throw new Error("Fixture picker mount failure");
        }
        append.apply(this, nodes);
      };
    });
    await page.goto(dashboard);
    await expect(page.locator("html")).toHaveAttribute("data-feedback-mount-cleaned", "true");
    await expect(page.locator("#main h1")).toBeVisible();
    await expect(page.locator(overlay)).toHaveCount(0);
  });
}
