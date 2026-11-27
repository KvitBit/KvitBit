/**
 * Tier 2 TEA & architecture invariants for @kvitbit/web:
 *   1. Route codec round-trip (`toPath -> fromPath`) and Shell access gate invariants.
 *   2. `Remote<A>` sequence-guard invariants (stale/out-of-order/post-settlement replies dropped).
 *   3. Shell `update` invariants (unmounted page messages dropped, workspace switcher toggle/close,
 *      prefs serialize/parse round-trip across all presets and random custom seeds).
 *   4. Static architecture checks (zero React imports, zero direct document./window. DOM mutations
 *      in `src/page/**` outside Command effects, zero raw hex literals in `src/styles/pages/**`).
 */
import { describe, expect, test } from "bun:test";
// @effect-diagnostics-next-line nodeBuiltinImport:off The filesystem scan runs synchronously in this Bun test.
import { readdirSync, readFileSync } from "node:fs";
import { Router } from "@effect/ui";
import {
  AttachmentId,
  ContactId,
  DocumentId,
  ExpenseId,
  IsoDate,
  ShareToken,
  TemplateId,
  type ThemeContrast,
  type ThemeMode,
  type ThemePresetId,
  type ThemeStyle,
  WorkspaceSlug,
} from "@kvitbit/domain";
import { I18n, Theme, ViewModels } from "@kvitbit/ui-port";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Path from "effect/Path";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as fc from "fast-check";
import ts from "typescript";
import type { Failure } from "../../src/app/api";
import { Intent_ } from "../../src/app/intent";
import type { Route } from "../../src/app/page";
import {
  defaultPrefs,
  type Locale,
  PREFS_COOKIE,
  type Prefs,
  parsePrefs,
  readCookie,
  serializePrefs,
} from "../../src/app/prefs";
import * as Remote from "../../src/app/remote";
import {
  BrowserRoutes,
  type Gate,
  gate,
  href,
  NOT_FOUND,
  routeFromPath,
} from "../../src/app/routing";
import type { SessionState } from "../../src/app/session";
import { DEMO_USER, DEMO_WORKSPACE, DEMO_WORKSPACES, demoId } from "../../src/demo/shell";
import { init, Message, type Model, Navigate, update } from "../../src/main";

const { join, relative, resolve } = Path.Path.pipe(Effect.provide(Path.layer), Effect.runSync);
const WEB_SRC = resolve(import.meta.dirname, "../../src");

const arbSlug = fc
  .stringMatching(/^[a-z][a-z0-9]{2,8}(-[a-z0-9]{1,6})?$/)
  .map((s) => WorkspaceSlug.make(s));

const arbUuid = fc.integer({ min: 1, max: 10_000 }).map((n) => demoId(n));
const arbDocId = arbUuid.map((s) => DocumentId.make(s));
const arbContactId = arbUuid.map((s) => ContactId.make(s));
const arbTemplateId = arbUuid.map((s) => TemplateId.make(s));
const arbExpenseId = arbUuid.map((s) => ExpenseId.make(s));
const arbAttachmentId = arbUuid.map((s) => AttachmentId.make(s));

const arbSafeToken = fc.stringMatching(/^[a-zA-Z0-9._-]{1,24}$/);
const arbSearchText = fc.stringMatching(/^[a-zA-Z0-9 _.-]{1,24}$/);

