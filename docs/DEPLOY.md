# Deploying HEBUZA

Server (api + worker + migrations) on **Render** via the Blueprint `render.yaml`; web on **Vercel** (or Render).
Operations (backups, alerts, key rotation, scaling): `docs/RUNBOOK.md`.

```
browser ──► web (Vercel, hebuza.rw) ──/api/* rewrite──► hebuza-api (Render, api.hebuza.rw)
                                                          │            ▲
                                        Postgres (pgvector) + Key Value (Redis) ◄── hebuza-worker
```

## 1. Server on Render (Blueprint)

Dashboard → New → Blueprint → this repo. `render.yaml` creates:

| Resource        | Type              | Notes                                                                               |
| --------------- | ----------------- | ----------------------------------------------------------------------------------- |
| `hebuza-api`    | web service       | Docker, `rootDir: server`, health check `/health`, preDeploy `node dist/migrate.js` |
| `hebuza-worker` | background worker | same Dockerfile, `dockerCommand: node --enable-source-maps dist/worker.js`          |
| `hebuza-redis`  | Key Value         | `maxmemoryPolicy: noeviction` (BullMQ), private network only                        |
| `hebuza-db`     | Postgres 16       | private network only; PITR on paid plans                                            |
| `hebuza-server` | env group         | shared by api + worker                                                              |

- **pgvector**: migration `0001_audit_chain_pgvector.sql` runs `CREATE EXTENSION vector`; Render Postgres supports it and
  the Blueprint's DB user owns the database, so nothing manual is needed. If it fails, run `CREATE EXTENSION vector;`
  once via `psql` (External/Shell connection) and redeploy.
- **Migrations**: `preDeployCommand` runs before every api deploy; a failure aborts the deploy and the old release keeps
  serving. Migrations must be expand-only (RUNBOOK §Release). The worker deploys independently; it never migrates.
- `PORT` is injected by Render (10000); the api reads it. `TRUST_PROXY=1` counts Render's proxy. When the browser goes
  through Vercel's `/api` rewrite there is one more hop: set `TRUST_PROXY=2` and verify `req.ip` once in logs.
- Region: all four resources in the same region (`frankfurt`) so they share the private network.

### Env vars (source of truth `server/src/core/config/env.ts`)

| Var                                                           | Required | Secret       | Render source                                                                         |
| ------------------------------------------------------------- | -------- | ------------ | ------------------------------------------------------------------------------------- |
| NODE_ENV                                                      | yes      |              | `production`                                                                          |
| PORT                                                          |          |              | Render                                                                                |
| TRUST_PROXY                                                   |          |              | `1` (`2` behind Vercel rewrite)                                                       |
| WEB_ORIGIN                                                    | yes      |              | web origin(s), comma list, e.g. `https://hebuza.rw,https://www.hebuza.rw`             |
| API_PUBLIC_URL                                                |          |              | `https://api.hebuza.rw` (gateway callbacks, feed links)                               |
| DATABASE_URL                                                  | yes      | yes          | `fromDatabase` hebuza-db                                                              |
| DB_POOL_MAX                                                   |          |              | default 10; keep `instances × pool` < DB connection limit                             |
| REDIS_URL                                                     | yes      | yes          | `fromService` hebuza-redis                                                            |
| JWT_PRIVATE_KEY / JWT_PUBLIC_KEY                              | yes      | private: yes | Ed25519 PEM pair (below); public key also on web                                      |
| FIELD_KEY                                                     | yes      | yes          | `generateValue` (32-byte base64) — **back it up**, losing it loses encrypted PII/TOTP |
| BLIND_INDEX_KEY                                               | yes      | yes          | `generateValue` — back it up                                                          |
| PAYMENTS_WEBHOOK_SECRET                                       | prod     | yes          | `generateValue`                                                                       |
| PAYMENTS_STUB                                                 |          |              | `false` (boot refuses `true` in production)                                           |
| REVALIDATE_SECRET                                             |          | yes          | ≥32 chars, same value on web                                                          |
| S3_ENDPOINT, S3_BUCKET, S3_REGION                             | yes      |              | external S3/R2 (Render has no object storage)                                         |
| S3_ACCESS_KEY, S3_SECRET_KEY                                  | yes      | yes          |                                                                                       |
| MAIL_FROM                                                     | yes      |              |                                                                                       |
| RESEND_API_KEY                                                |          | yes          | unset = mail logged only                                                              |
| ANTHROPIC_API_KEY, VOYAGE_API_KEY                             |          | yes          | assistant; `AI_*` budgets have defaults                                               |
| TURNSTILE_SECRET_KEY                                          |          | yes          |                                                                                       |
| CLAMAV_HOST                                                   |          |              | unset = uploads stay quarantined (run ClamAV as a private service if needed)          |
| MTN_MOMO__, AIRTEL__, FLUTTERWAVE_*                           |          | yes          | add per gateway when going live                                                       |
| SMS_PROVIDER, WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID |          | token: yes   | optional                                                                              |
| WORKER_MODE                                                   |          |              | `separate` (default) / `inline` (below)                                               |
| LOG_LEVEL                                                     |          |              | `info`                                                                                |

`sync: false` vars are prompted once when the Blueprint is applied. JWT keys:

