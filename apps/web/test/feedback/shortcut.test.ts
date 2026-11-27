import { describe, expect, test } from "bun:test";
import { type IKeyboardEventInit, Window } from "happy-dom";
import { isFeedbackShortcut } from "../../src/runtime/feedback/shortcut";

const fixture = () => {
  const window = new Window();
  // Use the emulated DOM at the browser API boundary.
  const document = window.document as unknown as Document;
  const keydown = (init: IKeyboardEventInit = {}): KeyboardEvent =>
    new window.KeyboardEvent("keydown", {
      key: "k",
      bubbles: true,
      composed: true,
      cancelable: true,
      ...init,
    }) as unknown as KeyboardEvent;
  return { document, keydown };
};

describe("feedback shortcut", () => {
  test("accepts bare k and Caps Lock K", () => {
    const { document, keydown } = fixture();
    expect(isFeedbackShortcut(keydown(), document)).toBe(true);
    expect(isFeedbackShortcut(keydown({ key: "K" }), document)).toBe(true);
  });

  test.each([
    { key: "j" },
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { shiftKey: true, key: "K" },
    { repeat: true },
    { isComposing: true },
  ])("ignores a key event with %j", (init) => {
    const { document, keydown } = fixture();
    expect(isFeedbackShortcut(keydown(init), document)).toBe(false);
  });

  test("ignores a key event already handled by another control", () => {
    const { document, keydown } = fixture();
    const event = keydown();
    event.preventDefault();
    expect(isFeedbackShortcut(event, document)).toBe(false);
  });

  test.each(["input", "textarea", "select"])("ignores a focused %s", (tag) => {
    const { document, keydown } = fixture();
    const control = document.createElement(tag);
    document.body.append(control);
    control.focus();
    expect(isFeedbackShortcut(keydown(), document)).toBe(false);
  });

  test.each(["textbox", "searchbox", "combobox"])("ignores a descendant of role %s", (role) => {
    const { document, keydown } = fixture();
    const control = document.createElement("div");
    control.setAttribute("role", role);
    const child = document.createElement("span");
    child.tabIndex = 0;
    control.append(child);
    document.body.append(control);
    child.focus();
    expect(isFeedbackShortcut(keydown(), document)).toBe(false);
  });

  test("ignores a focused descendant of a contenteditable element", () => {
    const { document, keydown } = fixture();
    const editor = document.createElement("div");
    editor.contentEditable = "plaintext-only";
    const child = document.createElement("span");
    child.tabIndex = 0;
    editor.append(child);
    document.body.append(editor);
    child.focus();
    expect(isFeedbackShortcut(keydown(), document)).toBe(false);
  });

  test("looks inside the composed path when the event target is a shadow host", () => {
    const { document, keydown } = fixture();
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    const textarea = document.createElement("textarea");
    root.append(textarea);
    document.body.append(host);
    const event = keydown();
    Object.defineProperties(event, {
      target: { value: host },
      composedPath: { value: () => [textarea, root, host, document.body, document] },
    });
    expect(isFeedbackShortcut(event, document)).toBe(false);
  });
});
