/**
 * Screen 05 — MCP OAuth 2.1 Consent (/oauth/consent).
 * Displays client identity & return host, workspace picker, granular per-area read/write
 * permission matrix across all 10 ScopeAreas via ui-port `ScopePicker`, and approve/deny actions.
 */
import {
  AccessMode,
  type AccessPreset,
  ConsentDecision,
  ConsentResult,
  ConsentView,
  type ConsentWorkspace,
  Scope,
} from "@kvitbit/api-contract";
import { I18n, ViewModels } from "@kvitbit/ui-port";
import { Option, Schema } from "effect";
import { Command, Submodel } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { Failure } from "../../app/api";
import { copy, translator } from "../../app/i18n";
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
  linkButton,
  segmented,
  selectField,
  skeleton,
} from "../../ui/kit";
import { callApi, failureMessage, redirectLocation } from "./_shared";

export type Route = RouteOf<"McpConsent">;

const ConsentRemote = Remote.remoteSchema(ConsentView);

export const Model = Schema.Struct({
  route: ViewModels.Route,
  consentId: Schema.String,
  consent: ConsentRemote,
  selectedWorkspaceId: Schema.NullOr(Schema.String),
  accessMode: AccessMode,
  selectedScopes: Schema.Array(Scope),
  grantableScopes: Schema.Array(Scope),
  submitSeq: Remote.Seq,
  submitting: Schema.Boolean,
  submitFailure: Schema.NullOr(Failure),
  redirectingTo: Schema.NullOr(Schema.String),
});
export type Model = typeof Model.Type;

