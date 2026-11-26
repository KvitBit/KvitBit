CREATE TYPE "document_settlement" AS ENUM('unpaid', 'partially_paid', 'paid', 'overpaid', 'credited');--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "sequence" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "reply_to" text;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "attachment" jsonb;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "arms" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "due_on" date;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "reminder_due_on" date;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "reminder_offset_days" integer;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "reminder_armed_by" integer;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "last_outcome" text;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "document_lines" ADD COLUMN "item_price" jsonb;--> statement-breakpoint
ALTER TABLE "document_lines" ADD COLUMN "given_vat" "vat_treatment";--> statement-breakpoint
ALTER TABLE "document_lines" ADD COLUMN "item_vat" "vat_treatment";--> statement-breakpoint
ALTER TABLE "document_lines" ADD COLUMN "rate_percent" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_lines" ADD COLUMN "amount" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "fx_override" jsonb;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "given" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "tax_document" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "payment_rounding" "payment_rounding" DEFAULT 'none'::"payment_rounding" NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "paid_amount" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "payments" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "settlement" "document_settlement" DEFAULT 'unpaid'::"document_settlement" NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "corrected_number" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "cancelled_on" date;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "figures" jsonb;--> statement-breakpoint
ALTER TABLE "exports" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "last_sent_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "accepted_by" text;--> statement-breakpoint
ALTER TABLE "issuing_entities" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "issuing_entities" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "issuing_entities" ADD COLUMN "web" text;--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_document_sequence" ON "deliveries" ("workspace_id","document_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_reminder_step" ON "deliveries" ("workspace_id","document_id","reminder_due_on","reminder_offset_days","reminder_armed_by") WHERE "reminder_due_on" is not null and not ("status" = 'skipped' and "attempts" = 0 and "last_outcome" is null);--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_contact_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "contacts"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_user_id_fkey" FOREIGN KEY ("accepted_by") REFERENCES "auth"."user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_reminder_step_complete" CHECK (("reminder_due_on" is null) = ("reminder_offset_days" is null) and ("reminder_due_on" is null) = ("reminder_armed_by" is null));--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_attempts_nonnegative" CHECK ("attempts" >= 0);--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_last_outcome_values" CHECK ("last_outcome" is null or "last_outcome" in ('not_accepted', 'outcome_unknown'));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_payments_nonnegative" CHECK ("payments" >= 0);