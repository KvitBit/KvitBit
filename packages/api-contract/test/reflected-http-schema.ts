import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";

// HTTP reflection erases the schema's service types. Contract codecs must decode with
// an empty context, so any attempted service access fails the test.
const reflectedContext = Context.makeUnsafe<unknown>(new Map());

export const decodeReflectedSchema = (schema: Schema.Top) =>
  Fn.flow(Schema.decodeUnknownEffect(schema), Effect.provideContext(reflectedContext));
