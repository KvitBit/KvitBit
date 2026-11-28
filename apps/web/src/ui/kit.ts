import type { Html } from "@effect/ui/html";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { type Attribute, type Markup, withAttributes } from "./html";
import { icon } from "./icons";
import {
  UiAlertDialog,
  UiAlertDialogBackdrop,
  UiAlertDialogContent,
  UiAlertDialogTitle,
  UiButton,
  UiCheckbox,
  UiCheckboxIndicator,
  UiDialog,
  UiDialogBackdrop,
  UiDialogContent,
  UiDialogTitle,
  UiField,
  UiFieldDescription,
  UiFieldError,
  UiFieldLabel,
  UiInput,
  UiSegmentedControl,
  UiSegmentedControlIndicator,
  UiSegmentedControlItem,
  UiSelect,
  UiSelectContent,
  UiSelectEmpty,
  UiSelectInput,
  UiSelectItem,
  UiSelectItemIndicator,
  UiSelectItemText,
  UiSelectList,
  UiSelectTrigger,
  UiSelectValue,
  UiSeparator,
  UiTabs,
  UiTabsIndicator,
  UiTabsList,
  UiTabsTab,
  UiTextarea,
  UiToggle,
} from "./sdk";
import {
  badgeVariants,
  bannerVariants,
  buttonVariants,
  cardVariants,
  chipVariants,
  cn,
  controlVariants,
  segmentedButtonVariants,
  ui,
} from "./styles";

/**
 * Shared view helpers over Effect UI’s `h` builder and `@ui-sdk/web` custom elements. Pages
 * compose these instead of re-styling raw elements, so every control carries the same Tailwind v4
 * + CVA Material 3 roles, keyboard/focus behavior, ARIA attributes, and agent discoverability.
 * Helpers take already-translated strings; money and dates come pre-formatted from
 * @kvitbit/ui-port/format.
 */

type Attrs = ReadonlyArray<Attribute>;
type Child<M> = Markup<M> | string;

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonOptions<M> {
  readonly label: string;
  readonly onClick?: M | undefined;
  readonly variant?: ButtonVariant;
  readonly small?: boolean;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly type?: "button" | "submit";
  readonly icon?: Markup<M>;
  readonly ariaLabel?: string;
  readonly testId?: string;
  readonly className?: string;
}

const buttonImpl = <M>(h: Html.H<M>, o: ButtonOptions<M>): Markup<M> => {
  const variant = o.variant ?? "secondary";
  const inactive = o.disabled === true || o.busy === true;
  return withAttributes(
    UiButton(h)
      .class()
      .disabled(o.disabled === true)
      .focusableWhenDisabled(o.busy === true),
    [
      (node) => (o.disabled === true ? node.attr("disabled", "") : node),
      (node) => (o.busy === true ? node.attr("focusable-when-disabled", "") : node),
      (node) => (o.onClick === undefined || inactive ? node : node.on("action", o.onClick)),
    ],
  ).children([
    withAttributes(h.button.class(), [
      (element) =>
        element.class(
          cn(
            buttonVariants({
              variant,
              size: o.small === true ? "small" : "default",
            }),
            o.className,
          ),
        ),
      (element) => element.attr("data-variant", variant),
      (element) => element.attr("type", o.type ?? "button"),
      (node) => (o.disabled === true ? node.disabled(true) : node),
      (node) => (o.busy === true ? node.attr("aria-busy", String(true)) : node),
      (node) => (o.ariaLabel === undefined ? node : node.attr("aria-label", o.ariaLabel)),
      (node) => (o.testId === undefined ? node : node.attr("data-testid", o.testId)),
    ]).children(o.icon === undefined ? [o.label] : [o.icon, o.label]),
  ]);
};

export const button: {
  <M>(o: ButtonOptions<M>): (h: Html.H<M>) => Markup<M>;
  <M>(h: Html.H<M>, o: ButtonOptions<M>): Markup<M>;
} = Fn.dual(2, buttonImpl);

/** An in-app link styled as a button; the Shell intercepts the click (internal navigation). */
const linkButtonImpl = <M>(
  h: Html.H<M>,
  o: {
    readonly label: string;
    readonly href: string;
    readonly variant?: ButtonVariant;
    readonly small?: boolean;
    readonly className?: string;
  },
): Markup<M> => {
  const variant = o.variant ?? "secondary";
  return UiButton(h).children([
    h.a
      .class(
        cn(
          buttonVariants({
            variant,
            size: o.small === true ? "small" : "default",
          }),
          o.className,
        ),
      )
      .attr("data-variant", variant)
      .attr("href", o.href)
      .children([o.label]),
  ]);
};

export const linkButton: {
  <M>(o: {
    readonly label: string;
    readonly href: string;
    readonly variant?: ButtonVariant;
    readonly small?: boolean;
    readonly className?: string;
  }): (h: Html.H<M>) => Markup<M>;
  <M>(
    h: Html.H<M>,
    o: {
      readonly label: string;
      readonly href: string;
      readonly variant?: ButtonVariant;
      readonly small?: boolean;
      readonly className?: string;
    },
  ): Markup<M>;
} = Fn.dual(2, linkButtonImpl);

export interface FieldOptions<M> {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onInput: (value: string) => M;
  readonly onPaste?: (text: string) => M | undefined;
  readonly type?: string;
  readonly placeholder?: string;
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly mono?: boolean;
  readonly autocomplete?: string;
  readonly inputMode?: string;
}

