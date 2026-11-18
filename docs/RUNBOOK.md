# HEBUZA runbook

Processes: **web** (Next standalone, `web/Dockerfile`), **api** and **worker** (one image, `server/Dockerfile`;
default CMD `node dist/main.js`, worker `node dist/worker.js`), **migrate** (same image, `node dist/migrate.js`; also
`--target migrate`). Single-instance hosting: `WORKER_MODE=inline` runs the jobs inside the api process (no worker).
Hosting guide (Render + Vercel): `docs/DEPLOY.md`.
Backing services: Postgres 16 + pgvector (PgBouncer in transaction mode for api/worker), Redis 7 (BullMQ, rate limits,
realtime fan-out), S3-compatible storage, ClamAV, Resend (mail). Example topology: `infra/docker-compose.prod.yml`.

## Env (api + worker) — source of truth `server/src/core/config/env.ts`, validated at boot (bad env = crash, not drift)

| Var                                                                                                        | Notes                                                                                                             |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| NODE_ENV                                                                                                   | `production` in prod. Boot refuses `PAYMENTS_STUB=true` or a missing `PAYMENTS_WEBHOOK_SECRET` in production.     |
| PORT                                                                                                       | default 4000                                                                                                      |
| TRUST_PROXY                                                                                                | number of proxy hops in front of the API (default 1). Wrong value = spoofable client IP → rate limits bypassable. |
| WEB_ORIGIN                                                                                                 | comma list; CORS + CSRF Origin allow-list                                                                         |
| DATABASE_URL, DB_POOL_MAX                                                                                  | app role (RLS-bound), via PgBouncer. Migrations use a separate owner URL.                                         |
| REDIS_URL                                                                                                  |                                                                                                                   |
| JWT_PRIVATE_KEY, JWT_PUBLIC_KEY                                                                            | asymmetric PEM pair (alg in core/auth/tokens.ts); web gets only the public key                                                                |
| FIELD_KEY                                                                                                  | field-level encryption key (PII columns, TOTP secrets)                                                            |
| BLIND_INDEX_KEY                                                                                            | HMAC key for searchable blind indexes and OTP pepper                                                              |
| S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, S3_REGION                                            |                                                                                                                   |
| RESEND_API_KEY, MAIL_FROM                                                                                  | mail; unset key = mail logged, not sent                                                                           |
| SMS_PROVIDER, WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID                                              | messaging channels (optional)                                                                                     |
| ANTHROPIC_API_KEY, VOYAGE_API_KEY, AI_MODEL, AI_FAST_MODEL, AI_DAILY_TOKEN_BUDGET, AI_SESSION_TOKEN_BUDGET | assistant; budgets cap spend                                                                                      |
| TURNSTILE_SECRET_KEY                                                                                       | bot check on public forms                                                                                         |
| CLAMAV_HOST                                                                                                | upload scanning; unset in prod = uploads never leave quarantine                                                   |
| REVALIDATE_SECRET                                                                                          | ≥32 chars, shared with web                                                                                        |
| MTN_MOMO__, AIRTEL__, FLUTTERWAVE_SECRET_KEY, FLUTTERWAVE_WEBHOOK_SECRET                                   | payment gateways                                                                                                  |
| PAYMENTS_STUB                                                                                              | `false` in prod (enforced)                                                                                        |
| PAYMENTS_WEBHOOK_SECRET                                                                                    | MoMo callback HMAC (required in prod, enforced)                                                                   |
| API_PUBLIC_URL                                                                                             | public API origin for gateway callbacks / feed links                                                              |
| WORKER_MODE | `separate` (default: run `dist/worker.js`), `inline` (api also runs jobs), `off` (tests) |
| LOG_LEVEL                                                                                                  | default info                                                                                                      |

Web: `API_URL` (internal API origin), `JWT_PUBLIC_KEY`, `REVALIDATE_SECRET`, `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`
(same on every instance), build args `NEXT_PUBLIC_SITE_URL`, `DEPLOYMENT_VERSION` (git SHA). The web image is built with
`NEXT_PUBLIC_API_MOCKING=off` — MSW mocks never ship.

## Release

1. Build both images tagged with the git SHA (CI). `pnpm audit --prod` must be clean of high/critical.
2. **Migrations job**: `docker compose -f infra/docker-compose.prod.yml --profile release run --rm migrate` (= `node dist/migrate.js`;
   on Render the api's preDeployCommand) (owner role,
   direct to Postgres, not PgBouncer). Migrations are forward-only and must be backward-compatible with the running
   release (expand → deploy → contract), so a failed rollout can roll back the image without a DB rollback.
