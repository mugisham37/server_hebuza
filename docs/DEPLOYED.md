# What is deployed (live record)

Updated: 2026-11-18. Plan and principles: `DEPLOYMENT-RAILWAY-CLOUDFLARE.md`.

## URLs (Railway domains; custom domain later, Phase L)

|        | Staging                                   | Production                                   |
| ------ | ----------------------------------------- | -------------------------------------------- |
| Web    | https://hebuza-web-staging.up.railway.app | https://hebuza-web-production.up.railway.app |
| API    | https://hebuza-api-staging.up.railway.app | https://hebuza-api-production.up.railway.app |
| Health | `/health/ready` (db, redis, worker)       | same                                         |
| Status | `/api/status`                             | same                                         |

## Railway: project `hebuza` (Hobby plan; Pro-ready config)

| Service   | Staging         | Production       | Notes                                                                               |
| --------- | --------------- | ---------------- | ----------------------------------------------------------------------------------- |
| Postgres  | `Postgres`      | `Postgres-3D1F`  | private only; pgvector via migration 0001 when available                            |
| PgBouncer | `PgBouncer`     | `PgBouncer-XczZ` | transaction mode, 1000 clients, pool 70, 3 replicas                                 |
| Redis     | `Redis`         | `Redis-bwbo`     | private, RDB snapshots on volume                                                    |
| ClamAV    | `clamav`        | `clamav`         | `clamav.railway.internal:3310`                                                      |
| API       | `hebuza-api`    | `hebuza-api`     | pre-deploy `node dist/migrate.js`; health `/health/ready`; overlap 20 s, drain 30 s |
| Worker    | `hebuza-worker` | `hebuza-worker`  | `node dist/worker.js`; heartbeat → API warns when down                              |
| Web       | `hebuza-web`    | `hebuza-web`     | health `/en`; `/api/*` → `http://hebuza-api.railway.internal:4000`                  |
| Backup    | `backup`        | `backup`         | cron `0 1 * * *` UTC → encrypted dump in R2                                         |

- Staging: demo seed (`client@example.test` / `Demo-pass-1`, staff personas from `src/db/seed/auth.ts`).
- Production: **reference data only** (`SEED_SCOPE=reference`: 48 services, 4 plans, CMS). There is one sysadmin; the credentials are in the owner's `~/.config/hebuza/prod-admin.txt`. Two-factor login is required on first sign-in.

## Cloudflare: account `9128c8c9…`

- R2 buckets:
  - `hebuza-files-prod`, `hebuza-files-staging`: CORS for the web origins. Lifecycle: quarantine 30 d, exports 7 d, abort multipart 1 d.
  - `hebuza-backups`: lifecycle daily 14 d / weekly 8 w / monthly 12 m; **lock 14 d on `postgres/`**; `status/LATEST-<env>.json` heartbeat.
  - `hebuza-audit`: **lock 7 years**.
- R2 tokens: one bucket-scoped token each for app-prod, app-staging, backup and audit.
- AI Gateway: `hebuza` (prod, 600 req/min) and `hebuza-staging` (120/min). Authenticated, logs on, cache 1 h.
- Turnstile widget `hebuza` (managed): both Railway web domains + localhost.

## Verified on 2026-11-18

- Staging and prod: health `ok` (db, redis, worker up); web pages 200; web→API proxy 200; status page all operational except Payments (no provider keys yet).
- Staging: demo client login; upload → presigned PUT to R2 → API download redirect.
- Prod: reference catalogue live; admin login.
- Backups ran in both environments. **Restore drill:** the prod dump decrypts with the offline age key and lists 125 tables.

## Secrets (never in git)

All secrets live in Railway variables (per environment, sealed) and in the owner's `~/.config/hebuza/` (mode 600):

- `staging|production.secrets.json`;
- `r2.json`, `ai-gateway.json`, `turnstile.json`;
- `backup-age.key`: **move it to a password manager, in 2 copies, then delete it from the disk.**

Scripts there: `set-vars.mjs` (all variables per env) and `set-config.mjs` (deploy settings per env).

## Owner to-do

1. Revoke the GitHub token that was pasted in chat.
2. Add GitHub secrets `RAILWAY_TOKEN_STAGING` and `RAILWAY_TOKEN_PRODUCTION`: Railway → project hebuza → Settings → Tokens, one per environment. `deploy.yml` uses them.
3. Delete the stray empty Railway project **"web"** (created by mistake on 2026-11-18).
4. Provide `RESEND_API_KEY` (email), `ANTHROPIC_API_KEY` (assistant) and payment sandbox keys in `~/.config/hebuza/providers.env`, then rerun `set-vars.mjs` for each environment. Until then, emails/OTP don't send and the assistant runs FAQ-only.
5. Railway Pro: enable Postgres PITR (`railway postgres pitr enable`) and raise replicas (api/web 2+). Web needs the shared Redis cache handler before it runs more than 1 replica.
6. Domain on Cloudflare: Phase L of the plan (DNS, WAF, rate limits, cache rules, origin-auth, Turnstile domain).
