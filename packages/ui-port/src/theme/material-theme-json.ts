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
import * as Arr from "effect/Array";
import * as Exit from "effect/Exit";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { type Text, text } from "../text";
import { isHex } from "./color/utils";
import type { ExtendedInput } from "./extended";
import { schemesOf, seedRecipe, withContrastWarnings } from "./resolve";
import { type RoleMap, SCHEME_VARIANTS, type SchemeVariant } from "./scheme";

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
  extendedColors: Schema.Struct({
    name: Schema.String,
    color: HexSchema,
    description: Schema.optional(Schema.String),
    harmonized: Schema.Boolean,
  }).pipe(Schema.Array, Schema.optional),
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

/** `uploads.themeJson.maxBytes` default (64 KB); callers pass the configured value. */
export const MATERIAL_THEME_MAX_BYTES = 64 * 1024;

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
const Json = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownExit(Json);
const encodeJson = Schema.encodeUnknownExit(Json);

const issue = (
  code: Issue["code"],
  path: Issue["path"] = [],
  params?: Record<string, string>,
): Issue => (params === undefined ? { path, code } : { path, code, params });

const invalid = (first: Issue, ...rest: Issue[]) => Invalid.make({ issues: [first, ...rest] });

/** UTF-8 length without TextEncoder (ui-port's lib has no DOM). */
const utf8ByteLength = (s: string): number => {
  let bytes = 0;
  for (const ch of s) {
    const cp = Option.getOrElse(Str.codePointAt(ch, 0), () => 0);
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
};

/** Roles of one file scheme, or the roles that are missing / malformed. */
const pickRoles = (
  scheme: Readonly<Record<string, string>>,
): { roles: Partial<Record<M3ColorRole, Hex>>; missing: M3ColorRole[]; unknown: string[] } => {
  const roles: Partial<Record<M3ColorRole, Hex>> = {};
  const missing: M3ColorRole[] = [];
  for (const role of M3_COLOR_ROLES) {
    const value = scheme[role];
    if (value !== undefined && isHex(value)) roles[role] = Str.toUpperCase(value);
    else missing.push(role);
  }
  const unknown = Arr.filter(Rec.keys(scheme), (k) => !ROLE_SET.has(k));
  return { roles, missing, unknown };
};

const isCompleteRoleMap = (roles: Partial<RoleMap>): roles is RoleMap =>
  Arr.every(M3_COLOR_ROLES, (role) => roles[role] !== undefined);

export interface DecodedThemeFile {
  readonly file: MaterialThemeJson;
  readonly seed: Hex;
  /** Complete role maps for the variants the file defines completely. */
  readonly roles: Partial<Record<SchemeVariant, RoleMap>>;
  readonly extended: Partial<Record<ExtendedRole, ExtendedInput>>;
  readonly warnings: ReadonlyArray<MaterialThemeFileWarning>;
  readonly unknownRoles: ReadonlyArray<string>;
}

type DecodedThemeFileWithPreview = DecodedThemeFile & {
  readonly roles: Readonly<Record<"light" | "dark", RoleMap>>;
};

// biome-ignore lint/plugin/no-unknown-parameters: This Schema boundary accepts arbitrary imported JSON.
const decodeWithPreview = (json: unknown): Result.Result<DecodedThemeFileWithPreview, Invalid> => {
  if (
    Predicate.isObject(json) &&
    "seed" in json &&
    !(Predicate.isString(json.seed) && isHex(json.seed))
  )
    return Result.fail(invalid(issue("theme.seed_invalid", ["seed"])));
  const exit = Schema.decodeUnknownExit(MaterialThemeJson)(json);
  if (Exit.isFailure(exit)) return Result.fail(invalid(issue("theme.json_invalid")));
  const file = exit.value;

  const roles: Partial<Record<SchemeVariant, RoleMap>> = {};
  const unknown = new Set<string>();
  const missingIssues: Issue[] = [];
  let contrastMissing = false;
  for (const variant of SCHEME_VARIANTS) {
    const key = FILE_SCHEME_KEY[variant];
    const scheme = file.schemes[key];
    if (scheme === undefined) {
      contrastMissing = true;
      continue;
    }
    const picked = pickRoles(scheme);
    for (const u of picked.unknown) unknown.add(u);
    if (isCompleteRoleMap(picked.roles)) roles[variant] = picked.roles;
    else if (variant === "light" || variant === "dark")
      for (const role of picked.missing)
        missingIssues.push(issue("theme.json_invalid", ["schemes", key, role], { role }));
    else contrastMissing = true;
  }
  const [firstMissing, ...restMissing] = missingIssues;
  if (firstMissing !== undefined) return Result.fail(invalid(firstMissing, ...restMissing));
  const { light, dark } = roles;
  if (light === undefined || dark === undefined) {
    return Result.fail(invalid(issue("theme.json_invalid")));
  }

  const extended: Partial<Record<ExtendedRole, ExtendedInput>> = {};
  for (const entry of file.extendedColors ?? []) {
    const name = Str.toLowerCase(Str.trim(entry.name));
    const role = Arr.findFirst(EXTENDED_ROLES, (r) => r === name);
    if (role._tag === "Some" && extended[role.value] === undefined)
      extended[role.value] = { color: Str.toUpperCase(entry.color), harmonized: entry.harmonized };
  }

  const warnings: MaterialThemeFileWarning[] = [];
  if (contrastMissing) warnings.push("missing_contrast_schemes");
  if (unknown.size > 0) warnings.push("unknown_roles_ignored");
  if (!Arr.some(EXTENDED_ROLES, (role) => extended[role] !== undefined))
    warnings.push("no_extended_colours");
  return Result.succeed({
    file,
    seed: Str.toUpperCase(file.seed),
    roles: { ...roles, light, dark },
    extended,
    warnings,
    unknownRoles: [...unknown],
  });
};

/**
 * Shape-check an already-parsed file. Light and dark must carry every `M3ColorRole` (rule M2);
 * an incomplete contrast scheme is regenerated from the seed with `missing_contrast_schemes`.
 */
// biome-ignore lint/plugin/no-unknown-parameters: Callers pass unvalidated theme data to the decoder.
export const decodeMaterialTheme = (json: unknown): Result.Result<DecodedThemeFile, Invalid> =>
  decodeWithPreview(json);

/**
 * Parse an uploaded file's text. The byte limit (`uploads.themeJson.maxBytes`) is checked before
 * `JSON.parse` (rule M1).
 */
export const parseMaterialThemeFile: {
  (maxBytes: number): (source: string) => Result.Result<ParsedThemeFile, Invalid>;
  (source: string, maxBytes: number): Result.Result<ParsedThemeFile, Invalid>;
} = Fn.dual(2, (source: string, maxBytes: number): Result.Result<ParsedThemeFile, Invalid> => {
  if (utf8ByteLength(source) > maxBytes)
    return Result.fail(invalid(issue("theme.too_large", [], { maxBytes: String(maxBytes) })));
  const parsed = decodeJson(source);
  if (Exit.isFailure(parsed)) return Result.fail(invalid(issue("theme.json_invalid")));
  const json = parsed.value;
  return Result.map(decodeWithPreview(json), (d) => {
    const { light, dark } = d.roles;
    return {
      json,
      seed: d.seed,
      preview: { light, dark },
      extendedFound: Arr.filter(EXTENDED_ROLES, (r) => d.extended[r] !== undefined),
      warnings: d.warnings,
      unknownRoles: d.unknownRoles,
    };
  });
});

/**
 * A full `ResolvedTheme` from a file: its own schemes where complete, seed-generated contrast
 * schemes otherwise; extended colours from `extendedColors` (honouring `harmonized`) or the
 * built-in sources harmonized toward the file's seed.
 */
// A numeric JSON value and a curried byte limit would have the same call shape.
// @effect-diagnostics-next-line missingPipeableSignature:off
export const resolveMaterialTheme = (
  // biome-ignore lint/plugin/no-unknown-parameters: Check the size and shape of the unvalidated ThemeSource payload.
  json: unknown,
  maxBytes: number = MATERIAL_THEME_MAX_BYTES,
): Result.Result<ResolvedTheme, Invalid> => {
  // The structured path enforces the same encoded limit as the text parser (rule M1).
  const encoded = encodeJson(json);
  if (Exit.isFailure(encoded)) return Result.fail(invalid(issue("theme.json_invalid")));
  if (utf8ByteLength(encoded.value) > maxBytes)
    return Result.fail(invalid(issue("theme.too_large", [], { maxBytes: String(maxBytes) })));
  return Result.map(decodeMaterialTheme(json), (d) =>
    withContrastWarnings(
      { _tag: "MaterialThemeBuilder", json },
      schemesOf(seedRecipe(d.seed), {
        rolesFor: (v) => d.roles[v],
        extended: d.extended,
      }),
    ),
  );
};

/** Copy for a file warning (`theme.warning.<code>`). */
export const fileWarningText: {
  (parsed?: Pick<ParsedThemeFile, "unknownRoles">): (warning: MaterialThemeFileWarning) => Text;
  (warning: MaterialThemeFileWarning, parsed?: Pick<ParsedThemeFile, "unknownRoles">): Text;
} = Fn.dual(
  (args) => Predicate.isString(args[0]),
  (warning: MaterialThemeFileWarning, parsed?: Pick<ParsedThemeFile, "unknownRoles">): Text =>
    warning === "unknown_roles_ignored"
      ? text("theme.warning.unknown_roles_ignored", { count: parsed?.unknownRoles.length ?? 0 })
      : text(`theme.warning.${warning}`),
);
