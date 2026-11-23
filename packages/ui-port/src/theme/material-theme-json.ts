/**
 * Material Theme Builder `material-theme.json` import (spec 4.3). The parser gives immediate
 * feedback on import and a local preview; `resolveMaterialTheme` turns a file into a full
 * `ResolvedTheme`, generating any contrast scheme or extended colour the file lacks from its seed.
 * Failures are `Invalid` values, never exceptions.
 */
import {
  EXTENDED_ROLES,
  type ExtendedRole,
  type Hex,
  M3_COLOR_ROLES,
  type M3ColorRole,
  type ResolvedTheme,
} from "@kvitbit/api-contract";
import { Hex as HexSchema, Invalid, type Issue } from "@kvitbit/domain/contract";
import { Exit, Result, Schema } from "effect";
import { type Text, text } from "../text";
import type { ExtendedInput } from "./extended";
import { schemesOf, seedRecipe, withContrastWarnings } from "./resolve";
import type { RoleMap, SchemeVariant } from "./scheme";

/** Theme Builder allows any role key; Kvitbit picks the `M3ColorRole` ones (rule M2). */
const RoleScheme = Schema.Record(Schema.String, Schema.String);

export const MaterialThemeJson = Schema.Struct({
  description: Schema.optional(Schema.String),
  seed: HexSchema,
  coreColors: Schema.Struct({
    primary: HexSchema,
    secondary: Schema.optional(HexSchema),
    tertiary: Schema.optional(HexSchema),
    error: Schema.optional(HexSchema),
    neutral: Schema.optional(HexSchema),
    neutralVariant: Schema.optional(HexSchema),
  }),
  extendedColors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        color: HexSchema,
        description: Schema.optional(Schema.String),
        harmonized: Schema.Boolean,
      }),
    ),
  ),
  schemes: Schema.Struct({
    light: RoleScheme,
    dark: RoleScheme,
    "light-medium-contrast": Schema.optional(RoleScheme),
    "light-high-contrast": Schema.optional(RoleScheme),
    "dark-medium-contrast": Schema.optional(RoleScheme),
    "dark-high-contrast": Schema.optional(RoleScheme),
  }),
  palettes: Schema.optional(Schema.Unknown),
});
export type MaterialThemeJson = typeof MaterialThemeJson.Type;

export const MATERIAL_THEME_FILE_WARNINGS = [
  "missing_contrast_schemes",
  "unknown_roles_ignored",
  "no_extended_colours",
] as const;
export type MaterialThemeFileWarning = (typeof MATERIAL_THEME_FILE_WARNINGS)[number];

export interface ParsedThemeFile {
  /** Sent unchanged as `ThemeSource.MaterialThemeBuilder.json`. */
  readonly json: unknown;
  readonly seed: Hex;
  readonly preview: { readonly light: RoleMap; readonly dark: RoleMap };
  /** Which of paid / proforma / overdue / draft the file defines. */
  readonly extendedFound: ReadonlyArray<ExtendedRole>;
  readonly warnings: ReadonlyArray<MaterialThemeFileWarning>;
  /** Unknown role keys, for the `unknown_roles_ignored` count. */
  readonly unknownRoles: ReadonlyArray<string>;
}

/** Theme Builder scheme key per contrast variant. */
const FILE_SCHEME_KEY = {
  light: "light",
  dark: "dark",
  lightMedium: "light-medium-contrast",
  lightHigh: "light-high-contrast",
  darkMedium: "dark-medium-contrast",
  darkHigh: "dark-high-contrast",
} as const satisfies Record<SchemeVariant, keyof MaterialThemeJson["schemes"]>;

const ROLE_SET: ReadonlySet<string> = new Set(M3_COLOR_ROLES);
const HEX = /^#[0-9A-Fa-f]{6}$/;

const issue = (
  code: Issue["code"],
  path: Issue["path"] = [],
  params?: Record<string, string>,
): Issue => (params === undefined ? { path, code } : { path, code, params });

const invalid = (first: Issue, ...rest: Issue[]) => new Invalid({ issues: [first, ...rest] });

/** UTF-8 length without TextEncoder (ui-port's lib has no DOM). */
export const utf8ByteLength = (s: string): number => {
  let bytes = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
};

const isRecord = (u: unknown): u is Record<string, unknown> =>
  typeof u === "object" && u !== null && !Array.isArray(u);

/** Roles of one file scheme, or the roles that are missing / malformed. */
const pickRoles = (
  scheme: Readonly<Record<string, string>>,
): { roles: Partial<Record<M3ColorRole, Hex>>; missing: M3ColorRole[]; unknown: string[] } => {
  const roles: Partial<Record<M3ColorRole, Hex>> = {};
  const missing: M3ColorRole[] = [];
  for (const role of M3_COLOR_ROLES) {
    const value = scheme[role];
    if (value !== undefined && HEX.test(value)) roles[role] = value.toUpperCase() as Hex;
    else missing.push(role);
  }
  const unknown = Object.keys(scheme).filter((k) => !ROLE_SET.has(k));
  return { roles, missing, unknown };
};