const fieldShell = <M>(
  h: Html.H<M>,
  o: {
    id: string;
    label: string;
    hint?: string;
    error?: string | undefined;
    disabled?: boolean;
  },
  control: Markup<M>,
): Markup<M> =>
  withAttributes(
    UiField(h)
      .class(ui.field)
      .attr("data-slot", "field")
      .name(o.id)
      .attr("name", o.id)
      .disabled(o.disabled === true)
      .invalid(o.error !== undefined ? true : undefined),
    [
      (node) => (o.disabled === true ? node.attr("disabled", "") : node),
      (node) => (o.error !== undefined ? node.attr("invalid", "") : node),
    ],
  ).children([
    UiFieldLabel(h).class(ui.fieldLabel).children([o.label]),
    control,
    ...(o.error !== undefined
      ? [
          UiFieldError(h)
            .class(ui.fieldError)
            .id(`${o.id}-error`)
            .match(true)
            .attr("match", "true")
            .attr("role", "alert")
            .children([o.error]),
        ]
      : o.hint !== undefined
        ? [UiFieldDescription(h).class(ui.fieldHint).id(`${o.id}-hint`).children([o.hint])]
        : []),
  ]);

const textFieldImpl = <M>(h: Html.H<M>, o: FieldOptions<M>): Markup<M> =>
  fieldShell(
    h,
    o,
    UiInput(h)
      .value(o.value)
      .on("valuechange", ({ value }) => (value === o.value ? undefined : o.onInput(value)))
      .children([
        withAttributes(h.input.class(), [
          (element) =>
            element.class(cn(controlVariants({ kind: "input" }), o.mono === true && ui.mono)),
          (element) => element.id(o.id),
          (element) => element.attr("name", o.id),
          (element) => element.attr("type", o.type ?? "text"),
          (element) => element.value(o.value),
          (element) =>
            element.on("input", ({ value }) => (value === o.value ? undefined : o.onInput(value))),
          (node) =>
            o.onPaste === undefined
              ? node
              : node.on("paste", ({ text }) => o.onPaste?.(text), { preventDefault: true }),
          (node) => (o.placeholder === undefined ? node : node.attr("placeholder", o.placeholder)),
          (node) => (o.required === true ? node.attr("required", "") : node),
          (node) => (o.disabled === true ? node.disabled(true) : node),
          (node) =>
            o.autocomplete === undefined ? node : node.attr("autocomplete", o.autocomplete),
          (node) => (o.inputMode === undefined ? node : node.attr("inputmode", o.inputMode)),
          (node) =>
            o.error === undefined
              ? node
              : node.attr("aria-invalid", String(true)).attr("aria-describedby", `${o.id}-error`),
        ]),
      ]),
  );

export const textField: {
  <M>(o: FieldOptions<M>): (h: Html.H<M>) => Markup<M>;
  <M>(h: Html.H<M>, o: FieldOptions<M>): Markup<M>;
} = Fn.dual(2, textFieldImpl);

const textAreaImpl = <M>(h: Html.H<M>, o: FieldOptions<M>): Markup<M> =>
  fieldShell(
    h,
    o,
    UiTextarea(h)
      .value(o.value)
      .on("valuechange", ({ value }) => (value === o.value ? undefined : o.onInput(value)))
      .children([
        withAttributes(h.textarea.class(), [
          (element) => element.class(controlVariants({ kind: "textarea" })),
          (element) => element.id(o.id),
          (element) => element.attr("name", o.id),
          (element) => element.value(o.value),
          (element) =>
            element.on("input", ({ value }) => (value === o.value ? undefined : o.onInput(value))),
          (node) =>
            o.onPaste === undefined
              ? node
              : node.on("paste", ({ text }) => o.onPaste?.(text), { preventDefault: true }),
          (node) => (o.placeholder === undefined ? node : node.attr("placeholder", o.placeholder)),
          (node) => (o.disabled === true ? node.disabled(true) : node),
          (node) => (o.error === undefined ? node : node.attr("aria-invalid", String(true))),
        ]),
      ]),
  );

export const textArea: {
  <M>(o: FieldOptions<M>): (h: Html.H<M>) => Markup<M>;
  <M>(h: Html.H<M>, o: FieldOptions<M>): Markup<M>;
} = Fn.dual(2, textAreaImpl);

interface SelectEntry {
  readonly value: string;
  readonly label: string;
}

interface SelectOptions<M, Options extends ReadonlyArray<SelectEntry>> {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly options: Options;
  readonly onChange: (value: NoInfer<Options[number]["value"]>) => M;
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly disabled?: boolean;
  readonly compact?: boolean;
  readonly searchable?: boolean;
  readonly searchPlaceholder?: string;
  readonly emptyText?: string;
  readonly className?: string;
}

// @ui-sdk/web/select treats value="" as absent; encode empty-string options with a stable sentinel.
const EMPTY_SELECT_VALUE = "__kb_empty__";
const encodeSelectValue = (value: string): string => (value === "" ? EMPTY_SELECT_VALUE : value);
const decodeSelectValue = (value: string | null): string =>
  value === null || value === EMPTY_SELECT_VALUE ? "" : value;

const selectFieldImpl = <M, const Options extends ReadonlyArray<SelectEntry>>(
  h: Html.H<M>,
  o: SelectOptions<M, Options>,
): Markup<M> => fieldShell(h, o, select(h, o));

export const selectField: {
  <M, const Options extends ReadonlyArray<SelectEntry>>(
    o: SelectOptions<M, Options>,
  ): (h: Html.H<M>) => Markup<M>;
  <M, const Options extends ReadonlyArray<SelectEntry>>(
    h: Html.H<M>,
    o: SelectOptions<M, Options>,
  ): Markup<M>;
} = Fn.dual(2, selectFieldImpl);

