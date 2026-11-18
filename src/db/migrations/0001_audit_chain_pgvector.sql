ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "chain_seq" bigint;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "chain_prev" varchar(64);--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "chain_hash" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_audit_log_chain_seq" ON "audit_log" USING btree ("chain_seq");--> statement-breakpoint
-- Backfill the chain columns from the pre-P13 details._chain copy (hash input strips _chain, so hashes still verify).
UPDATE "audit_log" SET
  "chain_seq" = ("details"->'_chain'->>'seq')::bigint,
  "chain_prev" = "details"->'_chain'->>'prev',
  "chain_hash" = "details"->'_chain'->>'hash'
WHERE "details" ? '_chain' AND "chain_seq" IS NULL;--> statement-breakpoint
-- Append-only: any UPDATE or DELETE on audit_log fails (incl. the users FK's ON DELETE SET NULL; users are deactivated, never deleted).
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "audit_log_append_only" ON "audit_log";--> statement-breakpoint
CREATE TRIGGER "audit_log_append_only" BEFORE UPDATE OR DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();--> statement-breakpoint
CREATE TRIGGER "audit_log_no_truncate" BEFORE TRUNCATE ON "audit_log" FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();--> statement-breakpoint
-- pgvector for assistant embeddings. Conditional: the dev Postgres image may not ship the extension (production uses a pgvector image).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
  ELSE
    RAISE NOTICE 'pgvector not available on this server; assistant keeps full-text retrieval';
  END IF;
END $$;
