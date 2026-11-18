-- staff:marketing sees a client's requests only as (code, service, status, created_at) and a request count — never
-- case details. Same pattern as 0005: raise app.roles to 'system' for the body only, restore before returning.
CREATE OR REPLACE FUNCTION marketing_client_cases(p_client varchar)
RETURNS TABLE(code varchar, service_name varchar, status varchar, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE prev text := coalesce(current_setting('app.roles', true), '');
BEGIN
  IF NOT app_has_role('staff:marketing|staff:executive|staff:sysadmin|system') THEN RETURN; END IF;
  PERFORM set_config('app.roles', 'system', true);
  RETURN QUERY SELECT a.code, a.service_name, a.status, a.created_at FROM applications a
    WHERE a.client_id = p_client ORDER BY a.created_at;
  PERFORM set_config('app.roles', prev, true);
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION marketing_request_count(p_from timestamptz, p_to timestamptz DEFAULT NULL) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE prev text := coalesce(current_setting('app.roles', true), ''); n bigint;
BEGIN
  IF NOT app_has_role('staff:marketing|staff:executive|staff:sysadmin|system') THEN RETURN 0; END IF;
  PERFORM set_config('app.roles', 'system', true);
  SELECT count(*) INTO n FROM applications a WHERE a.created_at >= p_from AND (p_to IS NULL OR a.created_at < p_to);
  PERFORM set_config('app.roles', prev, true);
  RETURN n;
END $$;
