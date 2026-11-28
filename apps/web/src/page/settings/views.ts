import type { Html } from "@effect/ui/html";
/**
 * View renderers for Workspace Settings (Screens 18–21) and Mobile More hub.
 * Split from settings.ts for readability; pure Effect UI HtmlBuilder views only.
 */
import { CurrencyCode } from "@kvitbit/domain";
import { I18n, Theme, ViewModels } from "@kvitbit/ui-port";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { textOf, translator } from "../../app/i18n";
import type { PageContext } from "../../app/page";
import * as Remote from "../../app/remote";
import { defaultReportRoute, href } from "../../app/routing";
import { attribute, type Markup, withAttributes } from "../../ui/html";
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
  segmented,
  selectField,
  skeleton,
  table,
  tabs,
  textArea,
  textField,
} from "../../ui/kit";
import { sCopy } from "./copy";
import {
  CURRENCY_OPTIONS,
  czechAccountFromIban,
  DOCUMENT_KINDS,
  PAYMENT_METHODS,
  previewNumberingPattern,
  TAX_REGIMES,
} from "./models";
import { brandingMiniPreview, scopeMatrixEditor, scopeSummaryBadges } from "./preview";
import {
  canEditSettings,
  Message,
  type Model,
  SETTINGS_SECTIONS,
  type SettingsSection,
  scopePickerFromModel,
} from "./state";

const sectionLabel = (t: I18n.Translator, s: SettingsSection): string => t.t(`settings.nav.${s}`);

// --- Mobile More Hub ----------------------------------------------------------------------------

const viewMoreHub = (ctx: PageContext, h: Html.H<Message>): Markup<Message> => {
  const t = translator(ctx.locale);
  const ws = ctx.workspace?.slug;
  if (ws === undefined) return page(h, [pageHeader(h, { title: sCopy(ctx.locale, "more.title") })]);

  const workspaceLinks: ReadonlyArray<{ readonly label: string; readonly to: string }> = [
    { label: t.t("shell.nav.templates"), to: href({ _tag: "Templates", ws }) },
    { label: t.t("shell.nav.priceList"), to: href({ _tag: "PriceList", ws }) },
    { label: t.t("shell.nav.reports"), to: href(defaultReportRoute(ws, 2026)) },
  ];

  return page(h, [
    pageHeader(h, {
      title: sCopy(ctx.locale, "more.title"),
      subtitle: ctx.workspace?.name ?? sCopy(ctx.locale, "more.subtitle"),
    }),
    card(h, [
      cardTitle(h, sCopy(ctx.locale, "more.workspace")),
      h.div.class("kb-more-grid").children(
        Arr.map(workspaceLinks, (item) =>
          h.a
            .class("kb-more-link")
            .attr("href", item.to)
            .children([h.span.children([item.label]), h.span.children(["→"])]),
        ),
      ),
    ]),
    card(h, [
      cardTitle(h, sCopy(ctx.locale, "more.settings")),
      h.div.class("kb-more-grid").children(
        Arr.map(SETTINGS_SECTIONS, (section) =>
          h.a
            .class("kb-more-link")
            .attr("href", href({ _tag: "Settings", ws, section }))
            .children([h.span.children([sectionLabel(t, section)]), h.span.children(["→"])]),
        ),
      ),
    ]),
    card(h, [
      cardTitle(h, sCopy(ctx.locale, "more.account")),
      h.div.class("kb-more-grid").children(
        Arr.map(["profile", "appearance", "security", "sessions", "danger"] as const, (tab) =>
          h.a
            .class("kb-more-link")
            .attr("href", href({ _tag: "Account", tab }))
            .children([
              h.span.children([sCopy(ctx.locale, `account.nav.${tab}`)]),
              h.span.children(["→"]),
            ]),
        ),
      ),
    ]),
  ]);
};

// --- Section 1: Issuing Entity ------------------------------------------------------------------

const viewIssuingEntity = (model: Model, ctx: PageContext, h: Html.H<Message>): Markup<Message> => {
  const t = translator(ctx.locale);
  const editable = canEditSettings(ctx);
  const f = model.entityForm;

  if (model.workspace._tag === "Loading") {
    return card(h, [
      cardTitle(h, t.t("settings.issuingEntity.title")),
      skeleton(h, "100%", "40px"),
      skeleton(h, "100%", "40px"),
      skeleton(h, "80%", "40px"),
    ]);
  }

  return card(h, [
    cardTitle(h, t.t("settings.issuingEntity.title"), [
      ...(editable
        ? [
            button(h, {
              label: t.t("common.action.saveChanges"),
              variant: "primary",
              busy: f.saving,
              onClick: Message.ClickedSaveEntity(),
            }),
          ]
        : []),
    ]),
    h.p.class("kb-muted").children([t.t("settings.issuingEntity.intro")]),
    h.div.class("kb-ares-row").children([
      textField(h, {
        id: "kb-entity-ico",
        label: t.t("common.field.ico"),
        placeholder: sCopy(ctx.locale, "entity.aresPlaceholder"),
        value: f.ico,
        mono: true,
        disabled: !editable,
        onInput: (value) => Message.ChangedEntityField({ field: "ico", value }),
      }),
      button(h, {
        label: t.t("settings.issuingEntity.refreshAres"),
        disabled: !editable || Str.trim(f.ico) === "",
        busy: f.lookingUpAres,
        onClick: Message.ClickedAresLookup(),
      }),
    ]),
    h.div.class("kb-form-grid").children([
      textField(h, {
        id: "kb-entity-name",
        label: t.t("common.field.name"),
        value: f.name,
        required: true,
        disabled: !editable,
        onInput: (value) => Message.ChangedEntityField({ field: "name", value }),
      }),
      textField(h, {
        id: "kb-entity-dic",
        label: t.t("common.field.dic"),
        value: f.dic,
        mono: true,
        disabled: !editable,
        onInput: (value) => Message.ChangedEntityField({ field: "dic", value }),
      }),
      textField(h, {
        id: "kb-entity-legal-form",
        label: sCopy(ctx.locale, "entity.legalForm"),
        value: f.legalForm,
        disabled: !editable,
        onInput: (value) => Message.ChangedEntityField({ field: "legalForm", value }),
      }),
      textField(h, {
        id: "kb-entity-slug",
        label: sCopy(ctx.locale, "entity.slug"),
        value: f.slug,
        mono: true,
        disabled: true,
        onInput: (value) => Message.ChangedEntityField({ field: "slug", value }),
      }),
    ]),
    textField(h, {
      id: "kb-entity-register",
      label: t.t("settings.issuingEntity.registerEntry"),
      hint: t.t("settings.issuingEntity.registerEntryHint"),
      value: f.registerEntry,
      disabled: !editable,
      onInput: (value) => Message.ChangedEntityField({ field: "registerEntry", value }),
    }),
    h.div.class("kb-form-grid").children([
      textField(h, {
        id: "kb-entity-street",
        label: t.t("common.field.street"),
        value: f.street,
        disabled: !editable,
        onInput: (value) => Message.ChangedEntityField({ field: "street", value }),
      }),
      textField(h, {
        id: "kb-entity-city",
        label: t.t("common.field.city"),
        value: f.city,
        disabled: !editable,
        onInput: (value) => Message.ChangedEntityField({ field: "city", value }),
      }),
      textField(h, {
        id: "kb-entity-postal",
        label: t.t("common.field.postalCode"),
        value: f.postalCode,
        mono: true,
        disabled: !editable,
        onInput: (value) => Message.ChangedEntityField({ field: "postalCode", value }),
      }),
      textField(h, {
        id: "kb-entity-country",
        label: t.t("common.field.country"),
        value: f.country,
        mono: true,
        disabled: !editable,
        onInput: (value) => Message.ChangedEntityField({ field: "country", value }),
      }),
      textField(h, {
        id: "kb-entity-email",
        label: t.t("common.field.email"),
        type: "email",
        value: f.email,
        disabled: !editable,
        onInput: (value) => Message.ChangedEntityField({ field: "email", value }),
      }),
      textField(h, {
        id: "kb-entity-phone",
        label: t.t("common.field.phone"),
        value: f.phone,
        disabled: !editable,
        onInput: (value) => Message.ChangedEntityField({ field: "phone", value }),
      }),
      textField(h, {
        id: "kb-entity-web",
        label: t.t("common.field.website"),
        value: f.web,
        disabled: !editable,
        onInput: (value) => Message.ChangedEntityField({ field: "web", value }),
      }),
    ]),
  ]);
};

