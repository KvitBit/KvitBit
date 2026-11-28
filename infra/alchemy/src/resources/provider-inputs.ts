import * as Output from "alchemy/Output";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

/**
 * A prop of a provider diff's `news` that is already a plain string. While
 * a plan runs, the props or the prop can still be an unresolved Output,
 * Config or Effect, which cannot differ yet, so it reads as `undefined`.
 */
export const resolvedStringProp = (key: string) =>
  Fn.flow(
    Schema.decodeUnknownOption(Schema.Struct({ [key]: Schema.String })),
    Option.flatMap(Record.get(key)),
  );

/** Keep the dependent resource from resolving until its prerequisites are ready. */
export const afterResources =
  (dependencies: ReadonlyArray<unknown>) =>
  (value: string | Output.Output<string>): Output.Output<string> => {
    const output = Output.asOutput(value);
    return dependencies.length === 0
      ? output
      : Output.all(output, Output.all(...Arr.map(dependencies, Output.asOutput))).pipe(
          Output.map(([resolved]) => resolved),
        );
  };

export const declaredLink = (resource: string) =>
  Output.mapEffect((link: string | undefined) =>
    link === undefined
      ? Effect.die(new Error(`${resource} reported no self link`))
      : Effect.succeed(link),
  );
