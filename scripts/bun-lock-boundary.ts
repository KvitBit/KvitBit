// Used before dependencies are installed. Bun's JSONC parser returns unknown.

export const isLockObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isLockString = (value: unknown): value is string => typeof value === "string";
