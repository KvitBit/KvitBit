/**
 * `me` group handlers (http-mcp-contracts 3.5.2, rule T5): read and update account preferences
 * in `user_preferences` with optimistic concurrency (`If-Match` -> 428 / 412, `ETag` via
 * `Revisioned`).
 */
import {
  type AccountPreferences,
  Api,
  CurrentPrincipal,
  DEFAULT_THEME_STYLE,
  type ThemeContrast,
  type ThemeMode,
  type ThemePreference,
  ThemeSource,
  type ThemeStyle,
} from "@kvitbit/api-contract";
import { Conflict, type Invalid, type Locale } from "@kvitbit/domain/contract";
import { Clock, Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { SqlClient } from "effect/sql";
import { withRevision } from "../conventions";
import { resolveThemeSource } from "./credentials/theme";

interface UserPreferencesRow {
  readonly locale: Locale | null;
  readonly theme_mode: ThemeMode;
  readonly theme_style: ThemeStyle;
  readonly theme_contrast: ThemeContrast;
  readonly dynamic_color: boolean;
  readonly theme_source: unknown;
  readonly revision: number;
}

const DEFAULT_THEME_PREFERENCE: ThemePreference = {
  mode: "system",
  style: DEFAULT_THEME_STYLE,
  contrast: "standard",
  dynamicColor: true,
  source: null,
};

const DEFAULT_PREFERENCES: Omit<AccountPreferences, "resolvedTheme"> = {
  locale: null,
  theme: DEFAULT_THEME_PREFERENCE,
  revision: 1,
};

const decodeStoredSource = Schema.decodeUnknownOption(Schema.NullOr(ThemeSource));

const rowToStoredPreferences = (
  row: UserPreferencesRow | undefined,
): Omit<AccountPreferences, "resolvedTheme"> => {
  if (row === undefined) return DEFAULT_PREFERENCES;
  const decodedSource = decodeStoredSource(row.theme_source);
  return {
    locale: row.locale,
    theme: {
      mode: row.theme_mode,
      style: row.theme_style,
      contrast: row.theme_contrast,
      dynamicColor: row.dynamic_color,
      source: Option.getOrElse(decodedSource, () => null),
    },
    revision: row.revision,
  };
};

const withResolvedTheme = (
  prefs: Omit<AccountPreferences, "resolvedTheme">,
): Effect.Effect<AccountPreferences, Invalid> =>
  Effect.map(resolveThemeSource(prefs.theme.source), (resolvedTheme) => ({
    ...prefs,
    resolvedTheme,
  }));

export const MeGroupLive = HttpApiBuilder.group(Api, "me", (handlers) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const readRow = (userId: string) =>
      sql<UserPreferencesRow>`
        select
          locale,
          theme_mode,
          theme_style,
          theme_contrast,
          dynamic_color,
          theme_source,
          revision
        from user_preferences
        where user_id = ${userId}
      `.pipe(Effect.map((rows) => rows[0]));

    return handlers
      .handle("getPreferences", () =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          const row = yield* readRow(principal.userId).pipe(Effect.orDie);
          return yield* withResolvedTheme(rowToStoredPreferences(row));
        }),
      )
      .handle("updatePreferences", ({ headers, payload }) =>
        withRevision(headers["if-match"], (expectedRevision) =>
          Effect.gen(function* () {
            const principal = yield* CurrentPrincipal;
            const now = new Date(yield* Clock.currentTimeMillis);

            // Validate and resolve the incoming theme source before writing to Postgres.
            const incomingResolved =
              payload.theme === undefined
                ? undefined
                : yield* resolveThemeSource(payload.theme.source);

            const saved = yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  const locked = yield* sql<UserPreferencesRow>`
                    select
                      locale,
                      theme_mode,
                      theme_style,
                      theme_contrast,
                      dynamic_color,
                      theme_source,
                      revision
                    from user_preferences
                    where user_id = ${principal.userId}
                    for update
                  `;
                  const existing = locked[0];

                  if (existing === undefined) {
                    if (expectedRevision !== 1) {
                      return yield* new Conflict({
                        reason: "revision_changed",
                        currentRevision: 1,
                      });
                    }
                    const nextLocale = payload.locale ?? null;
                    const nextTheme = payload.theme ?? DEFAULT_THEME_PREFERENCE;
                    const themeSourceJson =
                      nextTheme.source === null ? null : JSON.stringify(nextTheme.source);
                    const inserted = yield* sql<UserPreferencesRow>`
                      insert into user_preferences (
                        user_id,
                        locale,
                        theme_mode,
                        theme_style,
                        theme_contrast,
                        dynamic_color,
                        theme_source,
                        revision,
                        updated_at
                      ) values (
                        ${principal.userId},
                        ${nextLocale},
                        ${nextTheme.mode},
                        ${nextTheme.style},
                        ${nextTheme.contrast},
                        ${nextTheme.dynamicColor},
                        ${themeSourceJson}::jsonb,
                        2,
                        ${now}
                      )
                      on conflict (user_id) do nothing
                      returning
                        locale,
                        theme_mode,
                        theme_style,
                        theme_contrast,
                        dynamic_color,
                        theme_source,
                        revision
                    `;
                    const row = inserted[0];
                    if (row === undefined) {
                      const current = yield* readRow(principal.userId);
                      return yield* new Conflict({
                        reason: "revision_changed",
                        currentRevision: current?.revision ?? 1,
                      });
                    }
                    return row;
                  }

                  if (existing.revision !== expectedRevision) {
                    return yield* new Conflict({
                      reason: "revision_changed",
                      currentRevision: existing.revision,
                    });
                  }

                  const current = rowToStoredPreferences(existing);
                  const nextLocale = payload.locale === undefined ? current.locale : payload.locale;
                  const nextTheme = payload.theme ?? current.theme;
                  const themeSourceJson =
                    nextTheme.source === null ? null : JSON.stringify(nextTheme.source);

                  const updated = yield* sql<UserPreferencesRow>`
                    update user_preferences
                    set
                      locale = ${nextLocale},
                      theme_mode = ${nextTheme.mode},
                      theme_style = ${nextTheme.style},
                      theme_contrast = ${nextTheme.contrast},
                      dynamic_color = ${nextTheme.dynamicColor},
                      theme_source = ${themeSourceJson}::jsonb,
                      revision = revision + 1,
                      updated_at = ${now}
                    where user_id = ${principal.userId}
                      and revision = ${expectedRevision}
                    returning
                      locale,
                      theme_mode,
                      theme_style,
                      theme_contrast,
                      dynamic_color,
                      theme_source,
                      revision
                  `;
                  const row = updated[0];
                  if (row === undefined) {
                    const latest = yield* readRow(principal.userId);
                    return yield* new Conflict({
                      reason: "revision_changed",
                      currentRevision: latest?.revision ?? existing.revision,
                    });
                  }
                  return row;
                }),
              )
              .pipe(
                Effect.catchIf(
                  (e) => !(e instanceof Conflict),
                  (e) => Effect.die(e),
                ),
              );

            const stored = rowToStoredPreferences(saved);
            if (incomingResolved !== undefined) {
              return { ...stored, resolvedTheme: incomingResolved };
            }
            return yield* withResolvedTheme(stored);
          }),
        ).pipe(Effect.catchTag("Conflict", (e) => Effect.die(e))),
      );
  }),
);
