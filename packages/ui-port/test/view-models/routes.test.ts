import { describe, expect, test } from "bun:test";
import { Option, Schema } from "effect";
import {
  activeSection,
  matchShortcut,
  Route,
  type RouteBase,
  Routes,
  type RouteTag,
  sectionRoute,
  switchWorkspace,
} from "../../src/view-models";

const decode = Schema.decodeUnknownSync(Route);
const ID = "0193a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a6b";
const ID2 = "0193a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a6c";

/** One or more samples per Route tag, exercising every optional parameter. */
const SAMPLES: ReadonlyArray<Route> = [
  { _tag: "Landing" },
  { _tag: "Legal", page: "terms" },
  { _tag: "Legal", page: "privacy" },
  { _tag: "SignUp" },
  { _tag: "SignUp", invitation: "inv tok/+=" },
  { _tag: "SignIn" },
  { _tag: "SignIn", returnTo: "/w/acme/documents?status=draft" },
  { _tag: "CheckEmail", email: "a+b@example.cz" },
  { _tag: "AuthLink", kind: "magic", token: "abc_DEF-123" },
  { _tag: "AuthLink", kind: "verify", token: "t" },
  { _tag: "AuthLink", kind: "reset", token: "t" },
  { _tag: "ResetPassword" },
  { _tag: "ResetPassword", token: "r" },
  { _tag: "AndroidDownload" },
  { _tag: "McpConsent", consentId: "c-1" },
  { _tag: "Invitation", token: "inv" },
  { _tag: "Error", kind: "not_found" },
  { _tag: "Error", kind: "no_access" },
  { _tag: "Error", kind: "offline" },
  { _tag: "Onboarding" },
  { _tag: "Onboarding", step: 2 },
  { _tag: "Account", tab: "appearance" },
  ...[
    { _tag: "Share", token: "v1.aGVsbG8" },
    { _tag: "Dashboard", ws: "acme" },
    { _tag: "Documents", ws: "acme", query: {} },
    {
      _tag: "Documents",
      ws: "acme",
      query: { settlement: "partially_paid", overdue: true, from: "2026-01-01", to: "2026-03-31" },
    },
    {
      _tag: "Documents",
      ws: "acme",
      query: { text: "Nová faktura & co", status: "issued", kind: "proforma", contact: ID },
    },
    { _tag: "DocumentNew", ws: "acme", kind: "invoice" },
    { _tag: "DocumentNew", ws: "acme", kind: "proforma", from: { _tag: "Contact", id: ID } },
    { _tag: "DocumentNew", ws: "acme", kind: "invoice", from: { _tag: "Template", id: ID } },
    { _tag: "DocumentNew", ws: "acme", kind: "invoice", from: { _tag: "Duplicate", id: ID } },
    { _tag: "DocumentEdit", ws: "acme", id: ID },
    { _tag: "Document", ws: "acme", id: ID, tab: "preview" },
    { _tag: "Document", ws: "acme", id: ID, tab: "payments", dialog: "payment" },
    { _tag: "Templates", ws: "acme" },
    { _tag: "Template", ws: "acme", id: "new", tab: "template" },
    { _tag: "Template", ws: "acme", id: ID, tab: "runs" },
    { _tag: "Expenses", ws: "acme", query: {} },
    { _tag: "Expenses", ws: "acme", query: { text: "fuel", incomplete: true } },
    { _tag: "ExpenseCapture", ws: "acme" },
    { _tag: "Expense", ws: "acme", id: "new", mode: "edit", attachment: ID, job: "job-1" },
    { _tag: "Expense", ws: "acme", id: ID, mode: "view" },
    { _tag: "Contacts", ws: "acme", query: { role: "supplier", archived: false } },
    { _tag: "Contact", ws: "acme", id: "new", mode: "edit" },
    { _tag: "Contact", ws: "acme", id: ID, mode: "view" },
    { _tag: "PriceList", ws: "acme" },
    { _tag: "PriceList", ws: "acme", text: "hodina" },
    { _tag: "Reports", ws: "acme", report: "vat_summary", period: "2026-Q4" },
    { _tag: "Reports", ws: "acme", report: "revenue", period: "2026-11" },
    { _tag: "Settings", ws: "acme", section: "apiKeys" },
    { _tag: "Settings", ws: "acme", section: "dangerZone" },
    { _tag: "More", ws: "my-firm-2" },
  ].map((r) => decode(r)),
];

const ALL_TAGS: ReadonlyArray<RouteTag> = Route.members.map(
  (m) => (m.fields._tag.ast as unknown as { literal: RouteTag }).literal,
);