/** A bare select (no label wrapper), e.g. for toolbars. Needs an accessible name via `label`. */
const selectImpl = <M, const Options extends ReadonlyArray<SelectEntry>>(
  h: Html.H<M>,
  o: SelectOptions<M, Options>,
): Markup<M> => {
  const encoded = encodeSelectValue(o.value);
  const current = Option.getOrUndefined(
    Arr.findFirst(o.options, (option) => option.value === o.value),
  );
  const items = Arr.map<ReadonlyArray<SelectEntry>, Markup<M>>(o.options, (option) => {
    const itemValue = encodeSelectValue(option.value);
    return UiSelectItem(h)
      .key(itemValue)
      .class(
        "flex cursor-pointer select-none items-center justify-between gap-2 rounded-[calc(var(--kb-shape-control)-2px)] px-2.5 py-[7px] text-[0.875rem] text-on-surface data-[disabled]:cursor-not-allowed data-[highlighted]:bg-surface-container data-[selected]:font-medium data-[selected]:text-primary data-[disabled]:opacity-45",
      )
      .value(itemValue)
      .label(option.label)
      .attr("value", itemValue)
      .attr("label", option.label)
      .children([
        UiSelectItemText(h).children([option.label]),
        UiSelectItemIndicator(h)
          .class("inline-flex flex-none text-primary")
          .children([icon(h, "check", 14)]),
      ]);
  });

  return withAttributes(
    UiSelect(h)
      .class(cn("block min-w-0", o.compact === true ? "w-auto" : "w-full", o.className))
      .attr("data-slot", "select")
      .id(o.id)
      .name(o.id)
      .attr("name", o.id)
      .value(encoded)
      .attr("value", encoded)
      .disabled(o.disabled === true),
    [
      (node) => (o.disabled === true ? node.attr("disabled", "") : node),
      (node) =>
        node.on("valuechange", ({ value }) => {
          const decoded = decodeSelectValue(value);
          const match = Option.getOrUndefined(
            Arr.findFirst(o.options, (entry) => entry.value === decoded),
          );
          return decoded === o.value || match === undefined ? undefined : o.onChange(match.value);
        }),
    ],
  ).children([
    UiSelectTrigger(h).children([
      withAttributes(h.button.class(), [
        (element) =>
          element.class(
            cn(
              controlVariants({ kind: "select", compact: o.compact === true }),
              "group inline-flex cursor-pointer items-center justify-between gap-2 text-left",
            ),
          ),
        (element) => element.attr("type", "button"),
        (element) => element.attr("aria-label", o.label),
        (node) => (o.disabled === true ? node.disabled(true) : node),
        (node) => (o.error === undefined ? node : node.attr("aria-invalid", String(true))),
      ]).children([
        UiSelectValue(h)
          .class("overflow-hidden text-ellipsis whitespace-nowrap")
          .children([current?.label ?? ""]),
        h.span
          .class(
            "inline-flex flex-none text-on-surface-variant transition-transform duration-150 ease-out group-data-[open]:rotate-180",
          )
          .attr("aria-hidden", "true")
          .children([icon(h, "chevron", 14)]),
      ]),
    ]),
    UiSelectContent(h)
      .class(
        "max-h-[min(320px,var(--available-height,320px))] min-w-[max(var(--anchor-width,160px),160px)] overflow-auto rounded-control border border-outline-variant bg-surface-container-lowest p-1 text-on-surface shadow-[0_8px_24px_-12px_color-mix(in_srgb,var(--md-sys-color-shadow)_40%,transparent)]",
      )
      .attr("side-offset", "4")
      .attr("hidden", "")
      .children([
        ...(o.searchable === true
          ? [
              UiSelectInput(h)
                .class("block px-0.5 pt-0.5 pb-1.5")
                .children([
                  h.input
                    .class(controlVariants({ kind: "input", compact: true }))
                    .attr("type", "search")
                    .attr("aria-label", o.searchPlaceholder ?? o.label)
                    .attr("placeholder", o.searchPlaceholder ?? o.label),
                ]),
              UiSelectEmpty(h)
                .class("block px-2.5 py-2 text-center text-[0.8125rem] text-on-surface-variant")
                .children([o.emptyText ?? "—"]),
            ]
          : []),
        UiSelectList(h).class("flex flex-col gap-px").children(items),
      ]),
  ]);
};

export const select: {
  <M, const Options extends ReadonlyArray<SelectEntry>>(
    o: SelectOptions<M, Options>,
  ): (h: Html.H<M>) => Markup<M>;
  <M, const Options extends ReadonlyArray<SelectEntry>>(
    h: Html.H<M>,
    o: SelectOptions<M, Options>,
  ): Markup<M>;
} = Fn.dual(2, selectImpl);

const checkboxImpl = <M>(
  h: Html.H<M>,
  o: {
    readonly id: string;
    readonly label: string;
    readonly checked: boolean;
    readonly onToggle: (checked: boolean) => M;
    readonly disabled?: boolean;
  },
): Markup<M> =>
  h.label.class("inline-flex cursor-pointer items-center gap-2").children([
    withAttributes(
      UiCheckbox(h)
        .class(
          "group inline-flex h-[18px] w-[18px] flex-none cursor-pointer items-center justify-center rounded-[4px] border-[1.5px] border-outline bg-surface-container-lowest text-on-primary transition-[background-color,border-color] duration-120 ease-out aria-[checked=true]:border-primary aria-[checked=true]:bg-primary data-[checked]:border-primary data-[checked]:bg-primary data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45",
        )
        .id(o.id)
        .checked(o.checked)
        .disabled(o.disabled === true)
        .attr("checked", o.checked ? "" : undefined)
        .attr("role", "checkbox")
        .attr("aria-checked", String(o.checked))
        .attr("aria-labelledby", `${o.id}-label`),
      [
        (node) => (o.disabled === true ? node.attr("disabled", "") : node),
        (node) =>
          node.on("checkedchange", ({ value }) => {
            const next = value === true;
            return next === o.checked ? undefined : o.onToggle(next);
          }),
      ],
    ).children([
      UiCheckboxIndicator(h)
        .class(
          "hidden items-center justify-center group-aria-[checked=true]:inline-flex group-data-[checked]:inline-flex",
        )
        .children([icon(h, "check", 12)]),
    ]),
    h.span.id(`${o.id}-label`).children([o.label]),
  ]);

