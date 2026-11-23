import type { Locale } from "../locale";
import type { AnyMessage } from "../types";
import { cs } from "./cs";
import { type EnCatalog, en } from "./en";

export { cs } from "./cs";
export { type EnCatalog, en, enSections } from "./en";

/** Closed union of every catalog key; `en` is the source of truth. */
export type MessageKey = keyof EnCatalog;

export const catalogs: Readonly<Record<Locale, Readonly<Record<MessageKey, AnyMessage>>>> = {
  en,
  cs,
};

export const MESSAGE_KEYS = Object.keys(en) as ReadonlyArray<MessageKey>;

const keySet: ReadonlySet<string> = new Set(MESSAGE_KEYS);

export const isMessageKey = (key: string): key is MessageKey => keySet.has(key);