describe("Routes.toPath / fromPath", () => {
  test("samples cover every route", () => {
    expect(new Set(SAMPLES.map((r) => r._tag))).toEqual(new Set(ALL_TAGS));
  });

  for (const base of ["/", "/app/"] as ReadonlyArray<RouteBase>) {
    test(`round-trips every route and its canonical path (base ${base})`, () => {
      for (const route of SAMPLES) {
        const path = Routes.toPath(route, base);
        expect(path.startsWith(base)).toBe(true);
        const back = Routes.fromPath(path, base);
        expect(back).toEqual(Option.some(route));
        expect(Routes.toPath(Option.getOrThrow(back), base)).toBe(path);
      }
    });
  }

  test("canonical spellings", () => {
    const p = (r: unknown) => Routes.toPath(decode(r), "/");
    expect(p({ _tag: "Document", ws: "acme", id: ID, tab: "payments" })).toBe(
      `/w/acme/documents/${ID}?tab=payments`,
    );
    expect(p({ _tag: "Document", ws: "acme", id: ID, tab: "preview" })).toBe(
      `/w/acme/documents/${ID}`,
    );
    expect(p({ _tag: "Settings", ws: "acme", section: "connectedApps" })).toBe(
      "/w/acme/settings/connected-apps",
    );
    expect(p({ _tag: "Reports", ws: "acme", report: "vat_summary", period: "2026" })).toBe(
      "/w/acme/reports/vat-summary?period=2026",
    );
    expect(p({ _tag: "Error", kind: "not_found" })).toBe("/error/not-found");
    expect(Routes.toPath({ _tag: "Landing" }, "/app/")).toBe("/app/");
  });

  test("tolerates unknown query keys, a trailing slash, a hash and '+' for spaces", () => {
    expect(Routes.fromPath("/w/acme/price-list/?text=a+b&utm=x#top", "/")).toEqual(
      Option.some(decode({ _tag: "PriceList", ws: "acme", text: "a b" })),
    );
  });

  test("unknown or malformed paths are None", () => {
    const bad = [
      "",
      "relative/path",
      "/nope",
      "/w",
      "/w/acme/nope",
      "/w/Acme_Corp", // invalid slug
      `/w/acme/documents/not-a-uuid`,
      `/w/acme/documents/${ID}/edit/extra`,
      `/w/acme/documents/${ID}?tab=bogus`,
      "/w/acme/documents/new/credit_note",
      `/w/acme/documents?contact=${ID2.slice(0, 10)}`,
      "/w/acme/reports/revenue", // period required
      "/w/acme/reports/revenue?period=2026-13",
      "/w/acme/settings/apiKeys", // not the kebab spelling
      "/w/acme/expenses?incomplete=maybe",
      "/onboarding?step=two",
      "/legal/cookies",
      "/auth/magic",
      "/w/acme/documents?text=%E0%A4%A", // bad escape
      "/app/w/acme", // a PWA path is not a web path
    ];
    for (const path of bad) expect(Routes.fromPath(path, "/")).toEqual(Option.none());
    expect(Routes.fromPath("/w/acme", "/app/")).toEqual(Option.none());
    expect(Routes.fromPath("/application/w/acme", "/app/")).toEqual(Option.none());
  });

  test("requires", () => {
    expect(Routes.requires({ _tag: "SignIn" })).toBe("public");
    expect(Routes.requires({ _tag: "Account", tab: "profile" })).toBe("account");
    expect(Routes.requires({ _tag: "Onboarding" })).toBe("account");
    expect(Routes.requires(decode({ _tag: "Dashboard", ws: "acme" }))).toBe("workspace");
    expect(Routes.requires(decode({ _tag: "Share", token: "v1.x" }))).toBe("public");
  });
});

describe("Routes.fromDeepLink", () => {
  test("magic links, invitations and share links on https and the app scheme", () => {
    expect(Routes.fromDeepLink("https://kvitbit.cz/auth/magic/tok?x=1")).toEqual(
      Option.some({ _tag: "AuthLink", kind: "magic", token: "tok" }),
    );
    expect(Routes.fromDeepLink("https://kvitbit.cz/app/invitations/abc")).toEqual(
      Option.some({ _tag: "Invitation", token: "abc" }),
    );
    expect(Routes.fromDeepLink("kvitbit://s/v1.abc")).toEqual(
      Option.some(decode({ _tag: "Share", token: "v1.abc" })),
    );
  });
  test("other targets and junk open nothing", () => {
    expect(Routes.fromDeepLink("https://kvitbit.cz/w/acme")).toEqual(Option.none());
    expect(Routes.fromDeepLink("https://kvitbit.cz")).toEqual(Option.none());
    expect(Routes.fromDeepLink("not a url")).toEqual(Option.none());
  });
});

describe("navigation", () => {
  const doc = decode({ _tag: "Document", ws: "acme", id: ID, tab: "history" });
  const report = decode({ _tag: "Reports", ws: "acme", report: "profit", period: "2026" });
  const settings = decode({ _tag: "Settings", ws: "acme", section: "team" });

  test("active section per platform", () => {
    expect(activeSection(doc, "web")).toEqual(Option.some("documents"));
    expect(activeSection(report, "mobile")).toEqual(Option.some("more"));
    expect(activeSection(decode({ _tag: "More", ws: "acme" }), "web")).toEqual(
      Option.some("settings"),
    );
    expect(activeSection({ _tag: "SignIn" }, "web")).toEqual(Option.none());
  });

  test("workspace switch keeps the section, drops ids, else Dashboard", () => {
    const beta = decode({ _tag: "Dashboard", ws: "beta" });
    if (beta._tag !== "Dashboard") throw new Error("unreachable");
    const same = (r: Route): Route => decode({ ...r, ws: "beta" });
    expect<Route>(switchWorkspace(doc, beta.ws)).toEqual(
      decode({ _tag: "Documents", ws: "beta", query: {} }),
    );
    expect<Route>(switchWorkspace(report, beta.ws)).toEqual(same(report));
    expect<Route>(switchWorkspace(settings, beta.ws)).toEqual(same(settings));
    expect<Route>(switchWorkspace({ _tag: "Account", tab: "profile" }, beta.ws)).toEqual(beta);
    expect(sectionRoute("reports", beta.ws)).toEqual(Option.none());
  });

  test("Ctrl/Cmd+K opens the switcher", () => {
    const chord = { key: "K", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };
    expect(matchShortcut(chord, false)).toEqual(Option.some("openWorkspaceSwitcher"));
    expect(matchShortcut(chord, true)).toEqual(Option.none());
    expect(matchShortcut({ ...chord, ctrlKey: false, metaKey: true }, true)).toEqual(
      Option.some("openWorkspaceSwitcher"),
    );
    expect(matchShortcut({ ...chord, shiftKey: true }, false)).toEqual(Option.none());
  });
});
