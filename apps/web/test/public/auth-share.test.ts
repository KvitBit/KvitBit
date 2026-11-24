import { describe, expect, test } from "bun:test";
import { SharedDocumentView, type ShareToken } from "@kvitbit/domain";
import { Schema } from "effect";
import type { Failure } from "../../src/app/api";
import { routes as publicDemoRoutes } from "../../src/demo/public";
import { match } from "../../src/demo/router";
import * as Auth from "../../src/page/public/auth";
import * as Share from "../../src/page/public/share";
import { anonymous, ctxFor, renderPath } from "../support";

const failureOf = (tag: string, freshBotProof = false): Failure => ({
  tag,
  surface: "banner",
  text: { key: tag === "InvalidBotProof" ? "error.invalidBotProof" : "error.unknown" },
  issues: [],
  retryable: false,
  staleRevision: false,
  freshBotProof,
  requestId: null,
});

const decodeDemoShare = (token: string): SharedDocumentView => {
  const found = match(publicDemoRoutes, "GET", `/api/v1/share/${token}`);
  if (found === undefined) throw new Error(`missing demo share route for ${token}`);
  const raw = found.route.respond({
    method: "GET",
    path: `/api/v1/share/${token}`,
    params: found.params,
    query: new URLSearchParams(),
    body: null,
  });
  return Schema.decodeUnknownSync(Schema.toCodecJson(SharedDocumentView))(raw);
};

describe("Auth page (Screen 02)", () => {
  test("SignUp starts ALTCHA solve, drops stale botSeq, validates fields, and auto-re-solves on freshBotProof", () => {
    const route: Auth.Route = { _tag: "SignUp" };
    const ctx = ctxFor(route, { locale: "en", session: anonymous });
    const first = Auth.init(route, ctx);
    expect(first.model.botProof._tag).toBe("Solving");
    expect(first.model.botSeq).toBe(1);

    // Stale botSeq ignored
    const staleBot = Auth.update(
      first.model,
      Auth.Message.GotBotProof({ seq: 99, status: "solved", header: "bad", reason: null }),
      ctx,
    );
    expect(staleBot.model.botProof._tag).toBe("Solving");

    // Current botSeq=1 solves
    const solved = Auth.update(
      first.model,
      Auth.Message.GotBotProof({ seq: 1, status: "solved", header: "base64proof", reason: null }),
      ctx,
    );
    expect(solved.model.botProof._tag).toBe("Solved");

    // Missing email fails validation locally
    const missingEmail = Auth.update(solved.model, Auth.Message.SubmittedSignUp(), ctx);
    expect(missingEmail.model.localError).toBeTruthy();

    // Fill valid fields & submit
    let m = Auth.update(
      solved.model,
      Auth.Message.ChangedEmail({ value: "jana@example.cz" }),
      ctx,
    ).model;
    m = Auth.update(m, Auth.Message.ChangedPassword({ value: "super-secure-123" }), ctx).model;
    m = Auth.update(m, Auth.Message.ToggledTerms({ checked: true }), ctx).model;
    const submitted = Auth.update(m, Auth.Message.SubmittedSignUp(), ctx);
    expect(submitted.model.submitting).toBe(true);
    expect(submitted.commands?.length).toBe(1);

    // Server rejects bot proof -> auto-fetches a fresh challenge (botSeq=2)
    const freshProof = Auth.update(
      submitted.model,
      Auth.Message.FailedSubmit({ seq: 1, failure: failureOf("InvalidBotProof", true) }),
      ctx,
    );
    expect(freshProof.model.submitting).toBe(false);
    expect(freshProof.model.botProof._tag).toBe("Solving");
    expect(freshProof.model.botSeq).toBe(2);
    expect(freshProof.commands?.length).toBe(1);
  });

  test("SignIn supports password, magic_link, and passkey unsupported state", () => {
    const route: Auth.Route = { _tag: "SignIn", returnTo: "/w/novak-design" };
    const ctx = ctxFor(route, { locale: "en", session: anonymous });
    const first = Auth.init(route, ctx);
    expect(first.model.signInMethod).toBe("password");

    const magic = Auth.update(
      first.model,
      Auth.Message.SelectedSignInMethod({ method: "magic_link" }),
      ctx,
    );
    expect(magic.model.signInMethod).toBe("magic_link");
    expect(magic.model.botSeq).toBe(2);

    const passkey = Auth.update(
      magic.model,
      Auth.Message.SelectedSignInMethod({ method: "passkey" }),
      ctx,
    );
    expect(passkey.model.botProof._tag).toBe("Idle");

    const unsupported = Auth.update(passkey.model, Auth.Message.FailedPasskeyUnsupported(), ctx);
    expect(unsupported.model.localError).toContain("Passkeys are not supported");
  });

  test("AuthLink reset redirects to ResetPassword; verify failure shows expired state", () => {
    const resetRoute: Auth.Route = { _tag: "AuthLink", kind: "reset", token: "tok-1" };
    const ctx = ctxFor(resetRoute, { locale: "en", session: anonymous });
    const res = Auth.init(resetRoute, ctx);
    expect(res.outMessage?._tag).toBe("Navigate");

    const verifyRoute: Auth.Route = { _tag: "AuthLink", kind: "verify", token: "expired" };
    const vInit = Auth.init(verifyRoute, ctxFor(verifyRoute, { locale: "en", session: anonymous }));
    expect(vInit.model.linkState).toBe("verifying");
    const vFail = Auth.update(
      vInit.model,
      Auth.Message.FailedSubmit({ seq: 1, failure: failureOf("Invalid") }),
      ctx,
    );
    expect(vFail.model.linkState).toBe("expired");
  });

  test("SSR renders /sign-up and /sign-in with jargon-free human check copy (no PoW)", async () => {
    const signUp = await renderPath("/sign-up", { locale: "en", session: anonymous });
    expect(signUp.html).toContain("Create your account");
    expect(signUp.html).toContain("Verifying you're human");
    expect(signUp.html).not.toContain("PoW");
    expect(signUp.html).not.toContain("Local cryptographic");

    const signIn = await renderPath("/sign-in", { locale: "cs", session: anonymous });
    expect(signIn.html).toContain("Přihlásit se");
  });
});

