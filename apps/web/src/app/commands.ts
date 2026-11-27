import { Command } from "@effect/ui";
import { Api } from "@kvitbit/ui-port";
import { Effect, Layer, Option, Schema } from "effect";
import { StartupConfig, type WebServices, WebServicesLive } from "./api";

class ApiOperation {
  constructor(readonly effect: Effect.Effect<unknown, never, WebServices>) {}
}

/** Runs page API effects with the client supplied by the app's transport layer. */
export class RunApi extends Command.Service<RunApi>()("@kvitbit/web/RunApi", {
  args: { name: Schema.String, operation: Schema.instanceOf(ApiOperation) },
  group: ["name"],
  success: Schema.Unknown,
}) {
  static readonly fromClient = this.toLayer(
    Effect.gen(function* () {
      const client = yield* Api.KvitbitApi;
      const config = yield* Effect.serviceOption(StartupConfig);
      return ({ operation }) => {
        const effect = Effect.provideService(operation.effect, Api.KvitbitApi, client);
        return Option.isSome(config)
          ? Effect.provideService(effect, StartupConfig, config.value)
          : effect;
      };
    }),
  );
  static readonly layer = this.fromClient.pipe(Layer.provide(WebServicesLive));
}

export type PageCommand<Message> = Command.Command<Message, RunApi>;

export const apiCommand = <Message>(
  name: string,
  effect: Effect.Effect<Message, never, WebServices>,
) =>
  Command.map(
    RunApi.make({ name, operation: new ApiOperation(effect) }),
    // The only value this operation yields is the message from its supplied Effect.
    (message) => message as Message,
  );

export const browserCommand = <Message>(name: string, effect: Effect.Effect<Message>) =>
  Command.make(name, { args: {} }, () => effect).make();

export const defineApiCommand =
  <const Fields extends Schema.Struct.Fields, Message>(
    name: string,
    options: {
      readonly args: Fields;
      readonly execute: (
        args: Schema.Struct<Fields>["Type"],
      ) => Effect.Effect<Message, never, WebServices>;
    },
  ) =>
  (args: Schema.Struct<Fields>["Type"]) =>
    apiCommand(name, options.execute(args));
