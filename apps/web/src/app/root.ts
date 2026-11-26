import { UiSchema } from "@effect/ui";
import { ViewModels } from "@kvitbit/ui-port";
import { Schema } from "effect";
import { Intent, PendingNavigation } from "./intent";
import { Prefs } from "./prefs";
import { SessionState } from "./session";

export const Toast = Schema.Struct({
  id: Schema.Int,
  text: Schema.String,
  tone: Schema.Literals(["info", "error"]),
});
export type Toast = typeof Toast.Type;

export const Model = Schema.Struct({
  path: Schema.String,
  today: Schema.String,
  route: ViewModels.Route,
  prefs: Prefs,
  session: SessionState,
  waitingForSession: Schema.Boolean,
  sessionSeq: Schema.Int,
  pendingNav: Schema.NullOr(PendingNavigation),
  switcherOpen: Schema.Boolean,
  toasts: Schema.Array(Toast),
  nextToastId: Schema.Int,
});
export type Model = typeof Model.Type;

export const Flags = Schema.Struct({
  path: Schema.String,
  today: Schema.String,
  prefs: Prefs,
  session: SessionState,
});
export type Flags = typeof Flags.Type;

export const Message = UiSchema.TaggedEnum({
  ChangedUrl: { path: Schema.String },
  PageIntent: { path: Schema.String, intent: Intent },
  ClickedRetrySession: {},
  LoadedSession: { state: SessionState, seq: Schema.Int },
  ChangedPrefs: { prefs: Prefs },
  ToggledSwitcher: {},
  ClosedSwitcher: {},
  PressedSwitcherShortcut: {},
  ClickedSignOut: {},
  CompletedSignOut: {},
  DismissedToast: { id: Schema.Int },
});
export type Message = typeof Message.Type;
