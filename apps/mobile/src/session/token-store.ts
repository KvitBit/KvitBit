/** The Better Auth session bearer on Android, kept in the Keystore-backed SecureStore. */
import * as SecureStore from "expo-secure-store";

const KEY = "kvitbit.session-token";

export const tokenStore = {
  /** Native builds carry a bearer; the PWA (token-store.web.ts) rides the session cookie. */
  usesBearer: true,
  read: (): Promise<string | null> => SecureStore.getItemAsync(KEY),
  write: (token: string): Promise<void> => SecureStore.setItemAsync(KEY, token),
  clear: (): Promise<void> => SecureStore.deleteItemAsync(KEY),
};
