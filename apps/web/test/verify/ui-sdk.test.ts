import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { UiSchema } from "@effect/ui";
import { BrowserHost, Html, HtmlHydrate, HtmlServer } from "@effect/ui/html";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
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

const matchPattern = /K/;

const HarnessModel = Schema.Struct({
  name: Schema.String,
  notes: Schema.String,
  status: Schema.String,
  mode: Schema.String,
  archived: Schema.Boolean,
  chipOn: Schema.Boolean,
  dialogOpen: Schema.Boolean,
  clicks: Schema.Finite,
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
  const savedGlobals = new Map<PropertyKey, typeof Schema.Unknown.Type>();
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
      savedGlobals.set(key, Reflect.get(globalThis, key));
    }
    win = new Window({ url: "http://localhost/" });
    const proto = win.HTMLElement.prototype;
    Reflect.set(proto, "attachInternals", function (this: Element) {
      return {
        form: this.closest?.("form") ?? null,
        labels: [],
        states: new Set(),
        validity: { valid: true },
        validationMessage: "",
        willValidate: true,
        setFormValue: () => undefined,
        setValidity: () => undefined,
        checkValidity: () => true,
        reportValidity: () => true,
      };
    });
    Reflect.set(proto, "showPopover", () => undefined);
    Reflect.set(proto, "hidePopover", () => undefined);
    const elProto = win.Element.prototype;
    Reflect.set(elProto, "getAnimations", () => []);
    Reflect.set(elProto, "scrollIntoView", () => undefined);
    Reflect.set(elProto, "checkVisibility", () => true);
    Reflect.set(win.document, "elementFromPoint", () => null);
    Reflect.set(win.document, "elementsFromPoint", () => []);

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
      CSS: { escape: (s: string) => Str.replace(/([^\w-])/g, "\\$1")(s), supports: () => false },
      ResizeObserver: class {
        observe = () => undefined;
        unobserve = () => undefined;
        disconnect = () => undefined;
      },
      customElements: win.customElements,
      getComputedStyle: win.getComputedStyle.bind(win),
      requestAnimationFrame: win.requestAnimationFrame.bind(win),
      cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    });
  });

  afterAll(() => {
    for (const key of globalKeys) {
      if (savedGlobals.get(key) === undefined) {
        Reflect.deleteProperty(globalThis, key);
      } else {
        Reflect.set(globalThis, key, savedGlobals.get(key));
      }
    }
  });

  test("@ui-sdk/core shortcut helpers match and format mod+k", () => {
    expect(ariaKeyshortcuts("mod+k")).toMatch(matchPattern);
    expect(formatShortcut("mod+k").length).toBeGreaterThan(0);
    const ev = new KeyboardEvent("keydown", { key: "k", ctrlKey: true });
    expect(matchesShortcut(ev, "mod+k")).toBe(true);
    const plain = new KeyboardEvent("keydown", { key: "k" });
    expect(matchesShortcut(plain, "mod+k")).toBe(false);
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

    const container = document.createElement("div");
    container.append(document.createRange().createContextualFragment(rendered.html));
    document.body.appendChild(container);
    const serverLocale = container.querySelector("#h-bare-locale");
    const serverCheckbox = container.querySelector<HTMLElement>("#h-archived");

    try {
      await Effect.gen(function* () {
        const root = yield* HtmlHydrate.hydrateEffect(Harness, {}, container, rendered.state);
        yield* root.adopted;
        yield* registerUiSdk;
        yield* Effect.sleep(30);
        expect(container.querySelector("#h-bare-locale")).toBe(serverLocale);
        expect(container.querySelector("#h-archived")).toBe(serverCheckbox);
        expect(serverCheckbox?.getAttribute("role")).toBe("checkbox");
        expect(container.querySelector("ui-segmented-control")?.getAttribute("role")).toBe(
          "radiogroup",
        );
        if (serverCheckbox === null) throw new Error("Expected the server checkbox");
        serverCheckbox.click();
        yield* Effect.sleep(25);
        expect(root.model()?.archived).toBe(true);
      }).pipe(Effect.scoped, Effect.runPromise);
    } finally {
      container.remove();
    }
  });

  test("agent discovers every named control and drives TEA state changes", async () => {
    await Effect.runPromise(registerUiSdk);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { createAgent } = await import("@ui-sdk/web/agent");
    const agent = createAgent();

    try {
      await Effect.gen(function* () {
        const root = yield* BrowserHost.mountEffect(Harness, {}, container);
        yield* Effect.sleep(35);
        const snapshot = Arr.filter(
          agent.snapshot(),
          (entry) => !(entry.offPage !== undefined) && entry.component !== "more",
        );
        const labels = Arr.map(snapshot, (entry) => entry.label);
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
        yield* Effect.sleep(30);
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
      }).pipe(Effect.scoped, Effect.runPromise);
    } finally {
      container.remove();
    }
  });
});
