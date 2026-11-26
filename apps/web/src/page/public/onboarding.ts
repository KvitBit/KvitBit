import { UiSchema } from "@effect/ui";
import type { Html } from "@effect/ui/html";
/**
 * Screen 07 — 5-Step Workspace Onboarding Wizard (/onboarding).
 * Step 1: Issuing Entity + IČO ARES auto-fill
 * Step 2: Tax Regime (non_vat_payer | vat_payer | identified_person)
 * Step 3: Bank Account (Czech account -> IBAN helper, BIC, currency; optional with QR warning)
 * Step 4: Numbering Defaults (invoice/proforma/PTD/credit note patterns + live preview)
 * Step 5: Live Miniature Invoice Preview + Create Workspace API -> ReloadSession + Navigate
 */
import {
  CurrencyCode,
  type DocumentKind,
  Locale as DomainLocale,
  RegistryResult,
  TaxRegime,
  WorkspaceId,
  WorkspaceView,
} from "@kvitbit/domain";
import { Api, Format, I18n, ViewModels } from "@kvitbit/ui-port";
import { Effect, Result, Schema } from "effect";
import { Failure } from "../../app/api";
import { defineApiCommand } from "../../app/commands";
import { copy, translator } from "../../app/i18n";
import { Intent_ } from "../../app/intent";
import type { MessageHandlers, PageContext, PageReturn, RouteOf } from "../../app/page";
import * as Remote from "../../app/remote";
import { href } from "../../app/routing";
import { withAttributes } from "../../ui/html";
import { icon } from "../../ui/icons";
import {
  amount,
  badge,
  banner,
  button,
  card,
  cardTitle,
  dl,
  mono,
  pageHeader,
  selectField,
  textField,
} from "../../ui/kit";
import { callApi, failureMessage, randomKey, slugifyName } from "./_shared";

export type Route = RouteOf<"Onboarding">;

const AresRemote = Remote.remoteSchema(RegistryResult);

const SetupProgress = Schema.Struct({
  issuingEntity: Schema.Boolean,
  bankAccount: Schema.Boolean,
  series: Schema.Boolean,
});
type SetupProgress = typeof SetupProgress.Type;

const emptySetupProgress: SetupProgress = {
  issuingEntity: false,
  bankAccount: false,
  series: false,
};

export const Model = Schema.Struct({
  route: ViewModels.Route,
  step: Schema.Int,
  // Step 1: Issuing Entity
  ico: Schema.String,
  legalName: Schema.String,
  workspaceName: Schema.String,
  slug: Schema.String,
  slugEdited: Schema.Boolean,
  dic: Schema.String,
  street: Schema.String,
  city: Schema.String,
  postalCode: Schema.String,
  country: Schema.String,
  legalForm: Schema.String,
  registerEntry: Schema.String,
  ares: AresRemote,
  // Step 2: Tax Regime
  taxRegime: TaxRegime,
  taxEffectiveFrom: Schema.String,
  // Step 3: Bank Account
  czechAccount: Schema.String,
  iban: Schema.String,
  bic: Schema.String,
  bankCurrency: CurrencyCode,
  // Step 4: Numbering & Defaults
  invoicePattern: Schema.String,
  proformaPattern: Schema.String,
  ptdPattern: Schema.String,
  creditNotePattern: Schema.String,
  defaultCurrency: CurrencyCode,
  defaultLanguage: DomainLocale,
  // Step 5: Submit & resumable setup progress
  stepError: Schema.NullOr(Schema.String),
  submitSeq: Remote.Seq,
  submitting: Schema.Boolean,
  submitFailure: Schema.NullOr(Failure),
  createRequestKey: Schema.NullOr(Schema.String),
  bankRequestKey: Schema.NullOr(Schema.String),
  createdWorkspace: Schema.NullOr(WorkspaceView),
  setupDone: SetupProgress,
});
export type Model = typeof Model.Type;

export const Message = UiSchema.TaggedEnum({
  ClickedStep: { step: Schema.Int },
  ClickedNext: {},
  ClickedBack: {},
  ChangedField: {
    field: Schema.Literals([
      "ico",
      "legalName",
      "workspaceName",
      "slug",
      "dic",
      "street",
      "city",
      "postalCode",
      "country",
      "registerEntry",
      "taxEffectiveFrom",
      "czechAccount",
      "iban",
      "bic",
      "invoicePattern",
      "proformaPattern",
      "ptdPattern",
      "creditNotePattern",
    ]),
    value: Schema.String,
  },
  SelectedTaxRegime: { regime: TaxRegime },
  SelectedBankCurrency: { currency: CurrencyCode },
  SelectedDefaultCurrency: { currency: CurrencyCode },
  SelectedDefaultLanguage: { language: DomainLocale },
  ClickedLookupAres: {},
  GotAres: { seq: Remote.Seq, result: RegistryResult },
  FailedAres: { seq: Remote.Seq, failure: Failure },
  ClickedCreateWorkspace: {},
  CompletedCreate: { seq: Remote.Seq, workspace: WorkspaceView },
  FailedCreate: { seq: Remote.Seq, failure: Failure },
  CompletedSetup: { seq: Remote.Seq, slug: Schema.String },
  FailedSetup: { seq: Remote.Seq, setupDone: SetupProgress, failure: Failure },
});
export type Message = typeof Message.Type;

