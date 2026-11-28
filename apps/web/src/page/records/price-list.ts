import { UiSchema } from "@effect/ui";
import type { Html } from "@effect/ui/html";
/**
 * Price List screen (Screen 16, route `PriceList`).
 * Saved catalog items with search, archived toggle, inline/sheet create & edit,
 * currency/unit/VAT defaults, archive confirmation, and zero-CLS shimmer skeleton.
 */
import {
  CurrencyCode,
  PriceListItemId,
  PriceListItemInput,
  VatTreatment,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Format } from "@kvitbit/ui-port";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { Failure, request } from "../../app/api";
import type { PageCommand } from "../../app/commands";
import { copy, textOf, translator } from "../../app/i18n";
import { Intent_ } from "../../app/intent";
import {
  type MessageHandlers,
  type PageContext,
  type PageReturn,
  RouteCases,
} from "../../app/page";
import * as Remote from "../../app/remote";
import { BrowserRoutes } from "../../app/routing";
import type { Markup } from "../../ui/html";
import { icon } from "../../ui/icons";
import {
  badge,
  banner,
  button,
  card,
  cardTitle,
  checkbox,
  dialog,
  emptyState,
  page,
  pageHeader,
  searchInput,
  selectField,
  skeletonTable,
  table,
  textArea,
  textField,
} from "../../ui/kit";
import { cn, ui } from "../../ui/styles";
import {
  apiCommand,
  CURRENCIES,
  canWrite,
  enumLabel,
  moneyText,
  newIdempotencyKey,
  normalizePriceListItem,
  PriceListItemRecord,
  parseUserDecimal,
  VAT_TREATMENTS,
  vatRatePercent,
} from "./shared";

export const Route = RouteCases.PriceList;
export type Route = typeof Route.Type;

const tLocal = copy({
  cs: {
    subtitle: "Uložené položky slouží jako výchozí hodnoty při vytváření dokladů.",
    newItem: "Nová položka ceníku",
    editItem: "Upravit položku",
    vatDefault: "Výchozí (dle režimu prostoru)",
    archiveTitle: "Archivovat položku?",
    archiveBody:
      "Položka {name} se přestane nabízet v novém dokladu. Stávající doklady zůstanou beze změny.",
    priceInvalid: "Zadejte platnou cenu (např. 1500 nebo 70,50).",
    nameRequired: "Zadejte název položky.",
    archivedBadge: "Archivováno",
    activeBadge: "Aktivní",
    countLabel: "{count} položek",
    staleNotice: "Položka byla mezitím upravena. Načtěte aktuální stav.",
  },
  en: {
    subtitle: "Saved items supply default values when drafting documents.",
    newItem: "New price list item",
    editItem: "Edit item",
    vatDefault: "Default (by workspace tax regime)",
    archiveTitle: "Archive item?",
    archiveBody:
      "{name} will no longer appear in new document suggestions. Existing documents stay unchanged.",
    priceInvalid: "Enter a valid price (e.g. 1500 or 70.50).",
    nameRequired: "Enter an item name.",
    archivedBadge: "Archived",
    activeBadge: "Active",
    countLabel: "{count} items",
    staleNotice: "This item changed elsewhere. Reload to get the latest version.",
  },
});

const EditorDraft = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  revision: Schema.NullOr(Schema.Int),
  name: Schema.String,
  description: Schema.String,
  unit: Schema.String,
  unitPrice: Schema.String,
  currency: Schema.String,
  vat: Schema.String, // "" means null (workspace default)
  idempotencyKey: Schema.String,
  saving: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
type EditorDraft = typeof EditorDraft.Type;

export const Model = Schema.Struct({
  route: Route,
  search: Schema.String,
  includeArchived: Schema.Boolean,
  items: PriceListItemRecord.pipe(Schema.Array, Remote.remoteSchema),
  editor: Schema.NullOr(EditorDraft),
  confirmArchive: Schema.NullOr(PriceListItemRecord),
  archiving: Schema.Boolean,
});
export type Model = typeof Model.Type;

