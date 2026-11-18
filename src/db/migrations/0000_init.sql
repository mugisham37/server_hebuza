CREATE SEQUENCE "public"."support_ticket_ref_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."contact_ref_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 142 CACHE 1;--> statement-breakpoint
CREATE TABLE "application_feedback" (
	"application_id" varchar(64) PRIMARY KEY NOT NULL,
	"review" varchar(32),
	"review_note" text,
	"reviewed_at" timestamp with time zone,
	"rating" integer,
	"rated_at" timestamp with time zone,
	CONSTRAINT "ck_application_feedback_review" CHECK (review IS NULL OR review IN ('accepted','changes_requested')),
	CONSTRAINT "ck_application_feedback_rating" CHECK (rating IS NULL OR rating BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "document_requests" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"application_id" varchar(64) NOT NULL,
	"requirement_key" varchar(128) NOT NULL,
	"label" varchar(255) NOT NULL,
	"due_at" timestamp with time zone,
	"requested_by" varchar(64),
	"fulfilled_at" timestamp with time zone,
	"fulfilled_by_document_id" varchar(64),
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_ticket_messages" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"ticket_id" varchar(64) NOT NULL,
	"author_id" varchar(64),
	"side" varchar(16) NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"ref" varchar(32) NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"subject" varchar(200) NOT NULL,
	"status" varchar(16) NOT NULL,
	"rating_score" integer,
	"rating_comment" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_support_tickets_ref" UNIQUE("ref"),
	CONSTRAINT "ck_support_tickets_status" CHECK (status IN ('open','waiting','resolved'))
);
--> statement-breakpoint
CREATE TABLE "ai_drafts" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"session_id" varchar(64),
	"owner_id" varchar(64),
	"service_slug" varchar(128) NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(16) NOT NULL,
	"structure_version" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_evals" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"trigger" varchar(255) NOT NULL,
	"passed" integer NOT NULL,
	"total" integer NOT NULL,
	"prohibited" integer DEFAULT 0 NOT NULL,
	"deploy_blocked" boolean DEFAULT false NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_handoffs" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"session_id" varchar(64) NOT NULL,
	"conversation_id" varchar(64) NOT NULL,
	"ticket_ref" varchar(32) NOT NULL,
	"reason" varchar(32) NOT NULL,
	"lang" varchar(4) NOT NULL,
	"summary" text NOT NULL,
	"who" varchar(255) NOT NULL,
	"claimed_by" varchar(255),
	"claimed_by_id" varchar(64),
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_kb_chunks" (
	"id" varchar(80) PRIMARY KEY NOT NULL,
	"source_id" varchar(96) NOT NULL,
	"ord" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"url" varchar(255) NOT NULL,
	"locale" varchar(4) NOT NULL,
	"content" text NOT NULL,
	"source_version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_kb_sources" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"title" varchar(255) NOT NULL,
	"kind" varchar(24) NOT NULL,
	"locale" varchar(4) NOT NULL,
	"status" varchar(24) NOT NULL,
	"owner" varchar(255) NOT NULL,
	"facts_by" varchar(255),
	"tone_by" varchar(255),
	"review_by" varchar(10) NOT NULL,
	"last_indexed_at" timestamp with time zone,
	"body" text NOT NULL,
	"previous" text,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"comment" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_messages" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"session_id" varchar(64) NOT NULL,
	"role" varchar(12) NOT NULL,
	"text" text NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outcome" varchar(24),
	"rating" integer,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_reindex_jobs" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"ids" jsonb NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"started_by" varchar(64),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai_sessions" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"lang" varchar(4) NOT NULL,
	"context" varchar(16) NOT NULL,
	"owner_id" varchar(64),
	"ip_hash" varchar(64),
	"title" varchar(120) DEFAULT 'New chat' NOT NULL,
	"turns" integer DEFAULT 0 NOT NULL,
	"low_conf" integer DEFAULT 0 NOT NULL,
	"abuse" integer DEFAULT 0 NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"handed_off" boolean DEFAULT false NOT NULL,
	"outcome" varchar(24) DEFAULT 'abandoned' NOT NULL,
	"rating" integer,
	"intake" jsonb,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"model" varchar(64),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_settings" (
	"id" varchar(16) PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"budget_usd" integer NOT NULL,
	"per_ip_daily" integer NOT NULL,
	"retention_months" integer NOT NULL,
	"office_hours" varchar(64) NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_impersonations" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"actor_id" varchar(64) NOT NULL,
	"target_id" varchar(64) NOT NULL,
	"reason" varchar(500) NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by" varchar(16)
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"device" varchar(128) NOT NULL,
	"ip" varchar(64),
	"city" varchar(64),
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth_trusted_devices" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"label" varchar(128) NOT NULL,
	"place" varchar(64),
	"trusted_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_trusted_devices_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "bkg_advisers" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" varchar(64),
	"name" varchar(255) NOT NULL,
	"title" varchar(255),
	"photo" varchar(255),
	"priority" integer DEFAULT 9 NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"overrides" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"leave" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"external_busy" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bkg_advisers_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "bkg_bookings" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"reference" varchar(32) DEFAULT '' NOT NULL,
	"type_slug" varchar(96) NOT NULL,
	"type_name" jsonb NOT NULL,
	"price" integer DEFAULT 0 NOT NULL,
	"adviser_id" varchar(64),
	"client_id" varchar(64),
	"lead_id" varchar(64),
	"contact_name" varchar(255) DEFAULT '' NOT NULL,
	"phone_enc" text,
	"email_enc" text,
	"phone_masked" varchar(64),
	"email_masked" varchar(255),
	"contact_key" varchar(64) DEFAULT '' NOT NULL,
	"whatsapp" boolean DEFAULT false NOT NULL,
	"language" varchar(4) DEFAULT 'en' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"mode" varchar(16) NOT NULL,
	"location" varchar(255),
	"status" varchar(24) NOT NULL,
	"intake" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"family_slug" varchar(128),
	"service_slug" varchar(128),
	"invoice_ref" varchar(48),
	"hold_expires_at" timestamp with time zone,
	"paid" boolean DEFAULT false NOT NULL,
	"reschedule_count" integer DEFAULT 0 NOT NULL,
	"rescheduled_from_id" varchar(64),
	"rescheduled_to_ref" varchar(32),
	"cancel_reason" text,
	"cancelled_by" varchar(8),
	"client_summary" text,
	"outcome_notes" text,
	"recommended" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"start_links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quote_ref" varchar(32),
	"quote_request" jsonb,
	"reminders" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"refund" jsonb,
	"source" varchar(16) DEFAULT 'web' NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"confirm_key" varchar(64) NOT NULL,
	"join_url" varchar(255),
	"late_refund" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_bkg_bookings_token" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "bkg_counters" (
	"name" varchar(32) PRIMARY KEY NOT NULL,
	"value" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bkg_leads" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"phone_enc" text,
	"email_enc" text,
	"source" varchar(16) NOT NULL,
	"language" varchar(4),
	"topic" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bkg_payments" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"booking_id" varchar(64) NOT NULL,
	"kind" varchar(24) NOT NULL,
	"amount" integer NOT NULL,
	"provider_ref" varchar(128),
	"status" varchar(24) NOT NULL,
	"phone_masked" varchar(64),
	"checkout_url" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bkg_requests" (
	"id" varchar(16) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"phone_enc" text NOT NULL,
	"phone_masked" varchar(64) NOT NULL,
	"email_enc" text,
	"topic" varchar(128) NOT NULL,
	"preferred_times" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"language" varchar(4) NOT NULL,
	"status" varchar(16) DEFAULT 'new' NOT NULL,
	"booking_ref" varchar(32),
	"close_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bkg_settings" (
	"id" varchar(16) PRIMARY KEY NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bkg_types" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"slug" varchar(96) NOT NULL,
	"name" jsonb NOT NULL,
	"description" jsonb NOT NULL,
	"duration_min" integer NOT NULL,
	"modes" jsonb NOT NULL,
	"price" integer DEFAULT 0 NOT NULL,
	"buffer_before_min" integer DEFAULT 0 NOT NULL,
	"buffer_after_min" integer DEFAULT 0 NOT NULL,
	"min_notice_min" integer DEFAULT 240 NOT NULL,
	"horizon_days" integer DEFAULT 30 NOT NULL,
	"max_per_day" integer DEFAULT 6 NOT NULL,
	"family_slugs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"service_slugs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"adviser_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"intake_schema" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prepare" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"free_once_per_family" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bkg_types_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "bkg_waitlist" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"type_slug" varchar(96) NOT NULL,
	"date" date NOT NULL,
	"contact_key" varchar(64) NOT NULL,
	"contact_enc" text NOT NULL,
	"offered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_bkg_waitlist" UNIQUE("type_slug","date","contact_key")
);
--> statement-breakpoint
CREATE TABLE "service_sub_statuses" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"canonical" varchar(48) NOT NULL,
	"name" jsonb NOT NULL,
	"client_text" jsonb NOT NULL,
	"client_visible" boolean NOT NULL,
	"color" varchar(16) NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cms_comments" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"entry_id" varchar(96) NOT NULL,
	"block_id" varchar(96),
	"language" varchar(4),
	"by" varchar(255) NOT NULL,
	"body" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"resolved" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cms_entries" (
	"id" varchar(96) PRIMARY KEY NOT NULL,
	"type" varchar(32) NOT NULL,
	"key" varchar(160) NOT NULL,
	"version" integer NOT NULL,
	"archived" boolean NOT NULL,
	"doc" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_cms_entries_type_key" UNIQUE("type","key")
);
--> statement-breakpoint
CREATE TABLE "cms_locks" (
	"entry_id" varchar(96) PRIMARY KEY NOT NULL,
	"holder" varchar(255) NOT NULL,
	"since" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cms_nav" (
	"location" varchar(16) PRIMARY KEY NOT NULL,
	"items" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cms_not_found" (
	"path" varchar(512) PRIMARY KEY NOT NULL,
	"hits" integer NOT NULL,
	"last_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cms_redirects" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"from_path" varchar(512) NOT NULL,
	"to_path" varchar(512) NOT NULL,
	"code" integer NOT NULL,
	"hits" integer NOT NULL,
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_cms_redirects_from" UNIQUE("from_path")
);
--> statement-breakpoint
CREATE TABLE "cms_site_settings" (
	"id" varchar(16) PRIMARY KEY NOT NULL,
	"doc" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cms_versions" (
	"entry_id" varchar(96) NOT NULL,
	"language" varchar(4) NOT NULL,
	"version" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"by" varchar(255) NOT NULL,
	"summary" varchar(255) NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "cms_versions_entry_id_language_version_pk" PRIMARY KEY("entry_id","language","version")
);
--> statement-breakpoint
CREATE TABLE "client_document_expiry" (
	"document_id" varchar(64) PRIMARY KEY NOT NULL,
	"expires_on" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliverables" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"application_id" varchar(64) NOT NULL,
	"title" varchar(255) NOT NULL,
	"storage_path" varchar(1024) NOT NULL,
	"mime_type" varchar(128) NOT NULL,
	"file_size_bytes" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"issuer" varchar(128),
	"released_at" timestamp with time zone,
	"created_by" varchar(64),
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_agents" (
	"user_id" varchar(64) PRIMARY KEY NOT NULL,
	"agent_ref" varchar(64) NOT NULL,
	"districts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manager_id" varchar(64),
	"manager_name" varchar(255),
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_cash" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"provisional_no" varchar(32) NOT NULL,
	"visit_id" varchar(64) NOT NULL,
	"visit_ref" varchar(32) NOT NULL,
	"agent_user_id" varchar(64) NOT NULL,
	"agent_name" varchar(255) NOT NULL,
	"invoice_no" varchar(64) NOT NULL,
	"amount_rwf" integer NOT NULL,
	"status" varchar(16) NOT NULL,
	"deposit_ref" varchar(128),
	"confirmations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"escalated_at" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_field_cash_provisional" UNIQUE("provisional_no"),
	CONSTRAINT "ck_field_cash_amount" CHECK ("field_cash"."amount_rwf" > 0)
);
--> statement-breakpoint
CREATE TABLE "field_conflicts" (
	"op_id" varchar(128) PRIMARY KEY NOT NULL,
	"visit_id" varchar(64) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"note" text,
	"resolved_by" varchar(64),
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_counters" (
	"name" varchar(32) PRIMARY KEY NOT NULL,
	"value" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_custody" (
	"receipt_ref" varchar(32) PRIMARY KEY NOT NULL,
	"visit_id" varchar(64) NOT NULL,
	"items" integer NOT NULL,
	"stage" varchar(24) NOT NULL,
	"events" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_expenses" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"ref" varchar(32) NOT NULL,
	"local_ref" varchar(64) NOT NULL,
	"visit_id" varchar(64),
	"visit_ref" varchar(32),
	"category" varchar(16) NOT NULL,
	"amount_rwf" integer NOT NULL,
	"receipt_key" varchar(255),
	"no_receipt_reason" text,
	"note" text,
	"state" varchar(24) NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trail" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payout_batch" varchar(32),
	"claimant_id" varchar(64) NOT NULL,
	"claimant_name" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_field_expenses_ref" UNIQUE("ref"),
	CONSTRAINT "ck_field_expenses_amount" CHECK ("field_expenses"."amount_rwf" > 0)
);
--> statement-breakpoint
CREATE TABLE "field_flag_reviews" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"visit_id" varchar(64) NOT NULL,
	"flags" jsonb NOT NULL,
	"reviewed" boolean DEFAULT false NOT NULL,
	"reviewed_by" varchar(64),
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_incidents" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"ref" varchar(32) NOT NULL,
	"visit_id" varchar(64) NOT NULL,
	"type" varchar(32) NOT NULL,
	"description" text NOT NULL,
	"by_user_id" varchar(64) NOT NULL,
	"by_name" varchar(255) NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_momo" (
	"transaction_id" varchar(64) PRIMARY KEY NOT NULL,
	"idem_key" varchar(128),
	"visit_id" varchar(64) NOT NULL,
	"invoice_no" varchar(64) NOT NULL,
	"agent_user_id" varchar(64) NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_ops" (
	"op_id" varchar(128) NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"response" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_field_ops" UNIQUE("user_id","op_id")
);
--> statement-breakpoint
CREATE TABLE "field_otps" (
	"visit_id" varchar(64) PRIMARY KEY NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_pool_shares" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"agent_user_id" varchar(64) NOT NULL,
	"case_ref" varchar(64) NOT NULL,
	"service" varchar(255) NOT NULL,
	"pool_rwf" integer NOT NULL,
	"state" varchar(16) NOT NULL,
	"month" varchar(7) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_receipts" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"ref" varchar(32) NOT NULL,
	"local_ref" varchar(64) NOT NULL,
	"visit_id" varchar(64) NOT NULL,
	"direction" varchar(16) NOT NULL,
	"items" jsonb NOT NULL,
	"client_name" varchar(255) NOT NULL,
	"signature" jsonb NOT NULL,
	"signature_key" varchar(255),
	"condition_notes" text,
	"pdf_key" varchar(255),
	"sha256" varchar(64) NOT NULL,
	"supersedes_id" varchar(64),
	"agent_user_id" varchar(64) NOT NULL,
	"agent_name" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_field_receipts_ref" UNIQUE("ref")
);
--> statement-breakpoint
CREATE TABLE "field_scans" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"visit_id" varchar(64) NOT NULL,
	"label" varchar(255) NOT NULL,
	"pages" integer NOT NULL,
	"bytes" integer NOT NULL,
	"page_keys" jsonb NOT NULL,
	"pdf_key" varchar(255),
	"status" varchar(16) NOT NULL,
	"by_user_id" varchar(64) NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_settings" (
	"id" varchar(16) PRIMARY KEY NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_visits" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"ref" varchar(32) NOT NULL,
	"agent_user_id" varchar(64) NOT NULL,
	"case_ref" varchar(64) NOT NULL,
	"service_id" varchar(128) NOT NULL,
	"purpose" varchar(32) NOT NULL,
	"status" varchar(16) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"office_version" integer DEFAULT 0 NOT NULL,
	"title_i18n" jsonb NOT NULL,
	"todo_i18n" jsonb NOT NULL,
	"institution" varchar(255),
	"address" varchar(512) NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"priority" varchar(8) DEFAULT 'normal' NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_required" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"client_enc" text NOT NULL,
	"checkin" jsonb,
	"checkout" jsonb,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"custody_open" integer DEFAULT 0 NOT NULL,
	"collects_docs" boolean DEFAULT false NOT NULL,
	"offer_expires_at" timestamp with time zone,
	"cancelled_reason" text,
	"changed" jsonb,
	"created_by" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_field_visits_ref" UNIQUE("ref"),
	CONSTRAINT "ck_field_visits_status" CHECK ("field_visits"."status" in ('offered','scheduled','in_progress','completed','missed','cancelled','declined'))
);
--> statement-breakpoint
CREATE TABLE "finance_records" (
	"kind" varchar(24) NOT NULL,
	"id" varchar(96) NOT NULL,
	"status" varchar(32),
	"ref" varchar(96),
	"data" jsonb NOT NULL,
	"rev" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_finance_records" PRIMARY KEY("kind","id")
);
--> statement-breakpoint
CREATE TABLE "finance_sequences" (
	"key" varchar(32) PRIMARY KEY NOT NULL,
	"last" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"code" varchar(16) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_ledger_accounts_type" CHECK ("ledger_accounts"."type" in ('asset','liability','equity','revenue','expense'))
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"journal_id" varchar(64) NOT NULL,
	"account_code" varchar(16) NOT NULL,
	"debit_rwf" bigint DEFAULT 0 NOT NULL,
	"credit_rwf" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "ck_ledger_entries_one_side" CHECK ("ledger_entries"."debit_rwf" >= 0 and "ledger_entries"."credit_rwf" >= 0 and ("ledger_entries"."debit_rwf" = 0) <> ("ledger_entries"."credit_rwf" = 0))
);
--> statement-breakpoint
CREATE TABLE "ledger_journals" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"period_id" varchar(7) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"memo" text NOT NULL,
	"source_type" varchar(32) NOT NULL,
	"source_id" varchar(128) NOT NULL,
	"reverses_id" varchar(64),
	"created_by" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_ledger_journals_source" UNIQUE("source_type","source_id")
);
--> statement-breakpoint
CREATE TABLE "ledger_periods" (
	"id" varchar(7) PRIMARY KEY NOT NULL,
	"status" varchar(8) DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" varchar(64),
	CONSTRAINT "ck_ledger_periods_status" CHECK ("ledger_periods"."status" in ('open','closed'))
);
--> statement-breakpoint
CREATE TABLE "mkt_records" (
	"kind" varchar(24) NOT NULL,
	"id" varchar(128) NOT NULL,
	"pos" bigint NOT NULL,
	"status" varchar(32),
	"ref" varchar(128),
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_mkt_records" PRIMARY KEY("kind","id")
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"user_id" varchar(64) PRIMARY KEY NOT NULL,
	"email_enabled" boolean NOT NULL,
	"digest_enabled" boolean NOT NULL,
	"last_digest_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	"channels" jsonb
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"kind" varchar(48) NOT NULL,
	"title" varchar(255) NOT NULL,
	"body" varchar(1024),
	"href" varchar(1024),
	"conversation_id" varchar(64),
	"channel" varchar(16) DEFAULT 'in_app' NOT NULL,
	"data" jsonb,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_profiles" (
	"user_id" varchar(64) PRIMARY KEY NOT NULL,
	"title" varchar(120) DEFAULT 'Agent' NOT NULL,
	"external" boolean DEFAULT false NOT NULL,
	"location" varchar(120),
	"cost_rwf" integer,
	"cap" integer DEFAULT 8 NOT NULL,
	"share_bps" integer DEFAULT 3000 NOT NULL,
	"manager_id" varchar(64),
	"languages" jsonb DEFAULT '["rw"]'::jsonb NOT NULL,
	"services" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skills" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"skills_label" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'available' NOT NULL,
	"on_leave_until" date,
	"on_time_bps" integer DEFAULT 9000 NOT NULL,
	"rating_x10" integer DEFAULT 45 NOT NULL,
	"duty" varchar(8) DEFAULT 'on' NOT NULL,
	"away_until" timestamp with time zone,
	"clearance" varchar(24) DEFAULT 'new' NOT NULL,
	"ws" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_holidays" (
	"day" date NOT NULL,
	"name" varchar(120) NOT NULL,
	"country" varchar(2) DEFAULT 'RW' NOT NULL,
	CONSTRAINT "compliance_holidays_country_day_pk" PRIMARY KEY("country","day")
);
--> statement-breakpoint
CREATE TABLE "compliance_rules" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"code" varchar(64) NOT NULL,
	"authority" varchar(16) NOT NULL,
	"label" jsonb NOT NULL,
	"recurrence" jsonb NOT NULL,
	"due_rule" varchar(24) DEFAULT 'next_business_day' NOT NULL,
	"lead_days" integer NOT NULL,
	"remind_offsets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"service_slug" varchar(128),
	"active" boolean DEFAULT true NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"updated_by" varchar(64),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops_case_events" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"application_id" varchar(64) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"feed" varchar(8) DEFAULT 'ops' NOT NULL,
	"actor_id" varchar(64),
	"actor_name" varchar(255) NOT NULL,
	"from_value" varchar(255),
	"to_value" varchar(255),
	"text" text,
	"ip" varchar(64),
	"internal" boolean DEFAULT false NOT NULL,
	"client" boolean DEFAULT false NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops_case_meta" (
	"application_id" varchar(64) PRIMARY KEY NOT NULL,
	"code" varchar(32) NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops_client_profiles" (
	"user_id" varchar(64) PRIMARY KEY NOT NULL,
	"type" varchar(16) DEFAULT 'individual' NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dedicated_agent_id" varchar(64),
	"since" varchar(8)
);
--> statement-breakpoint
CREATE TABLE "ops_records" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"kind" varchar(24) NOT NULL,
	"owner_id" varchar(64),
	"ref" varchar(64),
	"state" varchar(24),
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_payment_methods" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"client_id" varchar(64) NOT NULL,
	"kind" varchar(8) NOT NULL,
	"label" varchar(64) NOT NULL,
	"last4" varchar(4) NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_client_payment_methods" UNIQUE("client_id","kind","label","last4"),
	CONSTRAINT "ck_client_payment_methods_kind" CHECK ("client_payment_methods"."kind" in ('momo','card'))
);
--> statement-breakpoint
CREATE TABLE "payment_webhook_events" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"provider" varchar(16) NOT NULL,
	"event_key" varchar(128) NOT NULL,
	"transaction_id" varchar(64),
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_payment_webhook_events_key" UNIQUE("provider","event_key")
);
--> statement-breakpoint
CREATE TABLE "procurement_records" (
	"kind" varchar(24) NOT NULL,
	"id" varchar(64) NOT NULL,
	"pos" bigint NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "procurement_records_kind_id_pk" PRIMARY KEY("kind","id")
);
--> statement-breakpoint
CREATE TABLE "system_records" (
	"kind" varchar(24) NOT NULL,
	"id" varchar(96) NOT NULL,
	"pos" bigint NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_records_kind_id_pk" PRIMARY KEY("kind","id")
);
--> statement-breakpoint
CREATE TABLE "agent_documents" (
	"document_id" varchar(64) PRIMARY KEY NOT NULL,
	"agent_id" varchar(64) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"original_filename" varchar(512) NOT NULL,
	"storage_path" varchar(1024) NOT NULL,
	"mime_type" varchar(128) NOT NULL,
	"file_size_bytes" integer NOT NULL,
	"status" varchar(32) NOT NULL,
	"review_note" text,
	"reviewed_by" varchar(64),
	"reviewed_at" timestamp with time zone,
	"is_active" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_agent_documents_kind" CHECK ((kind)::text = ANY ((ARRAY['cv'::character varying, 'contract'::character varying])::text[])),
	CONSTRAINT "ck_agent_documents_status" CHECK ((status)::text = ANY ((ARRAY['pending'::character varying, 'accepted'::character varying, 'rejected'::character varying])::text[]))
);
--> statement-breakpoint
CREATE TABLE "agent_service_skills" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"agent_id" varchar(64) NOT NULL,
	"service_category" varchar(64) NOT NULL,
	"proficiency_level" integer NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_agent_service_skills_agent_category" UNIQUE("agent_id","service_category"),
	CONSTRAINT "ck_agent_service_skills_proficiency_level" CHECK ((proficiency_level >= 1) AND (proficiency_level <= 5))
);
--> statement-breakpoint
CREATE TABLE "agent_settings" (
	"user_id" varchar(64) PRIMARY KEY NOT NULL,
	"accepting_cases" boolean NOT NULL,
	"daily_case_cap" integer,
	"notification_new_case" boolean NOT NULL,
	"notification_client_reply" boolean NOT NULL,
	"notification_sla_alert" boolean NOT NULL,
	"notification_daily_summary" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"monthly_percent" integer,
	"one_off_percent" integer,
	"payout_phone" varchar(32),
	"payout_bank_name" varchar(128),
	"payout_bank_account" varchar(64),
	"payout_account_name" varchar(255),
	CONSTRAINT "ck_agent_settings_monthly_percent" CHECK ((monthly_percent IS NULL) OR ((monthly_percent >= 0) AND (monthly_percent <= 100))),
	CONSTRAINT "ck_agent_settings_one_off_percent" CHECK ((one_off_percent IS NULL) OR ((one_off_percent >= 0) AND (one_off_percent <= 100)))
);
--> statement-breakpoint
CREATE TABLE "application_assignment_history" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"application_id" varchar(64) NOT NULL,
	"previous_agent_id" varchar(64),
	"new_agent_id" varchar(64),
	"performed_by" varchar(64) NOT NULL,
	"performed_by_role" varchar(32) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_documents" (
	"document_id" varchar(64) PRIMARY KEY NOT NULL,
	"application_id" varchar(64) NOT NULL,
	"requirement_key" varchar(128) NOT NULL,
	"original_filename" varchar(512) NOT NULL,
	"storage_path" varchar(1024) NOT NULL,
	"mime_type" varchar(128) NOT NULL,
	"file_size_bytes" integer NOT NULL,
	"uploaded_by" varchar(64),
	"uploaded_by_role" varchar(32) NOT NULL,
	"version" integer NOT NULL,
	"qc_status" varchar(32) NOT NULL,
	"qc_notes" jsonb,
	"is_active" boolean NOT NULL,
	"replaced_by" varchar(64),
	"created_at" timestamp with time zone NOT NULL,
	"vault_document_id" varchar(64),
	"vault_version" integer,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "application_escalations" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"application_id" varchar(64) NOT NULL,
	"escalated_by" varchar(64) NOT NULL,
	"reason" text NOT NULL,
	"oversight_status" varchar(32) NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" varchar(64),
	"resolution_note" text,
	"created_at" timestamp with time zone NOT NULL,
	"kind" varchar(32),
	"related_user_id" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "application_messages" (
	"message_id" varchar(64) PRIMARY KEY NOT NULL,
	"application_id" varchar(64),
	"sender_id" varchar(64),
	"sender_role" varchar(32),
	"content" text NOT NULL,
	"is_internal" boolean NOT NULL,
	"is_system" boolean NOT NULL,
	"attachments" jsonb NOT NULL,
	"is_read_by_client" boolean NOT NULL,
	"read_by_agent_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"assignment_id" varchar(64),
	"lane" varchar(16) NOT NULL,
	"conversation_id" varchar(64) NOT NULL,
	"seq" bigint NOT NULL,
	"client_msg_id" varchar(64),
	"kind" varchar(24) DEFAULT 'text' NOT NULL,
	"payload" jsonb,
	"reply_to_id" varchar(64),
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"deleted_by" varchar(64),
	"pinned_at" timestamp with time zone,
	"pinned_by" varchar(64),
	CONSTRAINT "ck_application_messages_kind" CHECK ((kind)::text = ANY ((ARRAY['text'::character varying, 'system'::character varying, 'doc_request'::character varying, 'doc_shared'::character varying, 'status_update'::character varying, 'payment_request'::character varying, 'appointment'::character varying, 'handoff'::character varying, 'dispute_opened'::character varying, 'dispute_resolved'::character varying, 'admin_joined'::character varying, 'admin_left'::character varying])::text[])),
	CONSTRAINT "ck_application_messages_lane" CHECK ((lane)::text = ANY ((ARRAY['client'::character varying, 'team'::character varying, 'internal'::character varying, 'direct'::character varying])::text[]))
);
--> statement-breakpoint
CREATE TABLE "application_status_history" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"application_id" varchar(64) NOT NULL,
	"status" varchar(32) NOT NULL,
	"changed_by" varchar(64),
	"changed_by_role" varchar(32),
	"note" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"application_id" varchar(64) PRIMARY KEY NOT NULL,
	"code" varchar(32) NOT NULL,
	"service_id" varchar(64) NOT NULL,
	"structure_version_id" varchar(64) NOT NULL,
	"service_slug" varchar(128) NOT NULL,
	"service_name" varchar(255) NOT NULL,
	"tier" varchar(32) NOT NULL,
	"status" varchar(32) NOT NULL,
	"client_id" varchar(64),
	"assigned_agent_id" varchar(64),
	"assigned_at" timestamp with time zone,
	"personal_info" jsonb NOT NULL,
	"service_data" jsonb NOT NULL,
	"payment_status" varchar(32) NOT NULL,
	"payment_amount" integer,
	"submission_ip" varchar(64),
	"sla_deadline" timestamp with time zone,
	"sla_breached_at" timestamp with time zone,
	"submitted_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"rejection_reason" text,
	"cancellation_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"current_assignment_id" varchar(64),
	"handler" varchar(16) NOT NULL,
	"ending" varchar(16) NOT NULL,
	"assigned_partner_id" varchar(64),
	"quote_status" varchar(32),
	"agreed_amount_rwf" integer,
	"hebuza_percent" integer,
	"idempotency_key" varchar(128),
	"partner_client_lane_open" boolean NOT NULL,
	"due_at" timestamp with time zone,
	"due_source" varchar(16) NOT NULL,
	"due_set_by" varchar(64),
	"client_preferred_date" date,
	"is_urgent" boolean NOT NULL,
	"basis_amount_rwf" bigint,
	"price_band_id" varchar(64),
	"price_band_snapshot" jsonb,
	CONSTRAINT "uq_applications_code" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"actor_id" varchar(64),
	"actor_role" varchar(32),
	"action" varchar(128) NOT NULL,
	"resource_type" varchar(64) NOT NULL,
	"resource_id" varchar(128),
	"details" jsonb NOT NULL,
	"ip_address" varchar(64),
	"kind" varchar(32) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"chain_seq" bigint,
	"chain_prev" varchar(64),
	"chain_hash" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "backup_codes" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"code_hash" varchar(128) NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_templates" (
	"template_id" varchar(64) PRIMARY KEY NOT NULL,
	"title" varchar(120) NOT NULL,
	"body_rw" text NOT NULL,
	"body_en" text NOT NULL,
	"body_fr" text NOT NULL,
	"scope" varchar(16) DEFAULT 'all' NOT NULL,
	"created_by" varchar(64),
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_chat_templates_ck_chat_templates_scope" CHECK ((scope)::text = ANY ((ARRAY['agent'::character varying, 'admin'::character varying, 'all'::character varying])::text[]))
);
--> statement-breakpoint
CREATE TABLE "client_document_versions" (
	"version_id" varchar(64) PRIMARY KEY NOT NULL,
	"document_id" varchar(64) NOT NULL,
	"version" integer NOT NULL,
	"storage_path" varchar(1024) NOT NULL,
	"original_filename" varchar(512) NOT NULL,
	"mime_type" varchar(128) NOT NULL,
	"file_size_bytes" integer NOT NULL,
	"content_sha256" varchar(64) NOT NULL,
	"uploaded_at" timestamp with time zone NOT NULL,
	"orphaned_at" timestamp with time zone,
	CONSTRAINT "uq_client_document_versions_document_version" UNIQUE("document_id","version")
);
--> statement-breakpoint
CREATE TABLE "client_documents" (
	"document_id" varchar(64) PRIMARY KEY NOT NULL,
	"client_id" varchar(64) NOT NULL,
	"original_filename" varchar(512) NOT NULL,
	"storage_path" varchar(1024) NOT NULL,
	"mime_type" varchar(128) NOT NULL,
	"file_size_bytes" integer NOT NULL,
	"label" varchar(255),
	"kind" varchar(64),
	"is_active" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"content_sha256" varchar(64),
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "client_obligations" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"client_id" varchar(64) NOT NULL,
	"service_id" varchar(64) NOT NULL,
	"rule_id" varchar(64),
	"period_key" varchar(128) NOT NULL,
	"label" jsonb NOT NULL,
	"due_date" date NOT NULL,
	"lead_days" integer NOT NULL,
	"remind_offsets" jsonb NOT NULL,
	"status" varchar(16) NOT NULL,
	"application_id" varchar(64),
	"note" text,
	"resolved_by" varchar(64),
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_client_obligations_period" UNIQUE("client_id","service_id","period_key"),
	CONSTRAINT "ck_client_obligations_ck_client_obligations_status" CHECK ((status)::text = ANY ((ARRAY['upcoming'::character varying, 'in_progress'::character varying, 'done'::character varying, 'missed'::character varying, 'skipped'::character varying])::text[]))
);
--> statement-breakpoint
CREATE TABLE "client_subscriptions" (
	"subscription_id" varchar(64) PRIMARY KEY NOT NULL,
	"client_id" varchar(64) NOT NULL,
	"plan_id" varchar(64) NOT NULL,
	"status" varchar(32) NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"last_recorded_payment_at" timestamp with time zone,
	"dedicated_agent_id" varchar(64),
	"assigned_by" varchar(64),
	"assigned_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_client_subscriptions_client_id" UNIQUE("client_id"),
	CONSTRAINT "ck_client_subscriptions_ck_client_subscriptions_status" CHECK ((status)::text = ANY ((ARRAY['active'::character varying, 'paused'::character varying, 'cancelled'::character varying, 'expired'::character varying, 'trial'::character varying])::text[]))
);
--> statement-breakpoint
CREATE TABLE "contact_inquiries" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"contact" varchar(255) NOT NULL,
	"topic" varchar(128) NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_participants" (
	"conversation_id" varchar(64) NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"role" varchar(32) NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"left_at" timestamp with time zone,
	"left_reason" varchar(32),
	"last_read_seq" bigint DEFAULT '0' NOT NULL,
	"last_delivered_seq" bigint DEFAULT '0' NOT NULL,
	"last_notified_at" timestamp with time zone,
	"muted_until" timestamp with time zone,
	CONSTRAINT "pk_conversation_participants" PRIMARY KEY("conversation_id","user_id"),
	CONSTRAINT "ck_conversation_participants_left_reason" CHECK ((left_reason IS NULL) OR ((left_reason)::text = ANY ((ARRAY['unassigned'::character varying, 'reassigned'::character varying, 'closed'::character varying, 'left'::character varying])::text[]))),
	CONSTRAINT "ck_conversation_participants_role" CHECK ((role)::text = ANY ((ARRAY['client'::character varying, 'partner'::character varying, 'agent'::character varying, 'admin'::character varying])::text[]))
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"conversation_id" varchar(64) PRIMARY KEY NOT NULL,
	"kind" varchar(16) NOT NULL,
	"application_id" varchar(64),
	"title" varchar(255),
	"last_seq" bigint DEFAULT '0' NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "ck_conversations_kind" CHECK ((kind)::text = ANY ((ARRAY['case'::character varying, 'direct_staff'::character varying, 'direct_partner'::character varying, 'support'::character varying])::text[]))
);
--> statement-breakpoint
CREATE TABLE "deadline_notifications" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"target_type" varchar(32) NOT NULL,
	"target_id" varchar(128) NOT NULL,
	"offset_days" integer NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_deadline_notifications_target" UNIQUE("target_type","target_id","offset_days")
);
--> statement-breakpoint
CREATE TABLE "dedicated_agent_focus" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"subscription_id" varchar(64) NOT NULL,
	"category_slug" varchar(64),
	"service_id" varchar(64),
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_dedicated_agent_focus_ck_dedicated_agent_focus_one_target" CHECK ((category_slug IS NULL) <> (service_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"identifier" varchar(255) NOT NULL,
	"ip_address" varchar(64),
	"success" boolean NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_attachments" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"application_id" varchar(64),
	"message_id" varchar(64),
	"uploaded_by" varchar(64),
	"lane" varchar(16) NOT NULL,
	"storage_path" varchar(1024) NOT NULL,
	"filename" varchar(512) NOT NULL,
	"mime" varchar(128) NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"conversation_id" varchar(64),
	"sha256" varchar(64),
	"scan_status" varchar(16) DEFAULT 'skipped' NOT NULL,
	"thumbnail_path" varchar(1024),
	"width" integer,
	"height" integer,
	CONSTRAINT "ck_message_attachments_scan_status" CHECK ((scan_status)::text = ANY ((ARRAY['pending'::character varying, 'clean'::character varying, 'infected'::character varying, 'skipped'::character varying])::text[]))
);
--> statement-breakpoint
CREATE TABLE "message_edits" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"message_id" varchar(64) NOT NULL,
	"previous_content" text NOT NULL,
	"edited_at" timestamp with time zone NOT NULL,
	"edited_by" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "message_mentions" (
	"message_id" varchar(64) NOT NULL,
	"subject_key" varchar(80) NOT NULL,
	"user_id" varchar(64),
	"mention_role" varchar(32),
	CONSTRAINT "pk_message_mentions" PRIMARY KEY("message_id","subject_key"),
	CONSTRAINT "ck_message_mentions_mention_subject" CHECK (((user_id IS NOT NULL) AND (mention_role IS NULL)) OR ((user_id IS NULL) AND ((mention_role)::text = 'admin'::text)))
);
--> statement-breakpoint
CREATE TABLE "message_reactions" (
	"message_id" varchar(64) NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"emoji" varchar(16) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pk_message_reactions" PRIMARY KEY("message_id","user_id","emoji"),
	CONSTRAINT "ck_message_reactions_emoji" CHECK ((emoji)::text = ANY ((ARRAY['👍'::character varying, '✅'::character varying, '🙏'::character varying, '❤️'::character varying, '👀'::character varying])::text[]))
);
--> statement-breakpoint
CREATE TABLE "message_references" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"message_id" varchar(64) NOT NULL,
	"ref_type" varchar(32) NOT NULL,
	"ref_id" varchar(64) NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "ck_message_references_ref_type" CHECK ((ref_type)::text = ANY ((ARRAY['application_document'::character varying, 'library_document'::character varying, 'attachment'::character varying, 'message'::character varying, 'application'::character varying, 'requirement'::character varying])::text[]))
);
--> statement-breakpoint
CREATE TABLE "partner_documents" (
	"document_id" varchar(64) PRIMARY KEY NOT NULL,
	"partner_id" varchar(64) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"original_filename" varchar(512) NOT NULL,
	"storage_path" varchar(1024) NOT NULL,
	"mime_type" varchar(128) NOT NULL,
	"file_size_bytes" integer NOT NULL,
	"note" text,
	"uploaded_by" varchar(64),
	"is_active" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"status" varchar(16) NOT NULL,
	"review_note" text,
	"reviewed_by" varchar(64),
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "ck_partner_documents_kind" CHECK ((kind)::text = ANY ((ARRAY['cv'::character varying, 'contract'::character varying])::text[])),
	CONSTRAINT "ck_partner_documents_status" CHECK ((status)::text = ANY ((ARRAY['pending'::character varying, 'accepted'::character varying, 'rejected'::character varying])::text[]))
);
--> statement-breakpoint
CREATE TABLE "partner_profiles" (
	"user_id" varchar(64) PRIMARY KEY NOT NULL,
	"org_name" varchar(255) NOT NULL,
	"org_type" varchar(64) NOT NULL,
	"registration_number" varchar(64),
	"referral_code" varchar(64),
	"referred_by_agent_id" varchar(64),
	"status" varchar(32) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"starting_percent" integer,
	"payout_phone" varchar(32),
	"payout_bank_name" varchar(128),
	"payout_bank_account" varchar(64),
	"payout_account_name" varchar(255),
	CONSTRAINT "ck_partner_profiles_org_type" CHECK ((org_type)::text = ANY ((ARRAY['law-firm'::character varying, 'accounting'::character varying, 'notary'::character varying, 'business-centre'::character varying, 'consultancy'::character varying, 'other'::character varying])::text[])),
	CONSTRAINT "ck_partner_profiles_starting_percent" CHECK ((starting_percent IS NULL) OR ((starting_percent >= 0) AND (starting_percent <= 100))),
	CONSTRAINT "ck_partner_profiles_status" CHECK ((status)::text = ANY ((ARRAY['active'::character varying, 'suspended'::character varying])::text[]))
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"purpose" varchar(16) NOT NULL,
	CONSTRAINT "uq_password_reset_tokens_token_hash" UNIQUE("token_hash"),
	CONSTRAINT "ck_password_reset_tokens_purpose" CHECK ((purpose)::text = ANY ((ARRAY['invite'::character varying, 'reset'::character varying])::text[]))
);
--> statement-breakpoint
CREATE TABLE "payment_splits" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"payment_id" varchar(64) NOT NULL,
	"source" varchar(16) NOT NULL,
	"application_code" varchar(64),
	"worker_id" varchar(64),
	"worker_role" varchar(16),
	"rate_percent" integer NOT NULL,
	"base_amount_rwf" integer NOT NULL,
	"hebuza_amount_rwf" integer NOT NULL,
	"worker_amount_rwf" integer NOT NULL,
	"government_fee_rwf" integer NOT NULL,
	"frozen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_payment_splits_rate_percent" CHECK ((rate_percent >= 0) AND (rate_percent <= 100)),
	CONSTRAINT "ck_payment_splits_source" CHECK ((source)::text = ANY ((ARRAY['plan'::character varying, 'service'::character varying, 'partner'::character varying])::text[]))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"payment_id" varchar(64) PRIMARY KEY NOT NULL,
	"application_code" varchar(64) NOT NULL,
	"transaction_id" varchar(64) NOT NULL,
	"amount_rwf" integer NOT NULL,
	"government_fee_rwf" integer NOT NULL,
	"platform_fee_rwf" integer NOT NULL,
	"vat_rate" numeric(4, 3) NOT NULL,
	"currency" varchar(8) NOT NULL,
	"method" varchar(32) NOT NULL,
	"provider_transaction_id" varchar(256),
	"receipt_number" varchar(64),
	"status" varchar(32) NOT NULL,
	"card_brand" varchar(16),
	"masked_phone" varchar(32),
	"session_token" varchar(128),
	"paid_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"client_id" varchar(64),
	"plan_id" varchar(64),
	CONSTRAINT "uq_payments_transaction_id" UNIQUE("transaction_id"),
	CONSTRAINT "uq_payments_receipt_number" UNIQUE("receipt_number")
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"id" varchar(16) PRIMARY KEY NOT NULL,
	"accept_new_apps" boolean NOT NULL,
	"guest_apps" boolean NOT NULL,
	"data_retention" varchar(32) NOT NULL,
	"compact_tables" boolean NOT NULL,
	"enforce_2fa" boolean NOT NULL,
	"session_timeout_minutes" integer NOT NULL,
	"ip_allowlist" text,
	"maintenance_mode" boolean NOT NULL,
	"updated_by" varchar(64),
	"updated_at" timestamp with time zone NOT NULL,
	"default_monthly_percent" integer NOT NULL,
	"default_one_off_percent" integer NOT NULL,
	"require_agent_papers" boolean NOT NULL,
	"payments_enabled" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"family_id" varchar(64) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by_token_id" varchar(64),
	"created_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "uq_refresh_tokens_token_hash" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "service_categories" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name_rw" varchar(128) NOT NULL,
	"name_en" varchar(128) NOT NULL,
	"name_fr" varchar(128) NOT NULL,
	"description" text,
	"icon" varchar(64),
	"color" varchar(16),
	"sort_order" integer NOT NULL,
	"is_active" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"description_rw" text,
	"description_en" text,
	"description_fr" text,
	CONSTRAINT "uq_service_categories_slug" UNIQUE("slug"),
	CONSTRAINT "ck_service_categories_color" CHECK ((color IS NULL) OR ((color)::text = ANY ((ARRAY['marigold'::character varying, 'pink'::character varying, 'green'::character varying, 'blue'::character varying, 'red'::character varying, 'cream'::character varying])::text[])))
);
--> statement-breakpoint
CREATE TABLE "service_deadline_rules" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"service_id" varchar(64) NOT NULL,
	"label" jsonb NOT NULL,
	"recurrence" jsonb NOT NULL,
	"lead_days" integer NOT NULL,
	"remind_offsets" jsonb NOT NULL,
	"active" boolean NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_price_bands" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"service_id" varchar(64) NOT NULL,
	"min_amount_rwf" bigint NOT NULL,
	"max_amount_rwf" bigint,
	"fee_type" varchar(16) NOT NULL,
	"fee_rwf" bigint,
	"fee_percent" numeric(7, 4),
	"min_fee_rwf" bigint,
	"max_fee_rwf" bigint,
	"sort_order" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_pricing_tiers" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"service_id" varchar(64) NOT NULL,
	"tier" varchar(32) NOT NULL,
	"display_name" varchar(128) NOT NULL,
	"description" text,
	"platform_fee" integer NOT NULL,
	"government_fee" integer NOT NULL,
	"eta_business_days" integer NOT NULL,
	"features" jsonb NOT NULL,
	"is_available" boolean NOT NULL,
	CONSTRAINT "uq_service_pricing_tiers_service_tier" UNIQUE("service_id","tier")
);
--> statement-breakpoint
CREATE TABLE "service_structure_versions" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"service_id" varchar(64) NOT NULL,
	"version" integer NOT NULL,
	"status" varchar(32) NOT NULL,
	"definition" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_service_structure_versions_service_version" UNIQUE("service_id","version")
);
--> statement-breakpoint
CREATE TABLE "service_subcategories" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"category_id" varchar(64) NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name_rw" varchar(128) NOT NULL,
	"name_en" varchar(128) NOT NULL,
	"name_fr" varchar(128) NOT NULL,
	"description" text,
	"description_rw" text,
	"description_en" text,
	"description_fr" text,
	"icon" varchar(64),
	"color" varchar(16),
	"sort_order" integer NOT NULL,
	"is_active" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_service_subcategories_slug" UNIQUE("slug"),
	CONSTRAINT "ck_service_subcategories_color" CHECK ((color IS NULL) OR ((color)::text = ANY ((ARRAY['marigold'::character varying, 'pink'::character varying, 'green'::character varying, 'blue'::character varying, 'red'::character varying, 'cream'::character varying])::text[])))
);
--> statement-breakpoint
CREATE TABLE "services" (
	"service_id" varchar(64) PRIMARY KEY NOT NULL,
	"slug" varchar(128) NOT NULL,
	"name" varchar(255) NOT NULL,
	"category" varchar(64) NOT NULL,
	"short_description" text,
	"description" text,
	"color" varchar(16),
	"icon" varchar(64),
	"status" varchar(32) NOT NULL,
	"published_version" integer NOT NULL,
	"is_featured" boolean NOT NULL,
	"created_by" varchar(64),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"category_id" varchar(64),
	"name_rw" varchar(255),
	"name_en" varchar(255),
	"name_fr" varchar(255),
	"short_description_rw" text,
	"short_description_en" text,
	"short_description_fr" text,
	"description_rw" text,
	"description_en" text,
	"description_fr" text,
	"subcategory_id" varchar(64),
	"handler" varchar(16) NOT NULL,
	"deadline_mode" varchar(16) NOT NULL,
	"pricing_mode" varchar(16) NOT NULL,
	"range_basis_label" jsonb,
	"plan_covered" boolean NOT NULL,
	"urgent_surcharge_type" varchar(16),
	"urgent_surcharge_value" integer,
	CONSTRAINT "uq_services_slug" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "staff_profiles" (
	"user_id" varchar(64) PRIMARY KEY NOT NULL,
	"totp_secret_encrypted" text,
	"twofa_enabled" boolean NOT NULL,
	"sms_phone_e164" varchar(32),
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_plans" (
	"plan_id" varchar(64) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"interval" varchar(16) NOT NULL,
	"amount_rwf" integer NOT NULL,
	"is_active" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"kind" varchar(32) NOT NULL,
	"max_applications_per_month" integer,
	"trial_days" integer,
	"description" text,
	"features" jsonb NOT NULL,
	"badge" varchar(64),
	"sort_order" integer NOT NULL,
	"is_public" boolean NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "ck_subscription_plans_ck_subscription_plans_amount" CHECK (amount_rwf >= 0),
	CONSTRAINT "ck_subscription_plans_ck_subscription_plans_interval" CHECK (("interval")::text = 'month'::text),
	CONSTRAINT "ck_subscription_plans_ck_subscription_plans_kind" CHECK ((kind)::text = ANY ((ARRAY['trial'::character varying, 'paid'::character varying, 'retainer'::character varying])::text[]))
);
--> statement-breakpoint
CREATE TABLE "team_access_requests" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"reference" varchar(32) NOT NULL,
	"email" varchar(255) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"note" text,
	"status" varchar(32) NOT NULL,
	"user_agent" varchar(512),
	"location" varchar(128),
	"resolved_by" varchar(64),
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_team_access_requests_reference" UNIQUE("reference"),
	CONSTRAINT "ck_team_access_requests_kind" CHECK ((kind)::text = ANY ((ARRAY['password'::character varying, 'two_factor'::character varying, 'unlock'::character varying, 'other'::character varying])::text[])),
	CONSTRAINT "ck_team_access_requests_status" CHECK ((status)::text = ANY ((ARRAY['open'::character varying, 'approved'::character varying, 'declined'::character varying])::text[]))
);
--> statement-breakpoint
CREATE TABLE "terms_acceptances" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"policy_version" varchar(64) NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_reads" (
	"application_id" varchar(64) NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"last_read_at" timestamp with time zone,
	"last_notified_at" timestamp with time zone,
	CONSTRAINT "pk_thread_reads" PRIMARY KEY("application_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "trusted_devices" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"fingerprint_hash" varchar(64) NOT NULL,
	"trusted_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_trusted_devices_user_id_fingerprint_hash" UNIQUE("user_id","fingerprint_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"user_id" varchar(64) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"email" varchar(255),
	"phone_e164" varchar(32),
	"password_hash" text NOT NULL,
	"role" varchar(32) NOT NULL,
	"is_active" boolean NOT NULL,
	"is_email_verified" boolean NOT NULL,
	"language" varchar(8) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_users_email_role" UNIQUE("email","role"),
	CONSTRAINT "uq_users_phone_role" UNIQUE("phone_e164","role")
);
--> statement-breakpoint
ALTER TABLE "application_feedback" ADD CONSTRAINT "application_feedback_application_id_applications_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_requests" ADD CONSTRAINT "document_requests_application_id_applications_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_requests" ADD CONSTRAINT "document_requests_requested_by_users_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_author_id_users_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_impersonations" ADD CONSTRAINT "auth_impersonations_actor_id_users_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_impersonations" ADD CONSTRAINT "auth_impersonations_target_id_users_user_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_trusted_devices" ADD CONSTRAINT "auth_trusted_devices_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cms_comments" ADD CONSTRAINT "cms_comments_entry_id_cms_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."cms_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cms_locks" ADD CONSTRAINT "cms_locks_entry_id_cms_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."cms_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cms_versions" ADD CONSTRAINT "cms_versions_entry_id_cms_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."cms_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_document_expiry" ADD CONSTRAINT "client_document_expiry_document_id_client_documents_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."client_documents"("document_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_application_id_applications_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_created_by_users_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "fk_ledger_entries_journal_id" FOREIGN KEY ("journal_id") REFERENCES "public"."ledger_journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "fk_ledger_entries_account_code" FOREIGN KEY ("account_code") REFERENCES "public"."ledger_accounts"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "fk_ledger_journals_period_id" FOREIGN KEY ("period_id") REFERENCES "public"."ledger_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "fk_ledger_journals_reverses_id" FOREIGN KEY ("reverses_id") REFERENCES "public"."ledger_journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "fk_ledger_journals_created_by" FOREIGN KEY ("created_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_periods" ADD CONSTRAINT "fk_ledger_periods_closed_by" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_manager_id_users_user_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_case_events" ADD CONSTRAINT "ops_case_events_application_id_applications_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_case_meta" ADD CONSTRAINT "ops_case_meta_application_id_applications_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_client_profiles" ADD CONSTRAINT "ops_client_profiles_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_client_profiles" ADD CONSTRAINT "ops_client_profiles_dedicated_agent_id_users_user_id_fk" FOREIGN KEY ("dedicated_agent_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_payment_methods" ADD CONSTRAINT "fk_client_payment_methods_client_id" FOREIGN KEY ("client_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_documents" ADD CONSTRAINT "fk_agent_documents_agent_id_users" FOREIGN KEY ("agent_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_documents" ADD CONSTRAINT "fk_agent_documents_reviewed_by_users" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_service_skills" ADD CONSTRAINT "fk_agent_service_skills_agent_id_users" FOREIGN KEY ("agent_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_settings" ADD CONSTRAINT "fk_agent_settings_user_id_users" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_assignment_history" ADD CONSTRAINT "fk_application_assignment_history_application_id_applications" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_assignment_history" ADD CONSTRAINT "fk_application_assignment_history_new_agent_id_users" FOREIGN KEY ("new_agent_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_assignment_history" ADD CONSTRAINT "fk_application_assignment_history_performed_by_users" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_assignment_history" ADD CONSTRAINT "fk_application_assignment_history_previous_agent_id_users" FOREIGN KEY ("previous_agent_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_documents" ADD CONSTRAINT "fk_application_documents_application_id_applications" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_documents" ADD CONSTRAINT "fk_application_documents_replaced_by_application_documents" FOREIGN KEY ("replaced_by") REFERENCES "public"."application_documents"("document_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_documents" ADD CONSTRAINT "fk_application_documents_uploaded_by_users" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_documents" ADD CONSTRAINT "fk_application_documents_vault_document_id" FOREIGN KEY ("vault_document_id") REFERENCES "public"."client_documents"("document_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_escalations" ADD CONSTRAINT "fk_application_escalations_application_id_applications" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("application_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_escalations" ADD CONSTRAINT "fk_application_escalations_escalated_by_users" FOREIGN KEY ("escalated_by") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_escalations" ADD CONSTRAINT "fk_application_escalations_related_user_id" FOREIGN KEY ("related_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_escalations" ADD CONSTRAINT "fk_application_escalations_resolved_by_users" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_messages" ADD CONSTRAINT "fk_application_messages_application_id_applications" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_messages" ADD CONSTRAINT "fk_application_messages_assignment_id" FOREIGN KEY ("assignment_id") REFERENCES "public"."application_assignment_history"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_messages" ADD CONSTRAINT "fk_application_messages_conversation_id" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_messages" ADD CONSTRAINT "fk_application_messages_deleted_by" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_messages" ADD CONSTRAINT "fk_application_messages_pinned_by" FOREIGN KEY ("pinned_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_messages" ADD CONSTRAINT "fk_application_messages_reply_to_id" FOREIGN KEY ("reply_to_id") REFERENCES "public"."application_messages"("message_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_messages" ADD CONSTRAINT "fk_application_messages_sender_id_users" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_status_history" ADD CONSTRAINT "fk_application_status_history_application_id_applications" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_status_history" ADD CONSTRAINT "fk_application_status_history_changed_by_users" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "fk_applications_assigned_agent_id_users" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "fk_applications_assigned_partner_id_users" FOREIGN KEY ("assigned_partner_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "fk_applications_client_id_users" FOREIGN KEY ("client_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "fk_applications_current_assignment_id" FOREIGN KEY ("current_assignment_id") REFERENCES "public"."application_assignment_history"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "fk_applications_due_set_by" FOREIGN KEY ("due_set_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "fk_applications_price_band_id" FOREIGN KEY ("price_band_id") REFERENCES "public"."service_price_bands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "fk_applications_service_id_services" FOREIGN KEY ("service_id") REFERENCES "public"."services"("service_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "fk_applications_structure_version_id_service_structure_versions" FOREIGN KEY ("structure_version_id") REFERENCES "public"."service_structure_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "fk_audit_log_actor_id_users" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_codes" ADD CONSTRAINT "fk_backup_codes_user_id_users" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_templates" ADD CONSTRAINT "fk_chat_templates_created_by_users" FOREIGN KEY ("created_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_document_versions" ADD CONSTRAINT "fk_client_document_versions_document_id_client_documents" FOREIGN KEY ("document_id") REFERENCES "public"."client_documents"("document_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_documents" ADD CONSTRAINT "fk_client_documents_client_id" FOREIGN KEY ("client_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_obligations" ADD CONSTRAINT "fk_client_obligations_application_id_applications" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("application_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_obligations" ADD CONSTRAINT "fk_client_obligations_client_id_users" FOREIGN KEY ("client_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_obligations" ADD CONSTRAINT "fk_client_obligations_resolved_by_users" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_obligations" ADD CONSTRAINT "fk_client_obligations_rule_id_service_deadline_rules" FOREIGN KEY ("rule_id") REFERENCES "public"."service_deadline_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_obligations" ADD CONSTRAINT "fk_client_obligations_service_id_services" FOREIGN KEY ("service_id") REFERENCES "public"."services"("service_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_subscriptions" ADD CONSTRAINT "fk_client_subscriptions_assigned_by_users" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_subscriptions" ADD CONSTRAINT "fk_client_subscriptions_client_id_users" FOREIGN KEY ("client_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_subscriptions" ADD CONSTRAINT "fk_client_subscriptions_dedicated_agent_id_users" FOREIGN KEY ("dedicated_agent_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_subscriptions" ADD CONSTRAINT "fk_client_subscriptions_plan_id_plans" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("plan_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "fk_conversation_participants_conversation_id" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "fk_conversation_participants_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "fk_conversations_application_id" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dedicated_agent_focus" ADD CONSTRAINT "fk_dedicated_agent_focus_service_id_services" FOREIGN KEY ("service_id") REFERENCES "public"."services"("service_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dedicated_agent_focus" ADD CONSTRAINT "fk_dedicated_agent_focus_subscription_id_client_subscriptions" FOREIGN KEY ("subscription_id") REFERENCES "public"."client_subscriptions"("subscription_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "fk_message_attachments_application_id_applications" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "fk_message_attachments_conversation_id" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "fk_message_attachments_message_id_application_messages" FOREIGN KEY ("message_id") REFERENCES "public"."application_messages"("message_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "fk_message_attachments_uploaded_by_users" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_edits" ADD CONSTRAINT "fk_message_edits_edited_by" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_edits" ADD CONSTRAINT "fk_message_edits_message_id" FOREIGN KEY ("message_id") REFERENCES "public"."application_messages"("message_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "fk_message_mentions_message_id" FOREIGN KEY ("message_id") REFERENCES "public"."application_messages"("message_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "fk_message_mentions_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "fk_message_reactions_message_id" FOREIGN KEY ("message_id") REFERENCES "public"."application_messages"("message_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "fk_message_reactions_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_references" ADD CONSTRAINT "fk_message_references_message_id" FOREIGN KEY ("message_id") REFERENCES "public"."application_messages"("message_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_documents" ADD CONSTRAINT "fk_partner_documents_partner_id_users" FOREIGN KEY ("partner_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_documents" ADD CONSTRAINT "fk_partner_documents_reviewed_by" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_documents" ADD CONSTRAINT "fk_partner_documents_uploaded_by_users" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_profiles" ADD CONSTRAINT "fk_partner_profiles_referred_by_agent_id_users" FOREIGN KEY ("referred_by_agent_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_profiles" ADD CONSTRAINT "fk_partner_profiles_user_id_users" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "fk_password_reset_tokens_user_id_users" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_splits" ADD CONSTRAINT "fk_payment_splits_payment_id_payments" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("payment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_splits" ADD CONSTRAINT "fk_payment_splits_worker_id_users" FOREIGN KEY ("worker_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "fk_platform_settings_updated_by_users" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "fk_refresh_tokens_user_id_users" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_deadline_rules" ADD CONSTRAINT "fk_service_deadline_rules_service_id_services" FOREIGN KEY ("service_id") REFERENCES "public"."services"("service_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_price_bands" ADD CONSTRAINT "fk_service_price_bands_service_id_services" FOREIGN KEY ("service_id") REFERENCES "public"."services"("service_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_pricing_tiers" ADD CONSTRAINT "fk_service_pricing_tiers_service_id_services" FOREIGN KEY ("service_id") REFERENCES "public"."services"("service_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_structure_versions" ADD CONSTRAINT "fk_service_structure_versions_service_id_services" FOREIGN KEY ("service_id") REFERENCES "public"."services"("service_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_subcategories" ADD CONSTRAINT "fk_service_subcategories_category_id_service_categories" FOREIGN KEY ("category_id") REFERENCES "public"."service_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "fk_services_category_id_service_categories" FOREIGN KEY ("category_id") REFERENCES "public"."service_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "fk_services_created_by_users" FOREIGN KEY ("created_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "fk_services_subcategory_id_service_subcategories" FOREIGN KEY ("subcategory_id") REFERENCES "public"."service_subcategories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "fk_staff_profiles_user_id_users" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_access_requests" ADD CONSTRAINT "fk_team_access_requests_resolved_by_users" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms_acceptances" ADD CONSTRAINT "fk_terms_acceptances_user_id_users" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_reads" ADD CONSTRAINT "fk_thread_reads_application_id_applications" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_reads" ADD CONSTRAINT "fk_thread_reads_user_id_users" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trusted_devices" ADD CONSTRAINT "fk_trusted_devices_user_id_users" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_document_requests_application_id" ON "document_requests" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "ix_support_ticket_messages_ticket" ON "support_ticket_messages" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_support_tickets_user_created" ON "support_tickets" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_ai_handoffs_at" ON "ai_handoffs" USING btree ("at");--> statement-breakpoint
CREATE INDEX "ix_ai_kb_chunks_source" ON "ai_kb_chunks" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "ix_ai_kb_chunks_fts" ON "ai_kb_chunks" USING gin (to_tsvector('simple', "title" || ' ' || "content"));--> statement-breakpoint
CREATE INDEX "ix_ai_messages_session" ON "ai_messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_ai_messages_outcome" ON "ai_messages" USING btree ("outcome","created_at");--> statement-breakpoint
CREATE INDEX "ix_ai_sessions_started" ON "ai_sessions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "ix_ai_sessions_owner" ON "ai_sessions" USING btree ("owner_id","started_at");--> statement-breakpoint
CREATE INDEX "ix_auth_impersonations_actor_id" ON "auth_impersonations" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "ix_auth_sessions_user_id" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_auth_trusted_devices_user_id" ON "auth_trusted_devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_bkg_bookings_adviser_start" ON "bkg_bookings" USING btree ("adviser_id","starts_at");--> statement-breakpoint
CREATE INDEX "ix_bkg_bookings_start" ON "bkg_bookings" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "ix_bkg_bookings_contact" ON "bkg_bookings" USING btree ("contact_key");--> statement-breakpoint
CREATE INDEX "ix_bkg_bookings_client" ON "bkg_bookings" USING btree ("client_id","starts_at");--> statement-breakpoint
CREATE INDEX "ix_bkg_bookings_reference" ON "bkg_bookings" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "ix_bkg_payments_booking" ON "bkg_payments" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "ix_bkg_requests_status" ON "bkg_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "ix_bkg_waitlist_day" ON "bkg_waitlist" USING btree ("type_slug","date","created_at");--> statement-breakpoint
CREATE INDEX "ix_service_sub_statuses_canonical" ON "service_sub_statuses" USING btree ("canonical","sort_order");--> statement-breakpoint
CREATE INDEX "ix_cms_comments_entry" ON "cms_comments" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "ix_cms_entries_updated" ON "cms_entries" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "ix_deliverables_application_id" ON "deliverables" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "ix_field_cash_status" ON "field_cash" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_field_conflicts_status" ON "field_conflicts" USING btree ("status","at");--> statement-breakpoint
CREATE INDEX "ix_field_custody_visit" ON "field_custody" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "ix_field_custody_stage" ON "field_custody" USING btree ("stage");--> statement-breakpoint
CREATE INDEX "ix_field_expenses_claimant" ON "field_expenses" USING btree ("claimant_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_field_expenses_state" ON "field_expenses" USING btree ("state");--> statement-breakpoint
CREATE INDEX "ix_field_flag_reviews_open" ON "field_flag_reviews" USING btree ("reviewed","at");--> statement-breakpoint
CREATE INDEX "ix_field_incidents_visit" ON "field_incidents" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "ix_field_momo_invoice" ON "field_momo" USING btree ("invoice_no");--> statement-breakpoint
CREATE INDEX "ix_field_pool_shares_agent_month" ON "field_pool_shares" USING btree ("agent_user_id","month");--> statement-breakpoint
CREATE INDEX "ix_field_receipts_visit" ON "field_receipts" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "ix_field_scans_visit" ON "field_scans" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "ix_field_visits_agent_window" ON "field_visits" USING btree ("agent_user_id","window_start");--> statement-breakpoint
CREATE INDEX "ix_field_visits_case_ref" ON "field_visits" USING btree ("case_ref");--> statement-breakpoint
CREATE INDEX "ix_finance_records_kind_status" ON "finance_records" USING btree ("kind","status");--> statement-breakpoint
CREATE INDEX "ix_finance_records_kind_ref" ON "finance_records" USING btree ("kind","ref");--> statement-breakpoint
CREATE INDEX "ix_ledger_entries_journal_id" ON "ledger_entries" USING btree ("journal_id");--> statement-breakpoint
CREATE INDEX "ix_ledger_entries_account_code" ON "ledger_entries" USING btree ("account_code");--> statement-breakpoint
CREATE INDEX "ix_ledger_journals_period_id" ON "ledger_journals" USING btree ("period_id");--> statement-breakpoint
CREATE INDEX "ix_mkt_records_kind_pos" ON "mkt_records" USING btree ("kind","pos");--> statement-breakpoint
CREATE INDEX "ix_mkt_records_kind_status" ON "mkt_records" USING btree ("kind","status");--> statement-breakpoint
CREATE INDEX "ix_mkt_records_kind_ref" ON "mkt_records" USING btree ("kind","ref");--> statement-breakpoint
CREATE INDEX "ix_notifications_user_created" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_notifications_user_unread" ON "notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_compliance_rules_code" ON "compliance_rules" USING btree ("code");--> statement-breakpoint
CREATE INDEX "ix_ops_case_events_app_at" ON "ops_case_events" USING btree ("application_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ops_case_meta_code" ON "ops_case_meta" USING btree ("code");--> statement-breakpoint
CREATE INDEX "ix_ops_records_kind_owner" ON "ops_records" USING btree ("kind","owner_id");--> statement-breakpoint
CREATE INDEX "ix_ops_records_kind_ref" ON "ops_records" USING btree ("kind","ref");--> statement-breakpoint
CREATE INDEX "ix_ops_records_kind_state" ON "ops_records" USING btree ("kind","state");--> statement-breakpoint
CREATE INDEX "ix_client_payment_methods_client_id" ON "client_payment_methods" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "ix_procurement_records_pos" ON "procurement_records" USING btree ("kind","pos");--> statement-breakpoint
CREATE INDEX "ix_system_records_pos" ON "system_records" USING btree ("kind","pos");--> statement-breakpoint
CREATE INDEX "ix_agent_documents_agent_id" ON "agent_documents" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "ix_agent_service_skills_agent_id" ON "agent_service_skills" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "ix_app_assignment_history_application_id" ON "application_assignment_history" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "ix_application_documents_active_req" ON "application_documents" USING btree ("application_id","requirement_key");--> statement-breakpoint
CREATE INDEX "ix_application_documents_application_id" ON "application_documents" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "ix_application_documents_vault_document_id" ON "application_documents" USING btree ("vault_document_id");--> statement-breakpoint
CREATE INDEX "ix_application_escalations_application_id" ON "application_escalations" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "ix_application_escalations_oversight_status" ON "application_escalations" USING btree ("oversight_status");--> statement-breakpoint
CREATE INDEX "ix_application_messages_application_id" ON "application_messages" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "ix_application_messages_conversation_id" ON "application_messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_application_messages_client_msg" ON "application_messages" USING btree ("sender_id","client_msg_id") WHERE (client_msg_id IS NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_application_messages_conversation_seq" ON "application_messages" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE INDEX "ix_app_status_history_application_id" ON "application_status_history" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "ix_applications_assigned_agent_id" ON "applications" USING btree ("assigned_agent_id");--> statement-breakpoint
CREATE INDEX "ix_applications_assigned_partner_id" ON "applications" USING btree ("assigned_partner_id");--> statement-breakpoint
CREATE INDEX "ix_applications_client_id" ON "applications" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "ix_applications_due_at" ON "applications" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "ix_applications_service_id" ON "applications" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "ix_applications_status" ON "applications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_applications_structure_version_id" ON "applications" USING btree ("structure_version_id");--> statement-breakpoint
CREATE INDEX "ix_applications_submitted_at" ON "applications" USING btree ("submitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_applications_idempotency_key" ON "applications" USING btree ("idempotency_key") WHERE (idempotency_key IS NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "ux_audit_log_chain_seq" ON "audit_log" USING btree ("chain_seq");--> statement-breakpoint
CREATE INDEX "ix_audit_log_actor_id" ON "audit_log" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "ix_audit_log_created_at" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ix_audit_log_kind" ON "audit_log" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "ix_backup_codes_user_id" ON "backup_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_chat_templates_scope" ON "chat_templates" USING btree ("scope");--> statement-breakpoint
CREATE INDEX "ix_client_document_versions_content_sha256" ON "client_document_versions" USING btree ("content_sha256");--> statement-breakpoint
CREATE INDEX "ix_client_documents_client_active" ON "client_documents" USING btree ("client_id","is_active");--> statement-breakpoint
CREATE INDEX "ix_client_documents_client_id" ON "client_documents" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "ix_client_obligations_client_id" ON "client_obligations" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "ix_client_obligations_due_date" ON "client_obligations" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "ix_client_subscriptions_dedicated_agent_id" ON "client_subscriptions" USING btree ("dedicated_agent_id");--> statement-breakpoint
CREATE INDEX "ix_client_subscriptions_status" ON "client_subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_conversation_participants_conversation" ON "conversation_participants" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "ix_conversation_participants_user_left" ON "conversation_participants" USING btree ("user_id","left_at");--> statement-breakpoint
CREATE INDEX "ix_conversations_kind" ON "conversations" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "ix_conversations_last_message_at" ON "conversations" USING btree ("last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversations_application_id" ON "conversations" USING btree ("application_id") WHERE (application_id IS NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_dedicated_agent_focus_category" ON "dedicated_agent_focus" USING btree ("subscription_id","category_slug") WHERE (category_slug IS NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_dedicated_agent_focus_service" ON "dedicated_agent_focus" USING btree ("subscription_id","service_id") WHERE (service_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "ix_login_attempts_attempted_at" ON "login_attempts" USING btree ("attempted_at");--> statement-breakpoint
CREATE INDEX "ix_login_attempts_identifier" ON "login_attempts" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "ix_message_attachments_application_id" ON "message_attachments" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "ix_message_attachments_conversation_id" ON "message_attachments" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "ix_message_attachments_message_id" ON "message_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "ix_message_edits_message_id" ON "message_edits" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "ix_message_reactions_message_id" ON "message_reactions" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "ix_message_references_message_id" ON "message_references" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "ix_partner_documents_partner_id" ON "partner_documents" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "ix_partner_profiles_referred_by_agent_id" ON "partner_profiles" USING btree ("referred_by_agent_id");--> statement-breakpoint
CREATE INDEX "ix_partner_profiles_status" ON "partner_profiles" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_password_reset_tokens_user_id" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_payment_splits_application_code" ON "payment_splits" USING btree ("application_code");--> statement-breakpoint
CREATE INDEX "ix_payment_splits_payment_id" ON "payment_splits" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "ix_payment_splits_worker_id" ON "payment_splits" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "ix_payments_application_code" ON "payments" USING btree ("application_code");--> statement-breakpoint
CREATE INDEX "ix_payments_client_id" ON "payments" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "ix_payments_plan_id" ON "payments" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "ix_payments_status" ON "payments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_refresh_tokens_family_id" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "ix_refresh_tokens_user_id" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_service_deadline_rules_service_id" ON "service_deadline_rules" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "ix_service_price_bands_service_id" ON "service_price_bands" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "ix_service_subcategories_category_id" ON "service_subcategories" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "ix_services_category_id" ON "services" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "ix_services_subcategory_id" ON "services" USING btree ("subcategory_id");--> statement-breakpoint
CREATE INDEX "ix_team_access_requests_email" ON "team_access_requests" USING btree ("email");--> statement-breakpoint
CREATE INDEX "ix_team_access_requests_status" ON "team_access_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ix_terms_acceptances_user_id" ON "terms_acceptances" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_thread_reads_user_id" ON "thread_reads" USING btree ("user_id");