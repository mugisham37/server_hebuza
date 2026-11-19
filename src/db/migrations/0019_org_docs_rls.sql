-- Company representatives read the company vault (ORG-07) and company-filed case documents' list; writes stay with the uploader.
DROP POLICY IF EXISTS "org_rep_read" ON "client_documents";--> statement-breakpoint
CREATE POLICY "org_rep_read" ON "client_documents" FOR SELECT USING (organization_id IS NOT NULL AND EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = client_documents.organization_id AND m.status = 'active' AND app_is_user(m.user_id)));
