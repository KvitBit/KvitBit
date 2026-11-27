// Used before dependencies are installed. Bun's JSONC parser returns unknown.
// @effect-diagnostics preferEffectArray:off
// biome-ignore lint/plugin/no-unknown-parameters lint/plugin/no-unsafe-dictionary-type: Check the JSONC object before reading its fields and validate individual entries at their use sites.
export const isLockObject = (value: unknown): value is Record<string, unknown> =>
  // biome-ignore lint/plugin/no-runtime-typeof: The bootstrap scripts run without Effect installed.
  typeof value === "object" && value !== null && !Array.isArray(value);

// biome-ignore lint/plugin/no-unknown-parameters: Validate fields from Bun's JSONC parser before using them.
export const isLockString = (value: unknown): value is string =>
  // biome-ignore lint/plugin/no-runtime-typeof: The bootstrap scripts run without Effect installed.
  typeof value === "string";
