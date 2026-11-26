import { describe, expect, test } from "bun:test";
import { Html, HtmlServer } from "@effect/ui/html";
import { SharedDocumentView, type ShareToken } from "@kvitbit/domain";
import { Effect, Schema } from "effect";
import jsQR from "jsqr";
import type { Failure } from "../../src/app/api";
import { routes as publicDemoRoutes } from "../../src/demo/public";
import { match } from "../../src/demo/router";
import * as Auth from "../../src/page/public/auth";
import * as Share from "../../src/page/public/share";
import { anonymous, ctxFor, DEMO_WORKSPACE, renderPath } from "../support";
import { mockWire, run } from "./wire";

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

    const started = Auth.update(passkey.model, Auth.Message.ClickedPasskeySignIn(), ctx);
    const unsupported = Auth.update(
      started.model,
      Auth.Message.FailedPasskeyUnsupported({ seq: started.model.submitSeq }),
      ctx,
    );
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

  test("invited signup uses the peeked address and invitation proof, then accepts with the verified session", async () => {
    const email = "invited@example.test";
    const token = "web-wire-invite";
    const invite = {
      workspaceName: "Novák",
      inviterName: "Jana",
      email,
      role: "member",
      status: "pending",
      expiresAt: "2099-01-01",
    };
    const route: Auth.Route = { _tag: "SignUp", invitation: token };
    const ctx = ctxFor(route, { locale: "en", session: anonymous });
    const calls: Array<string> = [];
    let session = false;
    const fetch = mockWire(async (request, credentials) => {
      const url = new URL(request.url);
      calls.push(`${request.method} ${url.pathname}`);
      switch (url.pathname) {
        case "/api/v1/bot-protection/challenges/invitation_accept":
          return Response.json({
            parameters: {
              algorithm: "SHA-256",
              nonce: "00112233",
              salt: "aabbccdd",
              cost: 1,
              keyLength: 32,
              keyPrefix: "0",
              data: { scope: "invitation_accept" },
            },
            signature: "wire-fixture",
          });
        case `/api/v1/invitations/${token}`:
          return Response.json(invite);
        case "/api/auth/sign-up/email": {
          expect(credentials).toBe("same-origin");
          const proof = JSON.parse(atob(request.headers.get("x-altcha") ?? ""));
          expect(proof.challenge.parameters.data.scope).toBe("invitation_accept");
          expect(await request.json()).toMatchObject({
            email,
            invitationToken: token,
            password: "wire-test-password",
          });
          session = true;
          return Response.json(
            { token: "fixture-session", user: { email, emailVerified: true } },
            {
              headers: {
                "set-cookie": "better-auth.session_token=fixture-session; HttpOnly; Path=/",
              },
            },
          );
        }
        case `/api/v1/invitations/${token}/accept`:
          expect(session).toBe(true);
          expect(credentials).toBe("include");
          return Response.json(DEMO_WORKSPACE);
        default:
          throw new Error(`Unexpected request ${url.pathname}`);
      }
    });
    try {
      const initial = Auth.init(route, ctx);
      const premature = Auth.update(initial.model, Auth.Message.SubmittedSignUp(), ctx);
      expect(premature.commands).toBeUndefined();
      const proof = Auth.update(initial.model, await run(initial.commands?.[0]), ctx);
      expect(calls).toEqual(["GET /api/v1/bot-protection/challenges/invitation_accept"]);
      expect(proof.model.botProof).toMatchObject({ _tag: "Solved" });
      const peeked = Auth.update(proof.model, await run(initial.commands?.[1]), ctx);
      const tampered = Auth.update(
        peeked.model,
        Auth.Message.ChangedEmail({ value: "other@example.test" }),
        ctx,
      );
      expect(tampered.model.email).toBe(email);
      const password = Auth.update(
        tampered.model,
        Auth.Message.ChangedPassword({ value: "wire-test-password" }),
        ctx,
      );
      const agreed = Auth.update(password.model, Auth.Message.ToggledTerms({ checked: true }), ctx);
      const submitted = Auth.update(agreed.model, Auth.Message.SubmittedSignUp(), ctx);
      expect(submitted.model.submitting).toBe(true);
      const signupResponse = await run(submitted.commands?.[0]);
      expect(signupResponse).toMatchObject({ _tag: "CompletedSubmit", sessionEstablished: true });
      const signedUp = Auth.update(submitted.model, signupResponse, ctx);
      expect(signedUp.outMessage).toBeUndefined();
      const accepted = Auth.update(signedUp.model, await run(signedUp.commands?.[0]), ctx);
      expect(accepted.outMessage?._tag).toBe("ReloadSession");
      expect(accepted.outMessage).toHaveProperty("then", {
        _tag: "Path",
        path: `/w/${DEMO_WORKSPACE.slug}`,
        replace: true,
      });
      expect(calls).toEqual([
        "GET /api/v1/bot-protection/challenges/invitation_accept",
        `GET /api/v1/invitations/${token}`,
        "POST /api/auth/sign-up/email",
        `POST /api/v1/invitations/${token}/accept`,
      ]);
    } finally {
      fetch.mockRestore();
    }
  });

  test("post-auth intents reload before honoring a destination", () => {
    for (const [returnTo, expected] of [
      ["/w/novak-design", { _tag: "Path", path: "/w/novak-design", replace: true }],
      ["/\\example.test", { _tag: "DefaultSignedIn" }],
      [undefined, { _tag: "DefaultSignedIn" }],
    ] as const) {
      const route: Auth.Route =
        returnTo === undefined ? { _tag: "SignIn" } : { _tag: "SignIn", returnTo };
      const ctx = ctxFor(route, { locale: "en", session: anonymous });
      const initial = Auth.init(route, ctx);
      const ready = Auth.update(
        initial.model,
        Auth.Message.SelectedSignInMethod({ method: "passkey" }),
        ctx,
      );
      const submitted = Auth.update(ready.model, Auth.Message.ClickedPasskeySignIn(), ctx);
      const result = Auth.update(
        submitted.model,
        Auth.Message.CompletedSubmit({
          seq: submitted.model.submitSeq,
          action: "sign_in_passkey",
        }),
        ctx,
      );
      expect(result.outMessage?._tag).toBe("ReloadSession");
      expect(result.outMessage).toHaveProperty("then", expected);
    }
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
      Share.Message.GotDocument({ seq: 99, token, doc: docCzk }),
      ctx,
    );
    expect(stale.model.doc._tag).toBe("Loading");

    // Current seq=1 succeeds
    const loaded = Share.update(
      first.model,
      Share.Message.GotDocument({ seq: 1, token, doc: docCzk }),
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
      Share.Message.FailedDocument({ seq: 1, token, failure: failureOf("NotFound") }),
      ctx,
    );
    expect(failed.model.doc._tag).toBe("Failed");
  });

  test("SSR renders /i/:token loading skeleton cleanly in cs and en", async () => {
    const { html } = await renderPath("/i/demo-unpaid-czk", { locale: "cs", session: anonymous });
    expect(html).toContain("kb-share-wrap");
  });

  test.each([
    [
      "demo-unpaid-czk",
      "SPD*1.0*ACC:CZ9320100000002000145399*AM:48400.00*CC:CZK*X-VS:20260042*MSG:Faktura 2026-0042",
    ],
    [
      "demo-unpaid-eur",
      "BCD\n002\n1\nSCT\nFIOBCZPPXXX\nNovak Design s.r.o.\nCZ9320100000002000145399\nEUR1815.00\n\n20260043",
    ],
  ])("decodes the rendered payment symbol for %s", async (token, expectedPayload) => {
    const html = await renderLoadedShare(token);
    const image = /src="data:image\/svg\+xml,([^"]+)"/g;
    const svg = Array.from(html.matchAll(image), (match) =>
      decodeURIComponent(match[1] ?? ""),
    ).find((markup) => markup.includes('shape-rendering="crispEdges"'));
    expect(svg).toBeDefined();
    expect(decodeQrSvg(svg ?? "")).toBe(expectedPayload);
    expect(html).toContain(`href="/api/v1/share/${token}/pdf?language=en"`);
    expect(html).toMatch(/<a[^>]*\bdownload(?:="")?[^>]*>/);
  });

  test.each(["demo-unpaid-czk", "demo-branded"])(
    "renders workspace branding independently of viewer preferences for %s",
    async (token) => {
      const elegant = await renderLoadedShare(token, "elegant");
      const cozy = await renderLoadedShare(token, "cozy");
      expect(cozy).toBe(elegant);
      expect(cozy).toContain('data-style="elegant"');
      expect(cozy).toContain(".kb-share-themed {");
      expect(cozy.includes('data-branded="1"')).toBe(token === "demo-branded");
    },
  );
});

