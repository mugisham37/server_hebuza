# Keys and secrets

Every variable the API/worker reads (source of truth: `src/core/config/env.ts`; blank template: `server/.env.example`) and
the web's. **Where** = how to obtain it. Secrets go in Railway variables (shared by `hebuza-api` + `hebuza-worker`) and
GitHub environment secrets, never in git. Rotation: `docs/RUNBOOK.md`.

## Server — core

| Key | Required | Where |
| --- | --- | --- |
| `NODE_ENV` | yes | `production` on staging and production images |
| `PORT` | | injected by Railway |
| `WEB_ORIGIN` | yes | web origin(s), comma list: `https://hebuza.rw,https://www.hebuza.rw` |
| `API_PUBLIC_URL` | prod | public API origin, `https://api.hebuza.rw` — gateway callbacks and calendar feeds are built from it |
| `DATABASE_URL`, `DB_POOL_MAX` | yes | Railway Postgres reference variable (`${{Postgres.DATABASE_URL}}`) |
| `DIRECT_DATABASE_URL` | | migrations only, when a pooler sits in front |
| `REDIS_URL` | yes | Railway Redis reference variable |
| `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` | yes | generate: `openssl genpkey -algorithm ed25519 -out jwt.pem && openssl pkey -in jwt.pem -pubout`; the web needs the public key too |
| `FIELD_KEY` | yes | 32 random bytes, base64 (`openssl rand -base64 32`); encrypts PII columns — losing it loses data |
| `BLIND_INDEX_KEY` | yes | 32 random bytes, base64; separate from `FIELD_KEY` |
| `ORIGIN_AUTH_SECRET` | | ≥ 32 chars, same value in the Cloudflare Transform Rule header `x-origin-auth` and the web |
| `RATE_LIMIT_FACTOR` | | staging test runs only (forced to 1 in production) |
| `WORKER_MODE` | | `separate` (default), `inline`, `off` |
| `LOG_LEVEL`, `GIT_SHA` | | ops |
| `SENTRY_DSN` | | sentry.io → project → Client Keys (DSN) |

## Storage (Cloudflare R2, S3 API)

| Key | Where |
| --- | --- |
| `S3_ENDPOINT` | R2 → Overview: `https://<account>.r2.cloudflarestorage.com` |
| `S3_BUCKET`, `S3_REGION` | bucket `hebuza-files`; region `auto` (or `us-east-1`) |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | R2 → Manage API tokens → Object Read & Write, scoped to the bucket |
| `AUDIT_S3_BUCKET`, `AUDIT_S3_ACCESS_KEY`, `AUDIT_S3_SECRET_KEY` | locked audit bucket; write-only token scoped to it |
| `BACKUP_STATUS_ENDPOINT`, `BACKUP_STATUS_BUCKET`, `BACKUP_STATUS_ACCESS_KEY`, `BACKUP_STATUS_SECRET_KEY`, `BACKUP_STATUS_ENV` | read-only token on the backup bucket (`server/backup/backup.sh` writes `status/LATEST-<env>.json`) |
| `CLAMAV_HOST` | host:port of the ClamAV service (Railway private network) |

## Messaging