// --- Section 2: Tax Regime ----------------------------------------------------------------------

const viewTaxRegime = (model: Model, ctx: PageContext, h: Html.H<Message>): Markup<Message> => {
  const t = translator(ctx.locale);
  const editable = canEditSettings(ctx);
  const ws = Remote.dataOf(model.workspace);
  const currentRegime = ws?.taxRegime ?? ctx.workspace?.taxRegime ?? "vat_payer";
  const history = ws?.taxRegimeHistory ?? [];
  const regimeOptions = Arr.map(
    TAX_REGIMES,
    (r) =>
      ({
        value: r,
        label: t.translate(I18n.enumText({ name: "taxRegime", value: r })),
      }) as const,
  );

  return h.div.class("kb-stack").children([
    card(h, [
      cardTitle(h, t.t("settings.taxRegime.title"), [
        badge(
          h,
          t.translate(I18n.enumText({ name: "taxRegime", value: currentRegime })),
          "proforma",
        ),
      ]),
      h.p
        .class("kb-muted")
        .children([t.translate(I18n.enumText({ name: "taxRegimeHint", value: currentRegime }))]),
      h.p.class("kb-small kb-muted").children([t.t("settings.taxRegime.keepsOld")]),
      ...(editable
        ? [
            h.div.class("kb-form-grid").children([
              selectField(h, {
                id: "kb-tax-regime-select",
                label: sCopy(ctx.locale, "tax.regime"),
                value: model.taxForm.nextRegime,
                options: regimeOptions,
                onChange: (value) => Message.ChangedTaxRegime({ regime: value }),
              }),
              textField(h, {
                id: "kb-tax-effective",
                label: t.t("settings.taxRegime.effectiveFrom"),
                type: "date",
                mono: true,
                value: model.taxForm.effectiveFrom,
                onInput: (value) => Message.ChangedTaxEffectiveFrom({ value }),
              }),
            ]),
            h.div.class("kb-row").children([
              button(h, {
                label: sCopy(ctx.locale, "tax.schedule"),
                variant: "primary",
                busy: model.taxForm.saving,
                onClick: Message.ClickedAskChangeTaxRegime(),
              }),
            ]),
          ]
        : []),
    ]),
    card(h, [
      cardTitle(h, sCopy(ctx.locale, "tax.history")),
      ...(history.length === 0
        ? [emptyState(h, { title: sCopy(ctx.locale, "tax.noHistory") })]
        : [
            table(h, {
              caption: sCopy(ctx.locale, "tax.history"),
              rows: history,
              rowKey: (row) => `${row.effectiveFrom}-${row.regime}`,
              columns: [
                {
                  header: sCopy(ctx.locale, "tax.effective"),
                  cell: (row) => h.span.class("kb-mono").children([row.effectiveFrom]),
                },
                {
                  header: sCopy(ctx.locale, "tax.regime"),
                  cell: (row) =>
                    t.translate(I18n.enumText({ name: "taxRegime", value: row.regime })),
                },
              ],
            }),
          ]),
    ]),
    ...(model.taxForm.confirmOpen
      ? [
          dialog(h, {
            id: "kb-tax-confirm-dialog",
            title: t.t("settings.taxRegime.confirmTitle", {
              regime: t.translate(
                I18n.enumText({ name: "taxRegime", value: model.taxForm.nextRegime }),
              ),
            }),
            body: [
              h.p.children([
                t.t("settings.taxRegime.confirmBody", { date: model.taxForm.effectiveFrom }),
              ]),
            ],
            actions: [
              button(h, {
                label: t.t("common.action.cancel"),
                onClick: Message.ClickedCancelTaxRegime(),
              }),
              button(h, {
                label: t.t("common.action.confirm"),
                variant: "primary",
                onClick: Message.ClickedConfirmTaxRegime(),
              }),
            ],
            onClose: Message.ClickedCancelTaxRegime(),
          }),
        ]
      : []),
  ]);
};

// --- Section 3: Bank Accounts -------------------------------------------------------------------

