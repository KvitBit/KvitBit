/**
 * The one computation every document write and dry run shares (rule D15: "same code path"):
 * a `DocumentSpec` (what the caller asked for, from `DocumentInput`, a stored record, or a
 * record plus `DocumentPatch`) is composed into the stored fields: Document → Contact →
 * Workspace defaults (core-ports 4.2), lines with resolved VAT treatment (rule D9), the CNB or
 * manual rate (rule D11) and the VatMath breakdown (section 5.1).
 *
 * P2's `issue` composes again at issue time (fresh party snapshots, today's date when
 * `issuedOn` was not given) and then allocates the number; P3 builds Credit Note and Final
 * Invoice specs (deduction lines carry `deducts`) and runs them through `compose` too.
 *
 * Floating defaults: a draft without an explicit `issuedOn` (or due date, currency, ...) takes
 * today / the current Contact and Workspace defaults again on every recompute (each edit, and
 * issue); only the caller's own values (`given`) persist. Issue pins the resolved values.
 */
import type {
  BankAccountId,
  ContactId,
  CurrencyCode,
  CurrentCaller,
  DocumentId,
  DocumentInput,
  DocumentKind,
  DocumentPatch,
  FxOverride,
  IsoDate,
  Issue,
  LineId,
  LineInput,
  NumberingSeriesId,
  PriceListItemId,
  TaxRegime,
  VatTreatment,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Invalid, NotFound } from "@kvitbit/domain/contract";
import { ExchangeRates, type RatesUnavailable } from "@kvitbit/domain/ports";
import { BigDecimal, Effect, Result } from "effect";
import { addDays, isCalendarDate, MAX_ISO_DATE } from "../../engines/calendar";
import { HUNDRED } from "../../engines/decimal";
import { Fx } from "../../engines/fx";
import { VatMath } from "../../engines/vat";
import { IdGenerator } from "../../shared/ids";
import { resolveDocumentDefaults } from "../../shared/overrides";
import type { StoreUnavailable } from "../../store/CoreStore";
import { NumberingSeries } from "../numbering";
import type { ContactForDocument, IssuerForDocument } from "./ports";
import { DocumentContacts, DocumentIssuers, DocumentPriceList } from "./ports";
import type {
  BankAccountRecord,
  ContactSnapshotRecord,
  DocumentRecord,
  FxRecord,
  GivenFields,
  IssuerSnapshotRecord,
  LineRecord,
  PaymentRounding,
} from "./record";

const ONE = BigDecimal.fromBigInt(1n);

/** A line before treatment resolution. */
export interface LineSpec {
  /** Kept from the stored line; null for a new line (a fresh id is generated). */
  readonly id: LineId | null;
  readonly item: PriceListItemId | null;
  readonly description: string;
  readonly quantity: BigDecimal.BigDecimal;
  readonly unit: string | null;
  readonly unitPrice: BigDecimal.BigDecimal;
  readonly vat: VatTreatment | null;
  readonly itemVat: VatTreatment | null;
  /**
   * The Price List Item's net price when the line's price was copied from it (not given):
   * recomputes re-derive `unitPrice` from it (currency check, VAT-inclusive gross-up).
   */
  readonly itemPrice: LineRecord["itemPrice"];
  readonly deducts: DocumentId | null;
}

/** What the caller asked for; `compose` resolves everything else. */
export interface DocumentSpec {
  readonly kind: DocumentKind;
  readonly contactId: ContactId;
  readonly given: GivenFields;
  readonly lines: ReadonlyArray<LineSpec>;
  readonly pricesIncludeVat: boolean;
  readonly orderNumber: string | null;
  readonly fxOverride: FxOverride | null;
}

