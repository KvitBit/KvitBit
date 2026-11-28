import { sql } from "drizzle-orm";
import { boolean, check, pgSchema, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Better Auth storage (http-mcp-contracts.md §2.6-2.7): core tables, passkey, apiKey and the
 * OAuth 2.1 provider. Kept in the `auth` Postgres schema because auth never enters core
 * (http-mcp-contracts.md T5) and because Better Auth's `account` is not the Kvitbit Account.
 * Ids are Better Auth's text ids. Property names equal the Better Auth 1.7.27 model field names
 * (the Drizzle adapter maps by property), and SQL columns are their snake_case forms. Kvitbit-owned additions on
 * `apikey` and `oauth_consent` (workspace_id, created_by, access, scopes) follow
 * http-mcp-contracts.md:853-858.
 */
export const authSchema = pgSchema("auth");

export const authTimestamp = (name: string) => timestamp(name, { withTimezone: true });

export const user = authSchema.table(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: authTimestamp("created_at").notNull().defaultNow(),
    updatedAt: authTimestamp("updated_at").notNull().defaultNow(),
    /**
     * Account deletion tombstone (http-mcp-contracts.md G10, user-flows.md Q7): a deleted account
     * is hidden at once and retained until `purge_after`.
     */
    deletedAt: authTimestamp("deleted_at"),
    purgeAfter: authTimestamp("purge_after"),
  },
  (t) => [
    uniqueIndex("user_email_unique").on(t.email),
    check("user_deletion_complete", sql`(${t.deletedAt} is null) = (${t.purgeAfter} is null)`),
  ],
);
