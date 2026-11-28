import {
  FEEDBACK_LIMITS,
  type FeedbackSubmission,
  redactFeedbackApiKeys,
  redactFeedbackUrls,
} from "@kvitbit/api-contract";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Fn from "effect/Function";
import * as EffectRecord from "effect/Record";
import * as Str from "effect/String";
import { elementPaths } from "./selector";

type Pin = FeedbackSubmission["pins"][number];
type Diagnostic = FeedbackSubmission["diagnostics"][number];

const editable =
  "input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox]";
const nonContent = "script, style, [hidden], [aria-hidden=true]";
const privateContent = ".kb-secret-box, [data-feedback-private]";

const containsPrivateContent = (element: Element) =>
  element.closest(privateContent) !== null || element.querySelector(privateContent) !== null;

const excerpt = (value: string, limit: number) =>
  Str.slice(
    0,
    limit,
  )(Str.trim(Str.replace(/\s+/gu, " ")(redactFeedbackUrls(redactFeedbackApiKeys(value)))));

const visibleText = (element: Element, limit: number): string => {
  if (
    !(element instanceof HTMLElement) ||
    element.closest(`${editable}, ${nonContent}`) !== null ||
    element.querySelector(editable) !== null ||
    containsPrivateContent(element)
  ) {
    return "";
  }
  return excerpt(element.innerText, limit);
};

const implicitRole = (element: Element) => {
  if (element instanceof HTMLInputElement) {
    switch (element.type) {
      case "checkbox":
      case "radio":
        return element.type;
      case "submit":
      case "reset":
      case "button":
        return "button";
      case "range":
        return "slider";
      case "number":
        return "spinbutton";
      case "search":
        return "searchbox";
      case "text":
      case "email":
      case "tel":
      case "url":
        return "textbox";
      default:
        return "";
    }
  }
  if (headingTag.test(element.localName)) return "heading";
  if (element.localName === "a" && element.hasAttribute("href")) return "link";
  if (element instanceof HTMLSelectElement) {
    return element.multiple || element.size > 1 ? "listbox" : "combobox";
  }
  const roles: Readonly<Record<string, string>> = {
    button: "button",
    img: "img",
    textarea: "textbox",
    main: "main",
    nav: "navigation",
    dialog: "dialog",
    table: "table",
    th: "columnheader",
    td: "cell",
    tr: "row",
    ul: "list",
    ol: "list",
    li: "listitem",
  };
  return EffectRecord.has(roles, element.localName) ? (roles[element.localName] ?? "") : "";
};

const accessibleName = (element: Element, role: string): string => {
  const limit = FEEDBACK_LIMITS.accessibleName;
  const labels = element.getAttribute("aria-labelledby");
  const ids = labels === null ? [] : Str.split(Str.trim(labels), wordSeparator);
  const referenced = Arr.flatMap(ids, (id) => {
    const label = element.ownerDocument.querySelector(`#${globalThis.CSS.escape(id)}`);
    return label === null ? [] : [visibleText(label, limit)];
  });
  const explicit =
    excerpt(Arr.join(referenced, " "), limit) ||
    excerpt(element.getAttribute("aria-label") ?? "", limit);
  if (explicit !== "") return explicit;

  if (element instanceof HTMLImageElement) return excerpt(element.alt, limit);
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return excerpt(
      Arr.join(
        Array.from(element.labels ?? [], (label) => visibleText(label, limit)),
        " ",
      ),
      limit,
    );
  }
  return ["button", "link", "heading", "tab", "menuitem"].includes(role)
    ? visibleText(element, limit)
    : "";
};

const capturePinImpl = (element: Element, sensitive: boolean): Pin | undefined => {
  const omitMetadata = sensitive || containsPrivateContent(element);
  const paths = elementPaths(element, !omitMetadata, FEEDBACK_LIMITS.selector);
  if (paths === undefined) return undefined;
  const { x, y, width, height } = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const role = omitMetadata
    ? implicitRole(element)
    : excerpt(element.getAttribute("role") ?? implicitRole(element), FEEDBACK_LIMITS.role);
  return {
    ...paths,
    tag: Str.slice(0, FEEDBACK_LIMITS.tag)(element.localName),
    accessibleName: omitMetadata ? "" : accessibleName(element, role),
    role,
    rect: { x, y, width, height },
    text: omitMetadata ? "" : visibleText(element, FEEDBACK_LIMITS.text),
    styles: {
      display: style.display,
      position: style.position,
      color: style.color,
      backgroundColor: style.backgroundColor,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
    },
  };
};

export const capturePin: {
  (sensitive: boolean): (element: Element) => Pin | undefined;
  (element: Element, sensitive: boolean): Pin | undefined;
} = Fn.dual(2, capturePinImpl);

export const captureDiagnostics = (signal: AbortSignal): (() => ReadonlyArray<Diagnostic>) => {
  const recent: Diagnostic[] = [];
  const record = (kind: Diagnostic["kind"]) => {
    recent.push({ kind, timestamp: DateTime.toEpochMillis(DateTime.nowUnsafe()) });
    if (recent.length > FEEDBACK_LIMITS.diagnostics) recent.shift();
  };

  // Console arguments and error details can carry credentials or user input. Keep only occurrence data.
  const browserConsole = globalThis.console;
  for (const kind of ["warn", "error"] as const) {
    const original = browserConsole[kind];
    const wrapped = (...args: unknown[]) => {
      record(kind);
      original.apply(browserConsole, args);
    };
    browserConsole[kind] = wrapped;
    signal.addEventListener("abort", () => {
      if (browserConsole[kind] === wrapped) browserConsole[kind] = original;
    });
  }
  globalThis.addEventListener("error", () => record("onerror"), { signal });
  globalThis.addEventListener("unhandledrejection", () => record("unhandledrejection"), { signal });
  return () => recent.slice();
};

const wordSeparator = /\s+/u;
const headingTag = /^h[1-6]$/;
