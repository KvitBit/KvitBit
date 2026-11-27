import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

const readReactProps = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown));

const findReactHandler = (element: Element | null, event: "onClick" | "onChange") => {
  if (element === null) throw new Error("Element not found");
  const key = Option.getOrUndefined(
    Arr.findFirst(Rec.keys(element), (name) => Str.startsWith("__reactProps$")(name)),
  );
  if (key === undefined) throw new Error("React props not found on element");
  const props = readReactProps(Reflect.get(element, key));
  const handler = Option.isSome(props) ? props.value[event] : undefined;
  if (!Predicate.isFunction(handler)) throw new Error(`React handler ${event} not found`);
  return handler;
};

export const reactEventHandler: {
  (element: Element | null, event: "onClick" | "onChange"): ReturnType<typeof findReactHandler>;
  (event: "onClick" | "onChange"): (element: Element | null) => ReturnType<typeof findReactHandler>;
} = Fn.dual(2, findReactHandler);