export const checkbox: {
  <M>(o: {
    readonly id: string;
    readonly label: string;
    readonly checked: boolean;
    readonly onToggle: (checked: boolean) => M;
    readonly disabled?: boolean;
  }): (h: Html.H<M>) => Markup<M>;
  <M>(
    h: Html.H<M>,
    o: {
      readonly id: string;
      readonly label: string;
      readonly checked: boolean;
      readonly onToggle: (checked: boolean) => M;
      readonly disabled?: boolean;
    },
  ): Markup<M>;
} = Fn.dual(2, checkboxImpl);

export type BadgeTone = "neutral" | "paid" | "proforma" | "overdue" | "draft" | "error" | "outline";

const badgeImpl = <M>(h: Html.H<M>, label: string, tone: BadgeTone = "neutral"): Markup<M> =>
  h.span.class(badgeVariants({ tone })).children([label]);

export const badge: {
  <M>(label: string, tone?: BadgeTone): (h: Html.H<M>) => Markup<M>;
  <M>(h: Html.H<M>, label: string, tone?: BadgeTone): Markup<M>;
} = Fn.dual((args) => Predicate.isObject(args[0]), badgeImpl);

const cardImpl = <M>(
  h: Html.H<M>,
  children: ReadonlyArray<Child<M>>,
  attrs: Attrs = [],
  flat = false,
  className?: string,
): Markup<M> =>
  withAttributes(h.section.class(), [
    (element) => element.class(cn(cardVariants({ flat }), className)),
    (element) => element.attr("data-slot", "card"),
    ...attrs,
  ]).children(children);

export const card: {
  <M>(
    children: ReadonlyArray<Child<M>>,
    attrs?: Attrs,
    flat?: boolean,
    className?: string,
  ): (h: Html.H<M>) => Markup<M>;
  <M>(
    h: Html.H<M>,
    children: ReadonlyArray<Child<M>>,
    attrs?: Attrs,
    flat?: boolean,
    className?: string,
  ): Markup<M>;
} = Fn.dual((args) => !Arr.isArray(args[0]), cardImpl);

const cardTitleImpl = <M>(
  h: Html.H<M>,
  title: string,
  actions: ReadonlyArray<Child<M>> = [],
): Markup<M> =>
  h.div
    .class("mb-3 flex items-center justify-between gap-2")
    .attr("data-slot", "card-title")
    .children([
      h.h2.children([title]),
      ...(actions.length === 0 ? [] : [h.div.class(ui.row).children(actions)]),
    ]);

export const cardTitle: {
  <M>(title: string, actions?: ReadonlyArray<Child<M>>): (h: Html.H<M>) => Markup<M>;
  <M>(h: Html.H<M>, title: string, actions?: ReadonlyArray<Child<M>>): Markup<M>;
} = Fn.dual((args) => Predicate.isObject(args[0]), cardTitleImpl);

const pageImpl = <M>(
  h: Html.H<M>,
  children: ReadonlyArray<Child<M>>,
  attrs: Attrs = [],
): Markup<M> =>
  withAttributes(h.div.class(), [
    (element) =>
      element.class(
        "mx-auto flex w-full max-w-[1280px] flex-col gap-5 px-4 pt-4 pb-24 md:px-7 md:pt-6 md:pb-12",
      ),
    ...attrs,
  ]).children(children);

export const page: {
  <M>(children: ReadonlyArray<Child<M>>, attrs?: Attrs): (h: Html.H<M>) => Markup<M>;
  <M>(h: Html.H<M>, children: ReadonlyArray<Child<M>>, attrs?: Attrs): Markup<M>;
} = Fn.dual((args) => !Arr.isArray(args[0]), pageImpl);

const pageHeaderImpl = <M>(
  h: Html.H<M>,
  o: {
    readonly title: string;
    readonly subtitle?: string;
    readonly actions?: ReadonlyArray<Child<M>>;
    readonly eyebrow?: Markup<M>;
  },
): Markup<M> =>
  h.header
    .class("flex flex-wrap items-end justify-between gap-3")
    .children([
      h.div
        .class("flex flex-col gap-1")
        .children([
          ...(o.eyebrow === undefined ? [] : [o.eyebrow]),
          h.h1.children([o.title]),
          ...(o.subtitle === undefined ? [] : [h.p.class(ui.muted).children([o.subtitle])]),
        ]),
      ...(o.actions === undefined || o.actions.length === 0
        ? []
        : [h.div.class("flex flex-wrap gap-2").children(o.actions)]),
    ]);

export const pageHeader: {
  <M>(o: {
    readonly title: string;
    readonly subtitle?: string | undefined;
    readonly actions?: ReadonlyArray<Child<M>>;
    readonly eyebrow?: Markup<M>;
  }): (h: Html.H<M>) => Markup<M>;
  <M>(
    h: Html.H<M>,
    o: {
      readonly title: string;
      readonly subtitle?: string | undefined;
      readonly actions?: ReadonlyArray<Child<M>>;
      readonly eyebrow?: Markup<M>;
    },
  ): Markup<M>;
} = Fn.dual(2, pageHeaderImpl);

