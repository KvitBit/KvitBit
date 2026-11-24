/** The AuthClient bound to the current session. Stub until auth-client.ts lands (stream m-auth/A). */
import type { AuthClient } from "./auth-port";

export const useAuthClient = (): AuthClient => {
  throw new Error("useAuthClient: not implemented yet");
};
