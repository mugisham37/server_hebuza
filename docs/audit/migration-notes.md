# Migration notes for the integrator (finance / workforce waves)

Hand-written SQL to append to the wave migration after `db:generate`. Each step is idempotent.

## 1. RLS: finance reads cases (G0)

```sql
CREATE POLICY "finance_read" ON "applications" FOR SELECT USING (app_has_role('staff:finance'));
```

## 2. F-WRK-01 / F-WRK-24 — legacy `partner_profiles` → unified worker profile (`agent_profiles`)

Scope: only users whose role is `ext:agent` (external agents). Institutional partners (PRT, lifecycle agent) keep
`partner_profiles` untouched; nothing here renames PRT.

```sql
-- a) every external agent has a worker profile row
INSERT INTO agent_profiles (user_id, title, external, updated_at)
SELECT p.user_id, coalesce(nullif(p.org_name, ''), 'External agent'), true, now()
FROM partner_profiles p JOIN users u ON u.user_id = p.user_id AND u.role = 'ext:agent'
ON CONFLICT (user_id) DO NOTHING;

-- b) payout destination + share terms carried over into the profile workspace blob (never overwrite newer data)
UPDATE agent_profiles a SET
  ws = jsonb_set(coalesce(a.ws, '{}'::jsonb), '{legacyPartner}', jsonb_strip_nulls(jsonb_build_object(
    'orgName', p.org_name, 'orgType', p.org_type, 'registrationNumber', p.registration_number,
    'startingPercent', p.starting_percent, 'payoutPhone', p.payout_phone, 'payoutBankName', p.payout_bank_name,
    'payoutBankAccountLast4', right(p.payout_bank_account, 4), 'payoutAccountName', p.payout_account_name,
    'migratedAt', now()))),
  share_bps = CASE WHEN a.share_bps = 3000 AND p.starting_percent IS NOT NULL THEN p.starting_percent * 100 ELSE a.share_bps END, -- 3000 = untouched default
  work_phone = coalesce(a.work_phone, p.payout_phone)
FROM partner_profiles p JOIN users u ON u.user_id = p.user_id AND u.role = 'ext:agent'
WHERE a.user_id = p.user_id AND NOT (coalesce(a.ws, '{}'::jsonb) ? 'legacyPartner');

-- c) legacy partner documents become worker credentials (read in /work credentials); files stay where they are
UPDATE ops_records r SET data = jsonb_set(r.data, '{credentials}', coalesce(r.data->'credentials', '[]'::jsonb) || coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', d.document_id, 'title', d.original_filename, 'kind', d.kind, 'storagePath', d.storage_path,
      'status', CASE d.status WHEN 'approved' THEN 'verified' WHEN 'rejected' THEN 'rejected' ELSE 'pending' END,
      'migrated', true))
    FROM partner_documents d
    WHERE d.partner_id = r.owner_id AND d.is_active
      AND NOT (coalesce(r.data->'credentials', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('id', d.document_id)))
  ), '[]'::jsonb))
WHERE r.kind = 'work_ext' AND EXISTS (SELECT 1 FROM users u WHERE u.user_id = r.owner_id AND u.role = 'ext:agent');
```

Check before dropping anything: `SELECT count(*) FROM partner_profiles p JOIN users u USING (user_id) WHERE u.role = 'ext:agent';`
The legacy tables are not read by any module (grep `partnerProfiles`/`partnerDocuments`: schema + relations only).
Drop only after PRT confirms it does not need them: `-- DROP TABLE partner_documents; DROP TABLE partner_profiles;` (left commented).

Verified: the web `/dashboard/work` → `/work` redirect is in `web/src/proxy.ts` (`LEGACY_REDIRECTS`).

## 3. F-IAM-01 multi-role backfill (`user_roles`)

`users.role` stays the primary role; `user_roles` holds the extra ones. Move the legacy system grants across once:

```sql
INSERT INTO user_roles (user_id, role, granted_by, granted_at, expires_at)
SELECT r.id, g->>'role', g->>'grantedBy', coalesce((g->>'grantedAt')::timestamptz, now()), (g->>'expiresAt')::timestamptz
FROM system_records r, jsonb_array_elements(coalesce(r.data->'extraRoles', '[]'::jsonb)) g
WHERE r.kind = 'userMeta' AND g->>'role' IS NOT NULL
ON CONFLICT (user_id, role) DO NOTHING;
```

`auth_sessions.active_role` (nullable) needs no backfill.

## 5. Split legacy `staff:admin` (F-IAM-01)

Spec: `staff:admin` becomes `staff:service_manager` + `staff:sysadmin`. The alias in `domain/auth/roles.ts` also
granted `staff:executive`; that grant is kept as a `user_roles` row so nobody loses access on deploy (drop it by hand
where it is not wanted). Run after §3.

```sql
INSERT INTO user_roles (user_id, role, granted_by, granted_at)
SELECT u.user_id, r.role, 'migration:staff_admin_split', now()
FROM users u CROSS JOIN (VALUES ('staff:service_manager'), ('staff:executive')) AS r(role)
WHERE u.role = 'staff:admin'
ON CONFLICT (user_id, role) DO NOTHING;

UPDATE users u SET role = 'staff:sysadmin', updated_at = now()
WHERE u.role = 'staff:admin'
  AND NOT EXISTS (SELECT 1 FROM users x WHERE x.role = 'staff:sysadmin' AND (x.email = u.email OR x.phone_e164 = u.phone_e164));
-- Left over (same person already has a staff:sysadmin row; uq_users_email_role): merge by hand, then re-run.
SELECT user_id, email FROM users WHERE role = 'staff:admin';
```

Tokens issued before the deploy still say `staff:admin` and resolve through the alias until they expire (≤ 10 min
access, refresh re-reads the row). Remove the alias in the next release.

## 4. New tables / columns this session (generated by `db:generate`, listed for review)

- `client_subscriptions`: `cancel_at_period_end`, `cancel_reason`, `cancelled_at`, `reminders_sent`, `usage_warned_at`, `scheduled_plan_id`, `paused_until`; status check adds `past_due`.
- `subscription_plans`: interval check allows `year`.
- `nps_responses` (new).
- `contact_inquiries`: `status` (default `open`), `assignee_id`, `replied_at`.
- `agent_profiles`: `daily_cap`, `work_email`, `work_phone`, `social_links`.
- `user_roles` (new), `auth_sessions.active_role`.
