-- Row-Level Security for client-owned tables (defence in depth under the service-layer checks).
-- TxService sets per-transaction GUCs: app.user_id (session user) and app.roles (comma-separated roles,
-- slugs from packages/domain/src/auth/roles.ts; "system" = TxService.runAsSystem, worker/cron only).
-- A row is visible/writable to its owner (owner column = app.user_id) or to the per-table bypass roles:
--   payments                                     : staff:finance, staff:sysadmin, system
--   applications                                 : case staff (staff:agent, staff:service_manager, staff:sysadmin, system)
--                                                  + ext:agent only on rows where assigned_agent_id = app.user_id
--   client_documents, conversation_participants  : case staff (ext:agent excluded: no assignment column)
--   notifications                                : owner + system only
-- FORCE applies RLS to the table owner too, so queries outside TxService see nothing on these tables.
-- Unset GUCs (current_setting(..., true) → NULL/'') never match, so the default is deny.
CREATE OR REPLACE FUNCTION app_has_role(roles_re text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.roles', true), '') ~ ('(^|,)(' || roles_re || ')(,|$)')
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_is_user(id varchar) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT id = nullif(current_setting('app.user_id', true), '')
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_case_staff() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT app_has_role('staff:agent|staff:service_manager|staff:sysadmin|system')
$$;--> statement-breakpoint
ALTER TABLE "applications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "applications" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "own" ON "applications"
  USING (app_is_user(client_id) OR app_case_staff() OR (app_has_role('ext:agent') AND app_is_user(assigned_agent_id)))
  WITH CHECK (app_is_user(client_id) OR app_case_staff() OR (app_has_role('ext:agent') AND app_is_user(assigned_agent_id)));--> statement-breakpoint
ALTER TABLE "client_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "client_documents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "own" ON "client_documents" USING (app_is_user(client_id) OR app_case_staff()) WITH CHECK (app_is_user(client_id) OR app_case_staff());--> statement-breakpoint
ALTER TABLE "conversation_participants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation_participants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "own" ON "conversation_participants" USING (app_is_user(user_id) OR app_case_staff()) WITH CHECK (app_is_user(user_id) OR app_case_staff());--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "own" ON "notifications" USING (app_is_user(user_id) OR app_has_role('system')) WITH CHECK (app_is_user(user_id) OR app_has_role('system'));--> statement-breakpoint
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "own" ON "payments" USING (app_is_user(client_id) OR app_has_role('staff:finance|staff:sysadmin|system')) WITH CHECK (app_is_user(client_id) OR app_has_role('staff:finance|staff:sysadmin|system'));
