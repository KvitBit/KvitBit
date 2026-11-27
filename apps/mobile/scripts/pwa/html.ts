import * as EffectArray from "effect/Array";
import * as Fn from "effect/Function";
import * as EffectString from "effect/String";
import { jsonLiteral } from "./json";
import { APP_BASE, appleTouchIcon } from "./manifest";

const closingHead = /<\/head>/i;
const assetReference = /\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const THEME_COLOR = /<meta\s+name=["']theme-color["'][^>]*>\s*/gi;

/** Registers the worker only where it is served: the export under `/app/`, not `expo start`. */
const serviceWorkerRegistration = `<script>
if ("serviceWorker" in navigator && location.pathname.startsWith(${jsonLiteral(APP_BASE)})) {
  addEventListener("load", () => {
    navigator.serviceWorker.register(${jsonLiteral(`${APP_BASE}sw.js`)}, { scope: ${jsonLiteral(APP_BASE)} }).catch(() => {});
  });
}
</script>`;

/**
 * Adds the manifest link, one theme-color meta (replacing Expo's), the
 * apple-touch-icon and the worker registration to the exported shell.
 * Throws when the shell has no `</head>` or is already injected.
 */
interface PwaHeadOptions {
  readonly themeColor: string;
}

export const injectPwaHead: {
  (options: PwaHeadOptions): (html: string) => string;
  (html: string, options: PwaHeadOptions): string;
} = Fn.dual(2, (html: string, { themeColor }: PwaHeadOptions): string => {
  if (EffectString.includes('rel="manifest"')(html))
    throw new Error("index.html already links a manifest");
  const close = closingHead.exec(html)?.index;
  if (close === undefined) throw new Error("index.html has no </head>");
  const head = EffectArray.join(
    [
      `<meta name="theme-color" content="${themeColor}">`,
      `<link rel="manifest" href="${APP_BASE}manifest.webmanifest">`,
      `<link rel="apple-touch-icon" href="${APP_BASE}icons/${appleTouchIcon}">`,
      serviceWorkerRegistration,
    ],
    "\n",
  );
  const before = EffectString.replace(THEME_COLOR, "")(EffectString.slice(0, close)(html));
  return `${before}${head}\n${EffectString.slice(close)(html)}`;
});

/** Every `src=` / `href=` value in the document, in order. */
export const assetUrls = (html: string): ReadonlyArray<string> =>
  EffectArray.map(
    [...EffectString.matchAll(assetReference)(html)],
    (match) => match[1] ?? match[2] ?? "",
  );

/** URLs that would not load from the `/app/` mount: anything outside it, including cross-origin ones. */
export const urlsOutsideBase = (html: string): ReadonlyArray<string> =>
  EffectArray.filter(
    assetUrls(html),
    (url) => !(EffectString.startsWith(APP_BASE)(url) || EffectString.startsWith("data:")(url)),
  );

/** Hashed bundle URLs the shell loads, for the worker's precache list. */
export const staticAssetUrls = (html: string): ReadonlyArray<string> => [
  ...new Set(
    EffectArray.filter(assetUrls(html), (url) =>
      EffectString.startsWith(`${APP_BASE}_expo/static/`)(url),
    ),
  ),
];