const arbIsoDate = fc
  .tuple(
    fc.integer({ min: 2024, max: 2030 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
  )
  .map(([y, m, d]) =>
    IsoDate.make(`${y}-${Str.padStart(2, "0")(String(m))}-${Str.padStart(2, "0")(String(d))}`),
  );

const arbPeriod = fc.oneof(
  fc.integer({ min: 2024, max: 2030 }).map((y) => String(y)),
  fc
    .tuple(fc.integer({ min: 2024, max: 2030 }), fc.integer({ min: 1, max: 4 }))
    .map(([y, q]) => `${y}-Q${q}`),
  fc
    .tuple(fc.integer({ min: 2024, max: 2030 }), fc.integer({ min: 1, max: 12 }))
    .map(([y, m]) => `${y}-${Str.padStart(2, "0")(String(m))}`),
);

const arbRoute: fc.Arbitrary<Route> = fc.oneof(
  fc.constant<Route>({ _tag: "Landing" }),
  fc
    .constantFrom("terms" as const, "privacy" as const)
    .map((page): Route => ({ _tag: "Legal", page })),
  fc
    .option(arbSafeToken, { nil: undefined })
    .map(
      (invitation): Route =>
        invitation === undefined ? { _tag: "SignUp" } : { _tag: "SignUp", invitation },
    ),
  fc
    .option(fc.constantFrom("/w/novak-design", "/account/profile", "/"), { nil: undefined })
    .map(
      (returnTo): Route =>
        returnTo === undefined ? { _tag: "SignIn" } : { _tag: "SignIn", returnTo },
    ),
  fc
    .constantFrom("jana@example.cz", "user+1@test.org")
    .map((email): Route => ({ _tag: "CheckEmail", email })),
  fc
    .tuple(fc.constantFrom("verify" as const, "magic" as const, "reset" as const), arbSafeToken)
    .map(([kind, token]): Route => ({ _tag: "AuthLink", kind, token })),
  fc
    .option(arbSafeToken, { nil: undefined })
    .map(
      (token): Route =>
        token === undefined ? { _tag: "ResetPassword" } : { _tag: "ResetPassword", token },
    ),
  fc.constant<Route>({ _tag: "AndroidDownload" }),
  arbSafeToken.map((t): Route => ({ _tag: "Share", token: ShareToken.make(`v1.${t}`) })),
  arbSafeToken.map((consentId): Route => ({ _tag: "McpConsent", consentId })),
  arbSafeToken.map((token): Route => ({ _tag: "Invitation", token })),
  fc
    .constantFrom("not_found" as const, "no_access" as const, "server" as const, "offline" as const)
    .map((kind): Route => ({ _tag: "Error", kind })),
  fc
    .option(fc.integer({ min: 1, max: 4 }), { nil: undefined })
    .map(
      (step): Route => (step === undefined ? { _tag: "Onboarding" } : { _tag: "Onboarding", step }),
    ),
  fc
    .constantFrom(
      "profile" as const,
      "appearance" as const,
      "security" as const,
      "sessions" as const,
      "danger" as const,
    )
    .map((tab): Route => ({ _tag: "Account", tab })),
  arbSlug.map((ws): Route => ({ _tag: "Dashboard", ws })),
  fc
    .record(
      {
        ws: arbSlug,
        text: arbSearchText,
        status: fc.constantFrom("draft" as const, "issued" as const, "cancelled" as const),
        kind: fc.constantFrom(
          "invoice" as const,
          "proforma" as const,
          "payment_tax_document" as const,
          "credit_note" as const,
        ),
        settlement: fc.constantFrom(
          "unpaid" as const,
          "partially_paid" as const,
          "paid" as const,
          "overpaid" as const,
        ),
        overdue: fc.boolean(),
        contact: arbContactId,
        from: arbIsoDate,
        to: arbIsoDate,
      },
      { requiredKeys: ["ws"] },
    )
    .map(({ ws, ...query }): Route => ({ _tag: "Documents", ws, query })),
  fc
    .record(
      {
        ws: arbSlug,
        kind: fc.constantFrom("invoice" as const, "proforma" as const),
        from: fc.oneof(
          arbContactId.map((id) => ({ _tag: "Contact" as const, id })),
          arbTemplateId.map((id) => ({ _tag: "Template" as const, id })),
          arbDocId.map((id) => ({ _tag: "Duplicate" as const, id })),
        ),
      },
      { requiredKeys: ["ws", "kind"] },
    )
    .map((r): Route => ({ _tag: "DocumentNew", ...r })),
  fc.tuple(arbSlug, arbDocId).map(([ws, id]): Route => ({ _tag: "DocumentEdit", ws, id })),
  fc
    .record(
      {
        ws: arbSlug,
        id: arbDocId,
        tab: fc.constantFrom(
          "preview" as const,
          "payments" as const,
          "share" as const,
          "history" as const,
        ),
        dialog: fc.constantFrom(
          "issue" as const,
          "payment" as const,
          "send" as const,
          "cancel" as const,
          "correct" as const,
        ),
      },
      { requiredKeys: ["ws", "id", "tab"] },
    )
    .map((r): Route => ({ _tag: "Document", ...r })),
  arbSlug.map((ws): Route => ({ _tag: "Templates", ws })),
  fc
    .record({
      ws: arbSlug,
      id: fc.oneof(arbTemplateId, fc.constant("new" as const)),
      tab: fc.constantFrom("template" as const, "schedule" as const, "runs" as const),
    })
    .map((r): Route => ({ _tag: "Template", ...r })),
  fc
    .record(
      {
        ws: arbSlug,
        text: arbSearchText,
        incomplete: fc.boolean(),
      },
      { requiredKeys: ["ws"] },
    )
    .map(({ ws, ...query }): Route => ({ _tag: "Expenses", ws, query })),
  arbSlug.map((ws): Route => ({ _tag: "ExpenseCapture", ws })),
  fc
    .record(
      {
        ws: arbSlug,
        id: fc.oneof(arbExpenseId, fc.constant("new" as const)),
        mode: fc.constantFrom("view" as const, "edit" as const),
        attachment: arbAttachmentId,
        job: arbSafeToken,
      },
      { requiredKeys: ["ws", "id", "mode"] },
    )
    .map((r): Route => ({ _tag: "Expense", ...r })),
  fc
    .record(
      {
        ws: arbSlug,
        text: arbSearchText,
        role: fc.constantFrom("customer" as const, "supplier" as const),
        archived: fc.boolean(),
      },
      { requiredKeys: ["ws"] },
    )
    .map(({ ws, ...query }): Route => ({ _tag: "Contacts", ws, query })),
  fc
    .record({
      ws: arbSlug,
      id: fc.oneof(arbContactId, fc.constant("new" as const)),
      mode: fc.constantFrom("view" as const, "edit" as const),
    })
    .map((r): Route => ({ _tag: "Contact", ...r })),
  fc
    .record({ ws: arbSlug, text: arbSearchText }, { requiredKeys: ["ws"] })
    .map((r): Route => ({ _tag: "PriceList", ...r })),
  fc
    .record({
      ws: arbSlug,
      report: fc.constantFrom(...ViewModels.ReportTab.literals),
      period: arbPeriod,
    })
    .map((r): Route => ({ _tag: "Reports", ...r })),
  fc
    .record({
      ws: arbSlug,
      section: fc.constantFrom(...ViewModels.SettingsSection.literals),
    })
    .map((r): Route => ({ _tag: "Settings", ...r })),
  arbSlug.map((ws): Route => ({ _tag: "More", ws })),
);

// Representative sample of every single one of the 30 Route tags for exhaustive gate verification.
const WS_MEMBER = DEMO_WORKSPACE.slug;
const WS_NON_MEMBER = WorkspaceSlug.make("foreign-workspace");

const sampleRoutesFor = (ws: WorkspaceSlug): ReadonlyArray<Route> => [
  { _tag: "Landing" },
  { _tag: "Legal", page: "terms" },
  { _tag: "SignUp" },
  { _tag: "SignIn" },
  { _tag: "CheckEmail", email: "a@b.cz" },
  { _tag: "AuthLink", kind: "verify", token: "tok1" },
  { _tag: "ResetPassword" },
  { _tag: "AndroidDownload" },
  { _tag: "Share", token: ShareToken.make("v1.tok") },
  { _tag: "McpConsent", consentId: "c1" },
  { _tag: "Invitation", token: "inv1" },
  { _tag: "Error", kind: "not_found" },
  { _tag: "Onboarding" },
  { _tag: "Account", tab: "profile" },
  { _tag: "Dashboard", ws },
  { _tag: "Documents", ws, query: {} },
  { _tag: "DocumentNew", ws, kind: "invoice" },
  { _tag: "DocumentEdit", ws, id: DocumentId.make(demoId(10)) },
  { _tag: "Document", ws, id: DocumentId.make(demoId(10)), tab: "preview" },
  { _tag: "Templates", ws },
  { _tag: "Template", ws, id: "new", tab: "template" },
  { _tag: "Expenses", ws, query: {} },
  { _tag: "ExpenseCapture", ws },
  { _tag: "Expense", ws, id: "new", mode: "view" },
  { _tag: "Contacts", ws, query: {} },
  { _tag: "Contact", ws, id: "new", mode: "view" },
  { _tag: "PriceList", ws },
  { _tag: "Reports", ws, report: "revenue", period: "2026" },
  { _tag: "Settings", ws, section: "issuingEntity" },
  { _tag: "More", ws },
];

const expectedScope = {
  Landing: "public",
  Legal: "public",
  SignUp: "public",
  SignIn: "public",
  CheckEmail: "public",
  AuthLink: "public",
  ResetPassword: "public",
  AndroidDownload: "public",
  Share: "public",
  McpConsent: "public",
  Invitation: "public",
  Error: "public",
  Onboarding: "account",
  Account: "account",
  Dashboard: "workspace",
  Documents: "workspace",
  DocumentNew: "workspace",
  DocumentEdit: "workspace",
  Document: "workspace",
  Templates: "workspace",
  Template: "workspace",
  Expenses: "workspace",
  ExpenseCapture: "workspace",
  Expense: "workspace",
  Contacts: "workspace",
  Contact: "workspace",
  PriceList: "workspace",
  Reports: "workspace",
  Settings: "workspace",
  More: "workspace",
} satisfies Record<Route["_tag"], "public" | "account" | "workspace">;

const mkFailure = (tag = "Offline"): Failure => ({
  tag,
  surface: "banner",
  text: { key: "error.offline" },
  issues: [],
  retryable: true,
  staleRevision: false,
  freshBotProof: false,
  requestId: null,
});

const bootModel = (path: string, session: SessionState, prefs: Prefs = defaultPrefs("cs")): Model =>
  init({ path, prefs, session, today: "2026-11-26" }).model;

// --- 1. Route round-trip & Shell gate invariants -------------------------------------------------

describe("route round-trip & Shell access gate invariants", () => {
  test("toPath -> fromPath round-trips across all 30 Route variants (fast-check)", async () => {
    await fc.assert(
      fc.property(arbRoute, (route) => {
        const path = href(route);
        expect(Str.startsWith("/")(path)).toBe(true);
        const parsed = routeFromPath(path);
        expect(parsed).toEqual(route);
      }),
      { numRuns: 200, seed: 20261124 },
    );
  });

  test("Effect UI router preserves app URLs and leaves other mount points native", () => {
    for (const route of sampleRoutesFor(WS_MEMBER)) {
      const matched = Option.getOrThrow(BrowserRoutes.parse(href(route)));
      expect(matched._tag).not.toBe("UnknownPath");
    }
    expect(routeFromPath("/s/v1.demo")).toEqual(routeFromPath("/i/v1.demo"));
    expect(routeFromPath("/consent/demo")).toEqual(routeFromPath("/oauth/consent?consent_id=demo"));
    expect(Option.getOrThrow(BrowserRoutes.parse("/s/v1.demo"))._tag).toBe("ShareAlias");
    expect(Option.getOrThrow(BrowserRoutes.parse("/consent/demo"))._tag).toBe("McpConsentAlias");
    expect(Option.getOrThrow(BrowserRoutes.parse("/i/demo.pdf"))._tag).toBe("Share");
    expect(Option.getOrThrow(BrowserRoutes.parse("/s/demo.pdf"))._tag).toBe("ShareAlias");

    for (const url of [
      "/app",
      "/app/",
      "/app/w/example",
      "/api/v1/shares/token/pdf",
      "/api/auth/get-session",
      "/download.pdf?language=en",
      "/legal/unknown.pdf",
    ]) {
      expect(BrowserRoutes.parse(url).pipe(Option.isNone)).toBe(true);
    }
  });

  test("unknown paths resolve to NOT_FOUND", () => {
    for (const bad of ["/no/such/page", "/w/", "/legal/unknown", "/account/nope", "/error/bogus"]) {
      expect(routeFromPath(bad)).toEqual(NOT_FOUND);
    }
  });

  test("Shell gate exhaustively enforces public/account/workspace across all 5 session states", () => {
    const signedInSession: SessionState = {
      _tag: "SignedIn",
      user: { ...DEMO_USER },
      workspaces: DEMO_WORKSPACES,
    };
    const unavailableSession: SessionState = {
      _tag: "Unavailable",
      failure: mkFailure("Offline"),
    };
    const sessions: ReadonlyArray<SessionState> = [
      { _tag: "Unknown" },
      { _tag: "Anonymous" },
      unavailableSession,
      signedInSession,
    ];

    const memberRoutes = sampleRoutesFor(WS_MEMBER);
    const nonMemberRoutes = sampleRoutesFor(WS_NON_MEMBER);
    expect(new Set<string>(Arr.map(memberRoutes, (route) => route._tag))).toEqual(
      new Set(Rec.keys(expectedScope)),
    );

    let checks = 0;

    for (const route of memberRoutes) {
      const scope = expectedScope[route._tag];
      for (const session of sessions) {
        const result = gate(route, session, href(route));
        checks += 1;
        const expected: Gate =
          scope === "public" || session._tag === "SignedIn"
            ? { _tag: "Allow" }
            : session._tag === "Unknown"
              ? { _tag: "Wait" }
              : session._tag === "Unavailable"
                ? { _tag: "Retry" }
                : { _tag: "Redirect", route: { _tag: "SignIn", returnTo: href(route) } };
        expect(result).toEqual(expected);
      }
    }

    // Signed-in non-member on every workspace route must redirect to no_access
    for (const route of nonMemberRoutes) {
      const scope = expectedScope[route._tag];
      const result = gate(route, signedInSession, href(route));
      checks += 1;
      const expected: Gate =
        scope === "workspace"
          ? { _tag: "Redirect", route: { _tag: "Error", kind: "no_access" } }
          : { _tag: "Allow" };
      expect(result).toEqual(expected);
    }

    expect(checks).toBe(Rec.keys(expectedScope).length * 5);
  });
});

// --- 2. Remote<A> sequence-guard invariants ------------------------------------------------------

describe("Remote<A> sequence-guard invariants", () => {
  type Op =
    | { readonly kind: "load" }
    | { readonly kind: "succeed"; readonly seqDelta: -2 | -1 | 0 | 1; readonly value: number }
    | { readonly kind: "fail"; readonly seqDelta: -2 | -1 | 0 | 1; readonly msg: string };

  const arbOp: fc.Arbitrary<Op> = fc.oneof(
    fc.constant<Op>({ kind: "load" }),
    fc.record({
      kind: fc.constant("succeed" as const),
      seqDelta: fc.constantFrom(-2 as const, -1 as const, 0 as const, 1 as const),
      value: fc.integer({ min: -1000, max: 1000 }),
    }),
    fc.record({
      kind: fc.constant("fail" as const),
      seqDelta: fc.constantFrom(-2 as const, -1 as const, 0 as const, 1 as const),
      msg: fc.constantFrom("timeout", "offline", "server"),
    }),
  );

  test("stale, future, and post-settlement replies never overwrite newer loads or data (fast-check)", async () => {
    await fc.assert(
      fc.property(fc.array(arbOp, { minLength: 1, maxLength: 50 }), (ops) => {
        let state: Remote.Remote<number> = Remote.idle;

        for (const op of ops) {
          const prev = state;
          const prevSeq = Remote.seqOf(prev);
          let expected: Remote.Remote<number>;
          let ignoredReply = false;

          switch (op.kind) {
            case "load": {
              state = Remote.load(prev);
              const seq = prevSeq + 1;
              expected =
                prev._tag === "Loaded" || prev._tag === "Refreshing"
                  ? { _tag: "Refreshing", seq, data: prev.data }
                  : { _tag: "Loading", seq };
              break;
            }
            case "succeed": {
              const targetSeq = Math.max(0, prevSeq + op.seqDelta);
              state = Remote.succeed(prev, targetSeq, op.value);
              ignoredReply = !Remote.isPending(prev) || targetSeq !== prevSeq;
              expected = ignoredReply ? prev : { _tag: "Loaded", seq: prevSeq, data: op.value };
              break;
            }
            case "fail": {
              const targetSeq = Math.max(0, prevSeq + op.seqDelta);
              const failure: Failure = mkFailure(op.msg);
              state = Remote.fail(prev, targetSeq, failure);
              ignoredReply = !Remote.isPending(prev) || targetSeq !== prevSeq;
              expected = ignoredReply ? prev : { _tag: "Failed", seq: prevSeq, failure };
              break;
            }
          }

          expect(state).toEqual(expected);
          expect(Remote.isPending(state)).toBe(
            expected._tag === "Loading" || expected._tag === "Refreshing",
          );
          expect(Remote.dataOf(state)).toBe(
            expected._tag === "Loaded" || expected._tag === "Refreshing"
              ? expected.data
              : undefined,
          );
          expect(ignoredReply && state !== prev).toBe(false);
          expect(Remote.seqOf(state)).toBeGreaterThanOrEqual(prevSeq);
        }
      }),
      { numRuns: 200, seed: 20261125 },
    );
  });

  test("deterministic out-of-order reply scenario: slow load #1 cannot overwrite load #2", () => {
    const r1 = Remote.load<string>(Remote.idle);
    expect(r1).toEqual({ _tag: "Loading", seq: 1 });

    const r2 = Remote.load(r1);
    expect(r2).toEqual({ _tag: "Loading", seq: 2 });

    // Stale reply for seq 1 is ignored
    const afterStale = Remote.succeed(r2, 1, "stale-v1");
    expect(afterStale).toBe(r2);

    // Current reply for seq 2 succeeds
    const afterCurrent = Remote.succeed(afterStale, 2, "fresh-v2");
    expect(afterCurrent).toEqual({ _tag: "Loaded", seq: 2, data: "fresh-v2" });

    // Duplicate/late failure for seq 2 after settlement is ignored
    const afterLateFail = Remote.fail(afterCurrent, 2, mkFailure("Offline"));
    expect(afterLateFail).toBe(afterCurrent);

    // Refresh preserves shown data while seq advances to 3
    const r3 = Remote.load(afterCurrent);
    expect(r3).toEqual({ _tag: "Refreshing", seq: 3, data: "fresh-v2" });
    expect(Remote.succeed(r3, 2, "old")).toBe(r3);
  });
});

// --- 3. Shell update & prefs invariants ----------------------------------------------------------

describe("Shell update & prefs invariants", () => {
  const signedInSession: SessionState = {
    _tag: "SignedIn",
    user: { ...DEMO_USER },
    workspaces: DEMO_WORKSPACES,
  };

  test("redirects only after the request that refreshes the session succeeds", () => {
    const path = "/sign-in";
    const destination = `/w/${WS_MEMBER}/documents`;
    const signedOut = bootModel(path, { _tag: "Anonymous" });
    const refresh = update(
      signedOut,
      Message.PageIntent({
        path,
        intent: Intent_.reloadSession({ _tag: "Path", path: destination, replace: true }),
      }),
    );
    expect(refresh.model.path).toBe(path);
    expect(refresh.model.pendingNav).toEqual({ _tag: "Path", path: destination, replace: true });
    expect(refresh.commands).toHaveLength(1);

    const stale = update(
      refresh.model,
      Message.LoadedSession({ seq: signedOut.sessionSeq, state: signedInSession }),
    );
    expect(stale.model).toBe(refresh.model);

    const loaded = update(
      refresh.model,
      Message.LoadedSession({ seq: refresh.model.sessionSeq, state: signedInSession }),
    );
    expect(loaded.model.session).toEqual(signedInSession);
    expect(loaded.commands?.[0]).toMatchObject({ args: { path: destination, replace: true } });
    const navigated = update(loaded.model, Message.ChangedUrl({ path: destination }));
    expect(navigated.model).toMatchObject({ path: destination, waitingForSession: false });
    expect(navigated.model.route._tag).toBe("Documents");
  });

  test("plain sign-in selects a workspace or onboarding from the refreshed membership", () => {
    const path = "/sign-in";
    const signedOut = bootModel(path, { _tag: "Anonymous" });
    const refresh = update(
      signedOut,
      Message.PageIntent({ path, intent: Intent_.reloadSession({ _tag: "DefaultSignedIn" }) }),
    );
    for (const [state, destination] of [
      [signedInSession, `/w/${WS_MEMBER}`],
      [{ ...signedInSession, workspaces: [] }, "/onboarding"],
    ] as const) {
      const loaded = update(
        refresh.model,
        Message.LoadedSession({ seq: refresh.model.sessionSeq, state }),
      );
      expect(loaded.commands?.[0]).toMatchObject({ args: { path: destination, replace: true } });
      const result = update(loaded.model, Message.ChangedUrl({ path: destination }));
      expect(result.model).toMatchObject({ path: destination, waitingForSession: false });
    }
  });

  test("ignores intents from other routes and while the protected shell waits", () => {
    const path = `/w/${WS_MEMBER}/documents`;
    const intent = Intent_.toast("stale", "info");
    const open = bootModel(path, signedInSession);
    expect(update(open, Message.PageIntent({ path: "/", intent })).model).toBe(open);
    const waiting = bootModel(path, { _tag: "Unknown" });
    expect(waiting.waitingForSession).toBe(true);
    expect(update(waiting, Message.PageIntent({ path, intent })).model).toBe(waiting);
  });

  test("the shell navigation command accepts same-origin destinations only", async () => {
    const actual = await Effect.runPromise(
      Effect.gen(function* () {
        const router = yield* Router.Router;
        const external = yield* Navigate.make({ path: "https://example.invalid/", replace: false })
          .effect;
        const internal = yield* Navigate.make({ path: "/sign-in", replace: false }).effect;
        return { external, internal, path: router.location().url };
      }).pipe(
        Effect.provide(
          Navigate.layer.pipe(Layer.provideMerge(Router.memory({ routes: BrowserRoutes }))),
        ),
      ),
    );
    expect(actual).toEqual({ external: "blocked", internal: "navigated", path: "/sign-in" });
  });

  test("workspace switcher toggle, close, shortcut, and navigation reset invariants", () => {
    const wsModel = bootModel(`/w/${WS_MEMBER}`, signedInSession);
    expect(wsModel.switcherOpen).toBe(false);

    const opened = update(wsModel, Message.ToggledSwitcher()).model;
    expect(opened.switcherOpen).toBe(true);

    const toggledClosed = update(opened, Message.ToggledSwitcher()).model;
    expect(toggledClosed.switcherOpen).toBe(false);

    const shortcutOpened = update(toggledClosed, Message.PressedSwitcherShortcut()).model;
    expect(shortcutOpened.switcherOpen).toBe(true);

    const closed = update(shortcutOpened, Message.ClosedSwitcher()).model;
    expect(closed.switcherOpen).toBe(false);

    // Idempotent close
    expect(update(closed, Message.ClosedSwitcher()).model.switcherOpen).toBe(false);

    // Navigation closes an open switcher
    const afterNav = update(
      shortcutOpened,
      Message.ChangedUrl({ path: `/w/${WS_MEMBER}/documents` }),
    ).model;
    expect(afterNav.switcherOpen).toBe(false);

    // Shortcut is a no-op on public/account routes
    const publicModel = bootModel("/", signedInSession);
    expect(update(publicModel, Message.PressedSwitcherShortcut()).model.switcherOpen).toBe(false);
  });

  test("prefs serialize/parse round-trip exhaustively across all 216 preset combinations", () => {
    const locales: ReadonlyArray<Locale> = I18n.LOCALES;
    const styles: ReadonlyArray<ThemeStyle> = ["elegant", "cozy"];
    const modes: ReadonlyArray<ThemeMode> = ["system", "light", "dark"];
    const contrasts: ReadonlyArray<ThemeContrast> = ["standard", "medium", "high"];
    const presets: ReadonlyArray<ThemePresetId> = Theme.PRESET_IDS;

    let count = 0;
    for (const locale of locales) {
      for (const style of styles) {
        for (const mode of modes) {
          for (const contrast of contrasts) {
            for (const id of presets) {
              const prefs: Prefs = {
                locale,
                style,
                mode,
                contrast,
                theme: { _tag: "Preset", id },
              };
              const serialized = serializePrefs(prefs);
              const parsed = parsePrefs(serialized);
              expect(parsed).toEqual(Option.some(prefs));
              // Cookie round-trip
              const header = `other=1; ${PREFS_COOKIE}=${encodeURIComponent(serialized)}; theme=x`;
              const fromCookie = parsePrefs(readCookie(header, PREFS_COOKIE));
              expect(fromCookie).toEqual(Option.some(prefs));
              count += 1;
            }
          }
        }
      }
    }

    expect(count).toBe(2 * 2 * 3 * 3 * 6);
  });

  test("prefs serialize/parse round-trip across random custom hex seeds (fast-check)", async () => {
    const arbHex = fc
      .integer({ min: 0, max: 0xffffff })
      .map((n) => `#${Str.toUpperCase(Str.padStart(6, "0")(n.toString(16)))}`);

    const arbSeedPrefs: fc.Arbitrary<Prefs> = fc.record({
      locale: fc.constantFrom(...I18n.LOCALES),
      style: fc.constantFrom("elegant" as const, "cozy" as const),
      mode: fc.constantFrom("system" as const, "light" as const, "dark" as const),
      contrast: fc.constantFrom("standard" as const, "medium" as const, "high" as const),
      theme: arbHex.map((hex) => ({ _tag: "Seed" as const, hex })),
    });

    await fc.assert(
      fc.property(arbSeedPrefs, (prefs) => {
        const parsed = parsePrefs(serializePrefs(prefs));
        expect(parsed).toEqual(Option.some(prefs));
      }),
      { numRuns: 100, seed: 20261126 },
    );
  });

  test("parsePrefs returns None for empty and malformed inputs", () => {
    const jsonEncoder = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
    const encodeJson = (value: Schema.Json) => jsonEncoder(value).pipe(Effect.runSync);
    const malformed = [
      null,
      undefined,
      "",
      "{}",
      "not-json",
      encodeJson({
        locale: "de",
        style: "elegant",
        mode: "dark",
        contrast: "standard",
        theme: { _tag: "Preset", id: "forest" },
      }),
      encodeJson({
        locale: "cs",
        style: "brutalist",
        mode: "dark",
        contrast: "standard",
        theme: { _tag: "Preset", id: "forest" },
      }),
      encodeJson({
        locale: "cs",
        style: "elegant",
        mode: "dark",
        contrast: "standard",
        theme: { _tag: "Seed", hex: "not-hex" },
      }),
    ];
    for (const raw of malformed) {
      expect(parsePrefs(raw).pipe(Option.isNone)).toBe(true);
    }
  });
});

// --- 4. Static architecture checks ---------------------------------------------------------------

const walkFiles = (dir: string, ext: string): ReadonlyArray<string> => {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, ext));
    } else if (entry.isFile() && Str.endsWith(ext)(entry.name)) {
      results.push(full);
    }
  }
  return Arr.sort(results, Order.String);
};