const local = copy({
  cs: {
    stepPreview: "Náhled a potvrzení",
    icoInvalid: "Zadejte platné 8místné IČO.",
    nameRequired: "Zadejte název firmy nebo podnikatele.",
    dissolvedWarning: "Pozor: společnost má v ARES datum zániku {date}.",
    czechAccountLabel: "České číslo účtu (např. 123456789/0100)",
    czechAccountHint: "Automaticky převedeme na IBAN.",
    ibanInvalid: "Zadejte platný IBAN.",
    invoiceSeries: "Řada faktur",
    proformaSeries: "Řada zálohových faktur",
    ptdSeries: "Řada daňových dokladů k platbě",
    creditNoteSeries: "Řada opravných dokladů",
    defaultCurrency: "Výchozí měna",
    defaultLanguage: "Výchozí jazyk dokladů",
    previewHeading: "Živý náhled faktury",
    previewIntro:
      "Takto budou vypadat vaše vystavené doklady. Vše můžete kdykoli upravit v Nastavení.",
    sampleCustomer: "Ukázkový odběratel s.r.o.",
    sampleLine: "Konzultační služby",
    qrIncluded: "QR Platba připravena",
    qrMissing: "Bez bankovního účtu (bez QR kódu)",
    workspaceCreated: "Pracovní prostor byl vytvořen.",
    step4Title: "Číslování a výchozí nastavení",
  },
  en: {
    stepPreview: "Preview & finish",
    icoInvalid: "Enter a valid 8-digit Czech company ID (IČO).",
    nameRequired: "Enter your business name to continue.",
    dissolvedWarning: "Warning: ARES lists a dissolution date of {date} for this company.",
    czechAccountLabel: "Czech account number (e.g. 123456789/0100)",
    czechAccountHint: "Automatically converted to IBAN.",
    ibanInvalid: "Enter a valid IBAN.",
    invoiceSeries: "Invoice series",
    proformaSeries: "Proforma series",
    ptdSeries: "Payment tax document series",
    creditNoteSeries: "Credit note series",
    defaultCurrency: "Default currency",
    defaultLanguage: "Default document language",
    previewHeading: "Live miniature invoice preview",
    previewIntro:
      "This is how your issued documents will look. You can adjust every setting later.",
    sampleCustomer: "Sample Customer s.r.o.",
    sampleLine: "Consulting services",
    qrIncluded: "QR payment ready",
    qrMissing: "No bank account (no QR code)",
    workspaceCreated: "Workspace created.",
    step4Title: "Numbering and defaults",
  },
});

const CreateWorkspaceArgs = Schema.Struct({
  seq: Remote.Seq,
  idempotencyKey: Schema.String,
  name: Schema.String,
  slug: Schema.optionalKey(Schema.String),
  ico: Schema.optionalKey(Schema.String),
  taxRegime: TaxRegime,
  currency: CurrencyCode,
  language: DomainLocale,
});

const LookupAresCmd = defineApiCommand("OnboardingLookupAres", {
  args: { ico: Schema.String, seq: Remote.Seq },
  execute: ({ ico, seq }) =>
    callApi(
      (client) => client.registry.lookupCompany({ params: { ico } }),
      (result) => Message.GotAres({ seq, result }),
      (failure) => Message.FailedAres({ seq, failure }),
    ),
});

const CreateWorkspaceCmd = defineApiCommand("OnboardingCreateWorkspace", {
  args: CreateWorkspaceArgs.fields,
  execute: ({ seq, idempotencyKey, name, slug, ico, taxRegime, currency, language }) =>
    callApi(
      (client) =>
        client.myWorkspaces.create({
          headers: { "idempotency-key": idempotencyKey },
          payload: {
            name,
            ...(slug !== undefined ? { slug } : {}),
            ...(ico !== undefined ? { ico } : {}),
            taxRegime,
            defaults: { currency, language },
          } as never,
        }),
      (workspace) => Message.CompletedCreate({ seq, workspace }),
      (failure) => Message.FailedCreate({ seq, failure }),
    ),
});

const ApplySetupArgs = Schema.Struct({
  seq: Remote.Seq,
  workspace: WorkspaceView,
  setupDone: SetupProgress,
  bankRequestKey: Schema.String,
  legalName: Schema.String,
  ico: Schema.String,
  dic: Schema.String,
  street: Schema.String,
  city: Schema.String,
  postalCode: Schema.String,
  country: Schema.String,
  legalForm: Schema.String,
  registerEntry: Schema.String,
  iban: Schema.String,
  bic: Schema.String,
  bankCurrency: CurrencyCode,
  invoicePattern: Schema.String,
  proformaPattern: Schema.String,
  ptdPattern: Schema.String,
  creditNotePattern: Schema.String,
});