const viewBankAccounts = (model: Model, ctx: PageContext, h: Html.H<Message>): Markup<Message> => {
  const t = translator(ctx.locale);
  const editable = canEditSettings(ctx);
  const rows = Remote.dataOf(model.bankAccounts) ?? [];
  const f = model.bankForm;
  const removing =
    f.removingId === null
      ? undefined
      : Option.getOrUndefined(Arr.findFirst(rows, (b) => b.id === f.removingId));

  return h.div.class("kb-stack").children([
    card(h, [
      cardTitle(h, t.t("settings.bankAccounts.title")),
      ...(model.bankAccounts._tag === "Loading"
        ? [skeleton(h, "100%", "48px"), skeleton(h, "100%", "48px")]
        : rows.length === 0
          ? [emptyState(h, { title: t.t("settings.bankAccounts.empty") })]
          : [
              table(h, {
                caption: t.t("settings.bankAccounts.title"),
                rows,
                rowKey: (b) => b.id,
                columns: [
                  {
                    header: t.t("settings.bankAccounts.label"),
                    cell: (b) => b.name ?? "—",
                  },
                  {
                    header: t.t("common.field.iban"),
                    cell: (b) => {
                      const cz = czechAccountFromIban(b.iban);
                      return h.div
                        .class("kb-stack")
                        .children([
                          h.span.class("kb-mono").children([b.iban]),
                          ...(cz !== null
                            ? [h.span.class("kb-small kb-muted kb-mono").children([cz])]
                            : []),
                        ]);
                    },
                  },
                  {
                    header: t.t("common.field.bic"),
                    cell: (b) => h.span.class("kb-mono").children([b.bic ?? "—"]),
                  },
                  {
                    header: t.t("common.field.currency"),
                    cell: (b) =>
                      h.div
                        .class("kb-row")
                        .children([
                          badge(h, b.currency, "outline"),
                          ...(b.isDefault
                            ? [
                                badge(
                                  h,
                                  t.t("settings.bankAccounts.default", { currency: b.currency }),
                                  "paid",
                                ),
                              ]
                            : []),
                        ]),
                  },
                  {
                    header: "",
                    align: "end",
                    cell: (b) =>
                      editable
                        ? h.div.class("kb-row").children([
                            ...(!b.isDefault
                              ? [
                                  button(h, {
                                    label: t.t("settings.bankAccounts.makeDefault", {
                                      currency: b.currency,
                                    }),
                                    small: true,
                                    variant: "ghost",
                                    onClick: Message.ClickedMakeBankDefault({ id: b.id }),
                                  }),
                                ]
                              : []),
                            button(h, {
                              label: t.t("common.action.edit"),
                              small: true,
                              variant: "ghost",
                              onClick: Message.ClickedEditBank({ id: b.id }),
                            }),
                            button(h, {
                              label: t.t("common.action.remove"),
                              small: true,
                              variant: "danger",
                              onClick: Message.ClickedAskRemoveBank({ id: b.id }),
                            }),
                          ])
                        : "",
                  },
                ],
              }),
            ]),
    ]),
    ...(editable
      ? [
          card(h, [
            cardTitle(
              h,
              sCopy(ctx.locale, f.editingId === null ? "bank.new" : "bank.edit"),
              f.editingId !== null
                ? [
                    button(h, {
                      label: t.t("common.action.cancel"),
                      small: true,
                      variant: "ghost",
                      onClick: Message.ClickedResetBankForm(),
                    }),
                  ]
                : [],
            ),
            h.div.class("kb-form-grid").children([
              textField(h, {
                id: "kb-bank-name",
                label: t.t("settings.bankAccounts.label"),
                value: f.name,
                onInput: (value) => Message.ChangedBankField({ field: "name", value }),
              }),
              textField(h, {
                id: "kb-bank-iban",
                label: t.t("common.field.iban"),
                placeholder: sCopy(ctx.locale, "bank.ibanPlaceholder"),
                value: f.iban,
                mono: true,
                required: true,
                onInput: (value) => Message.ChangedBankField({ field: "iban", value }),
              }),
              textField(h, {
                id: "kb-bank-bic",
                label: t.t("common.field.bic"),
                placeholder: sCopy(ctx.locale, "bank.bicPlaceholder"),
                value: f.bic,
                mono: true,
                onInput: (value) => Message.ChangedBankField({ field: "bic", value }),
              }),
              selectField(h, {
                id: "kb-bank-currency",
                label: sCopy(ctx.locale, "bank.currency"),
                value: f.currency,
                options: Arr.map(CURRENCY_OPTIONS, (c) => ({ value: c, label: c })),
                onChange: (value) =>
                  Message.ChangedBankCurrency({ currency: CurrencyCode.make(value) }),
              }),
            ]),
            checkbox(h, {
              id: "kb-bank-default",
              label: sCopy(ctx.locale, "bank.defaultFor", { currency: f.currency }),
              checked: f.isDefault,
              onToggle: (checked) => Message.ToggledBankDefault({ checked }),
            }),
            h.div.class("kb-row").children([
              button(h, {
                label:
                  f.editingId === null
                    ? t.t("settings.bankAccounts.add")
                    : t.t("common.action.saveChanges"),
                variant: "primary",
                busy: f.saving,
                onClick: Message.ClickedSaveBank(),
              }),
            ]),
          ]),
        ]
      : []),
    ...(removing !== undefined
      ? [
          dialog(h, {
            id: "kb-remove-bank-dialog",
            title: t.t("settings.bankAccounts.removeTitle"),
            body: [
              h.p.children([
                sCopy(ctx.locale, "bank.removeConfirm", {
                  label: removing.name ?? removing.iban,
                }),
              ]),
              selectField(h, {
                id: "kb-bank-replacement",
                label: t.t("settings.bankAccounts.replacement"),
                value: f.replacementId,
                options: [
                  { value: "", label: sCopy(ctx.locale, "bank.removeNoReplacement") },
                  ...Arr.map(
                    Arr.filter(
                      rows,
                      (b) => b.id !== removing.id && b.currency === removing.currency,
                    ),
                    (b) => ({ value: b.id, label: `${b.name ?? b.iban} (${b.currency})` }),
                  ),
                ],
                onChange: (value) => Message.ChangedBankReplacement({ value }),
              }),
            ],
            actions: [
              button(h, {
                label: t.t("common.action.cancel"),
                onClick: Message.ClickedCancelRemoveBank(),
              }),
              button(h, {
                label: t.t("common.action.remove"),
                variant: "danger",
                onClick: Message.ClickedConfirmRemoveBank(),
              }),
            ],
            onClose: Message.ClickedCancelRemoveBank(),
          }),
        ]
      : []),
  ]);
};

// --- Section 4: Branding & PDF Preview ----------------------------------------------------------

const viewBranding = (model: Model, ctx: PageContext, h: Html.H<Message>): Markup<Message> => {
  const t = translator(ctx.locale);
  const editable = canEditSettings(ctx);
  const f = model.brandingForm;
  const brandingData = Remote.dataOf(model.branding);
  const ws = Remote.dataOf(model.workspace);

  return h.div.class("kb-settings-grid").children([
    h.div.class("kb-stack").children([
      card(h, [
        cardTitle(h, sCopy(ctx.locale, "branding.templateSection"), [
          ...(editable
            ? [
                button(h, {
                  label: t.t("common.action.saveChanges"),
                  variant: "primary",
                  busy: f.saving,
                  onClick: Message.ClickedSaveBranding(),
                }),
              ]
            : []),
        ]),
        h.div
          .class("kb-template-picker")
          .children(
            Arr.map(["classic", "modern_minimal"] as const, (tpl) =>
              withAttributes(h.button.class(), [
                (element) => element.attr("type", "button"),
                (element) => element.class("kb-template-card"),
                (element) =>
                  element.attr("aria-pressed", String(f.pdfTemplate === tpl ? "true" : "false")),
                (element) => element.attr("data-template-option", tpl),
                (node) =>
                  editable
                    ? node.on("click", Message.SelectedPdfTemplate({ template: tpl }))
                    : node.disabled(true),
              ]).children([
                h.strong.children([
                  t.translate(I18n.enumText({ name: "pdfTemplate", value: tpl })),
                ]),
                h.span
                  .class("kb-small kb-muted")
                  .children([
                    sCopy(
                      ctx.locale,
                      tpl === "classic" ? "branding.classicDesc" : "branding.modernDesc",
                    ),
                  ]),
              ]),
            ),
          ),
        h.div.class("kb-form-grid").children([
          textField(h, {
            id: "kb-branding-accent",
            label: t.t("settings.branding.accent"),
            value: f.accentColor,
            mono: true,
            disabled: !editable,
            onInput: (value) => Message.ChangedAccentColor({ value }),
          }),
          selectField(h, {
            id: "kb-branding-theme",
            label: t.t("settings.branding.workspaceTheme"),
            hint: t.t("settings.branding.workspaceThemeHint"),
            value: f.themeChoice,
            disabled: !editable,
            options: [
              { value: "", label: sCopy(ctx.locale, "branding.themeNone") },
              ...Arr.map(Theme.PRESET_IDS, (id) => ({
                value: id,
                label: t.translate(Theme.presetNameText(id)),
              })),
              { value: "seed", label: sCopy(ctx.locale, "branding.themeCustomSeed") },
            ],
            onChange: (choice) => Message.SelectedWorkspaceTheme({ choice }),
          }),
        ]),
        ...(f.themeChoice === "seed"
          ? [
              textField(h, {
                id: "kb-branding-seed",
                label: sCopy(ctx.locale, "branding.themeCustomSeed"),
                value: f.themeSeed,
                mono: true,
                disabled: !editable,
                onInput: (value) => Message.ChangedWorkspaceThemeSeed({ value }),
              }),
            ]
          : []),
        textArea(h, {
          id: "kb-branding-footer",
          label: t.t("settings.branding.footer"),
          value: f.footerText,
          disabled: !editable,
          onInput: (value) => Message.ChangedFooterText({ value }),
        }),
      ]),
      card(h, [
        cardTitle(h, sCopy(ctx.locale, "branding.images")),
        h.p.class("kb-small kb-muted").children([t.t("settings.branding.uploadHint")]),
        ...Arr.map(["logo", "stamp"] as const, (kind) => {
          const hasImg = (brandingData?.[kind] ?? ws?.branding[kind] ?? null) !== null;
          return h.div.class("kb-upload-slot").children([
            h.div
              .class("kb-stack")
              .children([
                h.strong.children([t.t(`settings.branding.${kind}`)]),
                h.span
                  .class("kb-small kb-muted")
                  .children([
                    hasImg
                      ? sCopy(
                          ctx.locale,
                          kind === "logo" ? "branding.logoUploaded" : "branding.stampUploaded",
                        )
                      : sCopy(ctx.locale, "branding.noImage"),
                  ]),
              ]),
            h.div.class("kb-row").children([
              ...(editable
                ? [
                    h.label.class("kb-btn kb-btn--small").children([
                      t.t("common.action.upload"),
                      h.input
                        .attr("type", "file")
                        .attr("accept", "image/png,image/jpeg")
                        .class("kb-visually-hidden")
                        .on("change", ({ files: [file] }) =>
                          file === undefined
                            ? undefined
                            : Message.SelectedBrandingImage({ kind, file }),
                        ),
                    ]),
                  ]
                : []),
              ...(editable && hasImg
                ? [
                    button(h, {
                      label: t.t("common.action.remove"),
                      small: true,
                      variant: "danger",
                      onClick: Message.ClickedRemoveBrandingImage({ kind }),
                    }),
                  ]
                : []),
            ]),
          ]);
        }),
      ]),
    ]),
    card(h, [
      cardTitle(h, t.t("settings.branding.pdfPreview"), [
        segmented(h, {
          label: sCopy(ctx.locale, "branding.previewLang"),
          selected: f.previewLocale,
          items: [
            { id: "cs", label: "CS" },
            { id: "en", label: "EN" },
          ],
          onSelect: (id) => Message.SelectedPreviewLocale({ locale: id === "en" ? "en" : "cs" }),
        }),
      ]),
      brandingMiniPreview(h, {
        template: f.pdfTemplate,
        accentColor: Theme.isHex(Str.trim(f.accentColor)) ? Str.trim(f.accentColor) : "#111111",
        companyName: model.entityForm.name || ws?.issuingEntity.name || "",
        ico: model.entityForm.ico || ws?.issuingEntity.ico || "",
        dic: model.entityForm.dic || ws?.issuingEntity.dic || "",
        registerEntry: model.entityForm.registerEntry || ws?.issuingEntity.registerEntry || "",
        footerText: f.footerText,
        hasLogo: (brandingData?.logo ?? ws?.branding.logo ?? null) !== null,
        hasStamp: (brandingData?.stamp ?? ws?.branding.stamp ?? null) !== null,
        previewLocale: f.previewLocale,
      }),
      h.div.class("kb-row").children([
        button(h, {
          label: sCopy(ctx.locale, "branding.previewPdf"),
          small: true,
          busy: f.previewingPdf,
          onClick: Message.ClickedPreviewPdf(),
        }),
      ]),
    ]),
  ]);
};