export interface Column<Row, M> {
  readonly header: string;
  readonly cell: (row: Row) => Child<M>;
  readonly align?: "start" | "end";
  readonly numeric?: boolean;
}

const tableImpl = <Row, M>(
  h: Html.H<M>,
  o: {
    readonly caption: string;
    readonly columns: ReadonlyArray<Column<Row, M>>;
    readonly rows: ReadonlyArray<Row>;
    readonly rowKey: (row: Row) => string;
    readonly onRowClick?: (row: Row) => M;
  },
): Markup<M> =>
  h.div
    .class(
      "overflow-x-auto rounded-panel border border-outline-variant bg-surface-container-lowest",
    )
    .children([
      h.table.class("w-full border-collapse text-[0.8125rem]").children([
        h.caption.class("sr-only").children([o.caption]),
        h.thead.children([
          h.tr.children(
            Arr.map(o.columns, (c) =>
              h.th
                .class(
                  cn(
                    "whitespace-nowrap border-b border-outline-variant bg-surface-container-low px-3 py-2 text-left text-[0.75rem] font-medium text-on-surface-variant",
                    c.align === "end" && "text-right",
                  ),
                )
                .attr("scope", "col")
                .children([c.header]),
            ),
          ),
        ]),
        h.tbody.children(
          Arr.map(o.rows, (row) =>
            withAttributes(
              h.tr
                .key(o.rowKey(row))
                .class(
                  cn(
                    "hover:bg-surface-container-low [&:last-child>td]:border-b-0",
                    o.onRowClick !== undefined && "cursor-pointer",
                  ),
                ),
              o.onRowClick === undefined
                ? []
                : [
                    (element) => element.on("click", () => o.onRowClick?.(row)),
                    (element) => element.attr("data-href", "1"),
                  ],
            ).children(
              Arr.map(o.columns, (c) =>
                h.td
                  .class(
                    cn(
                      "h-11 border-b border-outline-variant px-3 py-2.5 align-middle",
                      c.align === "end" && "text-right",
                      c.numeric === true && ui.num,
                    ),
                  )
                  .children([c.cell(row)]),
              ),
            ),
          ),
        ),
      ]),
    ]);

export const table: {
  <Row, M>(o: {
    readonly caption: string;
    readonly columns: ReadonlyArray<Column<Row, M>>;
    readonly rows: ReadonlyArray<Row>;
    readonly rowKey: (row: Row) => string;
    readonly onRowClick?: (row: Row) => M;
  }): (h: Html.H<M>) => Markup<M>;
  <Row, M>(
    h: Html.H<M>,
    o: {
      readonly caption: string;
      readonly columns: ReadonlyArray<Column<Row, M>>;
      readonly rows: ReadonlyArray<Row>;
      readonly rowKey: (row: Row) => string;
      readonly onRowClick?: (row: Row) => M;
    },
  ): Markup<M>;
} = Fn.dual(2, tableImpl);

/** A loading table that mirrors the loaded chrome (zero-CLS): same headers, same row height. */
const skeletonTableImpl = <M>(h: Html.H<M>, headers: ReadonlyArray<string>, rows = 6): Markup<M> =>
  h.div
    .class(
      "overflow-x-auto rounded-panel border border-outline-variant bg-surface-container-lowest",
    )
    .attr("aria-busy", String(true))
    .children([
      h.table.class("w-full border-collapse text-[0.8125rem]").children([
        h.thead.children([
          h.tr.children(
            Arr.map(headers, (x) =>
              h.th
                .class(
                  "whitespace-nowrap border-b border-outline-variant bg-surface-container-low px-3 py-2 text-left text-[0.75rem] font-medium text-on-surface-variant",
                )
                .attr("scope", "col")
                .children([x]),
            ),
          ),
        ]),
        h.tbody.children(
          Array.from({ length: rows }, (_, i) =>
            h.tr
              .key(`s${i}`)
              .class("[&:last-child>td]:border-b-0")
              .children(
                Arr.map(headers, () =>
                  h.td
                    .class("h-11 border-b border-outline-variant px-3 py-2.5 align-middle")
                    .children([h.span.class("kb-skeleton block w-[70%]").children(["\u00A0"])]),
                ),
              ),
          ),
        ),
      ]),
    ]);

export const skeletonTable: {
  <M>(headers: ReadonlyArray<string>, rows?: number): (h: Html.H<M>) => Markup<M>;
  <M>(h: Html.H<M>, headers: ReadonlyArray<string>, rows?: number): Markup<M>;
} = Fn.dual((args) => !Arr.isArray(args[0]), skeletonTableImpl);

const skeletonImpl = <M>(h: Html.H<M>, width = "100%", height = "1em"): Markup<M> =>
  h.span
    .class("kb-skeleton block")
    .style({ width, height })
    .attr("aria-hidden", String(true))
    .children(["\u00A0"]);

export const skeleton: {
  <M>(width?: string, height?: string): (h: Html.H<M>) => Markup<M>;
  <M>(h: Html.H<M>, width?: string, height?: string): Markup<M>;
} = Fn.dual((args) => Predicate.isObject(args[0]), skeletonImpl);

const emptyStateImpl = <M>(
  h: Html.H<M>,
  o: {
    readonly title: string;
    readonly body?: string;
    readonly action?: Markup<M> | undefined;
    readonly art?: Markup<M>;
  },
): Markup<M> =>
  h.div
    .class("flex flex-col items-center gap-2 px-4 py-12 text-center text-on-surface-variant")
    .children([
      ...(o.art === undefined ? [] : [o.art]),
      h.p.class("font-semibold text-on-surface").children([o.title]),
      ...(o.body === undefined ? [] : [h.p.children([o.body])]),
      ...(o.action === undefined ? [] : [o.action]),
    ]);

