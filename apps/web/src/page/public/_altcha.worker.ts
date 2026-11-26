import type { AltchaChallenge } from "@kvitbit/api-contract";
import { solveAltchaChallenge } from "./_altcha-solver";

self.onmessage = async (event: MessageEvent<AltchaChallenge>) => {
  try {
    self.postMessage({ header: await solveAltchaChallenge(event.data) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