// --- Section 5: Numbering Series ----------------------------------------------------------------

const viewNumbering = (model: Model, ctx: PageContext, h: Html.H<Message>): Markup<Message> => {
  const t = translator(ctx.locale);
  const editable = canEditSettings(ctx);
  const rows = Remote.dataOf(model.series) ?? [];
  const f = model.numberingForm;
  const kindOptions = Arr.map(
    DOCUMENT_KINDS,
    (k) =>
      ({
        value: k,
        label: t.translate(I18n.enumText({ name: "documentKind", value: k })),
      }) as const,
  );
  const preview = previewNumberingPattern(f.pattern, Number.parseInt(f.nextNumber, 10) || 1);

  return h.div.class("kb-stack").children([
    card(h, [
      cardTitle(h, t.t("settings.numbering.title")),
      ...(model.series._tag === "Loading"
        ? [skeleton(h, "100%", "48px"), skeleton(h, "100%", "48px")]
        : [
            table(h, {
              caption: t.t("settings.numbering.title"),
              rows,
              rowKey: (s) => s.id,
              columns: [
                {
                  header: sCopy(ctx.locale, "numbering.kind"),
                  cell: (s) => t.translate(I18n.enumText({ name: "documentKind", value: s.kind })),
                },
                {
                  header: sCopy(ctx.locale, "numbering.name"),
                  cell: (s) =>
                    h.div
                      .class("kb-row")
                      .children([
                        h.span.children([s.name]),
                        ...(s.isDefault
                          ? [badge(h, t.t("settings.numbering.default"), "paid")]
                          : []),
                      ]),
                },
                {
                  header: t.t("settings.numbering.pattern"),
                  cell: (s) => h.span.class("kb-mono").children([s.pattern]),
                },
                {
                  header: sCopy(ctx.locale, "numbering.nextCounter"),
                  cell: (s) => h.span.class("kb-mono").children([s.nextNumber]),
                },
                {
                  header: "",
                  align: "end",
                  cell: (s) =>
                    editable
                      ? h.div.class("kb-row").children([
                          ...(!s.isDefault
                            ? [
                                button(h, {
                                  label: t.t("settings.numbering.makeDefault"),
                                  small: true,
                                  variant: "ghost",
                                  onClick: Message.ClickedMakeSeriesDefault({ id: s.id }),
                                }),
                              ]
                            : []),
                          button(h, {
                            label: t.t("common.action.edit"),
                            small: true,
                            variant: "ghost",
                            onClick: Message.ClickedEditSeries({ id: s.id }),
                          }),
                        ])
                      : "",
                },
              ],
            }),
          ]),
    ]),
    ...(editable
      ? [
          card(h, [
            cardTitle(
              h,
              sCopy(ctx.locale, f.editingId === null ? "numbering.new" : "numbering.edit"),
              f.editingId !== null
                ? [
                    button(h, {
                      label: t.t("common.action.cancel"),
                      small: true,
                      variant: "ghost",
                      onClick: Message.ClickedResetSeriesForm(),
                    }),
                  ]
                : [],
            ),
            h.div.class("kb-form-grid").children([
              selectField(h, {
                id: "kb-series-kind",
                label: sCopy(ctx.locale, "numbering.kind"),
                value: f.kind,
                disabled: f.editingId !== null,
                options: kindOptions,
                onChange: (value) => Message.ChangedSeriesKind({ kind: value }),
              }),
              textField(h, {
                id: "kb-series-name",
                label: sCopy(ctx.locale, "numbering.name"),
                value: f.name,
                required: true,
                onInput: (value) => Message.ChangedSeriesField({ field: "name", value }),
              }),
              textField(h, {
                id: "kb-series-pattern",
                label: t.t("settings.numbering.pattern"),
                hint: t.t("settings.numbering.patternHint"),
                error: preview.tooLong ? sCopy(ctx.locale, "numbering.tooLong") : undefined,
                value: f.pattern,
                mono: true,
                required: true,
                onInput: (value) => Message.ChangedSeriesField({ field: "pattern", value }),
              }),
              textField(h, {
                id: "kb-series-next",
                label: sCopy(ctx.locale, "numbering.nextCounter"),
                type: "number",
                mono: true,
                value: f.nextNumber,
                onInput: (value) => Message.ChangedSeriesField({ field: "nextNumber", value }),
              }),
            ]),
            h.div.class("kb-chip-row").children([
              h.span
                .class("kb-small kb-muted")
                .children([`${sCopy(ctx.locale, "numbering.insertToken")}:`]),
              ...Arr.map(["YYYY", "YY", "MM", "NNNN"] as const, (token) =>
                button(h, {
                  label: token,
                  small: true,
                  variant: "ghost",
                  onClick: Message.ClickedInsertToken({ token }),
                }),
              ),
            ]),
            h.div.class("kb-banner kb-banner--info").children([
              h.span.class("kb-mono").children([
                preview.samples.length > 0
                  ? t.t("settings.numbering.nextNumbers", {
                      numbers: Arr.join(preview.samples, ", "),
                    })
                  : t.t("settings.numbering.patternHint"),
              ]),
            ]),
            checkbox(h, {
              id: "kb-series-default",
              label: t.t("settings.numbering.makeDefault"),
              checked: f.isDefault,
              onToggle: (checked) => Message.ToggledSeriesDefault({ checked }),
            }),
            h.div.class("kb-row").children([
              button(h, {
                label:
                  f.editingId === null
                    ? t.t("settings.numbering.add")
                    : t.t("common.action.saveChanges"),
                variant: "primary",
                disabled: !preview.valid,
                busy: f.saving,
                onClick: Message.ClickedSaveSeries(),
              }),
            ]),
          ]),
        ]
      : []),
  ]);
};

