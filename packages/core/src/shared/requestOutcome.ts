/** The Ref-backed `RequestOutcome` (core-ports 2.1); the edge provides one per HTTP request. */
import { RequestOutcome } from "@kvitbit/domain/ports";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export const makeRequestOutcome: Effect.Effect<RequestOutcome["Service"]> = Effect.map(
  Ref.make(false),
  (ref) => ({ markReplayed: Ref.set(ref, true), replayed: Ref.get(ref) }),
);

export const RequestOutcomeLive: Layer.Layer<RequestOutcome> = Layer.effect(
  RequestOutcome,
  makeRequestOutcome,
);
