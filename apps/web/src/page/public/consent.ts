import { UiSchema } from "@effect/ui";
import type { Html } from "@effect/ui/html";
/**
 * Screen 05 — MCP OAuth 2.1 Consent (/oauth/consent).
 * Displays client identity & return host, workspace picker, granular per-area read/write
 * permission matrix across all 10 ScopeAreas via ui-port `ScopePicker`, and approve/deny actions.
 */
import {
  AccessMode,
  ConsentDecision,
  ConsentResult,
  ConsentView,
  type ConsentWorkspace,
  Scope,
} from "@kvitbit/api-contract";
import { WorkspaceId } from "@kvitbit/domain";
import { I18n, ViewModels } from "@kvitbit/ui-port";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { Failure } from "../../app/api";
import { defineApiCommand } from "../../app/commands";
import { copy, translator } from "../../app/i18n";
import {
  type MessageHandlers,
  type PageContext,
  type PageReturn,
  RouteCases,
} from "../../app/page";
import * as Remote from "../../app/remote";
import { href } from "../../app/routing";
import { withAttributes } from "../../ui/html";
import { icon } from "../../ui/icons";
import {
  badge,
  banner,
  button,
  card,
  cardTitle,
  linkButton,
  segmented,
  selectField,
  skeleton,
} from "../../ui/kit";
import { cn, ui } from "../../ui/styles";
import { callApi, failureMessage, redirectLocation } from "./_shared";

export const Route = RouteCases.McpConsent;
export type Route = typeof Route.Type;

const ConsentRemote = Remote.remoteSchema(ConsentView);

export const Model = Schema.Struct({
  route: Route,
  consentId: Schema.String,
  consent: ConsentRemote,
  selectedWorkspaceId: Schema.NullOr(WorkspaceId),
  accessMode: AccessMode,
  selectedScopes: Schema.Array(Scope),
  grantableScopes: Schema.Array(Scope),
  submitSeq: Remote.Seq,
  submitting: Schema.Boolean,
  submitFailure: Schema.NullOr(Failure),
  redirectingTo: Schema.NullOr(Schema.String),
});
export type Model = typeof Model.Type;

export const Message = UiSchema.TaggedEnum({
  GotConsent: { seq: Remote.Seq, consent: ConsentView },
  FailedConsent: { seq: Remote.Seq, failure: Failure },
  ClickedRetry: {},
  SelectedWorkspace: { workspaceId: WorkspaceId },
  SelectedPreset: { mode: AccessMode },
  ToggledScope: { scope: Scope },
  ClickedApprove: {},
  ClickedDeny: {},
  CompletedDecision: { seq: Remote.Seq, result: ConsentResult },
  FailedDecision: { seq: Remote.Seq, failure: Failure },
  Redirected: {},
});
export type Message = typeof Message.Type;

const local = copy({
  cs: {
    areaColumn: "Oblast",
    readColumn: "Čtení",
    writeColumn: "Zápis",
    redirecting: "Přesměrovávám zpět do aplikace…",
    createWorkspace: "Vytvořit pracovní prostor",
    narrowedHint: "Rozsah oprávnění byl zúžen oproti původní žádosti aplikace.",
  },
  en: {
    areaColumn: "Area",
    readColumn: "Read",
    writeColumn: "Write",
    redirecting: "Redirecting back to the app…",
    createWorkspace: "Create workspace",
    narrowedHint: "Permissions have been narrowed from what the app originally requested.",
  },
});

const FetchConsent = defineApiCommand({
  message: Message,
  name: "McpConsentFetch",
  args: { consentId: Schema.String, seq: Remote.Seq },
  execute: ({ consentId, seq }) =>
    callApi(
      (client) => client.oauthConsent.getConsent({ params: { consentId } }),
      (consent) => Message.GotConsent({ seq, consent }),
      (failure) => Message.FailedConsent({ seq, failure }),
    ),
});

