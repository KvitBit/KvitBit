import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { renderPath } from "../test/support";

const path = process.argv[2];
if (path === undefined) throw new Error("Pass the URL path to server-render");
const { html, flags, state } = await renderPath(path);
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const hydration = Effect.runSync(encode({ flags, state }));
process.stdout.write(Effect.runSync(encode({ html, hydration })));
