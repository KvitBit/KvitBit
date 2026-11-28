import { spyOn } from "bun:test";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import { type PageCommand, RunApi } from "../../src/app/commands";

export const run = <M>(command: PageCommand<M> | undefined): Promise<M> => {
  if (command?._tag !== "Effect") throw new Error("Expected a page effect command");
  return Effect.runPromise(
    command.effect.pipe(
      Effect.provide(RunApi.layer),
      Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
    ),
  );
};

export const mockWire = (
  handle: (
    request: Request,
    credentials: RequestCredentials | undefined,
  ) => Response | Promise<Response>,
) => {
  const implementation = Object.assign(
    (...[input, init]: Parameters<typeof fetch>) =>
      Promise.resolve().then(() => handle(new Request(input, init), init?.credentials)),
    { preconnect: () => undefined },
  );
  return spyOn(globalThis, "fetch").mockImplementation(implementation);
};
