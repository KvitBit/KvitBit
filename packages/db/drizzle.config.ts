import { defineConfig } from "drizzle-kit";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

// `drizzle-kit generate` diffs the schema against the committed snapshots and never connects,
// so the placeholder URL only matters for commands that touch a live database (migrate, push).
const localDatabase = "kvitbit";
const databaseUrl = Config.String("DATABASE_URL_UNPOOLED").pipe(
  Config.orElse(() => Config.String("DATABASE_URL")),
  Config.withDefault(
    `postgres://${localDatabase}:${localDatabase}@localhost:5432/${localDatabase}`,
  ),
);
const url = databaseUrl
  .parse(ConfigProvider.fromEnv({ preserveEmptyStrings: true }))
  .pipe(Effect.runSync);

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  schemaFilter: ["public", "auth"],
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