// --- Section 6: Document Defaults ---------------------------------------------------------------

const viewDocumentDefaults = (
  model: Model,
  ctx: PageContext,
  h: Html.H<Message>,
): Markup<Message> => {
  const t = translator(ctx.locale);
  const editable = canEditSettings(ctx);
  const f = model.defaultsForm;
  const methodOptions = Arr.map(
    PAYMENT_METHODS,
    (m) =>
      ({
        value: m,
        label: t.translate(I18n.enumText({ name: "paymentMethod", value: m })),
      }) as const,
  );

  return card(h, [
    cardTitle(h, t.t("settings.documentDefaults.title"), [
      ...(editable
        ? [
            button(h, {
              label: t.t("common.action.saveChanges"),
              variant: "primary",
              busy: f.saving,
              onClick: Message.ClickedSaveDefaults(),
            }),
          ]
        : []),
    ]),
    h.p.class("kb-muted").children([t.t("settings.documentDefaults.intro")]),
    h.div.class("kb-form-grid").children([
      selectField(h, {
        id: "kb-defaults-currency",
        label: sCopy(ctx.locale, "defaults.currency"),
        value: f.currency,
        disabled: !editable,
        options: Arr.map(CURRENCY_OPTIONS, (c) => ({ value: c, label: c })),
        onChange: (value) => Message.ChangedDefaultCurrency({ currency: CurrencyCode.make(value) }),
      }),
      selectField(h, {
        id: "kb-defaults-language",
        label: t.t("settings.documentDefaults.language"),
        value: f.language,
        disabled: !editable,
        options: [
          { value: "cs", label: "Čeština" },
          { value: "en", label: "English" },
        ],
        onChange: (value) =>
          Message.ChangedDefaultLanguage({ language: value === "en" ? "en" : "cs" }),
      }),
      textField(h, {
        id: "kb-defaults-due-days",
        label: t.t("settings.documentDefaults.dueDays"),
        type: "number",
        mono: true,
        value: f.dueDays,
        disabled: !editable,
        onInput: (value) => Message.ChangedDefaultDueDays({ value }),
      }),
      selectField(h, {
        id: "kb-defaults-payment-method",
        label: t.t("settings.documentDefaults.paymentMethod"),
        value: f.paymentMethod,
        disabled: !editable,
        options: methodOptions,
        onChange: (value) => Message.ChangedDefaultPaymentMethod({ method: value }),
      }),
      selectField(h, {
        id: "kb-defaults-rounding",
        label: sCopy(ctx.locale, "defaults.rounding"),
        value: f.paymentRounding,
        disabled: !editable,
        options: [
          { value: "none", label: sCopy(ctx.locale, "defaults.roundingNone") },
          { value: "whole_unit", label: sCopy(ctx.locale, "defaults.roundingWhole") },
        ],
        onChange: (value) => Message.ChangedDefaultRounding({ rounding: value }),
      }),
    ]),
    textArea(h, {
      id: "kb-defaults-note",
      label: sCopy(ctx.locale, "defaults.defaultNote"),
      value: f.defaultNote,
      disabled: !editable,
      onInput: (value) => Message.ChangedDefaultNote({ value }),
    }),
    checkbox(h, {
      id: "kb-defaults-auto-ptd",
      label: sCopy(ctx.locale, "defaults.autoSendPtd"),
      checked: f.paymentTaxDocumentAutoSend,
      disabled: !editable,
      onToggle: (checked) => Message.ToggledDefaultAutoSendPtd({ checked }),
    }),
  ]);
};

// --- Section 7: Overdue Reminders ---------------------------------------------------------------

const viewReminders = (model: Model, ctx: PageContext, h: Html.H<Message>): Markup<Message> => {
  const t = translator(ctx.locale);
  const editable = canEditSettings(ctx);
  const f = model.remindersForm;

  return card(h, [
    cardTitle(h, t.t("settings.reminders.title"), [
      ...(editable
        ? [
            button(h, {
              label: t.t("common.action.saveChanges"),
              variant: "primary",
              busy: f.saving,
              onClick: Message.ClickedSaveReminders(),
            }),
          ]
        : []),
    ]),
    checkbox(h, {
      id: "kb-reminders-enabled",
      label: t.t("settings.reminders.enable"),
      checked: f.enabled,
      disabled: !editable,
      onToggle: (checked) => Message.ToggledRemindersEnabled({ checked }),
    }),
    checkbox(h, {
      id: "kb-reminders-proformas",
      label: sCopy(ctx.locale, "reminders.proformas"),
      checked: f.proformas,
      disabled: !(editable && f.enabled),
      onToggle: (checked) => Message.ToggledRemindersProformas({ checked }),
    }),
    h.div.class("kb-section").children([
      h.h3.children([t.t("settings.reminders.offsets")]),
      h.p
        .class("kb-small kb-muted")
        .children([
          sCopy(ctx.locale, "reminders.maxNote", { max: 10, count: f.offsetsDays.length }),
        ]),
      h.div.class("kb-chip-row").children(
        Arr.map(f.offsetsDays, (day) =>
          h.span.class("kb-chip").children([
            h.span
              .class("kb-mono")
              .children([sCopy(ctx.locale, "reminders.daysAfter", { days: day })]),
            ...(editable
              ? [
                  h.button
                    .attr("type", "button")
                    .attr("aria-label", `${t.t("common.action.remove")} +${day}`)
                    .on("click", Message.ClickedRemoveReminderOffset({ day }))
                    .children(["×"]),
                ]
              : []),
          ]),
        ),
      ),
      ...(editable
        ? [
            h.div.class("kb-ares-row").children([
              textField(h, {
                id: "kb-reminders-new-offset",
                label: t.t("settings.reminders.addOffset"),
                placeholder: sCopy(ctx.locale, "reminders.newOffsetPlaceholder"),
                type: "number",
                mono: true,
                value: f.newOffset,
                disabled: f.offsetsDays.length >= 10,
                onInput: (value) => Message.ChangedNewReminderOffset({ value }),
              }),
              button(h, {
                label: t.t("settings.reminders.addOffset"),
                disabled: f.offsetsDays.length >= 10 || Str.trim(f.newOffset) === "",
                onClick: Message.ClickedAddReminderOffset(),
              }),
            ]),
          ]
        : []),
    ]),
    h.hr.class("kb-divider"),
    checkbox(h, {
      id: "kb-reminders-auto-ptd",
      label: sCopy(ctx.locale, "reminders.autoSendPtd"),
      checked: f.paymentTaxDocumentAutoSend,
      disabled: !editable,
      onToggle: (checked) => Message.ToggledRemindersAutoSendPtd({ checked }),
    }),
    h.p.class("kb-small kb-muted").children([sCopy(ctx.locale, "reminders.autoSendPtdHint")]),
  ]);
};

