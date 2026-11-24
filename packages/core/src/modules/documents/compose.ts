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
  VatBucket,
  VatTreatment,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import { Invalid, NotFound } from "@kvitbit/domain/contract";
import { ExchangeRates, type RatesUnavailable } from "@kvitbit/domain/ports";
import { BigDecimal, Effect, Result } from "effect";
import { addDays, isCalendarDate, MAX_ISO_DATE } from "../../engines/calendar";
import { HUNDRED, ZERO } from "../../engines/decimal";
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
  /** A Final Invoice deduction line (rule D8); null on every other line. */
  readonly deduction: Deduction | null;
}

/**
 * What a Final Invoice deduction line deducts, as stored on the deducted document (negative
 * amounts, its currency, treatment and rate): `compose` never recomputes it. A Payment Tax
 * Document bucket carries its VAT and CZK VAT; outside `vat_payer` the paid amount is one
 * `outside_scope` deduction with zero VAT.
 */
export interface Deduction {
  readonly currency: CurrencyCode;
  readonly treatment: VatTreatment;
  readonly ratePercent: BigDecimal.BigDecimal;
  readonly base: BigDecimal.BigDecimal;
  readonly vat: BigDecimal.BigDecimal;
  readonly vatCzk: BigDecimal.BigDecimal | null;
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
   * An issued document's frozen values (rule D10). Printed particulars: `contact` / `issuer`
   * snapshots are kept when given (left out for a new Contact or `refreshParties`); the bank
   * account (`bankAccount`, null = none) is kept while the currency is unchanged and no other
   * account is given (left out = pick afresh). Tax results are kept whatever the parties:
   * the regime and the rate (`fx`) while the tax point, currency and manual rate are the same,
   * and the whole-unit payment rounding always. VAT checks use the kept buyer.
   */
  readonly freeze?: {
    readonly contact?: ContactSnapshotRecord | undefined;
    readonly issuer?: IssuerSnapshotRecord | undefined;
    readonly bankAccount?: BankAccountRecord | null | undefined;
    readonly currency: CurrencyCode;
    readonly taxableSupplyOn: IsoDate | null;
    readonly regime: TaxRegime;
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
        deduction: null,
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
    deduction:
      l.deducts === null
        ? null
        : {
            currency: row.currency,
            treatment: l.treatment,
            ratePercent: l.ratePercent,
            // The stored amount is gross when prices include VAT.
            base: row.pricesIncludeVat
              ? BigDecimal.normalize(BigDecimal.subtract(l.amount, l.deductedVat ?? ZERO))
              : l.amount,
            vat: l.deductedVat ?? ZERO,
            vatCzk: l.deductedVatCzk,
          },
  })),
  pricesIncludeVat: row.pricesIncludeVat,
  orderNumber: row.orderNumber,
  fxOverride: row.fxOverride,
});

