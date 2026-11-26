import { describe, expect, test } from "bun:test";
import {
  KVITBIT_ANDROID_PACKAGE,
  OBTAINIUM_APK_FILTER_REGEX,
  OBTAINIUM_VERSION_EXTRACTION_REGEX,
  obtainiumAppLink,
  obtainiumImportUrl,
} from "./obtainium-link";
import { apkRoutePath } from "./storage-layout";

describe("obtainium-link", () => {
  test("builds Obtainium redirect URL targeting cz.kvitbit.app and /android", () => {
    const importUrl = obtainiumImportUrl("https://kvitbit.cz/");
    const parsed = new URL(importUrl);
    expect(parsed.origin).toBe("https://apps.obtainium.imranr.dev");
    expect(parsed.pathname).toBe("/redirect");

    const r = parsed.searchParams.get("r");
    expect(r).toBe(obtainiumAppLink("https://kvitbit.cz"));
    expect(r?.startsWith("obtainium://app/")).toBe(true);

    const payload = JSON.parse(decodeURIComponent((r ?? "").slice("obtainium://app/".length))) as {
      id: string;
      url: string;
      author: string;
      name: string;
      additionalSettings: string;
    };
    expect(payload.id).toBe(KVITBIT_ANDROID_PACKAGE);
    expect(payload.url).toBe("https://kvitbit.cz/android");
    expect(payload.name).toBe("Kvitbit");

    const settings = JSON.parse(payload.additionalSettings) as {
      customLinkFilterRegex: string;
      versionExtractionRegEx: string;
      matchGroupToUse: string;
    };
    expect(settings.customLinkFilterRegex).toBe(OBTAINIUM_APK_FILTER_REGEX);
    expect(settings.versionExtractionRegEx).toBe(OBTAINIUM_VERSION_EXTRACTION_REGEX);
    expect(settings.matchGroupToUse).toBe("1");

    // Exercise against the actual public ReleaseInfo.apkUrl / <a href="..."> path
    const relativeHref = apkRoutePath("1.4.0");
    const absoluteHref = `https://kvitbit.cz${relativeHref}`;
    const filterRe = new RegExp(settings.customLinkFilterRegex);
    const versionRe = new RegExp(settings.versionExtractionRegEx);

    expect(relativeHref).toBe("/api/mobile/releases/1.4.0/apk");
    expect(filterRe.test(relativeHref)).toBe(true);
    expect(filterRe.test(absoluteHref)).toBe(true);
    expect(filterRe.test("https://kvitbit.cz/android")).toBe(false);
    expect(versionRe.exec(relativeHref)?.[1]).toBe("1.4.0");
    expect(versionRe.exec(absoluteHref)?.[1]).toBe("1.4.0");
  });

  test("rejects non-http(s) origins", () => {
    expect(() => obtainiumImportUrl("ftp://kvitbit.cz")).toThrow();
    expect(() => obtainiumImportUrl("not-a-url")).toThrow();
  });
});
