import { Clock, Duration, Effect, Stream } from "effect";

export const utcDateAt = (now: number) => new Date(now).toISOString().slice(0, 10);

const sleepUntilMidnight = Effect.flatMap(Clock.currentTimeMillis, (now) =>
  Effect.sleep(Duration.millis(new Date(now).setUTCHours(24, 0, 0, 0) - now)),
);

// A background tab can miss its timer. Check its date as soon as it becomes visible again.
export const browserDates = Stream.suspend(() =>
  Stream.merge(
    Stream.concat(Stream.make(undefined), Stream.fromEffectRepeat(sleepUntilMidnight)),
    Stream.fromEventListener(document, "visibilitychange").pipe(
      Stream.filter(() => document.visibilityState === "visible"),
    ),
  ).pipe(
    Stream.mapEffect(() => Effect.map(Clock.currentTimeMillis, utcDateAt)),
    Stream.changes,
  ),
);
