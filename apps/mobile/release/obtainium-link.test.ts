import { describe, expect, test } from "bun:test";
import {
  KVITBIT_ANDROID_PACKAGE,
  OBTAINIUM_APK_FILTER_REGEX,
  OBTAINIUM_VERSION_EXTRACTION_REGEX,
  obtainiumAppLink,
  obtainiumImportUrl,
} from "./obtainium-link";

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

    expect(
      new RegExp(settings.customLinkFilterRegex).test(
        "/api/mobile/releases/1.4.0/kvitbit-1.4.0.apk",
      ),
    ).toBe(true);
    expect(new RegExp(settings.versionExtractionRegEx).exec("kvitbit-1.4.0.apk")?.[1]).toBe(
      "1.4.0",
    );
  });

  test("rejects non-http(s) origins", () => {
    expect(() => obtainiumImportUrl("ftp://kvitbit.cz")).toThrow();
    expect(() => obtainiumImportUrl("not-a-url")).toThrow();
  });
});