const stripCssComments = (src: string): string => Str.replace(/\/\*[\s\S]*?\*\//g, "")(src);

const literal = (node: ts.Node | undefined): string | undefined =>
  Option.fromUndefinedOr(node).pipe(
    Option.filter(ts.isStringLiteralLike),
    Option.map((textNode) => textNode.text),
    Option.getOrUndefined,
  );

const member = (
  node: ts.Node,
): { readonly receiver: ts.Expression; readonly name?: string } | undefined => {
  if (ts.isPropertyAccessExpression(node))
    return { receiver: node.expression, name: node.name.text };
  if (ts.isElementAccessExpression(node)) {
    const name = literal(node.argumentExpression);
    return name === undefined ? { receiver: node.expression } : { receiver: node.expression, name };
  }
  return undefined;
};

const retired = "foldkit";
const forbiddenPackage = (name: string) =>
  Arr.some(
    ["react", "react-dom", retired],
    (root) => name === root || Str.startsWith(`${root}/`)(name),
  ) || Str.startsWith(`@${retired}/`)(name);

const domMutators = new Set([
  "innerHTML",
  "outerHTML",
  "insertAdjacentHTML",
  "appendChild",
  "removeChild",
  "replaceChild",
  "replaceChildren",
  "setAttribute",
  "removeAttribute",
  "toggleAttribute",
  "setHTML",
  "setHTMLUnsafe",
]);
const browserGlobals = new Set(["document", "window", "localStorage", "sessionStorage"]);
const effectFactories = new Set(["sync", "promise", "tryPromise", "gen", "suspend"]);

const sourceViolations = (filename: string, code: string, page: boolean): ReadonlyArray<string> => {
  const file = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  const record = (node: ts.Node, reason: string) => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    violations.push(`${filename}:${line + 1} ${reason}`);
  };
  const visit = (node: ts.Node, deferred: boolean) => {
    let imported: string | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      imported = literal(node.moduleSpecifier);
    } else if (ts.isExternalModuleReference(node)) {
      imported = literal(node.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      imported = literal(node.argument.literal);
    } else if (ts.isCallExpression(node)) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        node.expression.getText(file) === "require"
      ) {
        imported = literal(node.arguments[0]);
      }
      const call = member(node.expression);
      if (
        page &&
        call?.receiver.getText(file) === "Effect" &&
        call.name !== undefined &&
        Str.startsWith("run")(call.name)
      ) {
        record(node, "starts an Effect inside a page");
      }
    }
    if (imported !== undefined && forbiddenPackage(imported)) record(node, `imports ${imported}`);

    const access = member(node);
    if (access?.name !== undefined && Str.toLowerCase(access.name) === "innerhtml")
      record(node, "accesses raw HTML");
    if (page && !deferred && access !== undefined) {
      const receiver = access.receiver.getText(file);
      const globalMember = member(access.receiver);
      const explicitGlobal =
        globalMember?.receiver.getText(file) === "globalThis" &&
        globalMember.name !== undefined &&
        browserGlobals.has(globalMember.name);
      if (
        browserGlobals.has(receiver) ||
        explicitGlobal ||
        (receiver === "history" &&
          ["pushState", "replaceState", "go", "back", "forward"].includes(access.name ?? "")) ||
        (access.name !== undefined && domMutators.has(access.name))
      ) {
        record(node, "accesses browser state or mutates DOM outside an Effect");
      }
    }

    ts.forEachChild(node, (child) => {
      const factory =
        ts.isPropertyAssignment(node) &&
        node.name.getText(file) === "try" &&
        ts.isObjectLiteralExpression(node.parent)
          ? node.parent.parent
          : node;
      const call = ts.isCallExpression(factory) ? member(factory.expression) : undefined;
      const callback = ts.isArrowFunction(child) || ts.isFunctionExpression(child);
      const lazy =
        callback &&
        call?.receiver.getText(file) === "Effect" &&
        call.name !== undefined &&
        effectFactories.has(call.name);
      visit(child, deferred || lazy);
    });
  };
  visit(file, false);
  return violations;
};

