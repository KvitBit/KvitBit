import { Mount } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { matchesShortcut } from "@ui-sdk/core";
import { ariaKeyshortcuts, formatShortcut } from "@ui-sdk/core/shortcuts";
import { createToaster } from "@ui-sdk/web";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export { ariaKeyshortcuts, formatShortcut, matchesShortcut };

export const registerUiSdk = Effect.all(
  [
    Effect.promise(() => import("@ui-sdk/web/alert-dialog")),
    Effect.promise(() => import("@ui-sdk/web/button")),
    Effect.promise(() => import("@ui-sdk/web/checkbox")),
    Effect.promise(() => import("@ui-sdk/web/dialog")),
    Effect.promise(() => import("@ui-sdk/web/field")),
    Effect.promise(() => import("@ui-sdk/web/input")),
    Effect.promise(() => import("@ui-sdk/web/menu")),
    Effect.promise(() => import("@ui-sdk/web/segmented-control")),
    Effect.promise(() => import("@ui-sdk/web/select")),
    Effect.promise(() => import("@ui-sdk/web/separator")),
    Effect.promise(() => import("@ui-sdk/web/tabs")),
    Effect.promise(() => import("@ui-sdk/web/textarea")),
    Effect.promise(() => import("@ui-sdk/web/toast")),
    Effect.promise(() => import("@ui-sdk/web/toggle")),
  ],
  { concurrency: "unbounded", discard: true },
);

const ActionDetail = Schema.Struct({});
const OpenChangeDetail = Schema.Struct({ value: Schema.Boolean });
const StringValueChangeDetail = Schema.Struct({ value: Schema.String });
const NullableValueChangeDetail = Schema.Struct({ value: Schema.NullOr(Schema.String) });
const CheckedChangeDetail = Schema.Struct({
  value: Schema.Union([Schema.Boolean, Schema.Literal("indeterminate")]),
});
const PressedChangeDetail = Schema.Struct({ value: Schema.Boolean });

export const UiButton = Html.customElement({
  tag: "ui-button",
  properties: {
    disabled: Schema.Boolean,
    focusableWhenDisabled: Schema.Boolean,
    pendingAnnouncement: Schema.String,
  },
  events: {
    action: ActionDetail,
  },
});

export const UiField = Html.customElement({
  tag: "ui-field",
  properties: {
    name: Schema.String,
    disabled: Schema.Boolean,
    invalid: Schema.UndefinedOr(Schema.Boolean),
  },
});

export const UiFieldLabel = Html.customElement({ tag: "ui-field-label" });
export const UiFieldDescription = Html.customElement({ tag: "ui-field-description" });
export const UiFieldError = Html.customElement({
  tag: "ui-field-error",
  properties: {
    match: Schema.Union([Schema.Boolean, Schema.String]),
  },
});

export const UiInput = Html.customElement({
  tag: "ui-input",
  properties: { value: Schema.String },
  events: { valuechange: StringValueChangeDetail },
});

export const UiTextarea = Html.customElement({
  tag: "ui-textarea",
  properties: {
    value: Schema.String,
    autoResize: Schema.Boolean,
  },
  events: { valuechange: StringValueChangeDetail },
});

export const UiCheckbox = Html.customElement({
  tag: "ui-checkbox",
  properties: {
    checked: Schema.Union([Schema.Boolean, Schema.Literal("indeterminate")]),
    disabled: Schema.Boolean,
    name: Schema.String,
  },
  events: { checkedchange: CheckedChangeDetail },
});

export const UiCheckboxIndicator = Html.customElement({ tag: "ui-checkbox-indicator" });

export const UiSelect = Html.customElement({
  tag: "ui-select",
  properties: {
    value: Schema.NullOr(Schema.String),
    disabled: Schema.Boolean,
    name: Schema.String,
    placeholder: Schema.String,
  },
  events: {
    valuechange: NullableValueChangeDetail,
    openchange: OpenChangeDetail,
  },
});

export const UiSelectTrigger = Html.customElement({
  tag: "ui-select-trigger",
  properties: { disabled: Schema.Boolean },
});
export const UiSelectValue = Html.customElement({
  tag: "ui-select-value",
  properties: { placeholder: Schema.String },
});
export const UiSelectContent = Html.customElement({ tag: "ui-select-content" });
export const UiSelectList = Html.customElement({ tag: "ui-select-list" });
export const UiSelectInput = Html.customElement({ tag: "ui-select-input" });
export const UiSelectEmpty = Html.customElement({ tag: "ui-select-empty" });
export const UiSelectItem = Html.customElement({
  tag: "ui-select-item",
  properties: {
    value: Schema.String,
    label: Schema.String,
    disabled: Schema.Boolean,
  },
});
export const UiSelectItemText = Html.customElement({ tag: "ui-select-item-text" });
export const UiSelectItemIndicator = Html.customElement({ tag: "ui-select-item-indicator" });

export const UiSegmentedControl = Html.customElement({
  tag: "ui-segmented-control",
  properties: {
    value: Schema.NullOr(Schema.String),
    disabled: Schema.Boolean,
    name: Schema.String,
  },
  events: { valuechange: NullableValueChangeDetail },
});
export const UiSegmentedControlIndicator = Html.customElement({
  tag: "ui-segmented-control-indicator",
});
export const UiSegmentedControlItem = Html.customElement({
  tag: "ui-segmented-control-item",
  properties: {
    value: Schema.String,
    disabled: Schema.Boolean,
  },
});

