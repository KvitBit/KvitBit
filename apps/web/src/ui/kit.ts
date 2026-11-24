/**
 * Shared view helpers over Foldkit's `h` builder. Pages compose these instead of re-styling raw
 * elements, so every control carries the same states (styles/ui.css) and Graphite Atelier roles.
 * Helpers take already-translated strings; money and dates come pre-formatted from
 * @kvitbit/ui-port/format.
 */
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

type Attrs<M> = ReadonlyArray<Attribute<M>>;
type Child = Html | string;

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonOptions<M> {
  readonly label: string;
  readonly onClick?: M;
  readonly variant?: ButtonVariant;
  readonly small?: boolean;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly type?: "button" | "submit";
  readonly icon?: Html;
  readonly ariaLabel?: string;
  readonly testId?: string;
}

const variantClass = (v: ButtonVariant | undefined): string =>
  v === undefined || v === "secondary" ? "" : ` kb-btn--${v}`;

export const button = <M>(h: HtmlBuilder<M>, o: ButtonOptions<M>): Html =>
  h.button(
    [
      h.Class(`kb-btn${variantClass(o.variant)}${o.small === true ? " kb-btn--small" : ""}`),
      h.Type(o.type ?? "button"),
      ...(o.onClick === undefined || o.disabled === true || o.busy === true
        ? []
        : [h.OnClick(o.onClick)]),
      ...(o.disabled === true ? [h.Disabled(true)] : []),
      ...(o.busy === true ? [h.AriaBusy(true)] : []),
      ...(o.ariaLabel === undefined ? [] : [h.AriaLabel(o.ariaLabel)]),
      ...(o.testId === undefined ? [] : [h.DataAttribute("testid", o.testId)]),
    ],
    o.icon === undefined ? [o.label] : [o.icon, o.label],
  );

/** An in-app link styled as a button; the Shell intercepts the click (internal navigation). */
export const linkButton = <M>(
  h: HtmlBuilder<M>,
  o: {
    readonly label: string;
    readonly href: string;
    readonly variant?: ButtonVariant;
    readonly small?: boolean;
  },
): Html =>
  h.a(
    [
      h.Class(`kb-btn${variantClass(o.variant)}${o.small === true ? " kb-btn--small" : ""}`),
      h.Href(o.href),
    ],
    [o.label],
  );

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
  h: HtmlBuilder<M>,
  o: { id: string; label: string; hint?: string; error?: string | undefined },
  control: Html,
): Html =>
  h.div(
    [h.Class("kb-field")],
    [
      h.label([h.Class("kb-field__label"), h.For(o.id)], [o.label]),
      control,
      ...(o.error !== undefined
        ? [h.span([h.Class("kb-field__error"), h.Id(`${o.id}-error`), h.Role("alert")], [o.error])]
        : o.hint !== undefined
          ? [h.span([h.Class("kb-field__hint"), h.Id(`${o.id}-hint`)], [o.hint])]
          : []),
    ],
  );

export const textField = <M>(h: HtmlBuilder<M>, o: FieldOptions<M>): Html =>
  fieldShell(
    h,
    o,
    h.input([
      h.Class(`kb-input${o.mono === true ? " kb-mono" : ""}`),
      h.Id(o.id),
      h.Name(o.id),
      h.Type(o.type ?? "text"),
      h.Value(o.value),
      h.OnInput(o.onInput),
      ...(o.placeholder === undefined ? [] : [h.Placeholder(o.placeholder)]),
      ...(o.required === true ? [h.Required(true)] : []),
      ...(o.disabled === true ? [h.Disabled(true)] : []),
      ...(o.autocomplete === undefined ? [] : [h.Autocomplete(o.autocomplete)]),
      ...(o.error === undefined ? [] : [h.AriaInvalid(true), h.AriaDescribedBy(`${o.id}-error`)]),
    ]),
  );

