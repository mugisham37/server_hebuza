-- Narrow RLS escapes (owners are already allowed by 0003). FORCE RLS also binds the function owner, so each
-- SECURITY DEFINER function raises app.roles to 'system' for its own body only and restores it before returning.
CREATE OR REPLACE FUNCTION public_service_volume(days int) RETURNS TABLE(service_id varchar, n bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE prev text := coalesce(current_setting('app.roles', true), '');
BEGIN
  PERFORM set_config('app.roles', 'system', true);
  RETURN QUERY SELECT a.service_id, count(*) FROM applications a WHERE a.submitted_at >= now() - make_interval(days => days) GROUP BY a.service_id;
  PERFORM set_config('app.roles', prev, true);
END $$;--> statement-breakpoint
-- Guest-application claim: a signed-in client may read/claim only an UNOWNED application by its code.
CREATE OR REPLACE FUNCTION guest_application(p_code varchar) RETURNS TABLE(application_id varchar, personal_info jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE prev text := coalesce(current_setting('app.roles', true), '');
BEGIN
  PERFORM set_config('app.roles', 'system', true);
  RETURN QUERY SELECT a.application_id, a.personal_info FROM applications a WHERE a.code = p_code AND a.client_id IS NULL FOR UPDATE;
  PERFORM set_config('app.roles', prev, true);
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION claim_application(p_id varchar) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE prev text := coalesce(current_setting('app.roles', true), ''); uid text := nullif(current_setting('app.user_id', true), ''); hit boolean;
BEGIN
  IF uid IS NULL THEN RETURN false; END IF;
  PERFORM set_config('app.roles', 'system', true);
  UPDATE applications SET client_id = uid, updated_at = now() WHERE application_id = p_id AND client_id IS NULL;
  hit := FOUND;
  PERFORM set_config('app.roles', prev, true);
  RETURN hit;
END $$;
