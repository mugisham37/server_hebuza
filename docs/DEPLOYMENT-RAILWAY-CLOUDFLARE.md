# HEBUZA production deployment: Railway + Cloudflare

Status: **plan / reference.** Nothing here is applied yet. It covers both repos (`server_hebuza`, `web_hebuza`) and lives in the server repo because the server owns infrastructure.

Platform limits and prices change. Items marked **[verify]** must be checked against the provider dashboard or docs on the day you set them up.

---

## 0. Decisions at a glance

| Concern                                      | Decision                                                                                                                                                                                 | Why                                                                                                                                                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web (Next.js 16)                             | **Railway** service from `web/Dockerfile` (Next standalone), 2+ replicas, behind Cloudflare                                                                                              | Zero code-path risk: our app uses Node runtime features (proxy.ts, `node:crypto`, cacheComponents/PPR, server actions-free fetch to API). OpenNext-on-Workers is kept as **Option B** (§12) once proven on staging. |
| API + worker                                 | **Railway**: `hebuza-api` (HTTP, 2+ replicas) + `hebuza-worker` (1+ replicas), **one Docker image**, two start commands                                                                  | Long-lived processes (SSE, BullMQ, pg pool) suit containers, not Workers.                                                                                                                                           |
| Database                                     | **Railway PostgreSQL 16 + pgvector** with volume, private network only                                                                                                                   | Managed, same region as API, private networking (no public port).                                                                                                                                                   |
| Connection pooling                           | **PgBouncer** service on Railway (transaction mode) in front of Postgres                                                                                                                 | Many API/worker replicas × pool size would otherwise exhaust connections; code already uses `prepare:false`.                                                                                                        |
| Redis (queues, cache, rate limits, realtime) | **Railway Redis** with AOF persistence, `maxmemory-policy noeviction`                                                                                                                    | BullMQ requires noeviction; same private network.                                                                                                                                                                   |
| File storage                                 | **Cloudflare R2** (S3-compatible) replaces MinIO                                                                                                                                         | Zero egress fees, huge objects, presigned PUT straight from the browser (bypasses API and Cloudflare proxy body limits).                                                                                            |
| Edge / security                              | **Cloudflare Pro** proxy in front of everything: DNS, TLS, WAF managed rules, rate-limiting rules, bot protection, Turnstile, cache rules, DDoS                                          | One security perimeter for web and API.                                                                                                                                                                             |
| AI                                           | Anthropic through **Cloudflare AI Gateway** (logging, caching, rate limits, spend control, fallback); embeddings stay **Voyage**, with **Workers AI** as an optional cheaper alternative | One-line code change (`baseURL`).                                                                                                                                                                                   |
| Backups                                      | Nightly encrypted `pg_dump` → **R2** (off-Railway), retention tiers via R2 lifecycle, plus Railway volume backups, plus monthly restore drill                                            | Data survives a Railway account or subscription problem; a Cloudflare-side copy is always restorable elsewhere.                                                                                                     |
| Environments                                 | Railway **production**, **staging** and PR preview environments; Cloudflare zones `hebuza.rw` (prod) and `staging.hebuza.rw`                                                             | Safe releases.                                                                                                                                                                                                      |
| Region                                       | Railway **EU West (Amsterdam)** [verify available regions]; Cloudflare edge serves Rwanda from its nearest PoP                                                                           | Lowest latency to Rwanda among Railway regions; Cloudflare caching hides distance for static content.                                                                                                               |

---

## 1. Target architecture

```
                        Users (Rwanda + world)
                                 │  HTTPS
                     ┌───────────▼────────────┐
                     │ Cloudflare (Pro)       │  DNS, TLS 1.3, WAF, rate limits,
                     │ hebuza.rw              │  bot fight, Turnstile, cache rules,
                     │ api.hebuza.rw          │  AI Gateway, R2, health checks
                     └──────┬───────────┬─────┘
            proxied (orange)│           │proxied (orange)
                ┌───────────▼──┐   ┌────▼──────────────┐
  Railway       │ web (Next)   │──▶│ api (NestJS)      │◀─── mobile/partners (Bearer)
  project       │ 2+ replicas  │   │ 2+ replicas       │
  "hebuza"      │ /api/* proxy │   └──┬──────┬──────┬──┘
  (private net) └──────────────┘      │      │      │
                       ┌──────────────┘      │      └───────────────┐
                ┌──────▼─────┐        ┌──────▼─────┐        ┌───────▼──────┐
                │ PgBouncer  │        │ Redis      │        │ worker       │
                └──────┬─────┘        │ (AOF)      │◀──────▶│ 1+ replicas  │
                ┌──────▼─────┐        └────────────┘        └───────┬──────┘
                │ Postgres16 │◀──────────────────────────────────────┘
                │ + pgvector │        ┌────────────┐
                └──────┬─────┘        │ cron:      │── pg_dump ─┐
                       └──────────────│ backup     │            │
                                      └────────────┘            ▼
  Cloudflare R2:  hebuza-files (uploads, private)   hebuza-backups (encrypted dumps, bucket lock)
                  hebuza-audit (daily audit export, bucket lock)
```

