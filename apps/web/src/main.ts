import { Command, type Component, Head, Router, Subscription } from "@effect/ui";
import { Html, HtmlHead } from "@effect/ui/html";
import { ViewModels } from "@kvitbit/ui-port";
import { Array as Arr, Effect, Option, Schema, Stream } from "effect";
import { authFetch } from "./app/api";
import { apiCommand, browserCommand, type RunApi } from "./app/commands";
import type { Intent } from "./app/intent";
import type { PageContext } from "./app/page";
import { type Prefs, persistPrefs } from "./app/prefs";
import { Flags, Message, Model, type Toast } from "./app/root";
import { gate, href, routeFromPath } from "./app/routing";
import { fetchSession, workspaceBySlug } from "./app/session";
import { shellView } from "./app/shell";

export { Flags, Message, Model } from "./app/root";

export class Navigate extends Command.Service<Navigate>()("@kvitbit/web/Navigate", {
  args: { path: Schema.String, replace: Schema.Boolean },
  success: Router.Outcome,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const router = yield* Router.Router;
      return ({ path, replace }) => router.navigate(path, { replace });
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
  prefs: model.prefs,
  locale: model.prefs.locale,
  session: model.session,
  workspace:
    "ws" in model.route ? Option.getOrNull(workspaceBySlug(model.session, model.route.ws)) : null,
});

const mountRoute = (model: Model, path: string): UpdateReturn => {
  const route = routeFromPath(path);
  const access = gate(route, model.session);
  if (access._tag === "Wait") return { model: { ...model, path, route, waitingForSession: true } };
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

const applyIntent = (model: Model, intent: Intent): UpdateReturn => {
  switch (intent._tag) {
    case "Navigate":
      return { model, commands: [navigate(intent.path, intent.replace)] };
    case "Toast":
      return { model: pushToast(model, intent.text, intent.tone) };
    case "SetPrefs":
      return setPrefs(model, intent.prefs);
    case "ReloadSession": {
      const sessionSeq = model.sessionSeq + 1;
      return {
        model: { ...model, pendingNav: intent.destination ?? model.pendingNav, sessionSeq },
        commands: [loadSession(sessionSeq)],
      };
    }
    case "SignedOut":
      return signedOut(model);
  }
};

export const init = (flags: Flags): UpdateReturn => {
  const initial = mountRoute(
    {
      path: flags.path,
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
    case "LoadedSession": {
      if (message.seq !== model.sessionSeq) return { model };
      const { state } = message;
      const next = { ...model, session: state, pendingNav: null };
      const pending = model.pendingNav;
      if (state._tag === "SignedIn" && pending !== null) {
        const path =
          pending._tag === "Path"
            ? pending.path
            : href(
                state.workspaces[0] === undefined
                  ? { _tag: "Onboarding" }
                  : { _tag: "Dashboard", ws: state.workspaces[0].slug },
              );
        return {
          model: next,
          commands: [navigate(path, pending._tag === "Path" ? pending.replace : true)],
        };
      }
      return mountRoute(next, model.path);
    }
    case "ChangedPrefs":
      return setPrefs(model, message.prefs);
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

const linkChanges = Subscription.make(
  "web-route",
  Stream.unwrap(
    Effect.map(Router.Router, (router) =>
      router.changes.pipe(
        Stream.filter((location) => location.seq !== 0),
        Stream.map((location) => Message.ChangedUrl({ path: location.url })),
      ),
    ),
  ),
);

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
  subscriptions: () => [linkChanges, shortcut],
  view: (h, model) => shellView(model, contextOf(model), h),
  head: ({ model }) => [Head.title("Kvitbit"), HtmlHead.lang(model.prefs.locale)],
});