const ApplyOnboardingSetupCmd = defineApiCommand("OnboardingApplySetup", {
  args: ApplySetupArgs.fields,
  execute: (args) => {
    const progress: { issuingEntity: boolean; bankAccount: boolean; series: boolean } = {
      ...args.setupDone,
    };
    return callApi(
      (client) =>
        Effect.gen(function* () {
          const workspaceId = yield* Schema.decodeUnknownEffect(WorkspaceId)(args.workspace.id);
          // 1. Persist manually entered / confirmed issuing entity details
          if (!progress.issuingEntity) {
            const hasManualEntity =
              args.legalName.trim() !== "" ||
              args.dic.trim() !== "" ||
              args.street.trim() !== "" ||
              args.city.trim() !== "" ||
              args.postalCode.trim() !== "" ||
              args.registerEntry.trim() !== "";
            if (hasManualEntity) {
              const current = yield* client.workspace.current({ params: { workspaceId } });
              const patch = {
                name: args.legalName.trim() || args.workspace.slug,
                ico: args.ico.trim() || null,
                dic: args.dic.trim() || null,
                address: {
                  street: args.street.trim(),
                  city: args.city.trim(),
                  postalCode: args.postalCode.trim(),
                  country: args.country.trim() || "CZ",
                },
                legalForm: args.legalForm.trim() || null,
                registerEntry: args.registerEntry.trim() || null,
              };
              yield* client.workspace.updateIssuingEntity({
                params: { workspaceId },
                headers: Api.ifMatchHeaders(current.revision),
                payload: patch as never,
              });
            }
            progress.issuingEntity = true;
          }

          // 2. Persist bank account if IBAN was entered
          if (!progress.bankAccount) {
            const rawIban = args.iban.replace(/\s+/g, "").toUpperCase();
            if (rawIban !== "") {
              yield* client.workspace.createBankAccount({
                params: { workspaceId },
                headers: Api.idempotencyHeaders(args.bankRequestKey),
                payload: {
                  iban: rawIban,
                  bic: args.bic.trim() || null,
                  currency: args.bankCurrency,
                  isDefault: true,
                } as never,
              });
            }
            progress.bankAccount = true;
          }

          // 3. Persist numbering series patterns
          if (!progress.series) {
            const existing = yield* client.workspace.listSeries({ params: { workspaceId } });
            const desired: ReadonlyArray<{
              readonly kind: DocumentKind;
              readonly name: string;
              readonly pattern: string;
            }> = [
              { kind: "invoice", name: "Invoices", pattern: args.invoicePattern.trim() },
              { kind: "proforma", name: "Proformas", pattern: args.proformaPattern.trim() },
              {
                kind: "payment_tax_document",
                name: "Payment tax documents",
                pattern: args.ptdPattern.trim(),
              },
              { kind: "credit_note", name: "Credit notes", pattern: args.creditNotePattern.trim() },
            ];
            for (const entry of desired) {
              if (entry.pattern === "") continue;
              const match =
                existing.find((s) => s.kind === entry.kind && s.isDefault) ??
                existing.find((s) => s.kind === entry.kind);
              if (match !== undefined) {
                if (match.pattern !== entry.pattern) {
                  yield* client.workspace.updateSeries({
                    params: { workspaceId, seriesId: match.id },
                    payload: {
                      kind: entry.kind,
                      name: match.name,
                      pattern: entry.pattern,
                      isDefault: true,
                    },
                  });
                }
              } else {
                yield* client.workspace.createSeries({
                  params: { workspaceId },
                  headers: Api.idempotencyHeaders(`${args.bankRequestKey}-${entry.kind}`),
                  payload: {
                    kind: entry.kind,
                    name: entry.name,
                    pattern: entry.pattern,
                    nextNumber: 1,
                    isDefault: true,
                  },
                });
              }
            }
            progress.series = true;
          }

          return args.workspace.slug;
        }),
      (slug) => Message.CompletedSetup({ seq: args.seq, slug }),
      (failure) => Message.FailedSetup({ seq: args.seq, setupDone: { ...progress }, failure }),
    );
  },
});

const buildSetupCmd = (model: Model, seq: Remote.Seq, workspace: WorkspaceView, bankKey: string) =>
  ApplyOnboardingSetupCmd({
    seq,
    workspace,
    setupDone: model.setupDone,
    bankRequestKey: bankKey,
    legalName: model.legalName,
    ico: model.ico,
    dic: model.dic,
    street: model.street,
    city: model.city,
    postalCode: model.postalCode,
    country: model.country,
    legalForm: model.legalForm,
    registerEntry: model.registerEntry,
    iban: model.iban,
    bic: model.bic,
    bankCurrency: model.bankCurrency,
    invoicePattern: model.invoicePattern,
    proformaPattern: model.proformaPattern,
    ptdPattern: model.ptdPattern,
    creditNotePattern: model.creditNotePattern,
  });