```bash
openssl genpkey -algorithm ed25519 -out jwt.pem && openssl pkey -in jwt.pem -pubout -out jwt.pub
```

Paste the PEM text as-is (multi-line is fine; `\n`-escaped also works). Never commit them.

### Single-instance option (cheaper)

Delete `hebuza-worker` from `render.yaml` and set `WORKER_MODE=inline` on `hebuza-api`: the api process also runs the
queues and crons. Fine for low traffic; split again before scaling the api past one instance.

## 2. Web on Vercel

New Project → import repo → **Root Directory `web/`** (framework Next.js, `pnpm` detected from the lockfile).

| Var                                                                      | Secret | Notes                                                                                       |
| ------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------- |
| API_URL                                                                  |        | `https://hebuza-api.onrender.com` (or `https://api.hebuza.rw`); `/api/*` is rewritten there |
| JWT_PUBLIC_KEY                                                           |        | same public PEM as the api                                                                  |
| REVALIDATE_SECRET                                                        | yes    | same as the api                                                                             |
| NEXT_SERVER_ACTIONS_ENCRYPTION_KEY                                       | yes    | `openssl rand -base64 32`; same on every deployment                                         |
| NEXT_PUBLIC_SITE_URL                                                     |        | `https://hebuza.rw` (build-time)                                                            |
| NEXT_PUBLIC_API_MOCKING                                                  |        | `off` (default when `API_URL` is set)                                                       |
| NEXT_PUBLIC_APP_ENV, NEXT_PUBLIC_APP_VERSION                             |        | e.g. `production`, git SHA                                                                  |
| NEXT_PUBLIC_GA4_ID, NEXT_PUBLIC_META_PIXEL_ID, NEXT_PUBLIC_TELEMETRY_URL |        | optional                                                                                    |

`NEXT_PUBLIC_*` are baked at build time: change → redeploy.

### Alternative: web on Render too

Add to `render.yaml`:

```yaml
- type: web
  name: hebuza-web
  runtime: docker
  rootDir: web
  dockerfilePath: ./Dockerfile
  dockerContext: .
  region: frankfurt
  plan: starter
  healthCheckPath: /
  envVars:
    - key: API_URL
      fromService: { type: web, name: hebuza-api, property: hostport } # private network: set to http://<hostport>
    - { key: JWT_PUBLIC_KEY, sync: false }
    - { key: REVALIDATE_SECRET, sync: false }
    - { key: NEXT_SERVER_ACTIONS_ENCRYPTION_KEY, generateValue: true }
```

`API_URL` needs a scheme: easiest is to set it by hand to `http://hebuza-api:10000` (private network). Build-time
`NEXT_PUBLIC_SITE_URL` goes in as a Docker build arg (Render passes env vars as build args to Docker builds).

## 3. Domains and cookies

- `hebuza.rw` (+ `www`) → Vercel; `api.hebuza.rw` → Render (Settings → Custom Domains; CNAME/ALIAS as shown there).
- **Default (proxy)**: the browser only talks to `hebuza.rw`; `/api/*` is rewritten to the api, so session cookies are
  host-only first-party on the web origin. Nothing extra to configure. `WEB_ORIGIN` must list the web origin(s).
- **Option `Domain=.hebuza.rw`** (browser calls `api.hebuza.rw` directly): not implemented — cookies are host-only
  (`server/src/core/auth/cookies.ts`). It would need a cookie `domain` setting plus CORS credentials; stay on the proxy
  unless the extra Vercel hop becomes a problem.

## 4. First deploy checklist

1. Generate JWT keys; apply the Blueprint; fill the `sync: false` vars. Back up `FIELD_KEY` / `BLIND_INDEX_KEY` offline.
2. Watch the api deploy: preDeploy logs `migrations applied`, then `/health` turns green; `GET /health/ready` = 200.
3. **Never seed production** (`db:seed` refuses `NODE_ENV=production`). Create the first sysadmin in the api Shell:
   `ADMIN_EMAIL=you@hebuza.rw ADMIN_NAME="Your Name" ADMIN_PASSWORD='…' node dist/admin-create.js`
   (12+ chars, upper/lower/digit/symbol; TOTP enrolment at first sign-in). Invite everyone else from the app.
4. Deploy web on Vercel with `API_URL` pointing at the api; sign in; check worker logs show jobs/crons running.
5. Add custom domains, then update `WEB_ORIGIN`, `API_PUBLIC_URL`, `NEXT_PUBLIC_SITE_URL` and redeploy both.
6. Run the RUNBOOK alerts/backups items (PITR, S3 versioning) before taking real traffic.

## 5. Rollback

- Render: service → Events → previous deploy → **Rollback** (api and worker separately). Migrations are not reverted;
  they are backward-compatible by policy, so the previous image runs against the new schema.
- Vercel: Deployments → previous → **Promote to Production** (instant).
- Bad migration: fix forward with a new migration; restore from PITR only for data loss.

## 6. Secrets rotation

See `docs/RUNBOOK.md` §Key rotation (JWT two-phase, `FIELD_KEY` re-encryption job, shared secrets updated on both
sides in one release). On Render update the `hebuza-server` env group (redeploys api + worker); on Vercel update and
redeploy.
