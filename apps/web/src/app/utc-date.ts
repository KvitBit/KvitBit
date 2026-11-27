import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export const utcDateAt = (now: number) => DateTime.formatIsoDateUtc(DateTime.makeUnsafe(now));

const millisPerDay = 86_400_000;
const sleepUntilMidnight = Effect.flatMap(Clock.currentTimeMillis, (now) =>
  Effect.sleep(Duration.millis((Math.floor(now / millisPerDay) + 1) * millisPerDay - now)),
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
