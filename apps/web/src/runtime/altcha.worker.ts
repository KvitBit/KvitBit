import { AltchaChallenge } from "@kvitbit/api-contract";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { solveAltchaChallenge } from "../page/public/_altcha-solver";

const solveMessage = Schema.decodeUnknownEffect(AltchaChallenge);

globalThis.onmessage = (event: MessageEvent) => {
  // biome-ignore lint/plugin/no-direct-effect-runs: This module is the worker's entry point.
  Effect.runFork(
    solveMessage(event.data).pipe(
      Effect.flatMap(solveAltchaChallenge),
      Effect.match({
        onSuccess: (header) => globalThis.postMessage({ header }),
        onFailure: (error) =>
          globalThis.postMessage({ error: "reason" in error ? error.reason : error.message }),
      }),
    ),
  );
};
