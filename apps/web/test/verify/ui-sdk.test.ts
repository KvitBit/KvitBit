import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { UiSchema } from "@effect/ui";
import { BrowserHost, Html, HtmlHydrate, HtmlServer } from "@effect/ui/html";
import { Effect, Schema } from "effect";
import { Window } from "happy-dom";
import {
  button,
  checkbox,
  dialog,
  segmented,
  select,
  selectField,
  separator,
  tabs,
  textArea,
  textField,
  toggleChip,
} from "../../src/ui/kit";
import { ariaKeyshortcuts, formatShortcut, matchesShortcut, registerUiSdk } from "../../src/ui/sdk";

const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

const HarnessModel = Schema.Struct({
  name: Schema.String,
  notes: Schema.String,
  status: Schema.String,
  mode: Schema.String,
  archived: Schema.Boolean,
  chipOn: Schema.Boolean,
  dialogOpen: Schema.Boolean,
  clicks: Schema.Number,
});

const HarnessMessage = UiSchema.TaggedEnum({
  ChangedName: { value: Schema.String },
  ChangedNotes: { value: Schema.String },
  ChangedStatus: { value: Schema.String },
  ChangedMode: { value: Schema.String },
  ToggledArchived: { checked: Schema.Boolean },
  ToggledChip: {},
  OpenedDialog: {},
  ClosedDialog: {},
  ClickedAction: {},
});

const Harness = Html.component({
  name: "UiSdkHarness",
  model: HarnessModel,
  message: HarnessMessage,
}).make({
  init: () => ({
    name: "Kvitbit",
    notes: "",
    status: "",
    mode: "elegant",
    archived: false,
    chipOn: false,
    dialogOpen: false,
    clicks: 0,
  }),
  update: ($, message) => {
    switch (message._tag) {
      case "ChangedName":
        return $.evolve({ name: message.value });
      case "ChangedNotes":
        return $.evolve({ notes: message.value });
      case "ChangedStatus":
        return $.evolve({ status: message.value });
      case "ChangedMode":
        return $.evolve({ mode: message.value });
      case "ToggledArchived":
        return $.evolve({ archived: message.checked });
      case "ToggledChip":
        return $.evolve({ chipOn: (v) => !v });
      case "OpenedDialog":
        return $.evolve({ dialogOpen: true });
      case "ClosedDialog":
        return $.evolve({ dialogOpen: false });
      case "ClickedAction":
        return $.evolve({ clicks: (n) => n + 1 });
    }
  },
  view: (h, model) =>
    h.div.children([
      textField(h, {
        id: "h-name",
        label: "Workspace name",
        value: model.name,
        onInput: (value) => HarnessMessage.ChangedName({ value }),
      }),
      textArea(h, {
        id: "h-notes",
        label: "Invoice notes",
        value: model.notes,
        onInput: (value) => HarnessMessage.ChangedNotes({ value }),
      }),
      selectField(h, {
        id: "h-status",
        label: "Document status",
        value: model.status,
        options: [
          { value: "", label: "All statuses" },
          { value: "draft", label: "Draft" },
          { value: "issued", label: "Issued" },
        ],
        onChange: (value) => HarnessMessage.ChangedStatus({ value }),
      }),
      select(h, {
        id: "h-bare-locale",
        label: "Language",
        value: "cs",
        options: [
          { value: "cs", label: "Čeština" },
          { value: "en", label: "English" },
        ],
        onChange: (value) => HarnessMessage.ChangedMode({ value }),
      }),
      segmented(h, {
        label: "Style profile",
        selected: model.mode,
        items: [
          { id: "elegant", label: "Elegant" },
          { id: "cozy", label: "Cozy" },
        ],
        onSelect: (value) => HarnessMessage.ChangedMode({ value }),
      }),
      checkbox(h, {
        id: "h-archived",
        label: "Show archived",
        checked: model.archived,
        onToggle: (checked) => HarnessMessage.ToggledArchived({ checked }),
      }),
      toggleChip(h, {
        label: "Unpaid only",
        pressed: model.chipOn,
        onPress: HarnessMessage.ToggledChip(),
      }),
      tabs(h, {
        label: "Document sections",
        selected: "preview",
        items: [
          { id: "preview", label: "Preview", href: "#preview" },
          { id: "payments", label: "Payments", href: "#payments" },
        ],
      }),
      separator(h),
      button(h, {
        label: "Save changes",
        variant: "primary",
        onClick: HarnessMessage.ClickedAction(),
      }),
      button(h, {
        label: "Open confirmation",
        onClick: HarnessMessage.OpenedDialog(),
      }),
      ...(model.dialogOpen
        ? [
            dialog(h, {
              id: "h-dialog",
              title: "Confirm action",
              alert: true,
              body: [h.p.children(["Proceed with archiving?"])],
              actions: [button(h, { label: "Cancel", onClick: HarnessMessage.ClosedDialog() })],
              onClose: HarnessMessage.ClosedDialog(),
            }),
          ]
        : []),
    ]),
});

