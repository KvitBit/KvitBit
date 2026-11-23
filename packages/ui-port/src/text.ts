/**
 * Render-ready copy descriptor shared by every ui-port area. Presenters and error
 * mappers emit `Text`, never strings; adapters resolve it through the i18n catalogs.
 * Keys follow the catalog's dotted MessageKey spelling (`issue.<IssueCode>` for issues).
 */
export type TextParam = string | number;

export interface Text<K extends string = string> {
  readonly key: K;
  readonly params?: Readonly<Record<string, TextParam>>;
}

export const text = <K extends string>(
  key: K,
  params?: Readonly<Record<string, TextParam>>,
): Text<K> => (params === undefined ? { key } : { key, params });
