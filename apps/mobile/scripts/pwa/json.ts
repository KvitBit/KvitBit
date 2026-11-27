import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const compact = Schema.encodeOption(Schema.fromJsonString(Schema.Json));
const pretty = Schema.encodeOption(Schema.fromJsonString(Schema.Json, { space: 2 }));

export const jsonLiteral = (value: Schema.Json) => compact(value).pipe(Option.getOrThrow);
export const jsonManifest = (value: Schema.Json) => pretty(value).pipe(Option.getOrThrow);
