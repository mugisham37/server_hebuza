CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE SEQUENCE "public"."request_group_ref_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "application_claim_otps" (
	"application_id" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignment_blocks" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"agent_id" varchar(64) NOT NULL,
	"client_id" varchar(64) NOT NULL,
	"reason" varchar(500) NOT NULL,
	"created_by" varchar(64),
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_sequences" (
	"year" integer PRIMARY KEY NOT NULL,
	"n" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nps_responses" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"client_id" varchar(64) NOT NULL,
	"score" integer NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_nps_responses_score" CHECK (score BETWEEN 0 AND 10)
);
--> statement-breakpoint
CREATE TABLE "request_groups" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"code" varchar(32) NOT NULL,
	"client_id" varchar(64),
	"total_amount_rwf" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_request_groups_code" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" varchar(64) NOT NULL,
	"role" varchar(32) NOT NULL,
	"granted_by" varchar(64),
	"granted_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "user_roles_user_id_role_pk" PRIMARY KEY("user_id","role")
);
--> statement-breakpoint
CREATE TABLE "bkg_calendar_links" (
	"adviser_id" varchar(64) NOT NULL,
	"provider" varchar(16) NOT NULL,
	"refresh_enc" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "bkg_calendar_links_adviser_id_provider_pk" PRIMARY KEY("adviser_id","provider")
);
--> statement-breakpoint
CREATE TABLE "service_price_changes" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"service_id" varchar(64) NOT NULL,
	"slug" varchar(128) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"tier" varchar(32),
	"body" jsonb NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"status" varchar(16) NOT NULL,
	"proposed_by" varchar(64) NOT NULL,
	"proposed_by_name" varchar(255),
	"decided_by" varchar(64),
	"decided_at" timestamp with time zone,
	"reason" varchar(500),
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cms_feedback" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"entry_type" varchar(32) NOT NULL,
	"entry_key" varchar(160) NOT NULL,
	"locale" varchar(2) NOT NULL,
	"helpful" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliverable_signatures" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"deliverable_id" varchar(64) NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"method" varchar(8) NOT NULL,
	"signer_name" varchar(255) NOT NULL,
	"image_png" text,
	"file_sha256" varchar(64) NOT NULL,
	"audit_hash" varchar(64) NOT NULL,
	"ip" varchar(64),
	"user_agent" varchar(255),
	"provider" varchar(32),
	"provider_ref" varchar(128),
	"signed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_retention_flags" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"source" varchar(16) NOT NULL,
	"source_id" varchar(64) NOT NULL,
	"retention_class" varchar(24) NOT NULL,
	"storage_path" varchar(1024) NOT NULL,
	"label" varchar(255) NOT NULL,
	"case_code" varchar(32),
	"anchor_at" timestamp with time zone NOT NULL,
	"flagged_at" timestamp with time zone NOT NULL,
	"decision" varchar(16),
	"decided_by" varchar(64),
	"decided_at" timestamp with time zone,
	"reason" varchar(500),
	"shredded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "download_tokens" (
	"token_hash" varchar(64) PRIMARY KEY NOT NULL,
	"deliverable_id" varchar(64) NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_events" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"name" varchar(32) NOT NULL,
	"path" varchar(512) NOT NULL,
	"locale" varchar(2),
	"referrer" varchar(512),
	"visitor" varchar(64),
	"props" jsonb,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consent_ledger" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" varchar(64),
	"subject" varchar(255) NOT NULL,
	"purpose" varchar(48) NOT NULL,
	"granted" boolean NOT NULL,
	"source" varchar(32) NOT NULL,
	"policy_version" varchar(32) NOT NULL,
	"ip" varchar(64),
	"user_agent" varchar(255),
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"notification_id" varchar(64),
	"user_id" varchar(64),
	"kind" varchar(64) NOT NULL,
	"channel" varchar(16) NOT NULL,
	"to_masked" varchar(64) NOT NULL,
	"template_key" varchar(96),
	"lang" varchar(8) NOT NULL,
	"status" varchar(16) NOT NULL,
	"provider" varchar(24),
	"provider_id" varchar(128),
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" varchar(512),
	"cost_rwf" integer DEFAULT 0 NOT NULL,
	"chain" jsonb,
	"fallback_from" varchar(64),
	"dedupe_key" varchar(255),
	"payload" jsonb,
	"scheduled_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_suppressions" (
	"channel" varchar(16) NOT NULL,
	"address" varchar(255) NOT NULL,
	"reason" varchar(24) NOT NULL,
	"source" varchar(64),
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "notification_suppressions_channel_address_pk" PRIMARY KEY("channel","address")
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"endpoint" varchar(1024) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "organization_invites" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"organization_id" varchar(64) NOT NULL,
	"contact" varchar(255) NOT NULL,
	"role" varchar(16) NOT NULL,
	"invited_by" varchar(64),
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_organization_invites_token" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"organization_id" varchar(64) NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"role" varchar(16) NOT NULL,
	"title" varchar(128),
	"proof_document_id" varchar(64),
	"status" varchar(16) NOT NULL,
	"invited_by" varchar(64),
	"invited_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "organization_members_organization_id_user_id_pk" PRIMARY KEY("organization_id","user_id"),
	CONSTRAINT "ck_organization_members_role" CHECK (role IN ('owner','admin','viewer')),
	CONSTRAINT "ck_organization_members_status" CHECK (status IN ('active','removed'))
);
--> statement-breakpoint
CREATE TABLE "organization_subscriptions" (
	"organization_id" varchar(64) PRIMARY KEY NOT NULL,
	"plan_id" varchar(64) NOT NULL,
	"status" varchar(16) NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"last_payment_id" varchar(64),
	"paid_by" varchar(64),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_organization_subscriptions_status" CHECK (status IN ('active','cancelled','expired'))
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"customer_no" varchar(24),
	"legal_name" varchar(255) NOT NULL,
	"trade_name" varchar(255),
	"org_type" varchar(24) NOT NULL,
	"tin" varchar(9),
	"rdb_number" varchar(64),
	"registered_on" date,
	"sector_code" varchar(16),
	"province" varchar(64),
	"district" varchar(64),
	"sector" varchar(64),
	"cell" varchar(64),
	"phone" varchar(32),
	"email" varchar(255),
	"website" varchar(255),
	"size_band" varchar(16),
	"vat_registered" boolean DEFAULT false NOT NULL,
	"vat_period" varchar(16) DEFAULT 'monthly' NOT NULL,
	"employer" boolean DEFAULT false NOT NULL,
	"verification_status" varchar(24) DEFAULT 'unverified' NOT NULL,
	"verification_note" varchar(1000),
	"verified_by" varchar(64),
	"verified_at" timestamp with time zone,
	"created_by" varchar(64),
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_organizations_customer_no" UNIQUE("customer_no"),
	CONSTRAINT "ck_organizations_status" CHECK (verification_status IN ('unverified','pending_verification','verified','rejected'))
);
--> statement-breakpoint
CREATE TABLE "partner_actions" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"partner_id" varchar(64) NOT NULL,
	"meeting_id" varchar(64),
	"objective_id" varchar(64),
	"title" varchar(255) NOT NULL,
	"deliverable" varchar(500),
	"owner_user_id" varchar(64),
	"due_on" date,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"done_at" timestamp with time zone,
	CONSTRAINT "ck_partner_actions_status" CHECK (status IN ('open','in_progress','done','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "partner_agreement_files" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"agreement_id" varchar(64) NOT NULL,
	"version" integer NOT NULL,
	"file_key" varchar(1024) NOT NULL,
	"filename" varchar(255) NOT NULL,
	"uploaded_by" varchar(64),
	"uploaded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_agreements" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"partner_id" varchar(64) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"number" varchar(64),
	"title" varchar(255) NOT NULL,
	"signed_on" date,
	"start_on" date NOT NULL,
	"end_on" date,
	"renewal_terms" text,
	"value_amount" bigint,
	"currency" varchar(3) DEFAULT 'RWF' NOT NULL,
	"commission_bps" integer,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"is_confidential" boolean DEFAULT false NOT NULL,
	"file_key" varchar(1024),
	"termination_reason" text,
	"terminated_on" date,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_partner_agreements_dates" CHECK (end_on IS NULL OR end_on >= start_on),
	CONSTRAINT "ck_partner_agreements_status" CHECK (status IN ('draft','active','renewed','expired','terminated'))
);
--> statement-breakpoint
CREATE TABLE "partner_commissions" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"partner_id" varchar(64) NOT NULL,
	"agreement_id" varchar(64),
	"referral_id" varchar(64),
	"application_id" varchar(64),
	"base_amount" bigint NOT NULL,
	"rate_bps" integer NOT NULL,
	"amount" bigint NOT NULL,
	"status" varchar(16) DEFAULT 'computed' NOT NULL,
	"decided_by" varchar(64),
	"decided_at" timestamp with time zone,
	"note" text,
	"reversed_amount" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_partner_commissions_status" CHECK (status IN ('computed','approved','paid','rejected','reversed'))
);
--> statement-breakpoint
CREATE TABLE "partner_contacts" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"partner_id" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"title" varchar(128),
	"email" varchar(255),
	"phone" varchar(32),
	"language" varchar(8),
	"is_primary" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_correspondence" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"partner_id" varchar(64) NOT NULL,
	"direction" varchar(8) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"date" date NOT NULL,
	"subject" varchar(255) NOT NULL,
	"summary" text,
	"file_key" varchar(1024),
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_meetings" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"partner_id" varchar(64) NOT NULL,
	"title" varchar(255) NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"location" varchar(500),
	"agenda" text,
	"minutes" text,
	"decisions" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" varchar(16) DEFAULT 'scheduled' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_objectives" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"partner_id" varchar(64) NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"period" varchar(32),
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_obligations" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"partner_id" varchar(64) NOT NULL,
	"agreement_id" varchar(64) NOT NULL,
	"description" varchar(1000) NOT NULL,
	"owner_user_id" varchar(64),
	"due_on" date,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_opportunities" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"partner_id" varchar(64) NOT NULL,
	"title" varchar(255) NOT NULL,
	"stage" varchar(16) DEFAULT 'idea' NOT NULL,
	"value" bigint,
	"owner_user_id" varchar(64),
	"closed_on" date,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_partner_opportunities_stage" CHECK (stage IN ('idea','proposal','active','won','lost'))
);
--> statement-breakpoint
CREATE TABLE "partner_referrals" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"partner_id" varchar(64) NOT NULL,
	"direction" varchar(8) NOT NULL,
	"client_id" varchar(64),
	"application_id" varchar(64),
	"name" varchar(255) NOT NULL,
	"status" varchar(16) DEFAULT 'referred' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partners" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"organization_id" varchar(64),
	"name" varchar(255) NOT NULL,
	"type" varchar(24) NOT NULL,
	"tier" varchar(16) DEFAULT 'operational' NOT NULL,
	"status" varchar(16) DEFAULT 'prospect' NOT NULL,
	"sector" varchar(128),
	"country" varchar(64) DEFAULT 'Rwanda' NOT NULL,
	"website" varchar(255),
	"logo_url" varchar(1024),
	"shown_on_website" boolean DEFAULT false NOT NULL,
	"owner_user_id" varchar(64),
	"notes" text,
	"last_contact_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_partners_status" CHECK (status IN ('prospect','active','dormant','archived')),
	CONSTRAINT "ck_partners_tier" CHECK (tier IN ('strategic','operational'))
);
--> statement-breakpoint
ALTER TABLE "client_subscriptions" DROP CONSTRAINT "ck_client_subscriptions_ck_client_subscriptions_status";--> statement-breakpoint
ALTER TABLE "subscription_plans" DROP CONSTRAINT "ck_subscription_plans_ck_subscription_plans_interval";--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "last_activity_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "active_role" varchar(32);--> statement-breakpoint
ALTER TABLE "deliverables" ADD COLUMN "signature_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_records" ADD COLUMN "gateway_payment_id" varchar(64);--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "daily_cap" integer;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "work_email" varchar(255);--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "work_phone" varchar(32);--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "social_links" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "application_documents" ADD COLUMN "ocr" jsonb;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "sla_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "sla_paused_ms" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "completion_record" jsonb;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "external_outcome" varchar(32);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "external_outcome_ref" varchar(128);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "external_outcome_institution" varchar(255);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "external_outcome_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "group_id" varchar(64);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "organization_id" varchar(64);--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "status_before_refund" varchar(32);--> statement-breakpoint
ALTER TABLE "client_documents" ADD COLUMN "ocr" jsonb;--> statement-breakpoint
ALTER TABLE "client_documents" ADD COLUMN "organization_id" varchar(64);--> statement-breakpoint
ALTER TABLE "client_subscriptions" ADD COLUMN "cancel_at_period_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "client_subscriptions" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "client_subscriptions" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "client_subscriptions" ADD COLUMN "reminders_sent" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "client_subscriptions" ADD COLUMN "usage_warned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "client_subscriptions" ADD COLUMN "scheduled_plan_id" varchar(64);--> statement-breakpoint
ALTER TABLE "client_subscriptions" ADD COLUMN "paused_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contact_inquiries" ADD COLUMN "status" varchar(16) DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_inquiries" ADD COLUMN "assignee_id" varchar(64);--> statement-breakpoint
ALTER TABLE "contact_inquiries" ADD COLUMN "replied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "sla_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "first_response_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "escalation_level" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "legal_hold" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD COLUMN "issued_by" varchar(64);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "organization_id" varchar(64);--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "engagement_type" varchar(16) DEFAULT 'application' NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "eligibility" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "deliverables" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "turnaround_days_min" integer;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "turnaround_days_max" integer;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "delivery_mode" varchar(16);--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "seo" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "related_slugs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "fee_explainer" jsonb;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "markets" jsonb DEFAULT '["RW"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "revenue_agent_bps" integer;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "locale_slugs" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "search_text" text GENERATED ALWAYS AS (lower(coalesce(name, '') || ' ' || coalesce(name_rw, '') || ' ' || coalesce(name_en, '') || ' ' || coalesce(name_fr, '') || ' ' || coalesce(short_description_rw, '') || ' ' || coalesce(short_description_en, '') || ' ' || coalesce(short_description_fr, '') || ' ' || category)) STORED;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "customer_no" varchar(24);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deletion_scheduled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "application_claim_otps" ADD CONSTRAINT "application_claim_otps_application_id_applications_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("application_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_claim_otps" ADD CONSTRAINT "application_claim_otps_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_blocks" ADD CONSTRAINT "assignment_blocks_agent_id_users_user_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_blocks" ADD CONSTRAINT "assignment_blocks_client_id_users_user_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_blocks" ADD CONSTRAINT "assignment_blocks_created_by_users_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nps_responses" ADD CONSTRAINT "nps_responses_client_id_users_user_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_groups" ADD CONSTRAINT "request_groups_client_id_users_user_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_signatures" ADD CONSTRAINT "deliverable_signatures_deliverable_id_deliverables_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."deliverables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverable_signatures" ADD CONSTRAINT "deliverable_signatures_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_tokens" ADD CONSTRAINT "download_tokens_deliverable_id_deliverables_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."deliverables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_tokens" ADD CONSTRAINT "download_tokens_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_ledger" ADD CONSTRAINT "consent_ledger_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_subscriptions" ADD CONSTRAINT "organization_subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_verified_by_users_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_users_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_actions" ADD CONSTRAINT "partner_actions_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_actions" ADD CONSTRAINT "partner_actions_owner_user_id_users_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_agreement_files" ADD CONSTRAINT "partner_agreement_files_agreement_id_partner_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."partner_agreements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_agreements" ADD CONSTRAINT "partner_agreements_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_commissions" ADD CONSTRAINT "partner_commissions_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_commissions" ADD CONSTRAINT "partner_commissions_agreement_id_partner_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."partner_agreements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_contacts" ADD CONSTRAINT "partner_contacts_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_correspondence" ADD CONSTRAINT "partner_correspondence_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_meetings" ADD CONSTRAINT "partner_meetings_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_objectives" ADD CONSTRAINT "partner_objectives_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_obligations" ADD CONSTRAINT "partner_obligations_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_obligations" ADD CONSTRAINT "partner_obligations_agreement_id_partner_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."partner_agreements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_obligations" ADD CONSTRAINT "partner_obligations_owner_user_id_users_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_opportunities" ADD CONSTRAINT "partner_opportunities_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_opportunities" ADD CONSTRAINT "partner_opportunities_owner_user_id_users_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_referrals" ADD CONSTRAINT "partner_referrals_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_referrals" ADD CONSTRAINT "partner_referrals_client_id_users_user_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_referrals" ADD CONSTRAINT "partner_referrals_application_id_applications_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("application_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partners" ADD CONSTRAINT "partners_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partners" ADD CONSTRAINT "partners_owner_user_id_users_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_assignment_blocks_agent" ON "assignment_blocks" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "ix_assignment_blocks_client" ON "assignment_blocks" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "ix_nps_responses_client" ON "nps_responses" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_request_groups_client" ON "request_groups" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "ix_user_roles_user" ON "user_roles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_service_price_changes_status" ON "service_price_changes" USING btree ("status","effective_at");--> statement-breakpoint
CREATE INDEX "ix_service_price_changes_slug" ON "service_price_changes" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "ix_cms_feedback_entry" ON "cms_feedback" USING btree ("entry_type","entry_key");--> statement-breakpoint
CREATE INDEX "ix_deliverable_signatures_deliverable" ON "deliverable_signatures" USING btree ("deliverable_id");--> statement-breakpoint
CREATE INDEX "ix_document_retention_flags_open" ON "document_retention_flags" USING btree ("decision","flagged_at");--> statement-breakpoint
CREATE INDEX "ix_document_retention_flags_source" ON "document_retention_flags" USING btree ("source","source_id");--> statement-breakpoint
CREATE INDEX "ix_download_tokens_deliverable" ON "download_tokens" USING btree ("deliverable_id");--> statement-breakpoint
CREATE INDEX "ix_site_events_name_at" ON "site_events" USING btree ("name","created_at");--> statement-breakpoint
CREATE INDEX "ix_consent_subject_purpose" ON "consent_ledger" USING btree ("subject","purpose","created_at");--> statement-breakpoint
CREATE INDEX "ix_ntf_deliveries_created" ON "notification_deliveries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ix_ntf_deliveries_status" ON "notification_deliveries" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "ix_ntf_deliveries_dedupe" ON "notification_deliveries" USING btree ("dedupe_key","created_at");--> statement-breakpoint
CREATE INDEX "ix_ntf_deliveries_provider" ON "notification_deliveries" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "ix_ntf_deliveries_notification" ON "notification_deliveries" USING btree ("notification_id");--> statement-breakpoint
CREATE INDEX "ix_push_subscriptions_user" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_organization_invites_org" ON "organization_invites" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ix_organization_members_user" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_organizations_verified_tin" ON "organizations" USING btree ("tin") WHERE verification_status = 'verified' and tin is not null;--> statement-breakpoint
CREATE INDEX "ix_partner_actions_partner" ON "partner_actions" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "ix_partner_agreement_files_agreement" ON "partner_agreement_files" USING btree ("agreement_id");--> statement-breakpoint
CREATE INDEX "ix_partner_agreements_partner" ON "partner_agreements" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "ix_partner_commissions_partner" ON "partner_commissions" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "ix_partner_contacts_partner" ON "partner_contacts" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "ix_partner_correspondence_partner" ON "partner_correspondence" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "ix_partner_meetings_partner" ON "partner_meetings" USING btree ("partner_id","starts_at");--> statement-breakpoint
CREATE INDEX "ix_partner_objectives_partner" ON "partner_objectives" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "ix_partner_obligations_agreement" ON "partner_obligations" USING btree ("agreement_id");--> statement-breakpoint
CREATE INDEX "ix_partner_opportunities_partner" ON "partner_opportunities" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "ix_partner_referrals_partner" ON "partner_referrals" USING btree ("partner_id");--> statement-breakpoint
ALTER TABLE "finance_records" ADD CONSTRAINT "finance_records_gateway_payment_id_payments_payment_id_fk" FOREIGN KEY ("gateway_payment_id") REFERENCES "public"."payments"("payment_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_finance_records_gateway_payment" ON "finance_records" USING btree ("gateway_payment_id");--> statement-breakpoint
CREATE INDEX "ix_application_messages_content_fts" ON "application_messages" USING gin (to_tsvector('simple', "content"));--> statement-breakpoint
CREATE INDEX "ix_services_search_trgm" ON "services" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
ALTER TABLE "platform_settings" DROP COLUMN "data_retention";--> statement-breakpoint
ALTER TABLE "platform_settings" DROP COLUMN "compact_tables";--> statement-breakpoint
ALTER TABLE "platform_settings" DROP COLUMN "enforce_2fa";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "uq_users_customer_no" UNIQUE("customer_no");--> statement-breakpoint
ALTER TABLE "client_subscriptions" ADD CONSTRAINT "ck_client_subscriptions_ck_client_subscriptions_status" CHECK ((status)::text = ANY ((ARRAY['active'::character varying, 'past_due'::character varying, 'paused'::character varying, 'cancelled'::character varying, 'expired'::character varying, 'trial'::character varying])::text[]));--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD CONSTRAINT "ck_subscription_plans_ck_subscription_plans_interval" CHECK (("interval")::text = ANY ((ARRAY['month'::character varying, 'year'::character varying])::text[]));--> statement-breakpoint
-- Hand-written (docs/audit/migration-notes.md): RLS + idempotent data steps
DROP POLICY IF EXISTS "finance_read" ON "applications";--> statement-breakpoint
CREATE POLICY "finance_read" ON "applications" FOR SELECT USING (app_has_role('staff:finance'));--> statement-breakpoint
DROP POLICY IF EXISTS "org_rep_read" ON "applications";--> statement-breakpoint
CREATE POLICY "org_rep_read" ON "applications" FOR SELECT USING (organization_id IS NOT NULL AND EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = applications.organization_id AND m.status = 'active' AND app_is_user(m.user_id)));--> statement-breakpoint
-- a) every external agent has a worker profile row
INSERT INTO agent_profiles (user_id, title, external, updated_at)
SELECT p.user_id, coalesce(nullif(p.org_name, ''), 'External agent'), true, now()
FROM partner_profiles p JOIN users u ON u.user_id = p.user_id AND u.role = 'ext:agent'
ON CONFLICT (user_id) DO NOTHING;--> statement-breakpoint
-- b) payout destination + share terms carried over into the profile workspace blob (never overwrite newer data)
UPDATE agent_profiles a SET
  ws = jsonb_set(coalesce(a.ws, '{}'::jsonb), '{legacyPartner}', jsonb_strip_nulls(jsonb_build_object(
    'orgName', p.org_name, 'orgType', p.org_type, 'registrationNumber', p.registration_number,
    'startingPercent', p.starting_percent, 'payoutPhone', p.payout_phone, 'payoutBankName', p.payout_bank_name,
    'payoutBankAccountLast4', right(p.payout_bank_account, 4), 'payoutAccountName', p.payout_account_name,
    'migratedAt', now()))),
  share_bps = CASE WHEN a.share_bps = 3000 AND p.starting_percent IS NOT NULL THEN p.starting_percent * 100 ELSE a.share_bps END, -- 3000 = untouched default
  work_phone = coalesce(a.work_phone, p.payout_phone)
