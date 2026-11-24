/**
 * Price List screen (Screen 16, route `PriceList`).
 * Saved catalog items with search, archived toggle, inline/sheet create & edit,
 * currency/unit/VAT defaults, archive confirmation, and zero-CLS shimmer skeleton.
 */
import type {
  CurrencyCode,
  PriceListItemId,
  PriceListItemInput,
  VatTreatment,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Format, ViewModels } from "@kvitbit/ui-port";
import { Schema } from "effect";
import { type Command, Submodel } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { Failure, request, type WebServices } from "../../app/api";
import { copy, textOf, translator } from "../../app/i18n";
import { Intent_ } from "../../app/intent";
import type { PageContext, PageReturn, RouteOf } from "../../app/page";
import * as Remote from "../../app/remote";
import { href } from "../../app/routing";
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
  selectField,
  skeletonTable,
  table,
  textArea,
  textField,
} from "../../ui/kit";
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

export type Route = RouteOf<"PriceList">;

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
  route: ViewModels.Route,
  search: Schema.String,
  includeArchived: Schema.Boolean,
  items: Remote.remoteSchema(Schema.Array(PriceListItemRecord)),
  editor: Schema.NullOr(EditorDraft),
  confirmArchive: Schema.NullOr(PriceListItemRecord),
  archiving: Schema.Boolean,
});
export type Model = typeof Model.Type;

