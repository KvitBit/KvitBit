CREATE SCHEMA "auth";
--> statement-breakpoint
CREATE TYPE "access_mode" AS ENUM('read', 'read_write', 'custom');--> statement-breakpoint
CREATE TYPE "bot_scope" AS ENUM('sign_up', 'sign_in', 'magic_link', 'password_reset', 'invitation_accept');--> statement-breakpoint
CREATE TYPE "cadence_unit" AS ENUM('weeks', 'months', 'years');--> statement-breakpoint
CREATE TYPE "channel" AS ENUM('web', 'mobile', 'api', 'mcp');--> statement-breakpoint
CREATE TYPE "client_kind" AS ENUM('api_key', 'mcp');--> statement-breakpoint
CREATE TYPE "contact_role" AS ENUM('customer', 'supplier');--> statement-breakpoint
CREATE TYPE "delivery_purpose" AS ENUM('document', 'reminder');--> statement-breakpoint
CREATE TYPE "delivery_status" AS ENUM('queued', 'sending', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "document_kind" AS ENUM('invoice', 'proforma', 'payment_tax_document', 'credit_note');--> statement-breakpoint
CREATE TYPE "document_relation" AS ENUM('corrects', 'corrected_by', 'advance_of', 'tax_document_for', 'final_invoice_for', 'deducts');--> statement-breakpoint
CREATE TYPE "document_status" AS ENUM('draft', 'issued', 'cancelled');--> statement-breakpoint
CREATE TYPE "draftable_kind" AS ENUM('invoice', 'proforma');--> statement-breakpoint
CREATE TYPE "entity_kind" AS ENUM('Workspace', 'Member', 'Invitation', 'Contact', 'PriceListItem', 'Document', 'Payment', 'Expense', 'Attachment', 'Template', 'Schedule', 'NumberingSeries', 'BankAccount', 'ShareLink', 'BrandingImage', 'Export', 'ApiKey', 'McpGrant');--> statement-breakpoint
CREATE TYPE "expense_status" AS ENUM('complete', 'incomplete');--> statement-breakpoint
CREATE TYPE "export_status" AS ENUM('running', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "fx_source" AS ENUM('cnb', 'manual');--> statement-breakpoint
CREATE TYPE "invitation_role" AS ENUM('admin', 'member', 'accountant');--> statement-breakpoint
CREATE TYPE "invitation_status" AS ENUM('pending', 'expired', 'revoked', 'accepted');--> statement-breakpoint
CREATE TYPE "locale" AS ENUM('cs', 'en');--> statement-breakpoint
CREATE TYPE "payment_method" AS ENUM('bank_transfer', 'cash', 'card', 'other');--> statement-breakpoint
CREATE TYPE "payment_rounding" AS ENUM('none', 'whole_unit');--> statement-breakpoint
CREATE TYPE "pdf_template" AS ENUM('classic', 'modern_minimal');--> statement-breakpoint
CREATE TYPE "recurring_outcome" AS ENUM('issued', 'failed', 'skipped_missed');--> statement-breakpoint
CREATE TYPE "reminder_policy_mode" AS ENUM('inherit', 'disabled', 'custom');--> statement-breakpoint
CREATE TYPE "reminders_choice" AS ENUM('on', 'off', 'inherit');--> statement-breakpoint
CREATE TYPE "role" AS ENUM('owner', 'admin', 'member', 'accountant');--> statement-breakpoint
CREATE TYPE "share_device" AS ENUM('desktop', 'mobile', 'tablet', 'unknown');--> statement-breakpoint
CREATE TYPE "share_event_kind" AS ENUM('view', 'download');--> statement-breakpoint
CREATE TYPE "system_job" AS ENUM('RecurringIssuance', 'PaymentReminders', 'DocumentDelivery', 'DataExport');--> statement-breakpoint
CREATE TYPE "tax_regime" AS ENUM('non_vat_payer', 'vat_payer', 'identified_person');--> statement-breakpoint
CREATE TYPE "theme_contrast" AS ENUM('standard', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "theme_mode" AS ENUM('system', 'light', 'dark');--> statement-breakpoint
CREATE TYPE "theme_style" AS ENUM('elegant', 'cozy');--> statement-breakpoint
CREATE TYPE "vat_treatment" AS ENUM('standard', 'reduced', 'exempt_intra_eu_goods', 'reverse_charge', 'outside_scope');--> statement-breakpoint
CREATE TABLE "auth"."account" (
	"id" text PRIMARY KEY,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."apikey" (
	"id" text PRIMARY KEY,
	"config_id" text,
	"name" text,
	"start" text,
	"prefix" text,
	"key" text NOT NULL,
	"reference_id" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"rate_limit_enabled" boolean DEFAULT true NOT NULL,
	"rate_limit_time_window" integer,
	"rate_limit_max" integer,
	"request_count" integer DEFAULT 0 NOT NULL,
	"remaining" integer,
	"last_request" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"permissions" text,
	"metadata" text,
	"workspace_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"access" "access_mode" NOT NULL,
	"scopes" text[] NOT NULL,
	CONSTRAINT "apikey_scopes_nonempty" CHECK (cardinality("scopes") > 0)
);
--> statement-breakpoint
CREATE TABLE "auth"."oauth_access_token" (
	"id" text PRIMARY KEY,
	"token" text,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text,
	"reference_id" text,
	"consent_id" text,
	"refresh_id" text,
	"resources" text[],
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone,
	"revoked" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth"."oauth_client" (
	"id" text PRIMARY KEY,
	"client_id" text NOT NULL,
	"client_secret" text,
	"disabled" boolean DEFAULT false,
	"skip_consent" boolean,
	"enable_end_session" boolean,
	"subject_type" text,
	"scopes" text[],
	"user_id" text,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" text[],
	"tos" text,
	"policy" text,
	"software_id" text,
	"software_version" text,
	"software_statement" text,
	"redirect_uris" text[] NOT NULL,
	"post_logout_redirect_uris" text[],
	"token_endpoint_auth_method" text,
	"application_type" text,
	"jwks" text,
	"jwks_uri" text,
	"grant_types" text[],
	"response_types" text[],
	"require_pkce" boolean,
	"reference_id" text,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "auth"."oauth_consent" (
	"id" text PRIMARY KEY,
	"client_id" text NOT NULL,
	"user_id" text,
	"reference_id" text,
	"resources" text[],
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"workspace_id" uuid,
	"access" "access_mode",
	"granted_scopes" text[],
	"last_used_at" timestamp with time zone,
	CONSTRAINT "oauth_consent_grant_complete" CHECK (("workspace_id" is null) = ("access" is null) and ("workspace_id" is null) = ("granted_scopes" is null))
);
--> statement-breakpoint
CREATE TABLE "auth"."oauth_refresh_token" (
	"id" text PRIMARY KEY,
	"token" text NOT NULL,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text NOT NULL,
	"reference_id" text,
	"consent_id" text,
	"resources" text[],
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone,
	"revoked" timestamp with time zone,
	"auth_time" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth"."passkey" (
	"id" text PRIMARY KEY,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" bigint NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"aaguid" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "auth"."rate_limit" (
	"id" text PRIMARY KEY,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."session" (
	"id" text PRIMARY KEY,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."user" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."verification" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_preferred_series" (
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid,
	"kind" "document_kind",
	"series_id" uuid NOT NULL,
	CONSTRAINT "contact_preferred_series_pkey" PRIMARY KEY("contact_id","kind")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"roles" "contact_role"[] DEFAULT '{customer}'::"contact_role"[] NOT NULL,
	"name" text NOT NULL,
	"ico" text,
	"dic" text,
	"legal_form" text,
	"street" text,
	"city" text,
	"postal_code" text,
	"country" text DEFAULT 'CZ' NOT NULL,
	"billing_emails" text[] DEFAULT '{}'::text[] NOT NULL,
	"phone" text,
	"note" text,
	"registry_fetched_at" timestamp with time zone,
	"default_currency" char(3),
	"default_language" "locale",
	"default_due_days" integer,
	"default_payment_method" "payment_method",
	"default_note" text,
	"reminder_policy_mode" "reminder_policy_mode" DEFAULT 'inherit'::"reminder_policy_mode" NOT NULL,
	"reminder_offsets_days" integer[],
	"archived_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "contacts_reminder_offsets_match_mode" CHECK (("reminder_policy_mode" = 'custom') = ("reminder_offsets_days" is not null)),
	CONSTRAINT "contacts_roles_nonempty" CHECK (cardinality("roles") > 0),
	CONSTRAINT "contacts_default_due_days_nonnegative" CHECK ("default_due_days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "price_list_items" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"unit" text,
	"unit_price" numeric NOT NULL,
	"currency" char(3) NOT NULL,
	"vat" "vat_treatment",
	"archived_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_list_items_workspace_id_id_unique" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"document_revision" integer NOT NULL,
	"purpose" "delivery_purpose" NOT NULL,
	"status" "delivery_status" DEFAULT 'queued'::"delivery_status" NOT NULL,
	"recipients" text[] NOT NULL,
	"language" "locale" NOT NULL,
	"subject" text NOT NULL,
	"render_model" jsonb NOT NULL,
	"reminder_epoch" integer,
	"failure" text,
	"workflow_started_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliveries_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "deliveries_recipients_nonempty" CHECK (cardinality("recipients") > 0),
	CONSTRAINT "deliveries_reminder_epoch_purpose" CHECK ("reminder_epoch" is null or "purpose" = 'reminder')
);
--> statement-breakpoint
CREATE TABLE "document_lines" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"price_list_item_id" uuid,
	"description" text NOT NULL,
	"quantity" numeric DEFAULT '1' NOT NULL,
	"unit" text,
	"unit_price" numeric NOT NULL,
	"vat" "vat_treatment" NOT NULL,
	CONSTRAINT "document_lines_document_position_unique" UNIQUE("document_id","position")
);
--> statement-breakpoint
CREATE TABLE "document_relations" (
	"workspace_id" uuid NOT NULL,
	"from_document_id" uuid,
	"to_document_id" uuid,
	"relation" "document_relation",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_relations_pkey" PRIMARY KEY("from_document_id","to_document_id","relation"),
	CONSTRAINT "document_relations_not_self" CHECK ("from_document_id" <> "to_document_id")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"kind" "document_kind" NOT NULL,
	"status" "document_status" DEFAULT 'draft'::"document_status" NOT NULL,
	"number" text,
	"series_id" uuid,
	"contact_id" uuid NOT NULL,
	"bank_account_id" uuid,
	"currency" char(3) NOT NULL,
	"language" "locale" NOT NULL,
	"issued_on" date,
	"taxable_supply_on" date,
	"due_on" date,
	"due_in_days" integer,
	"payment_method" "payment_method" NOT NULL,
	"prices_include_vat" boolean DEFAULT false NOT NULL,
	"variable_symbol" text,
	"order_number" text,
	"note" text,
	"fx_rate" numeric,
	"fx_quantity" integer,
	"fx_fixing_date" date,
	"fx_source" "fx_source",
	"contact_snapshot" jsonb,
	"issuer_snapshot" jsonb,
	"vat_breakdown" jsonb,
	"total_net" numeric(18,2),
	"total_vat" numeric(18,2),
	"total_gross" numeric(18,2),
	"locked" boolean DEFAULT false NOT NULL,
	"reminders_choice" "reminders_choice" DEFAULT 'inherit'::"reminders_choice" NOT NULL,
	"reminders_on" boolean DEFAULT false NOT NULL,
	"reminder_epoch" integer DEFAULT 0 NOT NULL,
	"schedule_id" uuid,
	"occurrence" date,
	"issued_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "documents_number_iff_not_draft" CHECK (("status" = 'draft') = ("number" is null)),
	CONSTRAINT "documents_occurrence_with_schedule" CHECK (("schedule_id" is null) = ("occurrence" is null)),
	CONSTRAINT "documents_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "documents_fx_complete" CHECK (("fx_rate" is null) = ("fx_source" is null) and ("fx_rate" is null) = ("fx_quantity" is null)),
	CONSTRAINT "documents_fx_positive" CHECK ("fx_rate" > 0 and "fx_quantity" >= 1),
	CONSTRAINT "documents_reminder_epoch_nonnegative" CHECK ("reminder_epoch" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid,
	"expense_id" uuid,
	"amount" numeric(18,2) NOT NULL,
	"currency" char(3) NOT NULL,
	"paid_on" date NOT NULL,
	"method" "payment_method" NOT NULL,
	"note" text,
	"tax_document_id" uuid,
	"removed_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "payments_one_target" CHECK (num_nonnulls("document_id", "expense_id") = 1),
	CONSTRAINT "payments_amount_positive" CHECK ("amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"key_version" integer NOT NULL,
	"created_by" text,
	"viewed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_links_workspace_id_id_unique" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "share_view_events" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"share_link_id" uuid NOT NULL,
	"kind" "share_event_kind" NOT NULL,
	"device" "share_device" NOT NULL,
	"visitor_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
	"blob_key" text NOT NULL,
	"file_name" text,
	"content_type" text NOT NULL,
	"bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachments_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "attachments_expense_sha256_unique" UNIQUE("expense_id","sha256"),
	CONSTRAINT "attachments_bytes_nonnegative" CHECK ("bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"status" "expense_status" DEFAULT 'complete'::"expense_status" NOT NULL,
	"contact_id" uuid,
	"supplier_name" text,
	"supplier_ico" text,
	"supplier_dic" text,
	"supplier_document_number" text,
	"issued_on" date,
	"taxable_supply_on" date,
	"due_on" date,
	"currency" char(3),
	"vat_breakdown" jsonb,
	"total_gross" numeric(18,2),
	"category" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"note" text,
	"fx_rate" numeric,
	"fx_quantity" integer,
	"fx_fixing_date" date,
	"fx_source" "fx_source",
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "expenses_complete_required" CHECK ("status" = 'incomplete' or ("issued_on" is not null and "currency" is not null and "total_gross" is not null))
);
--> statement-breakpoint
CREATE TABLE "schedule_runs" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	"occurrence" date NOT NULL,
	"outcome" "recurring_outcome" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document_id" uuid,
	"delivery_id" uuid,
	"delivery_status" "delivery_status",
	"failure" text,
	CONSTRAINT "schedule_runs_schedule_occurrence_unique" UNIQUE("schedule_id","occurrence")
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"cadence_unit" "cadence_unit" NOT NULL,
	"cadence_interval" integer NOT NULL,
	"start_on" date NOT NULL,
	"end_on" date,
	"issue_as" "draftable_kind" NOT NULL,
	"auto_send" boolean DEFAULT false NOT NULL,
	"next_occurrence" date,
	"paused_reason" text,
	"paused_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedules_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "schedules_interval_positive" CHECK ("cadence_interval" > 0),
	CONSTRAINT "schedules_end_after_start" CHECK ("end_on" is null or "end_on" >= "start_on")
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "draftable_kind" NOT NULL,
	"contact_id" uuid NOT NULL,
	"due_in_days" integer,
	"body" jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "templates_workspace_id_id_unique" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "altcha_replays" (
	"challenge_digest" text PRIMARY KEY,
	"scope" "bot_scope" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_entries" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" text,
	"actor_channel" "channel",
	"actor_client_kind" "client_kind",
	"actor_client_id" text,
	"actor_client_name" text,
	"actor_system_job" "system_job",
	"subject_entity" "entity_kind" NOT NULL,
	"subject_id" text NOT NULL,
	"subject_revision" integer,
	"action" text NOT NULL,
	"changes" jsonb DEFAULT '[]' NOT NULL,
	"reason" text,
	CONSTRAINT "audit_entries_one_actor" CHECK (("actor_user_id" is not null and "actor_channel" is not null and "actor_system_job" is null) or ("actor_user_id" is null and "actor_channel" is null and "actor_system_job" is not null)),
	CONSTRAINT "audit_entries_client_complete" CHECK (("actor_client_kind" is null) = ("actor_client_id" is null) and ("actor_client_kind" is null) = ("actor_client_name" is null))
);
--> statement-breakpoint
CREATE TABLE "exports" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"status" "export_status" DEFAULT 'running'::"export_status" NOT NULL,
	"requested_by" text,
	"blob_key" text,
	"size_bytes" bigint,
	"failure" text,
	"workflow_started_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fx_fixings" (
	"fixing_date" date PRIMARY KEY,
	"sequence" integer NOT NULL,
	"rates" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_log" (
	"workspace_id" uuid,
	"user_id" text,
	"request_key" text NOT NULL,
	"method" text NOT NULL,
	"payload_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_log_one_scope" CHECK (num_nonnulls("workspace_id", "user_id") >= 1)
);
--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"label" text,
	"currency" char(3) NOT NULL,
	"account_number" text,
	"bank_code" text,
	"iban" text,
	"bic" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_accounts_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "bank_accounts_has_number" CHECK ("iban" is not null or ("account_number" is not null and "bank_code" is not null))
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "invitation_role" NOT NULL,
	"status" "invitation_status" DEFAULT 'pending'::"invitation_status" NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" text NOT NULL,
	"send_epoch" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"workflow_started_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_workspace_id_id_unique" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "issuing_entities" (
	"workspace_id" uuid PRIMARY KEY,
	"legal_name" text NOT NULL,
	"legal_form" text,
	"ico" text,
	"dic" text,
	"street" text,
	"city" text,
	"postal_code" text,
	"country" text DEFAULT 'CZ' NOT NULL,
	"commercial_register" text,
	"sender_name" text,
	"registry_fetched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"workspace_id" uuid,
	"user_id" text,
	"role" "role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_pkey" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "number_reservations" (
	"workspace_id" uuid,
	"kind" "document_kind",
	"number" text,
	"series_id" uuid,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "number_reservations_pkey" PRIMARY KEY("workspace_id","kind","number")
);
--> statement-breakpoint
CREATE TABLE "numbering_counters" (
	"workspace_id" uuid NOT NULL,
	"series_id" uuid,
	"period" text,
	"next_counter" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "numbering_counters_pkey" PRIMARY KEY("series_id","period"),
	CONSTRAINT "numbering_counters_period_format" CHECK ("period" ~ '^([0-9]{4}(-[0-9]{2})?|all)$'),
	CONSTRAINT "numbering_counters_positive" CHECK ("next_counter" >= 1)
);
--> statement-breakpoint
CREATE TABLE "numbering_series" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"kind" "document_kind" NOT NULL,
	"name" text NOT NULL,
	"pattern" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "numbering_series_workspace_id_id_unique" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "tax_regime_periods" (
	"workspace_id" uuid,
	"effective_from" date,
	"regime" "tax_regime" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_regime_periods_pkey" PRIMARY KEY("workspace_id","effective_from")
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"user_id" text PRIMARY KEY,
	"locale" "locale" DEFAULT 'cs'::"locale" NOT NULL,
	"theme_mode" "theme_mode" DEFAULT 'system'::"theme_mode" NOT NULL,
	"theme_style" "theme_style" DEFAULT 'elegant'::"theme_style" NOT NULL,
	"theme_contrast" "theme_contrast" DEFAULT 'standard'::"theme_contrast" NOT NULL,
	"dynamic_color" boolean DEFAULT true NOT NULL,
	"theme_source" jsonb,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_slug_aliases" (
	"slug" text PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"default_currency" char(3) DEFAULT 'CZK' NOT NULL,
	"default_language" "locale" DEFAULT 'cs'::"locale" NOT NULL,
	"default_due_days" integer DEFAULT 14 NOT NULL,
	"default_payment_method" "payment_method" DEFAULT 'bank_transfer'::"payment_method" NOT NULL,
	"constant_symbol" text,
	"payment_rounding" "payment_rounding" DEFAULT 'none'::"payment_rounding" NOT NULL,
	"auto_send_payment_tax_document" boolean DEFAULT false NOT NULL,
	"reminders_enabled" boolean DEFAULT true NOT NULL,
	"reminders_for_proformas" boolean DEFAULT false NOT NULL,
	"reminder_offsets_days" integer[] DEFAULT '{3,10,30}'::integer[] NOT NULL,
	"pdf_template" "pdf_template" DEFAULT 'classic'::"pdf_template" NOT NULL,
	"accent_color" text,
	"footer_text" text,
	"theme_source" jsonb,
	"logo" jsonb,
	"stamp" jsonb,
	"closed_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slug_format" CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
	CONSTRAINT "workspaces_default_currency_format" CHECK ("default_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "workspaces_accent_color_format" CHECK ("accent_color" ~ '^#[0-9A-Fa-f]{6}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_account_unique" ON "auth"."account" ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "auth"."account" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "apikey_key_unique" ON "auth"."apikey" ("key");--> statement-breakpoint
CREATE INDEX "apikey_reference_id_idx" ON "auth"."apikey" ("reference_id");--> statement-breakpoint
CREATE INDEX "apikey_workspace_created_by_idx" ON "auth"."apikey" ("workspace_id","created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_access_token_token_unique" ON "auth"."oauth_access_token" ("token");--> statement-breakpoint
CREATE INDEX "oauth_access_token_client_id_idx" ON "auth"."oauth_access_token" ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_access_token_user_id_idx" ON "auth"."oauth_access_token" ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_access_token_consent_id_idx" ON "auth"."oauth_access_token" ("consent_id");--> statement-breakpoint
CREATE INDEX "oauth_access_token_refresh_id_idx" ON "auth"."oauth_access_token" ("refresh_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_client_client_id_unique" ON "auth"."oauth_client" ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_client_user_id_idx" ON "auth"."oauth_client" ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_consent_client_id_idx" ON "auth"."oauth_consent" ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_consent_user_id_idx" ON "auth"."oauth_consent" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_consent_grant_unique" ON "auth"."oauth_consent" ("client_id","user_id","workspace_id");--> statement-breakpoint
CREATE INDEX "oauth_consent_workspace_id_idx" ON "auth"."oauth_consent" ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_refresh_token_token_unique" ON "auth"."oauth_refresh_token" ("token");--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_client_id_idx" ON "auth"."oauth_refresh_token" ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_user_id_idx" ON "auth"."oauth_refresh_token" ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_consent_id_idx" ON "auth"."oauth_refresh_token" ("consent_id");--> statement-breakpoint
CREATE INDEX "passkey_user_id_idx" ON "auth"."passkey" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "passkey_credential_id_unique" ON "auth"."passkey" ("credential_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rate_limit_key_unique" ON "auth"."rate_limit" ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_unique" ON "auth"."session" ("token");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "auth"."session" ("user_id");--> statement-breakpoint
CREATE INDEX "session_expires_at_idx" ON "auth"."session" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_unique" ON "auth"."user" ("email");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "auth"."verification" ("identifier");--> statement-breakpoint
CREATE INDEX "verification_expires_at_idx" ON "auth"."verification" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_active_ico_unique" ON "contacts" ("workspace_id","ico") WHERE "archived_at" is null and "ico" is not null;--> statement-breakpoint
CREATE INDEX "contacts_workspace_name_idx" ON "contacts" ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "deliveries_document_idx" ON "deliveries" ("document_id");--> statement-breakpoint
CREATE INDEX "deliveries_pending_idx" ON "deliveries" ("status","workflow_started_at") WHERE "status" in ('queued', 'sending');--> statement-breakpoint
CREATE INDEX "document_relations_to_idx" ON "document_relations" ("to_document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_number_unique" ON "documents" ("workspace_id","kind","number") WHERE "number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_schedule_occurrence_unique" ON "documents" ("schedule_id","occurrence") WHERE "schedule_id" is not null;--> statement-breakpoint
CREATE INDEX "documents_workspace_status_idx" ON "documents" ("workspace_id","status","issued_on");--> statement-breakpoint
CREATE INDEX "documents_workspace_contact_idx" ON "documents" ("workspace_id","contact_id");--> statement-breakpoint
CREATE INDEX "payments_document_idx" ON "payments" ("document_id");--> statement-breakpoint
CREATE INDEX "payments_expense_idx" ON "payments" ("expense_id");--> statement-breakpoint
CREATE UNIQUE INDEX "share_links_token_hash_unique" ON "share_links" ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "share_links_one_active_per_document" ON "share_links" ("document_id") WHERE "revoked_at" is null;--> statement-breakpoint
CREATE INDEX "share_view_events_dedupe_idx" ON "share_view_events" ("share_link_id","visitor_hash","kind","created_at");--> statement-breakpoint
CREATE INDEX "expenses_workspace_issued_idx" ON "expenses" ("workspace_id","issued_on");--> statement-breakpoint
CREATE INDEX "expenses_supplier_document_idx" ON "expenses" ("workspace_id","supplier_ico","supplier_document_number");--> statement-breakpoint
CREATE UNIQUE INDEX "schedules_template_unique" ON "schedules" ("template_id");--> statement-breakpoint
CREATE INDEX "altcha_replays_expires_at_idx" ON "altcha_replays" ("expires_at");--> statement-breakpoint
CREATE INDEX "audit_entries_subject_idx" ON "audit_entries" ("workspace_id","subject_entity","subject_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_entries_workspace_at_idx" ON "audit_entries" ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "exports_one_running_per_workspace" ON "exports" ("workspace_id") WHERE "status" = 'running';--> statement-breakpoint
CREATE INDEX "exports_expires_at_idx" ON "exports" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "request_log_workspace_key_unique" ON "request_log" ("workspace_id","request_key") WHERE "workspace_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "request_log_user_key_unique" ON "request_log" ("user_id","request_key") WHERE "workspace_id" is null;--> statement-breakpoint
CREATE INDEX "request_log_created_at_idx" ON "request_log" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_one_default_per_currency" ON "bank_accounts" ("workspace_id","currency") WHERE "is_default" and "archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_hash_unique" ON "invitations" ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_pending_email_unique" ON "invitations" ("workspace_id",lower("email")) WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX "memberships_user_id_idx" ON "memberships" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_one_owner" ON "memberships" ("workspace_id") WHERE "role" = 'owner';--> statement-breakpoint
CREATE UNIQUE INDEX "numbering_series_one_default_per_kind" ON "numbering_series" ("workspace_id","kind") WHERE "is_default";--> statement-breakpoint
CREATE INDEX "workspace_slug_aliases_workspace_id_idx" ON "workspace_slug_aliases" ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_slug_unique" ON "workspaces" ("slug");--> statement-breakpoint
ALTER TABLE "auth"."account" ADD CONSTRAINT "account_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth"."apikey" ADD CONSTRAINT "apikey_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth"."apikey" ADD CONSTRAINT "apikey_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth"."oauth_access_token" ADD CONSTRAINT "oauth_access_token_client_id_oauth_client_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "auth"."oauth_client"("client_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth"."oauth_access_token" ADD CONSTRAINT "oauth_access_token_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "auth"."session"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "auth"."oauth_access_token" ADD CONSTRAINT "oauth_access_token_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth"."oauth_access_token" ADD CONSTRAINT "oauth_access_token_consent_id_oauth_consent_id_fkey" FOREIGN KEY ("consent_id") REFERENCES "auth"."oauth_consent"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth"."oauth_access_token" ADD CONSTRAINT "oauth_access_token_refresh_id_oauth_refresh_token_id_fkey" FOREIGN KEY ("refresh_id") REFERENCES "auth"."oauth_refresh_token"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth"."oauth_client" ADD CONSTRAINT "oauth_client_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth"."oauth_consent" ADD CONSTRAINT "oauth_consent_client_id_oauth_client_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "auth"."oauth_client"("client_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth"."oauth_consent" ADD CONSTRAINT "oauth_consent_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth"."oauth_consent" ADD CONSTRAINT "oauth_consent_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth"."oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_client_id_oauth_client_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "auth"."oauth_client"("client_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth"."oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "auth"."session"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "auth"."oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth"."oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_consent_id_oauth_consent_id_fkey" FOREIGN KEY ("consent_id") REFERENCES "auth"."oauth_consent"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth"."passkey" ADD CONSTRAINT "passkey_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD CONSTRAINT "session_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "contact_preferred_series" ADD CONSTRAINT "contact_preferred_series_contact_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "contacts"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "contact_preferred_series" ADD CONSTRAINT "contact_preferred_series_series_fk" FOREIGN KEY ("workspace_id","series_id") REFERENCES "numbering_series"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_document_fk" FOREIGN KEY ("workspace_id","document_id") REFERENCES "documents"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_document_fk" FOREIGN KEY ("workspace_id","document_id") REFERENCES "documents"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_price_list_item_fk" FOREIGN KEY ("workspace_id","price_list_item_id") REFERENCES "price_list_items"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "document_relations" ADD CONSTRAINT "document_relations_from_fk" FOREIGN KEY ("workspace_id","from_document_id") REFERENCES "documents"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_relations" ADD CONSTRAINT "document_relations_to_fk" FOREIGN KEY ("workspace_id","to_document_id") REFERENCES "documents"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_contact_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "contacts"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_series_fk" FOREIGN KEY ("workspace_id","series_id") REFERENCES "numbering_series"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_bank_account_fk" FOREIGN KEY ("workspace_id","bank_account_id") REFERENCES "bank_accounts"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_schedule_fk" FOREIGN KEY ("workspace_id","schedule_id") REFERENCES "schedules"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_document_fk" FOREIGN KEY ("workspace_id","document_id") REFERENCES "documents"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_expense_fk" FOREIGN KEY ("workspace_id","expense_id") REFERENCES "expenses"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tax_document_fk" FOREIGN KEY ("workspace_id","tax_document_id") REFERENCES "documents"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_document_fk" FOREIGN KEY ("workspace_id","document_id") REFERENCES "documents"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "share_view_events" ADD CONSTRAINT "share_view_events_share_link_fk" FOREIGN KEY ("workspace_id","share_link_id") REFERENCES "share_links"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_expense_fk" FOREIGN KEY ("workspace_id","expense_id") REFERENCES "expenses"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_contact_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "contacts"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_schedule_fk" FOREIGN KEY ("workspace_id","schedule_id") REFERENCES "schedules"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_document_fk" FOREIGN KEY ("workspace_id","document_id") REFERENCES "documents"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_template_fk" FOREIGN KEY ("workspace_id","template_id") REFERENCES "templates"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_contact_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "contacts"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "audit_entries" ADD CONSTRAINT "audit_entries_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_requested_by_user_id_fkey" FOREIGN KEY ("requested_by") REFERENCES "auth"."user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_user_id_fkey" FOREIGN KEY ("invited_by") REFERENCES "auth"."user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "issuing_entities" ADD CONSTRAINT "issuing_entities_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "number_reservations" ADD CONSTRAINT "number_reservations_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "number_reservations" ADD CONSTRAINT "number_reservations_series_fk" FOREIGN KEY ("workspace_id","series_id") REFERENCES "numbering_series"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "numbering_counters" ADD CONSTRAINT "numbering_counters_series_fk" FOREIGN KEY ("workspace_id","series_id") REFERENCES "numbering_series"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "numbering_series" ADD CONSTRAINT "numbering_series_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tax_regime_periods" ADD CONSTRAINT "tax_regime_periods_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_slug_aliases" ADD CONSTRAINT "workspace_slug_aliases_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;