describe("static architecture invariants", () => {
  test("detects dynamic React imports and computed DOM mutations", () => {
    const source = Arr.join(
      [
        'const view = () => { import("react/dom");',
        // biome-ignore lint/security/noSecrets: Source text for the computed DOM mutation fixture.
        'element["replaceChildren"](); };',
      ],
      " ",
    );
    expect(sourceViolations("fixture.ts", source, true)).toEqual([
      "fixture.ts:1 imports react/dom",
      "fixture.ts:1 accesses browser state or mutates DOM outside an Effect",
    ]);
  });

  test("web source and tests use the Effect UI runtime and page effects own DOM access", () => {
    const webRoot = resolve(WEB_SRC, "..");
    const files = Arr.flatMap(["src", "test", "e2e"], (dir) =>
      Arr.flatMap([".ts", ".tsx"], (ext) => walkFiles(join(webRoot, dir), ext)),
    );
    const violations = Arr.flatMap(files, (file) => {
      const path = relative(webRoot, file);
      return sourceViolations(path, readFileSync(file, "utf8"), Str.startsWith("src/page/")(path));
    });
    expect(violations).toEqual([]);
    const dependenciesSchema = Schema.Record(Schema.String, Schema.String);
    const manifestJson = Schema.fromJsonString(
      Schema.Struct({
        dependencies: Schema.optional(dependenciesSchema),
        devDependencies: Schema.optional(dependenciesSchema),
      }),
    );
    const manifest = Schema.decodeEffect(manifestJson)(
      readFileSync(join(webRoot, "package.json"), "utf8"),
    ).pipe(Effect.runSync);
    const dependencies = Rec.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(Arr.filter(dependencies, forbiddenPackage)).toEqual([]);
  });

  test("zero raw hex color literals in apps/web/src/styles/pages/**", () => {
    const stylesDir = join(WEB_SRC, "styles/pages");
    const cssFiles = walkFiles(stylesDir, ".css");
    expect(cssFiles.length).toBeGreaterThan(0);

    const hexValuePattern = /:\s*[^;{}]*#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;

    const violations: string[] = [];
    for (const file of cssFiles) {
      const clean = stripCssComments(readFileSync(file, "utf8"));
      const matches = Str.match(hexValuePattern)(clean);
      if (Option.isSome(matches)) {
        violations.push(`${relative(WEB_SRC, file)}: ${Arr.join(matches.value, ", ")}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