const clampStep = (n: number | undefined): number => {
  if (n === undefined || Number.isNaN(n)) return 1;
  return Math.max(1, Math.min(5, Math.trunc(n)));
};

const formatPatternSample = (pattern: string, counter: number, year: number): string => {
  const yyyy = String(year);
  const yy = yyyy.slice(-2);
  const mm = "11";
  return pattern
    .replace(/YYYY/g, yyyy)
    .replace(/YY/g, yy)
    .replace(/MM/g, mm)
    .replace(/N+/g, (m) => String(counter).padStart(m.length, "0"));
};

export const init = (route: Route, ctx: PageContext): PageReturn<Model, Message> => ({
  model: {
    route,
    step: clampStep(route.step),
    ico: "",
    legalName: "",
    workspaceName: "",
    slug: "",
    slugEdited: false,
    dic: "",
    street: "",
    city: "",
    postalCode: "",
    country: "CZ",
    legalForm: "",
    registerEntry: "",
    ares: Remote.idle,
    taxRegime: "non_vat_payer",
    taxEffectiveFrom: new Date().toISOString().slice(0, 10),
    czechAccount: "",
    iban: "",
    bic: "",
    bankCurrency: "CZK" as CurrencyCode,
    invoicePattern: "YYYY-NNNN",
    proformaPattern: "ZF-YYYY-NNNN",
    ptdPattern: "DD-YYYY-NNNN",
    creditNotePattern: "OD-YYYY-NNNN",
    defaultCurrency: "CZK" as CurrencyCode,
    defaultLanguage: ctx.locale,
    stepError: null,
    submitSeq: 0,
    submitting: false,
    submitFailure: null,
    createRequestKey: null,
    bankRequestKey: null,
    createdWorkspace: null,
    setupDone: emptySetupProgress,
  },
});

const validateStep = (model: Model, ctx: PageContext): string | null => {
  if (model.step === 1 && model.legalName.trim() === "") {
    return local(ctx.locale, "nameRequired");
  }
  if (model.step === 3 && model.iban.trim() !== "") {
    const res = Format.validateIban(model.iban);
    if (!Result.isSuccess(res)) return local(ctx.locale, "ibanInvalid");
  }
  return null;
};

