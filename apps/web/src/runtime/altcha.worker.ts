import { AltchaChallenge } from "@kvitbit/api-contract";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { solveAltchaChallenge } from "../page/public/_altcha-solver";

const solveMessage = Schema.decodeUnknownEffect(AltchaChallenge);

globalThis.onmessage = (event: MessageEvent) => {
  Effect.runFork(
    solveMessage(event.data).pipe(
      Effect.flatMap(solveAltchaChallenge),
      Effect.match({
        onSuccess: (header) => globalThis.postMessage({ _tag: "Solved", header }),
        onFailure: (error) =>
          globalThis.postMessage({
            _tag: "Failed",
            reason: "reason" in error ? error.reason : error.message,
          }),
      }),
    ),
  );
};

globalThis.onmessageerror = () =>
  globalThis.postMessage({ _tag: "Failed", reason: "Could not read challenge" });
globalThis.postMessage({ _tag: "Ready" });
