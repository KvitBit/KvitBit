import {
  FEEDBACK_LIMITS,
  type FeedbackSubmission,
  redactFeedbackApiKeys,
  redactFeedbackUrls,
} from "@kvitbit/api-contract";
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
  redactFeedbackUrls(redactFeedbackApiKeys(value)).replace(/\s+/gu, " ").trim().slice(0, limit);

const visibleText = (element: Element, limit: number): string => {
  if (
    !(element instanceof HTMLElement || element instanceof SVGElement) ||
    element.closest(`${editable}, ${nonContent}`) !== null ||
    element.querySelector(editable) !== null ||
    containsPrivateContent(element)
  ) {
    return "";
  }
  // biome-ignore lint/performance/useDomNodeTextContent: Capture rendered text while excluding hidden nodes.
  return excerpt(element instanceof HTMLElement ? element.innerText : "", limit);
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
  if (/^h[1-6]$/.test(element.localName)) return "heading";
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
  return Object.hasOwn(roles, element.localName) ? (roles[element.localName] ?? "") : "";
};

const accessibleName = (element: Element, role: string): string => {
  const limit = FEEDBACK_LIMITS.accessibleName;
  const ids = element.getAttribute("aria-labelledby")?.trim().split(/\s+/u) ?? [];
  const referenced = ids.flatMap((id) => {
    const label = element.ownerDocument.getElementById(id);
    return label === null ? [] : [visibleText(label, limit)];
  });
  const explicit =
    excerpt(referenced.join(" "), limit) ||
    excerpt(element.getAttribute("aria-label") ?? "", limit);
  if (explicit !== "") return explicit;

  if (element instanceof HTMLImageElement) return excerpt(element.alt, limit);
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return excerpt(
      Array.from(element.labels ?? [], (label) => visibleText(label, limit)).join(" "),
      limit,
    );
  }
  return ["button", "link", "heading", "tab", "menuitem"].includes(role)
    ? visibleText(element, limit)
    : "";
};

export const capturePin = (element: Element, sensitive: boolean): Pin | undefined => {
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
    tag: element.localName.slice(0, FEEDBACK_LIMITS.tag),
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

export const captureDiagnostics = (signal: AbortSignal): (() => ReadonlyArray<Diagnostic>) => {
  const recent: Diagnostic[] = [];
  const record = (kind: Diagnostic["kind"]) => {
    recent.push({ kind, timestamp: Date.now() });
    if (recent.length > FEEDBACK_LIMITS.diagnostics) recent.shift();
  };

  // Console arguments and error details can carry credentials or user input. Keep only occurrence data.
  const browserConsole = window.console;
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
  window.addEventListener("error", () => record("onerror"), { signal });
  window.addEventListener("unhandledrejection", () => record("unhandledrejection"), { signal });
  return () => recent.slice();
};
