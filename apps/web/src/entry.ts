import "./styles/index.css";
import { Router } from "@effect/ui";
import { BrowserHost, BrowserRouter, HtmlHydrate } from "@effect/ui/html";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { StartupConfig, WebServicesLive } from "./app/api";
import { RunApi } from "./app/commands";
import { loadBrowserPrefs } from "./app/prefs";
import { BrowserRoutes } from "./app/routing";
import { utcDateAt } from "./app/utc-date";
import { demoEnabled, demoRoutes } from "./demo";
import { installDemoFetch } from "./demo/router";
import { App, browserAnalytics, Flags, Navigate } from "./main";
import { registerUiSdk } from "./ui/sdk";

if (demoEnabled()) installDemoFetch({ routes: demoRoutes, run: Effect.runPromise });

const Bootstrap = Schema.fromJsonString(
  Schema.Struct({
    flags: Flags,
    state: Schema.JsonObject,
  }),
);
const readBootstrap = Schema.decodeUnknownOption(Bootstrap);
const state = readBootstrap(document.querySelector("#kb-state")?.textContent);

const host = Layer.unwrap(
  Effect.gen(function* () {
    const container = document.querySelector<HTMLDivElement>("#root");
    if (container === null) return yield* Effect.die("Missing #root for the application");
    if (Option.isSome(state)) {
      const { flags, state: saved } = state.value;
      return Layer.effectDiscard(
        Effect.gen(function* () {
          const root = yield* HtmlHydrate.hydrateEffect(App, flags, container, saved);
          yield* root.adopted;
          yield* registerUiSdk;
        }),
      );
    }
    yield* registerUiSdk;
    const router = yield* Router.Router;
    const prefs = yield* loadBrowserPrefs;
    const now = yield* Clock.currentTimeMillis;
    document.documentElement.lang = prefs.locale;
    return BrowserHost.mount(
      App,
      { path: router.location().url, today: utcDateAt(now), prefs, session: { _tag: "Unknown" } },
      container,
    );
  }),
);

const router = BrowserRouter.layer({ routes: BrowserRoutes });
const webServices = StartupConfig.layer.pipe(Layer.provideMerge(WebServicesLive));
const layers = Layer.mergeAll(
  RunApi.fromClient,
  Navigate.layer,
  browserAnalytics(location.origin),
).pipe(Layer.provideMerge(webServices), Layer.provideMerge(router));
host.pipe(Layer.provide(layers), Layer.launch, Effect.runFork);
