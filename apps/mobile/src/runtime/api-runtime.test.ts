import { expect, test } from "bun:test";
import { UiError } from "@kvitbit/ui-port/api";
import * as Effect from "effect/Effect";
import { credentialsFor, makeApiRunner } from "./api-runtime";

test("disposing a session runtime resolves an in-flight call as cancelled", async () => {
  const runtime = makeApiRunner("https://kvitbit.test", credentialsFor(null), () => "en");
  const started = Promise.withResolvers<void>();
  const pending = runtime.run(() =>
    Effect.sync(started.resolve).pipe(Effect.andThen(Effect.never)),
  );
  await started.promise;
  await runtime.dispose();
  expect(await pending).toEqual({ _tag: "Err", error: UiError.cancelled });
});