// --- Section 8: Team & Invitations --------------------------------------------------------------

const viewTeam = (model: Model, ctx: PageContext, h: Html.H<Message>): Markup<Message> => {
  const t = translator(ctx.locale);
  const editable = canEditSettings(ctx);
  const members = Remote.dataOf(model.members) ?? [];
  const invitations = Remote.dataOf(model.invitations) ?? [];
  const currentUserId = ctx.session._tag === "SignedIn" ? ctx.session.user.id : null;
  const removing =
    model.teamForm.removingUserId === null
      ? undefined
      : Option.getOrUndefined(
          Arr.findFirst(members, (m) => m.userId === model.teamForm.removingUserId),
        );
  const isOwner = ctx.workspace?.role === "owner";
  const roleOptions = Arr.map(
    ["admin", "member", "accountant"] as const,
    (r) =>
      ({
        value: r,
        label: t.translate(I18n.enumText({ name: "role", value: r })),
      }) as const,
  );

  return h.div.class("kb-stack").children([
    card(h, [
      cardTitle(h, t.t("settings.team.members"), [
        button(h, {
          label: t.t("settings.team.leave"),
          small: true,
          variant: "ghost",
          disabled: isOwner,
          onClick: Message.ClickedAskLeave(),
        }),
      ]),
      ...(isOwner
        ? [h.p.class("kb-small kb-muted").children([t.t("settings.team.lastOwner")])]
        : []),
      ...(model.members._tag === "Loading"
        ? [skeleton(h, "100%", "48px"), skeleton(h, "100%", "48px")]
        : [
            table(h, {
              caption: t.t("settings.team.members"),
              rows: members,
              rowKey: (m) => m.userId,
              columns: [
                {
                  header: t.t("common.field.name"),
                  cell: (m) =>
                    h.div
                      .class("kb-row")
                      .children([
                        h.span.children([m.name]),
                        ...(m.userId === currentUserId
                          ? [badge(h, t.t("settings.team.you"), "outline")]
                          : []),
                      ]),
                },
                {
                  header: t.t("common.field.email"),
                  cell: (m) => m.email,
                },
                {
                  header: t.t("common.field.role"),
                  cell: (m) =>
                    editable && m.role !== "owner" && m.userId !== currentUserId
                      ? selectField(h, {
                          id: `kb-role-${m.userId}`,
                          label: t.t("settings.team.changeRole"),
                          value: m.role,
                          options: roleOptions,
                          onChange: (value) =>
                            Message.ChangedMemberRole({
                              userId: m.userId,
                              role: value,
                            }),
                        })
                      : badge(
                          h,
                          t.translate(I18n.enumText({ name: "role", value: m.role })),
                          m.role === "owner" ? "paid" : "outline",
                        ),
                },
                {
                  header: sCopy(ctx.locale, "team.joined"),
                  cell: (m) => h.span.class("kb-mono").children([Str.slice(0, 10)(m.joinedAt)]),
                },
                {
                  header: "",
                  align: "end",
                  cell: (m) =>
                    editable && m.role !== "owner" && m.userId !== currentUserId
                      ? button(h, {
                          label: t.t("common.action.remove"),
                          small: true,
                          variant: "danger",
                          onClick: Message.ClickedAskRemoveMember({ userId: m.userId }),
                        })
                      : "",
                },
              ],
            }),
          ]),
    ]),
    ...(editable
      ? [
          card(h, [
            cardTitle(h, t.t("settings.team.invite")),
            h.div.class("kb-form-grid").children([
              textField(h, {
                id: "kb-invite-email",
                label: t.t("settings.team.inviteEmail"),
                type: "email",
                value: model.teamForm.inviteEmail,
                onInput: (value) => Message.ChangedInviteEmail({ value }),
              }),
              selectField(h, {
                id: "kb-invite-role",
                label: t.t("settings.team.inviteRole"),
                value: model.teamForm.inviteRole,
                options: roleOptions,
                onChange: (value) =>
                  Message.ChangedInviteRole({
                    role: value,
                  }),
              }),
            ]),
            h.div.class("kb-row").children([
              button(h, {
                label: t.t("settings.team.invite"),
                variant: "primary",
                busy: model.teamForm.inviting,
                onClick: Message.ClickedSendInvite(),
              }),
            ]),
          ]),
        ]
      : []),
    card(h, [
      cardTitle(h, t.t("settings.team.invitations")),
      ...(invitations.length === 0
        ? [emptyState(h, { title: sCopy(ctx.locale, "team.noInvitations") })]
        : [
            table(h, {
              caption: t.t("settings.team.invitations"),
              rows: invitations,
              rowKey: (i) => i.id,
              columns: [
                { header: t.t("common.field.email"), cell: (i) => i.email },
                {
                  header: t.t("common.field.role"),
                  cell: (i) => t.translate(I18n.enumText({ name: "role", value: i.role })),
                },
                {
                  header: t.t("common.field.status"),
                  cell: (i) =>
                    badge(
                      h,
                      t.translate(I18n.enumText({ name: "invitationStatus", value: i.status })),
                      "proforma",
                    ),
                },
                {
                  header: t.t("common.field.expires"),
                  cell: (i) => h.span.class("kb-mono").children([Str.slice(0, 10)(i.expiresAt)]),
                },
                {
                  header: "",
                  align: "end",
                  cell: (i) =>
                    editable
                      ? h.div.class("kb-row").children([
                          button(h, {
                            label: t.t("common.action.resend"),
                            small: true,
                            variant: "ghost",
                            onClick: Message.ClickedResendInvite({ id: i.id }),
                          }),
                          button(h, {
                            label: t.t("common.action.revoke"),
                            small: true,
                            variant: "danger",
                            onClick: Message.ClickedRevokeInvite({ id: i.id }),
                          }),
                        ])
                      : "",
                },
              ],
            }),
          ]),
    ]),
    ...(removing !== undefined
      ? [
          dialog(h, {
            id: "kb-remove-member-dialog",
            title: t.t("settings.team.removeTitle", { name: removing.name }),
            body: [h.p.children([t.t("settings.team.removeBody")])],
            actions: [
              button(h, {
                label: t.t("common.action.cancel"),
                onClick: Message.ClickedCancelRemoveMember(),
              }),
              button(h, {
                label: t.t("common.action.remove"),
                variant: "danger",
                onClick: Message.ClickedConfirmRemoveMember(),
              }),
            ],
            onClose: Message.ClickedCancelRemoveMember(),
          }),
        ]
      : []),
    ...(model.teamForm.confirmLeave
      ? [
          dialog(h, {
            id: "kb-leave-workspace-dialog",
            title: t.t("settings.team.leaveTitle", { workspace: ctx.workspace?.name ?? "" }),
            body: [h.p.children([t.t("settings.team.leaveBody")])],
            actions: [
              button(h, {
                label: t.t("common.action.cancel"),
                onClick: Message.ClickedCancelLeave(),
              }),
              button(h, {
                label: t.t("settings.team.leave"),
                variant: "danger",
                onClick: Message.ClickedConfirmLeave(),
              }),
            ],
            onClose: Message.ClickedCancelLeave(),
          }),
        ]
      : []),
  ]);
};

// --- Section 9: API Keys ------------------------------------------------------------------------

