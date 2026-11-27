import type { Html } from "@effect/ui/html";
import { type Attribute, type Markup, withAttributes } from "./html";

/**
 * Shared view helpers over Effect UI’s `h` builder. Pages compose these instead of re-styling raw
 * elements, so every control carries the same states (styles/ui.css) and Graphite Atelier roles.
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
}

const variantClass = (v: ButtonVariant | undefined): string =>
  v === undefined || v === "secondary" ? "" : ` kb-btn--${v}`;

export const button = <M>(h: Html.H<M>, o: ButtonOptions<M>): Markup<M> =>
  withAttributes(h.button.class(), [
    (element) =>
      element.class(`kb-btn${variantClass(o.variant)}${o.small === true ? " kb-btn--small" : ""}`),
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
  },
): Markup<M> =>
  h.a
    .class(`kb-btn${variantClass(o.variant)}${o.small === true ? " kb-btn--small" : ""}`)
    .attr("href", o.href)
    .children([o.label]);

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
  o: { id: string; label: string; hint?: string; error?: string | undefined },
  control: Markup<M>,
): Markup<M> =>
  h.div
    .class("kb-field")
    .children([
      h.label.class("kb-field__label").attr("for", o.id).children([o.label]),
      control,
      ...(o.error !== undefined
        ? [
            h.span
              .class("kb-field__error")
              .id(`${o.id}-error`)
              .attr("role", "alert")
              .children([o.error]),
          ]
        : o.hint !== undefined
          ? [h.span.class("kb-field__hint").id(`${o.id}-hint`).children([o.hint])]
          : []),
    ]);

export const textField = <M>(h: Html.H<M>, o: FieldOptions<M>): Markup<M> =>
  fieldShell(
    h,
    o,
    withAttributes(h.input.class(), [
      (element) => element.class(`kb-input${o.mono === true ? " kb-mono" : ""}`),
      (element) => element.id(o.id),
      (element) => element.attr("name", o.id),
      (element) => element.attr("type", o.type ?? "text"),
      (element) => element.value(o.value),
      (element) => element.on("input", ({ value }) => o.onInput(value)),
      (node) =>
        o.onPaste === undefined
          ? node
          : node.on("paste", ({ text }) => o.onPaste?.(text), { preventDefault: true }),
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
      (element) => element.class("kb-textarea"),
      (element) => element.id(o.id),
      (element) => element.attr("name", o.id),
      (element) => element.value(o.value),
      (element) => element.on("input", ({ value }) => o.onInput(value)),
      (node) =>
        o.onPaste === undefined
          ? node
          : node.on("paste", ({ text }) => o.onPaste?.(text), { preventDefault: true }),
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
}

export const selectField = <M>(h: Html.H<M>, o: SelectOptions<M>): Markup<M> =>
  fieldShell(h, o, select(h, o));

/** A bare select (no label wrapper), e.g. for toolbars. Needs an accessible name via `label`. */
export const select = <M>(h: Html.H<M>, o: SelectOptions<M>): Markup<M> =>
  h.select
    .class("kb-select")
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
    .class("kb-check")
    .attr("for", o.id)
    .children([
      withAttributes(h.input.class(), [
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
  h.span.class(`kb-badge${tone === "neutral" ? "" : ` kb-badge--${tone}`}`).children([label]);

export const card = <M>(
  h: Html.H<M>,
  children: ReadonlyArray<Child<M>>,
  attrs: Attrs = [],
  flat = false,
): Markup<M> =>
  withAttributes(h.section.class(), [
    (element) => element.class(`kb-card${flat ? " kb-card--flat" : ""}`),
    ...attrs,
  ]).children(children);

export const cardTitle = <M>(
  h: Html.H<M>,
  title: string,
  actions: ReadonlyArray<Child<M>> = [],
): Markup<M> =>
  h.div
    .class("kb-card__title")
    .children([
      h.h2.children([title]),
      ...(actions.length === 0 ? [] : [h.div.class("kb-row").children(actions)]),
    ]);

export const page = <M>(
  h: Html.H<M>,
  children: ReadonlyArray<Child<M>>,
  attrs: Attrs = [],
): Markup<M> =>
  withAttributes(h.div.class(), [(element) => element.class("kb-page"), ...attrs]).children(
    children,
  );

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
    .class("kb-page-header")
    .children([
      h.div
        .class("kb-page-header__titles")
        .children([
          ...(o.eyebrow === undefined ? [] : [o.eyebrow]),
          h.h1.children([o.title]),
          ...(o.subtitle === undefined ? [] : [h.p.class("kb-muted").children([o.subtitle])]),
        ]),
      ...(o.actions === undefined || o.actions.length === 0
        ? []
        : [h.div.class("kb-page-header__actions").children(o.actions)]),
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
    .class("kb-table-wrap")
    .children([
      h.table
        .class("kb-table")
        .children([
          h.caption.class("kb-visually-hidden").children([o.caption]),
          h.thead.children([
            h.tr.children(
              o.columns.map((c) =>
                withAttributes(h.th.class(), [
                  (element) => element.attr("scope", "col"),
                  (node) => (c.align === "end" ? node.class("kb-end") : node),
                ]).children([c.header]),
              ),
            ),
          ]),
          h.tbody.children(
            o.rows.map((row) =>
              withAttributes(
                h.tr.key(o.rowKey(row)),
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
                      `${c.align === "end" ? "kb-end" : ""}${c.numeric === true ? " kb-num" : ""}`,
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
    .class("kb-table-wrap")
    .attr("aria-busy", String(true))
    .children([
      h.table
        .class("kb-table")
        .children([
          h.thead.children([
            h.tr.children(headers.map((x) => h.th.attr("scope", "col").children([x]))),
          ]),
          h.tbody.children(
            Array.from({ length: rows }, (_, i) =>
              h.tr
                .key(`s${i}`)
                .children(
                  headers.map(() =>
                    h.td.children([
                      h.span
                        .class("kb-skeleton")
                        .style({ display: "block", width: "70%" })
                        .children([" "]),
                    ]),
                  ),
                ),
            ),
          ),
        ]),
    ]);

export const skeleton = <M>(h: Html.H<M>, width = "100%", height = "1em"): Markup<M> =>
  h.span
    .class("kb-skeleton")
    .style({ display: "block", width, height })
    .attr("aria-hidden", String(true))
    .children([" "]);

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
    .class("kb-empty")
    .children([
      ...(o.art === undefined ? [] : [o.art]),
      h.p.class("kb-empty__title").children([o.title]),
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
    .class(
      `kb-banner${o.tone === undefined || o.tone === "neutral" ? "" : ` kb-banner--${o.tone}`}`,
    )
    .attr("role", o.tone === "error" ? "alert" : "status")
    .children([
      h.span.style({ flex: "1" }).children([o.text]),
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
    .class("kb-tabs")
    .attr("aria-label", o.label)
    .children(
      o.items.map((it) =>
        withAttributes(h.a.class(), [
          (element) => element.class("kb-tab"),
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
  },
): Markup<M> =>
  h.div
    .class("kb-segmented")
    .attr("role", "group")
    .attr("aria-label", o.label)
    .children(
      o.items.map((it) =>
        h.button
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
      .class("kb-kpi")
      .children([
        h.span.class("kb-kpi__label").children([o.label]),
        h.span.class("kb-kpi__value kb-num").children([o.value]),
        ...(o.note === undefined ? [] : [h.span.class("kb-small kb-muted").children([o.note])]),
      ]),
  ]);

export const dl = <M>(h: Html.H<M>, rows: ReadonlyArray<readonly [string, Child<M>]>): Markup<M> =>
  h.dl.class("kb-dl").children(rows.flatMap(([k, v]) => [h.dt.children([k]), h.dd.children([v])]));

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
    .class("kb-dialog-scrim")
    .on("keydown", ({ key }) => (key === "Escape" ? o.onClose : undefined) as M)
    .children([
      h.div
        .class("kb-dialog")
        .attr("role", "dialog")
        .attr("aria-modal", String(true))
        .attr("aria-labelledby", `${o.id}-title`)
        .id(o.id)
        .children([
          h.h2.id(`${o.id}-title`).children([o.title]),
          h.div.class("kb-stack").children(o.body),
          h.div.class("kb-dialog__actions").children(o.actions),
        ]),
    ]);

export const mono = <M>(h: Html.H<M>, value: string): Markup<M> =>
  h.span.class("kb-mono").children([value]);
export const amount = <M>(h: Html.H<M>, value: string): Markup<M> =>
  h.span.class("kb-amount").children([value]);
