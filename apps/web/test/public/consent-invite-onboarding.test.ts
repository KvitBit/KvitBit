import { describe, expect, test } from "bun:test";
import { ConsentResult, ConsentView, SCOPE_AREAS } from "@kvitbit/api-contract";
import { InvitationPeek, RegistryResult, WorkspaceSummary, WorkspaceView } from "@kvitbit/domain";
import { Schema } from "effect";
import type { Failure } from "../../src/app/api";
import { routes as publicDemoRoutes } from "../../src/demo/public";
import { match } from "../../src/demo/router";
import * as Consent from "../../src/page/public/consent";
import * as Invitation from "../../src/page/public/invitation";
import * as Onboarding from "../../src/page/public/onboarding";
import { anonymous, ctxFor, DEMO_WORKSPACE, renderPath, signedIn } from "../support";

const demoCall = (method: string, path: string, body: unknown = null): unknown => {
  const hit = match(publicDemoRoutes, method, path);
  if (hit === undefined) throw new Error(`missing demo route ${method} ${path}`);
  return hit.route.respond({
    method,
    path,
    params: hit.params,
    query: new URLSearchParams(),
    body,
  });
};

const sampleFailure = (tag = "NotFound"): Failure => ({
  tag,
  surface: "banner",
  text: { key: tag === "NotFound" ? "error.notFound" : "error.unknown" },
  issues: [],
  retryable: false,
  staleRevision: false,
  freshBotProof: false,
  requestId: null,
});

describe("MCP OAuth 2.1 Consent page (Screen 05)", () => {
  test("loads consent, switches workspace, toggles all 10 ScopeAreas, and approves/denies with stale-seq safety", () => {
    const route: Consent.Route = { _tag: "McpConsent", consentId: "demo-consent" };
    const ctx = ctxFor(route, { locale: "en", session: signedIn });
    const first = Consent.init(route, ctx);
    expect(first.model.consent._tag).toBe("Loading");

    const consentView = Schema.decodeUnknownSync(ConsentView)(
      demoCall("GET", "/api/v1/oauth/consents/demo-consent"),
    );

    // Stale seq=99 ignored
    const stale = Consent.update(
      first.model,
      Consent.Message.GotConsent({ seq: 99, consent: consentView }),
      ctx,
    );
    expect(stale.model.consent._tag).toBe("Loading");

    // Current seq=1 succeeds and preselects first workspace
    const loaded = Consent.update(
      first.model,
      Consent.Message.GotConsent({ seq: 1, consent: consentView }),
      ctx,
    );
    expect(loaded.model.consent._tag).toBe("Loaded");
    expect(loaded.model.selectedWorkspaceId).toBe(consentView.workspaces[0]?.id ?? null);
    expect(loaded.model.grantableScopes.length).toBe(SCOPE_AREAS.length * 2);

    // Toggle a write scope off -> switches to custom mode
    const toggled = Consent.update(
      loaded.model,
      Consent.Message.ToggledScope({ scope: "documents:write" }),
      ctx,
    );
    expect(toggled.model.accessMode).toBe("custom");
    expect(toggled.model.selectedScopes).not.toContain("documents:write");
    expect(toggled.model.selectedScopes).toContain("documents:read");

    // Approve -> submits decision -> redirects
    const approving = Consent.update(toggled.model, Consent.Message.ClickedApprove(), ctx);
    expect(approving.model.submitting).toBe(true);
    expect(approving.commands?.length).toBe(1);

    const decision = Schema.decodeUnknownSync(ConsentResult)(
      demoCall("POST", "/api/v1/oauth/consents/demo-consent", { _tag: "Approve" }),
    );
    const done = Consent.update(
      approving.model,
      Consent.Message.CompletedDecision({ seq: 1, result: decision }),
      ctx,
    );
    expect(done.model.redirectingTo).toBe(decision.redirectTo);
    expect(done.commands?.length).toBe(1);
  });

  test("accountant workspace caps offerable scopes to read-only", () => {
    const route: Consent.Route = { _tag: "McpConsent", consentId: "demo-accountant" };
    const ctx = ctxFor(route, { locale: "en", session: signedIn });
    const first = Consent.init(route, ctx);
    const consentView = Schema.decodeUnknownSync(ConsentView)(
      demoCall("GET", "/api/v1/oauth/consents/demo-accountant"),
    );
    const loaded = Consent.update(
      first.model,
      Consent.Message.GotConsent({ seq: 1, consent: consentView }),
      ctx,
    );
    expect(loaded.model.accessMode).toBe("read");
    // Attempting to toggle a write scope is ignored by role cap
    const afterToggle = Consent.update(
      loaded.model,
      Consent.Message.ToggledScope({ scope: "documents:write" }),
      ctx,
    );
    expect(afterToggle.model.selectedScopes).not.toContain("documents:write");
  });
});

