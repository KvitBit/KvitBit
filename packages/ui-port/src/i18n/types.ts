import type { TextParam } from "../text";

/** English plural message: forms selected by `Intl.PluralRules("en")`. */
export interface EnPlural {
  readonly one: string;
  readonly other: string;
}

/** Czech plural message: 1 one, 2-4 few, fractions many, otherwise other. */
export interface CsPlural {
  readonly one: string;
  readonly few: string;
  readonly many: string;
  readonly other: string;
}

export type EnMessage = string | EnPlural;
export type CsMessage = string | CsPlural;
export type AnyMessage = string | Partial<Record<Intl.LDMLPluralRule, string>>;

/** Shape every `en` catalog section satisfies. */
export interface EnSection {
  readonly [key: string]: EnMessage;
}

/** The Czech section must have exactly the keys of its English source, plural where it is plural. */
export type CsSection<E extends EnSection> = {
  readonly [K in keyof E]: E[K] extends string ? string : CsPlural;
};

/** `{name}` placeholder names in a template literal type. */
export type Placeholders<S> = S extends `${string}{${infer P}}${infer R}`
  ? P | Placeholders<R>
  : never;

/** Placeholder names of a message; plurals also take `count`. */
export type ParamNames<M> = M extends string
  ? Placeholders<M>
  : M extends EnPlural
    ? Placeholders<M["one"]> | Placeholders<M["other"]> | "count"
    : never;

export type ParamsOf<M> = {
  readonly [P in ParamNames<M>]: P extends "count" ? number : TextParam;
};