export const Message = defineMessageUnion({
  LoadedItems: { seq: Schema.Int, items: Schema.Array(PriceListItemRecord) },
  FailedItems: { seq: Schema.Int, failure: Failure },
  ChangedSearch: { value: Schema.String },
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
): Command.Command<Message, never, WebServices> =>
  apiCommand(
    "PriceListLoadItems",
    request(
      (client) =>
        client.priceList.list({
          params: { workspaceId: workspaceId as WorkspaceId },
          query: {
            ...(text.trim() === "" ? {} : { text: text.trim() }),
            ...(includeArchived ? { includeArchived: true } : {}),
          },
        }),
      (raw): Message => Message.LoadedItems({ seq, items: raw.map(normalizePriceListItem) }),
      (failure): Message => Message.FailedItems({ seq, failure }),
    ),
  );

const saveItemCommand = (
  workspaceId: string,
  draft: EditorDraft,
): Command.Command<Message, never, WebServices> => {
  const parsedPrice = parseUserDecimal(draft.unitPrice) ?? 0;
  const payload = {
    name: draft.name.trim(),
    description: draft.description.trim() === "" ? null : draft.description.trim(),
    unit: draft.unit.trim() === "" ? null : draft.unit.trim(),
    unitPrice: String(parsedPrice),
    currency: draft.currency as CurrencyCode,
    vat: draft.vat === "" ? null : (draft.vat as VatTreatment),
  } as unknown as PriceListItemInput;

  return apiCommand(
    "PriceListSaveItem",
    request(
      (client) =>
        draft.id === null
          ? client.priceList.create({
              params: { workspaceId: workspaceId as WorkspaceId },
              headers: { "idempotency-key": draft.idempotencyKey },
              payload,
            })
          : client.priceList.update({
              params: {
                workspaceId: workspaceId as WorkspaceId,
                itemId: draft.id as PriceListItemId,
              },
              headers: { "if-match": `"${draft.revision ?? 1}"` },
              payload,
            }),
      (raw): Message => Message.SavedItem({ item: normalizePriceListItem(raw) }),
      (failure): Message => Message.FailedSave({ failure }),
    ),
  );
};

const archiveItemCommand = (
  workspaceId: string,
  itemId: string,
): Command.Command<Message, never, WebServices> =>
  apiCommand(
    "PriceListArchiveItem",
    request(
      (client) =>
        client.priceList.archive({
          params: {
            workspaceId: workspaceId as WorkspaceId,
            itemId: itemId as PriceListItemId,
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

export const init = (route: Route, ctx: PageContext): PageReturn<Model, Message> => {
  const search = route.text ?? "";
  const items = Remote.load<ReadonlyArray<PriceListItemRecord>>(Remote.idle);
  const wsId = ctx.workspace?.id;
  return {
    model: {
      route,
      search,
      includeArchived: false,
      items,
      editor: null,
      confirmArchive: null,
      archiving: false,
    },
    commands:
      wsId === undefined ? [] : [loadItemsCommand(wsId, Remote.seqOf(items), search, false)],
  };
};

export const update = (
  model: Model,
  message: Message,
  ctx: PageContext,
): PageReturn<Model, Message> => {
  const tr = translator(ctx.locale);
  const wsId = ctx.workspace?.id;
  const route = model.route as Route;

  return Message.match<PageReturn<Model, Message>>(message, {
    LoadedItems: ({ seq, items }) => ({
      model: { ...model, items: Remote.succeed(model.items, seq, items) },
    }),

    FailedItems: ({ seq, failure }) => ({
      model: { ...model, items: Remote.fail(model.items, seq, failure) },
    }),

    ChangedSearch: ({ value }) => {
      const nextItems = Remote.load(model.items);
      const trimmed = value.trim();
      const nextRoute: Route =
        trimmed === ""
          ? { _tag: "PriceList", ws: route.ws }
          : { _tag: "PriceList", ws: route.ws, text: trimmed };
      return {
        model: { ...model, search: value, items: nextItems },
        commands:
          wsId === undefined
            ? []
            : [loadItemsCommand(wsId, Remote.seqOf(nextItems), value, model.includeArchived)],
        outMessage: Intent_.navigate(href(nextRoute), true),
      };
    },

    ToggledIncludeArchived: ({ checked }) => {
      const nextItems = Remote.load(model.items);
      return {
        model: { ...model, includeArchived: checked, items: nextItems },
        commands:
          wsId === undefined
            ? []
            : [loadItemsCommand(wsId, Remote.seqOf(nextItems), model.search, checked)],
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
                  model.search,
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
      if (model.editor.name.trim() === "") {
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
      const idx = existing.findIndex((i) => i.id === item.id);
      const updated =
        idx >= 0 ? existing.map((i) => (i.id === item.id ? item : i)) : [item, ...existing];
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
        ? existing.map((i) => (i.id === id ? { ...i, archived: true } : i))
        : existing.filter((i) => i.id !== id);
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
  });
};

export const title = (_model: Model, ctx: PageContext): string =>
  translator(ctx.locale).t("priceList.title");

const formatVatLabel = (locale: PageContext["locale"], treatment: string | null): string => {
  const tr = translator(locale);
  if (treatment === null || treatment === "") return "—";
  const label = enumLabel(tr, "vatTreatment", treatment as VatTreatment);
  const rate = vatRatePercent(treatment);
  if (rate === 0) return label;
  return tr.t("priceList.vatToday", {
    treatment: label,
    rate: Format.formatVatRate(locale, rate),
  });
};

export const view = Submodel.defineView<Model, Message, PageContext>((model, ctx, h) => {
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

  const toolbar = h.div(
    [h.Class("kb-rec-toolbar")],
    [
      h.div(
        [h.Class("kb-rec-search")],
        [
          h.span([h.Class("kb-rec-search__icon")], [icon(h, "search", 16)]),
          h.input([
            h.Class("kb-input"),
            h.Type("search"),
            h.Placeholder(tr.t("priceList.search")),
            h.AriaLabel(tr.t("priceList.search")),
            h.Value(model.search),
            h.OnInput((value) => Message.ChangedSearch({ value })),
          ]),
        ],
      ),
      h.div(
        [h.Class("kb-row")],
        [
          checkbox(h, {
            id: "pricelist-include-archived",
            label: tr.t("priceList.showArchived"),
            checked: model.includeArchived,
            onToggle: (checked) => Message.ToggledIncludeArchived({ checked }),
          }),
          ...(items !== undefined
            ? [
                h.span(
                  [h.Class("kb-small kb-muted kb-num")],
                  [tLocal(ctx.locale, "countLabel", { count: items.length })],
                ),
              ]
            : []),
        ],
      ),
    ],
  );

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
      return emptyState(h, {
        title: tr.t("priceList.empty.title"),
        body: tLocal(ctx.locale, "subtitle"),
        ...(writable
          ? {
              action: button(h, {
                label: tr.t("priceList.empty.cta"),
                variant: "primary",
                icon: icon(h, "plus", 16),
                onClick: Message.ClickedNew(),
              }),
            }
          : {}),
      });
    }
    return table<PriceListItemRecord, Message>(h, {
      caption: tr.t("priceList.title"),
      rows: items,
      rowKey: (item) => item.id,
      ...(writable ? { onRowClick: (item) => Message.ClickedEdit({ item }) } : {}),
      columns: [
        {
          header: tr.t("priceList.column.name"),
          cell: (item) =>
            h.div(
              [
                h.Class(item.archived ? "kb-stack kb-row-archived" : "kb-stack"),
                h.Style({ "--kb-gap": "2px" }),
              ],
              [
                h.strong([], [item.name]),
                ...(item.description !== null && item.description !== ""
                  ? [h.span([h.Class("kb-small kb-muted")], [item.description])]
                  : []),
              ],
            ),
        },
        {
          header: tr.t("priceList.column.unit"),
          cell: (item) => h.span([h.Class("kb-muted")], [item.unit ?? "—"]),
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
              : h.empty,
        },
      ],
    });
  })();

  const editorPanel =
    model.editor === null
      ? h.empty
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
          h.form(
            [h.Class("kb-stack"), h.OnSubmit(Message.SubmittedEditor())],
            [
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
              h.div(
                [h.Class("kb-form-grid")],
                [
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
                    options: CURRENCIES.map((c) => ({ value: c, label: c })),
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
                      ...VAT_TREATMENTS.map((v) => ({
                        value: v,
                        label: formatVatLabel(ctx.locale, v),
                      })),
                    ],
                    onChange: (value) => Message.ChangedField({ field: "vat", value }),
                  }),
                ],
              ),
              h.div(
                [h.Class("kb-spread")],
                [
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
                    : h.span([], []),
                  h.div(
                    [h.Class("kb-row")],
                    [
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
                    ],
                  ),
                ],
              ),
            ],
          ),
        ]);

  const archiveModal =
    model.confirmArchive === null
      ? h.empty
      : dialog(h, {
          id: "pricelist-archive-dialog",
          title: tLocal(ctx.locale, "archiveTitle"),
          onClose: Message.CancelledArchive(),
          body: [h.p([], [tLocal(ctx.locale, "archiveBody", { name: model.confirmArchive.name })])],
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
    h.div(
      [
        h.Class(
          model.editor === null
            ? "kb-pricelist-layout"
            : "kb-pricelist-layout kb-pricelist-layout--editing",
        ),
      ],
      [listBody, editorPanel],
    ),
    archiveModal,
  ]);
});