Request paths:

- **Browser → web:** `https://hebuza.rw`. Next renders; `/api/*` is rewritten by the web to the API over Railway's private network (`http://hebuza-api.railway.internal:4000`), so cookies stay first-party.
- **Browser → R2:** a presigned PUT/GET straight to R2. Large files never touch Railway or the Cloudflare proxy limit.
- **Mobile/partners → API:** `https://api.hebuza.rw` with `Authorization: Bearer`.
- **SSE realtime:** browser → `hebuza.rw/api/realtime/stream` → web rewrite → API. The 25 s heartbeat stays under Cloudflare's idle timeout (100 s on the proxy). [verify the rewrite streams without buffering; if not, point the EventSource at `api.hebuza.rw` directly. The ticket auth already supports that.]

---

## 2. Railway setup

### 2.1 Project and environments

- One project `hebuza` with environments `production` and `staging`. Enable **PR environments** on staging for `web_hebuza` and `server_hebuza`.
- Region: EU West for every service and the databases (the same region is required for low-latency private networking).

### 2.2 Services

| Service         | Source                                           | Start command                         | Replicas (prod) | Resources (start)           | Health check                                   |
| --------------- | ------------------------------------------------ | ------------------------------------- | --------------- | --------------------------- | ---------------------------------------------- |
| `hebuza-api`    | GitHub `server_hebuza`, Dockerfile               | `node dist/main.js`                   | 2 (scale to N)  | 1 vCPU / 1 GB each          | `/health/ready`                                |
| `hebuza-worker` | same repo, same Dockerfile                       | `node dist/worker.js`                 | 1–2             | 1 vCPU / 1 GB               | none (no HTTP); the API's WorkerMonitor alarms |
| `hebuza-web`    | GitHub `web_hebuza`, Dockerfile                  | `node server.js` (standalone)         | 2               | 1 vCPU / 1 GB               | `/` or a lightweight `/api/health` proxy       |
| `postgres`      | Railway PostgreSQL (pgvector template/image)     | —                                     | 1 + volume      | 2 vCPU / 4 GB, 50 GB volume | Railway                                        |
| `pgbouncer`     | Railway template (edoburu/pgbouncer)             | —                                     | 1               | 0.5 vCPU / 256 MB           | TCP                                            |
| `redis`         | Railway Redis                                    | —                                     | 1 + volume      | 1 GB                        | Railway                                        |
| `backup`        | `server_hebuza`, Dockerfile target `backup` (§7) | cron `0 1 * * *` (UTC = 03:00 Kigali) | cron            | 0.5 vCPU                    | exit code                                      |

- **Pre-deploy command** on `hebuza-api`: `node dist/migrate.js`. It runs migrations once per deploy, before new replicas start; the deploy fails if migrations fail. The worker never migrates.
- **Watch paths:** api and worker redeploy on `src/**`, `package.json`, `pnpm-lock.yaml`, `Dockerfile`. Docs-only commits don't redeploy.
- **Deploy order:** api first (additive migrations), worker next, web last. Railway deploys each service independently, so keep schema changes backward-compatible (expand → migrate → contract).
- **Graceful shutdown:** Railway sends SIGTERM. The API uses `enableShutdownHooks`; the worker drains BullMQ jobs and deletes its heartbeat. Set Railway draining time to 30 s [verify setting name].
- **Private networking:** reference services by `*.railway.internal`. Postgres, Redis and PgBouncer get **no public TCP proxy** in production.
- **Serverless or sleep:** OFF for api, worker and web (SSE, crons and queues need always-on).

### 2.3 Variables (Railway shared variables + references)

Use a shared variable group `hebuza-shared` and per-service overrides. Mark secrets as sealed.

