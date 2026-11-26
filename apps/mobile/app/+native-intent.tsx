import { apiOrigin } from "../src/config/env";
import { nativeAuthPath } from "../src/features/auth/auth-links";

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return nativeAuthPath(path, apiOrigin());
}
