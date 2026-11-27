import { type Renderer, Router } from "@effect/ui";
import { HtmlServer } from "@effect/ui/html";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import { RunApi } from "../../src/app/commands";
import type { PageContext, Route } from "../../src/app/page";
import { defaultPrefs, type Locale } from "../../src/app/prefs";
import { BrowserRoutes, href } from "../../src/app/routing";
import type { SessionState } from "../../src/app/session";
import { DEMO_USER, DEMO_WORKSPACE, DEMO_WORKSPACES } from "../../src/demo/shell";
import { App, type Flags, Navigate } from "../../src/main";

const titlePattern = /<title[^>]*>([^<]*)<\/title>/;

export { DEMO_USER, DEMO_WORKSPACE, DEMO_WORKSPACES } from "../../src/demo/shell";

export const signedIn: SessionState = {
  _tag: "SignedIn",
  user: { ...DEMO_USER },
  workspaces: DEMO_WORKSPACES,
};
export const anonymous: SessionState = { _tag: "Anonymous" };

export const WS = DEMO_WORKSPACE.slug;

interface FixtureOptions {
  readonly locale?: Locale;
  readonly session?: SessionState;
  readonly today?: string;
}

export const ctxFor: {
  (opts?: FixtureOptions): (route: Route) => PageContext;
  (route: Route, opts?: FixtureOptions): PageContext;
} = Fn.dual(
  (args) => Predicate.hasProperty(args[0], "_tag"),
  (route: Route, opts: FixtureOptions = {}): PageContext => {
    const session = opts.session ?? signedIn;
    return {
      route,
      path: href(route),
      today: opts.today ?? "2026-11-26",
      prefs: defaultPrefs(opts.locale ?? "cs"),
      locale: opts.locale ?? "cs",
      session,
      workspace:
        "ws" in route && session._tag === "SignedIn"
          ? (Option.getOrUndefined(Arr.findFirst(session.workspaces, (w) => w.slug === route.ws)) ??
            null)
          : null,
    };
  },
);

export interface RenderedPath {
  readonly html: string;
  readonly head: string;
  readonly title: string;
  readonly flags: Flags;
  readonly state: Renderer.State;
}

/** Server-renders the same component and input the browser entry adopts. */
export const renderPath: {
  (opts?: FixtureOptions): (path: string) => Promise<RenderedPath>;
  (path: string, opts?: FixtureOptions): Promise<RenderedPath>;
} = Fn.dual(
  (args) => Predicate.isString(args[0]),
  (path: string, opts: FixtureOptions = {}): Promise<RenderedPath> => {
    const flags: Flags = {
      path,
      today: opts.today ?? "2026-11-26",
      prefs: defaultPrefs(opts.locale ?? "cs"),
      session: opts.session ?? signedIn,
    };
    const router = Router.static({ routes: BrowserRoutes, url: path });
    const layers = Layer.mergeAll(
      RunApi.layer,
      Navigate.layer.pipe(Layer.provideMerge(router)),
      FetchHttpClient.layer,
    );
    return HtmlServer.renderToHtml(App, flags).pipe(
      Effect.provide(layers),
      Effect.map((rendered) => ({
        ...rendered,
        title: titlePattern.exec(rendered.head)?.[1] ?? "",
        flags,
      })),
      Effect.runPromise,
    );
  },
);
