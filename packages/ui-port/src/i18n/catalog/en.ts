import { app } from "./en/app";
import { auth } from "./en/auth";
import { common } from "./en/common";
import { documents } from "./en/documents";
import { enums } from "./en/enums";
import { errors } from "./en/errors";
import { issues } from "./en/issues";
import { publicScreens } from "./en/public";
import { records } from "./en/records";
import { settings } from "./en/settings";

/** English catalog: the source of truth for `MessageKey`. */
export const en = {
  ...common,
  ...errors,
  ...issues,
  ...enums,
  ...publicScreens,
  ...auth,
  ...app,
  ...documents,
  ...records,
  ...settings,
} as const;

export type EnCatalog = typeof en;

/** The sections `en` is spread from, so tests can prove no key is defined twice. */
export const enSections = {
  common,
  errors,
  issues,
  enums,
  publicScreens,
  auth,
  app,
  documents,
  records,
  settings,
} as const;
