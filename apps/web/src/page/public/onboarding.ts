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
  BankAccountInput,
  CurrencyCode,
  DocumentKind,
  Locale as DomainLocale,
  IssuingEntityPatch,
  RegistryResult,
  TaxRegime,
  WorkspaceId,
  WorkspaceSlug,
  WorkspaceView,
} from "@kvitbit/domain";
import { Api, Format, I18n } from "@kvitbit/ui-port";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as EffectRecord from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { type Client, Failure } from "../../app/api";
import { readSessionStorage, writeSessionStorage } from "../../app/browser";
import { browserCommand, defineApiCommand } from "../../app/commands";
import { copy, translator } from "../../app/i18n";
import { Intent_ } from "../../app/intent";
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
import { callApi, failureMessage, slugifyName } from "./_shared";

export const Route = RouteCases.Onboarding;
export type Route = typeof Route.Type;

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

const SeriesRequestKeys = Schema.Struct({
  invoice: Schema.String,
  proforma: Schema.String,
  payment_tax_document: Schema.String,
  credit_note: Schema.String,
});
type SeriesRequestKeys = typeof SeriesRequestKeys.Type;

export const Model = Schema.Struct({
  route: Route,
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
  invoiceStart: Schema.String,
  proformaStart: Schema.String,
  ptdStart: Schema.String,
  creditNoteStart: Schema.String,
  defaultCurrency: CurrencyCode,
  defaultLanguage: DomainLocale,
  // Step 5: Submit & resumable setup progress
  stepError: Schema.NullOr(Schema.String),
  submitSeq: Remote.Seq,
  submitting: Schema.Boolean,
  submitFailure: Schema.NullOr(Failure),
  createRequestKey: Schema.NullOr(Schema.String),
  bankRequestKey: Schema.NullOr(Schema.String),
  seriesRequestKeys: Schema.optionalKey(SeriesRequestKeys),
  createdWorkspace: Schema.NullOr(WorkspaceView),
  setupDone: SetupProgress,
  draftReady: Schema.Boolean,
  interruptedWrite: Schema.Boolean,
});
export type Model = typeof Model.Type;

export const Message = UiSchema.TaggedEnum({
  RestoredDraft: { draft: Schema.NullOr(Model) },
  SavedDraft: {},
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
      "legalForm",
      "registerEntry",
      "czechAccount",
      "iban",
      "bic",
      "invoicePattern",
      "proformaPattern",
      "ptdPattern",
      "creditNotePattern",
      "invoiceStart",
      "proformaStart",
      "ptdStart",
      "creditNoteStart",
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
  GotRequestKeys: {
    seq: Remote.Seq,
    createKey: Schema.NullOr(Schema.String),
    bankKey: Schema.String,
    seriesKeys: SeriesRequestKeys,
  },
  CompletedCreate: { seq: Remote.Seq, workspace: WorkspaceView },
  FailedCreate: { seq: Remote.Seq, failure: Failure },
  CompletedSetup: { seq: Remote.Seq, slug: WorkspaceSlug },
  FailedSetup: { seq: Remote.Seq, setupDone: SetupProgress, failure: Failure },
});
export type Message = typeof Message.Type;

const onboardingDraftKey = (userId: string) => `kb.onboarding.v1.${userId}`;
const draftKey = (ctx: PageContext) =>
  ctx.session._tag === "SignedIn" ? onboardingDraftKey(ctx.session.user.id) : null;

const DraftJson = Schema.fromJsonString(Model);
const decodeDraft = Schema.decodeUnknownOption(DraftJson);
const encodeDraft = Schema.encodeEffect(DraftJson);

const readDraft = (key: string) =>
  browserCommand(
    "OnboardingReadDraft",
    readSessionStorage(key).pipe(
      Effect.map((stored) => Option.getOrNull(decodeDraft(stored))),
      Effect.orElseSucceed(() => null),
      Effect.map((draft) => Message.RestoredDraft({ draft })),
    ),
  );

const storeDraft = Effect.fn("storeOnboardingDraft")(
  function* (key: string | null, model: Model) {
    if (key === null) return;
    if (model.setupDone.series) {
      yield* writeSessionStorage({ key, value: null });
      return;
    }
    const json = yield* encodeDraft({
      ...model,
      ares: Remote.idle,
      stepError: null,
      submitFailure: null,
    });
    yield* writeSessionStorage({ key, value: json });
  },
  (write) => Effect.ignore(write),
);