const viewApiKeys = (model: Model, ctx: PageContext, h: Html.H<Message>): Markup<Message> => {
  const t = translator(ctx.locale);
  const editable = canEditSettings(ctx);
  const rows = Remote.dataOf(model.apiKeys) ?? [];
  const f = model.apiKeysForm;
  const picker = scopePickerFromModel(model, ctx);
  const revoking =
    f.revokingId === null
      ? undefined
      : Option.getOrUndefined(Arr.findFirst(rows, (k) => k.id === f.revokingId));

  return h.div.class("kb-stack").children([
    card(h, [
      cardTitle(h, t.t("settings.apiKeys.title"), [
        ...(editable
          ? [
              button(h, {
                label: f.creating ? t.t("common.action.cancel") : t.t("settings.apiKeys.create"),
                variant: f.creating ? "ghost" : "primary",
                onClick: Message.ClickedToggleCreateApiKey(),
              }),
            ]
          : []),
      ]),
      h.p.class("kb-muted").children([t.t("settings.apiKeys.intro")]),
      ...(model.apiKeys._tag === "Loading"
        ? [skeleton(h, "100%", "48px"), skeleton(h, "100%", "48px")]
        : rows.length === 0
          ? [emptyState(h, { title: t.t("settings.apiKeys.empty") })]
          : [
              table(h, {
                caption: t.t("settings.apiKeys.title"),
                rows,
                rowKey: (k) => k.id,
                columns: [
                  { header: t.t("common.field.name"), cell: (k) => k.name },
                  {
                    header: sCopy(ctx.locale, "api.prefix"),
                    cell: (k) => h.span.class("kb-mono").children([`${k.prefix}…`]),
                  },
                  {
                    header: sCopy(ctx.locale, "api.scopes"),
                    cell: (k) =>
                      scopeSummaryBadges(
                        h,
                        t,
                        ViewModels.describeAccess({ access: k.access, scopes: k.scopes }),
                      ),
                  },
                  {
                    header: t.t("common.field.expires"),
                    cell: (k) =>
                      h.span
                        .class("kb-mono")
                        .children([
                          k.expiresAt === null
                            ? t.t("settings.apiKeys.noExpiry")
                            : Str.slice(0, 10)(k.expiresAt),
                        ]),
                  },
                  {
                    header: "",
                    align: "end",
                    cell: (k) =>
                      editable
                        ? button(h, {
                            label: t.t("common.action.revoke"),
                            small: true,
                            variant: "danger",
                            onClick: Message.ClickedAskRevokeApiKey({ id: k.id }),
                          })
                        : "",
                  },
                ],
              }),
            ]),
    ]),
    ...(f.creating && editable
      ? [
          card(h, [
            cardTitle(h, t.t("settings.apiKeys.create")),
            h.p.class("kb-small kb-muted").children([t.t("settings.apiKeys.cappedByRole")]),
            h.div.class("kb-form-grid").children([
              textField(h, {
                id: "kb-apikey-name",
                label: t.t("settings.apiKeys.name"),
                value: f.name,
                required: true,
                onInput: (value) => Message.ChangedApiKeyName({ value }),
              }),
              textField(h, {
                id: "kb-apikey-expires",
                label: t.t("settings.apiKeys.expiry"),
                placeholder: sCopy(ctx.locale, "api.expiresPlaceholder"),
                type: "date",
                mono: true,
                value: f.expiresOn,
                onInput: (value) => Message.ChangedApiKeyExpires({ value }),
              }),
            ]),
            scopeMatrixEditor(h, {
              state: picker,
              t,
              onPreset: (preset) => Message.SelectedApiKeyPreset({ preset }),
              onCustom: Message.SelectedApiKeyCustom(),
              onToggle: (scope) => Message.ToggledApiKeyScope({ scope }),
            }),
            h.div.class("kb-row").children([
              button(h, {
                label: t.t("settings.apiKeys.create"),
                variant: "primary",
                disabled:
                  Str.trim(f.name) === "" || Option.isNone(ViewModels.toAccessRequest(picker)),
                busy: f.saving,
                onClick: Message.ClickedCreateApiKey(),
              }),
            ]),
          ]),
        ]
      : []),
    ...(f.createdSecret !== null
      ? [
          dialog(h, {
            id: "kb-apikey-secret-dialog",
            title: t.t("settings.apiKeys.secretTitle"),
            body: [
              h.p.children([t.t("settings.apiKeys.secretBody")]),
              h.div
                .class("kb-secret-box")
                .attr("data-testid", "api-key-secret")
                .children([f.createdSecret]),
            ],
            actions: [
              button(h, {
                label: t.t("common.action.copy"),
                onClick: Message.ClickedCopyApiKeySecret(),
              }),
              button(h, {
                label: t.t("settings.apiKeys.storedIt"),
                variant: "primary",
                onClick: Message.ClickedDismissApiKeySecret(),
              }),
            ],
            onClose: Message.ClickedDismissApiKeySecret(),
          }),
        ]
      : []),
    ...(revoking !== undefined
      ? [
          dialog(h, {
            id: "kb-revoke-apikey-dialog",
            title: t.t("settings.apiKeys.revokeTitle", { name: revoking.name }),
            body: [h.p.children([t.t("settings.apiKeys.revokeBody")])],
            actions: [
              button(h, {
                label: t.t("common.action.cancel"),
                onClick: Message.ClickedCancelRevokeApiKey(),
              }),
              button(h, {
                label: t.t("common.action.revoke"),
                variant: "danger",
                onClick: Message.ClickedConfirmRevokeApiKey(),
              }),
            ],
            onClose: Message.ClickedCancelRevokeApiKey(),
          }),
        ]
      : []),
  ]);
};

// --- Section 10: Connected MCP Apps -------------------------------------------------------------

const viewConnectedApps = (model: Model, ctx: PageContext, h: Html.H<Message>): Markup<Message> => {
  const t = translator(ctx.locale);
  const editable = canEditSettings(ctx);
  const rows = Remote.dataOf(model.connectedApps) ?? [];
  const revoking =
    model.connectedAppsForm.revokingGrantId === null
      ? undefined
      : Option.getOrUndefined(
          Arr.findFirst(rows, (g) => g.grantId === model.connectedAppsForm.revokingGrantId),
        );

  return h.div.class("kb-stack").children([
    card(h, [
      cardTitle(h, t.t("settings.connectedApps.title")),
      h.p.class("kb-muted").children([t.t("settings.connectedApps.intro")]),
      ...(model.connectedApps._tag === "Loading"
        ? [skeleton(h, "100%", "48px")]
        : rows.length === 0
          ? [emptyState(h, { title: t.t("settings.connectedApps.empty") })]
          : [
              table(h, {
                caption: t.t("settings.connectedApps.title"),
                rows,
                rowKey: (g) => g.grantId,
                columns: [
                  {
                    header: sCopy(ctx.locale, "mcp.client"),
                    cell: (g) =>
                      h.div
                        .class("kb-stack")
                        .children([
                          h.strong.children([g.client.name]),
                          h.span
                            .class("kb-small kb-muted")
                            .children([
                              t.t("settings.connectedApps.member", { name: g.member.name }),
                            ]),
                        ]),
                  },
                  {
                    header: sCopy(ctx.locale, "mcp.host"),
                    cell: (g) => h.span.class("kb-mono").children([g.client.redirectHost]),
                  },
                  {
                    header: sCopy(ctx.locale, "api.scopes"),
                    cell: (g) =>
                      scopeSummaryBadges(
                        h,
                        t,
                        ViewModels.describeAccess({ access: g.access, scopes: g.scopes }),
                      ),
                  },
                  {
                    header: t.t("common.field.lastUsed"),
                    cell: (g) =>
                      h.span
                        .class("kb-mono")
                        .children([
                          g.lastUsedAt === null
                            ? sCopy(ctx.locale, "api.never")
                            : Str.slice(0, 10)(g.lastUsedAt),
                        ]),
                  },
                  {
                    header: "",
                    align: "end",
                    cell: (g) =>
                      editable
                        ? button(h, {
                            label: t.t("common.action.revoke"),
                            small: true,
                            variant: "danger",
                            onClick: Message.ClickedAskRevokeApp({ grantId: g.grantId }),
                          })
                        : "",
                  },
                ],
              }),
            ]),
    ]),
    ...(revoking !== undefined
      ? [
          dialog(h, {
            id: "kb-revoke-app-dialog",
            title: t.t("settings.connectedApps.revokeTitle", { name: revoking.client.name }),
            body: [h.p.children([t.t("settings.connectedApps.revokeBody")])],
            actions: [
              button(h, {
                label: t.t("common.action.cancel"),
                onClick: Message.ClickedCancelRevokeApp(),
              }),
              button(h, {
                label: t.t("common.action.revoke"),
                variant: "danger",
                onClick: Message.ClickedConfirmRevokeApp(),
              }),
            ],
            onClose: Message.ClickedCancelRevokeApp(),
          }),
        ]
      : []),
  ]);
};

