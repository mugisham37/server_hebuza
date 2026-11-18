-- CRM revenue (marketing customer 360 / lifetime): client checkout payments live in `payments` (RLS: owner + finance), not
-- in the finance P6 invoice store, so marketing read 0 for every self-serve client. Totals only, marketing/exec/sysadmin.
CREATE OR REPLACE FUNCTION marketing_paid_payments()
RETURNS TABLE(no varchar, client_id varchar, code varchar, total integer, paid_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE prev text := coalesce(current_setting('app.roles', true), '');
BEGIN
  IF NOT app_has_role('staff:marketing|staff:executive|staff:sysadmin|system') THEN RETURN; END IF;
  PERFORM set_config('app.roles', 'system', true);
  RETURN QUERY SELECT ('INV-' || regexp_replace(p.application_code, '^PLAN:', 'PLAN-'))::varchar, p.client_id, p.application_code, p.amount_rwf, coalesce(p.paid_at, p.created_at)
    FROM payments p WHERE p.status = 'succeeded' AND p.client_id IS NOT NULL;
  PERFORM set_config('app.roles', prev, true);
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION marketing_paid_payments() FROM PUBLIC;
