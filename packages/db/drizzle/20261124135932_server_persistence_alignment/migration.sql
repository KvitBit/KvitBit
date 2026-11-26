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
-- Backfill distinct delivery sequences per document in stable historical order before creating
-- the unique (workspace_id, document_id, sequence) index, and preserve document metadata (S5).
UPDATE "deliveries" AS d
SET "sequence" = ranked.seq,
	"contact_id" = COALESCE(d."contact_id", ranked."doc_contact_id"),
	"due_on" = COALESCE(d."due_on", ranked."doc_due_on"),
	"attempts" = CASE
		WHEN d."status" IN ('sending', 'sent', 'failed')
			OR d."sent_at" IS NOT NULL
			OR d."failure" IS NOT NULL
		THEN GREATEST(d."attempts", 1)
		ELSE d."attempts"
	END
FROM (
	SELECT
		del."id",
		row_number() OVER (
			PARTITION BY del."workspace_id", del."document_id"
			ORDER BY del."created_at" ASC, del."id" ASC
		)::integer AS seq,
		doc."contact_id" AS "doc_contact_id",
		doc."due_on" AS "doc_due_on"
	FROM "deliveries" AS del
	JOIN "documents" AS doc
		ON doc."workspace_id" = del."workspace_id"
		AND doc."id" = del."document_id"
) AS ranked
WHERE d."id" = ranked."id";--> statement-breakpoint
-- Backfill exact line amounts (quantity * unit_price, unrounded per VatMath rule 1) and
-- rate_percent from stored vat_breakdown buckets, deducted document buckets, or Czech VAT rates.
UPDATE "document_lines" AS l
SET "rate_percent" = COALESCE(
		(
			SELECT trim_scale((b->>'ratePercent')::numeric)
			FROM jsonb_array_elements(
				CASE
					WHEN jsonb_typeof(d."vat_breakdown"->'buckets') = 'array'
					THEN d."vat_breakdown"->'buckets'
					ELSE '[]'::jsonb
				END
			) AS b
			WHERE b->>'treatment' = l."vat"::text
				AND b->>'ratePercent' IS NOT NULL
			LIMIT 1
		),
		(
			SELECT trim_scale((b->>'ratePercent')::numeric)
			FROM "documents" AS ded
			CROSS JOIN LATERAL jsonb_array_elements(
				CASE
					WHEN jsonb_typeof(ded."vat_breakdown"->'buckets') = 'array'
					THEN ded."vat_breakdown"->'buckets'
					ELSE '[]'::jsonb
				END
			) AS b
			WHERE l."deducts_document_id" IS NOT NULL
				AND ded."workspace_id" = l."workspace_id"
				AND ded."id" = l."deducts_document_id"
				AND b->>'treatment' = l."vat"::text
				AND b->>'ratePercent' IS NOT NULL
			LIMIT 1
		),
		CASE l."vat"
			WHEN 'standard' THEN 21::numeric
			WHEN 'reduced' THEN 12::numeric
			ELSE 0::numeric
		END
	),
	"amount" = trim_scale(l."quantity" * l."unit_price")
FROM "documents" AS d
WHERE d."workspace_id" = l."workspace_id"
	AND d."id" = l."document_id";--> statement-breakpoint
