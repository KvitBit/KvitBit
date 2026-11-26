import "./styles/index.css";
import { type Renderer, Router } from "@effect/ui";
import { BrowserHost, BrowserRouter, HtmlHydrate } from "@effect/ui/html";
import { Effect, Layer } from "effect";
import { RunApi } from "./app/commands";
import { loadBrowserPrefs } from "./app/prefs";
import { BrowserRoutes } from "./app/routing";
import { demoEnabled, demoRoutes } from "./demo";
import { installDemoFetch } from "./demo/router";
import { App, type Flags, Navigate } from "./main";

if (demoEnabled()) installDemoFetch(demoRoutes);

const container = document.getElementById("root");
if (container === null) throw new Error("Missing #root for the application");

const bootstrap = document.getElementById("kb-state")?.textContent;
const state: { readonly flags: Flags; readonly state: Renderer.State } | undefined = bootstrap
  ? JSON.parse(bootstrap)
  : undefined;

const host =
  state === undefined
    ? Layer.unwrap(
        Effect.map(Router.Router, (router) => {
          const prefs = loadBrowserPrefs();
          document.documentElement.lang = prefs.locale;
          return BrowserHost.mount(
            App,
            {
              path: router.location().url,
              today: new Date().toISOString().slice(0, 10),
              prefs,
              session: { _tag: "Unknown" },
            },
            container,
          );
        }),
      )
    : HtmlHydrate.hydrate(App, state.flags, container, state.state);

const router = BrowserRouter.layer({ routes: BrowserRoutes });
const layers = Layer.merge(RunApi.layer, Navigate.layer.pipe(Layer.provideMerge(router)));
Effect.runFork(Layer.launch(host.pipe(Layer.provide(layers))));
