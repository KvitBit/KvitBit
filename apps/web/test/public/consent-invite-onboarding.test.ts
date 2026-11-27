import { describe, expect, test } from "bun:test";
import { HtmlScene } from "@effect/ui/html/testing";
import { Locator } from "@effect/ui/testing";
import { ConsentResult, ConsentView, SCOPE_AREAS } from "@kvitbit/api-contract";
import { InvitationPeek, RegistryResult, WorkspaceSummary, WorkspaceView } from "@kvitbit/domain";
import { Effect, Schema } from "effect";
import type { Failure } from "../../src/app/api";
import { definePage } from "../../src/app/page";
import { routes as publicDemoRoutes } from "../../src/demo/public";
import { match } from "../../src/demo/router";
import * as Consent from "../../src/page/public/consent";
import * as Invitation from "../../src/page/public/invitation";
import * as Onboarding from "../../src/page/public/onboarding";
import { anonymous, ctxFor, DEMO_WORKSPACE, renderPath, signedIn } from "../support";
import { mockWire, run } from "./wire";

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
  test("walks 5 steps: ARES lookup, tax regime, Czech account -> IBAN, numbering, and create workspace", async () => {
    const route: Onboarding.Route = { _tag: "Onboarding" };
    const ctx = ctxFor(route, { locale: "en", session: signedIn });
    const first = Onboarding.update(
      Onboarding.init(route, ctx).model,
      Onboarding.Message.RestoredDraft({ draft: null }),
      ctx,
    );
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

    // ARES supplies entity data but does not determine VAT payer status.
    const filled = Onboarding.update(
      lookup.model,
      Onboarding.Message.GotAres({ seq: 1, result: aresRes }),
      ctx,
    );
    expect(filled.model.legalName).toBe("Alza.cz a.s.");
    expect(filled.model.slug).toBe("alza-cz-a-s");
    expect(filled.model.taxRegime).toBe("non_vat_payer");

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

    // Finish configuration before asking the shell to refresh membership.
    const submit = Onboarding.Message.ClickedCreateWorkspace();
    const minting = Onboarding.update(m, submit, ctx);
    const replay = Onboarding.update(m, submit, ctx);
    expect(replay.model).toEqual(minting.model);
    expect(replay.commands?.map((command) => command.name)).toEqual(["OnboardingRequestKeys"]);
    expect(minting.model.createRequestKey).toBeNull();
    expect(minting.model.bankRequestKey).toBeNull();
    const creating = Onboarding.update(minting.model, await run(minting.commands?.[0]), ctx);
    expect(creating.model.submitting).toBe(true);
    expect(creating.commands?.length).toBe(1);
    const keys = [
      creating.model.createRequestKey,
      creating.model.bankRequestKey,
      ...Object.values(creating.model.seriesRequestKeys ?? {}),
    ];
    expect(keys).toHaveLength(6);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys)
      expect(key).toMatch(/^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);

    const wsView = Schema.decodeUnknownSync(WorkspaceView)({
      id: DEMO_WORKSPACE.id,
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
    expect(created.outMessage).toBeUndefined();
    expect(created.commands).toHaveLength(1);
    const completed = Onboarding.update(
      created.model,
      Onboarding.Message.CompletedSetup({ seq: 1, slug: wsView.slug }),
      ctx,
    );
    expect(completed.outMessage?._tag).toBe("ReloadSession");
    expect(completed.outMessage).toHaveProperty("destination", {
      _tag: "Path",
      path: "/w/novak-design-s-r-o",
      replace: true,
    });

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

    const step4En = await renderPath("/onboarding?step=4", { locale: "en", session: signedIn });
    expect(step4En.html).toContain("kb-series-ledger");
    expect(step4En.html).toContain('data-series-kind="invoice"');
    expect(step4En.html).toContain('data-series-kind="proforma"');
    expect(step4En.html).toContain('data-series-kind="credit_note"');
    expect(step4En.html).toContain("ZF-2026-0001");
    expect(step4En.html).toContain("OD-2026-0001");
    expect(step4En.html).toContain("kb-onboarding-defaults");

    const step4Cs = await renderPath("/onboarding?step=4", { locale: "cs", session: signedIn });
    expect(step4Cs.html).toContain("Číselné řady");
    expect(step4Cs.html).toContain("Výchozí hodnoty dokladů");

    const en = await renderPath("/onboarding?step=5", { locale: "en", session: signedIn });
    expect(en.html).toContain("Live miniature invoice preview");
  });

  test("writes the issuer, bank and numbering through the typed API and resumes lost replies", async () => {
    const route: Onboarding.Route = { _tag: "Onboarding", step: 5 };
    const ctx = ctxFor(route, { locale: "en", session: signedIn });
    const workspace = {
      id: DEMO_WORKSPACE.id,
      slug: "wire-setup",
      revision: 1,
      branding: {
        pdfTemplate: "classic",
        accentColor: "#123456",
        footerText: null,
        theme: null,
        logo: null,
        stamp: null,
      },
    };
    const base = `/api/v1/workspaces/${workspace.id}`;
    let invoice = {
      id: "10000000-0000-7000-8000-000000000001",
      kind: "invoice",
      name: "Invoices",
      pattern: "YYYY-NNNN",
      isDefault: true,
      periodKey: "2026",
      nextCounter: 1,
      nextNumber: "2026-0001",
    };
    const calls: Array<string> = [];
    const createKeys: Array<string | null> = [];
    const bankKeys: Array<string | null> = [];
    const seriesKeys: Record<string, string | null> = {};
    const fetch = mockWire(async (request) => {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (path === "/api/v1/workspaces" && request.method === "POST") {
        createKeys.push(request.headers.get("idempotency-key"));
        expect(await request.json()).toMatchObject({
          name: "Test Workspace",
          taxRegime: "non_vat_payer",
          defaults: { currency: "CZK", language: "en" },
        });
        if (createKeys.length === 1)
          throw new TypeError("Connection lost after workspace creation");
        return Response.json(workspace, { status: 201 });
      }
      if (path === base) return Response.json(workspace);
      if (path === `${base}/issuing-entity`) {
        expect(request.headers.get("if-match")).toBe('"1"');
        expect(await request.json()).toEqual({
          name: "Manual Issuer",
          ico: null,
          dic: null,
          address: { street: "Main 1", city: "Prague", postalCode: "100 00", country: "CZ" },
          legalForm: null,
          registerEntry: null,
        });
        return Response.json({ ...workspace, revision: 2 });
      }
      if (path === `${base}/bank-accounts`) {
        bankKeys.push(request.headers.get("idempotency-key"));
        expect(await request.json()).toEqual({
          iban: "CZ9320100000002000145399",
          bic: "FIOBCZPPXXX",
          currency: "CZK",
          isDefault: true,
        });
        return bankKeys.length === 1
          ? Response.json({ _tag: "Unavailable" }, { status: 503 })
          : Response.json({ id: "bank-created" }, { status: 201 });
      }
      if (path === `${base}/numbering-series` && request.method === "GET") {
        return Response.json([invoice]);
      }
      if (path === `${base}/numbering-series/${invoice.id}`) {
        expect(await request.json()).toEqual({
          kind: "invoice",
          name: "Invoices",
          pattern: "INV-YYYY-NNNN",
          nextNumber: 42,
          isDefault: true,
        });
        invoice = {
          ...invoice,
          pattern: "INV-YYYY-NNNN",
          nextCounter: 42,
          nextNumber: "INV-2026-0042",
        };
        return Response.json(invoice);
      }
      if (path === `${base}/numbering-series` && request.method === "POST") {
        const body = (await request.json()) as { kind: string; name: string; pattern: string };
        seriesKeys[body.kind] = request.headers.get("idempotency-key");
        expect(body.kind).not.toBe("payment_tax_document");
        return Response.json(
          { ...invoice, ...body, nextCounter: 1, nextNumber: "2026-0001" },
          { status: 201 },
        );
      }
      throw new Error(`Unexpected request ${path}`);
    });
    try {
      let current = Onboarding.update(
        Onboarding.init(route, ctx).model,
        Onboarding.Message.RestoredDraft({ draft: null }),
        ctx,
      );
      for (const [field, value] of [
        ["legalName", "Manual Issuer"],
        ["workspaceName", "Test Workspace"],
        ["street", "Main 1"],
        ["city", "Prague"],
        ["postalCode", "100 00"],
        ["iban", "CZ93 2010 0000 0020 0014 5399"],
        ["bic", "FIOBCZPPXXX"],
        ["invoicePattern", "INV-YYYY-NNNN"],
        ["invoiceStart", "42"],
      ] as const) {
        current = Onboarding.update(
          current.model,
          Onboarding.Message.ChangedField({ field, value }),
          ctx,
        );
      }
      const creating = Onboarding.update(
        current.model,
        Onboarding.Message.ClickedCreateWorkspace(),
        ctx,
      );
      expect(
        Onboarding.update(creating.model, Onboarding.Message.ClickedCreateWorkspace(), ctx)
          .commands,
      ).toBeUndefined();
      const ready = Onboarding.update(creating.model, await run(creating.commands?.[0]), ctx);
      const failedCreate = Onboarding.update(ready.model, await run(ready.commands?.[0]), ctx);
      expect(failedCreate.model.submitFailure).not.toBeNull();
      expect(failedCreate.model.createdWorkspace).toBeNull();
      const retryCreate = Onboarding.update(
        failedCreate.model,
        Onboarding.Message.ClickedCreateWorkspace(),
        ctx,
      );
      const retryCreateReady = Onboarding.update(
        retryCreate.model,
        await run(retryCreate.commands?.[0]),
        ctx,
      );
      const created = Onboarding.update(
        retryCreateReady.model,
        await run(retryCreateReady.commands?.[0]),
        ctx,
      );
      const failed = Onboarding.update(created.model, await run(created.commands?.[0]), ctx);
      expect(failed.outMessage).toBeUndefined();
      expect(failed.model.setupDone).toEqual({
        issuingEntity: true,
        bankAccount: false,
        series: false,
      });
      const restored = Onboarding.update(
        Onboarding.init(route, ctx).model,
        Onboarding.Message.RestoredDraft({ draft: failed.model }),
        ctx,
      );
      const edited = Onboarding.update(
        restored.model,
        Onboarding.Message.ChangedField({ field: "bic", value: "WRONGBIC" }),
        ctx,
      );
      expect(edited.model.bic).toBe("FIOBCZPPXXX");
      const retry = Onboarding.update(
        edited.model,
        Onboarding.Message.ClickedCreateWorkspace(),
        ctx,
      );
      const retrySetup = Onboarding.update(retry.model, await run(retry.commands?.[0]), ctx);
      expect(retrySetup.model.bankRequestKey).toBe(failed.model.bankRequestKey);
      expect(retrySetup.model.seriesRequestKeys).toEqual(failed.model.seriesRequestKeys);
      const retryMessage = await run(retrySetup.commands?.[0]);
      expect({ retryMessage, calls }).toMatchObject({ retryMessage: { _tag: "CompletedSetup" } });
      const done = Onboarding.update(retrySetup.model, retryMessage, ctx);
      expect(done.outMessage?._tag).toBe("ReloadSession");
      expect(done.outMessage).toHaveProperty("destination", {
        _tag: "Path",
        path: "/w/wire-setup",
        replace: true,
      });
      expect(createKeys[0]).toBeTruthy();
      expect(createKeys[1]).toBe(createKeys[0]);
      expect(bankKeys[0]).toBeTruthy();
      expect(bankKeys[1]).toBe(bankKeys[0]);
      const savedSeriesKeys = ready.model.seriesRequestKeys;
      if (savedSeriesKeys === undefined)
        throw new Error("Expected request keys before the first write");
      expect(seriesKeys).toEqual({
        proforma: savedSeriesKeys.proforma,
        credit_note: savedSeriesKeys.credit_note,
      });
      expect(calls).toEqual([
        "POST /api/v1/workspaces",
        "POST /api/v1/workspaces",
        `GET ${base}`,
        `PATCH ${base}/issuing-entity`,
        `POST ${base}/bank-accounts`,
        `POST ${base}/bank-accounts`,
        `GET ${base}/numbering-series`,
        `PUT ${base}/numbering-series/${invoice.id}`,
        `POST ${base}/numbering-series`,
        `POST ${base}/numbering-series`,
      ]);
    } finally {
      fetch.mockRestore();
    }
  });

  test("pasting a full address splits into empty onboarding inputs and leaves single-part pastes alone", async () => {
    const route: Onboarding.Route = { _tag: "Onboarding" };
    const ctx = ctxFor(route, { locale: "en", session: signedIn });
    const OnboardingPage = definePage("Onboarding", Onboarding);
    const streetInput = Locator.attr("id", "onb-street");
    const cityInput = Locator.attr("id", "onb-city");
    const postalInput = Locator.attr("id", "onb-postal");
    const readyModel = Onboarding.update(
      Onboarding.init(route, ctx).model,
      Onboarding.Message.RestoredDraft({ draft: null }),
      ctx,
    ).model;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scene = yield* HtmlScene.make(OnboardingPage, ctx);
          scene.given(readyModel);

          // Pasting a single street line is not intercepted, so the browser paste runs as normal.
          scene.fire(streetInput, "paste", { text: "Jankovcova 1522/53" }).expectIgnored();

          // Pasting a full address into Street prefills Street, City, and Postal code.
          scene
            .fire(streetInput, "paste", {
              text: "Na Florenci 2116/15, Nové Město, 110 00 Praha 1, Česká republika",
            })
            .expectDefaultPrevented()
            .expect(streetInput)
            .toHaveValue("Na Florenci 2116/15")
            .expect(cityInput)
            .toHaveValue("Praha 1")
            .expect(postalInput)
            .toHaveValue("110 00");

          // Pre-filled sibling fields stay untouched when pasting a multiline address into City.
          scene
            .type(streetInput, "Korunní 1")
            .type(cityInput, "")
            .type(postalInput, "")
            .fire(cityInput, "paste", { text: "Jankovcova 1522/53\n170 00 Praha 7" })
            .expectDefaultPrevented()
            .expect(streetInput)
            .toHaveValue("Korunní 1")
            .expect(cityInput)
            .toHaveValue("Praha 7")
            .expect(postalInput)
            .toHaveValue("170 00");
        }),
      ),
    );
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