| Variable                                                                      | api         | worker | web                          | Value / source                                                                                         |
| ----------------------------------------------------------------------------- | ----------- | ------ | ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                                                                    | ✔           | ✔      | ✔                            | `production`                                                                                           |
| `DATABASE_URL`                                                                | ✔           | ✔      |                              | `postgres://…@pgbouncer.railway.internal:6432/hebuza`                                                  |
| `DIRECT_DATABASE_URL`                                                         | ✔ (migrate) |        |                              | Postgres direct; migrations need session mode, not PgBouncer transaction mode                          |
| `REDIS_URL`                                                                   | ✔           | ✔      | (✔ if web cache handler, §6) | `${{redis.REDIS_PRIVATE_URL}}`                                                                         |
| `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY`                                          | ✔ / ✔       | ✔ / ✔  | – / ✔                        | Ed25519 PEM, sealed                                                                                    |
| `FIELD_KEY`, `BLIND_INDEX_KEY`                                                | ✔           | ✔      |                              | 32-byte base64, sealed; **never rotate without the re-encrypt job** (RUNBOOK)                          |
| `WEB_ORIGIN`                                                                  | ✔           | ✔      |                              | `https://hebuza.rw,https://www.hebuza.rw`                                                              |
| `API_PUBLIC_URL`                                                              | ✔           | ✔      |                              | `https://api.hebuza.rw`                                                                                |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_REGION` | ✔           | ✔      |                              | R2: `https://<account>.r2.cloudflarestorage.com`, `hebuza-files`, R2 API token (bucket-scoped), `auto` |
| `ANTHROPIC_API_KEY`, `AI_GATEWAY_URL`                                         | ✔           | ✔      |                              | AI Gateway URL (§5.4)                                                                                  |
| `VOYAGE_API_KEY`                                                              | ✔           | ✔      |                              | optional                                                                                               |
| `RESEND_API_KEY`, `MAIL_FROM`                                                 | ✔           | ✔      |                              |                                                                                                        |
| `TURNSTILE_SECRET_KEY`                                                        | ✔           |        |                              | Cloudflare Turnstile                                                                                   |
| `PAYMENTS_*`, `MTN_MOMO_*`, `AIRTEL_*`, `FLUTTERWAVE_*`                       | ✔           | ✔      |                              | sealed; `PAYMENTS_STUB` **must not exist** in prod (the API refuses to boot)                           |
| `REVALIDATE_SECRET`                                                           | ✔           | ✔      | ✔                            | same value on both sides                                                                               |
| `WORKER_MODE`                                                                 | `separate`  |        |                              | `inline` only for single-instance staging                                                              |
| `TRUST_PROXY`                                                                 | ✔           |        |                              | hop count; see §6 code change 2                                                                        |
| `GIT_SHA`                                                                     | ✔           | ✔      | ✔                            | `${{RAILWAY_GIT_COMMIT_SHA}}` (version-mismatch warning)                                               |
| `API_URL`                                                                     |             |        | ✔                            | `http://hebuza-api.railway.internal:4000` (private)                                                    |
| `NEXT_PUBLIC_SITE_URL`                                                        |             |        | ✔                            | `https://hebuza.rw`                                                                                    |
| `BACKUP_AGE_RECIPIENT`, `R2_BACKUP_*`                                         |             |        |                              | backup service only (§7)                                                                               |

---

## 3. Cloudflare setup

### 3.1 DNS and TLS

- Zone `hebuza.rw` on Cloudflare (Pro).
- Records, all **proxied (orange)**:
  - `hebuza.rw` and `www` → Railway web custom domain (CNAME given by Railway);
  - `api` → Railway api custom domain;
  - `staging`, `api.staging` → staging services.
- SSL/TLS mode **Full (strict)**: Railway serves valid certificates on custom domains. Turn on: Always Use HTTPS, HSTS (max-age 1 year, includeSubDomains, preload after a stable month), minimum TLS 1.2, TLS 1.3, HTTP/3.
- `www` → apex redirect via a Redirect Rule.

### 3.2 Security (WAF and bots)

