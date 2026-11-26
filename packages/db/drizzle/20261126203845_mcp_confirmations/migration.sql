CREATE TABLE "mcp_confirmations" (
	"id" uuid PRIMARY KEY,
	"token_hash" text NOT NULL UNIQUE,
	"grant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"args_hash" text NOT NULL,
	"subject_revision" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "mcp_confirmations_expires_at_idx" ON "mcp_confirmations" ("expires_at");--> statement-breakpoint
ALTER TABLE "mcp_confirmations" ADD CONSTRAINT "mcp_confirmations_grant_id_oauth_consent_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "auth"."oauth_consent"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mcp_confirmations" ADD CONSTRAINT "mcp_confirmations_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mcp_confirmations" ADD CONSTRAINT "mcp_confirmations_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;