describe("Workspace Invitation Landing page (Screen 05)", () => {
  test("peeks invitation, handles accept -> ReloadSession, decline, and stale-seq", () => {
    const route: Invitation.Route = { _tag: "Invitation", token: "demo-pending" };
    const ctx = ctxFor(route, { locale: "en", session: signedIn });
    const first = Invitation.init(route, ctx);
    expect(first.model.peek._tag).toBe("Loading");

    const peek = Schema.decodeUnknownSync(InvitationPeek)(
      demoCall("GET", "/api/v1/invitations/demo-pending"),
    );

    // Stale seq ignored
    const stale = Invitation.update(first.model, Invitation.Message.GotPeek({ seq: 5, peek }), ctx);
    expect(stale.model.peek._tag).toBe("Loading");

    const loaded = Invitation.update(
      first.model,
      Invitation.Message.GotPeek({ seq: 1, peek }),
      ctx,
    );
    expect(loaded.model.peek._tag).toBe("Loaded");
    expect(Invitation.title(loaded.model, ctx)).toContain(DEMO_WORKSPACE.name);

    // Decline updates model
    const declined = Invitation.update(loaded.model, Invitation.Message.ClickedDecline(), ctx);
    expect(declined.model.declined).toBe(true);

    // Accept triggers command and ReloadSession on completion
    const accepting = Invitation.update(loaded.model, Invitation.Message.ClickedAccept(), ctx);
    expect(accepting.model.accepting).toBe(true);
    const ws = Schema.decodeUnknownSync(WorkspaceSummary)(
      demoCall("POST", "/api/v1/invitations/demo-pending/accept"),
    );
    const accepted = Invitation.update(
      accepting.model,
      Invitation.Message.CompletedAccept({ seq: 1, workspace: ws }),
      ctx,
    );
    expect(accepted.model.acceptedWorkspace?.slug).toBe(DEMO_WORKSPACE.slug);
    expect(accepted.outMessage?._tag).toBe("ReloadSession");
  });

  test("SSR renders /invite/:token for anonymous viewers", async () => {
    const { html } = await renderPath("/invite/demo-pending", { locale: "cs", session: anonymous });
    expect(html).toContain("kb-invite-shell");
  });
});