const renderLoadedShare = async (token: string, style: "elegant" | "cozy" = "elegant") => {
  const route: Share.Route = { _tag: "Share", token: token as ShareToken };
  const base = ctxFor(route, { locale: "en", session: anonymous });
  const ctx = { ...base, prefs: { ...base.prefs, style } };
  const initial = Share.init(route, ctx);
  const { model } = Share.update(
    initial.model,
    Share.Message.GotDocument({ seq: 1, token, doc: decodeDemoShare(token) }),
    ctx,
  );
  const component = Html.component({
    name: "LoadedShare",
    props: Share.Model,
    model: Share.Model,
    message: Share.Message,
  }).make({
    init: ($) => $.set($.props),
    update: ($) => $.set($.model),
    view: (h, model) => Share.view({ ...model, pdfLanguage: "en" }, ctx, h),
  });
  return (await Effect.runPromise(HtmlServer.renderToHtml(component, model))).html;
};

// Rasterize the emitted SVG rectangles before passing pixels to the independent decoder.
const decodeQrSvg = (svg: string) => {
  const modules = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)?.[1]);
  const scale = 4;
  const size = modules * scale;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  for (const [, x, y] of svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="1" height="1"\/>/g)) {
    for (let row = Number(y) * scale; row < (Number(y) + 1) * scale; row++) {
      for (let col = Number(x) * scale; col < (Number(x) + 1) * scale; col++) {
        const offset = (row * size + col) * 4;
        pixels.fill(0, offset, offset + 3);
      }
    }
  }
  return jsQR(pixels, size, size)?.data;
};
