import { type Renderer, Router } from "@effect/ui";
import { HtmlServer } from "@effect/ui/html";
import { Effect, Layer } from "effect";
import { RunApi } from "../../src/app/commands";
import type { PageContext, Route } from "../../src/app/page";
import { defaultPrefs, type Locale } from "../../src/app/prefs";
import { BrowserRoutes } from "../../src/app/routing";
import type { SessionState } from "../../src/app/session";
import { DEMO_USER, DEMO_WORKSPACE, DEMO_WORKSPACES } from "../../src/demo/shell";
import { App, type Flags, Navigate } from "../../src/main";

export { DEMO_USER, DEMO_WORKSPACE, DEMO_WORKSPACES };

export const signedIn: SessionState = {
  _tag: "SignedIn",
  user: { ...DEMO_USER },
  workspaces: DEMO_WORKSPACES,
};
export const anonymous: SessionState = { _tag: "Anonymous" };

export const WS = DEMO_WORKSPACE.slug;

export const ctxFor = (
  route: Route,
  opts: { locale?: Locale; session?: SessionState; today?: string } = {},
): PageContext => {
  const session = opts.session ?? signedIn;
  return {
    route,
    today: opts.today ?? "2026-11-26",
    prefs: defaultPrefs(opts.locale ?? "cs"),
    locale: opts.locale ?? "cs",
    session,
    workspace:
      "ws" in route && session._tag === "SignedIn"
        ? (session.workspaces.find((w) => w.slug === route.ws) ?? null)
        : null,
  };
};

export interface RenderedPath {
  readonly html: string;
  readonly head: string;
  readonly title: string;
  readonly flags: Flags;
  readonly state: Renderer.State;
}

/** Server-renders the same component and input the browser entry adopts. */
export const renderPath = async (
  path: string,
  opts: { locale?: Locale; session?: SessionState; today?: string } = {},
): Promise<RenderedPath> => {
  const flags: Flags = {
    path,
    today: opts.today ?? "2026-11-26",
    prefs: defaultPrefs(opts.locale ?? "cs"),
    session: opts.session ?? signedIn,
  };
  const router = Router.static({ routes: BrowserRoutes, url: path });
  const layers = Layer.merge(RunApi.layer, Navigate.layer.pipe(Layer.provideMerge(router)));
  const rendered = await Effect.runPromise(
    HtmlServer.renderToHtml(App, flags).pipe(Effect.provide(layers)),
  );
  const title = /<title[^>]*>([^<]*)<\/title>/.exec(rendered.head)?.[1] ?? "";
  return { ...rendered, title, flags };
};
