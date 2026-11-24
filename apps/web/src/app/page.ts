/**
 * The page contract. Every screen under src/page/<group>/ is a Foldkit Submodel exporting:
 *
 *   Model    Schema of its state (a codec, so SSR can embed it and tests can generate it)
 *   Message  defineMessageUnion(...) of fact-named Messages
 *   init     (route, ctx) => PageReturn: first state + load Commands
 *   update   (model, message, ctx) => PageReturn: pure transition; OutMessage = Intent
 *   view     Submodel.defineView<Model, Message, PageContext>((model, ctx, h) => Html)
 *   title    (model, ctx) => string: document title (without the " · Kvitbit" suffix)
 *
 * The Shell re-runs `init` whenever the route changes, so a page never sees a route it does not
 * own, and drops any Message addressed to a page that is no longer mounted (see app/pages.ts).
 */
import type { WorkspaceSummary } from "@kvitbit/domain";
import type { ViewModels } from "@kvitbit/ui-port";
import type { Update } from "foldkit";
import type { WebServices } from "./api";
import type { Intent } from "./intent";
import type { Locale, Prefs } from "./prefs";
import type { SessionState } from "./session";

export type Route = ViewModels.Route;
export type RouteOf<T extends ViewModels.RouteTag> = ViewModels.RouteOf<T>;

/**
 * Read-only context every page receives in init, update and view. Plain data only: Foldkit
 * forbids functions in Submodel view inputs, so derive helpers in the page
 * (`translator(ctx.locale)` from app/i18n, `href` from app/routing).
 */
export interface PageContext {
  readonly route: Route;
  readonly prefs: Prefs;
  readonly locale: Locale;
  readonly session: SessionState;
  /** The workspace named by the route's `ws` slug, when the viewer is a member. */
  readonly workspace: WorkspaceSummary | null;
}

export type PageReturn<Model, Message> = Update.ReturnWithOutMessage<
  Model,
  Message,
  Intent,
  WebServices
>;