export const emptyState: {
  <M>(o: {
    readonly title: string;
    readonly body?: string;
    readonly action?: Markup<M> | undefined;
    readonly art?: Markup<M>;
  }): (h: Html.H<M>) => Markup<M>;
  <M>(
    h: Html.H<M>,
    o: {
      readonly title: string;
      readonly body?: string;
      readonly action?: Markup<M> | undefined;
      readonly art?: Markup<M>;
    },
  ): Markup<M>;
} = Fn.dual(2, emptyStateImpl);

const bannerImpl = <M>(
  h: Html.H<M>,
  o: {
    readonly text: string;
    readonly tone?: "neutral" | "error" | "info";
    readonly action?: Markup<M> | undefined;
  },
): Markup<M> =>
  h.div
    .class(bannerVariants({ tone: o.tone ?? "neutral" }))
    .attr("role", o.tone === "error" ? "alert" : "status")
    .children([
      h.span.class("flex-1").children([o.text]),
      ...(o.action === undefined ? [] : [o.action]),
    ]);

export const banner: {
  <M>(o: {
    readonly text: string;
    readonly tone?: "neutral" | "error" | "info";
    readonly action?: Markup<M> | undefined;
  }): (h: Html.H<M>) => Markup<M>;
  <M>(
    h: Html.H<M>,
    o: {
      readonly text: string;
      readonly tone?: "neutral" | "error" | "info";
      readonly action?: Markup<M> | undefined;
    },
  ): Markup<M>;
} = Fn.dual(2, bannerImpl);

const tabsImpl = <M>(
  h: Html.H<M>,
  o: {
    readonly label: string;
    readonly items: ReadonlyArray<{
      readonly id: string;
      readonly label: string;
      readonly href: string;
    }>;
    readonly selected: string;
  },
): Markup<M> =>
  UiTabs(h)
    .class("block")
    .value(o.selected)
    .attr("value", o.selected)
    .children([
      UiTabsList(h)
        .class("relative flex gap-0.5 overflow-x-auto border-b border-outline-variant")
        .attr("data-slot", "tabs")
        .attr("aria-label", o.label)
        .children([
          ...Arr.map(o.items, (it) =>
            UiTabsTab(h)
              .key(it.id)
              .value(it.id)
              .attr("value", it.id)
              .children([
                withAttributes(h.a.class(), [
                  (element) =>
                    element.class(
                      "-mb-px cursor-pointer whitespace-nowrap border-0 border-b-2 border-transparent bg-transparent px-3.5 py-2.5 font-medium text-on-surface-variant no-underline hover:text-on-surface aria-[selected=true]:text-on-surface data-[selected]:text-on-surface [&[aria-selected=true]:not([data-selected])]:border-b-primary",
                    ),
                  (element) => element.attr("href", it.href),
                  (element) => element.attr("aria-selected", String(it.id === o.selected)),
                  (node) => (it.id === o.selected ? node.attr("aria-current", "page") : node),
                ]).children([it.label]),
              ]),
          ),
          UiTabsIndicator(h).class(
            "pointer-events-none absolute bottom-0 left-[var(--active-tab-left,0)] h-0.5 w-[var(--active-tab-width,0)] bg-primary transition-[left,width] duration-[180ms] ease-out data-[activation-direction=none]:transition-none",
          ),
        ]),
    ]);

export const tabs: {
  <M>(o: {
    readonly label: string;
    readonly items: ReadonlyArray<{
      readonly id: string;
      readonly label: string;
      readonly href: string;
    }>;
    readonly selected: string;
  }): (h: Html.H<M>) => Markup<M>;
  <M>(
    h: Html.H<M>,
    o: {
      readonly label: string;
      readonly items: ReadonlyArray<{
        readonly id: string;
        readonly label: string;
        readonly href: string;
      }>;
      readonly selected: string;
    },
  ): Markup<M>;
} = Fn.dual(2, tabsImpl);

interface SegmentChoice {
  readonly id: string;
  readonly label: string;
}

interface SegmentedOptions<M, Items extends ReadonlyArray<SegmentChoice>> {
  readonly label: string;
  readonly items: Items;
  readonly selected: string;
  readonly onSelect: (id: NoInfer<Items[number]["id"]>) => M;
  readonly fill?: boolean;
  readonly sizing?: "equal" | "auto";
  readonly className?: string;
}

const segmentedImpl = <M, const Items extends ReadonlyArray<SegmentChoice>>(
  h: Html.H<M>,
  o: SegmentedOptions<M, Items>,
): Markup<M> =>
  UiSegmentedControl(h)
    .class(
      cn(
        "relative isolate inline-flex max-w-full overflow-hidden rounded-control border border-outline-variant bg-surface-container-lowest",
        o.fill === true && "w-full",
        o.className,
      ),
    )
    .attr("aria-label", o.label)
    .value(o.selected)
    .attr("value", o.selected)
    .on("valuechange", ({ value }) => {
      const item = Option.getOrUndefined(
        Arr.findFirst(o.items, (candidate) => candidate.id === value),
      );
      return item === undefined || item.id === o.selected ? undefined : o.onSelect(item.id);
    })
    .children([
      UiSegmentedControlIndicator(h).class(
        "pointer-events-none absolute top-[var(--segmented-control-indicator-top,0)] left-[var(--segmented-control-indicator-left,0)] -z-10 h-[var(--segmented-control-indicator-height,0)] w-[var(--segmented-control-indicator-width,0)] bg-primary-container transition-[top,left,width,height] duration-[180ms] ease-out data-[activation-direction=none]:transition-none",
      ),
      ...Arr.map<ReadonlyArray<SegmentChoice>, Markup<M>>(o.items, (it) =>
        UiSegmentedControlItem(h)
          .key(it.id)
          .class(segmentedButtonVariants({ sizing: o.sizing ?? "equal" }))
          .value(it.id)
          .attr("value", it.id)
          .attr("role", "radio")
          .attr("aria-checked", String(it.id === o.selected))
          .children([it.label]),
      ),
    ]);