FROM partner_profiles p JOIN users u ON u.user_id = p.user_id AND u.role = 'ext:agent'
WHERE a.user_id = p.user_id AND NOT (coalesce(a.ws, '{}'::jsonb) ? 'legacyPartner');--> statement-breakpoint
-- c) legacy partner documents become worker credentials (read in /work credentials); files stay where they are
UPDATE ops_records r SET data = jsonb_set(r.data, '{credentials}', coalesce(r.data->'credentials', '[]'::jsonb) || coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', d.document_id, 'title', d.original_filename, 'kind', d.kind, 'storagePath', d.storage_path,
      'status', CASE d.status WHEN 'approved' THEN 'verified' WHEN 'rejected' THEN 'rejected' ELSE 'pending' END,
      'migrated', true))
    FROM partner_documents d
    WHERE d.partner_id = r.owner_id AND d.is_active
      AND NOT (coalesce(r.data->'credentials', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('id', d.document_id)))
  ), '[]'::jsonb))
WHERE r.kind = 'work_ext' AND EXISTS (SELECT 1 FROM users u WHERE u.user_id = r.owner_id AND u.role = 'ext:agent');--> statement-breakpoint
INSERT INTO user_roles (user_id, role, granted_by, granted_at, expires_at)
SELECT r.id, g->>'role', g->>'grantedBy', coalesce((g->>'grantedAt')::timestamptz, now()), (g->>'expiresAt')::timestamptz
FROM system_records r, jsonb_array_elements(coalesce(r.data->'extraRoles', '[]'::jsonb)) g
WHERE r.kind = 'userMeta' AND g->>'role' IS NOT NULL
ON CONFLICT (user_id, role) DO NOTHING;--> statement-breakpoint
INSERT INTO user_roles (user_id, role, granted_by, granted_at)
SELECT u.user_id, r.role, 'migration:staff_admin_split', now()
FROM users u CROSS JOIN (VALUES ('staff:service_manager'), ('staff:executive')) AS r(role)
WHERE u.role = 'staff:admin'
ON CONFLICT (user_id, role) DO NOTHING;--> statement-breakpoint
UPDATE users u SET role = 'staff:sysadmin', updated_at = now()
WHERE u.role = 'staff:admin'
  AND NOT EXISTS (SELECT 1 FROM users x WHERE x.role = 'staff:sysadmin' AND (x.email = u.email OR x.phone_e164 = u.phone_e164));--> statement-breakpoint
UPDATE finance_records fr SET gateway_payment_id = fr.data->>'gatewayPaymentId'
WHERE fr.kind = 'payment' AND fr.gateway_payment_id IS NULL AND fr.data ? 'gatewayPaymentId'
  AND EXISTS (SELECT 1 FROM payments p WHERE p.payment_id = fr.data->>'gatewayPaymentId');