/** The record fields `compose` produces. */
export type Composed = Pick<
  DocumentRecord,
  | "kind"
  | "contactId"
  | "contact"
  | "issuer"
  | "given"
  | "seriesId"
  | "currency"
  | "language"
  | "paymentMethod"
  | "note"
  | "issuedOn"
  | "taxableSupplyOn"
  | "dueOn"
  | "pricesIncludeVat"
  | "variableSymbol"
  | "orderNumber"
  | "lines"
  | "totals"
  | "fx"
  | "fxOverride"
  | "taxDocument"
  | "paymentRounding"
>;

export interface ComposeOptions {
  /** Prague today (default for `issuedOn`). */
  readonly today: IsoDate;
  /**
   * Printed particulars to keep instead of fresh snapshots (rule D10: an issued document keeps
   * them unless `refreshParties`). `contact` is left out when the edit changes the Contact.
   * The frozen bank account (or its absence) is kept while the currency is unchanged and no
   * other account is given; the regime and treatments still come from the current Workspace and Contact.
   */
  readonly freeze?: {
    readonly contact?: ContactSnapshotRecord | undefined;
    readonly issuer: IssuerSnapshotRecord;
    /** The frozen document's currency: its bank account (or none) is kept in it. */
    readonly currency: CurrencyCode;
    /**
     * The issued tax results, kept while their inputs are unchanged: the regime and the rate
     * (`fx`) while the tax point, currency and manual rate are the same, and the whole-unit
     * payment rounding always.
     */
    readonly taxableSupplyOn: IsoDate | null;
    readonly fx: FxRecord | null;
    readonly fxOverride: FxOverride | null;
    readonly paymentRounding: PaymentRounding;
  };
}

export type ComposeError = Invalid | NotFound | StoreUnavailable | RatesUnavailable;
export type ComposeServices =
  | CurrentCaller
  | DocumentContacts
  | DocumentIssuers
  | NumberingSeries
  | ExchangeRates
  | IdGenerator;

const issue = (path: Issue["path"], code: Issue["code"], params?: Record<string, string>): Issue =>
  params ? { path, code, params } : { path, code };

const invalid = (issues: ReadonlyArray<Issue>) =>
  new Invalid({ issues: issues as [Issue, ...Array<Issue>] });

// Specs -------------------------------------------------------------------------------------

/** Expands `LineInput`s (Price List Item fill-in) into line specs. */
export const expandLines = (
  workspaceId: WorkspaceId,
  lines: ReadonlyArray<LineInput>,
): Effect.Effect<
  ReadonlyArray<LineSpec>,
  Invalid | NotFound | StoreUnavailable,
  DocumentPriceList
> =>
  Effect.gen(function* () {
    const priceList = yield* DocumentPriceList;
    const issues: Array<Issue> = [];
    const out: Array<LineSpec> = [];
    for (const [i, line] of lines.entries()) {
      const item =
        line.item === undefined ? null : yield* priceList.forLine(workspaceId, line.item);
      // Blank values fall back to the item (description, then name); a blank result is invalid.
      const description = [line.description, item?.description, item?.name]
        .map((d) => d?.trim())
        .find((d) => d !== undefined && d !== "");
      const unitPrice = line.unitPrice ?? item?.unitPrice;
      if (description === undefined)
        issues.push(
          issue(["lines", i, "description"], "request.malformed", { reason: "required" }),
        );
      if (unitPrice === undefined)
        issues.push(issue(["lines", i, "unitPrice"], "request.malformed", { reason: "required" }));
      if (description === undefined || unitPrice === undefined) continue;
      out.push({
        id: null,
        item: line.item ?? null,
        description,
        quantity: line.quantity ?? ONE,
        unit: line.unit ?? item?.unit ?? null,
        unitPrice,
        vat: line.vat ?? null,
        itemVat: item?.vat ?? null,
        itemPrice:
          line.unitPrice === undefined && item
            ? { currency: item.currency, net: item.unitPrice }
            : null,
        deducts: null,
      });
    }
    if (issues.length > 0) return yield* invalid(issues);
    return out;
  });

const definedOnly = <A extends object>(value: A): A =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as A;

