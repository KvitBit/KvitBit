import type { AltchaChallenge } from "@kvitbit/api-contract";
import { type AltchaWorkerMessage, solveAltchaChallenge } from "./_altcha-solver";

const reply = (message: AltchaWorkerMessage) => self.postMessage(message);

self.onmessage = async (event: MessageEvent<AltchaChallenge>) => {
  try {
    reply({ _tag: "Solved", header: await solveAltchaChallenge(event.data) });
  } catch (error) {
    reply({ _tag: "Failed", reason: error instanceof Error ? error.message : String(error) });
  }
};
self.onmessageerror = () => reply({ _tag: "Failed", reason: "Could not read challenge" });
reply({ _tag: "Ready" });
