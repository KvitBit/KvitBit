import { UiSchema } from "@effect/ui";
import type { Html } from "@effect/ui/html";
/**
 * Screen 09 — Documents List: Invoices, Proformas, Payment Tax Documents, Credit Notes.
 * Kind/status/settlement/overdue/search filters, badges, cursor pagination, zero-CLS loading
 * skeleton, and empty state.
 */
import {
  DocumentId,
  type DocumentKind,
  DocumentSettlement,
  DocumentStatus,
  type WorkspaceId,
} from "@kvitbit/domain";
import { I18n } from "@kvitbit/ui-port";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as EffectRecord from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { Failure } from "../../app/api";
import type { PageCommand } from "../../app/commands";
import { type Copy, copy, textOf, translator } from "../../app/i18n";
import { Intent_ } from "../../app/intent";
import {
  type MessageHandlers,
  type PageContext,
  type PageReturn,
  RouteCases,
} from "../../app/page";
import * as Remote from "../../app/remote";
import { href } from "../../app/routing";
import {
  amount,
  banner,
  button,
  checkbox,
  emptyState,
  linkButton,
  mono,
  page,
  pageHeader,
  select,
  skeletonTable,
  table,
  tabs,
} from "../../ui/kit";
import {
  apiCommand,
  canRole,
  DocumentSummaryData,
  documentBadges,
  fmtDate,
  fmtMoney,
  kindBadge,
  readSummaries,
  sharedCopy,
} from "./shared";

export const Route = RouteCases.Documents;
export type Route = typeof Route.Type;

const CopyTable: Copy<
  | "title"
  | "subtitle"
  | "newInvoice"
  | "newProforma"
  | "searchPlaceholder"
  | "searchLabel"
  | "statusLabel"
  | "settlementLabel"
  | "allStatuses"
  | "allSettlements"
  | "overdueOnly"
  | "applySearch"
  | "clearFilters"
  | "tabsLabel"
  | "colNumber"
  | "colKind"
  | "colContact"
  | "colIssued"
  | "colDue"
  | "colStatus"
  | "colTotal"
  | "caption"
  | "draftNumber"
  | "emptyTitle"
  | "emptyFiltered"
  | "loadMore"
  | "showingCount"
> = {
  cs: {
    title: "Doklady",
    subtitle: "Faktury, zálohové faktury, daňové doklady k platbě a opravné daňové doklady",
    newInvoice: "Nová faktura",
    newProforma: "Nová zálohová faktura",
    searchPlaceholder: "Hledat podle čísla nebo odběratele…",
    searchLabel: "Hledat doklady",
    statusLabel: "Stav",
    settlementLabel: "Úhrada",
    allStatuses: "Všechny stavy",
    allSettlements: "Všechny úhrady",
    overdueOnly: "Jen po splatnosti",
    applySearch: "Hledat",
    clearFilters: "Vymazat filtry",
    tabsLabel: "Druh dokladu",
    colNumber: "Číslo",
    colKind: "Druh",
    colContact: "Odběratel",
    colIssued: "Vystaveno",
    colDue: "Splatnost",
    colStatus: "Stav",
    colTotal: "Celkem",
    caption: "Seznam dokladů",
    draftNumber: "Koncept",
    emptyTitle: "Zatím nemáte žádné doklady",
    emptyFiltered: "Žádný doklad neodpovídá zvoleným filtrům.",
    loadMore: "Načíst další",
    showingCount: "Zobrazeno {count} dokladů",
  },
  en: {
    title: "Documents",
    subtitle: "Invoices, proformas, payment tax documents, and credit notes",
    newInvoice: "New invoice",
    newProforma: "New proforma",
    searchPlaceholder: "Search by number or customer…",
    searchLabel: "Search documents",
    statusLabel: "Status",
    settlementLabel: "Settlement",
    allStatuses: "All statuses",
    allSettlements: "All settlements",
    overdueOnly: "Overdue only",
    applySearch: "Search",
    clearFilters: "Clear filters",
    tabsLabel: "Document kind",
    colNumber: "Number",
    colKind: "Kind",
    colContact: "Customer",
    colIssued: "Issued",
    colDue: "Due",
    colStatus: "Status",
    colTotal: "Total",
    caption: "Documents list",
    draftNumber: "Draft",
    emptyTitle: "No documents yet",
    emptyFiltered: "No documents match the current filters.",
    loadMore: "Load more",
    showingCount: "Showing {count} documents",
  },
};

