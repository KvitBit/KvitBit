import { describe, expect, test } from "bun:test";
import { ConfigView, ReleaseInfo } from "@kvitbit/api-contract";
import { Schema } from "effect";
import type { Failure } from "../../src/app/api";
import * as Android from "../../src/page/public/android";
import * as ErrorPage from "../../src/page/public/error";
import * as Landing from "../../src/page/public/landing";
import * as Legal from "../../src/page/public/legal";
import { anonymous, ctxFor, renderPath, signedIn } from "../support";

const sampleFailure = (tag = "Unavailable"): Failure => ({
  tag,
  surface: "banner",
  text: { key: "error.unknown" },
  issues: [],
  retryable: true,
  staleRevision: false,
  freshBotProof: false,
  requestId: null,
});

const sampleConfig = (signUp = true): ConfigView =>
  Schema.decodeUnknownSync(ConfigView)({
    version: "1.0.0",
    botProtection: "altcha",
    uploads: {
      attachment: { maxBytes: 1024, types: ["application/pdf"] },
      brandingImage: { maxBytes: 1024, types: ["image/png"] },
      themeJson: { maxBytes: 1024 },
    },
    features: { signUp, mcp: true, apiKeys: true },
  });

const sampleRelease: ReleaseInfo = Schema.decodeUnknownSync(ReleaseInfo)({
  version: "1.2.3",
  versionCode: 10203,
  releasedAt: "2026-11-20T10:00:00Z",
  apkUrl: "/api/mobile/releases/1.2.3/apk",
  apkSha256: "aaaa1111bbbb2222",
  sizeBytes: 15_728_640,
  signingCertSha256: "cccc3333dddd4444",
  minAndroidSdk: 26,
  obtainiumUrl: "obtainium://add/https://kvitbit.cz/api/mobile/releases/latest",
});

describe("Landing page (Screen 01)", () => {
  test("init loads config with seq=1 and ignores stale seq replies", () => {
    const ctx = ctxFor({ _tag: "Landing" }, { locale: "en", session: anonymous });
    const first = Landing.init({ _tag: "Landing" }, ctx);
    expect(first.model.config._tag).toBe("Loading");
    expect(first.commands?.length).toBe(1);

    // Stale seq=99 must be ignored
    const stale = Landing.update(
      first.model,
      Landing.Message.GotConfig({ seq: 99, config: sampleConfig(false) }),
      ctx,
    );
    expect(stale.model.config._tag).toBe("Loading");

    // Current seq=1 succeeds
    const loaded = Landing.update(
      first.model,
      Landing.Message.GotConfig({ seq: 1, config: sampleConfig(false) }),
      ctx,
    );
    expect(loaded.model.config._tag).toBe("Loaded");
    if (loaded.model.config._tag === "Loaded") {
      expect(loaded.model.config.data.features.signUp).toBe(false);
    }
  });

  test("SSR renders landing in cs and en with Persuade hero and feature cards", async () => {
    const cs = await renderPath("/", { locale: "cs", session: anonymous });
    expect(cs.html).toContain("kb-landing-hero");
    expect(cs.html).toContain("kb-pattern");
    expect(cs.html).toContain("kvitbit-lockup-horizontal");
    expect(cs.html).toContain("/sign-up");
    expect(cs.html).toContain("/android");
    expect(cs.html).toContain("/app/");

    const en = await renderPath("/", { locale: "en", session: anonymous });
    expect(en.html).toContain("Invoicing for Czech freelancers and small companies");
    expect(en.html).toContain("Start for free");
  });
});

describe("Legal page (Screen 01)", () => {
  test("renders terms and privacy in both cs and en", async () => {
    const termsEn = await renderPath("/legal/terms", { locale: "en", session: anonymous });
    expect(termsEn.title).toContain("Terms of service");
    expect(termsEn.html).toContain("Terms of service");
    expect(termsEn.html).toContain("/legal/privacy");

    const privacyCs = await renderPath("/legal/privacy", { locale: "cs", session: anonymous });
    expect(privacyCs.title).toContain("Ochrana osobních údajů");
    expect(privacyCs.html).toContain("GDPR");

    const ctx = ctxFor({ _tag: "Legal", page: "terms" }, { locale: "en" });
    const init = Legal.init({ _tag: "Legal", page: "terms" }, ctx);
    expect(init.model.kind).toBe("terms");
  });
});

describe("Android Download page (Screen 03)", () => {
  test("init fetches release, handles failure/retry, stale-seq, and copy toast", () => {
    const ctx = ctxFor({ _tag: "AndroidDownload" }, { locale: "en", session: anonymous });
    const first = Android.init({ _tag: "AndroidDownload" }, ctx);
    expect(first.model.release._tag).toBe("Loading");

    // Stale seq ignored
    const stale = Android.update(
      first.model,
      Android.Message.GotRelease({ seq: 42, release: sampleRelease }),
      ctx,
    );
    expect(stale.model.release._tag).toBe("Loading");

    // Failure -> Retry bumps seq to 2
    const failed = Android.update(
      first.model,
      Android.Message.FailedRelease({ seq: 1, failure: sampleFailure() }),
      ctx,
    );
    expect(failed.model.release._tag).toBe("Failed");

    const retried = Android.update(failed.model, Android.Message.ClickedRetry(), ctx);
    expect(retried.model.release._tag).toBe("Loading");
    if (retried.model.release._tag === "Loading") {
      expect(retried.model.release.seq).toBe(2);
    }

    const loaded = Android.update(
      retried.model,
      Android.Message.GotRelease({ seq: 2, release: sampleRelease }),
      ctx,
    );
    expect(loaded.model.release._tag).toBe("Loaded");

    const copied = Android.update(loaded.model, Android.Message.CopiedValue({ ok: true }), ctx);
    expect(copied.outMessage?._tag).toBe("Toast");
  });

  test("SSR renders /android with Obtainium and /app/ PWA link", async () => {
    const { html, title } = await renderPath("/android", { locale: "en", session: anonymous });
    expect(title).toContain("Kvitbit for Android");
    expect(html).toContain("Obtainium");
    expect(html).toContain('href="/app/"');
  });
});

describe("Error pages (Screen 03)", () => {
  test("renders 404, 403 no_access, 500 server, and offline states", async () => {
    const notFound = await renderPath("/no/such/page", { locale: "en", session: anonymous });
    expect(notFound.html).toContain("404");
    expect(notFound.html).toContain("Page not found");

    const noAccess = await renderPath("/w/unknown-workspace/documents", {
      locale: "en",
      session: signedIn,
    });
    expect(noAccess.html).toContain("403");
    expect(noAccess.html).toContain("No access");
    expect(noAccess.html).toContain("Novák Design");

    const ctx = ctxFor({ _tag: "Error", kind: "server" }, { locale: "cs", session: anonymous });
    const init = ErrorPage.init({ _tag: "Error", kind: "server" }, ctx);
    expect(ErrorPage.title(init.model, ctx)).toContain("Něco se pokazilo");
    const retried = ErrorPage.update(init.model, ErrorPage.Message.ClickedRetry(), ctx);
    expect(retried.outMessage?._tag).toBe("ReloadSession");
  });
});
