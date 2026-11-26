export interface CaptureStorage {
  readonly load: (scope: string) => Promise<string | null>;
  readonly save: (scope: string, value: string, previous: string) => Promise<void>;
  readonly lock: <T>(scope: string, work: () => Promise<T>) => Promise<T>;
}