const DecideConsent = defineApiCommand({
  message: Message,
  name: "McpConsentDecide",
  args: { consentId: Schema.String, seq: Remote.Seq, payload: ConsentDecision },
  execute: ({ consentId, seq, payload }) =>
    callApi(
      (client) => client.oauthConsent.decide({ params: { consentId }, payload }),
      (result) => Message.CompletedDecision({ seq, result }),
      (failure) => Message.FailedDecision({ seq, failure }),
    ),
});

const RedirectCmd = defineApiCommand({
  message: Message,
  name: "McpConsentRedirect",
  args: { url: Schema.String },
  execute: ({ url }) => redirectLocation(url, () => Message.Redirected()),
});

const pickerFromModel = (model: Model): ViewModels.ScopePickerState => ({
  mode: model.accessMode,
  selected: new Set(model.selectedScopes),
  grantable: new Set(model.grantableScopes),
});

const applyPicker = (model: Model, picker: ViewModels.ScopePickerState): Model => ({
  ...model,
  accessMode: picker.mode,
  selectedScopes: [...picker.selected],
  grantableScopes: [...picker.grantable],
});

const initPickerForWorkspace = (
  consent: ConsentView,
  ws: ConsentWorkspace | undefined,
): ViewModels.ScopePickerState => {
  if (ws === undefined) {
    return { mode: "custom", selected: new Set(), grantable: new Set() };
  }
  const requested =
    consent.requestedAccess === "custom"
      ? { access: "custom" as const, scopes: consent.requestedScopes }
      : { access: consent.requestedAccess, scopes: consent.requestedScopes };
  const picker = ViewModels.ScopePicker.forConsent(requested, ws.offerableScopes);
  if (
    picker.mode === "custom" &&
    consent.requestedAccess === "read_write" &&
    ws.maxAccess === "read"
  ) {
    return ViewModels.ScopePicker.choosePreset(picker, "read");
  }
  return picker;
};

const initImpl = (route: Route, _ctx: PageContext): PageReturn<Model, Message> => {
  const consent = Remote.load(Remote.idle);
  const seq = Remote.seqOf(consent);
  return {
    model: {
      route,
      consentId: route.consentId,
      consent,
      selectedWorkspaceId: null,
      accessMode: "custom",
      selectedScopes: [],
      grantableScopes: [],
      submitSeq: 0,
      submitting: false,
      submitFailure: null,
      redirectingTo: null,
    },
    commands: [FetchConsent({ consentId: route.consentId, seq })],
  };
};