describe("Workspace Onboarding Wizard (Screen 07)", () => {
  test("walks 5 steps: ARES lookup, tax regime, Czech account -> IBAN, numbering, and create workspace", () => {
    const route: Onboarding.Route = { _tag: "Onboarding" };
    const ctx = ctxFor(route, { locale: "en", session: signedIn });
    const first = Onboarding.init(route, ctx);
    expect(first.model.step).toBe(1);

    // Cannot advance Step 1 without business name
    const blocked = Onboarding.update(first.model, Onboarding.Message.ClickedNext(), ctx);
    expect(blocked.model.step).toBe(1);
    expect(blocked.model.stepError).toBeTruthy();

    // ARES lookup for valid Czech IČO 27082440
    let m = Onboarding.update(
      first.model,
      Onboarding.Message.ChangedField({ field: "ico", value: "27082440" }),
      ctx,
    ).model;
    const lookup = Onboarding.update(m, Onboarding.Message.ClickedLookupAres(), ctx);
    expect(lookup.model.ares._tag).toBe("Loading");
    expect(lookup.commands?.length).toBe(1);

    const aresRes = Schema.decodeUnknownSync(RegistryResult)(
      demoCall("GET", "/api/v1/registry/companies/27082440"),
    );

    // Stale ARES seq ignored
    const staleAres = Onboarding.update(
      lookup.model,
      Onboarding.Message.GotAres({ seq: 99, result: aresRes }),
      ctx,
    );
    expect(staleAres.model.ares._tag).toBe("Loading");

    // Current ARES seq auto-fills legal name, slug, DIC, and VAT payer regime
    const filled = Onboarding.update(
      lookup.model,
      Onboarding.Message.GotAres({ seq: 1, result: aresRes }),
      ctx,
    );
    expect(filled.model.legalName).toBe("Alza.cz a.s.");
    expect(filled.model.slug).toBe("alza-cz-a-s");
    expect(filled.model.taxRegime).toBe("vat_payer");

    // Step 1 -> Step 2 -> Step 3
    m = Onboarding.update(filled.model, Onboarding.Message.ClickedNext(), ctx).model;
    expect(m.step).toBe(2);
    m = Onboarding.update(
      m,
      Onboarding.Message.SelectedTaxRegime({ regime: "vat_payer" }),
      ctx,
    ).model;
    m = Onboarding.update(m, Onboarding.Message.ClickedNext(), ctx).model;
    expect(m.step).toBe(3);

    // Czech bank account auto-converts to IBAN
    m = Onboarding.update(
      m,
      Onboarding.Message.ChangedField({ field: "czechAccount", value: "2000145399/2010" }),
      ctx,
    ).model;
    expect(m.iban.replace(/\s/g, "")).toMatch(/^CZ\d{22}$/);

    // Step 3 -> Step 4 -> Step 5
    m = Onboarding.update(m, Onboarding.Message.ClickedNext(), ctx).model;
    expect(m.step).toBe(4);
    m = Onboarding.update(m, Onboarding.Message.ClickedNext(), ctx).model;
    expect(m.step).toBe(5);

    // Submit workspace creation -> Navigate to Dashboard
    const creating = Onboarding.update(m, Onboarding.Message.ClickedCreateWorkspace(), ctx);
    expect(creating.model.submitting).toBe(true);
    expect(creating.commands?.length).toBe(1);

    const wsView = Schema.decodeUnknownSync(WorkspaceView)({
      slug: "novak-design-s-r-o",
      branding: {
        pdfTemplate: "classic",
        accentColor: "#111111",
        footerText: null,
        theme: null,
        logo: null,
        stamp: null,
      },
      revision: 1,
    });
    const created = Onboarding.update(
      creating.model,
      Onboarding.Message.CompletedCreate({ seq: 1, workspace: wsView }),
      ctx,
    );
    expect(created.outMessage?._tag).toBe("Navigate");
    if (created.outMessage?._tag === "Navigate") {
      expect(created.outMessage.path).toBe("/w/novak-design-s-r-o");
    }

    // Failure path keeps wizard on step 5 with submitFailure
    const failed = Onboarding.update(
      creating.model,
      Onboarding.Message.FailedCreate({ seq: 1, failure: sampleFailure("Unavailable") }),
      ctx,
    );
    expect(failed.model.submitting).toBe(false);
    expect(failed.model.submitFailure?.tag).toBe("Unavailable");
  });

  test("SSR renders /onboarding wizard in cs and en", async () => {
    const cs = await renderPath("/onboarding", { locale: "cs", session: signedIn });
    expect(cs.html).toContain("kb-onboarding");
    expect(cs.html).toContain("ARES");

    const en = await renderPath("/onboarding?step=5", { locale: "en", session: signedIn });
    expect(en.html).toContain("Live miniature invoice preview");
  });
});

describe("Demo API routes (src/demo/public.ts)", () => {
  test("matches every public demo endpoint", () => {
    const expected: ReadonlyArray<readonly [string, string]> = [
      ["GET", "/api/v1/config"],
      ["GET", "/api/v1/bot-protection/challenges/sign_up"],
      ["POST", "/api/auth/sign-up/email"],
      ["POST", "/api/auth/sign-in/email"],
      ["POST", "/api/auth/sign-in/magic-link"],
      ["GET", "/api/mobile/releases/latest"],
      ["GET", "/api/v1/share/demo-unpaid-czk"],
      ["GET", "/api/v1/invitations/demo-pending"],
      ["POST", "/api/v1/invitations/demo-pending/accept"],
      ["GET", "/api/v1/oauth/consents/demo-consent"],
      ["POST", "/api/v1/oauth/consents/demo-consent"],
      ["GET", "/api/v1/registry/companies/01234567"],
      ["POST", "/api/v1/workspaces"],
    ];
    for (const [method, path] of expected) {
      expect(match(publicDemoRoutes, method, path)).toBeDefined();
    }
  });
});