- **WAF managed rules:** Cloudflare Managed Ruleset + OWASP Core Ruleset (Pro includes them) on both hostnames. Start OWASP at paranoia level 1 in _log_ mode for one week, then _block_.
- **Custom rules:**
  - Block non-browser traffic to `/api/admin/*` from outside allowed countries (optional, configurable list).
  - Challenge suspicious ASNs on `/api/auth/*`.
  - Allow-list payment provider webhook source IPs on `/api/payments/webhooks/*` [verify each provider's published IPs] and skip the WAF and bot checks there (signature is verified in code).
- **Rate-limiting rules** (edge, in front of our Redis limits):
  - `/api/auth/login|signup|forgot*`: 20 req/min/IP → block 10 min;
  - `/api/*` writes: 300/min/IP;
  - `/api/assistant/*`: 30/min/IP;
  - the whole site: 2,000/min/IP → managed challenge.
- **Bot Fight Mode** (Pro: Super Bot Fight Mode) for definitely-automated traffic. Exclude `api.hebuza.rw` Bearer clients via a skip rule on the `Authorization` header present + known partner IPs.
- **Turnstile** on signup, login after failures, contact, booking and assistant start. The server already verifies tokens and fails closed in production.
- **Origin protection:** Railway origins are public URLs, so attackers could bypass Cloudflare. Mitigations:
  - **Authenticated header:** a Cloudflare Transform Rule adds `X-Origin-Auth: <secret>` on proxied requests. The API and web reject requests without it, except health checks from Railway. _Code change 3._
  - Don't publish the `*.up.railway.app` domains; disable them after custom domains work.
- **Security headers:** already set by the web (CSP report-only). Enforce CSP after a week of clean reports; add `api` CORP/COOP via the API's helmet.

### 3.3 Caching and performance

- **Cache rules:**
  - `/_next/static/*`, `/orvena/*`, `/fonts/*` → cache everything, edge TTL 1 year (immutable, hashed).
  - Public images → 30 days.
  - HTML → **bypass** (Next handles PPR/streaming; personalised pages must never be cached).
  - `api.hebuza.rw/*` → bypass, except `GET /api/services*`, `/api/platform/public-settings`, `/api/status`, `/api/content/*` → respect origin `Cache-Control` (the API caches in Redis; add `s-maxage=60` on those routes, _code change 4_).
- **Tiered Cache** on. **Argo Smart Routing** optional (paid add-on); worth it for Rwanda → Amsterdam origin latency [measure first].
- **Early Hints** on. Brotli is automatic.
- **Image optimisation:** Next `/_next/image` on Railway, cached by Cloudflare. Alternative: Cloudflare Images / Image Resizing (Pro) via a custom Next image loader (Option B).

### 3.4 R2 (object storage)

- Buckets:
  - `hebuza-files` (private): uploads, documents, deliverables, exports.
  - `hebuza-backups` (private, **bucket lock** retention 35 days minimum).
  - `hebuza-audit` (private, bucket lock 7 years for audit exports, the legal retention [verify Rwanda requirement]).
  - `hebuza-public` (optional, public via custom domain `cdn.hebuza.rw`, marketing media only).
- **CORS on `hebuza-files`:** allow `PUT, GET, HEAD` from `https://hebuza.rw`, headers `content-type`, expose `ETag`, max-age 3600. Presigned uploads need it.
- **API tokens:** one bucket-scoped token per purpose: app (`hebuza-files` read/write), backup (`hebuza-backups` write-only), audit (`hebuza-audit` write-only). Never use an account-wide key.
- **Big files:**
  - Single presigned PUT supports up to 5 GB [verify].
  - For larger files or flaky mobile networks, switch to S3 multipart presigned uploads (CreateMultipartUpload + part URLs + Complete). _Code change 5, only if business needs files over ~200 MB._ Current max is 25–50 MB by policy, so single PUT is fine.
- **Lifecycle rules:**
  - `hebuza-files/quarantine/*` delete after 30 days.
  - `exports/*` delete after 7 days.
  - Incomplete multipart uploads abort after 1 day.
- **Malware scanning:** stays in our worker (ClamAV). Deploy ClamAV as a Railway service (`clamav/clamav`, 2 GB RAM) on the private network; set `CLAMAV_HOST`. Without it, production files stay `pending` and are not downloadable (by design).

### 3.5 Health checks and status

- Cloudflare Health Checks (Pro) on `https://api.hebuza.rw/health/ready` and `https://hebuza.rw/` every 60 s from 3 regions → email/Slack notifications.
- The public status page already reads `/api/status` (db, redis, worker, queues, storage, payment config).

---

## 4. Release pipeline (CI/CD)

```
PR opened ──▶ GitHub Actions (server.yml / web.yml): typecheck, lint, tests, authz matrix, build
          └─▶ Railway PR environment (staging project) auto-deploys the branch → preview URL
merge to main ──▶ Railway staging deploy ──▶ smoke (health, login, e2e subset via Actions against staging)
manual promote ──▶ Railway production deploy (api pre-deploy migrate → api → worker → web)
```

- Railway's GitHub integration deploys on push. Enable **"Wait for CI"** so Railway only deploys commits whose GitHub checks passed [verify setting].
- Production deploys from a `production` branch or by manual promotion; the choice is in §13.
- Web contract drift: set GitHub variable `SERVER_OPENAPI_URL=https://api.staging.hebuza.rw` so `web.yml` regenerates types against staging and fails on drift.
- **Rollback:** Railway "Redeploy previous deployment" per service (one click). Migrations are forward-only and additive, so the old code runs on the new schema. Destructive schema changes ship in a later release, after the code that stopped using them.

---

## 5. Cloudflare AI and platform features worth using

### 5.1 AI Gateway (do this)

- Create gateway `hebuza`. Set Anthropic `baseURL` to `https://gateway.ai.cloudflare.com/v1/<account>/hebuza/anthropic` (_code change 1_: read `AI_GATEWAY_URL` in the assistant engine).
- Turn on: logging (PII masked by our redaction already), **caching** for identical FAQ prompts (TTL 1 h), **rate limiting** per gateway, **spend alerts**, and **fallback** to another model on 5xx.
- Our own budgets (`ai_usage`, per-session/IP/daily) stay as the authoritative limit.

### 5.2 Workers AI (optional)

- Embeddings: `@cf/baai/bge-m3` (multilingual, handles Kinyarwanda/French/English) as an alternative to Voyage. That needs an embedding provider interface (`EMBEDDINGS_PROVIDER=voyage|workers-ai`) and a dimension migration (bge-m3 = 1024 dims, same as now) [verify dims].
- Moderation/classification for chat or uploads: optional later.

### 5.3 Workers (edge code), small and targeted

- **Short links** `/r/:code`, `/c/:code` can move from Next to a Worker (KV cache of targets, async click logging to the API) for instant redirects. Optional.
- **Maintenance mode Worker:** a toggle that serves a static maintenance page while Railway is unavailable, from KV/R2. Recommended.
- Not recommended: running the API on Workers. NestJS, BullMQ, SSE and the pg pool are long-lived Node processes; that would be a rewrite.

### 5.4 Email

- Cloudflare Email Routing for inbound (`support@hebuza.rw` → team inbox).
- Outbound stays on Resend, with SPF/DKIM/DMARC records set in Cloudflare DNS.

---

## 6. Code changes required (small, all in a dedicated "deploy" PR)

| #   | Repo         | Change                                                                                                                      | Why                                                                                                |
| --- | ------------ | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | server       | `AI_GATEWAY_URL` env → Anthropic client `baseURL`                                                                           | AI Gateway                                                                                         |
| 2   | server       | Client IP from `CF-Connecting-IP` when `X-Origin-Auth` is valid, else from the socket; set Fastify `trustProxy` accordingly | Correct per-IP rate limits and audit IPs behind Cloudflare + Railway + web rewrite (two hops)      |
| 3   | server + web | `X-Origin-Auth` check (global guard in API, middleware/proxy check in web) with `ORIGIN_AUTH_SECRET`; health paths exempt   | Prevent bypassing Cloudflare via Railway URLs                                                      |
| 4   | server       | `Cache-Control: public, s-maxage=60, stale-while-revalidate=300` on public catalogue/settings/status/content GETs           | Edge caching                                                                                       |
| 5   | server + web | Optional multipart presigned upload for >200 MB                                                                             | Very big files                                                                                     |
| 6   | server       | `DIRECT_DATABASE_URL` for `migrate.ts` (bypasses PgBouncer)                                                                 | Migrations need session mode                                                                       |
| 7   | web          | Redis `cacheHandlers` (shared `"use cache"` + tag revalidation across replicas), with `REDIS_URL` on web                    | Two+ web replicas must share cache invalidation; without it, `revalidateTag` hits only one replica |
| 8   | server       | `backup` Dockerfile target + `scripts/backup.sh` (§7) and `restore.sh`                                                      | Backups                                                                                            |
| 9   | server       | Daily audit export job → `hebuza-audit` (JSONL.gz of yesterday's `audit_log` with chain hashes)                             | Immutable audit trail outside the DB                                                               |
| 10  | server       | Storage: `S3_REGION=auto`, path-style off for R2 (keep config-driven)                                                       | R2 compatibility                                                                                   |
| 11  | web          | `output: "standalone"` (already), `inlineCss` off (done), image < 300 MB confirmed                                          | Fast deploys                                                                                       |
| 12  | both         | Sentry SDK (errors + traces), `SENTRY_DSN`                                                                                  | Observability (§9)                                                                                 |

---

## 7. Backup and disaster recovery

### 7.1 What is backed up

| Data                         | Primary                                 | Backup                                                                                                                        | RPO                       | RTO            |
| ---------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------- |
| Postgres (all business data) | Railway volume                          | ① Railway volume backups (daily, in Railway) ② **nightly encrypted `pg_dump` → R2** ③ optional WAL archiving (§7.4)           | 24 h (① ②), ~5 min with ③ | 1–2 h          |
| Uploaded files               | R2 `hebuza-files` (11-nines durability) | Weekly `rclone` copy of new objects → `hebuza-backups/files/` (or a second R2 account / other provider for full independence) | 7 days                    | 4 h            |
| Audit log                    | Postgres (hash chain)                   | Daily JSONL export → `hebuza-audit` (bucket lock)                                                                             | 24 h                      | n/a (evidence) |
| Redis                        | Railway volume (AOF)                    | none needed: jobs re-derive from the outbox; caches rebuild                                                                   | —                         | minutes        |
| Secrets                      | Railway / Cloudflare                    | Encrypted export in a password manager (1Password/Bitwarden), owner + backup owner                                            | —                         | —              |
| Code                         | GitHub                                  | Clone mirror (optional)                                                                                                       | —                         | —              |

### 7.2 Nightly Postgres backup job (Railway cron service `backup`)

```bash
#!/bin/sh
# 01:00 UTC daily. Dumps over the private network, encrypts with age (public key only on the server), uploads to R2.
set -eu
TS=$(date -u +%Y-%m-%dT%H%M%SZ)
DAY=$(date -u +%d); DOW=$(date -u +%u)
TIER=daily; [ "$DOW" = 7 ] && TIER=weekly; [ "$DAY" = 01 ] && TIER=monthly
pg_dump "$DIRECT_DATABASE_URL" --format=custom --no-owner --compress=9 \
  | age -r "$BACKUP_AGE_RECIPIENT" \
  | aws s3 cp - "s3://hebuza-backups/postgres/$TIER/hebuza-$TS.dump.age" \
      --endpoint-url "$R2_ENDPOINT" --only-show-errors
# integrity marker + size for monitoring
echo "{\"at\":\"$TS\",\"tier\":\"$TIER\"}" | aws s3 cp - "s3://hebuza-backups/postgres/LATEST.json" --endpoint-url "$R2_ENDPOINT"
```

- **Encryption:** `age` with a key pair. The **private key is NOT on Railway or Cloudflare**; it lives in the password manager, in 2 copies held by 2 people. A compromise of either platform can't read backups.
- **Monitoring:** if `LATEST.json` is older than 26 h, alert (Cloudflare Worker cron or Better Stack heartbeat URL pinged by the job).

### 7.3 Retention (R2 lifecycle + bucket lock), "keep, then forget"

| Prefix                          | Keep            | Then                                           |
| ------------------------------- | --------------- | ---------------------------------------------- |
| `postgres/daily/`               | 14 days         | auto-delete                                    |
| `postgres/weekly/`              | 8 weeks         | auto-delete                                    |
| `postgres/monthly/`             | 12 months       | auto-delete                                    |
| `files/` snapshot               | 30 days         | auto-delete                                    |
| bucket lock on `hebuza-backups` | 14 days minimum | prevents deletion even with leaked credentials |

Storage stays bounded (about 14 + 8 + 12 = 34 dumps). Old data is forgotten automatically, as you wanted, while a compromised token can't wipe recent backups.

### 7.4 Point-in-time recovery (optional, when data is critical)

- WAL-G sidecar on Postgres archiving WAL to R2 (`hebuza-backups/wal/`) gives restore to any second. This needs a custom Postgres image on Railway instead of the template. Add it when revenue or legal exposure justifies it.

### 7.5 Restore drills (monthly, mandatory)

1. Download the latest dump from R2, then `age -d -i key.txt | pg_restore` into a throwaway Railway staging Postgres.
2. Run migrations (no-op), boot staging API against it, run the e2e smoke and the audit-chain verify endpoint.
3. Record the time taken (RTO) and the dump age (RPO) in `docs/RUNBOOK.md`.

### 7.6 Platform-loss scenarios

| Scenario                                      | Plan                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Railway subscription lapses or account locked | Backups are in **Cloudflare R2** (separate billing). Recreate on Railway (new account), on any Docker host, or temporarily with `infra/docker-compose.prod.yml` on a VPS. Restore the latest dump, point DNS (Cloudflare) to the new origin. Target RTO 4 h.                                                                                        |
| Cloudflare lapses                             | Files and backups at risk. Mitigation: monthly `rclone sync` of `hebuza-backups` to a **second provider** (Backblaze B2 or an AWS S3 Glacier deep-archive bucket, a few cents). DNS can move to another provider; the apps don't depend on Cloudflare APIs except R2 and AI Gateway (both config-swappable: `S3_ENDPOINT`, `AI_GATEWAY_URL` unset). |
| Region outage (Railway EU West)               | Restore into another Railway region from R2 (RTO hours). Multi-region active setup is out of scope until scale demands it.                                                                                                                                                                                                                          |
| Bad migration or data corruption              | Railway volume backup or the nightly dump (or PITR if §7.4) into a new DB; promote; app redeploy.                                                                                                                                                                                                                                                   |
| Secret leak                                   | Rotation procedures in RUNBOOK. JWT keys rotate with kid; webhook secrets at provider; R2 tokens revoke and reissue. `FIELD_KEY` rotation needs the re-encrypt job.                                                                                                                                                                                 |

- **Billing safety:** set both platforms to auto-pay with a backup card, budget alerts at 50/80/100%, and **two owners** on each account.

---

## 8. Security checklist (production)

- [ ] Cloudflare Full (strict), HSTS, WAF managed + OWASP, rate limits, Super Bot Fight Mode, Turnstile on sensitive forms
- [ ] Origin-auth header enforced; `*.up.railway.app` domains disabled
- [ ] Postgres, Redis and PgBouncer: private network only, strong generated passwords, no public proxy
- [ ] Postgres least privilege: the app connects as a non-superuser role that owns the tables (RLS enforced); migrations use a separate role; the backup uses a read-only role
- [ ] All secrets sealed in Railway; `PAYMENTS_STUB` absent; `NODE_ENV=production`
- [ ] Sysadmin created with `pnpm admin:create` (one-off), 2FA enforced on first login; no seed in prod
- [ ] R2 bucket-scoped tokens; backups encrypted with an offline key; bucket locks on
- [ ] CSP enforced after report-only week; `X-Frame-Options DENY` (set)
- [ ] Dependabot/Renovate on both repos; `pnpm audit` in CI; GitHub secret scanning + push protection on
- [ ] Branch protection on `main` (PR + green CI required); 2FA on GitHub, Railway, Cloudflare for all members
- [ ] Authz matrix (`test/authz`) runs in CI against staging before each production promotion
- [ ] Data protection: retention jobs on (compliance module); DSAR export/delete tested; Rwanda data-protection registration [verify obligations: Law 058/2021, NCSA]

---

## 9. Observability and alerting

| Signal            | Tool                                                                            | Alert                                              |
| ----------------- | ------------------------------------------------------------------------------- | -------------------------------------------------- |
| Errors and traces | **Sentry** (API, worker, web), OpenTelemetry already in code paths              | new issue, error-rate spike                        |
| Logs              | Railway log explorer (JSON pino); optional drain to Better Stack / Grafana Loki | —                                                  |
| Metrics           | Railway CPU/RAM/network per service                                             | CPU > 80% for 10 min, memory > 85%                 |
| Uptime            | Cloudflare Health Checks + Better Stack heartbeat (backup job)                  | down 2 checks; backup older than 26 h              |
| Worker health     | API logs `worker offline` + `/health/ready` `degraded` + staff banner           | log-based alert on `worker offline`                |
| Queues            | `/api/status` backlog/failed counts                                             | backlog > 1,000 or failed > 50/h                   |
| AI spend          | AI Gateway analytics + `ai_usage`                                               | 80% of monthly cap                                 |
| Security          | Cloudflare Security Events, WAF analytics                                       | spikes in blocks; webhook signature failures (log) |

---

## 10. Capacity and scaling

- **Start (pilot, <5k users):** web 2×(1 vCPU/1 GB), api 2×(1/1), worker 1×(1/1), Postgres 2 vCPU/4 GB, Redis 1 GB, PgBouncer pool 25.
- **Growth (≈50k users):** web 3–4, api 4–6, worker 2–3 (queue concurrency up), Postgres 4–8 vCPU/16 GB plus a read replica for reports (reports module already marked for replica), Redis 2–4 GB.
- **Hot spots known from load tests:** `/api/services` (120 KB, CPU-bound) is solved by edge cache (§6 #4). Chat sends serialize per conversation (by design); no action needed.
- **Connection math:** (api replicas × pool + worker replicas × pool) ≤ PgBouncer `max_client_conn`; Postgres `max_connections` ≥ PgBouncer pool + admin headroom.
- **Big documents:** presigned PUT straight to R2, so API and proxy limits don't apply. Server-side processing (scan, EXIF strip, PDF) runs in the worker with memory headroom (scale the worker to 2 GB if PDFs are large).

---

## 11. Cost outline (monthly, rough, [verify current pricing])

| Item                                                            | Estimate                               |
| --------------------------------------------------------------- | -------------------------------------- |
| Railway Pro (usage-based: ~9 vCPU, ~12 GB RAM steady + volumes) | $60–150                                |
| Cloudflare Pro (hebuza.rw)                                      | $20–25                                 |
| R2 (100 GB files + backups, zero egress)                        | $2–5                                   |
| AI Gateway                                                      | included; model cost = Anthropic usage |
| Second-provider backup copy (B2)                                | <$2                                    |
| Sentry / Better Stack (free → team tiers)                       | $0–50                                  |

---

## 12. Option B: web on Cloudflare Workers (later)

Deploy Next.js to Workers with **OpenNext for Cloudflare** (`@opennextjs/cloudflare`):

- incremental cache in R2, tag cache in D1 or Durable Objects, revalidation queue on Cloudflare Queues;
- `nodejs_compat` flag for `node:crypto` (jose, HMAC in the revalidate hook).
- **Benefits:** global edge rendering (lower latency in Rwanda), no web replicas to manage, scales to zero.
- **Risks to validate on staging first:** Next 16 features we use (`cacheComponents`/PPR, `proxy.ts`, React Compiler, rewrites streaming SSE), bundle size limits per Worker, `sharp` (use Cloudflare Images instead).
- **Code changes:** OpenNext config, a custom image loader, and the `/api/*` rewrite to `https://api.hebuza.rw` with the origin-auth header.
- **Decision rule:** move when a staging build passes the full e2e suite on Workers. Until then, Railway web is the default.

---

## 13. Go-live runbook (ordered)

1. **Accounts:** Railway team (2 owners, 2FA), Cloudflare (2 owners, 2FA), GitHub org with both repos, branch protection.
2. **Cloudflare:** add zone `hebuza.rw`, move nameservers, TLS Full (strict), HSTS (no preload yet), WAF in log mode, create the 3–4 R2 buckets + CORS + lifecycle + bucket locks + scoped tokens, AI Gateway `hebuza`, Turnstile site keys.
3. **Code PR "deploy":** implement §6 #1–4, 6–10 (and 12); merge after CI and staging verify.
4. **Railway staging:** Postgres(pgvector) + PgBouncer + Redis(noeviction, AOF) + ClamAV + api + worker + web + backup cron; variables (§2.3); custom domains `staging.hebuza.rw`, `api.staging.hebuza.rw`; seed **staging only**; run e2e + authz matrix against staging.
5. **Backups:** generate the age keypair offline; store the private key in the password manager (2 people); run the backup job manually once; do a restore drill into a scratch DB (§7.5).
6. **Railway production:** clone the staging environment config, new secrets (never reuse staging keys), no seed. Pre-deploy migrate; `pnpm admin:create` once.
7. **DNS cutover:** point `hebuza.rw` / `api` records to the Railway production domains (proxied); enable origin-auth enforcement; disable Railway public domains.
8. **Verify:** health checks green, login, client apply + upload (R2), payment in provider sandbox → live after sign-off, worker banner absent, `/api/status` all operational, backup ran at 01:00 UTC.
9. **Harden after 1 week:** WAF OWASP → block, CSP enforce, HSTS preload, rate-limit thresholds tuned from analytics.
10. **Recurring:** monthly restore drill, quarterly key rotation review, dependency updates weekly, cost review monthly.

---

## 14. Open decisions for the owner

- Production promotion: manual promote (recommended) or a `production` branch?
- Argo Smart Routing: measure Kigali → Amsterdam latency first.
- WAL-G PITR now or later (§7.4)?
- Second-provider backup copy: Backblaze B2 (recommended), or none?
- Embeddings: keep Voyage, or move to Workers AI bge-m3?
- Audit log retention period (legal requirement in Rwanda to confirm).
