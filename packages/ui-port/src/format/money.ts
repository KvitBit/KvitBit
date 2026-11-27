import { CurrencyCode, MoneyMath } from "@kvitbit/domain/contract";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import type { Locale } from "../i18n/locale";
import { type DecimalInput, formatExact, roundedDecimal, type Sign, signOf } from "./number";

export interface MoneyInput {
  readonly amount: DecimalInput;
  readonly currency: CurrencyCode | string;
}

export interface MoneyOptions {
  /** Fraction digits; default the currency's minor-unit scale (2 for CZK and EUR). */
  readonly scale?: number;
  /** Show `+` on positive amounts (deltas, differences). */
  readonly signed?: boolean;
}

/**
 * Locale money text, Intl only: cs `1 234,50 Kč`, en `CZK 1,234.50`, en `€1,234.50`.
 * Grouping uses NBSP in cs. Digits are exact for any decimal size (no float conversion). The
 * scale is the display scale (the currency's minor-unit scale unless overridden): amounts arrive
 * already rounded per bucket; a value with more decimals is rounded half away from zero for
 * display only, the same rule Intl applies.
 */
export const formatMoney: {
  (money: MoneyInput, options?: MoneyOptions): (locale: Locale) => string;
  (locale: Locale, money: MoneyInput, options?: MoneyOptions): string;
} = Fn.dual(
  (args) => Predicate.isString(args[0]),
  (locale: Locale, money: MoneyInput, options: MoneyOptions = {}): string => {
    const currency = Str.toUpperCase(money.currency);
    const scale = options.scale ?? currencyScale(currency);
    const shown = roundedDecimal(money.amount, scale, scale);
    const sign = signOf(shown);
    return formatExact(locale, shown, {
      style: "currency",
      currency,
      currencyDisplay: "symbol",
      minimumFractionDigits: scale,
      maximumFractionDigits: scale,
      signDisplay: options.signed === true && sign !== "zero" ? "always" : "auto",
    });
  },
);

const currencyScale = (currency: string): number =>
  CurrencyCode.makeOption(currency).pipe(
    Option.map(MoneyMath.minorUnitScale),
    Option.getOrElse(() => 2),
  );

/** Render-ready money: the spec's `MoneyVM` shape (section 2.12). */
export interface MoneyDisplay {
  readonly text: string;
  readonly sign: Sign;
  /** Adapters set `font-variant-numeric: tabular-nums` / `fontVariant: ["tabular-nums"]`. */
  readonly tabular: true;
  readonly currency: string;
}

/** Sign of the amount as displayed (an amount that rounds to zero is "zero"). */
const displayedSign = (money: MoneyInput, options: MoneyOptions): Sign => {
  const scale = options.scale ?? currencyScale(Str.toUpperCase(money.currency));
  return signOf(roundedDecimal(money.amount, scale, scale));
};

export const moneyDisplay: {
  (money: MoneyInput, options?: MoneyOptions): (locale: Locale) => MoneyDisplay;
  (locale: Locale, money: MoneyInput, options?: MoneyOptions): MoneyDisplay;
} = Fn.dual(
  (args) => Predicate.isString(args[0]),
  (locale: Locale, money: MoneyInput, options: MoneyOptions = {}): MoneyDisplay => ({
    text: formatMoney(locale, money, options),
    sign: displayedSign(money, options),
    tabular: true,
    currency: Str.toUpperCase(money.currency),
  }),
);
