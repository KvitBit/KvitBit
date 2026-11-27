export {};

// The Bun type declarations extend NodeJS.ProcessEnv with Bun.Env.
declare module "bun" {
  interface Env {
    /** Expo inlines this variable when accessed with dot notation. */
    readonly EXPO_PUBLIC_API_ORIGIN?: string;
  }
}