/** The fields of `DocumentPatch` that `applyPatch` handles (number/refreshParties are P2's). */
export const applyPatch = (workspaceId: WorkspaceId, spec: DocumentSpec, patch: DocumentPatch) =>
  Effect.gen(function* () {
    // A Final Invoice keeps its deduction lines (D8) whatever lines the patch gives.
    const lines =
      patch.lines === undefined
        ? spec.lines
        : [
            ...(yield* expandLines(workspaceId, patch.lines)),
            ...spec.lines.filter((l) => l.deduction !== null),
          ];
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

const bucketKey = (b: Pick<VatBucket, "treatment" | "ratePercent">) =>
  `${b.treatment}|${BigDecimal.format(BigDecimal.normalize(b.ratePercent))}`;

const addOpt = (a: BigDecimal.BigDecimal | null, b: BigDecimal.BigDecimal | null) =>
  a === null ? b : b === null ? a : BigDecimal.normalize(BigDecimal.sum(a, b));

/** Sums buckets per (treatment, rate), first-seen order. */
export const mergeBuckets = (
  ...lists: ReadonlyArray<ReadonlyArray<VatBucket>>
): ReadonlyArray<VatBucket> => {
  const byKey = new Map<string, VatBucket>();
  for (const b of lists.flat()) {
    const key = bucketKey(b);
    const prev = byKey.get(key);
    byKey.set(
      key,
      prev === undefined
        ? b
        : {
            ...prev,
            base: BigDecimal.normalize(BigDecimal.sum(prev.base, b.base)),
            vat: BigDecimal.normalize(BigDecimal.sum(prev.vat, b.vat)),
            gross: BigDecimal.normalize(BigDecimal.sum(prev.gross, b.gross)),
            vatCzk: addOpt(prev.vatCzk, b.vatCzk),
          },
    );
  }
  return [...byKey.values()];
};

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
    const regime = samePoint ? frozen.regime : issuer.regime;
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

    // Deduction lines keep the deducted document's treatment and rate (D8): no D9 checks.
    const treatments = spec.lines.map(
      (l) => l.deduction?.treatment ?? treatmentOf(l, regime, buyer),
    );
    const supplyTreatments = treatments.filter((_, i) => spec.lines[i]?.deduction === null);
    issues.push(...regimeIssues(regime, buyer, supplyTreatments));
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
    spec.lines.forEach((l) => {
      // Deducted amounts are in the deducted document's currency.
      if (l.deduction !== null && l.deduction.currency !== currency) {
        issues.push(
          issue(["currency"], "request.malformed", {
            reason: "currency_mismatch",
            currency: l.deduction.currency,
          }),
        );
      }
    });
    if (supplyTreatments.length === 0) issues.push(issue(["lines"], "document.lines_required"));
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

    const kept = frozen?.bankAccount;
    const account =
      kept !== undefined &&
      frozen?.currency === currency &&
      (given.bankAccount === undefined || given.bankAccount === kept?.id)
        ? kept === null
          ? null
          : { ...kept, isDefault: false }
        : pickBankAccount(issuer, currency, given.bankAccount);
    if (account === undefined) {
      return yield* new NotFound({ entity: "BankAccount", id: given.bankAccount ?? "" });
    }
    // Payments go to an account in the document currency.
    if (account !== null && account.currency !== currency) {
      return yield* invalid([
        issue(["bankAccount"], "request.malformed", {
          reason: "currency_mismatch",
          currency: account.currency,
        }),
      ]);
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
      // A deduction line prints quantity -1 at the deducted base (gross with VAT-inclusive prices).
      if (l.deduction !== null) {
        return BigDecimal.normalize(
          BigDecimal.negate(
            spec.pricesIncludeVat
              ? BigDecimal.sum(l.deduction.base, l.deduction.vat)
              : l.deduction.base,
          ),
        );
      }
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
    const supply = spec.lines.flatMap((l, i) =>
      l.deduction === null
        ? [
            {
              quantity: l.quantity,
              unitPrice: unitPrices[i] ?? l.unitPrice,
              treatment: treatments[i] ?? "outside_scope",
            },
          ]
        : [],
    );
    const deductions = spec.lines.flatMap((l) => (l.deduction === null ? [] : [l.deduction]));
    const calculated = VatMath.calculate({
      lines: supply,
      currency,
      taxPoint,
      pricesIncludeVat: spec.pricesIncludeVat,
      fx,
      paymentRounding,
    });
    // D8: the deducted buckets are added as stored, so VAT already declared on a Payment Tax
    // Document (at its own rate and CZK fixing) is subtracted exactly, never re-derived.
    const totals =
      deductions.length === 0
        ? calculated
        : VatMath.fromBuckets(
            mergeBuckets(
              calculated.buckets,
              deductions.map((d) => ({
                treatment: d.treatment,
                ratePercent: d.ratePercent,
                base: d.base,
                vat: d.vat,
                gross: BigDecimal.normalize(BigDecimal.sum(d.base, d.vat)),
                vatCzk: currency === "CZK" ? null : d.vatCzk,
              })),
            ),
            currency,
            paymentRounding,
          );

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
        ratePercent: l.deduction?.ratePercent ?? VatMath.rateFor(treatment, taxPoint),
        amount: BigDecimal.normalize(BigDecimal.multiply(l.quantity, unitPrice)),
        deducts: l.deducts,
        deductedVat: l.deduction?.vat ?? null,
        deductedVatCzk: l.deduction?.vatCzk ?? null,
      });
    }

    return {
      kind,
      contactId: spec.contactId,
      contact: options.freeze?.contact ?? contactSnapshot(contact),
      issuer: { ...(frozen?.issuer ?? issuer.party), regime, bankAccount },
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
      taxDocument: isTaxDocument(kind, regime, supplyTreatments),
      paymentRounding,
    };
  });