export const textArea = <M>(h: HtmlBuilder<M>, o: FieldOptions<M>): Html =>
  fieldShell(
    h,
    o,
    h.textarea([
      h.Class("kb-textarea"),
      h.Id(o.id),
      h.Name(o.id),
      h.Value(o.value),
      h.OnInput(o.onInput),
      ...(o.placeholder === undefined ? [] : [h.Placeholder(o.placeholder)]),
      ...(o.error === undefined ? [] : [h.AriaInvalid(true)]),
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

export const selectField = <M>(h: HtmlBuilder<M>, o: SelectOptions<M>): Html =>
  fieldShell(h, o, select(h, o));

/** A bare select (no label wrapper), e.g. for toolbars. Needs an accessible name via `label`. */
export const select = <M>(h: HtmlBuilder<M>, o: SelectOptions<M>): Html =>
  h.select(
    [
      h.Class("kb-select"),
      h.Id(o.id),
      h.Name(o.id),
      h.AriaLabel(o.label),
      h.OnChange(o.onChange),
      ...(o.disabled === true ? [h.Disabled(true)] : []),
    ],
    o.options.map((opt) =>
      h.option(
        [h.Value(opt.value), ...(opt.value === o.value ? [h.Selected(true)] : [])],
        [opt.label],
      ),
    ),
  );

export const checkbox = <M>(
  h: HtmlBuilder<M>,
  o: {
    readonly id: string;
    readonly label: string;
    readonly checked: boolean;
    readonly onToggle: (checked: boolean) => M;
    readonly disabled?: boolean;
  },
): Html =>
  h.label(
    [h.Class("kb-check"), h.For(o.id)],
    [
      h.input([
        h.Type("checkbox"),
        h.Id(o.id),
        h.Checked(o.checked),
        h.OnChange(() => o.onToggle(!o.checked)),
        ...(o.disabled === true ? [h.Disabled(true)] : []),
      ]),
      h.span([], [o.label]),
    ],
  );

export type BadgeTone = "neutral" | "paid" | "proforma" | "overdue" | "draft" | "error" | "outline";

export const badge = <M>(h: HtmlBuilder<M>, label: string, tone: BadgeTone = "neutral"): Html =>
  h.span([h.Class(`kb-badge${tone === "neutral" ? "" : ` kb-badge--${tone}`}`)], [label]);

export const card = <M>(
  h: HtmlBuilder<M>,
  children: ReadonlyArray<Child>,
  attrs: Attrs<M> = [],
  flat = false,
): Html => h.section([h.Class(`kb-card${flat ? " kb-card--flat" : ""}`), ...attrs], children);

export const cardTitle = <M>(
  h: HtmlBuilder<M>,
  title: string,
  actions: ReadonlyArray<Child> = [],
): Html =>
  h.div(
    [h.Class("kb-card__title")],
    [h.h2([], [title]), ...(actions.length === 0 ? [] : [h.div([h.Class("kb-row")], actions)])],
  );

export const page = <M>(
  h: HtmlBuilder<M>,
  children: ReadonlyArray<Child>,
  attrs: Attrs<M> = [],
): Html => h.div([h.Class("kb-page"), ...attrs], children);

export const pageHeader = <M>(
  h: HtmlBuilder<M>,
  o: {
    readonly title: string;
    readonly subtitle?: string;
    readonly actions?: ReadonlyArray<Child>;
    readonly eyebrow?: Html;
  },
): Html =>
  h.header(
    [h.Class("kb-page-header")],
    [
      h.div(
        [h.Class("kb-page-header__titles")],
        [
          ...(o.eyebrow === undefined ? [] : [o.eyebrow]),
          h.h1([], [o.title]),
          ...(o.subtitle === undefined ? [] : [h.p([h.Class("kb-muted")], [o.subtitle])]),
        ],
      ),
      ...(o.actions === undefined || o.actions.length === 0
        ? []
        : [h.div([h.Class("kb-page-header__actions")], o.actions)]),
    ],
  );

export interface Column<Row> {
  readonly header: string;
  readonly cell: (row: Row) => Child;
  readonly align?: "start" | "end";
  readonly numeric?: boolean;
}

export const table = <Row, M>(
  h: HtmlBuilder<M>,
  o: {
    readonly caption: string;
    readonly columns: ReadonlyArray<Column<Row>>;
    readonly rows: ReadonlyArray<Row>;
    readonly rowKey: (row: Row) => string;
    readonly onRowClick?: (row: Row) => M;
  },
): Html =>
  h.div(
    [h.Class("kb-table-wrap")],
    [
      h.table(
        [h.Class("kb-table")],
        [
          h.caption([h.Class("kb-visually-hidden")], [o.caption]),
          h.thead(
            [],
            [
              h.tr(
                [],
                o.columns.map((c) =>
                  h.th(
                    [h.Scope("col"), ...(c.align === "end" ? [h.Class("kb-end")] : [])],
                    [c.header],
                  ),
                ),
              ),
            ],
          ),
          h.tbody(
            [],
            o.rows.map((row) =>
              h.keyed("tr")(
                o.rowKey(row),
                o.onRowClick === undefined
                  ? []
                  : [h.OnClick(o.onRowClick(row)), h.DataAttribute("href", "1")],
                o.columns.map((c) =>
                  h.td(
                    [
                      h.Class(
                        `${c.align === "end" ? "kb-end" : ""}${c.numeric === true ? " kb-num" : ""}`,
                      ),
                    ],
                    [c.cell(row)],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    ],
  );

/** A loading table that mirrors the loaded chrome (zero-CLS): same headers, same row height. */
export const skeletonTable = <M>(
  h: HtmlBuilder<M>,
  headers: ReadonlyArray<string>,
  rows = 6,
): Html =>
  h.div(
    [h.Class("kb-table-wrap"), h.AriaBusy(true)],
    [
      h.table(
        [h.Class("kb-table")],
        [
          h.thead(
            [],
            [
              h.tr(
                [],
                headers.map((x) => h.th([h.Scope("col")], [x])),
              ),
            ],
          ),
          h.tbody(
            [],
            Array.from({ length: rows }, (_, i) =>
              h.keyed("tr")(
                `s${i}`,
                [],
                headers.map(() =>
                  h.td(
                    [],
                    [
                      h.span(
                        [h.Class("kb-skeleton"), h.Style({ display: "block", width: "70%" })],
                        [" "],
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    ],
  );

export const skeleton = <M>(h: HtmlBuilder<M>, width = "100%", height = "1em"): Html =>
  h.span(
    [h.Class("kb-skeleton"), h.Style({ display: "block", width, height }), h.AriaHidden(true)],
    [" "],
  );

export const emptyState = <M>(
  h: HtmlBuilder<M>,
  o: {
    readonly title: string;
    readonly body?: string;
    readonly action?: Html;
    readonly art?: Html;
  },
): Html =>
  h.div(
    [h.Class("kb-empty")],
    [
      ...(o.art === undefined ? [] : [o.art]),
      h.p([h.Class("kb-empty__title")], [o.title]),
      ...(o.body === undefined ? [] : [h.p([], [o.body])]),
      ...(o.action === undefined ? [] : [o.action]),
    ],
  );

export const banner = <M>(
  h: HtmlBuilder<M>,
  o: {
    readonly text: string;
    readonly tone?: "neutral" | "error" | "info";
    readonly action?: Html;
  },
): Html =>
  h.div(
    [
      h.Class(
        `kb-banner${o.tone === undefined || o.tone === "neutral" ? "" : ` kb-banner--${o.tone}`}`,
      ),
      h.Role(o.tone === "error" ? "alert" : "status"),
    ],
    [h.span([h.Style({ flex: "1" })], [o.text]), ...(o.action === undefined ? [] : [o.action])],
  );

export const tabs = <M>(
  h: HtmlBuilder<M>,
  o: {
    readonly label: string;
    readonly items: ReadonlyArray<{
      readonly id: string;
      readonly label: string;
      readonly href: string;
    }>;
    readonly selected: string;
  },
): Html =>
  h.nav(
    [h.Class("kb-tabs"), h.AriaLabel(o.label)],
    o.items.map((it) =>
      h.a(
        [
          h.Class("kb-tab"),
          h.Href(it.href),
          h.AriaSelected(it.id === o.selected),
          ...(it.id === o.selected ? [h.AriaCurrent("page")] : []),
        ],
        [it.label],
      ),
    ),
  );

export const segmented = <M>(
  h: HtmlBuilder<M>,
  o: {
    readonly label: string;
    readonly items: ReadonlyArray<{ readonly id: string; readonly label: string }>;
    readonly selected: string;
    readonly onSelect: (id: string) => M;
  },
): Html =>
  h.div(
    [h.Class("kb-segmented"), h.Role("group"), h.AriaLabel(o.label)],
    o.items.map((it) =>
      h.button(
        [
          h.Type("button"),
          h.AriaPressed(it.id === o.selected ? "true" : "false"),
          h.OnClick(o.onSelect(it.id)),
        ],
        [it.label],
      ),
    ),
  );

export const kpi = <M>(
  h: HtmlBuilder<M>,
  o: { readonly label: string; readonly value: string; readonly note?: Html | string },
): Html =>
  card(h, [
    h.div(
      [h.Class("kb-kpi")],
      [
        h.span([h.Class("kb-kpi__label")], [o.label]),
        h.span([h.Class("kb-kpi__value kb-num")], [o.value]),
        ...(o.note === undefined ? [] : [h.span([h.Class("kb-small kb-muted")], [o.note])]),
      ],
    ),
  ]);

export const dl = <M>(h: HtmlBuilder<M>, rows: ReadonlyArray<readonly [string, Child]>): Html =>
  h.dl(
    [h.Class("kb-dl")],
    rows.flatMap(([k, v]) => [h.dt([], [k]), h.dd([], [v])]),
  );

/** A modal dialog (Graphite Atelier: outlineVariant border over a dimmed scrim). */
export const dialog = <M>(
  h: HtmlBuilder<M>,
  o: {
    readonly id: string;
    readonly title: string;
    readonly body: ReadonlyArray<Child>;
    readonly actions: ReadonlyArray<Html>;
    readonly onClose: M;
  },
): Html =>
  h.div(
    [
      h.Class("kb-dialog-scrim"),
      h.OnKeyDown((key) => (key === "Escape" ? o.onClose : undefined) as M),
    ],
    [
      h.div(
        [
          h.Class("kb-dialog"),
          h.Role("dialog"),
          h.AriaModal(true),
          h.AriaLabelledBy(`${o.id}-title`),
          h.Id(o.id),
        ],
        [
          h.h2([h.Id(`${o.id}-title`)], [o.title]),
          h.div([h.Class("kb-stack")], o.body),
          h.div([h.Class("kb-dialog__actions")], o.actions),
        ],
      ),
    ],
  );

export const mono = <M>(h: HtmlBuilder<M>, value: string): Html =>
  h.span([h.Class("kb-mono")], [value]);
export const amount = <M>(h: HtmlBuilder<M>, value: string): Html =>
  h.span([h.Class("kb-amount")], [value]);
