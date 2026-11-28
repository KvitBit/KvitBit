/**
 * Formats BigDecimal values inside open view fields before HttpApiBuilder encodes the response.
 * Closed schema fields keep their decoded values for the schema's own JSON codec.
 */
import {
  PaymentView,
  type PriceListItemView,
  ReportView,
  type TemplateView,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";

const normalizer = (keepUndefined: boolean) => {
  const fields = <A>(object: Readonly<Record<string, A>>) => {
    const entries = Record.toEntries(object);
    const present = keepUndefined
      ? entries
      : Arr.filter(entries, ([, field]) => field !== undefined);
    return Record.fromEntries(Arr.map(present, ([key, field]) => [key, value(field)] as const));
  };

  const value = <A>(input: A): unknown => {
    if (BigDecimal.isBigDecimal(input)) return BigDecimal.format(input);
    if (Arr.isArray(input)) return Arr.map(input, value);
    if (Predicate.isObject(input)) return fields(input);
    return input;
  };

  return { fields, value };
};

const records = normalizer(false);
export const documentJsonValue = normalizer(true).value;

export const jsonizePayment = (payment: PaymentView): PaymentView =>
  PaymentView.make(records.value(payment));

export const jsonizeReport = (report: ReportView): ReportView =>
  ReportView.make(records.value(report));

export const jsonizePriceListItem = (item: PriceListItemView): PriceListItemView => ({
  ...records.fields(item),
  revision: item.revision,
});

export const jsonizeTemplate = (template: TemplateView): TemplateView => ({
  ...records.fields(template),
  revision: template.revision,
  schedule:
    template.schedule === null
      ? null
      : { ...records.fields(template.schedule), pausedReason: template.schedule.pausedReason },
});
