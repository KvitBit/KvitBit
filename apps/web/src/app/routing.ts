/**
 * URL <-> Route for the web build (base "/"), with the Shell's access gates: account and workspace
 * routes need a session; a workspace route needs membership of that workspace.
 */
import { ViewModels } from "@kvitbit/ui-port";
import { Option } from "effect";
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