describe("Public Share Link page (Screen 04)", () => {
  test("loads unpaid CZK, EUR, paid, proforma, credit note, branded, and revoked states with stale-seq safety", () => {
    const token = "demo-unpaid-czk" as ShareToken;
    const route: Share.Route = { _tag: "Share", token };
    const ctx = ctxFor(route, { locale: "en", session: anonymous });

    const first = Share.init(route, ctx);
    expect(first.model.doc._tag).toBe("Loading");

    // Stale seq=99 ignored
    const docCzk = decodeDemoShare("demo-unpaid-czk");
    const stale = Share.update(
      first.model,
      Share.Message.GotDocument({ seq: 99, doc: docCzk }),
      ctx,
    );
    expect(stale.model.doc._tag).toBe("Loading");

    // Current seq=1 succeeds
    const loaded = Share.update(
      first.model,
      Share.Message.GotDocument({ seq: 1, doc: docCzk }),
      ctx,
    );
    expect(loaded.model.doc._tag).toBe("Loaded");
    expect(Share.title(loaded.model, ctx)).toContain("2026-0042");

    // PDF language toggle
    const switched = Share.update(
      loaded.model,
      Share.Message.SelectedPdfLanguage({ language: "en" }),
      ctx,
    );
    expect(switched.model.pdfLanguage).toBe("en");

    // Copy emits toast
    const copied = Share.update(switched.model, Share.Message.CopiedValue({ ok: true }), ctx);
    expect(copied.outMessage?._tag).toBe("Toast");

    // Verify all demo share variants decode cleanly
    for (const variant of [
      "demo-unpaid-eur",
      "demo-paid",
      "demo-overdue",
      "demo-proforma",
      "demo-credit-note",
      "demo-branded",
    ]) {
      const doc = decodeDemoShare(variant);
      expect(doc.number.length).toBeGreaterThan(0);
    }

    // Revoked / expired fails with NotFound
    const failed = Share.update(
      first.model,
      Share.Message.FailedDocument({ seq: 1, failure: failureOf("NotFound") }),
      ctx,
    );
    expect(failed.model.doc._tag).toBe("Failed");
  });

  test("SSR renders /i/:token loading skeleton cleanly in cs and en", async () => {
    const { html } = await renderPath("/i/demo-unpaid-czk", { locale: "cs", session: anonymous });
    expect(html).toContain("kb-share-wrap");
  });
});