export const Message = UiSchema.TaggedEnum({
  LoadedItems: { seq: Schema.Int, items: Schema.Array(PriceListItemRecord) },
  FailedItems: { seq: Schema.Int, failure: Failure },
  ChangedSearch: { value: Schema.String },
  SubmittedSearch: {},
  ToggledIncludeArchived: { checked: Schema.Boolean },
  ClickedRetry: {},
  ClickedNew: {},
  ClickedEdit: { item: PriceListItemRecord },
  ClickedCloseEditor: {},
  ChangedField: {
    field: Schema.Literals(["name", "description", "unit", "unitPrice", "currency", "vat"]),
    value: Schema.String,
  },
  SubmittedEditor: {},
  SavedItem: { item: PriceListItemRecord },
  FailedSave: { failure: Failure },
  RequestedArchive: { item: PriceListItemRecord },
  CancelledArchive: {},
  ConfirmedArchive: {},
  ArchivedItem: { id: Schema.String },
  FailedArchive: { failure: Failure },
});
export type Message = typeof Message.Type;

const loadItemsCommand = (
  workspaceId: string,
  seq: number,
  text: string,
  includeArchived: boolean,
): PageCommand<Message> =>
  apiCommand(
    Message,
    "PriceList.LoadItems",
    request(
      (client) =>
        client.priceList.list({
          params: { workspaceId: WorkspaceId.make(workspaceId) },
          query: {
            text: Str.trim(text) === "" ? undefined : Str.trim(text),
            includeArchived: includeArchived || undefined,
          },
        }),
      (raw): Message => Message.LoadedItems({ seq, items: Arr.map(raw, normalizePriceListItem) }),
      (failure): Message => Message.FailedItems({ seq, failure }),
    ),
  );

const saveItemCommand = (workspaceId: string, draft: EditorDraft): PageCommand<Message> => {
  const parsedPrice = parseUserDecimal(draft.unitPrice) ?? 0;
  const payload = PriceListItemInput.make({
    name: Str.trim(draft.name),
    description: Str.trim(draft.description) === "" ? null : Str.trim(draft.description),
    unit: Str.trim(draft.unit) === "" ? null : Str.trim(draft.unit),
    unitPrice: String(parsedPrice),
    currency: CurrencyCode.make(draft.currency),
    vat: draft.vat === "" ? null : draft.vat,
  });

  return apiCommand(
    Message,
    "PriceList.SaveItem",
    request(
      (client) =>
        draft.id === null
          ? client.priceList.create({
              params: { workspaceId: WorkspaceId.make(workspaceId) },
              headers: { "idempotency-key": draft.idempotencyKey },
              payload,
            })
          : client.priceList.update({
              params: {
                workspaceId: WorkspaceId.make(workspaceId),
                itemId: PriceListItemId.make(draft.id),
              },
              headers: { "if-match": `"${draft.revision ?? 1}"` },
              payload,
            }),
      (raw): Message => Message.SavedItem({ item: normalizePriceListItem(raw) }),
      (failure): Message => Message.FailedSave({ failure }),
    ),
  );
};

const archiveItemCommand = (workspaceId: string, itemId: string): PageCommand<Message> =>
  apiCommand(
    Message,
    "PriceListArchiveItem",
    request(
      (client) =>
        client.priceList.archive({
          params: {
            workspaceId: WorkspaceId.make(workspaceId),
            itemId: PriceListItemId.make(itemId),
          },
        }),
      (): Message => Message.ArchivedItem({ id: itemId }),
      (failure): Message => Message.FailedArchive({ failure }),
    ),
  );

const emptyDraft = (): EditorDraft => ({
  id: null,
  revision: null,
  name: "",
  description: "",
  unit: "hod",
  unitPrice: "",
  currency: "CZK",
  vat: "standard",
  idempotencyKey: newIdempotencyKey("pli"),
  saving: false,
  error: null,
});

const draftFromItem = (item: PriceListItemRecord): EditorDraft => ({
  id: item.id,
  revision: item.revision,
  name: item.name,
  description: item.description ?? "",
  unit: item.unit ?? "",
  unitPrice: item.unitPrice,
  currency: item.currency,
  vat: item.vat ?? "",
  idempotencyKey: newIdempotencyKey("pli"),
  saving: false,
  error: null,
});

