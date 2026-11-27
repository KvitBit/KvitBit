import * as Schema from "effect/Schema";

const JsonText = Schema.fromJsonString(Schema.Unknown);

// Render-time formatter keys and query keys need the encoded string immediately.
// @effect-diagnostics-next-line schemaSync:off
const encode = Schema.encodeSync(JsonText);

// biome-ignore lint/plugin/no-unknown-parameters: The encoder accepts any value and checks JSON serializability.
export const stringifyJson = (value: unknown): string => encode(value);
