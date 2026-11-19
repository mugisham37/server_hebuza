# Resilience drills

Run each drill on **staging** first, then quarterly in production during a announced window (maintenance mode on via
`/system/settings/maintenance` for drills 1 and 4). Record each run on `/system/ops?tab=backups` (restore drill) or as an
incident post-mortem (`/system/ops/incidents`). Targets: **RTO ≤ 4 h, RPO ≤ 24 h** for the full-loss case
(`RTO_MINUTES` in `src/domain/system/incidents.ts`); minutes for the managed-failover cases.

Before every drill: `pnpm smoke:prod` (web) passes, `/health/ready` is green, the worker heartbeat shows on `/api/status`,
and the latest backup status (`status/LATEST-<env>.json`, shown on the backups tab) is under 26 h old.

## 1. Database failover (managed Postgres primary loss)

1. Note the outbox depth: `select count(*) from outbox where sent_at is null;` and the newest `audit_log.chain_seq`.
2. Trigger the provider's failover (or restart the primary). PgBouncer reconnects; api/worker connections fail fast.
3. Expect: API 5xx/503 for < 2 min, `/health/ready` red then green; TxService retries serialization/connection errors
   (`core/db/tx.ts`). No request that returned 2xx is lost (writes commit before the response).
4. Verify: outbox drains to 0 within 5 min; `audit` daily verify (`/system/audit/integrity` → run now) reports an
   unbroken chain; a client can submit a request and pay (staging, `PAYMENTS_STUB`).
5. Pass when: total write outage < 5 min, no chain break, no duplicate payments (`payments` unique transaction ids).

## 2. Redis loss (flush or instance replacement)

Redis holds BullMQ queues, rate-limit counters, realtime streams and caches — never the source of truth.

1. `FLUSHALL` on staging Redis (or replace the instance and point `REDIS_URL` at the new one; restart api + worker).
2. Expect: realtime clients reconnect (SSE retry) and miss at most the replay buffer; rate limits reset; cron job
   schedulers are re-upserted by the worker at boot (`JobExplorer`).
3. Recover queued work: undelivered outbox rows are re-relayed automatically (`sent_at is null`). Jobs that were already
   relayed but not yet run are lost from Redis — re-drive them:
   `update outbox set sent_at = null where sent_at > now() - interval '30 minutes';` (handlers are idempotent: job ids
   derive from outbox ids, notification rows insert-on-conflict, deliveries check `dispatched`).
4. Verify: a test notification arrives (in-app + email), `/system/notifications` deliveries show `sent`, a scheduled
   cron (e.g. `notifications.digest`) appears in the next hour's logs.
5. Pass when: no lost notifications for events in the window (compare `notifications` rows vs outbox), recovery < 15 min.

## 3. Worker crash (process killed mid-job)

1. Start a long job (e.g. a report export: `/finance/reports/fin.revenue` → Export XLSX), then `kill -9` the worker.
2. Expect: `/api/status` shows the worker down within the heartbeat TTL; the API keeps serving (jobs queue up).
3. Restart the worker (Railway redeploy). BullMQ marks the stalled job and retries it (default 5 attempts, exponential
   backoff); exhausted jobs land in the failed set (`queue.dlq` log line).
4. Verify: the export completes and notifies once; the outbox drains; no duplicate notification rows (`ntf_<job id>`).
5. Pass when: work resumes without manual DB edits; dead-lettered jobs (if any) are listed and re-queued from the failed set.

## 4. Restore from the R2 backup (full loss / corruption)

Backups: `backup/backup.sh` (daily Railway cron) writes age-encrypted `pg_dump -Fc` files to R2 `hebuza-backups`
(`postgres/{daily,weekly,monthly}/…`) and `status/LATEST-<env>.json`. The private age key lives offline with two
sysadmins; it is supplied only for a restore.

1. Pick the dump: the key in `status/LATEST-<env>.json` (or an older tier for corruption that predates it).
2. Create an empty Postgres 16 + pgvector instance (staging drill: a scratch database).
3. `AGE_IDENTITY="$(cat age.key)" R2_BUCKET=hebuza-backups R2_ENDPOINT=… AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… \
   sh backup/restore.sh <key> "<target database url>"`
4. Run migrations to head (`node dist/migrate.js`); they are no-ops if the dump is current.
5. Point api + worker at the restored database (`DATABASE_URL` / `DIRECT_DATABASE_URL`), restart, keep maintenance on.
6. Verify: `/health/ready`; `/system/audit/integrity` verify passes; spot-check the newest case, invoice and payment
   against the payment gateway's dashboard; reconcile payments made after the dump time (gateway → `/finance/reconciliation/import`).
7. Production restores need the two-person approval (`/system/ops` → Restore → production creates a change request).
8. Record the drill: target, dump key, start/end time (RTO), data age (RPO), issues. Staging restore records a drill
   row automatically when run from `/system/ops`.
9. Pass when: RTO ≤ 4 h, RPO ≤ 24 h, audit chain verifies, no orphaned object-storage keys for restored documents.
