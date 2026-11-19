-- For the integrator (fold into the wave migration): company representatives read cases filed for their company
-- (ORG §2 "View company cases": owner/admin/viewer). Writes stay with the filing client.
CREATE POLICY "org_rep_read" ON "applications" FOR SELECT
  USING (organization_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM organization_members m
    WHERE m.organization_id = applications.organization_id AND m.status = 'active' AND app_is_user(m.user_id)));
