export const KVITBIT_ANDROID_PACKAGE = "cz.kvitbit.app";
export const OBTAINIUM_REDIRECT_ORIGIN = "https://apps.obtainium.imranr.dev/redirect";
export const OBTAINIUM_APK_FILTER_REGEX = "kvitbit-[0-9.]+\\.apk$";
export const OBTAINIUM_VERSION_EXTRACTION_REGEX = "kvitbit-([0-9.]+)\\.apk";

/**
 * Obtainium's web page source settings: picks the APK link on `/android` by
 * file name and extracts the semantic version so updates show as a version
 * rather than a file hash.
 */
const obtainiumSourceSettings = {
  customLinkFilterRegex: OBTAINIUM_APK_FILTER_REGEX,
  versionExtractionRegEx: OBTAINIUM_VERSION_EXTRACTION_REGEX,
  matchGroupToUse: "1",
} as const;

const normalizeOrigin = (origin: string): string => {
  const url = URL.parse(origin.trim());
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new Error(`Obtainium origin must be an http(s) URL, got ${JSON.stringify(origin)}`);
  }
  return url.origin;
};

/** Direct `obtainium://app/...` deep link for Kvitbit on `origin`. */
export const obtainiumAppLink = (origin: string): string => {
  const normalizedOrigin = normalizeOrigin(origin);
  return `obtainium://app/${encodeURIComponent(
    JSON.stringify({
      id: KVITBIT_ANDROID_PACKAGE,
      url: `${normalizedOrigin}/android`,
      author: "Kvitbit",
      name: "Kvitbit",
      additionalSettings: JSON.stringify(obtainiumSourceSettings),
    }),
  )}`;
};

/**
 * Adds Kvitbit (`cz.kvitbit.app`) to Obtainium via Obtainium's redirect page,
 * which opens the `obtainium://` link or offers to install Obtainium.
 */
export const obtainiumImportUrl = (origin: string): string => {
  const url = new URL(OBTAINIUM_REDIRECT_ORIGIN);
  url.searchParams.set("r", obtainiumAppLink(origin));
  return url.href;
};