export const update = (
  model: Model,
  message: Message,
  ctx: PageContext,
): PageReturn<Model, Message> =>
  Message.match(message, {
    ClickedStep: ({ step }) => {
      const target = clampStep(step);
      if (target > model.step) {
        const err = validateStep(model, ctx);
        if (err !== null) return { model: { ...model, stepError: err } };
      }
      return { model: { ...model, step: target, stepError: null } };
    },
    ClickedNext: () => {
      const err = validateStep(model, ctx);
      if (err !== null) return { model: { ...model, stepError: err } };
      return { model: { ...model, step: clampStep(model.step + 1), stepError: null } };
    },
    ClickedBack: () => ({
      model: { ...model, step: clampStep(model.step - 1), stepError: null },
    }),
    ChangedField: ({ field, value }) => {
      const next: Model = { ...model, [field]: value, stepError: null, submitFailure: null };
      if (field === "legalName") {
        const wsName =
          model.workspaceName === "" || model.workspaceName === model.legalName
            ? value
            : model.workspaceName;
        return {
          model: {
            ...next,
            workspaceName: wsName,
            slug: model.slugEdited ? model.slug : slugifyName(wsName),
          },
        };
      }
      if (field === "workspaceName" && !model.slugEdited) {
        return { model: { ...next, slug: slugifyName(value) } };
      }
      if (field === "slug") {
        return { model: { ...next, slug: slugifyName(value), slugEdited: value !== "" } };
      }
      if (field === "czechAccount") {
        const parsed = Format.parseCzechAccount(value);
        if (Result.isSuccess(parsed)) {
          return {
            model: {
              ...next,
              iban: Format.formatIban(Format.czechAccountToIban(parsed.success)),
            },
          };
        }
      }
      return { model: next };
    },
    SelectedTaxRegime: ({ regime }) => ({
      model: { ...model, taxRegime: regime, stepError: null },
    }),
    SelectedBankCurrency: ({ currency }) => ({
      model: { ...model, bankCurrency: currency },
    }),
    SelectedDefaultCurrency: ({ currency }) => ({
      model: { ...model, defaultCurrency: currency },
    }),
    SelectedDefaultLanguage: ({ language }) => ({
      model: { ...model, defaultLanguage: language },
    }),
    ClickedLookupAres: () => {
      const check = Format.validateIco(model.ico);
      if (!Result.isSuccess(check)) {
        return { model: { ...model, stepError: local(ctx.locale, "icoInvalid") } };
      }
      const normalized = check.success;
      const ares = Remote.load(model.ares);
      const seq = Remote.seqOf(ares);
      return {
        model: { ...model, ico: normalized, ares, stepError: null },
        commands: [LookupAresCmd({ ico: normalized, seq })],
      };
    },
    GotAres: ({ seq, result }) => {
      const ares = Remote.succeed(model.ares, seq, result);
      if (ares._tag !== "Loaded") return { model: { ...model, ares } };
      const wsName = result.name;
      return {
        model: {
          ...model,
          ares,
          ico: result.ico,
          legalName: result.name,
          workspaceName: wsName,
          slug: model.slugEdited ? model.slug : slugifyName(wsName),
          dic: result.dic ?? model.dic,
          street: result.address.street,
          city: result.address.city,
          postalCode: result.address.postalCode,
          country: result.address.country,
          legalForm: result.legalForm,
          registerEntry: result.registerEntry ?? "",
          taxRegime: result.dic !== null ? "vat_payer" : model.taxRegime,
        },
      };
    },
    FailedAres: ({ seq, failure }) => ({
      model: { ...model, ares: Remote.fail(model.ares, seq, failure) },
    }),
    ClickedCreateWorkspace: () => {
      if (model.legalName.trim() === "") {
        return { model: { ...model, step: 1, stepError: local(ctx.locale, "nameRequired") } };
      }
      if (model.iban.trim() !== "") {
        const ibanCheck = Format.validateIban(model.iban);
        if (!Result.isSuccess(ibanCheck)) {
          return { model: { ...model, step: 3, stepError: local(ctx.locale, "ibanInvalid") } };
        }
      }
      const seq = model.submitSeq + 1;
      const bankKey = model.bankRequestKey ?? randomKey();
      // Resume setup steps if workspace was already created on a previous attempt
      if (model.createdWorkspace !== null) {
        return {
          model: {
            ...model,
            submitSeq: seq,
            submitting: true,
            submitFailure: null,
            stepError: null,
            bankRequestKey: bankKey,
          },
          commands: [buildSetupCmd(model, seq, model.createdWorkspace, bankKey)],
        };
      }
      const slug = model.slug.trim() || slugifyName(model.workspaceName || model.legalName);
      const ico = model.ico.trim();
      const idempotencyKey = model.createRequestKey ?? randomKey();
      return {
        model: {
          ...model,
          submitSeq: seq,
          submitting: true,
          submitFailure: null,
          stepError: null,
          createRequestKey: idempotencyKey,
          bankRequestKey: bankKey,
        },
        commands: [
          CreateWorkspaceCmd({
            seq,
            idempotencyKey,
            name: model.workspaceName.trim() || model.legalName.trim(),
            ...(slug !== "" ? { slug } : {}),
            ...(ico !== "" ? { ico } : {}),
            taxRegime: model.taxRegime,
            currency: model.defaultCurrency,
            language: model.defaultLanguage,
          }),
        ],
      };
    },
    CompletedCreate: ({ seq, workspace }) => {
      if (seq !== model.submitSeq) return { model };
      const bankKey = model.bankRequestKey ?? randomKey();
      const nextModel: Model = {
        ...model,
        createdWorkspace: workspace,
        bankRequestKey: bankKey,
        submitting: true,
      };
      return {
        model: nextModel,
        commands: [buildSetupCmd(nextModel, seq, workspace, bankKey)],
      };
    },
    FailedCreate: ({ seq, failure }) => {
      if (seq !== model.submitSeq) return { model };
      return { model: { ...model, submitting: false, submitFailure: failure } };
    },
    CompletedSetup: ({ seq, slug }) => {
      if (seq !== model.submitSeq) return { model };
      return {
        model: {
          ...model,
          submitting: false,
          setupDone: { issuingEntity: true, bankAccount: true, series: true },
        },
        outMessage: Intent_.reloadSession({
          _tag: "Path",
          path: href({ _tag: "Dashboard", ws: slug as WorkspaceView["slug"] }),
          replace: true,
        }),
      };
    },
    FailedSetup: ({ seq, setupDone, failure }) => {
      if (seq !== model.submitSeq) return { model };
      return {
        model: { ...model, submitting: false, setupDone, submitFailure: failure },
      };
    },
  } satisfies MessageHandlers<Message, PageReturn<Model, Message>>);

export const title = (_model: Model, ctx: PageContext): string =>
  translator(ctx.locale).t("onboarding.wizard.title");

