import type { CsSection } from "../types";
import { app } from "./cs/app";
import { auth } from "./cs/auth";
import { common } from "./cs/common";
import { documents } from "./cs/documents";
import { enums } from "./cs/enums";
import { errors } from "./cs/errors";
import { issues } from "./cs/issues";
import { publicScreens } from "./cs/public";
import { records } from "./cs/records";
import { settings } from "./cs/settings";
import type { EnCatalog } from "./en";

/** Czech catalog: exactly the keys of `en` (checked per section and as a whole). */
export const cs = {
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
} as const satisfies CsSection<EnCatalog>;
