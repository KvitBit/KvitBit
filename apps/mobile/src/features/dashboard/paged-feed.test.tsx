import { expect, test } from "bun:test";
import { UiError } from "@kvitbit/ui-port/api";
import * as Effect from "effect/Effect";
import { act } from "react";
import { ApiProvider } from "../../runtime/api-runtime";
import { clientRoot } from "../../testing/client-root";
import { eventually } from "../../testing/eventually";
import { TestProviders } from "../../testing/providers";
import { FeedProbe } from "../test-probes";

const root = clientRoot({ keepFetch: true });

test("superseding a feed read aborts it and a failed refresh retains the last good result", async () => {
  const requests: Array<{
    readonly end: (effect: Effect.Effect<string, UiError>) => void;
    readonly signal: AbortSignal;
  }> = [];
  const load = () =>
    Effect.callback<string, UiError>((end, signal) => {
      requests.push({ end, signal });
    });

  await root.render(
    <TestProviders>
      <ApiProvider origin="https://feed.test" token={null}>
        <FeedProbe load={load} />
      </ApiProvider>
    </TestProviders>,
  );
  const waitForRequest = (n: number) => Effect.runPromise(eventually(() => requests.length === n));
  await waitForRequest(1);
  const button = root.container().querySelector("button");
  if (button === null) throw new Error("Feed probe button is missing");
  await act(async () => button.click());
  await waitForRequest(2);
  expect(requests[0]?.signal.aborted).toBe(true);

  await act(async () => requests[1]?.end(Effect.succeed("newest")));
  await act(async () => requests[0]?.end(Effect.succeed("old")));
  expect(button.textContent).toBe("newest");

  await act(async () => button.click());
  await waitForRequest(3);
  expect(button.textContent).toBe("newest");
  await act(async () => requests[2]?.end(Effect.fail(UiError.offline)));
  expect(button.textContent).toBe("newest (Offline)");

  await act(async () => button.click());
  await waitForRequest(4);
  await root.render(null);
  expect(requests[3]?.signal.aborted).toBe(true);
});
