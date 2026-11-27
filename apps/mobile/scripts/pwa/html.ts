import { APP_BASE, appleTouchIcon } from "./manifest";

const THEME_COLOR = /<meta\s+name=["']theme-color["'][^>]*>\s*/gi;

/** Registers the worker only where it is served: the export under `/app/`, not `expo start`. */
export const serviceWorkerRegistration = `<script>
if ("serviceWorker" in navigator && location.pathname.startsWith(${JSON.stringify(APP_BASE)})) {
  addEventListener("load", () => {
    navigator.serviceWorker.register(${JSON.stringify(`${APP_BASE}sw.js`)}, { scope: ${JSON.stringify(APP_BASE)} }).catch(() => {});
  });
}
</script>`;

/**
 * Adds the manifest link, one theme-color meta (replacing Expo's), the
 * apple-touch-icon and the worker registration to the exported shell.
 * Throws when the shell has no `</head>` or is already injected.
 */
export const injectPwaHead = (
  html: string,
  { themeColor }: { readonly themeColor: string },
): string => {
  if (html.includes('rel="manifest"')) throw new Error("index.html already links a manifest");
  const close = html.search(/<\/head>/i);
  if (close < 0) throw new Error("index.html has no </head>");
  const head = [
    `<meta name="theme-color" content="${themeColor}">`,
    `<link rel="manifest" href="${APP_BASE}manifest.webmanifest">`,
    `<link rel="apple-touch-icon" href="${APP_BASE}icons/${appleTouchIcon}">`,
    serviceWorkerRegistration,
  ].join("\n");
  const before = html.slice(0, close).replace(THEME_COLOR, "");
  return `${before}${head}\n${html.slice(close)}`;
};

/** Every `src=` / `href=` value in the document, in order. */
export const assetUrls = (html: string): ReadonlyArray<string> =>
  [...html.matchAll(/\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map(
    (match) => match[1] ?? match[2] ?? "",
  );

/** URLs that would not load from the `/app/` mount: anything outside it, including cross-origin ones. */
export const urlsOutsideBase = (html: string): ReadonlyArray<string> =>
  assetUrls(html).filter((url) => !url.startsWith(APP_BASE) && !url.startsWith("data:"));

/** Hashed bundle URLs the shell loads, for the worker's precache list. */
export const staticAssetUrls = (html: string): ReadonlyArray<string> => [
  ...new Set(assetUrls(html).filter((url) => url.startsWith(`${APP_BASE}_expo/static/`))),
];
