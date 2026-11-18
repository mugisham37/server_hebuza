CREATE TABLE "idempotency_keys" (
	"key" varchar(128) NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"body_hash" varchar(64) NOT NULL,
	"status" integer,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_key_user_id_pk" PRIMARY KEY("key","user_id")
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"type" varchar(96) NOT NULL,
	"payload" jsonb NOT NULL,
	"queue" varchar(16) DEFAULT 'default' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "ix_idempotency_keys_created_at" ON "idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ix_outbox_pending" ON "outbox" USING btree ("run_at") WHERE sent_at is null;