export const view = (model: Model, ctx: PageContext, h: Html.H<Message>) => {
  const t = translator(ctx.locale);
  const year = 2026;
  const steps = [
    { num: 1, label: t.t("onboarding.wizard.step.entity") },
    { num: 2, label: t.t("onboarding.wizard.step.tax") },
    { num: 3, label: t.t("onboarding.wizard.step.bank") },
    { num: 4, label: t.t("onboarding.wizard.step.numbering") },
    { num: 5, label: local(ctx.locale, "stepPreview") },
  ] as const;

  const aresData = Remote.dataOf(model.ares);
  const aresBusy = Remote.isPending(model.ares);

  const stepContent = (() => {
    switch (model.step) {
      case 1:
        return card(h, [
          cardTitle(h, t.t("onboarding.wizard.step.entity")),
          h.div.class("kb-stack").children([
            h.p.class("kb-muted").children([t.t("onboarding.wizard.entity.intro")]),
            h.div
              .class("kb-row")
              .style({ alignItems: "flex-end" })
              .children([
                h.div.style({ flex: "1", minWidth: "200px" }).children([
                  textField(h, {
                    id: "onb-ico",
                    label: t.t("common.field.ico"),
                    value: model.ico,
                    mono: true,
                    placeholder: "01234567",
                    onInput: (value) => Message.ChangedField({ field: "ico", value }),
                  }),
                ]),
                button(h, {
                  label: aresBusy
                    ? t.t("onboarding.wizard.entity.lookingUp")
                    : t.t("onboarding.wizard.entity.lookup"),
                  onClick: Message.ClickedLookupAres(),
                  variant: "secondary",
                  icon: icon(h, "search", 16),
                  busy: aresBusy,
                  disabled: aresBusy,
                  testId: "onboarding-ares-lookup",
                }),
              ]),
            ...(model.ares._tag === "Loaded"
              ? [banner(h, { text: t.t("onboarding.wizard.entity.found"), tone: "info" })]
              : []),
            ...(aresData?.terminatedOn !== null && aresData !== undefined
              ? [
                  banner(h, {
                    text: local(ctx.locale, "dissolvedWarning", {
                      date: Format.formatDate(ctx.locale, aresData.terminatedOn),
                    }),
                    tone: "error",
                  }),
                ]
              : []),
            ...(model.ares._tag === "Failed"
              ? [
                  banner(h, {
                    text:
                      model.ares.failure.tag === "NotFound"
                        ? t.t("onboarding.wizard.entity.notFound")
                        : t.t("onboarding.wizard.entity.aresDown"),
                    tone: "error",
                  }),
                ]
              : []),
            h.div.class("kb-grid").children([
              textField(h, {
                id: "onb-legal-name",
                label: t.t("onboarding.wizard.entity.legalName"),
                value: model.legalName,
                required: true,
                onInput: (value) => Message.ChangedField({ field: "legalName", value }),
              }),
              textField(h, {
                id: "onb-ws-name",
                label: t.t("onboarding.wizard.entity.workspaceName"),
                value: model.workspaceName,
                onInput: (value) => Message.ChangedField({ field: "workspaceName", value }),
              }),
              textField(h, {
                id: "onb-slug",
                label: t.t("onboarding.wizard.entity.slug"),
                value: model.slug,
                mono: true,
                onInput: (value) => Message.ChangedField({ field: "slug", value }),
              }),
              textField(h, {
                id: "onb-dic",
                label: t.t("common.field.dic"),
                value: model.dic,
                mono: true,
                onInput: (value) => Message.ChangedField({ field: "dic", value }),
              }),
              textField(h, {
                id: "onb-street",
                label: t.t("common.field.street"),
                value: model.street,
                onInput: (value) => Message.ChangedField({ field: "street", value }),
              }),
              textField(h, {
                id: "onb-city",
                label: t.t("common.field.city"),
                value: model.city,
                onInput: (value) => Message.ChangedField({ field: "city", value }),
              }),
              textField(h, {
                id: "onb-postal",
                label: t.t("common.field.postalCode"),
                value: model.postalCode,
                mono: true,
                onInput: (value) => Message.ChangedField({ field: "postalCode", value }),
              }),
              textField(h, {
                id: "onb-register",
                label: t.t("onboarding.wizard.entity.registerEntry"),
                hint: t.t("onboarding.wizard.entity.registerEntryHint"),
                value: model.registerEntry,
                onInput: (value) => Message.ChangedField({ field: "registerEntry", value }),
              }),
            ]),
          ]),
        ]);

      case 2:
        return card(h, [
          cardTitle(h, t.t("onboarding.wizard.step.tax")),
          h.div.class("kb-stack").children([
            h.p.class("kb-muted").children([t.t("onboarding.wizard.tax.intro")]),
            h.div.class("kb-regime-grid").children(
              (["non_vat_payer", "vat_payer", "identified_person"] as const).map((regime) =>
                h.button
                  .attr("type", "button")
                  .class("kb-regime-card")
                  .attr("aria-pressed", String(model.taxRegime === regime ? "true" : "false"))
                  .on("click", Message.SelectedTaxRegime({ regime }))
                  .children([
                    h.strong.children([t.translate(I18n.enumText("taxRegime", regime))]),
                    h.span.class("kb-small").children([t.t(`enum.taxRegimeHint.${regime}`)]),
                  ]),
              ),
            ),
            h.div.class("kb-grid").children([
              ...(model.taxRegime !== "non_vat_payer"
                ? [
                    textField(h, {
                      id: "onb-tax-dic",
                      label: t.t("common.field.dic"),
                      value: model.dic,
                      mono: true,
                      placeholder: "CZ01234567",
                      onInput: (value) => Message.ChangedField({ field: "dic", value }),
                    }),
                  ]
                : []),
              textField(h, {
                id: "onb-tax-effective",
                label: t.t("onboarding.wizard.tax.effectiveFrom"),
                type: "date",
                value: model.taxEffectiveFrom,
                onInput: (value) => Message.ChangedField({ field: "taxEffectiveFrom", value }),
              }),
            ]),
          ]),
        ]);

      case 3:
        return card(h, [
          cardTitle(h, t.t("onboarding.wizard.step.bank")),
          h.div.class("kb-stack").children([
            h.p.class("kb-muted").children([t.t("onboarding.wizard.bank.intro")]),
            ...(model.iban.trim() === ""
              ? [banner(h, { text: t.t("onboarding.wizard.bank.noQrWarning"), tone: "info" })]
              : []),
            h.div.class("kb-grid").children([
              textField(h, {
                id: "onb-cz-account",
                label: local(ctx.locale, "czechAccountLabel"),
                hint: local(ctx.locale, "czechAccountHint"),
                value: model.czechAccount,
                mono: true,
                onInput: (value) => Message.ChangedField({ field: "czechAccount", value }),
              }),
              textField(h, {
                id: "onb-iban",
                label: t.t("common.field.iban"),
                value: model.iban,
                mono: true,
                placeholder: "CZ65 0800 0000 1920 0014 5399",
                onInput: (value) => Message.ChangedField({ field: "iban", value }),
              }),
              textField(h, {
                id: "onb-bic",
                label: t.t("common.field.bic"),
                value: model.bic,
                mono: true,
                placeholder: "GIBACZPX",
                onInput: (value) => Message.ChangedField({ field: "bic", value }),
              }),
              selectField(h, {
                id: "onb-bank-currency",
                label: t.t("common.field.currency"),
                value: model.bankCurrency,
                options: [
                  { value: "CZK", label: "CZK" },
                  { value: "EUR", label: "EUR" },
                ],
                onChange: (v) =>
                  Message.SelectedBankCurrency({
                    currency: (v === "EUR" ? "EUR" : "CZK") as CurrencyCode,
                  }),
              }),
            ]),
            h.span.class("kb-small kb-muted").children([t.t("onboarding.wizard.bank.optional")]),
          ]),
        ]);

      case 4: {
        const previewList = [1, 2, 3]
          .map((n) => formatPatternSample(model.invoicePattern || "YYYY-NNNN", n, year))
          .join(", ");
        return card(h, [
          cardTitle(h, local(ctx.locale, "step4Title")),
          h.div.class("kb-stack").children([
            h.p.class("kb-muted").children([t.t("onboarding.wizard.numbering.intro")]),
            banner(h, {
              text: t.t("onboarding.wizard.numbering.preview", { numbers: previewList }),
              tone: "info",
            }),
            h.div.class("kb-grid").children([
              textField(h, {
                id: "onb-pat-inv",
                label: local(ctx.locale, "invoiceSeries"),
                value: model.invoicePattern,
                mono: true,
                onInput: (value) => Message.ChangedField({ field: "invoicePattern", value }),
              }),
              textField(h, {
                id: "onb-pat-prof",
                label: local(ctx.locale, "proformaSeries"),
                value: model.proformaPattern,
                mono: true,
                onInput: (value) => Message.ChangedField({ field: "proformaPattern", value }),
              }),
              ...(model.taxRegime === "vat_payer"
                ? [
                    textField(h, {
                      id: "onb-pat-ptd",
                      label: local(ctx.locale, "ptdSeries"),
                      value: model.ptdPattern,
                      mono: true,
                      onInput: (value) => Message.ChangedField({ field: "ptdPattern", value }),
                    }),
                  ]
                : []),
              textField(h, {
                id: "onb-pat-cn",
                label: local(ctx.locale, "creditNoteSeries"),
                value: model.creditNotePattern,
                mono: true,
                onInput: (value) => Message.ChangedField({ field: "creditNotePattern", value }),
              }),
              selectField(h, {
                id: "onb-def-currency",
                label: local(ctx.locale, "defaultCurrency"),
                value: model.defaultCurrency,
                options: [
                  { value: "CZK", label: "CZK" },
                  { value: "EUR", label: "EUR" },
                ],
                onChange: (v) =>
                  Message.SelectedDefaultCurrency({
                    currency: (v === "EUR" ? "EUR" : "CZK") as CurrencyCode,
                  }),
              }),
              selectField(h, {
                id: "onb-def-lang",
                label: local(ctx.locale, "defaultLanguage"),
                value: model.defaultLanguage,
                options: [
                  { value: "cs", label: "Čeština" },
                  { value: "en", label: "English" },
                ],
                onChange: (v) =>
                  Message.SelectedDefaultLanguage({ language: v === "en" ? "en" : "cs" }),
              }),
            ]),
          ]),
        ]);
      }

      default: {
        const sampleNumber = formatPatternSample(model.invoicePattern || "YYYY-NNNN", 1, year);
        const isVat = model.taxRegime === "vat_payer";
        const net = Format.moneyDisplay(ctx.locale, {
          amount: "10000.00",
          currency: model.defaultCurrency,
        });
        const total = Format.moneyDisplay(ctx.locale, {
          amount: isVat ? "12100.00" : "10000.00",
          currency: model.defaultCurrency,
        });
        return card(h, [
          cardTitle(h, local(ctx.locale, "previewHeading")),
          h.div.class("kb-stack").children([
            h.p.class("kb-muted").children([local(ctx.locale, "previewIntro")]),
            h.div.class("kb-mini-invoice").children([
              h.div.class("kb-mini-invoice__head").children([
                h.div
                  .class("kb-stack")
                  .style({ "--kb-gap": "2px" })
                  .children([
                    h.strong.children([model.legalName || "—"]),
                    ...(model.ico !== ""
                      ? [
                          h.span
                            .class("kb-small kb-muted")
                            .children([
                              `IČO ${model.ico}${model.dic !== "" ? ` · DIČ ${model.dic}` : ""}`,
                            ]),
                        ]
                      : []),
                    ...(model.street !== "" || model.city !== ""
                      ? [
                          h.span
                            .class("kb-small kb-muted")
                            .children([
                              [model.street, model.postalCode, model.city]
                                .filter(Boolean)
                                .join(", "),
                            ]),
                        ]
                      : []),
                  ]),
                h.div
                  .class("kb-stack")
                  .style({ alignItems: "flex-end", "--kb-gap": "4px" })
                  .children([
                    mono(h, sampleNumber),
                    badge(
                      h,
                      t.translate(I18n.enumText("taxRegime", model.taxRegime)),
                      isVat ? "proforma" : "outline",
                    ),
                  ]),
              ]),
              dl(h, [
                [t.t("common.field.name"), local(ctx.locale, "sampleCustomer")],
                [t.t("common.field.description"), local(ctx.locale, "sampleLine")],
                [t.t("common.field.subtotal"), amount(h, net.text)],
                ...(isVat ? [[t.t("common.field.vat"), "21 %"] as const] : []),
                [t.t("common.field.total"), amount(h, total.text)],
                [
                  t.t("common.field.iban"),
                  model.iban !== ""
                    ? mono(h, model.iban)
                    : h.span.class("kb-muted").children([local(ctx.locale, "qrMissing")]),
                ],
              ]),
              h.div
                .class("kb-row")
                .children([
                  badge(
                    h,
                    model.iban !== ""
                      ? local(ctx.locale, "qrIncluded")
                      : local(ctx.locale, "qrMissing"),
                    model.iban !== "" ? "paid" : "draft",
                  ),
                ]),
            ]),
            h.span.class("kb-footnote").children([t.t("onboarding.wizard.nothingSaved")]),
          ]),
        ]);
      }
    }
  })();

  return h.div.class("kb-onboarding").children([
    pageHeader(h, {
      title: t.t("onboarding.wizard.title"),
      subtitle: t.t("onboarding.wizard.stepOf", { step: model.step, steps: 5 }),
    }),
    h.nav
      .class("kb-stepper")
      .attr("aria-label", t.t("onboarding.wizard.title"))
      .children(
        steps.map((s) =>
          withAttributes(h.button.class(), [
            (element) => element.attr("type", "button"),
            (element) => element.class("kb-stepper__item"),
            (node) => (s.num === model.step ? node.attr("aria-current", "step") : node),
            (element) => element.on("click", Message.ClickedStep({ step: s.num })),
          ]).children([
            h.span.class("kb-stepper__num").children([String(s.num)]),
            h.span.children([s.label]),
          ]),
        ),
      ),
    ...(model.stepError !== null ? [banner(h, { text: model.stepError, tone: "error" })] : []),
    ...(model.submitFailure !== null
      ? [banner(h, { text: failureMessage(t, model.submitFailure), tone: "error" })]
      : []),
    stepContent,
    h.div.class("kb-onboarding__actions").children([
      model.step > 1
        ? button(h, {
            label: t.t("common.action.back"),
            onClick: Message.ClickedBack(),
            variant: "secondary",
          })
        : h.span.children([]),
      h.div.class("kb-row").children([
        ...(model.step === 3
          ? [
              button(h, {
                label: t.t("common.action.skip"),
                onClick: Message.ClickedNext(),
                variant: "ghost",
              }),
            ]
          : []),
        model.step < 5
          ? button(h, {
              label: t.t("common.action.next"),
              onClick: Message.ClickedNext(),
              variant: "primary",
              testId: "onboarding-next",
            })
          : button(h, {
              label: model.submitting
                ? t.t("onboarding.wizard.creating")
                : t.t("onboarding.wizard.submit"),
              onClick: Message.ClickedCreateWorkspace(),
              variant: "primary",
              busy: model.submitting,
              disabled: model.submitting,
              testId: "onboarding-submit",
            }),
      ]),
    ]),
  ]);
};
