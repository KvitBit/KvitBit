/**
 * Kvitbit web: the root Foldkit program (Shell). Owns the URL, the session, viewer preferences
 * (locale, style, mode, contrast, theme), toasts and the workspace switcher; mounts exactly one
 * page Submodel per route (app/pages.ts). `update` is pure; every effect is a Command.
 */
import { ViewModels } from "@kvitbit/ui-port";
import { Array as Arr, Effect, Option, Schema, Stream } from "effect";
import { Command, type Runtime, Subscription, type Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { load, pushUrl, replaceUrl, UrlRequest } from "foldkit/navigation";
import { toString as urlToString } from "foldkit/url";
import { authFetch, type WebServices } from "./app/api";
import type { Intent } from "./app/intent";
import type { PageContext, Route } from "./app/page";
import { initPage, pageTitle, updatePage } from "./app/pages";
import { Prefs, persistPrefs } from "./app/prefs";
import { type Flags, Message, type Model, type Toast } from "./app/root";
import { gate, href, routeFromPath } from "./app/routing";
import { fetchSession, workspaceBySlug } from "./app/session";
import { shellView } from "./app/shell";

export { Flags, Message, Model, Mount, Toast } from "./app/root";

type UpdateReturn = Update.Return<Model, Message, WebServices>;

// COMMAND

const Navigate = Command.define("Navigate", {
  args: { url: Schema.String, replace: Schema.Boolean },
  messages: [Message.CompletedNavigate],
  execute: ({ url, replace }) =>
    (replace ? replaceUrl(url) : pushUrl(url)).pipe(Effect.as(Message.CompletedNavigate())),
});

const LoadExternal = Command.define("LoadExternal", {
  args: { href: Schema.String },
  messages: [Message.CompletedNavigate],
  execute: ({ href }) => load(href).pipe(Effect.as(Message.CompletedNavigate())),
});

export const LoadSession = Command.define("LoadSession", {
  messages: [Message.LoadedSession],
  interrupt: true,
  execute: fetchSession.pipe(Effect.map((state) => Message.LoadedSession({ state }))),
});

const PersistPrefs = Command.define("PersistPrefs", {
  args: { prefs: Prefs },
  messages: [Message.CompletedPersistPrefs],
  execute: ({ prefs }) => persistPrefs(prefs).pipe(Effect.as(Message.CompletedPersistPrefs())),
});

const SignOut = Command.define("SignOut", {
  messages: [Message.CompletedSignOut],
  execute: authFetch(
    "/sign-out",
    { method: "POST", body: {} },
    () => Message.CompletedSignOut(),
    () => Message.CompletedSignOut(),
  ),
});

// CONTEXT

export const contextOf = (model: Model): PageContext => ({
  route: model.route,
  prefs: model.prefs,
  locale: model.prefs.locale,
  session: model.session,
  workspace:
    "ws" in model.route ? Option.getOrNull(workspaceBySlug(model.session, model.route.ws)) : null,
});

// MOUNTING

/** Applies the access gate and mounts the page for `route` (or the Splash while the session loads). */
const mountRoute = (model: Model, route: Route): UpdateReturn => {
  const g = gate(route, model.session);
  if (g._tag === "Wait") return { model: { ...model, route, mount: { _tag: "Splash" } } };
  if (g._tag === "Redirect") {
    const next = { ...model, route: g.route };
    const mounted = mountRoute(next, g.route);
    return {
      model: mounted.model,
      commands: [Navigate({ url: href(g.route), replace: true }), ...(mounted.commands ?? [])],
    };
  }
  const base: Model = { ...model, route, switcherOpen: false };
  const result = initPage(route, contextOf(base));
  return applyIntent(
    { ...base, mount: { _tag: "Mounted", page: result.page } },
    Command.mapMessages(result.commands, (message) => Message.GotPage({ message })),
    result.outMessage,
  );
};

const pushToast = (model: Model, text: string, tone: Toast["tone"]): Model => ({
  ...model,
  toasts: Arr.takeRight([...model.toasts, { id: model.nextToastId, text, tone }], 3),
  nextToastId: model.nextToastId + 1,
});

const setPrefs = (model: Model, prefs: Prefs): UpdateReturn => ({
  model: { ...model, prefs },
  commands: [PersistPrefs({ prefs })],
});

const applyIntent = (
  model: Model,
  commands: ReadonlyArray<Command.Command<Message, never, WebServices>>,
  intent: Intent | undefined,
): UpdateReturn => {
  if (intent === undefined) return { model, commands };
  switch (intent._tag) {
    case "Navigate":
      return {
        model,
        commands: [...commands, Navigate({ url: intent.path, replace: intent.replace })],
      };
    case "Toast":
      return { model: pushToast(model, intent.text, intent.tone), commands };
    case "SetPrefs": {
      const next = setPrefs(model, intent.prefs);
      return { model: next.model, commands: [...commands, ...(next.commands ?? [])] };
    }
    case "ReloadSession":
      return { model, commands: [...commands, LoadSession()] };
    case "SignedOut":
      return {
        model: { ...model, session: { _tag: "Anonymous" } },
        commands: [...commands, Navigate({ url: href({ _tag: "SignIn" }), replace: false })],
      };
  }
};

// INIT

export const init: Runtime.RoutingApplicationInit<Model, Message, Flags, WebServices> = (
  flags,
  url,
) => {
  const route = routeFromPath(urlToString(url).replace(/^[a-z]+:\/\/[^/]+/i, ""));
  const model: Model = {
    route,
    prefs: flags.prefs,
    session: flags.session,
    mount: { _tag: "Splash" },
    switcherOpen: false,
    toasts: [],
    nextToastId: 1,
  };
  const mounted = mountRoute(model, route);
  return flags.session._tag === "Unknown"
    ? { model: mounted.model, commands: [...(mounted.commands ?? []), LoadSession()] }
    : mounted;
};

// UPDATE

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ClickedLink: ({ request }) =>
      UrlRequest.match<UpdateReturn>(request, {
        Internal: ({ url }) => ({
          model,
          commands: [Navigate({ url: urlToString(url), replace: false })],
        }),
        External: ({ href }) => ({ model, commands: [LoadExternal({ href })] }),
      }),
    ChangedUrl: ({ url }) =>
      mountRoute(
        model,
        routeFromPath(
          `${url.pathname}${Option.match(url.search, { onNone: () => "", onSome: (s) => `?${s}` })}`,
        ),
      ),
    GotPage: ({ message }) => {
      if (model.mount._tag !== "Mounted") return { model };
      const result = updatePage(model.mount.page, message, contextOf(model));
      if (result === undefined) return { model };
      return applyIntent(
        { ...model, mount: { _tag: "Mounted", page: result.page } },
        Command.mapMessages(result.commands, (m) => Message.GotPage({ message: m })),
        result.outMessage,
      );
    },
    LoadedSession: ({ state }) => {
      const next = { ...model, session: state };
      // Re-mount when the gate may now resolve differently (Splash, or account/workspace scope).
      return model.mount._tag === "Splash" || ViewModels.Routes.requires(model.route) !== "public"
        ? mountRoute(next, model.route)
        : { model: next };
    },
    ChangedPrefs: ({ prefs }) => setPrefs(model, prefs),
    ToggledSwitcher: () => ({ model: { ...model, switcherOpen: !model.switcherOpen } }),
    ClosedSwitcher: () => ({ model: { ...model, switcherOpen: false } }),
    PressedSwitcherShortcut: () =>
      "ws" in model.route ? { model: { ...model, switcherOpen: !model.switcherOpen } } : { model },
    ClickedSignOut: () => ({ model, commands: [SignOut()] }),
    CompletedSignOut: () => applyIntent(model, [], { _tag: "SignedOut" }),
    DismissedToast: ({ id }) => ({
      model: { ...model, toasts: model.toasts.filter((t) => t.id !== id) },
    }),
    CompletedNavigate: () => ({ model }),
    CompletedPersistPrefs: () => ({ model }),
  });

// SUBSCRIPTIONS

/** Ctrl/Cmd+K opens the workspace switcher (ui-port SHORTCUTS); active only in a workspace. */
export const subscriptions = Subscription.make<Model, Message>()(() => ({
  switcherShortcut: Subscription.persistentEntry(
    typeof window === "undefined"
      ? Stream.empty
      : Stream.fromEventListener<KeyboardEvent>(window, "keydown").pipe(
          Stream.filter((e) =>
            Option.isSome(ViewModels.matchShortcut(e, /Mac|iPhone|iPad/.test(navigator.platform))),
          ),
          Stream.tap((e) => Effect.sync(() => e.preventDefault())),
          Stream.map(() => Message.PressedSwitcherShortcut()),
        ),
  ),
}));

// VIEW

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const ctx = contextOf(model);
  const title = model.mount._tag === "Mounted" ? pageTitle(model.mount.page, ctx) : "";
  return {
    title: title === "" ? "Kvitbit" : `${title} · Kvitbit`,
    body: shellView(model, ctx, h),
  };
};