3. Roll api, worker, web (`up -d`); api readiness = `/health/ready` (db + redis). Watch 5xx and queue depth for 10 min.
4. Rollback: redeploy the previous image tag. Never `drizzle-kit drop`.

## Seed policy

`pnpm --dir server db:seed` / `db:reset` are **dev/staging only**; both throw when `NODE_ENV=production`. Seed
users have published demo passwords and a shared TOTP secret — a seeded database must never be reachable publicly.
Prod first-run: migrations only, then create the first sysadmin with a one-off
`ADMIN_EMAIL=… ADMIN_NAME=… ADMIN_PASSWORD=… node dist/admin-create.js` (dev: `pnpm admin:create`); invite the rest.

## Backups / PITR

- Managed Postgres with PITR (WAL archiving), retention ≥ 14 days; nightly logical dump (`pg_dump -Fc`) to a separate
  account/bucket, retention 35 days. Restore drill monthly: restore to a scratch instance, run `/health/ready` + a
  read-only smoke against it.
- S3 bucket: versioning on, lifecycle to expire non-current versions after 30 days; replicate to a second region.
- Redis is not a source of truth (queues are re-derivable from the outbox table); AOF on for job durability.

## Key rotation

- **JWT keys**: deploy the new public key to web + api verification first (support both during the access-token TTL), then
  switch signing; old refresh tokens die on next refresh.
- **FIELD_KEY**: requires re-encryption of encrypted columns (staff TOTP secrets, PII) by a one-off job before retiring
  the old key; plan a maintenance window.
- **BLIND_INDEX_KEY**: rotating invalidates blind indexes and pending OTPs → recompute indexes in a job; OTPs simply re-issue.
- Gateway / Resend / S3 / Anthropic keys: rotate in the provider, update the secret store, restart api + worker.
- `REVALIDATE_SECRET`, `PAYMENTS_WEBHOOK_SECRET`: update both sides (web/api; gateway callback URL) in one release.
- On suspected compromise: rotate, then revoke all sessions (`auth_sessions`/`refresh_tokens`) for affected users.

## Scaling

- **api**: stateless; scale horizontally behind the proxy (≥2). Each instance holds `DB_POOL_MAX` connections — keep
  `replicas × DB_POOL_MAX` below PgBouncer's pool. Rate limits live in Redis, so they are global across replicas.
- **worker**: scale on BullMQ queue depth/age; jobs are idempotent (outbox + idempotency keys). Crons are BullMQ job schedulers (`upsertJobScheduler`),
  keyed by name in Redis, so extra workers don't double-fire them.
- **web**: stateless; ≥2 instances, same `DEPLOYMENT_VERSION` and `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`.
- Hot spots seen in the local load probe (`server/test/load.ts`): `GET /api/services` returns the full catalogue
  (~120 KB) per call — cache it at the edge/web; chat sends to one conversation serialise on that conversation's row.

## Health checks

- api: `GET /health` (liveness, no deps), `GET /health/ready` (db + redis). Readiness gates traffic; liveness restarts.
- worker: process liveness + queue lag alert (no HTTP port).
- web: `GET /` 200 via the proxy.

## Alerts (minimum)

- api 5xx rate > 1% over 5 min; p95 latency > 1 s over 10 min.
- `/health/ready` failing on any instance > 2 min.
- BullMQ: failed jobs > 0 in `critical` queue; oldest waiting job > 5 min; outbox rows unprocessed > 5 min.
- Payment webhooks: 401 rate spike (signature failures) or reconcile failures.
- Auth: 429 spike on `/api/auth/*` (credential stuffing), lockouts per hour.
- Postgres: connections > 80% of max, replication/WAL archive lag, storage > 80%. Redis memory > 80%.
- Backup job missed; certificate expiry < 14 days.

## Tests to run against staging before go-live

`npx tsx server/test/authz/matrix.ts` (authz matrix + IDOR), `npx tsx server/test/authz/abuse.ts` (rate limits,
OTP cap, idempotency, webhook signatures, body limit, CSRF, view-as), `npx tsx server/test/load.ts`. Set `API_URL`.
They log in as seed personas, so they only run where the seed exists (never prod).