const local = copy({
  cs: {
    stepPreview: "Náhled a potvrzení",
    icoInvalid: "Zadejte platné 8místné IČO.",
    nameRequired: "Zadejte název firmy nebo podnikatele.",
    dissolvedWarning: "Pozor: společnost má v ARES datum zániku {date}.",
    czechAccountLabel: "České číslo účtu (např. 123456789/0100)",
    czechAccountHint: "Automaticky převedeme na IBAN.",
    ibanInvalid: "Zadejte platný IBAN.",
    bicInvalid: "Zadejte platný BIC.",
    slugInvalid: "Adresa prostoru musí mít 3 až 40 znaků.",
    legalForm: "Právní forma",
    invoiceSeries: "Řada faktur",
    proformaSeries: "Řada zálohových faktur",
    ptdSeries: "Řada daňových dokladů k platbě",
    creditNoteSeries: "Řada opravných dokladů",
    startNumber: "Počáteční číslo",
    seriesInvalid: "Zadejte vzor a kladné celé počáteční číslo pro každou řadu.",
    resume: "Dokončit nastavení",
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
    bicInvalid: "Enter a valid BIC.",
    slugInvalid: "Use 3 to 40 characters for the workspace address.",
    legalForm: "Legal form",
    invoiceSeries: "Invoice series",
    proformaSeries: "Proforma series",
    ptdSeries: "Payment tax document series",
    creditNoteSeries: "Credit note series",
    startNumber: "Starting number",
    seriesInvalid: "Enter a pattern and a positive whole starting number for each series.",
    resume: "Finish workspace setup",
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
  draftKey: Schema.NullOr(Schema.String),
  draft: Model,
  seq: Remote.Seq,
  idempotencyKey: Schema.String,
  name: Schema.String,
  slug: Schema.optional(WorkspaceSlug),
  taxRegime: TaxRegime,
  currency: CurrencyCode,
  language: DomainLocale,
});

const LookupAresCmd = defineApiCommand({
  message: Message,
  // biome-ignore lint/security/noSecrets: This is a statically declared UI command or message name.
  name: "OnboardingLookupAres",
  args: { ico: Schema.String, seq: Remote.Seq },
  execute: ({ ico, seq }) =>
    callApi(
      (client) => client.registry.lookupCompany({ params: { ico } }),
      (result) => Message.GotAres({ seq, result }),
      (failure) => Message.FailedAres({ seq, failure }),
    ),
});

const CreateWorkspaceCmd = defineApiCommand({
  message: Message,
  // biome-ignore lint/security/noSecrets: This is a statically declared UI command or message name.
  name: "OnboardingCreateWorkspace",
  args: CreateWorkspaceArgs.fields,
  execute: Effect.fn("create workspace")(function* ({
    draftKey: currentDraftKey,
    draft,
    seq,
    idempotencyKey,
    name,
    slug,
    taxRegime,
    currency,
    language,
  }: typeof CreateWorkspaceArgs.Type) {
    const details = { name, taxRegime, defaults: { currency, language } };
    const payload = slug === undefined ? details : { ...details, slug };
    yield* storeDraft(currentDraftKey, draft);
    return yield* callApi(
      (client) =>
        client.myWorkspaces.create({
          headers: { "idempotency-key": idempotencyKey },
          payload,
        }),
      (workspace) => Message.CompletedCreate({ seq, workspace }),
      (failure) => Message.FailedCreate({ seq, failure }),
    );
  }),
});

const setupSeries = [
  {
    kind: "invoice",
    label: "invoiceSeries",
    name: "Invoices",
    pattern: "invoicePattern",
    start: "invoiceStart",
  },
  {
    kind: "proforma",
    label: "proformaSeries",
    name: "Proformas",
    pattern: "proformaPattern",
    start: "proformaStart",
  },
  {
    kind: "payment_tax_document",
    label: "ptdSeries",
    name: "Payment tax documents",
    pattern: "ptdPattern",
    start: "ptdStart",
  },
  {
    kind: "credit_note",
    label: "creditNoteSeries",
    name: "Credit notes",
    pattern: "creditNotePattern",
    start: "creditNoteStart",
  },
] as const;

const eligibleSeries = (taxRegime: TaxRegime) =>
  Arr.filter(
    setupSeries,
    ({ kind }) => kind !== "payment_tax_document" || taxRegime === "vat_payer",
  );

const nullableText = Schema.NullOr(Schema.String);
const readIssuingEntity = Schema.decodeUnknownOption(
  Schema.Struct({
    name: Schema.String,
    ico: nullableText,
    dic: nullableText,
    legalForm: nullableText,
    registerEntry: nullableText,
    address: Schema.Struct({
      street: Schema.String,
      city: Schema.String,
      postalCode: Schema.String,
      country: Schema.String,
    }),
  }),
);

const ApplySetupArgs = Schema.Struct({
  draftKey: Schema.NullOr(Schema.String),
  draft: Model,
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
  series: Schema.Array(
    Schema.Struct({
      kind: DocumentKind,
      requestKey: Schema.String,
      name: Schema.String,
      pattern: Schema.String,
      nextNumber: Schema.Int,
    }),
  ),
});

const ApplyOnboardingSetupCmd = defineApiCommand({
  message: Message,
  // biome-ignore lint/security/noSecrets: This is a statically declared UI command or message name.
  name: "OnboardingApplySetup",
  args: ApplySetupArgs.fields,
  execute: (args) => {
    const progress = { ...args.setupDone };
    return callApi(
      Effect.fn("apply workspace setup")(function* (client: Client) {
        yield* storeDraft(args.draftKey, args.draft);
        const workspaceId = yield* Schema.decodeUnknownEffect(WorkspaceId)(args.workspace.id);
        if (!progress.issuingEntity) {
          const current = yield* client.workspace.current({ params: { workspaceId } });
          const address = {
            street: Str.trim(args.street),
            city: Str.trim(args.city),
            postalCode: Str.trim(args.postalCode),
            country: Str.toUpperCase(Str.trim(args.country)) || "CZ",
          };
          const issuer = {
            name: Str.trim(args.legalName),
            ico: Str.trim(args.ico) || null,
            dic: Str.trim(args.dic) || null,
            legalForm: Str.trim(args.legalForm) || null,
            registerEntry: Str.trim(args.registerEntry) || null,
          };
          const stored = Option.getOrUndefined(readIssuingEntity(current.issuingEntity));
          const matches =
            stored !== undefined &&
            Arr.every(EffectRecord.toEntries(issuer), ([key, value]) => stored[key] === value) &&
            Arr.every(
              EffectRecord.toEntries(address),
              ([key, value]) => stored.address[key] === value,
            );
          if (!matches) {
            yield* client.workspace.updateIssuingEntity({
              params: { workspaceId },
              headers: Api.ifMatchHeaders(current.revision),
              payload: IssuingEntityPatch.make({ ...issuer, address }),
            });
          }
          progress.issuingEntity = true;
        }

        // 2. Persist bank account if IBAN was entered
        if (!progress.bankAccount) {
          const rawIban = Str.toUpperCase(Str.replace(/\s+/g, "")(args.iban));
          if (rawIban !== "") {
            yield* client.workspace.createBankAccount({
              params: { workspaceId },
              headers: Api.idempotencyHeaders(args.bankRequestKey),
              payload: BankAccountInput.make({
                iban: rawIban,
                bic: Str.toUpperCase(Str.trim(args.bic)) || null,
                currency: args.bankCurrency,
                isDefault: true,
              }),
            });
          }
          progress.bankAccount = true;
        }

        if (!progress.series) {
          const existing = yield* client.workspace.listSeries({ params: { workspaceId } });
          for (const entry of args.series) {
            const match =
              Arr.findFirst(existing, (s) => s.kind === entry.kind && s.isDefault).pipe(
                Option.getOrUndefined,
              ) ??
              Arr.findFirst(existing, (s) => s.kind === entry.kind).pipe(Option.getOrUndefined);
            if (match !== undefined) {
              const changedPattern = match.pattern !== entry.pattern;
              const setCounter = entry.nextNumber > (changedPattern ? 1 : match.nextCounter);
              if (!match.isDefault || changedPattern || setCounter) {
                const series = {
                  kind: entry.kind,
                  name: match.name,
                  pattern: entry.pattern,
                  isDefault: true,
                };
                yield* client.workspace.updateSeries({
                  params: { workspaceId, seriesId: match.id },
                  payload: setCounter ? { ...series, nextNumber: entry.nextNumber } : series,
                });
              }
            } else {
              yield* client.workspace.createSeries({
                params: { workspaceId },
                headers: Api.idempotencyHeaders(entry.requestKey),
                payload: {
                  kind: entry.kind,
                  name: entry.name,
                  pattern: entry.pattern,
                  nextNumber: entry.nextNumber,
                  isDefault: true,
                },
              });
            }
          }
          progress.series = true;
        }

        yield* storeDraft(args.draftKey, { ...args.draft, setupDone: progress });
        return args.workspace.slug;
      }),
      (slug) => Message.CompletedSetup({ seq: args.seq, slug }),
      (failure) => Message.FailedSetup({ seq: args.seq, setupDone: { ...progress }, failure }),
    );
  },
});

const buildSetupCmd = (
  model: Model,
  seq: Remote.Seq,
  workspace: WorkspaceView,
  bankKey: string,
  seriesKeys: SeriesRequestKeys,
  key: string | null,
) =>
  ApplyOnboardingSetupCmd({
    draftKey: key,
    draft: model,
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
    series: Arr.map(eligibleSeries(model.taxRegime), (series) => ({
      kind: series.kind,
      requestKey: seriesKeys[series.kind],
      name: series.name,
      pattern: Str.trim(model[series.pattern]),
      nextNumber: Number(model[series.start]),
    })),
  });

const clampStep = (n: number | undefined): number => {
  if (n === undefined || Number.isNaN(n)) return 1;
  return Math.max(1, Math.min(5, Math.trunc(n)));
};

const alphaRuns = /([A-Za-z]+)/;
const numberingRun = /^[YMN]+$/;
const numberingTokens = /(YYYY|YY|MM|N+)/;
const numericCounter = /^N+$/;
const alphaWords = /[A-Za-z]+/g;
const numberingChunks = /Y+|M+|N+/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the numbering grammar disallows control characters.
const controlCharacter = /[\u0000-\u001f\u007f]/;
const formatPatternSample = (pattern: string, counter: number, date: string): string => {
  const year = Str.slice(0, 4)(date);
  const month = Str.slice(5, 7)(date);
  return Arr.join(
    Arr.map(Str.split(pattern, alphaRuns), (word, index) =>
      index % 2 === 0 || !numberingRun.test(word)
        ? word
        : Arr.join(
            Arr.map(Str.split(word, numberingTokens), (token, tokenIndex) => {
              if (tokenIndex % 2 === 0) return token;
              if (token === "YYYY") return year;
              if (token === "YY") return Str.slice(-2)(year);
              return token === "MM" ? month : Str.padStart(token.length, "0")(String(counter));
            }),
            "",
          ),
    ),
    "",
  );
};

const validSeries = (pattern: string, start: string): boolean => {
  const counter = Number(start);
  if (
    !(wholeNumberText.test(start) && Number.isSafeInteger(counter)) ||
    counter < 1 ||
    counter > 2_147_483_646
  )
    return false;
  const words: ReadonlyArray<string> = Option.getOrNull(Str.match(alphaWords)(pattern)) ?? [];
  const matchingWords = Arr.filter(words, (word) => numberingRun.test(word));
  const runs = Arr.flatMap(
    matchingWords,
    (word) => Option.getOrNull(Str.match(numberingChunks)(word)) ?? [],
  );
  if (Arr.filter(runs, (run) => numericCounter.test(run)).length !== 1) return false;
  if (Arr.some(runs, (run) => Str.startsWith("Y")(run) && run !== "YY" && run !== "YYYY"))
    return false;
  if (
    Arr.some(
      runs,
      (run) =>
        Str.startsWith("M")(run) &&
        (run !== "MM" || !Arr.some(runs, (other) => Str.startsWith("Y")(other))),
    )
  )
    return false;
  const hasControlCharacter = controlCharacter.test(pattern);
  return !hasControlCharacter && formatPatternSample(pattern, counter, "2026-01-01").length <= 20;
};

const initImpl = (route: Route, ctx: PageContext): PageReturn<Model, Message> => ({
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
    czechAccount: "",
    iban: "",
    bic: "",
    bankCurrency: CurrencyCode.make("CZK"),
    invoicePattern: "YYYY-NNNN",
    proformaPattern: "ZF-YYYY-NNNN",
    ptdPattern: "DD-YYYY-NNNN",
    creditNotePattern: "OD-YYYY-NNNN",
    invoiceStart: "1",
    proformaStart: "1",
    ptdStart: "1",
    creditNoteStart: "1",
    defaultCurrency: CurrencyCode.make("CZK"),
    defaultLanguage: ctx.locale,
    stepError: null,
    submitSeq: 0,
    submitting: false,
    submitFailure: null,
    createRequestKey: null,
    bankRequestKey: null,
    createdWorkspace: null,
    setupDone: emptySetupProgress,
    draftReady: draftKey(ctx) === null,
    interruptedWrite: false,
  },
  commands:
    ctx.session._tag === "SignedIn" ? [readDraft(onboardingDraftKey(ctx.session.user.id))] : [],
});

