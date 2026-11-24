/**
 * Test helpers shared by every page group: a PageContext builder, demo session fixtures, and a
 * server render of any path through the real root program (Foldkit experimental Server).
 */
import { Effect } from "effect";
import type { Runtime } from "foldkit";
import { Server } from "foldkit/experimental";
import type { PageContext, Route } from "../../src/app/page";
import { defaultPrefs, type Locale } from "../../src/app/prefs";
import type { SessionState } from "../../src/app/session";
import { DEMO_USER, DEMO_WORKSPACE, DEMO_WORKSPACES } from "../../src/demo/shell";
import { Flags, init, Message, Model, update, view } from "../../src/main";

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
  opts: { locale?: Locale; session?: SessionState } = {},
): PageContext => {
  const session = opts.session ?? signedIn;
  return {
    route,
    prefs: defaultPrefs(opts.locale ?? "cs"),
    locale: opts.locale ?? "cs",
    session,
    workspace:
      "ws" in route && session._tag === "SignedIn"
        ? (session.workspaces.find((w) => w.slug === route.ws) ?? null)
        : null,
  };
};

const routing = {
  onUrlRequest: (request: Parameters<typeof Message.ClickedLink>[0]["request"]) =>
    Message.ClickedLink({ request }),
  onUrlChange: (url: Parameters<typeof Message.ChangedUrl>[0]["url"]) =>
    Message.ChangedUrl({ url }),
};

// A server render never runs Commands, so the WebServices requirement of init/update is erased for
// renderToString, which only accepts programs without Resources.
const initForRender = init as unknown as Runtime.RoutingApplicationInit<Model, Message, Flags>;
const updateForRender = update as unknown as (
  model: Model,
  message: Message,
) => { readonly model: Model };

const renderConfig = { Model, Flags, init: initForRender, update: updateForRender, view, routing };

/** Server-renders `path` with the given session; resolves to the HTML and document title. */
export const renderPath = (
  path: string,
  opts: { locale?: Locale; session?: SessionState } = {},
): Promise<{ readonly html: string; readonly title: string }> =>
  Effect.runPromise(
    Server.renderToString(
      // The overloads cannot infer this program shape; the call is checked at runtime by the smoke tests.
      renderConfig as never,
      {
        url: `http://localhost${path}`,
        flags: { prefs: defaultPrefs(opts.locale ?? "cs"), session: opts.session ?? signedIn },
        buildId: "test",
      } as never,
    ),
  );