describe("@ui-sdk/core and @ui-sdk/web integration", () => {
  let win: Window;
  const savedGlobals: Record<string, unknown> = {};
  const globalKeys = [
    "window",
    "document",
    "HTMLElement",
    "HTMLFieldSetElement",
    "HTMLFormElement",
    "HTMLInputElement",
    "HTMLSelectElement",
    "HTMLTextAreaElement",
    "HTMLButtonElement",
    "HTMLLabelElement",
    "HTMLAnchorElement",
    "HTMLMeterElement",
    "HTMLOutputElement",
    "HTMLProgressElement",
    "HTMLDialogElement",
    "HTMLTemplateElement",
    "SVGElement",
    "Element",
    "Node",
    "Text",
    "Comment",
    "CustomEvent",
    "Event",
    "KeyboardEvent",
    "MouseEvent",
    "PointerEvent",
    "MutationObserver",
    "HTMLSlotElement",
    "ShadowRoot",
    "CSS",
    "ResizeObserver",
    "customElements",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ] as const;

  beforeAll(() => {
    for (const key of globalKeys) {
      savedGlobals[key] = Reflect.get(globalThis, key);
    }
    win = new Window({ url: "http://localhost/" });
    const proto = win.HTMLElement.prototype as unknown as Record<string, unknown>;
    proto.attachInternals = function (this: Element) {
      return {
        form: this.closest?.("form") ?? null,
        labels: [],
        states: new Set(),
        validity: { valid: true },
        validationMessage: "",
        willValidate: true,
        setFormValue() {},
        setValidity() {},
        checkValidity: () => true,
        reportValidity: () => true,
      };
    };
    proto.showPopover = () => {};
    proto.hidePopover = () => {};
    const elProto = win.Element.prototype as unknown as Record<string, unknown>;
    elProto.getAnimations = () => [];
    elProto.scrollIntoView = () => {};
    elProto.checkVisibility = () => true;
    const doc = win.document as unknown as Record<string, unknown>;
    doc.elementFromPoint = () => null;
    doc.elementsFromPoint = () => [];

    Object.assign(globalThis, {
      window: win,
      document: win.document,
      HTMLElement: win.HTMLElement,
      HTMLFieldSetElement: win.HTMLFieldSetElement,
      HTMLFormElement: win.HTMLFormElement,
      HTMLInputElement: win.HTMLInputElement,
      HTMLSelectElement: win.HTMLSelectElement,
      HTMLTextAreaElement: win.HTMLTextAreaElement,
      HTMLButtonElement: win.HTMLButtonElement,
      HTMLLabelElement: win.HTMLLabelElement,
      HTMLAnchorElement: win.HTMLAnchorElement,
      HTMLMeterElement: win.HTMLMeterElement,
      HTMLOutputElement: win.HTMLOutputElement,
      HTMLProgressElement: win.HTMLProgressElement,
      HTMLDialogElement: win.HTMLDialogElement,
      HTMLTemplateElement: win.HTMLTemplateElement,
      SVGElement: win.SVGElement,
      Element: win.Element,
      Node: win.Node,
      Text: win.Text,
      Comment: win.Comment,
      CustomEvent: win.CustomEvent,
      Event: win.Event,
      KeyboardEvent: win.KeyboardEvent,
      MouseEvent: win.MouseEvent,
      PointerEvent: win.MouseEvent,
      MutationObserver: win.MutationObserver,
      HTMLSlotElement: win.HTMLSlotElement,
      ShadowRoot: win.ShadowRoot,
      CSS: { escape: (s: string) => s.replace(/([^\w-])/g, "\\$1"), supports: () => false },
      ResizeObserver: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
      customElements: win.customElements,
      getComputedStyle: win.getComputedStyle.bind(win),
      requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
      cancelAnimationFrame: clearTimeout,
    });
  });

  afterAll(() => {
    for (const key of globalKeys) {
      if (savedGlobals[key] === undefined) {
        Reflect.deleteProperty(globalThis, key);
      } else {
        Reflect.set(globalThis, key, savedGlobals[key]);
      }
    }
  });

  test("@ui-sdk/core shortcut helpers match and format mod+k", () => {
    expect(ariaKeyshortcuts("mod+k")).toMatch(/K/);
    expect(formatShortcut("mod+k").length).toBeGreaterThan(0);
    const ev = new win.KeyboardEvent("keydown", { key: "k", ctrlKey: true });
    expect(matchesShortcut(ev as unknown as KeyboardEvent, "mod+k")).toBe(true);
    const plain = new win.KeyboardEvent("keydown", { key: "k" });
    expect(matchesShortcut(plain as unknown as KeyboardEvent, "mod+k")).toBe(false);
  });

  test("hydrates SSR custom elements in place and upgrades them without node replacement", async () => {
    const rendered = await Effect.runPromise(HtmlServer.renderToHtml(Harness, {}));
    expect(rendered.html).toContain("<ui-field");
    expect(rendered.html).toContain("<ui-select");
    expect(rendered.html).toContain("<ui-segmented-control");
    expect(rendered.html).toContain("<ui-checkbox");
    expect(rendered.html).toContain("<ui-tabs");
    expect(rendered.html).toContain("<ui-button");
    expect(rendered.html).toContain("<ui-separator");

    const container = win.document.createElement("div");
    container.append(win.document.createRange().createContextualFragment(rendered.html));
    win.document.body.appendChild(container);
    const serverLocale = container.querySelector("#h-bare-locale");
    const serverCheckbox = container.querySelector("#h-archived");

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const root = yield* HtmlHydrate.hydrateEffect(
              Harness,
              {},
              container as unknown as Element,
              rendered.state,
            );
            yield* root.adopted;
            yield* Effect.promise(() => registerUiSdk());
            yield* Effect.promise(() => tick(30));

            expect(container.querySelector("#h-bare-locale")).toBe(serverLocale);
            expect(container.querySelector("#h-archived")).toBe(serverCheckbox);
            expect(serverCheckbox?.getAttribute("role")).toBe("checkbox");
            expect(container.querySelector("ui-segmented-control")?.getAttribute("role")).toBe(
              "radiogroup",
            );

            (serverCheckbox as unknown as HTMLElement).click();
            yield* Effect.promise(() => tick(25));
            expect(root.model()?.archived).toBe(true);
          }),
        ),
      );
    } finally {
      container.remove();
    }
  });

  test("agent discovers every named control and drives TEA state changes", async () => {
    await registerUiSdk();
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const { createAgent } = await import("@ui-sdk/web/agent");
    const agent = createAgent();

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const root = yield* BrowserHost.mountEffect(
              Harness,
              {},
              container as unknown as Element,
            );
            yield* Effect.promise(() => tick(35));

            const snapshot = agent
              .snapshot()
              .filter((entry) => !entry.offPage && entry.component !== "more");
            const labels = snapshot.map((entry) => entry.label);
            for (const required of [
              "Workspace name",
              "Invoice notes",
              "Document status",
              "Language",
              "Style profile",
              "Show archived",
              "Unpaid only",
              "Save changes",
            ]) {
              expect(labels, `${required} missing from agent snapshot`).toContain(required);
            }

            const result = yield* Effect.promise(() =>
              agent.act({
                steps: [
                  { ref: "Workspace name", action: "setValue", args: ["Novak Studio"] },
                  { ref: "Invoice notes", action: "setValue", args: ["Net 14"] },
                  { ref: "Document status", action: "setValue", args: ["Issued"] },
                  { ref: "Document status", action: "setValue", args: ["All statuses"] },
                  { ref: "Style profile", action: "setValue", args: ["Cozy"] },
                  { ref: "Show archived", action: "setChecked", args: [true] },
                  { ref: "Unpaid only", action: "toggle" },
                  { ref: "Save changes", action: "press" },
                ],
              }),
            );
            yield* Effect.promise(() => tick(30));

            expect(result.ok, result.error?.message).toBe(true);
            expect(root.model()).toMatchObject({
              name: "Novak Studio",
              notes: "Net 14",
              status: "",
              mode: "cozy",
              archived: true,
              chipOn: true,
              clicks: 1,
            });
          }),
        ),
      );
    } finally {
      container.remove();
    }
  });
});
