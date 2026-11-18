-- Wave 4: ext:agent reach beyond assigned_agent_id (OR-ed with "own" from 0003).
-- Helper on a case: the user id is in ops_case_meta.data->'helpers' (agent "my cases" list + case detail).
CREATE POLICY "ext_helper" ON "applications"
  USING (app_has_role('ext:agent') AND EXISTS (SELECT 1 FROM ops_case_meta m WHERE m.application_id = applications.application_id AND m.data->'helpers' ? current_setting('app.user_id', true)))
  WITH CHECK (app_has_role('ext:agent') AND EXISTS (SELECT 1 FROM ops_case_meta m WHERE m.application_id = applications.application_id AND m.data->'helpers' ? current_setting('app.user_id', true)));--> statement-breakpoint
-- Firm admin: cases assigned to a member of the firm they own (work_firm record, owner_id = admin; firm jobs + internal reassignment).
CREATE POLICY "ext_firm_admin" ON "applications"
  USING (app_has_role('ext:agent') AND EXISTS (SELECT 1 FROM ops_records f WHERE f.kind = 'work_firm' AND app_is_user(f.owner_id) AND f.data->'members' @> jsonb_build_array(jsonb_build_object('id', applications.assigned_agent_id))))
  WITH CHECK (app_has_role('ext:agent') AND EXISTS (SELECT 1 FROM ops_records f WHERE f.kind = 'work_firm' AND app_is_user(f.owner_id) AND f.data->'members' @> jsonb_build_array(jsonb_build_object('id', applications.assigned_agent_id))));