| Key | Where |
| --- | --- |
| `RESEND_API_KEY` | resend.com → API Keys (sending access, domain `hebuza.rw` verified) |
| `MAIL_FROM` | e.g. `HEBUZA <noreply@hebuza.rw>` — the domain must be verified in Resend |
| `RESEND_WEBHOOK_SECRET` | Resend → Webhooks → signing secret `whsec_…` |
| `SMS_PROVIDER` | `africastalking` to enable SMS |
| `AT_USERNAME`, `AT_API_KEY`, `AT_SENDER_ID` | account.africastalking.com → Settings → API Key; sender ID approved per country (`sandbox` username for tests) |
| `NOTIFY_WEBHOOK_TOKEN` | ≥ 24 random chars (`openssl rand -hex 24`); appears in the provider webhook URLs below |
| `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | Meta Business → WhatsApp → API Setup (permanent system-user token) |

## Payments

| Key | Where |
| --- | --- |
| `MTN_MOMO_SUBSCRIPTION_KEY` | momodeveloper.mtn.com → Collections product → primary key (production: MTN Rwanda go-live) |
| `MTN_MOMO_API_USER`, `MTN_MOMO_API_KEY` | created against the subscription key (sandbox: provisioning API; production: MTN partner portal) |
| `MTN_MOMO_TARGET_ENVIRONMENT` | `sandbox` or the production target given by MTN (`mtnrwanda`) |
| `AIRTEL_CLIENT_ID`, `AIRTEL_CLIENT_SECRET`, `AIRTEL_BASE_URL` | developers.airtel.africa → application keys; base URL per environment |
| `FLUTTERWAVE_SECRET_KEY` | Flutterwave dashboard → Settings → API keys |
| `FLUTTERWAVE_WEBHOOK_SECRET` | Flutterwave → Settings → Webhooks → secret hash (sent as `verif-hash`) |
| `PAYMENTS_WEBHOOK_SECRET` | random ≥ 32 chars; signs the MoMo callback URL (`?sig=`). Required in production |
| `PAYMENTS_STUB` | `true` only in dev; production refuses to boot with it |

## AI

| Key | Where |
| --- | --- |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `AI_GATEWAY_URL`, `AI_GATEWAY_TOKEN` | Cloudflare → AI → AI Gateway: `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>` + its token |
| `VOYAGE_API_KEY` | dash.voyageai.com (embeddings; unset → full-text retrieval) |
| `AI_MODEL`, `AI_FAST_MODEL`, `AI_DAILY_TOKEN_BUDGET`, `AI_SESSION_TOKEN_BUDGET` | defaults in env.ts |

## Security / web integration

| Key | Where |
| --- | --- |
| `TURNSTILE_SECRET_KEY` | Cloudflare → Turnstile → widget → secret key (site key goes to the web) |
| `REVALIDATE_SECRET` | ≥ 32 random chars, same value on the web (CMS revalidate hook) |

## Scripts only

`ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` (`pnpm admin:create`), `MIGRATIONS_DIR`, `ALLOW_SEED=staging` + `SEED_SCOPE`
(`pnpm db:seed`), `ALLOW_PURGE=production` (`pnpm db:purge-demo --apply` on production only).

## Web (Next.js)

| Key | Where |
| --- | --- |
| `API_URL` | API origin for server-side fetches/rewrites: `http://hebuza-api.railway.internal:4000` |
| `JWT_PUBLIC_KEY` | same as the server's |
| `ORIGIN_AUTH_SECRET`, `REVALIDATE_SECRET` | same values as the server |
| `NEXT_PUBLIC_SITE_URL` | `https://hebuza.rw` |
| `NEXT_PUBLIC_APP_ENV`, `NEXT_PUBLIC_APP_VERSION`, `DEPLOYMENT_VERSION` | `production`/`staging`, build version |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Cloudflare Turnstile site key |
| `NEXT_PUBLIC_GA`, `NEXT_PUBLIC_META_PIXEL_ID`, `NEXT_PUBLIC_TELEMETRY_URL` | analytics (optional) |

## GitHub Actions secrets

`RAILWAY_TOKEN_STAGING`, `RAILWAY_TOKEN_PRODUCTION` — Railway → project → Settings → Tokens, one per environment
(`deploy.yml`, `reseed-staging.yml`). Variable `SERVER_OPENAPI_URL` for web contract drift.

## Webhook URLs to register with providers

Replace `<api>` with `API_PUBLIC_URL` (production `https://api.hebuza.rw`) and `<token>` with `NOTIFY_WEBHOOK_TOKEN`.

| Provider | URL | Auth |
| --- | --- | --- |
| MTN MoMo | `<api>/api/payments/webhooks/momo?sig=…` | sent per request as `X-Callback-Url` by the API (signed with `PAYMENTS_WEBHOOK_SECRET`); nothing to paste, but whitelist the `<api>` host in the MTN portal |
| Airtel Money | none — the API polls Airtel for status (reconcile job every 5 min) | |
| Flutterwave | `<api>/api/payments/webhooks/flutterwave` | `verif-hash` = `FLUTTERWAVE_WEBHOOK_SECRET` |
| Resend (delivery events) | `<api>/api/webhooks/notify/<token>/resend` | svix signature with `RESEND_WEBHOOK_SECRET` |
| Africa's Talking delivery reports | `<api>/api/webhooks/notify/<token>/africastalking/status` | token in path |
| Africa's Talking inbound SMS (STOP) | `<api>/api/webhooks/notify/<token>/africastalking/inbound` | token in path |
| Web CMS revalidate (API → web) | `https://hebuza.rw/hooks/revalidate` | HMAC with `REVALIDATE_SECRET` |