const txt = copy(CopyTable);

const DocumentsPageData = Schema.Struct({
  items: Schema.Array(DocumentSummaryData),
  nextCursor: Schema.NullOr(Schema.String),
});
type DocumentsPageData = typeof DocumentsPageData.Type;

export const Model = Schema.Struct({
  route: Route,
  searchInput: Schema.String,
  list: Remote.remoteSchema(DocumentsPageData),
  loadingMore: Schema.Boolean,
});
export type Model = typeof Model.Type;

export const Message = UiSchema.TaggedEnum({
  Loaded: { seq: Remote.Seq, data: DocumentsPageData, append: Schema.Boolean },
  Failed: { seq: Remote.Seq, failure: Failure },
  ChangedSearch: { value: Schema.String },
  SubmittedSearch: {},
  SelectedStatus: { value: Schema.String },
  SelectedSettlement: { value: Schema.String },
  ToggledOverdue: { checked: Schema.Boolean },
  ClickedClearFilters: {},
  ClickedRow: { id: Schema.String },
  ClickedLoadMore: {},
  ClickedRetry: {},
});
export type Message = typeof Message.Type;

const loadDocumentsCommand = (
  workspaceId: WorkspaceId,
  query: Route["query"],
  seq: Remote.Seq,
  cursor: string | undefined,
  append: boolean,
): PageCommand<Message> =>
  apiCommand(
    Message,
    "LoadDocuments",
    (c) =>
      c.documents.list({
        params: { workspaceId },
        query: cursor === undefined ? { ...query, limit: 25 } : { ...query, cursor, limit: 25 },
      }),
    (pageRes): Message =>
      Message.Loaded({
        seq,
        data: { items: readSummaries(pageRes.items), nextCursor: pageRes.nextCursor },
        append,
      }),
    (failure): Message => Message.Failed({ seq, failure }),
  );

const initImpl = (route: Route, ctx: PageContext): PageReturn<Model, Message> => {
  const ws = ctx.workspace;
  const searchInput = route.query.text ?? "";
  if (ws === null) {
    return { model: { route, searchInput, list: Remote.idle, loadingMore: false } };
  }
  const list = Remote.load(Remote.idle);
  return {
    model: { route, searchInput, list, loadingMore: false },
    commands: [loadDocumentsCommand(ws.id, route.query, Remote.seqOf(list), undefined, false)],
  };
};