// --- Section 11: Danger Zone --------------------------------------------------------------------

const viewDangerZone = (model: Model, ctx: PageContext, h: Html.H<Message>): Markup<Message> => {
  const t = translator(ctx.locale);
  const isOwner = ctx.workspace?.role === "owner" && !ctx.workspace.closed;
  const members = Remote.dataOf(model.members) ?? [];
  const candidates = Arr.filter(members, (m) => m.role !== "owner");
  const targetMember = Option.getOrUndefined(
    Arr.findFirst(candidates, (m) => m.userId === model.dangerForm.transferToUserId),
  );
  const wsName = ctx.workspace?.name ?? "";
  const canClose =
    isOwner && Str.trim(model.dangerForm.closeConfirmName) === wsName && wsName !== "";

  return h.div.class("kb-stack").children([
    card(h, [
      cardTitle(h, t.t("settings.dangerZone.export")),
      h.p.children([t.t("settings.dangerZone.retention")]),
      h.p.class("kb-small kb-muted").children([sCopy(ctx.locale, "danger.exportDesc")]),
      h.div.class("kb-row").children([
        button(h, {
          label: t.t("settings.dangerZone.export"),
          busy: model.dangerForm.exporting,
          onClick: Message.ClickedStartExport(),
        }),
      ]),
    ]),
    card(
      h,
      [
        cardTitle(h, t.t("settings.dangerZone.transfer")),
        h.p.children([t.t("settings.dangerZone.transferBody")]),
        ...(candidates.length === 0
          ? [
              h.p
                .class("kb-small kb-muted")
                .children([sCopy(ctx.locale, "danger.noTransferCandidates")]),
            ]
          : [
              selectField(h, {
                id: "kb-transfer-owner-select",
                label: t.t("settings.dangerZone.transferPick"),
                value: model.dangerForm.transferToUserId,
                disabled: !isOwner,
                options: [
                  { value: "", label: "—" },
                  ...Arr.map(candidates, (m) => ({
                    value: m.userId,
                    label: `${m.name} (${m.email})`,
                  })),
                ],
                onChange: (userId) => Message.ChangedTransferTarget({ userId }),
              }),
              h.div.class("kb-row").children([
                button(h, {
                  label: t.t("settings.dangerZone.transfer"),
                  variant: "danger",
                  disabled: !isOwner || model.dangerForm.transferToUserId === "",
                  busy: model.dangerForm.transferring,
                  onClick: Message.ClickedAskTransfer(),
                }),
              ]),
            ]),
      ],
      [attribute("class", "kb-card kb-danger-card")],
    ),
    card(
      h,
      [
        cardTitle(h, t.t("settings.dangerZone.close")),
        h.p.children([t.t("settings.dangerZone.closeBody")]),
        textField(h, {
          id: "kb-close-workspace-confirm",
          label: t.t("settings.dangerZone.closeConfirm", { name: wsName }),
          value: model.dangerForm.closeConfirmName,
          disabled: !isOwner,
          onInput: (value) => Message.ChangedCloseConfirm({ value }),
        }),
        h.div.class("kb-row").children([
          button(h, {
            label: t.t("settings.dangerZone.close"),
            variant: "danger",
            disabled: !canClose,
            busy: model.dangerForm.closing,
            onClick: Message.ClickedCloseWorkspace(),
          }),
        ]),
      ],
      [attribute("class", "kb-card kb-danger-card")],
    ),
    ...(model.dangerForm.confirmTransfer && targetMember !== undefined
      ? [
          dialog(h, {
            id: "kb-transfer-confirm-dialog",
            title: t.t("settings.dangerZone.transferConfirm", { name: targetMember.name }),
            body: [h.p.children([t.t("settings.dangerZone.transferBody")])],
            actions: [
              button(h, {
                label: t.t("common.action.cancel"),
                onClick: Message.ClickedCancelTransfer(),
              }),
              button(h, {
                label: t.t("common.action.confirm"),
                variant: "danger",
                onClick: Message.ClickedConfirmTransfer(),
              }),
            ],
            onClose: Message.ClickedCancelTransfer(),
          }),
        ]
      : []),
  ]);
};

// --- Page Entrypoint ----------------------------------------------------------------------------

export const viewSettingsPage: {
  (ctx: PageContext, h: Html.H<Message>): (model: Model) => Markup<Message>;
  (model: Model, ctx: PageContext, h: Html.H<Message>): Markup<Message>;
} = Fn.dual(3, (model: Model, ctx: PageContext, h: Html.H<Message>): Markup<Message> => {
  if (model.route._tag === "More") return viewMoreHub(ctx, h);

  const t = translator(ctx.locale);
  const workspace = ctx.workspace;
  const section: SettingsSection =
    model.route._tag === "Settings" ? model.route.section : "issuingEntity";
  const editable = canEditSettings(ctx);
  const subtitle = workspace === null ? undefined : { subtitle: workspace.name };

  const body =
    section === "issuingEntity"
      ? viewIssuingEntity(model, ctx, h)
      : section === "taxRegime"
        ? viewTaxRegime(model, ctx, h)
        : section === "bankAccounts"
          ? viewBankAccounts(model, ctx, h)
          : section === "branding"
            ? viewBranding(model, ctx, h)
            : section === "numbering"
              ? viewNumbering(model, ctx, h)
              : section === "documentDefaults"
                ? viewDocumentDefaults(model, ctx, h)
                : section === "reminders"
                  ? viewReminders(model, ctx, h)
                  : section === "team"
                    ? viewTeam(model, ctx, h)
                    : section === "apiKeys"
                      ? viewApiKeys(model, ctx, h)
                      : section === "connectedApps"
                        ? viewConnectedApps(model, ctx, h)
                        : viewDangerZone(model, ctx, h);

  return page(h, [
    pageHeader(h, {
      title: t.t("settings.title"),
      ...subtitle,
    }),
    ...(workspace === null
      ? []
      : [
          tabs(h, {
            label: t.t("settings.title"),
            selected: section,
            items: Arr.map(SETTINGS_SECTIONS, (s) => ({
              id: s,
              label: sectionLabel(t, s),
              href: href({ _tag: "Settings", ws: workspace.slug, section: s }),
            })),
          }),
        ]),
    ...(!editable ? [banner(h, { tone: "info", text: t.t("settings.readOnly") })] : []),
    ...(model.actionFailure !== null
      ? [banner(h, { tone: "error", text: textOf(t, model.actionFailure.text) })]
      : []),
    body,
  ]);
});
