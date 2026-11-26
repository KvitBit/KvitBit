/**
 * URL <-> Route for the web build (base "/"), with the Shell's access gates: account and workspace
 * routes need a session; a workspace route needs membership of that workspace.
 */

import { Route as UiRoute } from "@effect/ui";
import { ViewModels } from "@kvitbit/ui-port";
import { Option, Schema } from "effect";
import type { Route } from "./page";
import type { SessionState } from "./session";

export const NOT_FOUND: Route = { _tag: "Error", kind: "not_found" };

export const routeFromPath = (pathAndSearch: string): Route =>
  Option.getOrElse(ViewModels.Routes.fromPath(pathAndSearch, "/"), () => NOT_FOUND);

export const href = (route: Route): string => ViewModels.Routes.toPath(route, "/");

/** The current year as a report period, for nav links into Reports. */
export const defaultReportRoute = (ws: string, year: number): Route =>
  ({ _tag: "Reports", ws, report: "revenue", period: String(year) }) as Route;

export type Gate =
  | { readonly _tag: "Allow" }
  | { readonly _tag: "Wait" }
  | { readonly _tag: "Redirect"; readonly route: Route };

/** What the Shell does with a route given the session (pure). */
export const gate = (route: Route, session: SessionState): Gate => {
  const needs = ViewModels.Routes.requires(route);
  if (needs === "public") return { _tag: "Allow" };
  switch (session._tag) {
    case "Unknown":
      return { _tag: "Wait" };
    case "Unavailable":
      return { _tag: "Redirect", route: { _tag: "Error", kind: "server" } };
    case "Anonymous":
      return { _tag: "Redirect", route: { _tag: "SignIn", returnTo: href(route) } };
    case "SignedIn": {
      if (needs === "account") return { _tag: "Allow" };
      const ws = "ws" in route ? route.ws : undefined;
      const member = session.workspaces.some((w) => w.slug === ws);
      return member
        ? { _tag: "Allow" }
        : { _tag: "Redirect", route: { _tag: "Error", kind: "no_access" } };
    }
  }
};

const search = <const Key extends string>(...keys: ReadonlyArray<Key>) =>
  Object.fromEntries(keys.map((key) => [key, Schema.optionalKey(Schema.String)]));

export const magicSignInCallback = "/sign-in?magic=complete";

const workspace = { ws: Schema.String };
const resource = { ...workspace, id: Schema.String };

const webRoutes = UiRoute.union({
  Landing: UiRoute.make("/"),
  Legal: UiRoute.make("/legal/:page", { params: { page: Schema.String } }),
  SignUp: UiRoute.make("/sign-up", { search: search("invitation") }),
  SignIn: UiRoute.make("/sign-in", { search: search("returnTo", "magic") }),
  CheckEmail: UiRoute.make("/check-email", { search: search("email") }),
  AuthLink: UiRoute.make("/auth/:kind/:token", {
    params: { kind: Schema.String, token: Schema.String },
  }),
  ResetPassword: UiRoute.make("/reset-password", { search: search("token") }),
  Android: UiRoute.make("/android"),
  Share: UiRoute.make("/i/:token", { params: { token: Schema.String } }),
  ShareAlias: UiRoute.make("/s/:token", { params: { token: Schema.String } }),
  McpConsent: UiRoute.make("/oauth/consent", { search: search("consent_id") }),
  McpConsentAlias: UiRoute.make("/consent/:id", { params: { id: Schema.String } }),
  Invitation: UiRoute.make("/invite/:token", { params: { token: Schema.String } }),
  ErrorPage: UiRoute.make("/error/:kind", { params: { kind: Schema.String } }),
  Onboarding: UiRoute.make("/onboarding", { search: search("step") }),
  Account: UiRoute.make("/account/:tab", { params: { tab: Schema.String } }),
  Dashboard: UiRoute.make("/w/:ws", { params: workspace }),
  Documents: UiRoute.make("/w/:ws/documents", {
    params: workspace,
    search: search("text", "status", "kind", "settlement", "contact", "from", "to", "overdue"),
  }),
  Document: UiRoute.make("/w/:ws/documents/:id", {
    params: resource,
    search: search("tab", "dialog"),
  }),
  DocumentNew: UiRoute.make("/w/:ws/documents/new/:kind", {
    params: { ...workspace, kind: Schema.String },
    search: search("contact", "template", "duplicate"),
  }),
  DocumentEdit: UiRoute.make("/w/:ws/documents/:id/edit", { params: resource }),
  Templates: UiRoute.make("/w/:ws/templates", { params: workspace }),
  Template: UiRoute.make("/w/:ws/templates/:id", { params: resource, search: search("tab") }),
  Expenses: UiRoute.make("/w/:ws/expenses", {
    params: workspace,
    search: search("text", "incomplete"),
  }),
  ExpenseCapture: UiRoute.make("/w/:ws/expenses/capture", { params: workspace }),
  Expense: UiRoute.make("/w/:ws/expenses/:id", {
    params: resource,
    search: search("mode", "attachment", "job"),
  }),
  Contacts: UiRoute.make("/w/:ws/contacts", {
    params: workspace,
    search: search("text", "role", "archived"),
  }),
  Contact: UiRoute.make("/w/:ws/contacts/:id", { params: resource, search: search("mode") }),
  PriceList: UiRoute.make("/w/:ws/price-list", {
    params: workspace,
    search: {
      text: Schema.optionalKey(Schema.String),
      archived: Schema.optionalKey(Schema.String),
    },
  }),
  Reports: UiRoute.make("/w/:ws/reports/:report", {
    params: { ...workspace, report: Schema.String },
    search: search("period"),
  }),
  Settings: UiRoute.make("/w/:ws/settings/:section", {
    params: { ...workspace, section: Schema.String },
  }),
  More: UiRoute.make("/w/:ws/more", { params: workspace }),
  UnknownPath: UiRoute.make("/*", { params: { "*": Schema.String } }),
});

// The shared route codec owns validation and defaults. BrowserRouter owns navigation and
// leaves requests for the other app and the API to the browser.
const resolveWeb = (path: string) => {
  const pathname = path.split(/[?#]/, 1)[0] ?? "";
  if (/^\/(?:app|api|assets|fonts)(?:\/|$)/.test(pathname)) return Option.none();
  const match = webRoutes.resolve(path);
  if (
    /\.pdf$/i.test(pathname) &&
    (Option.isNone(match) ||
      match.value.notFound ||
      Option.isNone(ViewModels.Routes.fromPath(path, "/")))
  ) {
    return Option.none();
  }
  return match.pipe(Option.orElse(() => webRoutes.resolve("/error/not-found")));
};

export const BrowserRoutes = {
  ...webRoutes,
  parse: (path: string) => Option.map(resolveWeb(path), (resolved) => resolved.route),
  resolve: resolveWeb,
};
