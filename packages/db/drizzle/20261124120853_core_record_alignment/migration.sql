CREATE TYPE "recurring_send_state" AS ENUM('none', 'pending', 'queued', 'failed');--> statement-breakpoint
CREATE TABLE "fx_fixing_requests" (
	"requested_on" date PRIMARY KEY,
	"fixing_date" date NOT NULL,
	CONSTRAINT "fx_fixing_requests_not_after_request" CHECK ("fixing_date" <= "requested_on")
);
--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "provider_message_id" text;--> statement-breakpoint
ALTER TABLE "document_lines" ADD COLUMN "deducted_vat_czk" numeric(18,2);--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "deductible_percent" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "paid" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "payments" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD COLUMN "send_state" "recurring_send_state" DEFAULT 'none'::"recurring_send_state" NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "paused_error" text;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "catch_up_through" date;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "schedule_runs_pending_send_idx" ON "schedule_runs" ("at") WHERE "outcome" = 'issued' and "send_state" = 'pending';--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_deducted_vat_czk_on_deduction" CHECK ("deducted_vat_czk" is null or "deducts_document_id" is not null);--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_deductible_percent_range" CHECK ("deductible_percent" between 0 and 100);--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_payments_nonnegative" CHECK ("payments" >= 0);--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_send_needs_issued" CHECK ("send_state" = 'none' or "outcome" = 'issued');--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_queued_has_delivery" CHECK ("send_state" <> 'queued' or "delivery_id" is not null);--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_pause_fields_need_paused_at" CHECK ("paused_at" is not null or ("paused_reason" is null and "paused_error" is null));--> statement-breakpoint
-- Backfill the Expense paid projection (`ExpensePayables.settle`) from the live Payments ledger.
UPDATE "expenses" AS e SET "paid" = s.paid, "payments" = s.n
FROM (
	SELECT "workspace_id", "expense_id", sum("amount") AS paid, count(*)::integer AS n
	FROM "payments" WHERE "expense_id" IS NOT NULL AND "removed_at" IS NULL
	GROUP BY "workspace_id", "expense_id"
) AS s
WHERE e."workspace_id" = s."workspace_id" AND e."id" = s."expense_id";--> statement-breakpoint
-- Backfill the send half of issued runs (RecurringIssuance.send): a recorded delivery is
-- `queued`; a failure on an issued run is a refused send, `failed`. Historical `pending`
-- cannot be told from `none`, so those stay `none`.
UPDATE "schedule_runs" SET "send_state" = CASE WHEN "delivery_id" IS NOT NULL THEN 'queued'::"recurring_send_state" ELSE 'failed'::"recurring_send_state" END
WHERE "outcome" = 'issued' AND ("delivery_id" IS NOT NULL OR "failure" IS NOT NULL);
