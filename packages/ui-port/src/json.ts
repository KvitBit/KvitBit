import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const JsonText = Schema.fromJsonString(Schema.Unknown);
const encode = Schema.encodeEffect(JsonText);

export const stringifyJson = (value: unknown): string => Effect.runSync(encode(value));
