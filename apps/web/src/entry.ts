/**
 * Browser entry. A fresh boot reads viewer preferences from storage and starts with an unknown
 * session (the Shell loads it); a server-rendered page hydrates from the Flags it embedded.
 */
import "./styles/index.css";
import { Effect } from "effect";
import { Runtime } from "foldkit";
import { WebServicesLive } from "./app/api";
import { loadBrowserPrefs } from "./app/prefs";
import { demoEnabled, demoRoutes } from "./demo";
import { installDemoFetch } from "./demo/router";
import { Flags, init, Message, Model, subscriptions, update, view } from "./main";

if (demoEnabled()) installDemoFetch(demoRoutes);

const application = Runtime.makeApplication({
  Model,
  Flags,
  init,
  update,
  view,
  subscriptions,
  resources: WebServicesLive,
  container: document.getElementById("root"),
  routing: {
    onUrlRequest: (request) => Message.ClickedLink({ request }),
    onUrlChange: (url) => Message.ChangedUrl({ url }),
  },
});

if (document.getElementById("root")?.hasChildNodes() === true) {
  Runtime.hydrate(application);
} else {
  Runtime.run(application, {
    flags: Effect.sync((): Flags => ({ prefs: loadBrowserPrefs(), session: { _tag: "Unknown" } })),
  });
}
