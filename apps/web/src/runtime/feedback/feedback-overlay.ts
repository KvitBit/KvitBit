import {
  FEEDBACK_LIMITS,
  FeedbackIssue,
  type FeedbackSubmission,
  sanitizeFeedbackPageUrl,
} from "@kvitbit/api-contract";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import { fetchBrowser } from "../../app/browser";
import { copy } from "../../app/i18n";
import type { Locale, Prefs } from "../../app/prefs";
import { captureDiagnostics, capturePin } from "./capture";
import { renderFeedbackControls } from "./view";

const text = copy({
  cs: {
    pick: "Vizuální zpětná vazba",
    stop: "Ukončit výběr",
    review: "Zobrazit piny ({total})",
    instructions:
      "Vyberte prvek kliknutím nebo klávesami Tab a Enter. Výběr ukončíte klávesou Escape.",
    unavailable: "Prvek nelze jednoznačně určit. Vyberte jiný prvek.",
    pin: "Pin {number}",
    position: "Pin {number} z {total}",
    comment: "Co bychom měli upravit?",
    add: "Přidat pin",
    remove: "Odebrat pin",
    close: "Zavřít",
    submit: "Odeslat na GitHub",
    // biome-ignore lint/security/noSecrets: This is static user-facing copy or a translation key.
    sending: "Odesílání…",
    failure: "Zpětnou vazbu se nepodařilo odeslat. Zkuste to znovu.",
    created: "Vytvořen požadavek #{number} na GitHubu",
  },
  en: {
    pick: "Visual feedback",
    stop: "Stop picking",
    review: "Review pins ({total})",
    instructions: "Click an element, or use Tab and Enter to pick it. Press Escape to stop.",
    unavailable: "This element cannot be identified uniquely. Pick another element.",
    pin: "Pin {number}",
    position: "Pin {number} of {total}",
    comment: "What should change?",
    add: "Add a pin",
    remove: "Remove pin",
    close: "Close",
    submit: "Send to GitHub",
    sending: "Sending…",
    failure: "Feedback could not be sent. Try again.",
    created: "GitHub issue #{number} created",
  },
});

interface Pin {
  readonly element: Element;
  readonly marker: HTMLButtonElement;
  readonly snapshot: FeedbackSubmission["pins"][number];
}

const px = (value: number) => `${value}px`;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const place = (element: HTMLElement, x: number, y: number) => {
  element.style.left = px(x);
  element.style.top = px(y);
};

const visibleRect = (element: Element): DOMRect | undefined => {
  if (!element.isConnected) return undefined;
  const box = element.getBoundingClientRect();
  if (
    box.width <= 0 ||
    box.height <= 0 ||
    box.bottom <= 0 ||
    box.top >= innerHeight ||
    box.right <= 0 ||
    box.left >= innerWidth
  )
    return undefined;
  return box;
};

const pageTarget = (event: Event): Element | undefined => {
  const target = event.target;
  return target instanceof Element && target.id !== "root" && target.closest("#root") !== null
    ? (target.closest("svg") ?? target)
    : undefined;
};

class FeedbackError extends Schema.TaggedError<FeedbackError, { readonly brand: unique symbol }>()(
  "FeedbackError",
  {
    operation: Schema.String,
  },
) {}

const issuePath = /^\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*$/;
const issueBody = HttpClientResponse.schemaBodyJson(FeedbackIssue);
const githubIssue = Effect.fn("githubIssue")(function* ({
  issueNumber,
  issueUrl,
  title,
}: FeedbackIssue) {
  const url = yield* Effect.try({
    try: () => new URL(issueUrl),
    catch: () => FeedbackError.make({ operation: "read issue URL" }),
  });
  if (
    url.origin !== "https://github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !issuePath.test(url.pathname) ||
    !Str.endsWith(`/issues/${issueNumber}`)(url.pathname)
  ) {
    return yield* FeedbackError.make({ operation: "read issue URL" });
  }
  return { number: issueNumber, url: url.href, title };
});

const sendFeedback = Effect.fn("sendFeedback")(function* (submission: FeedbackSubmission) {
  const request = HttpClientRequest.post(new URL("/api/feedback", globalThis.location.origin));
  return yield* HttpClientRequest.bodyJson(request, submission).pipe(
    Effect.flatMap((prepared) =>
      fetchBrowser({ request: prepared, options: { redirect: "error" } }),
    ),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(issueBody),
    Effect.flatMap(githubIssue),
  );
});

