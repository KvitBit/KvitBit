import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class PlatformOperationFailed extends Schema.TaggedError<
  PlatformOperationFailed,
  { readonly brand: unique symbol }
>()("PlatformOperationFailed", { cause: Schema.Unknown }) {}

export const tryPlatform = <A>(run: () => A) =>
  Effect.try({ try: run, catch: (cause) => PlatformOperationFailed.make({ cause }) });
