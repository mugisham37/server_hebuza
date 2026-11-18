-- Wave 3 integration: read-only executives + two narrow SECURITY DEFINER readers (same pattern as 0005).
-- staff:executive reads case lists/documents/participants but never writes them (SELECT-only policies, OR-ed with "own").
CREATE POLICY "exec_read" ON "applications" FOR SELECT USING (app_has_role('staff:executive'));--> statement-breakpoint
CREATE POLICY "exec_read" ON "client_documents" FOR SELECT USING (app_has_role('staff:executive'));--> statement-breakpoint
CREATE POLICY "exec_read" ON "conversation_participants" FOR SELECT USING (app_has_role('staff:executive'));--> statement-breakpoint
-- Active (non-terminal) case counts per service + structure version, across all owners (catalogue boards).
CREATE OR REPLACE FUNCTION service_active_counts() RETURNS TABLE(service_id varchar, structure_version_id varchar, n bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE prev text := coalesce(current_setting('app.roles', true), '');
BEGIN
  PERFORM set_config('app.roles', 'system', true);
  RETURN QUERY SELECT a.service_id, a.structure_version_id, count(*) FROM applications a
   WHERE a.status NOT IN ('completed', 'completed_delivered', 'rejected', 'cancelled', 'refunded')
   GROUP BY a.service_id, a.structure_version_id;
  PERFORM set_config('app.roles', prev, true);
END $$;--> statement-breakpoint
-- Active participant ids of one conversation (chat realtime fan-out; RLS shows a client only their own row).
CREATE OR REPLACE FUNCTION conversation_member_ids(p_conv varchar) RETURNS SETOF varchar
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE prev text := coalesce(current_setting('app.roles', true), '');
BEGIN
  PERFORM set_config('app.roles', 'system', true);
  RETURN QUERY SELECT p.user_id FROM conversation_participants p WHERE p.conversation_id = p_conv AND p.left_at IS NULL;
  PERFORM set_config('app.roles', prev, true);
END $$;
