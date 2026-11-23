import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` diffs the schema against the committed snapshots and never connects,
// so the placeholder URL only matters for commands that touch a live database (migrate, push).
const url =
  process.env.DATABASE_URL_UNPOOLED ??
  process.env.DATABASE_URL ??
  "postgres://kvitbit:kvitbit@localhost:5432/kvitbit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  schemaFilter: ["public", "auth"],
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