export const init: {
  (ctx: PageContext): (route: Route) => PageReturn<Model, Message>;
  (route: Route, ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(2, initImpl);

const validateStep = (model: Model, ctx: PageContext): string | null => {
  if (model.step === 1) {
    if (Str.trim(model.legalName) === "") return local(ctx.locale, "nameRequired");
    if (Str.trim(model.ico) !== "" && !Result.isSuccess(Format.validateIco(model.ico)))
      return local(ctx.locale, "icoInvalid");
    if (model.slugEdited && !Schema.is(WorkspaceSlug)(model.slug))
      return local(ctx.locale, "slugInvalid");
  }
  if (model.step === 3) {
    if (Str.trim(model.iban) !== "" && !Result.isSuccess(Format.validateIban(model.iban)))
      return local(ctx.locale, "ibanInvalid");
    if (Str.trim(model.bic) !== "" && !Result.isSuccess(Format.validateBic(model.bic)))
      return local(ctx.locale, "bicInvalid");
  }
  if (
    model.step === 4 &&
    Arr.some(
      eligibleSeries(model.taxRegime),
      ({ pattern, start }) => !validSeries(Str.trim(model[pattern]), model[start]),
    )
  ) {
    return local(ctx.locale, "seriesInvalid");
  }
  return null;
};

const editingLocked = (model: Model) =>
  !model.draftReady ||
  model.submitting ||
  model.interruptedWrite ||
  (model.createdWorkspace === null && model.createRequestKey !== null);

const bankLocked = (model: Model) =>
  model.setupDone.bankAccount || (model.setupDone.issuingEntity && model.bankRequestKey !== null);

const bankFields = new Set(["czechAccount", "iban", "bic"]);
const seriesFields = new Set<string>(
  Arr.flatMap(setupSeries, ({ pattern, start }) => [pattern, start]),
);

const updateWizard = (
  model: Model,
  message: Message,
  ctx: PageContext,
): PageReturn<Model, Message> =>
  Message.match(message, {
    RestoredDraft: ({ draft }) => ({
      model: model.draftReady
        ? model
        : {
            ...(draft ?? model),
            route: model.route,
            draftReady: true,
            submitting: false,
            interruptedWrite: draft?.submitting === true || draft?.interruptedWrite === true,
          },
    }),
    SavedDraft: () => ({ model }),
    ClickedStep: ({ step }) => {
      if (model.submitting) return { model };
      const target = clampStep(step);
      if (target > model.step) {
        const err = validateStep(model, ctx);
        if (err !== null) return { model: { ...model, stepError: err } };
      }
      return { model: { ...model, step: target, stepError: null } };
    },
    ClickedNext: () => {
      if (model.submitting) return { model };
      const err = validateStep(model, ctx);
      if (err !== null) return { model: { ...model, stepError: err } };
      return { model: { ...model, step: clampStep(model.step + 1), stepError: null } };
    },
    ClickedBack: () => ({
      model: model.submitting
        ? model
        : { ...model, step: clampStep(model.step - 1), stepError: null },
    }),
    ChangedField: ({ field, value }) => {
      if (editingLocked(model)) return { model };
      if (
        model.createdWorkspace !== null &&
        (bankFields.has(field)
          ? bankLocked(model)
          : !seriesFields.has(field) &&
            (model.setupDone.issuingEntity || field === "workspaceName" || field === "slug"))
      ) {
        return { model };
      }
      const next: Model = { ...model, [field]: value, stepError: null, submitFailure: null };
      if (field === "legalName") {
        const wsName =
          model.createdWorkspace === null &&
          (model.workspaceName === "" || model.workspaceName === model.legalName)
            ? value
            : model.workspaceName;
        return {
          model: {
            ...next,
            workspaceName: wsName,
            slug:
              model.slugEdited || model.createdWorkspace !== null
                ? model.slug
                : slugifyName(wsName),
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
      model:
        editingLocked(model) || model.createdWorkspace !== null
          ? model
          : { ...model, taxRegime: regime, stepError: null },
    }),
    SelectedBankCurrency: ({ currency }) => ({
      model:
        editingLocked(model) || bankLocked(model) ? model : { ...model, bankCurrency: currency },
    }),
    SelectedDefaultCurrency: ({ currency }) => ({
      model:
        editingLocked(model) || model.createdWorkspace !== null
          ? model
          : { ...model, defaultCurrency: currency },
    }),
    SelectedDefaultLanguage: ({ language }) => ({
      model:
        editingLocked(model) || model.createdWorkspace !== null
          ? model
          : { ...model, defaultLanguage: language },
    }),
    ClickedLookupAres: () => {
      if (editingLocked(model) || model.createdWorkspace !== null) return { model };
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
      if (
        ares === model.ares ||
        ares._tag !== "Loaded" ||
        editingLocked(model) ||
        model.createdWorkspace !== null
      )
        return { model };
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
        },
      };
    },
    FailedAres: ({ seq, failure }) => ({
      model: { ...model, ares: Remote.fail(model.ares, seq, failure) },
    }),
    ClickedCreateWorkspace: () => {
      if (!model.draftReady || model.submitting || model.setupDone.series) return { model };
      for (const step of [1, 3, 4]) {
        const stepError = validateStep({ ...model, step }, ctx);
        if (stepError !== null) return { model: { ...model, step, stepError } };
      }
      const seq = model.submitSeq + 1;
      return {
        model: { ...model, submitSeq: seq, submitting: true, submitFailure: null, stepError: null },
        commands: [
          browserCommand(
            // biome-ignore lint/security/noSecrets: This is a statically declared UI command or message name.
            "OnboardingRequestKeys",
            Effect.gen(function* () {
              const createKey =
                model.createRequestKey ??
                (model.createdWorkspace === null ? yield* Api.uuidV7 : null);
              const bankKey = model.bankRequestKey ?? (yield* Api.uuidV7);
              const seriesKeys =
                model.seriesRequestKeys ??
                (yield* Effect.all(
                  {
                    invoice: Api.uuidV7,
                    proforma: Api.uuidV7,
                    payment_tax_document: Api.uuidV7,
                    credit_note: Api.uuidV7,
                  },
                  { concurrency: 1 },
                ));
              return Message.GotRequestKeys({ seq, createKey, bankKey, seriesKeys });
            }),
          ),
        ],
      };
    },
    GotRequestKeys: ({ seq, createKey, bankKey, seriesKeys }) => {
      if (
        seq !== model.submitSeq ||
        !model.submitting ||
        (model.createdWorkspace === null && createKey === null)
      )
        return { model };
      const draft = {
        ...model,
        createRequestKey: createKey,
        bankRequestKey: bankKey,
        seriesRequestKeys: seriesKeys,
      };
      if (model.createdWorkspace !== null) {
        return {
          model: draft,
          commands: [
            buildSetupCmd(draft, seq, model.createdWorkspace, bankKey, seriesKeys, draftKey(ctx)),
          ],
        };
      }
      if (createKey === null) return { model };
      const slug = model.slugEdited ? Str.trim(model.slug) : "";
      return {
        model: draft,
        commands: [
          CreateWorkspaceCmd({
            draftKey: draftKey(ctx),
            draft,
            seq,
            idempotencyKey: createKey,
            name: Str.trim(model.workspaceName) || Str.trim(model.legalName),
            slug: slug === "" ? undefined : WorkspaceSlug.make(slug),
            taxRegime: model.taxRegime,
            currency: model.defaultCurrency,
            language: model.defaultLanguage,
          }),
        ],
      };
    },
    CompletedCreate: ({ seq, workspace }) => {
      const { bankRequestKey, seriesRequestKeys } = model;
      if (
        seq !== model.submitSeq ||
        !model.submitting ||
        model.createdWorkspace !== null ||
        bankRequestKey === null ||
        seriesRequestKeys === undefined
      )
        return { model };
      const nextModel: Model = { ...model, createdWorkspace: workspace };
      return {
        model: nextModel,
        commands: [
          buildSetupCmd(
            nextModel,
            seq,
            workspace,
            bankRequestKey,
            seriesRequestKeys,
            draftKey(ctx),
          ),
        ],
      };
    },
    FailedCreate: ({ seq, failure }) => {
      if (seq !== model.submitSeq || !model.submitting || model.createdWorkspace !== null)
        return { model };
      return {
        model: {
          ...model,
          submitting: false,
          interruptedWrite: false,
          submitFailure: failure,
          createRequestKey: failure.tag === "Invalid" ? null : model.createRequestKey,
        },
      };
    },
    CompletedSetup: ({ seq, slug }) => {
      if (seq !== model.submitSeq || !model.submitting || model.createdWorkspace === null)
        return { model };
      return {
        model: {
          ...model,
          submitting: false,
          interruptedWrite: false,
          setupDone: { issuingEntity: true, bankAccount: true, series: true },
        },
        outMessage: Intent_.reloadSession({
          _tag: "Path",
          path: href({ _tag: "Dashboard", ws: slug }),
          replace: true,
        }),
      };
    },
    FailedSetup: ({ seq, setupDone, failure }) => {
      if (seq !== model.submitSeq || !model.submitting || model.createdWorkspace === null)
        return { model };
      return {
        model: {
          ...model,
          step:
            failure.tag === "Invalid"
              ? !setupDone.issuingEntity
                ? 1
                : !setupDone.bankAccount
                  ? 3
                  : 4
              : model.step,
          submitting: false,
          interruptedWrite: false,
          setupDone,
          submitFailure: failure,
          bankRequestKey:
            setupDone.issuingEntity && !setupDone.bankAccount && failure.tag === "Invalid"
              ? null
              : model.bankRequestKey,
        },
      };
    },
  } satisfies MessageHandlers<Message, PageReturn<Model, Message>>);

const updateImpl = (
  model: Model,
  message: Message,
  ctx: PageContext,
): PageReturn<Model, Message> => {
  const result = updateWizard(model, message, ctx);
  const key = draftKey(ctx);
  if (
    key === null ||
    result.model === model ||
    result.model.submitting ||
    message._tag === "RestoredDraft" ||
    (result.model.createRequestKey === null && model.createRequestKey === null)
  )
    return result;
  return {
    ...result,
    commands: [
      ...(result.commands ?? []),
      browserCommand(
        "OnboardingSaveDraft",
        Effect.as(storeDraft(key, result.model), Message.SavedDraft()),
      ),
    ],
  };
};

export const update: {
  (message: Message, ctx: PageContext): (model: Model) => PageReturn<Model, Message>;
  (model: Model, message: Message, ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(3, updateImpl);

const titleImpl = (_model: Model, ctx: PageContext): string =>
  translator(ctx.locale).t("onboarding.wizard.title");

export const title: {
  (ctx: PageContext): (_model: Model) => string;
  (_model: Model, ctx: PageContext): string;
} = Fn.dual(2, titleImpl);

const viewImpl = (model: Model, ctx: PageContext, h: Html.H<Message>) => {
  const t = translator(ctx.locale);
  const steps = [
    { num: 1, label: t.t("onboarding.wizard.step.entity") },
    { num: 2, label: t.t("onboarding.wizard.step.tax") },
    { num: 3, label: t.t("onboarding.wizard.step.bank") },
    { num: 4, label: t.t("onboarding.wizard.step.numbering") },
    { num: 5, label: local(ctx.locale, "stepPreview") },
  ] as const;

  const aresData = Remote.dataOf(model.ares);
  const aresBusy = Remote.isPending(model.ares);
  const workspaceCreated = model.createdWorkspace !== null;
  const disableStepFields =
    editingLocked(model) ||
    (model.step === 1 && model.setupDone.issuingEntity) ||
    (model.step === 2 && workspaceCreated) ||
    (model.step === 3 && bankLocked(model));

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
                  disabled: aresBusy || workspaceCreated,
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
                disabled: workspaceCreated,
                label: t.t("onboarding.wizard.entity.workspaceName"),
                value: model.workspaceName,
                onInput: (value) => Message.ChangedField({ field: "workspaceName", value }),
              }),
              textField(h, {
                id: "onb-slug",
                disabled: workspaceCreated,
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
                id: "onb-legal-form",
                label: local(ctx.locale, "legalForm"),
                value: model.legalForm,
                onInput: (value) => Message.ChangedField({ field: "legalForm", value }),
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
              Arr.map(["non_vat_payer", "vat_payer", "identified_person"] as const, (regime) =>
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
            ]),
          ]),
        ]);

      case 3:
        return card(h, [
          cardTitle(h, t.t("onboarding.wizard.step.bank")),
          h.div.class("kb-stack").children([
            h.p.class("kb-muted").children([t.t("onboarding.wizard.bank.intro")]),
            ...(Str.trim(model.iban) === ""
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
                    currency: CurrencyCode.make(v === "EUR" ? "EUR" : "CZK"),
                  }),
              }),
            ]),
            h.span.class("kb-small kb-muted").children([t.t("onboarding.wizard.bank.optional")]),
          ]),
        ]);

      case 4: {
        const previewList = Arr.join(
          Arr.map([1, 2, 3], (n) =>
            formatPatternSample(
              model.invoicePattern || "YYYY-NNNN",
              n + (Number(model.invoiceStart) || 1) - 1,
              ctx.today,
            ),
          ),
          ", ",
        );
        return card(h, [
          cardTitle(h, local(ctx.locale, "step4Title")),
          h.div.class("kb-stack").children([
            h.p.class("kb-muted").children([t.t("onboarding.wizard.numbering.intro")]),
            banner(h, {
              text: t.t("onboarding.wizard.numbering.preview", { numbers: previewList }),
              tone: "info",
            }),
            h.div.class("kb-grid").children([
              ...Arr.map(eligibleSeries(model.taxRegime), ({ kind, label, pattern, start }) =>
                h.div.class("kb-stack").children([
                  textField(h, {
                    id: `onb-pattern-${kind}`,
                    label: local(ctx.locale, label),
                    value: model[pattern],
                    mono: true,
                    onInput: (value) => Message.ChangedField({ field: pattern, value }),
                  }),
                  textField(h, {
                    id: `onb-start-${kind}`,
                    label: local(ctx.locale, "startNumber"),
                    type: "number",
                    value: model[start],
                    onInput: (value) => Message.ChangedField({ field: start, value }),
                  }),
                ]),
              ),
              selectField(h, {
                id: "onb-def-currency",
                disabled: workspaceCreated,
                label: local(ctx.locale, "defaultCurrency"),
                value: model.defaultCurrency,
                options: [
                  { value: "CZK", label: "CZK" },
                  { value: "EUR", label: "EUR" },
                ],
                onChange: (v) =>
                  Message.SelectedDefaultCurrency({
                    currency: CurrencyCode.make(v === "EUR" ? "EUR" : "CZK"),
                  }),
              }),
              selectField(h, {
                id: "onb-def-lang",
                disabled: workspaceCreated,
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
        const sampleNumber = formatPatternSample(
          model.invoicePattern || "YYYY-NNNN",
          Number(model.invoiceStart) || 1,
          ctx.today,
        );
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
                              Arr.join(
                                Arr.filter([model.street, model.postalCode, model.city], Boolean),
                                ", ",
                              ),
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
        Arr.map(steps, (s) =>
          withAttributes(h.button.class(), [
            (element) => element.attr("type", "button"),
            (element) => element.class("kb-stepper__item"),
            (node) => (s.num === model.step ? node.attr("aria-current", "step") : node),
            (node) => (model.submitting ? node.attr("disabled", "") : node),
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
    withAttributes(h.el("fieldset").attr("style", "min-width:0;margin:0;padding:0;border:0"), [
      (node) => (disableStepFields ? node.attr("disabled", "") : node),
    ]).children([stepContent]),
    h.div.class("kb-onboarding__actions").children([
      model.step > 1
        ? button(h, {
            label: t.t("common.action.back"),
            onClick: Message.ClickedBack(),
            variant: "secondary",
            disabled: model.submitting,
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
                : workspaceCreated
                  ? local(ctx.locale, "resume")
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

export const view: {
  (ctx: PageContext, h: Html.H<Message>): (model: Model) => ReturnType<typeof viewImpl>;
  (model: Model, ctx: PageContext, h: Html.H<Message>): ReturnType<typeof viewImpl>;
} = Fn.dual(3, viewImpl);

const wholeNumberText = /^\d+$/;