export const init: {
  (_ctx: PageContext): (route: Route) => PageReturn<Model, Message>;
  (route: Route, _ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(2, initImpl);

const updateImpl = (
  model: Model,
  message: Message,
  _ctx: PageContext,
): PageReturn<Model, Message> =>
  Message.match(message, {
    GotConsent: ({ seq, consent }) => {
      const nextRemote = Remote.succeed(model.consent, seq, consent);
      if (nextRemote._tag !== "Loaded") return { model: { ...model, consent: nextRemote } };
      const firstWs = consent.workspaces[0];
      const picker = initPickerForWorkspace(consent, firstWs);
      return {
        model: applyPicker(
          {
            ...model,
            consent: nextRemote,
            selectedWorkspaceId: firstWs?.id ?? null,
          },
          picker,
        ),
      };
    },
    FailedConsent: ({ seq, failure }) => ({
      model: { ...model, consent: Remote.fail(model.consent, seq, failure) },
    }),
    ClickedRetry: () => {
      const consent = Remote.load(model.consent);
      const seq = Remote.seqOf(consent);
      return {
        model: { ...model, consent },
        commands: [FetchConsent({ consentId: model.consentId, seq })],
      };
    },
    SelectedWorkspace: ({ workspaceId }) => {
      const consent = Remote.dataOf(model.consent);
      if (consent === undefined) return { model };
      const ws = Arr.findFirst(consent.workspaces, (w) => w.id === workspaceId).pipe(
        Option.getOrUndefined,
      );
      const picker = initPickerForWorkspace(consent, ws);
      return {
        model: applyPicker(
          { ...model, selectedWorkspaceId: ws?.id ?? null, submitFailure: null },
          picker,
        ),
      };
    },
    SelectedPreset: ({ mode }) => {
      const current = pickerFromModel(model);
      const next =
        mode === "custom"
          ? ViewModels.ScopePicker.chooseCustom(current)
          : ViewModels.ScopePicker.choosePreset(current, mode);
      return { model: applyPicker(model, next) };
    },
    ToggledScope: ({ scope }) => {
      const next = ViewModels.ScopePicker.toggle(pickerFromModel(model), scope);
      return { model: applyPicker(model, next) };
    },
    ClickedApprove: () => {
      if (model.selectedWorkspaceId === null) return { model };
      const accessReq = ViewModels.toAccessRequest(pickerFromModel(model));
      if (Option.isNone(accessReq)) return { model };
      const seq = model.submitSeq + 1;
      const payload: ConsentDecision = {
        _tag: "Approve",
        workspace: model.selectedWorkspaceId,
        grant: accessReq.value,
      };
      return {
        model: { ...model, submitSeq: seq, submitting: true, submitFailure: null },
        commands: [DecideConsent({ consentId: model.consentId, seq, payload })],
      };
    },
    ClickedDeny: () => {
      const seq = model.submitSeq + 1;
      const payload: ConsentDecision = { _tag: "Deny" };
      return {
        model: { ...model, submitSeq: seq, submitting: true, submitFailure: null },
        commands: [DecideConsent({ consentId: model.consentId, seq, payload })],
      };
    },
    CompletedDecision: ({ seq, result }) => {
      if (seq !== model.submitSeq) return { model };
      return {
        model: { ...model, submitting: false, redirectingTo: result.redirectTo },
        commands: [RedirectCmd({ url: result.redirectTo })],
      };
    },
    FailedDecision: ({ seq, failure }) => {
      if (seq !== model.submitSeq) return { model };
      return { model: { ...model, submitting: false, submitFailure: failure } };
    },
    Redirected: () => ({ model }),
  } satisfies MessageHandlers<Message, PageReturn<Model, Message>>);

export const update: {
  (message: Message, _ctx: PageContext): (model: Model) => PageReturn<Model, Message>;
  (model: Model, message: Message, _ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(3, updateImpl);

const titleImpl = (model: Model, ctx: PageContext): string => {
  const t = translator(ctx.locale);
  const consent = Remote.dataOf(model.consent);
  return consent !== undefined
    ? t.t("mcp.consent.title", { client: consent.client.name })
    : t.t("mcp.consent.permissions");
};

export const title: {
  (ctx: PageContext): (model: Model) => string;
  (model: Model, ctx: PageContext): string;
} = Fn.dual(2, titleImpl);

const viewImpl = (model: Model, ctx: PageContext, h: Html.H<Message>) => {
  const t = translator(ctx.locale);

  const consentShellClass = "mx-auto flex w-full max-w-[680px] flex-col gap-4.5 px-5 pt-7 pb-16";

  if (model.redirectingTo !== null) {
    return h.div
      .class(consentShellClass)
      .attr("aria-busy", String(true))
      .children([card(h, [h.p.children([local(ctx.locale, "redirecting")])])]);
  }

  if (model.consent._tag === "Loading" || model.consent._tag === "Idle") {
    return h.div
      .class(consentShellClass)
      .attr("aria-busy", String(true))
      .children([card(h, [skeleton(h, "60%", "1.5rem"), skeleton(h, "100%", "12rem")])]);
  }

  if (model.consent._tag === "Failed") {
    const expired = model.consent.failure.tag === "NotFound";
    return h.div.class(consentShellClass).children([
      card(h, [
        h.div.class(ui.stack).children([
          h.div
            .class(ui.row)
            .children([
              icon(h, "alert", 20),
              h.h1.children([expired ? t.t("mcp.consent.expired") : t.t("common.state.error")]),
            ]),
          ...(!expired
            ? [
                h.p.class(ui.muted).children([failureMessage(t, model.consent.failure)]),
                h.div.class(ui.row).children([
                  button(h, {
                    label: t.t("common.action.retry"),
                    onClick: Message.ClickedRetry(),
                    variant: "primary",
                  }),
                ]),
              ]
            : []),
        ]),
      ]),
    ]);
  }

  const consent = model.consent.data;
  const currentWs = Arr.findFirst(
    consent.workspaces,
    (w) => w.id === model.selectedWorkspaceId,
  ).pipe(Option.getOrUndefined);
  const picker = pickerFromModel(model);
  const rows = ViewModels.ScopePicker.rows(picker);
  const canApprove =
    currentWs !== undefined &&
    Option.isSome(ViewModels.toAccessRequest(picker)) &&
    !model.submitting;
  const presetItems = Arr.filter(
    ["read", "read_write", "custom"] as const,
    (m) => m === "custom" || ViewModels.presetAvailable(picker, m),
  );

  return h.div.class(consentShellClass).children([
    card(h, [
      h.div.class("flex items-center gap-3.5").children([
        h.span
          .class(
            "inline-flex h-11 w-11 flex-none items-center justify-center rounded-control bg-primary-container font-display text-[1.125rem] text-on-primary-container",
          )
          .attr("aria-hidden", String(true))
          .children([Str.toUpperCase(Str.slice(0, 1)(consent.client.name))]),
        h.div
          .class("flex flex-col gap-0.5")
          .children([
            h.h1.children([t.t("mcp.consent.title", { client: consent.client.name })]),
            h.p
              .class(cn(ui.small, ui.muted))
              .children([t.t("mcp.consent.redirectHost", { host: consent.client.redirectHost })]),
          ]),
      ]),
    ]),
    ...(model.submitFailure !== null
      ? [banner(h, { text: failureMessage(t, model.submitFailure), tone: "error" })]
      : []),
    ...(consent.workspaces.length === 0
      ? [
          card(h, [
            h.div.class(ui.stack).children([
              banner(h, { text: t.t("mcp.consent.noWorkspace"), tone: "info" }),
              h.div.class(ui.row).children([
                linkButton(h, {
                  label: local(ctx.locale, "createWorkspace"),
                  href: href({ _tag: "Onboarding" }),
                  variant: "primary",
                }),
                button(h, {
                  label: t.t("mcp.consent.deny"),
                  onClick: Message.ClickedDeny(),
                  variant: "ghost",
                }),
              ]),
            ]),
          ]),
        ]
      : [
          card(h, [
            h.div.class(ui.stack).children([
              selectField(h, {
                id: "consent-workspace",
                label: t.t("mcp.consent.workspace"),
                hint: t.t("mcp.consent.pickWorkspace"),
                value: model.selectedWorkspaceId ?? "",
                options: Arr.map(consent.workspaces, (ws) => ({
                  value: ws.id,
                  label: `${ws.name} (${t.translate(I18n.enumText({ name: "role", value: ws.role }))})`,
                })),
                onChange: (workspaceId) =>
                  Message.SelectedWorkspace({ workspaceId: WorkspaceId.make(workspaceId) }),
              }),
              ...(currentWs?.role === "accountant"
                ? [banner(h, { text: t.t("mcp.consent.accountantReadOnly"), tone: "info" })]
                : []),
              ...(currentWs !== undefined && currentWs.offerableScopes.length === 0
                ? [banner(h, { text: t.t("mcp.consent.roleCannotGrant"), tone: "error" })]
                : []),
            ]),
          ]),
          card(h, [
            cardTitle(h, t.t("mcp.consent.permissions"), [
              ...(currentWs !== undefined
                ? [
                    badge(
                      h,
                      t.translate(I18n.enumText({ name: "role", value: currentWs.role })),
                      "outline",
                    ),
                  ]
                : []),
            ]),
            h.div.class(ui.stack).children([
              segmented(h, {
                label: t.t("mcp.consent.permissions"),
                selected: model.accessMode,
                items: Arr.map(presetItems, (m) => ({
                  id: m,
                  label: t.translate(I18n.enumText({ name: "accessMode", value: m })),
                })),
                onSelect: (id) =>
                  Message.SelectedPreset({
                    mode: id === "read" || id === "read_write" || id === "custom" ? id : "custom",
                  }),
              }),
              h.table
                .class("w-full border-collapse text-[0.8125rem]")
                .attr("data-slot", "scope-matrix")
                .children([
                  h.thead.children([
                    h.tr.children([
                      h.th
                        .class("border-b border-outline-variant px-2.5 py-2 text-left")
                        .attr("scope", "col")
                        .children([local(ctx.locale, "areaColumn")]),
                      h.th
                        .class("w-[84px] border-b border-outline-variant px-2.5 py-2 text-center")
                        .attr("scope", "col")
                        .children([local(ctx.locale, "readColumn")]),
                      h.th
                        .class("w-[84px] border-b border-outline-variant px-2.5 py-2 text-center")
                        .attr("scope", "col")
                        .children([local(ctx.locale, "writeColumn")]),
                    ]),
                  ]),
                  h.tbody.children(
                    Arr.map(rows, (row) => {
                      const areaLabel = t.translate(
                        I18n.enumText({ name: "scopeArea", value: row.area }),
                      );
                      const readScope: Scope = `${row.area}:read`;
                      const writeScope: Scope = `${row.area}:write`;
                      return h.tr
                        .key(row.area)
                        .class("[&:last-child>td]:border-b-0")
                        .children([
                          h.td
                            .class("border-b border-outline-variant px-2.5 py-2 text-left")
                            .children([areaLabel]),
                          h.td
                            .class(
                              "w-[84px] border-b border-outline-variant px-2.5 py-2 text-center",
                            )
                            .children([
                              withAttributes(h.input.class(), [
                                (element) => element.class("h-4 w-4 accent-primary"),
                                (element) => element.attr("type", "checkbox"),
                                (element) =>
                                  element.attr(
                                    "aria-label",
                                    `${areaLabel} — ${local(ctx.locale, "readColumn")}`,
                                  ),
                                (element) =>
                                  element.checked(row.level === "read" || row.level === "write"),
                                (node) => (row.readEnabled ? node : node.disabled(true)),
                                (element) =>
                                  element.on("change", () =>
                                    Message.ToggledScope({ scope: readScope }),
                                  ),
                              ]),
                            ]),
                          h.td
                            .class(
                              "w-[84px] border-b border-outline-variant px-2.5 py-2 text-center",
                            )
                            .children([
                              withAttributes(h.input.class(), [
                                (element) => element.class("h-4 w-4 accent-primary"),
                                (element) => element.attr("type", "checkbox"),
                                (element) =>
                                  element.attr(
                                    "aria-label",
                                    `${areaLabel} — ${local(ctx.locale, "writeColumn")}`,
                                  ),
                                (element) => element.checked(row.level === "write"),
                                (node) => (row.writeEnabled ? node : node.disabled(true)),
                                (element) =>
                                  element.on("change", () =>
                                    Message.ToggledScope({ scope: writeScope }),
                                  ),
                              ]),
                            ]),
                        ]);
                    }),
                  ),
                ]),
              h.p.class(ui.footnote).children([t.t("mcp.consent.revokeHint")]),
              h.div.class(ui.spread).children([
                button(h, {
                  label: t.t("mcp.consent.deny"),
                  onClick: Message.ClickedDeny(),
                  variant: "secondary",
                  disabled: model.submitting,
                  testId: "consent-deny",
                }),
                button(h, {
                  label: t.t("mcp.consent.approve"),
                  onClick: Message.ClickedApprove(),
                  variant: "primary",
                  busy: model.submitting,
                  disabled: !canApprove,
                  testId: "consent-approve",
                }),
              ]),
            ]),
          ]),
        ]),
  ]);
};

export const view: {
  (ctx: PageContext, h: Html.H<Message>): (model: Model) => ReturnType<typeof viewImpl>;
  (model: Model, ctx: PageContext, h: Html.H<Message>): ReturnType<typeof viewImpl>;
} = Fn.dual(3, viewImpl);
