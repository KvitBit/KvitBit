import { Command, type Component, Head, Router, Subscription } from "@effect/ui";
import { Html, HtmlHead } from "@effect/ui/html";
import { ViewModels } from "@kvitbit/ui-port";
import { Array as Arr, Effect, Layer, Option, Schema, Stream } from "effect";
import { createPageviewTracker } from "./app/analytics";
import { authFetch, StartupConfig } from "./app/api";
import { apiCommand, browserCommand, type RunApi } from "./app/commands";
import type { Intent, PendingNavigation } from "./app/intent";
import type { PageContext } from "./app/page";
import { type Prefs, persistPrefs } from "./app/prefs";
import { Flags, Message, Model, type Toast } from "./app/root";
import { BrowserRoutes, gate, href, magicSignInCallback, routeFromPath } from "./app/routing";
import { fetchSession, workspaceBySlug } from "./app/session";
import { shellView } from "./app/shell";
import { browserDates } from "./app/utc-date";
import { feedbackSubscription } from "./runtime/feedback-subscription";

export { Flags, Message, Model } from "./app/root";

export const browserAnalytics = (origin: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* Router.Router;
      const config = yield* StartupConfig;
      const track = createPageviewTracker(origin, async () => {
        const value = await Effect.runPromise(config);
        return value.analytics;
      });
      track(router.location().url);
      yield* Stream.runForEach(router.changes, ({ url }) => Effect.sync(() => track(url))).pipe(
        Effect.forkScoped,
      );
    }),
  );

export class Navigate extends Command.Service<Navigate>()("@kvitbit/web/Navigate", {
  args: { path: Schema.String, replace: Schema.Boolean },
  success: Router.Outcome,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const router = yield* Router.Router;
      return ({ path, replace }) => {
        const origin = "https://kvitbit.invalid";
        try {
          const url = new URL(path, origin);
          return path.startsWith("/") && url.origin === origin
            ? router.navigate(url.pathname + url.search + url.hash, { replace })
            : Effect.succeed("blocked" as const);
        } catch {
          return Effect.succeed("blocked" as const);
        }
      };
    }),
  );
}

const navigate = (path: string, replace = false) =>
  Command.asNoop(Navigate.make({ path, replace }));

type ShellCommand = Command.Command<Message | Component.Noop, RunApi | Navigate>;
interface UpdateReturn {
  readonly model: Model;
  readonly commands?: ReadonlyArray<ShellCommand>;
}

const loadSession = (seq: number) =>
  apiCommand(
    "LoadSession",
    Effect.map(fetchSession, (state) => Message.LoadedSession({ state, seq })),
  );

export const contextOf = (model: Model): PageContext => ({
  route: model.route,
  path: model.path,
  today: model.today,
  prefs: model.prefs,
  locale: model.prefs.locale,
  session: model.session,
  workspace:
    "ws" in model.route ? Option.getOrNull(workspaceBySlug(model.session, model.route.ws)) : null,
});

const mountRoute = (model: Model, path: string): UpdateReturn => {
  const route = routeFromPath(path);
  const access = gate(route, model.session, path);
  if (access._tag === "Wait") return { model: { ...model, path, route, waitingForSession: true } };
  if (access._tag === "Retry") {
    return {
      model: {
        ...model,
        path,
        route,
        pendingNav: { _tag: "Path", path, replace: true },
        waitingForSession: false,
        switcherOpen: false,
      },
    };
  }
  if (access._tag === "Redirect") {
    const target = href(access.route);
    return {
      model: {
        ...model,
        path: target,
        route: access.route,
        waitingForSession: false,
        switcherOpen: false,
      },
      commands: [navigate(target, true)],
    };
  }
  return { model: { ...model, path, route, waitingForSession: false, switcherOpen: false } };
};

const pushToast = (model: Model, text: string, tone: Toast["tone"]): Model => ({
  ...model,
  toasts: Arr.takeRight([...model.toasts, { id: model.nextToastId, text, tone }], 3),
  nextToastId: model.nextToastId + 1,
});

const setPrefs = (model: Model, prefs: Prefs): UpdateReturn => ({
  model: { ...model, prefs },
  commands: [Command.asNoop(browserCommand("PersistPrefs", persistPrefs(prefs)))],
});

const signedOut = (model: Model): UpdateReturn => {
  const path = href({ _tag: "SignIn" });
  const next = mountRoute(
    {
      ...model,
      session: { _tag: "Anonymous" },
      pendingNav: null,
      sessionSeq: model.sessionSeq + 1,
    },
    path,
  );
  return { model: next.model, commands: [navigate(path)] };
};

const reloadSession = (model: Model, pendingNav: PendingNavigation | null): UpdateReturn => {
  const sessionSeq = model.sessionSeq + 1;
  return {
    model: { ...model, pendingNav, sessionSeq, waitingForSession: pendingNav !== null },
    commands: [loadSession(sessionSeq)],
  };
};

