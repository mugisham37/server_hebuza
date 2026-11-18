-- W3-A: guest submissions and the public tracker are cross-owner by nature (no app.user_id).
-- Guests may INSERT an unowned application (no RETURNING/SELECT: they still cannot read it back directly).
CREATE POLICY "guest_insert" ON "applications" FOR INSERT
  WITH CHECK (client_id IS NULL AND nullif(current_setting('app.user_id', true), '') IS NULL);--> statement-breakpoint
-- One application by tracking code or submission idempotency key, as jsonb (column names), or NULL.
CREATE OR REPLACE FUNCTION public_application(p_code varchar, p_key varchar) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE prev text := coalesce(current_setting('app.roles', true), ''); r jsonb;
BEGIN
  PERFORM set_config('app.roles', 'system', true);
  SELECT to_jsonb(a) INTO r FROM applications a
   WHERE (p_code IS NOT NULL AND a.code = p_code) OR (p_key IS NOT NULL AND a.idempotency_key = p_key) LIMIT 1;
  PERFORM set_config('app.roles', prev, true);
  RETURN r;
END $$;--> statement-breakpoint
-- Succeeded payments of one case (tracker detail after the contact check).
CREATE OR REPLACE FUNCTION public_paid_payments(p_code varchar) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE prev text := coalesce(current_setting('app.roles', true), '');
BEGIN
  PERFORM set_config('app.roles', 'system', true);
  RETURN QUERY SELECT to_jsonb(p) FROM payments p WHERE p.application_code = p_code AND p.status = 'succeeded' ORDER BY p.paid_at;
  PERFORM set_config('app.roles', prev, true);
END $$;
