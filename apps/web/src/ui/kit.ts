import type { Html } from "@effect/ui/html";
import { type Attribute, type Markup, withAttributes } from "./html";
import {
  badgeVariants,
  bannerVariants,
  buttonVariants,
  cardVariants,
  cn,
  controlVariants,
  segmentedButtonVariants,
  ui,
} from "./styles";

/**
 * Shared view helpers over Effect UI’s `h` builder. Pages compose these instead of re-styling raw
 * elements, so every control carries the same Tailwind v4 + CVA states and Material 3 roles.
 * Helpers take already-translated strings; money and dates come pre-formatted from
 * @kvitbit/ui-port/format.
 */

type Attrs = ReadonlyArray<Attribute>;
type Child<M> = Markup<M> | string;

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonOptions<M> {
  readonly label: string;
  readonly onClick?: M;
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

export const button = <M>(h: Html.H<M>, o: ButtonOptions<M>): Markup<M> =>
  withAttributes(h.button.class(), [
    (element) =>
      element.class(
        cn(
          buttonVariants({
            variant: o.variant ?? "secondary",
            size: o.small === true ? "small" : "default",
          }),
          o.className,
        ),
      ),
    (element) => element.attr("type", o.type ?? "button"),
    (node) =>
      o.onClick === undefined || o.disabled === true || o.busy === true
        ? node
        : node.on("click", o.onClick),
    (node) => (o.disabled === true ? node.disabled(true) : node),
    (node) => (o.busy === true ? node.attr("aria-busy", String(true)) : node),
    (node) => (o.ariaLabel === undefined ? node : node.attr("aria-label", o.ariaLabel)),
    (node) => (o.testId === undefined ? node : node.attr("data-testid", o.testId)),
  ]).children(o.icon === undefined ? [o.label] : [o.icon, o.label]);

/** An in-app link styled as a button; the Shell intercepts the click (internal navigation). */
export const linkButton = <M>(
  h: Html.H<M>,
  o: {
    readonly label: string;
    readonly href: string;
    readonly variant?: ButtonVariant;
    readonly small?: boolean;
    readonly className?: string;
  },
): Markup<M> =>
  h.a
    .class(
      cn(
        buttonVariants({
          variant: o.variant ?? "secondary",
          size: o.small === true ? "small" : "default",
        }),
        o.className,
      ),
    )
    .attr("href", o.href)
    .children([o.label]);

export interface FieldOptions<M> {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onInput: (value: string) => M;
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
  o: { id: string; label: string; hint?: string; error?: string | undefined },
  control: Markup<M>,
): Markup<M> =>
  h.div
    .class(ui.field)
    .attr("data-slot", "field")
    .children([
      h.label.class(ui.fieldLabel).attr("for", o.id).children([o.label]),
      control,
      ...(o.error !== undefined
        ? [
            h.span
              .class(ui.fieldError)
              .id(`${o.id}-error`)
              .attr("role", "alert")
              .children([o.error]),
          ]
        : o.hint !== undefined
          ? [h.span.class(ui.fieldHint).id(`${o.id}-hint`).children([o.hint])]
          : []),
    ]);

export const textField = <M>(h: Html.H<M>, o: FieldOptions<M>): Markup<M> =>
  fieldShell(
    h,
    o,
    withAttributes(h.input.class(), [
      (element) =>
        element.class(cn(controlVariants({ kind: "input" }), o.mono === true && ui.mono)),
      (element) => element.id(o.id),
      (element) => element.attr("name", o.id),
      (element) => element.attr("type", o.type ?? "text"),
      (element) => element.value(o.value),
      (element) => element.on("input", ({ value }) => o.onInput(value)),
      (node) => (o.placeholder === undefined ? node : node.attr("placeholder", o.placeholder)),
      (node) => (o.required === true ? node.attr("required", "") : node),
      (node) => (o.disabled === true ? node.disabled(true) : node),
      (node) => (o.autocomplete === undefined ? node : node.attr("autocomplete", o.autocomplete)),
      (node) =>
        o.error === undefined
          ? node
          : node.attr("aria-invalid", String(true)).attr("aria-describedby", `${o.id}-error`),
    ]),
  );

export const textArea = <M>(h: Html.H<M>, o: FieldOptions<M>): Markup<M> =>
  fieldShell(
    h,
    o,
    withAttributes(h.textarea.class(), [
      (element) => element.class(controlVariants({ kind: "textarea" })),
      (element) => element.id(o.id),
      (element) => element.attr("name", o.id),
      (element) => element.value(o.value),
      (element) => element.on("input", ({ value }) => o.onInput(value)),
      (node) => (o.placeholder === undefined ? node : node.attr("placeholder", o.placeholder)),
      (node) => (o.error === undefined ? node : node.attr("aria-invalid", String(true))),
    ]),
  );

export interface SelectOptions<M> {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly onChange: (value: string) => M;
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly disabled?: boolean;
  readonly compact?: boolean;
}

export const selectField = <M>(h: Html.H<M>, o: SelectOptions<M>): Markup<M> =>
  fieldShell(h, o, select(h, o));

/** A bare select (no label wrapper), e.g. for toolbars. Needs an accessible name via `label`. */
export const select = <M>(h: Html.H<M>, o: SelectOptions<M>): Markup<M> =>
  h.select
    .class(controlVariants({ kind: "select", compact: o.compact === true }))
    .id(o.id)
    .attr("name", o.id)
    .attr("aria-label", o.label)
    .value(o.value)
    .disabled(o.disabled === true)
    .on("change", ({ value }) => o.onChange(value))
    .children(
      o.options.map((option) => h.option.attr("value", option.value).children(option.label)),
    );

export const checkbox = <M>(
  h: Html.H<M>,
  o: {
    readonly id: string;
    readonly label: string;
    readonly checked: boolean;
    readonly onToggle: (checked: boolean) => M;
    readonly disabled?: boolean;
  },
): Markup<M> =>
  h.label
    .class("inline-flex cursor-pointer items-center gap-2")
    .attr("for", o.id)
    .children([
      withAttributes(h.input.class(), [
        (element) => element.class("h-4 w-4 accent-primary"),
        (element) => element.attr("type", "checkbox"),
        (element) => element.id(o.id),
        (element) => element.checked(o.checked),
        (element) => element.on("change", () => o.onToggle(!o.checked)),
        (node) => (o.disabled === true ? node.disabled(true) : node),
      ]),
      h.span.children([o.label]),
    ]);

export type BadgeTone = "neutral" | "paid" | "proforma" | "overdue" | "draft" | "error" | "outline";

export const badge = <M>(h: Html.H<M>, label: string, tone: BadgeTone = "neutral"): Markup<M> =>
  h.span.class(badgeVariants({ tone })).children([label]);

export const card = <M>(
  h: Html.H<M>,
  children: ReadonlyArray<Child<M>>,
  attrs: Attrs = [],
  flat = false,
  className?: string,
): Markup<M> =>
  withAttributes(h.section.class(), [
    (element) => element.class(cn(cardVariants({ flat }), className)),
    ...attrs,
  ]).children(children);

export const cardTitle = <M>(
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

export const page = <M>(
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

export const pageHeader = <M>(
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

export interface Column<Row, M> {
  readonly header: string;
  readonly cell: (row: Row) => Child<M>;
  readonly align?: "start" | "end";
  readonly numeric?: boolean;
}

export const table = <Row, M>(
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
            o.columns.map((c) =>
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
          o.rows.map((row) =>
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
              o.columns.map((c) =>
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

/** A loading table that mirrors the loaded chrome (zero-CLS): same headers, same row height. */
export const skeletonTable = <M>(
  h: Html.H<M>,
  headers: ReadonlyArray<string>,
  rows = 6,
): Markup<M> =>
  h.div
    .class(
      "overflow-x-auto rounded-panel border border-outline-variant bg-surface-container-lowest",
    )
    .attr("aria-busy", String(true))
    .children([
      h.table.class("w-full border-collapse text-[0.8125rem]").children([
        h.thead.children([
          h.tr.children(
            headers.map((x) =>
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
                headers.map(() =>
                  h.td
                    .class("h-11 border-b border-outline-variant px-3 py-2.5 align-middle")
                    .children([h.span.class("kb-skeleton block w-[70%]").children(["\u00A0"])]),
                ),
              ),
          ),
        ),
      ]),
    ]);

export const skeleton = <M>(h: Html.H<M>, width = "100%", height = "1em"): Markup<M> =>
  h.span
    .class("kb-skeleton block")
    .style({ width, height })
    .attr("aria-hidden", String(true))
    .children(["\u00A0"]);

export const emptyState = <M>(
  h: Html.H<M>,
  o: {
    readonly title: string;
    readonly body?: string;
    readonly action?: Markup<M>;
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

export const banner = <M>(
  h: Html.H<M>,
  o: {
    readonly text: string;
    readonly tone?: "neutral" | "error" | "info";
    readonly action?: Markup<M>;
  },
): Markup<M> =>
  h.div
    .class(bannerVariants({ tone: o.tone ?? "neutral" }))
    .attr("role", o.tone === "error" ? "alert" : "status")
    .children([
      h.span.class("flex-1").children([o.text]),
      ...(o.action === undefined ? [] : [o.action]),
    ]);

export const tabs = <M>(
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
  h.nav
    .class("flex gap-0.5 overflow-x-auto border-b border-outline-variant")
    .attr("data-slot", "tabs")
    .attr("aria-label", o.label)
    .children(
      o.items.map((it) =>
        withAttributes(h.a.class(), [
          (element) =>
            element.class(
              "-mb-px cursor-pointer whitespace-nowrap border-0 border-b-2 border-transparent bg-transparent px-3.5 py-2.5 font-medium text-on-surface-variant no-underline hover:text-on-surface aria-[selected=true]:border-b-primary aria-[selected=true]:text-on-surface",
            ),
          (element) => element.attr("href", it.href),
          (element) => element.attr("aria-selected", String(it.id === o.selected)),
          (node) => (it.id === o.selected ? node.attr("aria-current", "page") : node),
        ]).children([it.label]),
      ),
    );

export const segmented = <M>(
  h: Html.H<M>,
  o: {
    readonly label: string;
    readonly items: ReadonlyArray<{ readonly id: string; readonly label: string }>;
    readonly selected: string;
    readonly onSelect: (id: string) => M;
    readonly fill?: boolean;
    readonly sizing?: "equal" | "auto";
    readonly className?: string;
  },
): Markup<M> =>
  h.div
    .class(
      cn(
        "inline-flex max-w-full overflow-hidden rounded-control border border-outline-variant",
        o.fill === true && "w-full",
        o.className,
      ),
    )
    .attr("data-slot", "segmented")
    .attr("role", "group")
    .attr("aria-label", o.label)
    .children(
      o.items.map((it) =>
        h.button
          .class(segmentedButtonVariants({ sizing: o.sizing ?? "equal" }))
          .attr("type", "button")
          .attr("aria-pressed", String(it.id === o.selected ? "true" : "false"))
          .on("click", o.onSelect(it.id))
          .children([it.label]),
      ),
    );

export const kpi = <M>(
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

export const dl = <M>(h: Html.H<M>, rows: ReadonlyArray<readonly [string, Child<M>]>): Markup<M> =>
  h.dl
    .class("grid grid-cols-[minmax(120px,max-content)_1fr] gap-x-4 gap-y-1.5 text-[0.8125rem]")
    .children(
      rows.flatMap(([k, v]) => [
        h.dt.class("text-on-surface-variant").children([k]),
        h.dd.class("m-0").children([v]),
      ]),
    );

/** A modal dialog (Graphite Atelier: outlineVariant border over a dimmed scrim). */
export const dialog = <M>(
  h: Html.H<M>,
  o: {
    readonly id: string;
    readonly title: string;
    readonly body: ReadonlyArray<Child<M>>;
    readonly actions: ReadonlyArray<Markup<M>>;
    readonly onClose: M;
  },
): Markup<M> =>
  h.div
    .class(
      "fixed inset-0 z-50 grid place-items-center bg-[color-mix(in_srgb,var(--md-sys-color-scrim)_40%,transparent)] p-4",
    )
    .on("keydown", ({ key }) => (key === "Escape" ? o.onClose : undefined) as M)
    .children([
      h.div
        .class(
          "max-h-[calc(100dvh-32px)] w-[min(520px,100%)] overflow-auto rounded-panel border border-outline-variant bg-surface-container-lowest p-5 shadow-[0_12px_32px_-12px_color-mix(in_srgb,var(--md-sys-color-shadow)_35%,transparent)]",
        )
        .attr("role", "dialog")
        .attr("aria-modal", String(true))
        .attr("aria-labelledby", `${o.id}-title`)
        .id(o.id)
        .children([
          h.h2.id(`${o.id}-title`).children([o.title]),
          h.div.class(ui.stack).children(o.body),
          h.div.class("mt-4 flex justify-end gap-2").children(o.actions),
        ]),
    ]);

export const mono = <M>(h: Html.H<M>, value: string): Markup<M> =>
  h.span.class(ui.mono).children([value]);
export const amount = <M>(h: Html.H<M>, value: string): Markup<M> =>
  h.span.class(ui.num).children([value]);
