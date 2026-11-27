import { Subscription } from "@effect/ui";
import { Effect, Stream } from "effect";
import type { Model } from "../app/root";

export const feedbackSubscription = ({ session, path, prefs }: Model) =>
  session._tag === "SignedIn" && session.user.feedbackEnabled === true
    ? [
        Subscription.make(
          "visual-feedback",
          [session.user.id, path, prefs.locale, prefs.mode] as const,
          ([, , locale, mode]) =>
            Stream.unwrap(
              Effect.tryPromise(() => import("./feedback/feedback-overlay")).pipe(
                Effect.flatMap(({ mountFeedback }) =>
                  Effect.acquireRelease(
                    Effect.sync(() => mountFeedback(locale, mode)),
                    (dispose) => Effect.sync(dispose),
                  ),
                ),
                Effect.as(Stream.never),
                Effect.catch(() => Effect.succeed(Stream.empty)),
              ),
            ),
        ),
      ]
    : [];
