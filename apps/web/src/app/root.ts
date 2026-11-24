/** Root Shell Model, Flags and Message schemas (kept apart from main.ts so views can import them). */
import { ViewModels } from "@kvitbit/ui-port";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { UrlRequest } from "foldkit/navigation";
import { Url } from "foldkit/url";
import { PageMessage, PageModel } from "./pages";
import { Prefs } from "./prefs";
import { SessionState } from "./session";

// MODEL

export const Toast = Schema.Struct({
  id: Schema.Int,
  text: Schema.String,
  tone: Schema.Literals(["info", "error"]),
});
export type Toast = typeof Toast.Type;

export const Mount = Schema.Union([
  Schema.TaggedStruct("Splash", {}),
  Schema.TaggedStruct("Mounted", { page: PageModel }),
]);
export type Mount = typeof Mount.Type;

export const Model = Schema.Struct({
  route: ViewModels.Route,
  prefs: Prefs,
  session: SessionState,
  mount: Mount,
  switcherOpen: Schema.Boolean,
  toasts: Schema.Array(Toast),
  nextToastId: Schema.Int,
});
export type Model = typeof Model.Type;

export const Flags = Schema.Struct({ prefs: Prefs, session: SessionState });
export type Flags = typeof Flags.Type;

// MESSAGE

export const Message = defineMessageUnion({
  ClickedLink: { request: UrlRequest },
  ChangedUrl: { url: Url },
  GotPage: { message: PageMessage },
  LoadedSession: { state: SessionState },
  ChangedPrefs: { prefs: Prefs },
  ToggledSwitcher: {},
  ClosedSwitcher: {},
  ClickedSignOut: {},
  CompletedSignOut: {},
  DismissedToast: { id: Schema.Int },
  PressedSwitcherShortcut: {},
  CompletedNavigate: {},
  CompletedPersistPrefs: {},
});
export type Message = typeof Message.Type;