/** The spec of a new document. */
export const specFromInput = (workspaceId: WorkspaceId, input: DocumentInput) =>
  Effect.map(
    expandLines(workspaceId, input.lines),
    (lines): DocumentSpec => ({
      kind: input.kind,
      contactId: input.contact,
      given: definedOnly({
        currency: input.currency,
        issuedOn: input.issuedOn,
        taxableSupplyOn: input.taxableSupplyOn,
        due: input.due,
        language: input.language,
        series: input.series,
        bankAccount: input.bankAccount,
        note: input.note,
        paymentMethod: input.paymentMethod,
        variableSymbol: input.variableSymbol,
      }),
      lines,
      pricesIncludeVat: input.pricesIncludeVat ?? false,
      orderNumber: input.orderNumber ?? null,
      fxOverride: input.fx ?? null,
    }),
  );

/** The spec a stored record was composed from (for recomputes). */
export const specFromRecord = (row: DocumentRecord): DocumentSpec => ({
  kind: row.kind,
  contactId: row.contactId,
  given: row.given,
  lines: row.lines.map((l) => ({
    id: l.id,
    item: l.item,
    description: l.description,
    quantity: l.quantity,
    unit: l.unit,
    unitPrice: l.unitPrice,
    vat: l.vat,
    itemVat: l.itemVat,
    itemPrice: l.itemPrice,
    deducts: l.deducts,
  })),
  pricesIncludeVat: row.pricesIncludeVat,
  orderNumber: row.orderNumber,
  fxOverride: row.fxOverride,
});

/** The fields of `DocumentPatch` that `applyPatch` handles (number/refreshParties are P2's). */
export const applyPatch = (workspaceId: WorkspaceId, spec: DocumentSpec, patch: DocumentPatch) =>
  Effect.gen(function* () {
    const lines =
      patch.lines === undefined ? spec.lines : yield* expandLines(workspaceId, patch.lines);
    const given: GivenFields = definedOnly({
      ...spec.given,
      currency: patch.currency ?? spec.given.currency,
      issuedOn: patch.issuedOn ?? spec.given.issuedOn,
      taxableSupplyOn: patch.taxableSupplyOn ?? spec.given.taxableSupplyOn,
      due: patch.due ?? spec.given.due,
      language: patch.language ?? spec.given.language,
      series: patch.series ?? spec.given.series,
      bankAccount: patch.bankAccount ?? spec.given.bankAccount,
      note: patch.note ?? spec.given.note,
      paymentMethod: patch.paymentMethod ?? spec.given.paymentMethod,
      variableSymbol: patch.variableSymbol ?? spec.given.variableSymbol,
    });
    return {
      ...spec,
      contactId: patch.contact ?? spec.contactId,
      given,
      lines,
      pricesIncludeVat: patch.pricesIncludeVat ?? spec.pricesIncludeVat,
      orderNumber: patch.orderNumber ?? spec.orderNumber,
      fxOverride: patch.fx === undefined ? spec.fxOverride : patch.fx,
    } satisfies DocumentSpec;
  });

// Rule D9 -----------------------------------------------------------------------------------

/** A caller's variable symbol (Czech payment reference) must be 1-10 digits. */
const isValidVariableSymbol = (vs: string): boolean => /^\d{1,10}$/.test(vs);

/** EU member states (ISO 3166-1 alpha-2, Greece as GR) other than CZ. */
const EU = new Set([
  "AT",
  "BE",
  "BG",
  "CY",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
]);

const countryOf = (contact: ContactForDocument) =>
  contact.party.address.country.trim().toUpperCase();
const isDomestic = (contact: ContactForDocument) => countryOf(contact) === "CZ";
const isOtherEu = (contact: ContactForDocument) => EU.has(countryOf(contact));
const hasVatId = (contact: ContactForDocument) => (contact.party.dic ?? "").trim() !== "";

/**
 * Default treatment (rule D9): vat_payer + domestic Contact → standard; vat_payer + EU
 * business Contact with a VAT ID → reverse_charge (services); everyone else → outside_scope.
 */
