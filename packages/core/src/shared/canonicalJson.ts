/** Deterministic JSON for fingerprints. Object keys are sorted and undefined members omitted. */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as EffectRecord from "effect/Record";
import * as Schema from "effect/Schema";

const encodeString = Schema.encodeOption(Schema.fromJsonString(Schema.String));
const quote = (value: string): string => Option.getOrThrow(encodeString(value));

class NonFiniteFingerprint extends Schema.TaggedError<
  NonFiniteFingerprint,
  { readonly brand: unique symbol }
>()("NonFiniteFingerprint", { value: Schema.String }) {
  override get message(): string {
    return `canonicalJson: non-finite number ${this.value}`;
  }
}

export const canonicalJson = <A>(value: A): string => {
  if (Predicate.isString(value)) return quote(value);
  if (Predicate.isBigInt(value)) return quote(value.toString());
  if (Predicate.isBoolean(value)) return value === true ? "true" : "false";
  if (Predicate.isNumber(value)) {
    return Number.isFinite(value)
      ? String(value)
      : Option.getOrThrowWith(Option.none<string>(), () =>
          NonFiniteFingerprint.make({ value: String(value) }),
        );
  }
  if (Arr.isArray(value)) {
    return `[${Arr.join(
      Arr.map(value, (item, index) => (index in value ? canonicalJson(item) : "")),
      ",",
    )}]`;
  }
  if (!Predicate.isObject(value) || Predicate.isFunction(value)) return "null";
  const entries = Arr.filter(EffectRecord.toEntries(value), ([, item]) => item !== undefined);
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${Arr.join(
    Arr.map(entries, ([key, item]) => `${quote(key)}:${canonicalJson(item)}`),
    ",",
  )}}`;
};