export const UiTabs = Html.customElement({
  tag: "ui-tabs",
  properties: {
    value: Schema.NullOr(Schema.String),
    activation: Schema.Literals(["automatic", "manual"]),
  },
  events: { valuechange: NullableValueChangeDetail },
});
export const UiTabsList = Html.customElement({ tag: "ui-tabs-list" });
export const UiTabsTab = Html.customElement({
  tag: "ui-tabs-tab",
  properties: {
    value: Schema.String,
    disabled: Schema.Boolean,
  },
});
export const UiTabsIndicator = Html.customElement({ tag: "ui-tabs-indicator" });

export const UiDialog = Html.customElement({
  tag: "ui-dialog",
  properties: {
    open: Schema.Boolean,
    dismissible: Schema.Boolean,
  },
  events: { openchange: OpenChangeDetail },
});
export const UiDialogBackdrop = Html.customElement({ tag: "ui-dialog-backdrop" });
export const UiDialogContent = Html.customElement({ tag: "ui-dialog-content" });
export const UiDialogTitle = Html.customElement({ tag: "ui-dialog-title" });

export const UiAlertDialog = Html.customElement({
  tag: "ui-alert-dialog",
  properties: {
    open: Schema.Boolean,
    dismissible: Schema.Boolean,
  },
  events: { openchange: OpenChangeDetail },
});
export const UiAlertDialogBackdrop = Html.customElement({ tag: "ui-alert-dialog-backdrop" });
export const UiAlertDialogContent = Html.customElement({ tag: "ui-alert-dialog-content" });
export const UiAlertDialogTitle = Html.customElement({ tag: "ui-alert-dialog-title" });

export const UiMenu = Html.customElement({
  tag: "ui-menu",
  properties: {
    open: Schema.Boolean,
  },
  events: {
    openchange: OpenChangeDetail,
    action: Schema.Struct({ value: Schema.String }),
  },
});
export const UiMenuTrigger = Html.customElement({
  tag: "ui-menu-trigger",
  properties: {
    disabled: Schema.Boolean,
    shortcut: Schema.String,
  },
});
export const UiMenuContent = Html.customElement({ tag: "ui-menu-content" });
export const UiMenuItem = Html.customElement({
  tag: "ui-menu-item",
  properties: {
    value: Schema.String,
    label: Schema.String,
    disabled: Schema.Boolean,
    destructive: Schema.Boolean,
  },
});
export const UiMenuSeparator = Html.customElement({ tag: "ui-menu-separator" });

export const UiToggle = Html.customElement({
  tag: "ui-toggle",
  properties: {
    pressed: Schema.Boolean,
    disabled: Schema.Boolean,
  },
  events: { pressedchange: PressedChangeDetail },
});

export const UiSeparator = Html.customElement({
  tag: "ui-separator",
  properties: {
    orientation: Schema.Literals(["horizontal", "vertical"]),
    decorative: Schema.Boolean,
  },
});

export const UiToastRegion = Html.customElement({
  tag: "ui-toast-region",
  properties: {
    maxVisible: Schema.Finite,
    expanded: Schema.Boolean,
  },
});

const ToastEntry = Schema.Struct({
  id: Schema.Finite,
  text: Schema.String,
  tone: Schema.Literals(["info", "error"]),
});

export const SyncToasts = Mount.makeStream(
  "SyncToasts",
  {
    args: {
      toasts: Schema.Array(ToastEntry),
      dismissLabel: Schema.String,
    },
  },
  (node: HTMLElement, initial, changes) =>
    Stream.callback<number>(
      Effect.fn("SyncToasts.observe")(function* (queue) {
        const toaster = createToaster({ duration: 5000 });
        const active = new Map<number, string>();
        let disposed = false;

        // Defer property assignment until hydration finishes registering custom elements.
        const attach = () => {
          if (!disposed) Reflect.set(node, "toaster", toaster);
        };
        if (
          globalThis.customElements !== undefined &&
          globalThis.customElements.get("ui-toast-region") !== undefined
        ) {
          attach();
        } else if (globalThis.customElements !== undefined) {
          yield* Effect.promise(() =>
            globalThis.customElements.whenDefined("ui-toast-region"),
          ).pipe(
            Effect.tap(() => Effect.sync(attach)),
            Effect.forkScoped,
          );
        }

        const sync = (
          toasts: ReadonlyArray<{
            readonly id: number;
            readonly text: string;
            readonly tone: "info" | "error";
          }>,
          dismissLabel: string,
        ) => {
          const wanted = new Set(Arr.map(toasts, (t) => t.id));
          for (const [id, toastId] of active) {
            if (!wanted.has(id)) {
              active.delete(id);
              toaster.dismiss(toastId);
            }
          }
          const onDismiss = (id: number) => {
            if (active.delete(id) && !disposed) Queue.offerUnsafe(queue, id);
          };
          for (const toast of toasts) {
            if (active.has(toast.id)) continue;
            const toastId = `kb-toast-${toast.id}`;
            active.set(toast.id, toastId);
            const show = toast.tone === "error" ? toaster.error : toaster.info;
            show(toast.text, {
              id: toastId,
              cancel: { label: dismissLabel },
              onDismiss: () => onDismiss(toast.id),
            });
          }
        };

        sync(initial.toasts, initial.dismissLabel);

        yield* Effect.forkScoped(
          Stream.runForEach(changes, ({ toasts, dismissLabel }) =>
            Effect.sync(() => sync(toasts, dismissLabel)),
          ),
        );

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            disposed = true;
            active.clear();
            toaster.dismiss();
          }),
        );
      }),
    ),
);