export const defaultTreatment = (regime: TaxRegime, contact: ContactForDocument): VatTreatment => {
  if (regime !== "vat_payer") return "outside_scope";
  if (isDomestic(contact)) return "standard";
  if (isOtherEu(contact) && hasVatId(contact)) return "reverse_charge";
  return "outside_scope";
};

/**
 * Treatment of one line: the caller's `vat`; else, for a vat_payer, the Price List Item's;
 * else the regime default. A non-payer never inherits a rated item treatment.
 */
const treatmentOf = (line: LineSpec, regime: TaxRegime, contact: ContactForDocument) =>
  line.vat ?? (regime === "vat_payer" ? line.itemVat : null) ?? defaultTreatment(regime, contact);

/**
 * Rule D9 checks: non_vat_payer (and identified_person on a domestic supply) accept only
 * outside_scope; identified_person may otherwise use only reverse_charge (services to another
 * EU state; interpretation to confirm with product/legal); exempt_intra_eu_goods (§64) is a
 * vat_payer's supply to a buyer in another EU state; reverse_charge and exempt_intra_eu_goods
 * need the buyer's VAT ID.
 */
const regimeIssues = (
  regime: TaxRegime,
  contact: ContactForDocument,
  treatments: ReadonlyArray<VatTreatment>,
): ReadonlyArray<Issue> =>
  treatments.flatMap((treatment, i): ReadonlyArray<Issue> => {
    const path = ["lines", i, "vat"];
    const allowed =
      regime === "vat_payer" ||
      treatment === "outside_scope" ||
      (regime === "identified_person" && isOtherEu(contact) && treatment === "reverse_charge");
    if (!allowed) return [issue(path, "vat.not_allowed_for_regime", { regime, treatment })];
    if (treatment === "exempt_intra_eu_goods" && !isOtherEu(contact)) {
      return [issue(path, "vat.not_allowed_for_regime", { regime, treatment })];
    }
    if (
      (treatment === "reverse_charge" || treatment === "exempt_intra_eu_goods") &&
      !hasVatId(contact)
    ) {
      return [issue(path, "document.buyer_vat_id_required")];
    }
    return [];
  });

/** Tax document (rule D6): a vat_payer's, or an identified_person's carrying VAT; never a Proforma. */
export const isTaxDocument = (
  kind: DocumentKind,
  regime: TaxRegime,
  treatments: ReadonlyArray<VatTreatment>,
) =>
  kind !== "proforma" &&
  (regime === "vat_payer" ||
    (regime === "identified_person" && treatments.some((t) => t !== "outside_scope")));

// Compose -----------------------------------------------------------------------------------

const pickBankAccount = (
  issuer: IssuerForDocument,
  currency: string,
  given: BankAccountId | undefined,
) => {
  if (given !== undefined) return issuer.bankAccounts.find((a) => a.id === given);
  const inCurrency = issuer.bankAccounts.filter((a) => a.currency === currency);
  return inCurrency.find((a) => a.isDefault) ?? inCurrency[0] ?? null;
};

const contactSnapshot = (contact: ContactForDocument): ContactSnapshotRecord => ({
  contactId: contact.party.contactId,
  name: contact.party.name,
  ico: contact.party.ico,
  dic: contact.party.dic,
  legalForm: contact.party.legalForm,
  address: contact.party.address,
  billingEmails: contact.billingEmails,
});

const sameOverride = (a: FxOverride | null, b: FxOverride | null) =>
  a === null || b === null
    ? a === b
    : BigDecimal.equals(a.manual.rate, b.manual.rate) && a.manual.quantity === b.manual.quantity;

const issuerSnapshot = (
  issuer: IssuerForDocument,
  bankAccount: BankAccountRecord | null,
): IssuerSnapshotRecord => ({ ...issuer.party, regime: issuer.regime, bankAccount });

