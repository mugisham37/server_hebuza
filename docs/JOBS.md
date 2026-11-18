# Background jobs & crons (worker spec)

Extracted from the removed in-app backend (git tag `backend-in-next-final`, `src/server/modules/*.jobs.ts`). The new worker service must cover each of these.

## assistant
> P12 assistant background work (pg-boss): KB reindex (chunk → ai_kb_chunks), nightly retention purge and draft
> expiry, the weekly eval run, and a daily stale-source sweep (review_by passed → stale, flagged for re-review).
- **Job** `assistant.reindex` 
- **Cron** `assistant.retention` 30 2 * * *
- **Cron** `assistant.stale` 0 6 * * *
- **Cron** `assistant.evals.weekly` 0 5 * * 1

## auth
> Nightly auth housekeeping: expired/revoked refresh tokens, used/expired reset links, dead sessions, stale devices,
> login_attempts older than 90 days. Registered by importing this file from src/server/jobs.ts.
- **Cron** `auth.cleanup` 15 3 * * *

## booking
> P12 booking background work (pg-boss): notifications (confirm/reschedule/cancel/manage link/next steps),
> the minute sweep (auto no-show, lapsed holds → waitlist offers), due reminders and refund hand-off to finance.
> Email goes through core/email (logged, never sent, without RESEND_API_KEY).
> shortcut: SMS/WhatsApp channels are logged only, wire the SMS/WhatsApp provider when its keys exist.
- **Cron** `booking.sweep` * * * * *
- **Cron** `booking.reminders` */5 * * * *

## cms
> CMS cron: publish due scheduled variants and mark overdue regulatory updates stale, then drop the public cache.
> revalidateTag only works inside a request, so the job calls the app's own /hooks/revalidate (same process/host).
- **Cron** `cms.sweep-schedule` * * * * *

## deadlines
- **Cron** `deadlines_daily` 0 7 * * *

## documents
> process_attachment (EXIF strip + thumbnail via sharp) and the daily orphan clean-up (Python run_orphan_cleanup).
- **Job** `process_attachment` 
- **Cron** `cleanup_orphan_documents` 30 3 * * *

## field
> Field background work (pg-boss): signed custody receipt PDFs, scan page → PDF assembly, 48 h cash escalation.
- **Job** `field.receipt.pdf` 
- **Job** `field.scan.assemble` 
- **Cron** `field.cash.escalate` 0 * * * *

## finance
> Finance background work (pg-boss). Imported once from src/server/jobs.ts.
- **Job** `finance.refund.disburse` 
- **Cron** `finance.refunds.sweep` */5 * * * *
- **Cron** `finance.payments.sweep` */5 * * * *
- **Cron** `finance.settings.apply` 5 0 * * *

## marketing
> P11 marketing jobs: campaign send tick, sequence runner, conversion + referral sweeps, contact sync, link check,
> lead retention purge. Delivery: email through the Resend job (logged when RESEND_API_KEY is empty); WhatsApp through
> the Cloud API only when WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID are set; SMS is logged (no provider yet).
- **Cron** `mkt.campaign-send` * * * * *
- **Cron** `mkt.sequence-run` */5 * * * *
- **Cron** `mkt.conversion-sweep` */15 * * * *
- **Cron** `mkt.contact-sync` 17 * * * *
- **Cron** `mkt.link-check` 30 3 * * *
- **Cron** `mkt.lead-retention` 45 2 * * *

## notifications
- **Cron** `notifications_digest` 5 * * * *

## ops
> P5 ops crons: offer expiry (return the case to the queue), SLA breach stamping (port of chat/sla.py + the
> applications SLA sweep), and auto-assign of new intake per service rules.
- **Cron** `ops_offer_expiry` */5 * * * *
- **Cron** `ops_sla_sweep` */10 * * * *
- **Cron** `ops_auto_assign` */5 * * * *

## payments
> Payment and subscription background work (pg-boss). Imported once from src/server/jobs.ts.
- **Job** `payments.reconcile` 
- **Cron** `payments.reconcile-sweep` */5 * * * *
- **Cron** `subscriptions.expire` 15 0 * * *

## procurement
> Procurement crons (P7): daily obligations sweep and monthly recurring contract bill drafts (R-14).
- **Cron** `procurement_daily` 0 7 * * *
- **Cron** `procurement_recurring_bills` 0 6 20 * *

## reports
> Report export jobs (pg-boss). Imported once from src/server/jobs.ts.
- **Job** `reports.export` 

## system
> P10 crons: approvals/invites/break-glass/review sweep (every minute), nightly audit-chain verification (alerts the
> console on a broken link), quarterly access-review campaign, nightly retention due counts, impersonation expiry.
- **Cron** `system_sweep` * * * * *
- **Cron** `system_audit_verify` 30 2 * * *
- **Cron** `system_access_review` 0 6 1 1,4,7,10 *
- **Cron** `system_retention_due` 0 3 * * *

## work
> P9 external-agent crons (pg-boss): monthly licence invoices + overdue marking, daily credential expiry sweep.
- **Cron** `work.licence.monthly` 0 6 21 * *
- **Cron** `work.credentials.sweep` 30 2 * * *