export const segmented: {
  <M, const Items extends ReadonlyArray<SegmentChoice>>(
    o: SegmentedOptions<M, Items>,
  ): (h: Html.H<M>) => Markup<M>;
  <M, const Items extends ReadonlyArray<SegmentChoice>>(
    h: Html.H<M>,
    o: SegmentedOptions<M, Items>,
  ): Markup<M>;
} = Fn.dual(2, segmentedImpl);

const toggleChipImpl = <M>(
  h: Html.H<M>,
  o: {
    readonly label: string;
    readonly pressed: boolean;
    readonly onPress: M;
    readonly disabled?: boolean;
  },
): Markup<M> =>
  withAttributes(
    UiToggle(h)
      .pressed(o.pressed)
      .disabled(o.disabled === true)
      .attr("pressed", o.pressed ? "" : undefined),
    [
      (node) => (o.disabled === true ? node.attr("disabled", "") : node),
      (node) => (o.disabled === true ? node : node.on("pressedchange", () => o.onPress)),
    ],
  ).children([
    withAttributes(h.button.class(), [
      (element) => element.class(chipVariants({ active: o.pressed })),
      (element) => element.attr("type", "button"),
      (element) => element.attr("aria-pressed", String(o.pressed)),
      (node) => (o.disabled === true ? node.disabled(true) : node),
    ]).children([o.label]),
  ]);

export const toggleChip: {
  <M>(o: {
    readonly label: string;
    readonly pressed: boolean;
    readonly onPress: M;
    readonly disabled?: boolean;
  }): (h: Html.H<M>) => Markup<M>;
  <M>(
    h: Html.H<M>,
    o: {
      readonly label: string;
      readonly pressed: boolean;
      readonly onPress: M;
      readonly disabled?: boolean;
    },
  ): Markup<M>;
} = Fn.dual(2, toggleChipImpl);

const searchInputImpl = <M>(
  h: Html.H<M>,
  o: {
    readonly value: string;
    readonly placeholder: string;
    readonly onInput: (value: string) => M;
    readonly name?: string;
    readonly ariaLabel?: string;
    readonly className?: string;
    readonly inputClassName?: string;
  },
): Markup<M> =>
  UiInput(h)
    .class(cn("block w-full", o.className))
    .value(o.value)
    .on("valuechange", ({ value }) => o.onInput(value))
    .children([
      withAttributes(h.input.class(), [
        (element) => element.class(cn(controlVariants({ kind: "input" }), o.inputClassName)),
        (element) => element.attr("type", "search"),
        (element) => element.attr("placeholder", o.placeholder),
        (element) => element.attr("aria-label", o.ariaLabel ?? o.placeholder),
        (element) => element.value(o.value),
        (node) => (o.name === undefined ? node : node.attr("name", o.name)),
      ]),
    ]);

export const searchInput: {
  <M>(o: {
    readonly value: string;
    readonly placeholder: string;
    readonly onInput: (value: string) => M;
    readonly name?: string;
    readonly ariaLabel?: string;
    readonly className?: string;
    readonly inputClassName?: string;
  }): (h: Html.H<M>) => Markup<M>;
  <M>(
    h: Html.H<M>,
    o: {
      readonly value: string;
      readonly placeholder: string;
      readonly onInput: (value: string) => M;
      readonly name?: string;
      readonly ariaLabel?: string;
      readonly className?: string;
      readonly inputClassName?: string;
    },
  ): Markup<M>;
} = Fn.dual(2, searchInputImpl);

type SeparatorOptions = {
  readonly orientation?: "horizontal" | "vertical";
  readonly decorative?: boolean;
};

const separatorImpl = <M>(h: Html.H<M>, o: SeparatorOptions = {}): Markup<M> =>
  withAttributes(UiSeparator(h).class(ui.divider), [
    (node) =>
      o.orientation === undefined
        ? node
        : node.orientation(o.orientation).attr("orientation", o.orientation),
    (node) => (o.decorative === true ? node.decorative(true).attr("decorative", "") : node),
  ]);

export const separator: {
  <M>(h: Html.H<M>): Markup<M>;
  <M>(o: SeparatorOptions): (h: Html.H<M>) => Markup<M>;
  <M>(h: Html.H<M>, o: SeparatorOptions): Markup<M>;
} = Fn.dual(
  (args) => Predicate.isObject(args[0]) && Reflect.get(args[0], "div") !== undefined,
  separatorImpl,
);

const kpiImpl = <M>(
  h: Html.H<M>,
  o: { readonly label: string; readonly value: string; readonly note?: Markup<M> | string },
): Markup<M> =>
  card(h, [
    h.div
      .class("flex flex-col gap-1.5")
      .children([
        h.span.class("text-[0.75rem] text-on-surface-variant").children([o.label]),
        h.span.class(cn("font-display text-[1.375rem] leading-7", ui.num)).children([o.value]),
        ...(o.note === undefined ? [] : [h.span.class(cn(ui.small, ui.muted)).children([o.note])]),
      ]),
  ]);