export const compose = (
  workspaceId: WorkspaceId,
  spec: DocumentSpec,
  options: ComposeOptions,
): Effect.Effect<Composed, ComposeError, ComposeServices> =>
  Effect.gen(function* () {
    const { given, kind } = spec;
    const contact = yield* (yield* DocumentContacts).forDocument(workspaceId, spec.contactId);
    const issuedOn = given.issuedOn ?? options.today;
    // DocumentInput: default issuedOn, for every kind; it drives the VAT rate and CNB fixing.
    const taxableSupplyOn = given.taxableSupplyOn ?? issuedOn;
    const taxPoint = taxableSupplyOn;
    // NotFound{Workspace} (agreements #414/#418) passes through.
    const issuer = yield* (yield* DocumentIssuers).forDocument(workspaceId, taxPoint);
    const frozen = options.freeze;
    const samePoint = frozen !== undefined && frozen.taxableSupplyOn === taxPoint;
    // D10: an issued document's tax results follow its frozen parties, not live changes.
    const regime = samePoint ? frozen.issuer.regime : issuer.regime;
    const buyer: ContactForDocument =
      frozen?.contact === undefined
        ? contact
        : {
            ...contact,
            party: {
              contactId: frozen.contact.contactId,
              name: frozen.contact.name,
              ico: frozen.contact.ico,
              dic: frozen.contact.dic,
              legalForm: frozen.contact.legalForm,
              address: frozen.contact.address,
            },
          };

    const defaults = resolveDocumentDefaults({
      kind,
      document: {
        currency: given.currency,
        language: given.language,
        dueDays: given.due !== undefined && "inDays" in given.due ? given.due.inDays : undefined,
        paymentMethod: given.paymentMethod,
        series: given.series,
        note: given.note ?? undefined,
      },
      contact: contact.defaults,
      workspace: issuer.billing,
    });
    const currency = defaults.currency;

    const issues: Array<Issue> = [];
    const dueOn =
      given.due !== undefined && "on" in given.due
        ? given.due.on
        : addDays(issuedOn, defaults.dueDays);
    if (!isCalendarDate(dueOn) || dueOn > MAX_ISO_DATE) {
      // e.g. a huge `inDays`: the result must still be an IsoDate (four-digit year).
      issues.push(issue(["due"], "request.malformed", { reason: "out_of_range" }));
    } else if (dueOn < issuedOn) issues.push(issue(["due"], "document.due_before_issue"));

    const treatments = spec.lines.map((l) => treatmentOf(l, regime, buyer));
    issues.push(...regimeIssues(regime, buyer, treatments));
    spec.lines.forEach((l, i) => {
      // A price copied from the Price List is in the item's currency: it must match (also
      // after an edit changes the document currency); else the caller gives a unitPrice.
      if (l.itemPrice !== null && l.itemPrice.currency !== currency) {
        issues.push(
          issue(["lines", i, "unitPrice"], "request.malformed", {
            reason: "currency_mismatch",
            currency: l.itemPrice.currency,
          }),
        );
      }
    });
    if (spec.lines.length === 0) issues.push(issue(["lines"], "document.lines_required"));
    if (given.variableSymbol !== undefined && !isValidVariableSymbol(given.variableSymbol)) {
      issues.push(
        issue(["variableSymbol"], "request.malformed", { reason: "variable_symbol_invalid" }),
      );
    }
    if (issues.length > 0) return yield* invalid(issues);

    // Series: an explicit (Document or Contact) choice must be a series of this kind here.
    let seriesId: NumberingSeriesId | null = defaults.series;
    if (seriesId !== null && seriesId !== issuer.billing.seriesByKind[kind]) {
      const series = yield* (yield* NumberingSeries).resolve(workspaceId, kind, seriesId);
      seriesId = series.id;
    }

    const account =
      frozen !== undefined &&
      frozen.currency === currency &&
      (given.bankAccount === undefined || given.bankAccount === frozen.issuer.bankAccount?.id)
        ? frozen.issuer.bankAccount === null
          ? null
          : { ...frozen.issuer.bankAccount, isDefault: false }
        : pickBankAccount(issuer, currency, given.bankAccount);
    if (account === undefined) {
      return yield* new NotFound({ entity: "BankAccount", id: given.bankAccount ?? "" });
    }
    const bankAccount: BankAccountRecord | null =
      account === null
        ? null
        : {
            id: account.id,
            name: account.name,
            currency: account.currency,
            accountNumber: account.accountNumber,
            iban: account.iban,
            bic: account.bic,
          };

    // Rule D11: manual rate, else the CNB fixing valid on the tax point (carried back).
    let fx: FxRecord | null;
    if (
      samePoint &&
      frozen.currency === currency &&
      sameOverride(frozen.fxOverride, spec.fxOverride)
    ) {
      fx = frozen.fx;
    } else {
      const fixing = Fx.needsFixing(currency, spec.fxOverride)
        ? yield* (yield* ExchangeRates).fixing(taxPoint)
        : null;
      const fxResult = Fx.resolve({ currency, override: spec.fxOverride, fixing });
      if (Result.isFailure(fxResult)) return yield* fxResult.failure;
      fx = fxResult.success;
    }
    const paymentRounding = frozen?.paymentRounding ?? issuer.paymentRounding;

    // A Price List price is net (excl. VAT): with pricesIncludeVat it is grossed up at the
    // line's rate, so the top-down math (§37(b)) sees a gross unit price.
    const unitPrices = spec.lines.map((l, i) => {
      if (l.itemPrice === null) return l.unitPrice;
      if (!spec.pricesIncludeVat) return l.itemPrice.net;
      const rate = VatMath.rateFor(treatments[i] ?? "outside_scope", taxPoint);
      return BigDecimal.normalize(
        BigDecimal.divideUnsafe(
          BigDecimal.multiply(l.itemPrice.net, BigDecimal.sum(HUNDRED, rate)),
          HUNDRED,
        ),
      );
    });
    const totals = VatMath.calculate({
      lines: spec.lines.map((l, i) => ({
        quantity: l.quantity,
        unitPrice: unitPrices[i] ?? l.unitPrice,
        treatment: treatments[i] ?? "outside_scope",
      })),
      currency,
      taxPoint,
      pricesIncludeVat: spec.pricesIncludeVat,
      fx,
      paymentRounding,
    });

    const ids = yield* IdGenerator;
    const lines: Array<LineRecord> = [];
    for (const [i, l] of spec.lines.entries()) {
      const treatment = treatments[i] ?? "outside_scope";
      const unitPrice = unitPrices[i] ?? l.unitPrice;
      lines.push({
        id: l.id ?? ((yield* ids.next) as LineId),
        item: l.item,
        description: l.description,
        quantity: l.quantity,
        unit: l.unit,
        unitPrice,
        itemPrice: l.itemPrice,
        vat: l.vat,
        itemVat: l.itemVat,
        treatment,
        ratePercent: VatMath.rateFor(treatment, taxPoint),
        amount: BigDecimal.normalize(BigDecimal.multiply(l.quantity, unitPrice)),
        deducts: l.deducts,
      });
    }

    return {
      kind,
      contactId: spec.contactId,
      contact: options.freeze?.contact ?? contactSnapshot(contact),
      issuer: options.freeze
        ? { ...options.freeze.issuer, regime, bankAccount }
        : issuerSnapshot(issuer, bankAccount),
      given,
      seriesId,
      currency,
      language: defaults.language,
      paymentMethod: defaults.paymentMethod,
      note: given.note === null ? null : defaults.note,
      issuedOn,
      taxableSupplyOn,
      dueOn,
      pricesIncludeVat: spec.pricesIncludeVat,
      variableSymbol: given.variableSymbol ?? null,
      orderNumber: spec.orderNumber,
      lines,
      totals,
      fx,
      fxOverride: spec.fxOverride,
      taxDocument: isTaxDocument(kind, regime, treatments),
      paymentRounding,
    };
  });