const installFeedback = (
  locale: Locale,
  mode: Prefs["mode"],
  signal: AbortSignal,
  enqueue: (effect: Effect.Effect<void, never, HttpClient.HttpClient>) => void,
) => {
  const host = document.createElement("div");
  host.dataset["kbVisualFeedback"] = "";
  host.dataset["mode"] = mode;
  host.lang = locale;
  const {
    highlight,
    highlightTag,
    markers,
    pick,
    pickError,
    review,
    composer,
    position,
    selector,
    commentLabel,
    comment,
    add,
    remove,
    close,
    send,
    error,
    toast,
    issue,
    dismiss,
    announcement,
  } = renderFeedbackControls(host.attachShadow({ mode: "open" }));
  const nativePopover = Predicate.isFunction(composer.showPopover);
  if (nativePopover) composer.setAttribute("popover", "manual");

  pick.textContent = text(locale, "pick");
  commentLabel.textContent = text(locale, "comment");
  close.setAttribute("aria-label", text(locale, "close"));
  dismiss.setAttribute("aria-label", text(locale, "close"));
  add.textContent = text(locale, "add");
  remove.textContent = text(locale, "remove");
  send.textContent = text(locale, "submit");
  comment.maxLength = FEEDBACK_LIMITS.comment;

  const pins: Pin[] = [];
  let selected: Pin | undefined;
  let hovered: Element | undefined;
  let picking = false;
  let submitting = false;
  let frame = 0;

  const layout = () => {
    const outline = hovered === undefined ? undefined : visibleRect(hovered);
    highlight.hidden = outline === undefined;
    if (outline !== undefined && hovered !== undefined) {
      place(highlight, outline.x, outline.y);
      highlight.style.width = px(outline.width);
      highlight.style.height = px(outline.height);
      highlightTag.textContent = hovered.localName;
    }

    for (const { element, marker } of pins) {
      const box = visibleRect(element);
      marker.hidden = box === undefined;
      if (box !== undefined) {
        place(
          marker,
          clamp(box.right - 15, 2, innerWidth - 32),
          clamp(box.top - 15, 2, innerHeight - 32),
        );
      }
    }

    if (composer.hidden !== false) return;
    const anchor = (
      selected?.marker.hidden === false ? selected.marker : review
    ).getBoundingClientRect();
    const { width, height } = composer.getBoundingClientRect();
    const below = anchor.bottom + 8;
    const x = clamp(anchor.left, 12, innerWidth - width - 12);
    const y = clamp(
      below + height + 12 <= innerHeight ? below : anchor.top - height - 8,
      12,
      innerHeight - height - 12,
    );
    place(composer, x, y);
  };

  const requestLayout = () => {
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      layout();
    });
  };

  const refresh = () => {
    pick.textContent = text(locale, picking ? "stop" : "pick");
    pick.setAttribute("aria-pressed", String(picking));
    pick.disabled = submitting || (!picking && pins.length >= FEEDBACK_LIMITS.pins);
    review.hidden = pins.length === 0;
    review.disabled = submitting;
    review.textContent = text(locale, "review", { total: pins.length });
    add.disabled = submitting || pins.length >= FEEDBACK_LIMITS.pins;
    send.disabled = submitting || Str.trim(comment.value) === "";
    close.disabled = submitting;
    remove.disabled = submitting;
    comment.readOnly = submitting;
    composer.setAttribute("aria-busy", String(submitting));
    send.textContent = text(locale, submitting ? "sending" : "submit");
    for (const [index, { marker }] of pins.entries()) {
      marker.textContent = String(index + 1);
      marker.setAttribute("aria-label", text(locale, "pin", { number: index + 1 }));
      marker.disabled = submitting;
    }
  };

  const closeComposer = () => {
    if (composer.hidden === false && nativePopover) composer.hidePopover();
    composer.hidden = true;
  };

  const setPicking = (active: boolean) => {
    picking = active;
    hovered = undefined;
    pickError.hidden = true;
    if (active) {
      closeComposer();
      error.hidden = true;
    }
    announcement.textContent = active ? text(locale, "instructions") : "";
    refresh();
    requestLayout();
  };

  const showComposer = (pin: Pin) => {
    setPicking(false);
    selected = pin;
    position.textContent = text(locale, "position", {
      number: pins.indexOf(pin) + 1,
      total: pins.length,
    });
    selector.textContent = pin.snapshot.selector;
    if (composer.hidden !== false) {
      composer.hidden = false;
      if (nativePopover) composer.showPopover();
    }
    layout();
    comment.focus({ preventScroll: true });
  };

  const pagePath = location.pathname;
  const pageUrl = sanitizeFeedbackPageUrl(location.href);
  const url =
    pageUrl !== undefined && pageUrl.url.length <= FEEDBACK_LIMITS.url
      ? pageUrl.url
      : `${location.origin}/[redacted]`;

  const addPin = (element: Element) => {
    const existing = Option.getOrUndefined(
      Arr.findFirst(pins, (currentPin) => currentPin.element === element),
    );
    if (existing !== undefined) {
      showComposer(existing);
      return;
    }
    const snapshot = capturePin(element, pageUrl?.sensitive !== false);
    if (snapshot === undefined) {
      pickError.textContent = text(locale, "unavailable");
      pickError.hidden = false;
      announcement.textContent = pickError.textContent;
      return;
    }
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = "marker";
    const pin = { element, marker, snapshot };
    pins.push(pin);
    marker.addEventListener("click", () => showComposer(pin), { signal });
    markers.append(marker);
    showComposer(pin);
  };

  const capture = (event: Event) => {
    if (!picking || location.pathname !== pagePath) return;
    const element = pageTarget(event);
    if (element === undefined) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (visibleRect(element) !== undefined) addPin(element);
  };

  const submit = () => {
    const message = Str.trim(comment.value);
    if (submitting || message === "" || pins.length === 0 || location.pathname !== pagePath) return;
    submitting = true;
    error.hidden = true;
    refresh();
    const theme =
      mode === "system"
        ? matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : mode;
    const submission: FeedbackSubmission = {
      comment: message,
      pins: Arr.map(pins, (pin) => pin.snapshot),
      page: {
        url,
        locale,
        theme,
        viewport: { width: innerWidth, height: innerHeight },
        dpr: devicePixelRatio,
      },
      diagnostics: diagnostics(),
    };
    enqueue(
      sendFeedback(submission).pipe(
        Effect.match({
          onSuccess: (result) => {
            if (signal.aborted) return;
            pins.length = 0;
            markers.replaceChildren();
            comment.value = "";
            selected = undefined;
            closeComposer();
            issue.href = result.url;
            issue.title = result.title;
            issue.textContent = text(locale, "created", { number: result.number });
            announcement.textContent = issue.textContent;
            toast.hidden = false;
            issue.focus({ preventScroll: true });
          },
          onFailure: () => {
            if (signal.aborted) return;
            error.textContent = text(locale, "failure");
            error.hidden = false;
            requestLayout();
          },
        }),
        Effect.ensuring(
          Effect.sync(() => {
            if (!signal.aborted) {
              submitting = false;
              refresh();
            }
          }),
        ),
      ),
    );
  };

  pick.addEventListener("click", () => setPicking(!picking), { signal });
  review.addEventListener(
    "click",
    () => {
      const pin = selected ?? pins[0];
      if (pin !== undefined) showComposer(pin);
    },
    { signal },
  );
  add.addEventListener(
    "click",
    () => {
      setPicking(true);
      pick.focus({ preventScroll: true });
    },
    { signal },
  );
  remove.addEventListener(
    "click",
    () => {
      if (selected === undefined) return;
      selected.marker.remove();
      pins.splice(pins.indexOf(selected), 1);
      selected = undefined;
      const next = pins.at(-1);
      if (next !== undefined) showComposer(next);
      else {
        closeComposer();
        refresh();
        pick.focus({ preventScroll: true });
      }
    },
    { signal },
  );
  close.addEventListener(
    "click",
    () => {
      closeComposer();
      review.focus({ preventScroll: true });
    },
    { signal },
  );
  dismiss.addEventListener(
    "click",
    () => {
      toast.hidden = true;
      pick.focus({ preventScroll: true });
    },
    { signal },
  );
  comment.addEventListener("input", refresh, { signal });
  composer.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      submit();
    },
    { signal },
  );
  globalThis.addEventListener("click", capture, { capture: true, signal });
  const updateHovered = (event: Event) => {
    if (picking) {
      hovered = pageTarget(event);
      requestLayout();
    }
  };
  globalThis.addEventListener("pointerover", updateHovered, { capture: true, signal });
  globalThis.addEventListener("focusin", updateHovered, { capture: true, signal });
  globalThis.addEventListener(
    "pointerout",
    (event) => {
      if (picking && event instanceof PointerEvent && event.relatedTarget === null) {
        hovered = undefined;
        requestLayout();
      }
    },
    { signal },
  );
  globalThis.addEventListener(
    "keydown",
    (event) => {
      if (!(event instanceof KeyboardEvent)) return;
      if (event.key === "Escape" && (picking || (composer.hidden === false && !submitting))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (picking) {
          setPicking(false);
          pick.focus({ preventScroll: true });
        } else {
          closeComposer();
          review.focus({ preventScroll: true });
        }
      } else if ((event.key === "Enter" || event.key === " ") && !event.repeat) {
        capture(event);
      }
    },
    { capture: true, signal },
  );
  globalThis.addEventListener("scroll", requestLayout, { capture: true, passive: true, signal });
  globalThis.addEventListener("resize", requestLayout, { signal });
  const diagnostics = captureDiagnostics(signal);
  document.body.append(host);

  return () => {
    cancelAnimationFrame(frame);
    host.remove();
  };
};

export const mountFeedback = ({
  locale,
  mode,
}: {
  readonly locale: Locale;
  readonly mode: Prefs["mode"];
}) =>
  Stream.callback<Effect.Effect<void, never, HttpClient.HttpClient>, FeedbackError>(
    (submissions) => {
      const controller = new AbortController();
      return Effect.acquireRelease(
        Effect.try({
          try: () =>
            installFeedback(locale, mode, controller.signal, (effect) => {
              Queue.offerUnsafe(submissions, effect);
            }),
          catch: () => FeedbackError.make({ operation: "mount controls" }),
        }).pipe(Effect.tapError(() => Effect.sync(() => controller.abort()))),
        (dispose) =>
          Effect.sync(() => {
            controller.abort();
            dispose();
          }),
      );
    },
  ).pipe(Stream.runForEach((submission) => submission));
