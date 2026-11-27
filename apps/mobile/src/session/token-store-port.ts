export interface TokenStore {
  readonly usesBearer: boolean;
  readonly read: () => Promise<string | null>;
  readonly write: (token: string) => Promise<void>;
  readonly clear: () => Promise<void>;
}
