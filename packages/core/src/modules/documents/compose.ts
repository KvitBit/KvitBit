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
import { addDays } from "../../engines/calendar";
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
  GivenFields,
  IssuerSnapshotRecord,
  LineRecord,
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
  /** Currency of a unit price copied from a Price List Item (must match the document's). */
  readonly priceCurrency: string | null;
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

/**
 * How a missing referenced record (Contact, Price List Item, bank account, series) fails:
 * `NotFound` for stored writes, `Invalid` at the field's path for `preview` (whose signature
 * has no NotFound).
 */
export type MissingAs = "notFound" | "invalid";

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
>;

export interface ComposeOptions {
  /** Prague today (default for `issuedOn`). */
  readonly today: IsoDate;
  readonly missing: MissingAs;
  /**
   * Printed particulars to keep instead of fresh snapshots (rule D10: an issued document keeps
   * them unless `refreshParties`). Defaults, regime and bank accounts still come from the
   * current Contact and Workspace.
   */
  readonly freeze?: {
    readonly contact: ContactSnapshotRecord;
    readonly issuer: IssuerSnapshotRecord;
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

/** Maps `NotFound` to `Invalid{request.malformed}` at `path` when `missing` is "invalid". */
const orMissing =
  (missing: MissingAs, path: Issue["path"]) =>
  <A, E, R>(
    effect: Effect.Effect<A, E | NotFound, R>,
  ): Effect.Effect<A, E | NotFound | Invalid, R> =>
    missing === "notFound"
      ? effect
      : (Effect.catchTag(effect as Effect.Effect<A, NotFound, R>, "NotFound", () =>
          Effect.fail(invalid([issue(path, "request.malformed")])),
        ) as Effect.Effect<A, E | Invalid, R>);

// Specs -------------------------------------------------------------------------------------

/** Expands `LineInput`s (Price List Item fill-in) into line specs. */
export const expandLines = (
  workspaceId: WorkspaceId,
  lines: ReadonlyArray<LineInput>,
  missing: MissingAs,
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
        line.item === undefined
          ? null
          : yield* orMissing(missing, ["lines", i, "item"])(
              priceList.forLine(workspaceId, line.item),
            );
      // Blank values fall back to the item (description, then name); a blank result is invalid.
      const description = [line.description, item?.description, item?.name]
        .map((d) => d?.trim())
        .find((d) => d !== undefined && d !== "");
      const unitPrice = line.unitPrice ?? item?.unitPrice;
      if (description === undefined)
        issues.push(issue(["lines", i, "description"], "request.malformed"));
      if (unitPrice === undefined)
        issues.push(issue(["lines", i, "unitPrice"], "request.malformed"));
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
        priceCurrency: line.unitPrice === undefined && item ? item.currency : null,
        deducts: null,
      });
    }
    if (issues.length > 0) return yield* invalid(issues);
    return out;
  });

const definedOnly = <A extends object>(value: A): A =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as A;

/** The spec of a new document. */
export const specFromInput = (workspaceId: WorkspaceId, input: DocumentInput, missing: MissingAs) =>
  Effect.map(
    expandLines(workspaceId, input.lines, missing),
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
    priceCurrency: null,
    deducts: l.deducts,
  })),
  pricesIncludeVat: row.pricesIncludeVat,
  orderNumber: row.orderNumber,
  fxOverride: row.fxOverride,
});