export const kpi: {
  <M>(o: {
    readonly label: string;
    readonly value: string;
    readonly note?: Markup<M> | string | undefined;
  }): (h: Html.H<M>) => Markup<M>;
  <M>(
    h: Html.H<M>,
    o: {
      readonly label: string;
      readonly value: string;
      readonly note?: Markup<M> | string | undefined;
    },
  ): Markup<M>;
} = Fn.dual(2, kpiImpl);

const dlImpl = <M>(h: Html.H<M>, rows: ReadonlyArray<readonly [string, Child<M>]>): Markup<M> =>
  h.dl
    .class("grid grid-cols-[minmax(120px,max-content)_1fr] gap-x-4 gap-y-1.5 text-[0.8125rem]")
    .children(
      Arr.flatMap(rows, ([k, v]) => [
        h.dt.class("text-on-surface-variant").children([k]),
        h.dd.class("m-0").children([v]),
      ]),
    );

export const dl: {
  <M>(rows: ReadonlyArray<readonly [string, Child<M>]>): (h: Html.H<M>) => Markup<M>;
  <M>(h: Html.H<M>, rows: ReadonlyArray<readonly [string, Child<M>]>): Markup<M>;
} = Fn.dual(2, dlImpl);

const DIALOG_BACKDROP_CLASS =
  "fixed inset-0 bg-[color-mix(in_srgb,var(--md-sys-color-scrim)_40%,transparent)] transition-opacity duration-160 ease-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0";
const DIALOG_CONTENT_CLASS =
  "fixed inset-0 m-auto h-fit max-h-[calc(100dvh-32px)] w-[min(520px,calc(100vw-32px))] overflow-auto rounded-panel border border-outline-variant bg-surface-container-lowest p-5 text-on-surface shadow-[0_12px_32px_-12px_color-mix(in_srgb,var(--md-sys-color-shadow)_35%,transparent)] transition-[opacity,translate] duration-160 ease-out data-[ending-style]:translate-y-1.5 data-[starting-style]:translate-y-1.5 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0";
const DIALOG_TITLE_CLASS =
  "mb-3 block font-display text-[0.9375rem] leading-5 font-[var(--kb-font-display-weight)] tracking-[-0.01em]";

/** A modal dialog powered by `@ui-sdk/web/dialog` (or `alert-dialog` when `alert` is true). */
const dialogImpl = <M>(
  h: Html.H<M>,
  o: {
    readonly id: string;
    readonly title: string;
    readonly body: ReadonlyArray<Child<M>>;
    readonly actions: ReadonlyArray<Markup<M>>;
    readonly onClose: M;
    readonly alert?: boolean;
  },
): Markup<M> => {
  if (o.alert === true) {
    return UiAlertDialog(h)
      .id(`${o.id}-root`)
      .open(true)
      .attr("open", "")
      .on("openchange", ({ value }) => (value === false ? o.onClose : undefined))
      .children([
        UiAlertDialogBackdrop(h).class(DIALOG_BACKDROP_CLASS),
        UiAlertDialogContent(h)
          .class(DIALOG_CONTENT_CLASS)
          .id(o.id)
          .attr("role", "alertdialog")
          .attr("aria-modal", String(true))
          .attr("aria-labelledby", `${o.id}-title`)
          .children([
            UiAlertDialogTitle(h).class(DIALOG_TITLE_CLASS).id(`${o.id}-title`).children([o.title]),
            h.div.class(ui.stack).children(o.body),
            h.div.class("mt-4 flex justify-end gap-2").children(o.actions),
          ]),
      ]);
  }
  return UiDialog(h)
    .id(`${o.id}-root`)
    .open(true)
    .attr("open", "")
    .on("openchange", ({ value }) => (value === false ? o.onClose : undefined))
    .children([
      UiDialogBackdrop(h).class(DIALOG_BACKDROP_CLASS),
      UiDialogContent(h)
        .class(DIALOG_CONTENT_CLASS)
        .id(o.id)
        .attr("role", "dialog")
        .attr("aria-modal", String(true))
        .attr("aria-labelledby", `${o.id}-title`)
        .children([
          UiDialogTitle(h).class(DIALOG_TITLE_CLASS).id(`${o.id}-title`).children([o.title]),
          h.div.class(ui.stack).children(o.body),
          h.div.class("mt-4 flex justify-end gap-2").children(o.actions),
        ]),
    ]);
};

export const dialog: {
  <M>(o: {
    readonly id: string;
    readonly alert?: boolean;
    readonly title: string;
    readonly body: ReadonlyArray<Child<M>>;
    readonly actions: ReadonlyArray<Markup<M>>;
    readonly onClose: M;
  }): (h: Html.H<M>) => Markup<M>;
  <M>(
    h: Html.H<M>,
    o: {
      readonly id: string;
      readonly alert?: boolean;
      readonly title: string;
      readonly body: ReadonlyArray<Child<M>>;
      readonly actions: ReadonlyArray<Markup<M>>;
      readonly onClose: M;
    },
  ): Markup<M>;
} = Fn.dual(2, dialogImpl);

const monoImpl = <M>(h: Html.H<M>, value: string): Markup<M> =>
  h.span.class(ui.mono).children([value]);

export const mono: {
  <M>(value: string): (h: Html.H<M>) => Markup<M>;
  <M>(h: Html.H<M>, value: string): Markup<M>;
} = Fn.dual(2, monoImpl);
const amountImpl = <M>(h: Html.H<M>, value: string): Markup<M> =>
  h.span.class(ui.num).children([value]);

export const amount: {
  <M>(value: string): (h: Html.H<M>) => Markup<M>;
  <M>(h: Html.H<M>, value: string): Markup<M>;
} = Fn.dual(2, amountImpl);