export const init: {
  (ctx: PageContext): (route: Route) => PageReturn<Model, Message>;
  (route: Route, ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(2, initImpl);

const navigateWithQuery = (
  route: Route,
  patch: Partial<{
    text: string | undefined;
    status: DocumentStatus | undefined;
    kind: DocumentKind | undefined;
    settlement: DocumentSettlement | undefined;
    overdue: boolean | undefined;
  }>,
) => {
  const filtered = EffectRecord.filter<string, string | boolean | undefined>(
    { ...route.query, ...patch },
    (value) => value !== undefined && value !== "" && value !== false,
  );
  const query = Option.getOrElse(
    Schema.decodeOption(Route.fields.query)(filtered),
    () => route.query,
  );
  const nextRoute: Route = { _tag: "Documents", ws: route.ws, query };
  return Intent_.navigate(href(nextRoute), true);
};

const updateImpl = (
  model: Model,
  message: Message,
  ctx: PageContext,
): PageReturn<Model, Message> => {
  const route = model.route;
  return Message.match(message, {
    Loaded: ({ seq, data, append }) => {
      if (append) {
        const existing = Remote.dataOf(model.list);
        const merged: DocumentsPageData = {
          items: [...(existing?.items ?? []), ...data.items],
          nextCursor: data.nextCursor,
        };
        return {
          model: { ...model, list: Remote.succeed(model.list, seq, merged), loadingMore: false },
        };
      }
      return {
        model: { ...model, list: Remote.succeed(model.list, seq, data), loadingMore: false },
      };
    },
    Failed: ({ seq, failure }) => ({
      model: { ...model, list: Remote.fail(model.list, seq, failure), loadingMore: false },
    }),
    ChangedSearch: ({ value }) => ({ model: { ...model, searchInput: value } }),
    SubmittedSearch: () => ({
      model,
      outMessage: navigateWithQuery(route, { text: Str.trim(model.searchInput) || undefined }),
    }),
    SelectedStatus: ({ value }) => ({
      model,
      outMessage: navigateWithQuery(route, {
        status: Option.getOrUndefined(Schema.decodeUnknownOption(DocumentStatus)(value)),
      }),
    }),
    SelectedSettlement: ({ value }) => ({
      model,
      outMessage: navigateWithQuery(route, {
        settlement: Option.getOrUndefined(Schema.decodeUnknownOption(DocumentSettlement)(value)),
      }),
    }),
    ToggledOverdue: ({ checked }) => ({
      model,
      outMessage: navigateWithQuery(route, { overdue: checked ? true : undefined }),
    }),
    ClickedClearFilters: () => ({
      model: { ...model, searchInput: "" },
      outMessage: Intent_.navigate(href({ _tag: "Documents", ws: route.ws, query: {} }), true),
    }),
    ClickedRow: ({ id }) => ({
      model,
      outMessage: Intent_.navigate(
        href({
          _tag: "Document",
          ws: route.ws,
          id: DocumentId.make(id),
          tab: "preview",
        }),
      ),
    }),
    ClickedLoadMore: () => {
      const ws = ctx.workspace;
      const data = Remote.dataOf(model.list);
      if (ws === null || data === undefined || data.nextCursor === null || model.loadingMore) {
        return { model };
      }
      const list = Remote.load(model.list);
      return {
        model: { ...model, list, loadingMore: true },
        commands: [
          loadDocumentsCommand(ws.id, route.query, Remote.seqOf(list), data.nextCursor, true),
        ],
      };
    },
    ClickedRetry: () => {
      const ws = ctx.workspace;
      if (ws === null) return { model };
      const list = Remote.load(model.list);
      return {
        model: { ...model, list, loadingMore: false },
        commands: [loadDocumentsCommand(ws.id, route.query, Remote.seqOf(list), undefined, false)],
      };
    },
  } satisfies MessageHandlers<Message, PageReturn<Model, Message>>);
};

export const update: {
  (message: Message, ctx: PageContext): (model: Model) => PageReturn<Model, Message>;
  (model: Model, message: Message, ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(3, updateImpl);

const titleImpl = (_model: Model, ctx: PageContext): string => txt(ctx.locale, "title");

export const title: {
  (ctx: PageContext): (_model: Model) => string;
  (_model: Model, ctx: PageContext): string;
} = Fn.dual(2, titleImpl);

const activeTabId = (q: Route["query"]): string => {
  if (q.status === "draft") return "drafts";
  if (q.kind === "invoice") return "invoices";
  if (q.kind === "proforma") return "proformas";
  if (q.kind === "payment_tax_document") return "tax_documents";
  if (q.kind === "credit_note") return "credit_notes";
  return "all";
};

const viewImpl = (model: Model, ctx: PageContext, h: Html.H<Message>) => {
  const { locale } = ctx;
  const t = translator(locale);
  const route = model.route;
  const ws = ctx.workspace;
  if (ws === null) {
    return page(h, [banner(h, { text: sharedCopy(locale, "noWorkspace"), tone: "error" })]);
  }
  const slug = ws.slug;
  const canCreateDraft = canRole(ws.role, "document.draft");
  const q = route.query;
  const hasFilters =
    q.kind !== undefined ||
    q.status !== undefined ||
    q.settlement !== undefined ||
    q.overdue === true ||
    (q.text !== undefined && q.text !== "");

  const tabItems = [
    {
      id: "all",
      label: textOf(t, I18n.enumText({ name: "documentTab", value: "all" })),
      href: href({ _tag: "Documents", ws: slug, query: {} }),
    },
    {
      id: "drafts",
      label: textOf(t, I18n.enumText({ name: "documentTab", value: "drafts" })),
      href: href({ _tag: "Documents", ws: slug, query: { status: "draft" } }),
    },
    {
      id: "invoices",
      label: textOf(t, I18n.enumText({ name: "documentTab", value: "invoices" })),
      href: href({ _tag: "Documents", ws: slug, query: { kind: "invoice" } }),
    },
    {
      id: "proformas",
      label: textOf(t, I18n.enumText({ name: "documentTab", value: "proformas" })),
      href: href({ _tag: "Documents", ws: slug, query: { kind: "proforma" } }),
    },
    {
      id: "tax_documents",
      label: textOf(t, I18n.enumText({ name: "documentTab", value: "tax_documents" })),
      href: href({ _tag: "Documents", ws: slug, query: { kind: "payment_tax_document" } }),
    },
    {
      id: "credit_notes",
      label: textOf(t, I18n.enumText({ name: "documentTab", value: "credit_notes" })),
      href: href({ _tag: "Documents", ws: slug, query: { kind: "credit_note" } }),
    },
  ];

  const headers = [
    txt(locale, "colNumber"),
    txt(locale, "colKind"),
    txt(locale, "colContact"),
    txt(locale, "colIssued"),
    txt(locale, "colDue"),
    txt(locale, "colStatus"),
    txt(locale, "colTotal"),
  ];

  const data = Remote.dataOf(model.list);

  const body =
    model.list._tag === "Failed"
      ? banner(h, {
          text: textOf(t, model.list.failure.text),
          tone: "error",
          action: button(h, {
            label: sharedCopy(locale, "retry"),
            onClick: Message.ClickedRetry(),
            small: true,
          }),
        })
      : data === undefined
        ? skeletonTable(h, headers, 6)
        : data.items.length === 0
          ? emptyState(h, {
              title: hasFilters ? txt(locale, "emptyFiltered") : txt(locale, "emptyTitle"),
              ...(hasFilters
                ? {
                    action: button(h, {
                      label: txt(locale, "clearFilters"),
                      onClick: Message.ClickedClearFilters(),
                    }),
                  }
                : canCreateDraft
                  ? {
                      action: linkButton(h, {
                        label: txt(locale, "newInvoice"),
                        href: href({ _tag: "DocumentNew", ws: slug, kind: "invoice" }),
                        variant: "primary",
                      }),
                    }
                  : {}),
            })
          : h.div.class("kb-stack").children([
              table(h, {
                caption: txt(locale, "caption"),
                rows: data.items,
                rowKey: (row) => row.id,
                onRowClick: (row) => Message.ClickedRow({ id: row.id }),
                columns: [
                  {
                    header: txt(locale, "colNumber"),
                    cell: (row) =>
                      h.a
                        .attr(
                          "href",
                          href({ _tag: "Document", ws: slug, id: row.id, tab: "preview" }),
                        )
                        .class("kb-queue-item__link")
                        .children([mono(h, row.number ?? txt(locale, "draftNumber"))]),
                  },
                  {
                    header: txt(locale, "colKind"),
                    cell: (row) => kindBadge(h, locale, row.kind),
                  },
                  {
                    header: txt(locale, "colContact"),
                    cell: (row) => row.contact.name,
                  },
                  {
                    header: txt(locale, "colIssued"),
                    numeric: true,
                    cell: (row) => fmtDate(locale, row.issuedOn),
                  },
                  {
                    header: txt(locale, "colDue"),
                    numeric: true,
                    cell: (row) => fmtDate(locale, row.dueOn),
                  },
                  {
                    header: txt(locale, "colStatus"),
                    cell: (row) =>
                      h.span.class("kb-docs-badges").children(documentBadges(h, locale, row)),
                  },
                  {
                    header: txt(locale, "colTotal"),
                    align: "end",
                    numeric: true,
                    cell: (row) => amount(h, fmtMoney(locale, row.total)),
                  },
                ],
              }),
              h.div.class("kb-docs-pager").children([
                h.span
                  .class("kb-small kb-muted kb-num")
                  .children([txt(locale, "showingCount", { count: data.items.length })]),
                ...(data.nextCursor === null
                  ? []
                  : [
                      button(h, {
                        label: txt(locale, "loadMore"),
                        onClick: Message.ClickedLoadMore(),
                        busy: model.loadingMore,
                      }),
                    ]),
              ]),
            ]);

  return page(h, [
    pageHeader(h, {
      title: txt(locale, "title"),
      subtitle: txt(locale, "subtitle"),
      actions: canCreateDraft
        ? [
            linkButton(h, {
              label: txt(locale, "newProforma"),
              href: href({ _tag: "DocumentNew", ws: slug, kind: "proforma" }),
            }),
            linkButton(h, {
              label: txt(locale, "newInvoice"),
              href: href({ _tag: "DocumentNew", ws: slug, kind: "invoice" }),
              variant: "primary",
            }),
          ]
        : [],
    }),
    tabs(h, {
      label: txt(locale, "tabsLabel"),
      items: tabItems,
      selected: activeTabId(q),
    }),
    h.div.class("kb-docs-toolbar").children([
      h.form
        .class("kb-docs-filters")
        .on("submit", Message.SubmittedSearch(), { preventDefault: true })
        .children([
          h.input
            .class("kb-input kb-docs-search")
            .attr("type", "search")
            .attr("aria-label", txt(locale, "searchLabel"))
            .attr("placeholder", txt(locale, "searchPlaceholder"))
            .value(model.searchInput)
            .on("input", ({ value }) => Message.ChangedSearch({ value })),
          select(h, {
            id: "docs-status",
            label: txt(locale, "statusLabel"),
            value: q.status ?? "",
            onChange: (value) => Message.SelectedStatus({ value }),
            options: [
              { value: "", label: txt(locale, "allStatuses") },
              {
                value: "draft",
                label: textOf(t, I18n.enumText({ name: "documentStatus", value: "draft" })),
              },
              {
                value: "issued",
                label: textOf(t, I18n.enumText({ name: "documentStatus", value: "issued" })),
              },
              {
                value: "cancelled",
                label: textOf(t, I18n.enumText({ name: "documentStatus", value: "cancelled" })),
              },
            ],
          }),
          select(h, {
            id: "docs-settlement",
            label: txt(locale, "settlementLabel"),
            value: q.settlement ?? "",
            onChange: (value) => Message.SelectedSettlement({ value }),
            options: [
              { value: "", label: txt(locale, "allSettlements") },
              {
                value: "unpaid",
                label: textOf(t, I18n.enumText({ name: "settlement", value: "unpaid" })),
              },
              {
                value: "partially_paid",
                label: textOf(t, I18n.enumText({ name: "settlement", value: "partially_paid" })),
              },
              {
                value: "paid",
                label: textOf(t, I18n.enumText({ name: "settlement", value: "paid" })),
              },
              {
                value: "overpaid",
                label: textOf(t, I18n.enumText({ name: "settlement", value: "overpaid" })),
              },
              {
                value: "credited",
                label: textOf(t, I18n.enumText({ name: "settlement", value: "credited" })),
              },
            ],
          }),
          checkbox(h, {
            id: "docs-overdue",
            label: txt(locale, "overdueOnly"),
            checked: q.overdue === true,
            onToggle: (checked) => Message.ToggledOverdue({ checked }),
          }),
          button(h, {
            label: txt(locale, "applySearch"),
            type: "submit",
            small: true,
          }),
          ...(hasFilters
            ? [
                button(h, {
                  label: txt(locale, "clearFilters"),
                  onClick: Message.ClickedClearFilters(),
                  variant: "ghost",
                  small: true,
                }),
              ]
            : []),
        ]),
    ]),
    body,
  ]);
};

export const view: {
  (ctx: PageContext, h: Html.H<Message>): (model: Model) => ReturnType<typeof viewImpl>;
  (model: Model, ctx: PageContext, h: Html.H<Message>): ReturnType<typeof viewImpl>;
} = Fn.dual(3, viewImpl);
