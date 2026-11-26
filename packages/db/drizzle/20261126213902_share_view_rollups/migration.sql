CREATE TABLE "share_view_rollups" (
	"workspace_id" uuid,
	"share_link_id" uuid,
	"day" date,
	"views" bigint NOT NULL,
	"downloads" bigint NOT NULL,
	CONSTRAINT "share_view_rollups_pkey" PRIMARY KEY("workspace_id","share_link_id","day")
);
--> statement-breakpoint
CREATE INDEX "attachments_blob_key_idx" ON "attachments" ("blob_key");--> statement-breakpoint
ALTER TABLE "share_view_rollups" ADD CONSTRAINT "share_view_rollups_share_link_fk" FOREIGN KEY ("workspace_id","share_link_id") REFERENCES "share_links"("workspace_id","id") ON DELETE CASCADE;