const settleSession = (model: Model, session: Model["session"]): UpdateReturn => {
  const pendingNav = model.pendingNav;
  if (session._tag === "Unavailable" && pendingNav !== null) {
    return { model: { ...model, session, waitingForSession: false } };
  }
  const next = { ...model, session, pendingNav: null };
  if (session._tag !== "SignedIn" || pendingNav === null) return mountRoute(next, model.path);
  const first = session.workspaces[0];
  const path =
    pendingNav._tag === "Path"
      ? pendingNav.path
      : href(first === undefined ? { _tag: "Onboarding" } : { _tag: "Dashboard", ws: first.slug });
  return path === model.path
    ? mountRoute(next, path)
    : {
        model: next,
        commands: [navigate(path, pendingNav._tag === "Path" ? pendingNav.replace : true)],
      };
};

const applyIntent = (model: Model, intent: Intent): UpdateReturn => {
  switch (intent._tag) {
    case "Navigate":
      return { model, commands: [navigate(intent.path, intent.replace)] };
    case "Toast":
      return { model: pushToast(model, intent.text, intent.tone) };
    case "SetPrefs":
      return setPrefs(model, intent.prefs);
    case "ReloadSession":
      return reloadSession(model, intent.destination ?? model.pendingNav);
    case "SignedOut":
      return signedOut(model);
  }
};

export const init = (flags: Flags): UpdateReturn => {
  const initial = mountRoute(
    {
      path: flags.path,
      today: flags.today,
      route: routeFromPath(flags.path),
      prefs: flags.prefs,
      session: flags.session,
      waitingForSession: false,
      sessionSeq: 1,
      pendingNav: null,
      switcherOpen: false,
      toasts: [],
      nextToastId: 1,
    },
    flags.path,
  );
  if (flags.path === magicSignInCallback && flags.session._tag !== "Anonymous") {
    const callback: Model = {
      ...initial.model,
      pendingNav: { _tag: "DefaultSignedIn" },
      waitingForSession: true,
    };
    return flags.session._tag === "Unknown"
      ? { model: callback, commands: [loadSession(callback.sessionSeq)] }
      : settleSession(callback, flags.session);
  }
  return flags.session._tag === "Unknown"
    ? { model: initial.model, commands: [...(initial.commands ?? []), loadSession(1)] }
    : initial;
};

export const update = (model: Model, message: Message): UpdateReturn => {
  switch (message._tag) {
    case "ChangedUrl":
      return message.path === model.path
        ? { model }
        : mountRoute({ ...model, pendingNav: null }, message.path);
    case "PageIntent":
      return !model.waitingForSession && message.path === model.path
        ? applyIntent(model, message.intent)
        : { model };
    case "LoadedSession":
      return message.seq === model.sessionSeq ? settleSession(model, message.state) : { model };
    case "ClickedRetrySession":
      return model.session._tag === "Unavailable" &&
        model.pendingNav !== null &&
        !model.waitingForSession
        ? reloadSession(model, model.pendingNav)
        : { model };
    case "ChangedPrefs":
      return setPrefs(model, message.prefs);
    case "ChangedDate":
      return { model: message.today === model.today ? model : { ...model, today: message.today } };
    case "ToggledSwitcher":
      return { model: { ...model, switcherOpen: !model.switcherOpen } };
    case "ClosedSwitcher":
      return { model: { ...model, switcherOpen: false } };
    case "PressedSwitcherShortcut":
      return "ws" in model.route
        ? { model: { ...model, switcherOpen: !model.switcherOpen } }
        : { model };
    case "ClickedSignOut":
      return {
        model,
        commands: [
          browserCommand(
            "SignOut",
            authFetch(
              "/sign-out",
              { method: "POST", body: {} },
              () => Message.CompletedSignOut(),
              () => Message.CompletedSignOut(),
            ),
          ),
        ],
      };
    case "CompletedSignOut":
      return signedOut(model);
    case "DismissedToast":
      return { model: { ...model, toasts: model.toasts.filter((t) => t.id !== message.id) } };
  }
};

const shortcut = Subscription.make(
  "workspace-switcher",
  Stream.suspend(() =>
    Stream.fromEventListener<KeyboardEvent>(window, "keydown").pipe(
      Stream.filter((event) =>
        Option.isSome(ViewModels.matchShortcut(event, /Mac|iPhone|iPad/.test(navigator.platform))),
      ),
      Stream.tap((event) => Effect.sync(() => event.preventDefault())),
      Stream.map(() => Message.PressedSwitcherShortcut()),
    ),
  ),
);

const changedDate = Subscription.make(
  "utc-date",
  browserDates.pipe(Stream.map((today) => Message.ChangedDate({ today }))),
);

export const App = Html.component({
  name: "Kvitbit",
  props: Flags,
  model: Model,
  message: Message,
  restore: false,
}).make({
  init: ($) => {
    const result = init($.props);
    return $.set(result.model).run(...(result.commands ?? []));
  },
  update: ($, message) => {
    const result = update($.model, message);
    return $.set(result.model).run(...(result.commands ?? []));
  },
  subscriptions: ({ model }) => [
    Router.subscription(
      BrowserRoutes,
      Option.getOrElse(BrowserRoutes.parse(model.path), () =>
        BrowserRoutes.ErrorPage({ params: { kind: "not-found" } }),
      ),
      (route) => Message.ChangedUrl({ path: BrowserRoutes.print(route) }),
    ),
    shortcut,
    changedDate,
    ...feedbackSubscription(model),
  ],
  view: (h, model) => shellView(model, contextOf(model), h),
  head: ({ model }) => [Head.title("Kvitbit"), HtmlHead.lang(model.prefs.locale)],
});
