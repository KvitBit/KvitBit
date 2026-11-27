import { Subscription } from "@effect/ui";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { Model } from "../app/root";

export const feedbackSubscription = ({ session, path, prefs }: Model) =>
  session._tag === "SignedIn" && session.user.feedbackEnabled === true
    ? [
        Subscription.make(
          "visual-feedback",
          [session.user.id, path, prefs.locale, prefs.mode] as const,
          ([, , locale, mode]) =>
            Stream.unwrap(
              Effect.tryPromise({
                try: () => import("./feedback/feedback-overlay"),
                catch: () => "feedback-unavailable" as const,
              }).pipe(
                Effect.map(({ mountFeedback }) =>
                  Stream.fromEffect(mountFeedback({ locale, mode })).pipe(
                    Stream.drain,
                    Stream.catch(() => Stream.empty),
                  ),
                ),
                Effect.orElseSucceed(() => Stream.empty),
              ),
            ),
        ),
      ]
    : [];