export const Message = defineMessageUnion({
  GotConsent: { seq: Remote.Seq, consent: ConsentView },
  FailedConsent: { seq: Remote.Seq, failure: Failure },
  ClickedRetry: {},
  SelectedWorkspace: { workspaceId: Schema.String },
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

const FetchConsent = Command.define("McpConsentFetch", {
  args: { consentId: Schema.String, seq: Remote.Seq },
  messages: [Message.GotConsent, Message.FailedConsent],
  execute: ({ consentId, seq }) =>
    callApi(
      (client) => client.oauthConsent.getConsent({ params: { consentId } }),
      (consent) => Message.GotConsent({ seq, consent }),
      (failure) => Message.FailedConsent({ seq, failure }),
    ),
});

const DecideConsent = Command.define("McpConsentDecide", {
  args: { consentId: Schema.String, seq: Remote.Seq, payload: ConsentDecision },
  messages: [Message.CompletedDecision, Message.FailedDecision],
  execute: ({ consentId, seq, payload }) =>
    callApi(
      (client) => client.oauthConsent.decide({ params: { consentId }, payload }),
      (result) => Message.CompletedDecision({ seq, result }),
      (failure) => Message.FailedDecision({ seq, failure }),
    ),
});

const RedirectCmd = Command.define("McpConsentRedirect", {
  args: { url: Schema.String },
  messages: [Message.Redirected],
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

export const init = (route: Route, _ctx: PageContext): PageReturn<Model, Message> => {
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

export const update = (
  model: Model,
  message: Message,
  _ctx: PageContext,
): PageReturn<Model, Message> =>
  Message.match<PageReturn<Model, Message>>(message, {
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
      const ws = consent.workspaces.find((w) => w.id === workspaceId);
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
          : ViewModels.ScopePicker.choosePreset(current, mode as AccessPreset);
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
        workspace: model.selectedWorkspaceId as ConsentWorkspace["id"],
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
  });

export const title = (model: Model, ctx: PageContext): string => {
  const t = translator(ctx.locale);
  const consent = Remote.dataOf(model.consent);
  return consent !== undefined
    ? t.t("mcp.consent.title", { client: consent.client.name })
    : t.t("mcp.consent.permissions");
};

export const view = Submodel.defineView<Model, Message, PageContext>((model, ctx, h) => {
  const t = translator(ctx.locale);

  if (model.redirectingTo !== null) {
    return h.div(
      [h.Class("kb-consent-shell"), h.AriaBusy(true)],
      [card(h, [h.p([], [local(ctx.locale, "redirecting")])])],
    );
  }

  if (model.consent._tag === "Loading" || model.consent._tag === "Idle") {
    return h.div(
      [h.Class("kb-consent-shell"), h.AriaBusy(true)],
      [card(h, [skeleton(h, "60%", "1.5rem"), skeleton(h, "100%", "12rem")])],
    );
  }

  if (model.consent._tag === "Failed") {
    const expired = model.consent.failure.tag === "NotFound";
    return h.div(
      [h.Class("kb-consent-shell")],
      [
        card(h, [
          h.div(
            [h.Class("kb-stack")],
            [
              h.div(
                [h.Class("kb-row")],
                [
                  icon(h, "alert", 20),
                  h.h1([], [expired ? t.t("mcp.consent.expired") : t.t("common.state.error")]),
                ],
              ),
              ...(!expired
                ? [
                    h.p([h.Class("kb-muted")], [failureMessage(t, model.consent.failure)]),
                    h.div(
                      [h.Class("kb-row")],
                      [
                        button(h, {
                          label: t.t("common.action.retry"),
                          onClick: Message.ClickedRetry(),
                          variant: "primary",
                        }),
                      ],
                    ),
                  ]
                : []),
            ],
          ),
        ]),
      ],
    );
  }

  const consent = model.consent.data;
  const currentWs = consent.workspaces.find((w) => w.id === model.selectedWorkspaceId);
  const picker = pickerFromModel(model);
  const rows = ViewModels.ScopePicker.rows(picker);
  const canApprove =
    currentWs !== undefined &&
    Option.isSome(ViewModels.toAccessRequest(picker)) &&
    !model.submitting;
  const presetItems = (["read", "read_write", "custom"] as const).filter(
    (m) => m === "custom" || ViewModels.presetAvailable(picker, m),
  );

  return h.div(
    [h.Class("kb-consent-shell")],
    [
      card(h, [
        h.div(
          [h.Class("kb-consent-client")],
          [
            h.span(
              [h.Class("kb-consent-client__avatar"), h.AriaHidden(true)],
              [consent.client.name.slice(0, 1).toUpperCase()],
            ),
            h.div(
              [h.Class("kb-stack"), h.Style({ "--kb-gap": "2px" })],
              [
                h.h1([], [t.t("mcp.consent.title", { client: consent.client.name })]),
                h.p(
                  [h.Class("kb-small kb-muted")],
                  [t.t("mcp.consent.redirectHost", { host: consent.client.redirectHost })],
                ),
              ],
            ),
          ],
        ),
      ]),
      ...(model.submitFailure !== null
        ? [banner(h, { text: failureMessage(t, model.submitFailure), tone: "error" })]
        : []),
      ...(consent.workspaces.length === 0
        ? [
            card(h, [
              h.div(
                [h.Class("kb-stack")],
                [
                  banner(h, { text: t.t("mcp.consent.noWorkspace"), tone: "info" }),
                  h.div(
                    [h.Class("kb-row")],
                    [
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
                    ],
                  ),
                ],
              ),
            ]),
          ]
        : [
            card(h, [
              h.div(
                [h.Class("kb-stack")],
                [
                  selectField(h, {
                    id: "consent-workspace",
                    label: t.t("mcp.consent.workspace"),
                    hint: t.t("mcp.consent.pickWorkspace"),
                    value: model.selectedWorkspaceId ?? "",
                    options: consent.workspaces.map((ws) => ({
                      value: ws.id,
                      label: `${ws.name} (${t.translate(I18n.enumText("role", ws.role))})`,
                    })),
                    onChange: (workspaceId) => Message.SelectedWorkspace({ workspaceId }),
                  }),
                  ...(currentWs?.role === "accountant"
                    ? [banner(h, { text: t.t("mcp.consent.accountantReadOnly"), tone: "info" })]
                    : []),
                  ...(currentWs !== undefined && currentWs.offerableScopes.length === 0
                    ? [banner(h, { text: t.t("mcp.consent.roleCannotGrant"), tone: "error" })]
                    : []),
                ],
              ),
            ]),
            card(h, [
              cardTitle(h, t.t("mcp.consent.permissions"), [
                ...(currentWs !== undefined
                  ? [badge(h, t.translate(I18n.enumText("role", currentWs.role)), "outline")]
                  : []),
              ]),
              h.div(
                [h.Class("kb-stack")],
                [
                  segmented(h, {
                    label: t.t("mcp.consent.permissions"),
                    selected: model.accessMode,
                    items: presetItems.map((m) => ({
                      id: m,
                      label: t.translate(I18n.enumText("accessMode", m)),
                    })),
                    onSelect: (id) =>
                      Message.SelectedPreset({
                        mode:
                          id === "read" || id === "read_write" || id === "custom" ? id : "custom",
                      }),
                  }),
                  h.table(
                    [h.Class("kb-scope-matrix")],
                    [
                      h.thead(
                        [],
                        [
                          h.tr(
                            [],
                            [
                              h.th([h.Scope("col")], [local(ctx.locale, "areaColumn")]),
                              h.th(
                                [h.Scope("col"), h.Class("kb-center")],
                                [local(ctx.locale, "readColumn")],
                              ),
                              h.th(
                                [h.Scope("col"), h.Class("kb-center")],
                                [local(ctx.locale, "writeColumn")],
                              ),
                            ],
                          ),
                        ],
                      ),
                      h.tbody(
                        [],
                        rows.map((row) => {
                          const areaLabel = t.translate(I18n.enumText("scopeArea", row.area));
                          const readScope = `${row.area}:read` as Scope;
                          const writeScope = `${row.area}:write` as Scope;
                          return h.keyed("tr")(
                            row.area,
                            [],
                            [
                              h.td([], [areaLabel]),
                              h.td(
                                [h.Class("kb-center")],
                                [
                                  h.input([
                                    h.Type("checkbox"),
                                    h.AriaLabel(
                                      `${areaLabel} — ${local(ctx.locale, "readColumn")}`,
                                    ),
                                    h.Checked(row.level === "read" || row.level === "write"),
                                    ...(row.readEnabled ? [] : [h.Disabled(true)]),
                                    h.OnChange(() => Message.ToggledScope({ scope: readScope })),
                                  ]),
                                ],
                              ),
                              h.td(
                                [h.Class("kb-center")],
                                [
                                  h.input([
                                    h.Type("checkbox"),
                                    h.AriaLabel(
                                      `${areaLabel} — ${local(ctx.locale, "writeColumn")}`,
                                    ),
                                    h.Checked(row.level === "write"),
                                    ...(row.writeEnabled ? [] : [h.Disabled(true)]),
                                    h.OnChange(() => Message.ToggledScope({ scope: writeScope })),
                                  ]),
                                ],
                              ),
                            ],
                          );
                        }),
                      ),
                    ],
                  ),
                  h.p([h.Class("kb-footnote")], [t.t("mcp.consent.revokeHint")]),
                  h.div(
                    [h.Class("kb-spread")],
                    [
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
                    ],
                  ),
                ],
              ),
            ]),
          ]),
    ],
  );
});