export const init: {
  (ctx: PageContext): (route: Route) => PageReturn<Model, Message>;
  (route: Route, ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(2, (route: Route, ctx: PageContext): PageReturn<Model, Message> => {
  const search = route.text ?? "";
  const location = Option.getOrUndefined(BrowserRoutes.parse(ctx.path));
  const includeArchived = location?._tag === "PriceList" && location.search.archived === "1";
  const items = Remote.load<ReadonlyArray<PriceListItemRecord>>(Remote.idle);
  const wsId = ctx.workspace?.id;
  return {
    model: {
      route,
      search,
      includeArchived,
      items,
      editor: null,
      confirmArchive: null,
      archiving: false,
    },
    commands:
      wsId === undefined
        ? []
        : [loadItemsCommand(wsId, Remote.seqOf(items), search, includeArchived)],
  };
});

export const update: {
  (message: Message, ctx: PageContext): (model: Model) => PageReturn<Model, Message>;
  (model: Model, message: Message, ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(3, (model: Model, message: Message, ctx: PageContext): PageReturn<Model, Message> => {
  const tr = translator(ctx.locale);
  const wsId = ctx.workspace?.id;
  const route = model.route;
  const committedSearch = route.text ?? "";

  return Message.match(message, {
    LoadedItems: ({ seq, items }) => ({
      model: { ...model, items: Remote.succeed(model.items, seq, items) },
    }),

    FailedItems: ({ seq, failure }) => ({
      model: { ...model, items: Remote.fail(model.items, seq, failure) },
    }),

    ChangedSearch: ({ value }) => ({ model: { ...model, search: value } }),

    SubmittedSearch: () => {
      const trimmed = Str.trim(model.search);
      const text = trimmed === "" ? undefined : { text: trimmed };
      const archived = model.includeArchived ? { archived: "1" as const } : undefined;
      const path = BrowserRoutes.print(
        BrowserRoutes.PriceList({ params: { ws: route.ws }, search: { ...text, ...archived } }),
      );
      const next = { model: { ...model, search: trimmed } };
      return path === ctx.path ? next : { ...next, outMessage: Intent_.navigate(path) };
    },

    ToggledIncludeArchived: ({ checked }) => {
      const nextItems = Remote.load(model.items);
      return {
        model: { ...model, includeArchived: checked, items: nextItems },
        commands:
          wsId === undefined
            ? []
            : [loadItemsCommand(wsId, Remote.seqOf(nextItems), committedSearch, checked)],
      };
    },

    ClickedRetry: () => {
      const nextItems = Remote.load(model.items);
      return {
        model: { ...model, items: nextItems },
        commands:
          wsId === undefined
            ? []
            : [
                loadItemsCommand(
                  wsId,
                  Remote.seqOf(nextItems),
                  committedSearch,
                  model.includeArchived,
                ),
              ],
      };
    },

    ClickedNew: () => ({
      model: { ...model, editor: emptyDraft() },
    }),

    ClickedEdit: ({ item }) => ({
      model: { ...model, editor: draftFromItem(item) },
    }),

    ClickedCloseEditor: () => ({
      model: { ...model, editor: null },
    }),

    ChangedField: ({ field, value }) => {
      if (model.editor === null) return { model };
      return {
        model: {
          ...model,
          editor: { ...model.editor, [field]: value, error: null },
        },
      };
    },

    SubmittedEditor: () => {
      if (model.editor === null || model.editor.saving || wsId === undefined) return { model };
      if (Str.trim(model.editor.name) === "") {
        return {
          model: {
            ...model,
            editor: { ...model.editor, error: tLocal(ctx.locale, "nameRequired") },
          },
        };
      }
      if (parseUserDecimal(model.editor.unitPrice) === null) {
        return {
          model: {
            ...model,
            editor: { ...model.editor, error: tLocal(ctx.locale, "priceInvalid") },
          },
        };
      }
      const nextEditor: EditorDraft = { ...model.editor, saving: true, error: null };
      return {
        model: { ...model, editor: nextEditor },
        commands: [saveItemCommand(wsId, nextEditor)],
      };
    },

    SavedItem: ({ item }) => {
      const existing = Remote.dataOf(model.items) ?? [];
      const idx = Option.getOrElse(
        Arr.findFirstIndex(existing, (i) => i.id === item.id),
        () => -1,
      );
      const updated =
        idx >= 0 ? Arr.map(existing, (i) => (i.id === item.id ? item : i)) : [item, ...existing];
      const nextSeq = Remote.seqOf(model.items);
      return {
        model: {
          ...model,
          items: { _tag: "Loaded", seq: nextSeq, data: updated },
          editor: null,
        },
        outMessage: Intent_.toast(tr.t("common.toast.saved"), "info"),
      };
    },

    FailedSave: ({ failure }) => {
      if (model.editor === null) return { model };
      const msg = failure.staleRevision
        ? tLocal(ctx.locale, "staleNotice")
        : textOf(tr, failure.text);
      return {
        model: { ...model, editor: { ...model.editor, saving: false, error: msg } },
      };
    },

    RequestedArchive: ({ item }) => ({
      model: { ...model, confirmArchive: item },
    }),

    CancelledArchive: () => ({
      model: { ...model, confirmArchive: null },
    }),

    ConfirmedArchive: () => {
      if (model.confirmArchive === null || wsId === undefined) return { model };
      return {
        model: { ...model, archiving: true },
        commands: [archiveItemCommand(wsId, model.confirmArchive.id)],
      };
    },

    ArchivedItem: ({ id }) => {
      const targetName = model.confirmArchive?.name ?? "";
      const existing = Remote.dataOf(model.items) ?? [];
      const updated = model.includeArchived
        ? Arr.map(existing, (i) => (i.id === id ? { ...i, archived: true } : i))
        : Arr.filter(existing, (i) => i.id !== id);
      return {
        model: {
          ...model,
          items: { _tag: "Loaded", seq: Remote.seqOf(model.items), data: updated },
          confirmArchive: null,
          archiving: false,
          editor: model.editor?.id === id ? null : model.editor,
        },
        outMessage: Intent_.toast(tr.t("common.toast.archived", { name: targetName }), "info"),
      };
    },

    FailedArchive: ({ failure }) => ({
      model: { ...model, archiving: false, confirmArchive: null },
      outMessage: Intent_.toast(textOf(tr, failure.text), "error"),
    }),
  } satisfies MessageHandlers<Message, PageReturn<Model, Message>>);
});

export const title: {
  (ctx: PageContext): (_model: Model) => string;
  (_model: Model, ctx: PageContext): string;
} = Fn.dual(2, (_model: Model, ctx: PageContext): string =>
  translator(ctx.locale).t("priceList.title"),
);

const formatVatLabel = (locale: PageContext["locale"], treatment: string | null): string => {
  const tr = translator(locale);
  if (!Schema.is(VatTreatment)(treatment)) return "—";
  const label = enumLabel(tr, "vatTreatment", treatment);
  const rate = vatRatePercent(treatment);
  if (rate === 0) return label;
  return tr.t("priceList.vatToday", {
    treatment: label,
    rate: Format.formatVatRate(locale, rate),
  });
};

export const view: {
  (ctx: PageContext, h: Html.H<Message>): (model: Model) => Markup<Message>;
  (model: Model, ctx: PageContext, h: Html.H<Message>): Markup<Message>;
} = Fn.dual(3, (model: Model, ctx: PageContext, h: Html.H<Message>): Markup<Message> => {
  const tr = translator(ctx.locale);
  const writable = canWrite(ctx);
  const items = Remote.dataOf(model.items);
  const headers = [
    tr.t("priceList.column.name"),
    tr.t("priceList.column.unit"),
    tr.t("priceList.column.price"),
    tr.t("priceList.column.vat"),
    tr.t("common.field.status"),
    "",
  ];

  const toolbar = h.div
    .attr("data-slot", "rec-toolbar")
    .class("flex flex-wrap items-center justify-between gap-3")
    .children([
      h.search.children([
        h.form
          .class(ui.row)
          .attr("action", Str.split(ctx.path, "?")[0] ?? ctx.path)
          .on("submit", Message.SubmittedSearch(), { preventDefault: true })
          .children([
            h.div.class("relative max-w-[380px] flex-[1_1_240px]").children([
              h.span
                .class(
                  "pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant",
                )
                .children([icon(h, "search", 16)]),
              searchInput(h, {
                name: "text",
                value: model.search,
                placeholder: tr.t("priceList.search"),
                ariaLabel: tr.t("priceList.search"),
                inputClassName: "pl-[34px]",
                onInput: (value) => Message.ChangedSearch({ value }),
              }),
            ]),
            button(h, { label: tr.t("common.action.search"), type: "submit" }),
          ]),
      ]),
      h.div.class(ui.row).children([
        checkbox(h, {
          id: "pricelist-include-archived",
          label: tr.t("priceList.showArchived"),
          checked: model.includeArchived,
          onToggle: (checked) => Message.ToggledIncludeArchived({ checked }),
        }),
        ...(items !== undefined
          ? [
              h.span
                .class(cn(ui.small, ui.muted, ui.num))
                .children([tLocal(ctx.locale, "countLabel", { count: items.length })]),
            ]
          : []),
      ]),
    ]);

  const listBody = (() => {
    if (model.items._tag === "Loading" || model.items._tag === "Idle") {
      return skeletonTable(h, headers, 6);
    }
    if (model.items._tag === "Failed") {
      return banner(h, {
        text: textOf(tr, model.items.failure.text),
        tone: "error",
        action: button(h, {
          label: tr.t("common.action.retry"),
          small: true,
          onClick: Message.ClickedRetry(),
        }),
      });
    }
    if (items === undefined || items.length === 0) {
      const action = writable
        ? {
            action: button(h, {
              label: tr.t("priceList.empty.cta"),
              variant: "primary",
              icon: icon(h, "plus", 16),
              onClick: Message.ClickedNew(),
            }),
          }
        : undefined;
      return emptyState(h, {
        title: tr.t("priceList.empty.title"),
        body: tLocal(ctx.locale, "subtitle"),
        ...action,
      });
    }
    const rowAction = writable
      ? { onRowClick: (item: PriceListItemRecord) => Message.ClickedEdit({ item }) }
      : undefined;
    return table<PriceListItemRecord, Message>(h, {
      caption: tr.t("priceList.title"),
      rows: items,
      rowKey: (item) => item.id,
      ...rowAction,
      columns: [
        {
          header: tr.t("priceList.column.name"),
          cell: (item) =>
            h.div
              .class(cn(ui.stack, item.archived && "opacity-65"))
              .style({ "--kb-gap": "2px" })
              .children([
                h.strong.children([item.name]),
                ...(item.description !== null && item.description !== ""
                  ? [h.span.class(cn(ui.small, ui.muted)).children([item.description])]
                  : []),
              ]),
        },
        {
          header: tr.t("priceList.column.unit"),
          cell: (item) => h.span.class(ui.muted).children([item.unit ?? "—"]),
        },
        {
          header: tr.t("priceList.column.price"),
          align: "end",
          numeric: true,
          cell: (item) => moneyText(ctx.locale, item.unitPrice, item.currency),
        },
        {
          header: tr.t("priceList.column.vat"),
          cell: (item) => formatVatLabel(ctx.locale, item.vat),
        },
        {
          header: tr.t("common.field.status"),
          cell: (item) =>
            item.archived
              ? badge(h, tLocal(ctx.locale, "archivedBadge"), "outline")
              : badge(h, tLocal(ctx.locale, "activeBadge"), "paid"),
        },
        {
          header: "",
          align: "end",
          cell: (item) =>
            writable
              ? button(h, {
                  label: tr.t("common.action.edit"),
                  variant: "ghost",
                  small: true,
                  onClick: Message.ClickedEdit({ item }),
                })
              : h.text(""),
        },
      ],
    });
  })();

  const editorPanel =
    model.editor === null
      ? h.text("")
      : card(h, [
          cardTitle(
            h,
            model.editor.id === null
              ? tLocal(ctx.locale, "newItem")
              : tLocal(ctx.locale, "editItem"),
            [
              button(h, {
                label: tr.t("common.action.close"),
                variant: "ghost",
                small: true,
                onClick: Message.ClickedCloseEditor(),
              }),
            ],
          ),
          h.form
            .class(ui.stack)
            .on("submit", Message.SubmittedEditor(), { preventDefault: true })
            .children([
              ...(model.editor.error !== null
                ? [banner(h, { text: model.editor.error, tone: "error" })]
                : []),
              textField(h, {
                id: "pli-name",
                label: tr.t("priceList.column.name"),
                value: model.editor.name,
                required: true,
                onInput: (value) => Message.ChangedField({ field: "name", value }),
              }),
              textArea(h, {
                id: "pli-desc",
                label: tr.t("common.field.description"),
                value: model.editor.description,
                onInput: (value) => Message.ChangedField({ field: "description", value }),
              }),
              h.div
                .attr("data-slot", "form-grid")
                .class(ui.formGrid)
                .children([
                  textField(h, {
                    id: "pli-price",
                    label: tr.t("common.field.unitPrice"),
                    value: model.editor.unitPrice,
                    required: true,
                    mono: true,
                    onInput: (value) => Message.ChangedField({ field: "unitPrice", value }),
                  }),
                  selectField(h, {
                    id: "pli-currency",
                    label: tr.t("common.field.currency"),
                    value: model.editor.currency,
                    options: Arr.map(CURRENCIES, (c) => ({ value: c, label: c })),
                    onChange: (value) => Message.ChangedField({ field: "currency", value }),
                  }),
                  textField(h, {
                    id: "pli-unit",
                    label: tr.t("common.field.unit"),
                    value: model.editor.unit,
                    placeholder: tr.t("common.unit.hour"),
                    onInput: (value) => Message.ChangedField({ field: "unit", value }),
                  }),
                  selectField(h, {
                    id: "pli-vat",
                    label: tr.t("common.field.vat"),
                    value: model.editor.vat,
                    options: [
                      { value: "", label: tLocal(ctx.locale, "vatDefault") },
                      ...Arr.map(VAT_TREATMENTS, (v) => ({
                        value: v,
                        label: formatVatLabel(ctx.locale, v),
                      })),
                    ],
                    onChange: (value) => Message.ChangedField({ field: "vat", value }),
                  }),
                ]),
              h.div
                .attr("data-slot", "spread")
                .class(ui.spread)
                .children([
                  model.editor.id !== null
                    ? button(h, {
                        label: tr.t("common.action.archive"),
                        variant: "danger",
                        small: true,
                        onClick: Message.RequestedArchive({
                          item: {
                            id: model.editor.id,
                            name: model.editor.name,
                            description: model.editor.description || null,
                            unit: model.editor.unit || null,
                            unitPrice: model.editor.unitPrice,
                            currency: model.editor.currency,
                            vat: model.editor.vat || null,
                            archived: false,
                            revision: model.editor.revision ?? 1,
                          },
                        }),
                      })
                    : h.span.children([]),
                  h.div.class(ui.row).children([
                    button(h, {
                      label: tr.t("common.action.cancel"),
                      onClick: Message.ClickedCloseEditor(),
                    }),
                    button(h, {
                      label: tr.t("common.action.save"),
                      variant: "primary",
                      type: "submit",
                      busy: model.editor.saving,
                    }),
                  ]),
                ]),
            ]),
        ]);

  const archiveModal =
    model.confirmArchive === null
      ? h.text("")
      : dialog(h, {
          id: "pricelist-archive-dialog",
          title: tLocal(ctx.locale, "archiveTitle"),
          onClose: Message.CancelledArchive(),
          alert: true,
          body: [
            h.p.children([tLocal(ctx.locale, "archiveBody", { name: model.confirmArchive.name })]),
          ],
          actions: [
            button(h, {
              label: tr.t("common.action.cancel"),
              onClick: Message.CancelledArchive(),
            }),
            button(h, {
              label: tr.t("common.action.archive"),
              variant: "danger",
              busy: model.archiving,
              onClick: Message.ConfirmedArchive(),
            }),
          ],
        });

  return page(h, [
    pageHeader(h, {
      title: tr.t("priceList.title"),
      subtitle: tLocal(ctx.locale, "subtitle"),
      actions: writable
        ? [
            button(h, {
              label: tr.t("priceList.new"),
              variant: "primary",
              icon: icon(h, "plus", 16),
              onClick: Message.ClickedNew(),
            }),
          ]
        : [],
    }),
    toolbar,
    h.div
      .class(
        model.editor === null
          ? "grid grid-cols-1 gap-4"
          : "grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(300px,0.9fr)]",
      )
      .children([listBody, editorPanel]),
    archiveModal,
  ]);
});