/** The fields of `DocumentPatch` that `applyPatch` handles (number/refreshParties are P2's). */
export const applyPatch = (
  workspaceId: WorkspaceId,
  spec: DocumentSpec,
  patch: DocumentPatch,
  missing: MissingAs,
) =>
  Effect.gen(function* () {
    const lines =
      patch.lines === undefined
        ? spec.lines
        : yield* expandLines(workspaceId, patch.lines, missing);
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
      (regime === "identified_person" && !isDomestic(contact) && treatment === "reverse_charge");
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
    const missing = options.missing;
    const contact = yield* orMissing(missing, ["contact"])(
      (yield* DocumentContacts).forDocument(workspaceId, spec.contactId),
    );
    const issuedOn = given.issuedOn ?? options.today;
    // A Proforma is never a tax document: no tax point unless the caller set one.
    const taxableSupplyOn = given.taxableSupplyOn ?? (kind === "proforma" ? null : issuedOn);
    const taxPoint = taxableSupplyOn ?? issuedOn;
    // The caller's own Workspace always exists; a miss is a broken caller (defect).
    const issuer = yield* Effect.catchTag(
      (yield* DocumentIssuers).forDocument(workspaceId, taxPoint),
      "NotFound",
      (e) => Effect.die(e),
    );

    const defaults = resolveDocumentDefaults({
      kind,
      document: {
        currency: given.currency,
        language: given.language,
        dueDays: given.due !== undefined && "inDays" in given.due ? given.due.inDays : undefined,
        paymentMethod: given.paymentMethod,
        series: given.series,
        note: given.note,
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
    if (dueOn < issuedOn) issues.push(issue(["due"], "document.due_before_issue"));

    const treatments = spec.lines.map((l) => treatmentOf(l, issuer.regime, contact));
    issues.push(...regimeIssues(issuer.regime, contact, treatments));
    spec.lines.forEach((l, i) => {
      if (l.priceCurrency !== null && l.priceCurrency !== currency) {
        issues.push(
          issue(["lines", i, "unitPrice"], "request.malformed", { currency: l.priceCurrency }),
        );
      }
    });
    if (spec.lines.length === 0) issues.push(issue(["lines"], "document.lines_required"));
    if (issues.length > 0) return yield* invalid(issues);

    // Series: an explicit (Document or Contact) choice must be a series of this kind here.
    let seriesId: NumberingSeriesId | null = defaults.series;
    if (seriesId !== null && seriesId !== issuer.billing.seriesByKind[kind]) {
      const series = yield* orMissing(missing, ["series"])(
        (yield* NumberingSeries).resolve(workspaceId, kind, seriesId),
      );
      seriesId = series.id;
    }

    const account = pickBankAccount(issuer, currency, given.bankAccount);
    if (account === undefined) {
      return yield* orMissing(missing, ["bankAccount"])(
        Effect.fail(new NotFound({ entity: "BankAccount", id: given.bankAccount ?? "" })),
      );
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
    const fixing = Fx.needsFixing(currency, spec.fxOverride)
      ? yield* (yield* ExchangeRates).fixing(taxPoint)
      : null;
    const fxResult = Fx.resolve({ currency, override: spec.fxOverride, fixing });
    if (Result.isFailure(fxResult)) return yield* fxResult.failure;
    const fx = fxResult.success;

    const totals = VatMath.calculate({
      lines: spec.lines.map((l, i) => ({
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        treatment: treatments[i] ?? "outside_scope",
      })),
      currency,
      taxPoint,
      pricesIncludeVat: spec.pricesIncludeVat,
      fx,
      paymentRounding: issuer.paymentRounding,
    });

    const ids = yield* IdGenerator;
    const lines: Array<LineRecord> = [];
    for (const [i, l] of spec.lines.entries()) {
      const treatment = treatments[i] ?? "outside_scope";
      lines.push({
        id: l.id ?? ((yield* ids.next) as LineId),
        item: l.item,
        description: l.description,
        quantity: l.quantity,
        unit: l.unit,
        unitPrice: l.unitPrice,
        vat: l.vat,
        itemVat: l.itemVat,
        treatment,
        ratePercent: VatMath.rateFor(treatment, taxPoint),
        amount: BigDecimal.normalize(BigDecimal.multiply(l.quantity, l.unitPrice)),
        deducts: l.deducts,
      });
    }

    return {
      kind,
      contactId: spec.contactId,
      contact: options.freeze?.contact ?? contactSnapshot(contact),
      issuer: options.freeze
        ? { ...options.freeze.issuer, regime: issuer.regime, bankAccount }
        : issuerSnapshot(issuer, bankAccount),
      given,
      seriesId,
      currency,
      language: defaults.language,
      paymentMethod: defaults.paymentMethod,
      note: defaults.note,
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
      taxDocument: isTaxDocument(kind, issuer.regime, treatments),
    };
  });