-- Backfill Document payment projections (paid_amount, payments, settlement per core P1/P3/D6/D8),
-- missing legacy vat_breakdown / totals (with supply VAT separated from stored advance deductions
-- per VatMath rule 9), and accounting metadata (including Credit Note inheritance from original).
WITH live_payments AS (
	SELECT
		"workspace_id",
		"document_id",
		trim_scale(sum("amount")) AS paid_amount,
		count(*)::integer AS payments
	FROM "payments"
	WHERE "document_id" IS NOT NULL
		AND "removed_at" IS NULL
	GROUP BY "workspace_id", "document_id"
),
supply_buckets AS (
	SELECT
		s."workspace_id",
		s."document_id",
		s."vat" AS treatment,
		s.rate_percent,
		CASE
			WHEN s."prices_include_vat" THEN
				round(s.line_sum, 2) - CASE
					WHEN s.rate_percent = 0 THEN 0::numeric
					ELSE round(round(s.line_sum, 2) * s.rate_percent / (100 + s.rate_percent), 2)
				END
			ELSE round(s.line_sum, 2)
		END AS base,
		CASE
			WHEN s."prices_include_vat" THEN
				CASE
					WHEN s.rate_percent = 0 THEN 0::numeric
					ELSE round(round(s.line_sum, 2) * s.rate_percent / (100 + s.rate_percent), 2)
				END
			ELSE round(round(s.line_sum, 2) * s.rate_percent / 100, 2)
		END AS vat,
		CASE
			WHEN s."prices_include_vat" THEN round(s.line_sum, 2)
			ELSE round(s.line_sum, 2) + round(round(s.line_sum, 2) * s.rate_percent / 100, 2)
		END AS gross
	FROM (
		SELECT
			l."workspace_id",
			l."document_id",
			d."prices_include_vat",
			l."vat",
			trim_scale(l."rate_percent") AS rate_percent,
			sum(l."amount") AS line_sum
		FROM "document_lines" AS l
		JOIN "documents" AS d
			ON d."workspace_id" = l."workspace_id"
			AND d."id" = l."document_id"
		WHERE l."deducts_document_id" IS NULL
		GROUP BY l."workspace_id", l."document_id", d."prices_include_vat", l."vat", trim_scale(l."rate_percent")
	) AS s
),
deduction_buckets AS (
	SELECT
		l."workspace_id",
		l."document_id",
		l."vat" AS treatment,
		trim_scale(l."rate_percent") AS rate_percent,
		sum(
			CASE
				WHEN d."prices_include_vat" THEN l."amount" - COALESCE(l."deducted_vat", 0::numeric)
				ELSE l."amount"
			END
		) AS base,
		sum(COALESCE(l."deducted_vat", 0::numeric)) AS vat,
		sum(
			CASE
				WHEN d."prices_include_vat" THEN l."amount"
				ELSE l."amount" + COALESCE(l."deducted_vat", 0::numeric)
			END
		) AS gross
	FROM "document_lines" AS l
	JOIN "documents" AS d
		ON d."workspace_id" = l."workspace_id"
		AND d."id" = l."document_id"
	WHERE l."deducts_document_id" IS NOT NULL
	GROUP BY l."workspace_id", l."document_id", l."vat", trim_scale(l."rate_percent")
),
netted_fallback_buckets AS (
	SELECT
		u."workspace_id",
		u."document_id",
		u.treatment,
		u.rate_percent,
		sum(u.base) AS base,
		sum(u.vat) AS vat,
		sum(u.gross) AS gross,
		CASE
			WHEN trim(d."currency") <> 'CZK'
				AND d."fx_rate" IS NOT NULL
				AND d."fx_quantity" IS NOT NULL
			THEN round(sum(u.vat) * d."fx_rate" / d."fx_quantity", 2)
			ELSE NULL
		END AS vat_czk
	FROM (
		SELECT "workspace_id", "document_id", treatment, rate_percent, base, vat, gross
		FROM supply_buckets
		UNION ALL
		SELECT "workspace_id", "document_id", treatment, rate_percent, base, vat, gross
		FROM deduction_buckets
	) AS u
	JOIN "documents" AS d
		ON d."workspace_id" = u."workspace_id"
		AND d."id" = u."document_id"
	GROUP BY
		u."workspace_id",
		u."document_id",
		u.treatment,
		u.rate_percent,
		d."currency",
		d."fx_rate",
		d."fx_quantity"
),
reconstructed_breakdowns AS (
	SELECT
		d."workspace_id",
		d."id" AS "document_id",
		COALESCE(agg.net_amt, 0::numeric) AS net_amt,
		COALESCE(agg.vat_amt, 0::numeric) AS vat_amt,
		COALESCE(agg.gross_amt, 0::numeric) AS raw_gross_amt,
		COALESCE(d."total_gross", COALESCE(agg.gross_amt, 0::numeric)) AS gross_amt,
		COALESCE(d."total_gross", COALESCE(agg.gross_amt, 0::numeric)) - COALESCE(agg.gross_amt, 0::numeric) AS rounding_adj,
		jsonb_build_object(
			'buckets', COALESCE(agg.buckets_json, '[]'::jsonb),
			'net', jsonb_build_object(
				'amount', trim_scale(COALESCE(agg.net_amt, 0::numeric))::text,
				'currency', trim(d."currency")
			),
			'vat', jsonb_build_object(
				'amount', trim_scale(COALESCE(agg.vat_amt, 0::numeric))::text,
				'currency', trim(d."currency")
			),
			'roundingAdjustment', jsonb_build_object(
				'amount', trim_scale(
					COALESCE(d."total_gross", COALESCE(agg.gross_amt, 0::numeric)) - COALESCE(agg.gross_amt, 0::numeric)
				)::text,
				'currency', trim(d."currency")
			),
			'gross', jsonb_build_object(
				'amount', trim_scale(COALESCE(d."total_gross", COALESCE(agg.gross_amt, 0::numeric)))::text,
				'currency', trim(d."currency")
			),
			'vatCzk', CASE
				WHEN trim(d."currency") <> 'CZK'
					AND d."fx_rate" IS NOT NULL
					AND d."fx_quantity" IS NOT NULL
				THEN jsonb_build_object(
					'amount', trim_scale(COALESCE(agg.vat_czk_amt, 0::numeric))::text,
					'currency', 'CZK'
				)
				ELSE NULL
			END
		) AS vat_breakdown
	FROM "documents" AS d
	LEFT JOIN (
		SELECT
			nb."workspace_id",
			nb."document_id",
			sum(nb.base) AS net_amt,
			sum(nb.vat) AS vat_amt,
			sum(nb.gross) AS gross_amt,
			sum(COALESCE(nb.vat_czk, 0::numeric)) AS vat_czk_amt,
			jsonb_agg(
				jsonb_build_object(
					'treatment', nb.treatment::text,
					'ratePercent', trim_scale(nb.rate_percent)::text,
					'base', trim_scale(nb.base)::text,
					'vat', trim_scale(nb.vat)::text,
					'gross', trim_scale(nb.gross)::text,
					'vatCzk', CASE WHEN nb.vat_czk IS NULL THEN NULL ELSE trim_scale(nb.vat_czk)::text END
				)
				ORDER BY
					array_position(
						ARRAY['standard', 'reduced', 'exempt_intra_eu_goods', 'reverse_charge', 'outside_scope'],
						nb.treatment::text
					),
					nb.rate_percent
			) AS buckets_json
		FROM netted_fallback_buckets AS nb
		GROUP BY nb."workspace_id", nb."document_id"
	) AS agg
		ON agg."workspace_id" = d."workspace_id"
		AND agg."document_id" = d."id"
	WHERE d."vat_breakdown" IS NULL
),
credit_links AS (
	SELECT DISTINCT
		r."workspace_id",
		CASE
			WHEN r."relation" = 'corrects' THEN r."to_document_id"
			ELSE r."from_document_id"
		END AS original_id,
		CASE
			WHEN r."relation" = 'corrects' THEN r."from_document_id"
			ELSE r."to_document_id"
		END AS credit_note_id
	FROM "document_relations" AS r
	JOIN "documents" AS cn
		ON cn."workspace_id" = r."workspace_id"
		AND cn."id" = CASE
			WHEN r."relation" = 'corrects' THEN r."from_document_id"
			ELSE r."to_document_id"
		END
	WHERE r."relation" IN ('corrects', 'corrected_by')
		AND cn."kind" = 'credit_note'
		AND cn."status" = 'issued'
),
stage1_breakdowns AS (
	SELECT
		d."workspace_id",
		d."id",
		COALESCE(d."vat_breakdown", rb.vat_breakdown) AS vat_breakdown,
		COALESCE((COALESCE(d."vat_breakdown", rb.vat_breakdown)->'roundingAdjustment'->>'amount')::numeric, 0::numeric) AS rounding_adj
	FROM "documents" AS d
	LEFT JOIN reconstructed_breakdowns AS rb
		ON rb."workspace_id" = d."workspace_id"
		AND rb."document_id" = d."id"
),
-- For a legacy closing credit note with null vat_breakdown, reconstruct its breakdown from the
-- original document's remaining open buckets after earlier credit notes (matching credit.ts:283),
-- so leftover rounding VAT cents stay in VAT rather than leaking into roundingAdjustment.
closing_credit_prior_docs AS (
	SELECT
		cl."workspace_id",
		cl.credit_note_id,
		cl.original_id,
		cl.original_id AS member_id
	FROM credit_links AS cl
	JOIN "documents" AS cn
		ON cn."workspace_id" = cl."workspace_id"
		AND cn."id" = cl.credit_note_id
	WHERE cn."vat_breakdown" IS NULL
	UNION ALL
	SELECT
		cl."workspace_id",
		cl.credit_note_id,
		cl.original_id,
		prior_cl.credit_note_id AS member_id
	FROM credit_links AS cl
	JOIN "documents" AS cn
		ON cn."workspace_id" = cl."workspace_id"
		AND cn."id" = cl.credit_note_id
	JOIN credit_links AS prior_cl
		ON prior_cl."workspace_id" = cl."workspace_id"
		AND prior_cl.original_id = cl.original_id
		AND prior_cl.credit_note_id <> cl.credit_note_id
	JOIN "documents" AS prior_cn
		ON prior_cn."workspace_id" = prior_cl."workspace_id"
		AND prior_cn."id" = prior_cl.credit_note_id
	WHERE cn."vat_breakdown" IS NULL
		AND (
			COALESCE(prior_cn."issued_on", '0001-01-01'::date),
			COALESCE(prior_cn."issued_at", prior_cn."created_at"),
			prior_cn."created_at",
			prior_cn."id"
		) < (
			COALESCE(cn."issued_on", '0001-01-01'::date),
			COALESCE(cn."issued_at", cn."created_at"),
			cn."created_at",
			cn."id"
		)
),
closing_credit_remaining_buckets AS (
	SELECT
		p."workspace_id",
		p.credit_note_id,
		b->>'treatment' AS treatment,
		trim_scale((b->>'ratePercent')::numeric) AS rate_percent,
		sum((b->>'base')::numeric) AS rem_base,
		sum((b->>'vat')::numeric) AS rem_vat,
		sum((b->>'gross')::numeric) AS rem_gross,
		CASE
			WHEN bool_or(b->>'vatCzk' IS NOT NULL)
			THEN sum(COALESCE((b->>'vatCzk')::numeric, 0::numeric))
			ELSE NULL
		END AS rem_vat_czk
	FROM closing_credit_prior_docs AS p
	JOIN stage1_breakdowns AS sb
		ON sb."workspace_id" = p."workspace_id"
		AND sb."id" = p.member_id
	CROSS JOIN LATERAL jsonb_array_elements(
		CASE
			WHEN jsonb_typeof(sb.vat_breakdown->'buckets') = 'array'
			THEN sb.vat_breakdown->'buckets'
			ELSE '[]'::jsonb
		END
	) AS b
	GROUP BY p."workspace_id", p.credit_note_id, b->>'treatment', trim_scale((b->>'ratePercent')::numeric)
	HAVING sum((b->>'base')::numeric) <> 0
		OR sum((b->>'vat')::numeric) <> 0
		OR sum((b->>'gross')::numeric) <> 0
		OR (
			bool_or(b->>'vatCzk' IS NOT NULL)
			AND sum(COALESCE((b->>'vatCzk')::numeric, 0::numeric)) <> 0
		)
),
closing_credit_remaining_rounding AS (
	SELECT
		p."workspace_id",
		p.credit_note_id,
		sum(sb.rounding_adj) AS rem_rounding
	FROM closing_credit_prior_docs AS p
	JOIN stage1_breakdowns AS sb
		ON sb."workspace_id" = p."workspace_id"
		AND sb."id" = p.member_id
	GROUP BY p."workspace_id", p.credit_note_id
),
closing_credit_breakdowns AS (
	SELECT
		cn."workspace_id",
		cn."id" AS "document_id",
		-COALESCE(agg.rem_net, 0::numeric) AS net_amt,
		-COALESCE(agg.rem_vat, 0::numeric) AS vat_amt,
		-(COALESCE(agg.rem_gross, 0::numeric) + COALESCE(rr.rem_rounding, 0::numeric)) AS gross_amt,
		jsonb_build_object(
			'buckets', COALESCE(agg.buckets_json, '[]'::jsonb),
			'net', jsonb_build_object(
				'amount', trim_scale(-COALESCE(agg.rem_net, 0::numeric))::text,
				'currency', trim(cn."currency")
			),
			'vat', jsonb_build_object(
				'amount', trim_scale(-COALESCE(agg.rem_vat, 0::numeric))::text,
				'currency', trim(cn."currency")
			),
			'roundingAdjustment', jsonb_build_object(
				'amount', trim_scale(-COALESCE(rr.rem_rounding, 0::numeric))::text,
				'currency', trim(cn."currency")
			),
			'gross', jsonb_build_object(
				'amount', trim_scale(-(COALESCE(agg.rem_gross, 0::numeric) + COALESCE(rr.rem_rounding, 0::numeric)))::text,
				'currency', trim(cn."currency")
			),
			'vatCzk', CASE
				WHEN COALESCE(agg.has_vat_czk, false)
				THEN jsonb_build_object(
					'amount', trim_scale(-COALESCE(agg.rem_vat_czk, 0::numeric))::text,
					'currency', 'CZK'
				)
				ELSE NULL
			END
		) AS vat_breakdown
	FROM closing_credit_remaining_rounding AS rr
	JOIN "documents" AS cn
		ON cn."workspace_id" = rr."workspace_id"
		AND cn."id" = rr.credit_note_id
	JOIN reconstructed_breakdowns AS rb_cn
		ON rb_cn."workspace_id" = cn."workspace_id"
		AND rb_cn."document_id" = cn."id"
	LEFT JOIN (
		SELECT
			rb."workspace_id",
			rb.credit_note_id,
			sum(rb.rem_base) AS rem_net,
			sum(rb.rem_vat) AS rem_vat,
			sum(rb.rem_gross) AS rem_gross,
			bool_or(rb.rem_vat_czk IS NOT NULL) AS has_vat_czk,
			sum(COALESCE(rb.rem_vat_czk, 0::numeric)) AS rem_vat_czk,
			jsonb_agg(
				jsonb_build_object(
					'treatment', rb.treatment,
					'ratePercent', trim_scale(rb.rate_percent)::text,
					'base', trim_scale(-rb.rem_base)::text,
					'vat', trim_scale(-rb.rem_vat)::text,
					'gross', trim_scale(-rb.rem_gross)::text,
					'vatCzk', CASE WHEN rb.rem_vat_czk IS NULL THEN NULL ELSE trim_scale(-rb.rem_vat_czk)::text END
				)
				ORDER BY
					array_position(
						ARRAY['standard', 'reduced', 'exempt_intra_eu_goods', 'reverse_charge', 'outside_scope'],
						rb.treatment
					),
					rb.rate_percent
			) AS buckets_json
		FROM closing_credit_remaining_buckets AS rb
		GROUP BY rb."workspace_id", rb.credit_note_id
	) AS agg
		ON agg."workspace_id" = rr."workspace_id"
		AND agg.credit_note_id = rr.credit_note_id
	WHERE cn."vat_breakdown" IS NULL
		AND (
			(cn."total_net" IS NOT NULL AND cn."total_net" <> rb_cn.net_amt)
			OR (cn."total_vat" IS NOT NULL AND cn."total_vat" <> rb_cn.vat_amt)
			OR (cn."total_gross" IS NOT NULL AND cn."total_gross" <> rb_cn.raw_gross_amt)
			OR (
				COALESCE(agg.has_vat_czk, false)
				AND COALESCE(agg.rem_vat_czk, 0::numeric) <> 0
				AND NOT EXISTS (
					SELECT 1
					FROM "document_lines" AS cl_line
					WHERE cl_line."workspace_id" = cn."workspace_id"
						AND cl_line."document_id" = cn."id"
				)
			)
		)
		AND (cn."total_net" IS NULL OR cn."total_net" = -COALESCE(agg.rem_net, 0::numeric))
		AND (cn."total_vat" IS NULL OR cn."total_vat" = -COALESCE(agg.rem_vat, 0::numeric))
		AND (
			cn."total_gross" IS NULL
			OR cn."total_gross" = -(COALESCE(agg.rem_gross, 0::numeric) + COALESCE(rr.rem_rounding, 0::numeric))
		)
),
doc_totals AS (
	SELECT
		d."workspace_id",
		d."id",
		COALESCE(d."vat_breakdown", ccb.vat_breakdown, rb.vat_breakdown) AS effective_vat_breakdown,
		COALESCE(d."total_net", ccb.net_amt, rb.net_amt) AS effective_total_net,
		COALESCE(d."total_vat", ccb.vat_amt, rb.vat_amt) AS effective_total_vat,
		COALESCE(
			d."total_gross",
			CASE
				WHEN d."vat_breakdown"->'gross'->>'amount' IS NOT NULL
				THEN (d."vat_breakdown"->'gross'->>'amount')::numeric
			END,
			ccb.gross_amt,
			rb.gross_amt,
			0::numeric
		) AS gross,
		d."total_net",
		d."total_vat",
		(jsonb_typeof(COALESCE(d."vat_breakdown", ccb.vat_breakdown, rb.vat_breakdown)->'buckets') = 'array') AS has_buckets,
		COALESCE(
			(COALESCE(d."vat_breakdown", ccb.vat_breakdown, rb.vat_breakdown)->'roundingAdjustment'->>'amount')::numeric,
			0::numeric
		) AS rounding_adj
	FROM "documents" AS d
	LEFT JOIN reconstructed_breakdowns AS rb
		ON rb."workspace_id" = d."workspace_id"
		AND rb."document_id" = d."id"
	LEFT JOIN closing_credit_breakdowns AS ccb
		ON ccb."workspace_id" = d."workspace_id"
		AND ccb."document_id" = d."id"
),
credit_group_docs AS (
	SELECT DISTINCT "workspace_id", original_id, original_id AS member_id
	FROM credit_links
	UNION
	SELECT "workspace_id", original_id, credit_note_id AS member_id
	FROM credit_links
),
open_bucket_originals AS (
	SELECT DISTINCT "workspace_id", original_id
	FROM (
		SELECT
			cg."workspace_id",
			cg.original_id,
			b->>'treatment' AS treatment,
			trim_scale((b->>'ratePercent')::numeric) AS rate_percent,
			sum((b->>'base')::numeric) AS sum_base,
			sum((b->>'vat')::numeric) AS sum_vat,
			sum((b->>'gross')::numeric) AS sum_gross,
			sum(COALESCE((b->>'vatCzk')::numeric, 0::numeric)) AS sum_vat_czk
		FROM credit_group_docs AS cg
		JOIN doc_totals AS m
			ON m."workspace_id" = cg."workspace_id"
			AND m."id" = cg.member_id
		CROSS JOIN LATERAL jsonb_array_elements(
			CASE
				WHEN jsonb_typeof(m.effective_vat_breakdown->'buckets') = 'array'
				THEN m.effective_vat_breakdown->'buckets'
				ELSE '[]'::jsonb
			END
		) AS b
		GROUP BY cg."workspace_id", cg.original_id, b->>'treatment', trim_scale((b->>'ratePercent')::numeric)
	) AS grouped
	WHERE sum_base <> 0
		OR sum_vat <> 0
		OR sum_gross <> 0
		OR sum_vat_czk <> 0
),
open_deduction_originals AS (
	SELECT DISTINCT "workspace_id", original_id
	FROM (
		SELECT
			cg."workspace_id",
			cg.original_id,
			l."vat" AS treatment,
			trim_scale(l."rate_percent") AS rate_percent,
			sum(
				CASE
					WHEN m."prices_include_vat" THEN l."amount" - COALESCE(l."deducted_vat", 0::numeric)
					ELSE l."amount"
				END
			) AS sum_base,
			sum(COALESCE(l."deducted_vat", 0::numeric)) AS sum_vat,
			sum(
				CASE
					WHEN m."prices_include_vat" THEN l."amount"
					ELSE l."amount" + COALESCE(l."deducted_vat", 0::numeric)
				END
			) AS sum_gross,
			sum(
				CASE
					WHEN trim(m."currency") = 'CZK' THEN 0::numeric
					ELSE COALESCE(l."deducted_vat_czk", 0::numeric)
				END
			) AS sum_vat_czk
		FROM credit_group_docs AS cg
		JOIN "documents" AS m
			ON m."workspace_id" = cg."workspace_id"
			AND m."id" = cg.member_id
		JOIN "document_lines" AS l
			ON l."workspace_id" = m."workspace_id"
			AND l."document_id" = m."id"
		WHERE l."deducts_document_id" IS NOT NULL
			AND EXISTS (
				SELECT 1
				FROM "document_lines" AS ol
				WHERE ol."workspace_id" = cg."workspace_id"
					AND ol."document_id" = cg.original_id
					AND ol."deducts_document_id" IS NOT NULL
			)
		GROUP BY cg."workspace_id", cg.original_id, l."vat", trim_scale(l."rate_percent")
	) AS ded_grouped
	WHERE sum_base <> 0
		OR sum_vat <> 0
		OR sum_gross <> 0
		OR sum_vat_czk <> 0
),
credit_summary AS (
	SELECT
		cl."workspace_id",
		cl.original_id,
		count(*)::integer AS credit_count,
		sum(ct.gross) AS credit_gross,
		sum(COALESCE(ct."total_net", 0::numeric)) AS credit_net,
		sum(COALESCE(ct."total_vat", 0::numeric)) AS credit_vat,
		bool_and(ct.has_buckets) AS all_credits_have_buckets,
		sum(ct.rounding_adj) AS credit_rounding_adj
	FROM credit_links AS cl
	JOIN doc_totals AS ct
		ON ct."workspace_id" = cl."workspace_id"
		AND ct."id" = cl.credit_note_id
	GROUP BY cl."workspace_id", cl.original_id
),
base_meta AS (
	SELECT
		d."workspace_id",
		d."id",
		CASE
			WHEN d."kind" = 'payment_tax_document' THEN true
			WHEN d."kind" = 'proforma' THEN false
			WHEN COALESCE(
				d."issuer_snapshot"->>'regime',
				(
					SELECT trp."regime"::text
					FROM "tax_regime_periods" AS trp
					WHERE trp."workspace_id" = d."workspace_id"
						AND trp."effective_from" <= COALESCE(d."taxable_supply_on", d."issued_on", CURRENT_DATE)
					ORDER BY trp."effective_from" DESC
					LIMIT 1
				),
				'non_vat_payer'
			) = 'vat_payer' THEN true
			WHEN COALESCE(
				d."issuer_snapshot"->>'regime',
				(
					SELECT trp."regime"::text
					FROM "tax_regime_periods" AS trp
					WHERE trp."workspace_id" = d."workspace_id"
						AND trp."effective_from" <= COALESCE(d."taxable_supply_on", d."issued_on", CURRENT_DATE)
					ORDER BY trp."effective_from" DESC
					LIMIT 1
				),
				'non_vat_payer'
			) = 'identified_person'
				AND EXISTS (
					SELECT 1
					FROM "document_lines" AS l
					WHERE l."workspace_id" = d."workspace_id"
						AND l."document_id" = d."id"
						AND l."vat" <> 'outside_scope'
				)
				THEN true
			ELSE false
		END AS tax_document,
		CASE
			WHEN dt.rounding_adj <> 0 THEN 'whole_unit'::"payment_rounding"
			ELSE d."payment_rounding"
		END AS payment_rounding
	FROM "documents" AS d
	JOIN doc_totals AS dt
		ON dt."workspace_id" = d."workspace_id"
		AND dt."id" = d."id"
),
computed_docs AS (
	SELECT
		d."workspace_id",
		d."id",
		dt.effective_vat_breakdown AS vat_breakdown,
		dt.effective_total_net AS total_net,
		dt.effective_total_vat AS total_vat,
		COALESCE(d."total_gross", dt.gross) AS total_gross,
		COALESCE(lp.paid_amount, 0::numeric) AS paid_amount,
		COALESCE(lp.payments, 0) AS payments,
		(
			CASE
				WHEN d."kind" = 'credit_note' THEN 'unpaid'
				WHEN d."status" = 'draft' THEN 'unpaid'
				WHEN COALESCE(cs.credit_count, 0) > 0
					AND od.original_id IS NULL
					AND (
						CASE
							WHEN dt.has_buckets AND cs.all_credits_have_buckets THEN
								ob.original_id IS NULL
								AND (dt.rounding_adj + cs.credit_rounding_adj) = 0
							ELSE
								(dt.gross + cs.credit_gross) = 0
								AND (dt."total_net" IS NULL OR (dt."total_net" + cs.credit_net) = 0)
								AND (dt."total_vat" IS NULL OR (dt."total_vat" + cs.credit_vat) = 0)
						END
					)
					THEN 'credited'
				WHEN d."kind" = 'payment_tax_document' THEN 'paid'
				WHEN COALESCE(lp.payments, 0) = 0
					AND (dt.gross + COALESCE(cs.credit_gross, 0::numeric)) > 0
					THEN 'unpaid'
				WHEN COALESCE(lp.paid_amount, 0::numeric) < (dt.gross + COALESCE(cs.credit_gross, 0::numeric))
					THEN 'partially_paid'
				WHEN COALESCE(lp.paid_amount, 0::numeric) = (dt.gross + COALESCE(cs.credit_gross, 0::numeric))
					THEN 'paid'
				ELSE 'overpaid'
			END
		)::"document_settlement" AS settlement,
		CASE
			WHEN d."kind" = 'credit_note' THEN COALESCE(orig_meta.tax_document, bm.tax_document)
			ELSE bm.tax_document
		END AS tax_document,
		CASE
			WHEN d."kind" = 'credit_note' THEN COALESCE(orig_meta.payment_rounding, bm.payment_rounding)
			ELSE bm.payment_rounding
		END AS payment_rounding,
		CASE
			WHEN d."fx_override" IS NULL
				AND d."fx_source" = 'manual'
				AND d."fx_rate" IS NOT NULL
				AND d."fx_quantity" IS NOT NULL
			THEN jsonb_build_object(
				'manual',
				jsonb_build_object(
					'rate', trim_scale(d."fx_rate")::text,
					'quantity', d."fx_quantity"
				)
			)
			ELSE d."fx_override"
		END AS fx_override,
		CASE
			WHEN d."locked" AND d."locked_at" IS NULL
			THEN COALESCE(d."updated_at", d."created_at")
			ELSE d."locked_at"
		END AS locked_at,
		COALESCE(
			d."corrected_number",
			orig_doc."number"
		) AS corrected_number,
		CASE
			WHEN d."cancelled_on" IS NULL AND d."cancelled_at" IS NOT NULL
			THEN (d."cancelled_at" AT TIME ZONE 'Europe/Prague')::date
			ELSE d."cancelled_on"
		END AS cancelled_on
	FROM "documents" AS d
	JOIN doc_totals AS dt
		ON dt."workspace_id" = d."workspace_id"
		AND dt."id" = d."id"
	JOIN base_meta AS bm
		ON bm."workspace_id" = d."workspace_id"
		AND bm."id" = d."id"
	LEFT JOIN live_payments AS lp
		ON lp."workspace_id" = d."workspace_id"
		AND lp."document_id" = d."id"
	LEFT JOIN credit_summary AS cs
		ON cs."workspace_id" = d."workspace_id"
		AND cs.original_id = d."id"
	LEFT JOIN open_bucket_originals AS ob
		ON ob."workspace_id" = d."workspace_id"
		AND ob.original_id = d."id"
	LEFT JOIN open_deduction_originals AS od
		ON od."workspace_id" = d."workspace_id"
		AND od.original_id = d."id"
	LEFT JOIN LATERAL (
		SELECT cl2.original_id
		FROM credit_links AS cl2
		WHERE cl2."workspace_id" = d."workspace_id"
			AND cl2.credit_note_id = d."id"
		LIMIT 1
	) AS cn_orig ON true
	LEFT JOIN "documents" AS orig_doc
		ON orig_doc."workspace_id" = d."workspace_id"
		AND orig_doc."id" = cn_orig.original_id
	LEFT JOIN base_meta AS orig_meta
		ON orig_meta."workspace_id" = d."workspace_id"
		AND orig_meta."id" = cn_orig.original_id
)
UPDATE "documents" AS d
SET "vat_breakdown" = c.vat_breakdown,
	"total_net" = c.total_net,
	"total_vat" = c.total_vat,
	"total_gross" = c.total_gross,
	"paid_amount" = c.paid_amount,
	"payments" = c.payments,
	"settlement" = c.settlement,
	"tax_document" = c.tax_document,
	"payment_rounding" = c.payment_rounding,
	"fx_override" = c.fx_override,
	"locked_at" = c.locked_at,
	"corrected_number" = c.corrected_number,
	"cancelled_on" = c.cancelled_on
FROM computed_docs AS c
WHERE d."workspace_id" = c."workspace_id"
	AND d."id" = c."id";--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_document_sequence" ON "deliveries" ("workspace_id","document_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_reminder_step" ON "deliveries" ("workspace_id","document_id","reminder_due_on","reminder_offset_days","reminder_armed_by") WHERE "reminder_due_on" is not null and not ("status" = 'skipped' and "attempts" = 0 and "last_outcome" is null);--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_contact_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "contacts"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_user_id_fkey" FOREIGN KEY ("accepted_by") REFERENCES "auth"."user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_reminder_step_complete" CHECK (("reminder_due_on" is null) = ("reminder_offset_days" is null) and ("reminder_due_on" is null) = ("reminder_armed_by" is null));--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_attempts_nonnegative" CHECK ("attempts" >= 0);--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_last_outcome_values" CHECK ("last_outcome" is null or "last_outcome" in ('not_accepted', 'outcome_unknown'));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_payments_nonnegative" CHECK ("payments" >= 0);