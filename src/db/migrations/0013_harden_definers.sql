-- Harden SECURITY DEFINER escapes: narrow outputs, require caller access, and no PUBLIC execute.
-- The app connects as the owning role (FORCE RLS binds it), so the owner keeps EXECUTE after REVOKE FROM PUBLIC.

-- Tracker/replay columns only (no service_data, submission_ip, pricing internals). The idempotency-key match stays:
-- guest replay (applications.service byKey) has no other way to read back its own unowned row.
CREATE OR REPLACE FUNCTION public_application(p_code varchar, p_key varchar) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE prev text := coalesce(current_setting('app.roles', true), ''); r jsonb;
BEGIN
  PERFORM set_config('app.roles', 'system', true);
  SELECT jsonb_build_object(
    'application_id', a.application_id, 'code', a.code, 'client_id', a.client_id, 'service_id', a.service_id,
    'service_name', a.service_name, 'tier', a.tier, 'status', a.status, 'ending', a.ending,
    'payment_status', a.payment_status, 'payment_amount', a.payment_amount, 'personal_info', a.personal_info,
    'assigned_agent_id', a.assigned_agent_id, 'assigned_partner_id', a.assigned_partner_id,
    'due_at', a.due_at, 'sla_deadline', a.sla_deadline, 'submitted_at', a.submitted_at,
    'created_at', a.created_at, 'updated_at', a.updated_at)
    INTO r FROM applications a
   WHERE (p_code IS NOT NULL AND a.code = p_code) OR (p_key IS NOT NULL AND a.idempotency_key = p_key) LIMIT 1;
  PERFORM set_config('app.roles', prev, true);
  RETURN r;
END $$;--> statement-breakpoint

-- Member ids only for a caller who is in the conversation, on its case, or case staff.
CREATE OR REPLACE FUNCTION conversation_member_ids(p_conv varchar) RETURNS SETOF varchar
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE prev text := coalesce(current_setting('app.roles', true), ''); me text := nullif(current_setting('app.user_id', true), ''); ok boolean;
BEGIN
  PERFORM set_config('app.roles', 'system', true);
  ok := prev ~ '(^|,)(staff:agent|staff:service_manager|staff:sysadmin|staff:admin|system)(,|$)'
     OR EXISTS (SELECT 1 FROM conversation_participants p WHERE p.conversation_id = p_conv AND p.user_id = me AND p.left_at IS NULL)
     OR EXISTS (SELECT 1 FROM conversations c JOIN applications a ON a.application_id = c.application_id
                 WHERE c.conversation_id = p_conv AND me IN (a.client_id, a.assigned_agent_id, a.assigned_partner_id));
  IF ok THEN
    RETURN QUERY SELECT p.user_id FROM conversation_participants p WHERE p.conversation_id = p_conv AND p.left_at IS NULL;
  END IF;
  PERFORM set_config('app.roles', prev, true);
END $$;--> statement-breakpoint

-- Payment status of one field MoMo prompt, only for the agent who started it (agents cannot read `payments`).
CREATE OR REPLACE FUNCTION field_momo_status(p_tx varchar) RETURNS varchar
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE prev text := coalesce(current_setting('app.roles', true), ''); r varchar;
BEGIN
  PERFORM set_config('app.roles', 'system', true);
  SELECT p.status INTO r FROM field_momo m JOIN payments p ON p.transaction_id = m.transaction_id
   WHERE m.transaction_id = p_tx AND m.agent_user_id = nullif(current_setting('app.user_id', true), '');
  PERFORM set_config('app.roles', prev, true);
  RETURN r;
END $$;--> statement-breakpoint

DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.prosecdef LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;
