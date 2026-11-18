CREATE TABLE "ai_usage" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"session_id" varchar(64),
	"user_id" varchar(64),
	"model" varchar(64) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"usd_micros" integer DEFAULT 0 NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ix_ai_usage_at" ON "ai_usage" USING btree ("at");--> statement-breakpoint
-- Vector side table only where pgvector was installed (0001); otherwise the assistant keeps full-text retrieval.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    CREATE TABLE IF NOT EXISTS "ai_kb_embeddings" (
      "chunk_id" varchar(80) PRIMARY KEY NOT NULL REFERENCES "public"."ai_kb_chunks"("id") ON DELETE cascade,
      "embedding" vector(1024) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "ix_ai_kb_embeddings_hnsw" ON "ai_kb_embeddings" USING hnsw ("embedding" vector_cosine_ops);
  ELSE
    RAISE NOTICE 'pgvector not installed; ai_kb_embeddings skipped';
  END IF;
END $$;
--> statement-breakpoint
-- Marketing insights ratings: staff:marketing sees (application, stars, rated_at, service) only. Same pattern as 0010.
CREATE OR REPLACE FUNCTION marketing_ratings()
RETURNS TABLE(application_id varchar, rating integer, rated_at timestamptz, service_slug varchar)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE prev text := coalesce(current_setting('app.roles', true), '');
BEGIN
  IF NOT app_has_role('staff:marketing|staff:executive|staff:sysadmin|system') THEN RETURN; END IF;
  PERFORM set_config('app.roles', 'system', true);
  RETURN QUERY SELECT f.application_id, f.rating, f.rated_at, a.service_slug FROM application_feedback f
    JOIN applications a ON a.application_id = f.application_id
    WHERE f.rating IS NOT NULL AND f.rated_at IS NOT NULL;
  PERFORM set_config('app.roles', prev, true);
END $$;
