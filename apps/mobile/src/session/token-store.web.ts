/** The PWA keeps the Better Auth session cookie (scoped to `/`), so there is no bearer to store. */
export const tokenStore = {
  usesBearer: false,
  read: async (): Promise<string | null> => null,
  write: async (_token: string): Promise<void> => undefined,
  clear: async (): Promise<void> => undefined,
};
