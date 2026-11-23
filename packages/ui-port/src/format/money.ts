import { type CurrencyCode, MoneyMath } from "@kvitbit/domain/contract";
import type { Locale } from "../i18n/locale";
import { type DecimalInput, numberFormat, type Sign, signOf, toDecimalString } from "./number";

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
 * Grouping uses NBSP in cs. The scale is the display scale: amounts arrive already rounded per
 * bucket, so a wire value with more decimals is a server bug, not something to hide.
 */
export const formatMoney = (
  locale: Locale,
  money: MoneyInput,
  options: MoneyOptions = {},
): string => {
  const currency = money.currency.toUpperCase();
  const scale = options.scale ?? MoneyMath.minorUnitScale(currency as CurrencyCode);
  const sign = signOf(money.amount);
  const raw = toDecimalString(money.amount);
  return numberFormat(locale, {
    style: "currency",
    currency,
    currencyDisplay: "symbol",
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
    signDisplay: options.signed === true && sign !== "zero" ? "always" : "auto",
  }).format(sign === "zero" ? "0" : raw);
};

/** Render-ready money: the spec's `MoneyVM` shape (section 2.12). */
export interface MoneyDisplay {
  readonly text: string;
  readonly sign: Sign;
  /** Adapters set `font-variant-numeric: tabular-nums` / `fontVariant: ["tabular-nums"]`. */
  readonly tabular: true;
  readonly currency: string;
}

export const moneyDisplay = (
  locale: Locale,
  money: MoneyInput,
  options: MoneyOptions = {},
): MoneyDisplay => ({
  text: formatMoney(locale, money, options),
  sign: signOf(money.amount),
  tabular: true,
  currency: money.currency.toUpperCase(),
});