export interface DecodedThemeFile {
  readonly file: MaterialThemeJson;
  readonly seed: Hex;
  /** Complete role maps for the variants the file defines completely. */
  readonly roles: Partial<Record<SchemeVariant, RoleMap>>;
  readonly extended: Partial<Record<ExtendedRole, ExtendedInput>>;
  readonly warnings: ReadonlyArray<MaterialThemeFileWarning>;
  readonly unknownRoles: ReadonlyArray<string>;
}

/**
 * Shape-check an already-parsed file. Light and dark must carry every `M3ColorRole` (rule M2);
 * an incomplete contrast scheme is regenerated from the seed with `missing_contrast_schemes`.
 */
export const decodeMaterialTheme = (json: unknown): Result.Result<DecodedThemeFile, Invalid> => {
  if (isRecord(json) && "seed" in json && !(typeof json.seed === "string" && HEX.test(json.seed)))
    return Result.fail(invalid(issue("theme.seed_invalid", ["seed"])));
  const exit = Schema.decodeUnknownExit(MaterialThemeJson)(json);
  if (Exit.isFailure(exit)) return Result.fail(invalid(issue("theme.json_invalid")));
  const file = exit.value;

  const roles: Partial<Record<SchemeVariant, RoleMap>> = {};
  const unknown = new Set<string>();
  const missingIssues: Issue[] = [];
  let contrastMissing = false;
  for (const [variant, key] of Object.entries(FILE_SCHEME_KEY) as [SchemeVariant, string][]) {
    const scheme = (file.schemes as Readonly<Record<string, Readonly<Record<string, string>>>>)[
      key
    ];
    if (scheme === undefined) {
      contrastMissing = true;
      continue;
    }
    const picked = pickRoles(scheme);
    for (const u of picked.unknown) unknown.add(u);
    if (picked.missing.length === 0) roles[variant] = picked.roles as RoleMap;
    else if (variant === "light" || variant === "dark")
      for (const role of picked.missing)
        missingIssues.push(issue("theme.json_invalid", ["schemes", key, role], { role }));
    else contrastMissing = true;
  }
  const [firstMissing, ...restMissing] = missingIssues;
  if (firstMissing !== undefined) return Result.fail(invalid(firstMissing, ...restMissing));

  const extended: Partial<Record<ExtendedRole, ExtendedInput>> = {};
  for (const entry of file.extendedColors ?? []) {
    const name = entry.name.trim().toLowerCase();
    const role = EXTENDED_ROLES.find((r) => r === name);
    if (role !== undefined && extended[role] === undefined)
      extended[role] = { color: entry.color.toUpperCase() as Hex, harmonized: entry.harmonized };
  }

  const warnings: MaterialThemeFileWarning[] = [];
  if (contrastMissing) warnings.push("missing_contrast_schemes");
  if (unknown.size > 0) warnings.push("unknown_roles_ignored");
  if (Object.keys(extended).length === 0) warnings.push("no_extended_colours");
  return Result.succeed({
    file,
    seed: file.seed.toUpperCase() as Hex,
    roles,
    extended,
    warnings,
    unknownRoles: [...unknown],
  });
};

/**
 * Parse an uploaded file's text. The byte limit (`uploads.themeJson.maxBytes`) is checked before
 * `JSON.parse` (rule M1).
 */
export const parseMaterialThemeFile = (
  source: string,
  maxBytes: number,
): Result.Result<ParsedThemeFile, Invalid> => {
  if (utf8ByteLength(source) > maxBytes)
    return Result.fail(invalid(issue("theme.too_large", [], { maxBytes: String(maxBytes) })));
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    return Result.fail(invalid(issue("theme.json_invalid")));
  }
  return Result.map(decodeMaterialTheme(json), (d) => {
    const light = d.roles.light as RoleMap;
    const dark = d.roles.dark as RoleMap;
    return {
      json,
      seed: d.seed,
      preview: { light, dark },
      extendedFound: EXTENDED_ROLES.filter((r) => d.extended[r] !== undefined),
      warnings: d.warnings,
      unknownRoles: d.unknownRoles,
    };
  });
};

/**
 * A full `ResolvedTheme` from a file: its own schemes where complete, seed-generated contrast
 * schemes otherwise; extended colours from `extendedColors` (honouring `harmonized`) or the
 * built-in sources harmonized toward the file's seed.
 */
export const resolveMaterialTheme = (json: unknown): Result.Result<ResolvedTheme, Invalid> =>
  Result.map(decodeMaterialTheme(json), (d) =>
    withContrastWarnings(
      { _tag: "MaterialThemeBuilder", json },
      schemesOf(seedRecipe(d.seed), {
        rolesFor: (v) => d.roles[v],
        extended: d.extended,
        harmonizeToward: d.seed,
      }),
    ),
  );

/** Copy for a file warning (`theme.warning.<code>`). */
export const fileWarningText = (
  warning: MaterialThemeFileWarning,
  parsed?: Pick<ParsedThemeFile, "unknownRoles">,
): Text =>
  warning === "unknown_roles_ignored"
    ? text("theme.warning.unknown_roles_ignored", { count: parsed?.unknownRoles.length ?? 0 })
    : text(`theme.warning.${warning}`);
