import css from "./feedback-overlay.css?inline";

const create = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Readonly<Record<string, string>>,
  ...children: ReadonlyArray<Node | string>
): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  element.append(...children);
  return element;
};

export const renderFeedbackControls = (root: ShadowRoot) => {
  const highlightTag = create("span", {});
  const highlight = create(
    "div",
    { id: "highlight", "aria-hidden": "true", hidden: "" },
    highlightTag,
  );
  const markers = create("div", {});
  const review = create("button", { type: "button", hidden: "" });
  const pick = create("button", { id: "pick", type: "button", "aria-pressed": "false" });
  const toolbar = create("div", { class: "toolbar" }, review, pick);
  const position = create("strong", { id: "pin-position" });
  const close = create("button", { type: "button" }, "×");
  const selector = create("code", {});
  const commentLabel = create("label", { for: "comment" });
  const comment = create("textarea", { id: "comment", rows: "3", required: "" });
  const add = create("button", { type: "button" });
  const remove = create("button", { type: "button" });
  const send = create("button", { type: "submit", class: "primary" });
  const error = create("p", { class: "error", role: "alert", hidden: "" });
  const composer = create(
    "form",
    { class: "composer", "aria-labelledby": "pin-position", autocomplete: "off", hidden: "" },
    create("header", {}, position, close),
    selector,
    commentLabel,
    comment,
    create("div", { class: "actions" }, add, remove, send),
    error,
  );
  const issue = create("a", { target: "_blank", rel: "noopener noreferrer" });
  const dismiss = create("button", { type: "button" }, "×");
  const toast = create("div", { class: "toast", hidden: "" }, issue, dismiss);
  const announcement = create("div", { class: "announcement", role: "status" });

  root.append(create("style", {}, css), highlight, markers, toolbar, composer, toast, announcement);
  return {
    highlight,
    highlightTag,
    markers,
    pick,
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
  };
};
