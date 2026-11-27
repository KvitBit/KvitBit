import { Command } from "@effect/ui";
import { Api } from "@kvitbit/ui-port";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type WebServices, WebServicesLive } from "./api";

class ApiOperation {
  readonly effect: Effect.Effect<unknown, never, WebServices>;

  constructor(effect: Effect.Effect<unknown, never, WebServices>) {
    this.effect = effect;
  }
}

/** Runs page API effects with the client supplied by the app's transport layer. */
export class RunApi extends Command.Service<RunApi>()("@kvitbit/web/RunApi", {
  args: { name: Schema.String, operation: Schema.instanceOf(ApiOperation) },
  success: Schema.Unknown,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const services = yield* Effect.context<WebServices>().pipe(
        Effect.map(Context.pick(Api.KvitbitApi, HttpClient.HttpClient)),
      );
      return ({ operation }) => Effect.provideContext(operation.effect, services);
    }),
  ).pipe(Layer.provide(WebServicesLive));
}

export type PageCommand<Message> = Command.Command<Message, RunApi>;

const apiCommandImpl = <Message>(
  message: Schema.Codec<Message, unknown, never, never>,
  name: string,
  effect: Effect.Effect<NoInfer<Message>, never, WebServices>,
) => {
  const decode = Schema.decodeUnknownOption(Schema.toType(message));
  return Command.map(RunApi.make({ name, operation: new ApiOperation(effect) }), (result) =>
    Option.getOrThrowWith(decode(result), () => new Error(`Invalid ${name} message`)),
  );
};

export const apiCommand: {
  <Message>(
    name: string,
    effect: Effect.Effect<NoInfer<Message>, never, WebServices>,
  ): (
    message: Schema.Codec<Message, unknown, never, never>,
  ) => ReturnType<typeof apiCommandImpl<Message>>;
  <Message>(
    message: Schema.Codec<Message, unknown, never, never>,
    name: string,
    effect: Effect.Effect<NoInfer<Message>, never, WebServices>,
  ): ReturnType<typeof apiCommandImpl<Message>>;
} = Fn.dual(3, apiCommandImpl);

const browserCommandImpl = <Message>(name: string, effect: Effect.Effect<Message>) =>
  Command.make(name, { args: {} }, () => effect).make();

export const browserCommand: {
  <Message>(
    effect: Effect.Effect<Message>,
  ): (name: string) => ReturnType<typeof browserCommandImpl<Message>>;
  <Message>(
    name: string,
    effect: Effect.Effect<Message>,
  ): ReturnType<typeof browserCommandImpl<Message>>;
} = Fn.dual(2, browserCommandImpl);

export const defineApiCommand =
  <const Fields extends Schema.Struct.Fields, Message>(options: {
    readonly message: Schema.Codec<Message, unknown, never, never>;
    readonly name: string;
    readonly args: Fields;
    readonly execute: (
      args: Schema.Struct<Fields>["Type"],
    ) => Effect.Effect<NoInfer<Message>, never, WebServices>;
  }) =>
  (args: Schema.Struct<Fields>["Type"]) =>
    apiCommand(options.message, options.name, options.execute(args));
