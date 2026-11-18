# HEBUZA POSIBA — Full-stack Next.js backend plan

Goal: Next.js 16 (this repo) becomes the **only** server. It replaces the FastAPI service at
`~/Desktop/Coding/Development/hebuza/server` and implements every endpoint the frontend currently
gets from MSW mocks, so every screen (atoms → molecules → organisms → routes) runs on real data.

---

## 1. Where we start

|              | Today                                                                                                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend     | Next 16.4.5, React 19.3, React Compiler, TanStack Query, zod 4, MSW 3. ~255 pages, 308 component files.                                                                                                                                                                         |
| API contract | Browser calls same-origin `/api/*`. `next.config.ts` rewrites it to FastAPI. Responses use the envelope `{ success, message, errorType, data }`. Errors are mapped by `src/lib/api/error-copy.ts`. Types come from `src/lib/api/schema.d.ts`, generated from FastAPI's OpenAPI. |
| Mocks        | 81 files in `src/mocks`, about **835 handlers**. `*-world.ts` files hold seed data; `policy.ts` holds business values and `PLACEHOLDER(id)` markers.                                                                                                                            |
| FastAPI      | ~36.5k lines of Python. 16 modules, ~224 endpoints, 50 tables, 32 Alembic migrations, 9 ARQ jobs. Uses Redis, MinIO/S3, Resend, MTN MoMo and Flutterwave. SSE realtime runs on one-time tickets with Redis fan-out.                                                             |

**Coverage today:**

- **Real (FastAPI), about 25%:** auth, services catalogue, categories, applications and cases, documents, shared documents, chat, payments, subscriptions, deadlines, notifications, agents, analytics, audit, platform, realtime.
- **Mock only, about 75%:**
  - finance;
  - procurement;
  - field;
  - system admin;
  - marketing CRM, CMS and campaigns;
  - booking and the AI assistant;
  - external agents (`/work`) and workforce;
  - most of ops;
  - compliance calendar.

**Principles:**

- **The mocks are the contract.** Each real handler must return the same shapes and error types as the mock it replaces. The UI should not need to change to switch over.
- **The Python code is the reference** for the 25% being ported, and its tests are the acceptance cases.

---

## 2. Architecture decisions

### 2.1 What runs where

| Concern                          | Where it lives                                                                                                                                          | Notes                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP API (`/api/*`)              | **One** catch-all route handler: `src/app/(endpoints)/api/[...path]/route.ts`. It is a single line that hands the request to `src/server/core/http.ts`. | Matches the "few folders" rule. Every endpoint is declared in a typed route table, one per module, and matched by a precompiled per-method radix matcher.                                 |
| Data for Server Components       | Server Components call `src/server/modules/*/service.ts` directly through a Data Access Layer, with no HTTP round trip.                                 | Saves a network hop for server-rendered pages, such as the public catalogue, CMS pages and dashboard first paint.                                                                         |
| Mutations                        | Route handlers, because the TanStack Query client, the field offline outbox and the webhooks all need plain HTTP.                                       | Server Actions are used only for simple public forms (contact, lead, newsletter). They call the same services.                                                                            |
| Background jobs and cron         | **pg-boss** (a queue stored in Postgres), started once per Node process from `src/instrumentation.ts` `register()`.                                     | Same deploy and same code. pg-boss locks jobs in Postgres, so running several instances is safe. A dedicated worker process can be split out later with no code change (`WORKER_ONLY=1`). |
| Fire-and-forget after a response | `after()` from `next/server`                                                                                                                            | Audit fan-out, analytics, cache warm-up and notification enqueueing.                                                                                                                      |
| Realtime                         | SSE route handler fed by Redis pub/sub, using one-time tickets as today                                                                                 | Needs a Node server that stays running (self-hosted), not serverless.                                                                                                                     |
| Request gate                     | `src/proxy.ts`, kept as is                                                                                                                              | Locale, coarse role gate, MFA gate and security headers. Final permission checks happen inside the API (defence in depth).                                                                |

### 2.2 Stack (versions pinned at install, ≥2 weeks old)

| Need                                     | Choice                                                                                                                                          | Why                                                                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Database                                 | PostgreSQL (same Railway instance)                                                                                                              | Already in production use                                                                                                           |
| ORM and migrations                       | **Drizzle ORM + drizzle-kit**, `postgres` (postgres.js) driver                                                                                  | Typed SQL, no runtime engine, fast. `drizzle-kit pull` introspects the **existing** FastAPI schema, so no data migration is needed. |
| Validation                               | **zod 4** (already installed)                                                                                                                   | One schema per request and response. Also generates OpenAPI (`zod-openapi`), so `schema.d.ts` stays the source of client types.     |
| Auth tokens                              | `jose` (JWT HS256, same secrets as FastAPI)                                                                                                     | Existing sessions survive the cutover                                                                                               |
| Passwords                                | `@node-rs/argon2`                                                                                                                               | Verifies existing argon2-cffi PHC hashes as they are                                                                                |
| Field encryption                         | Small Fernet implementation on `node:crypto`                                                                                                    | Decrypts secrets already encrypted by Python (`FERNET_SECRET`)                                                                      |
| Cache, rate limits, pub/sub, idempotency | Redis via `ioredis`                                                                                                                             | Same instance as today                                                                                                              |
| Files                                    | `@aws-sdk/client-s3` and `s3-request-presigner` (MinIO in dev, R2/S3 in production)                                                             | The browser uploads straight to a presigned URL, so Next.js never carries the bytes                                                 |
| Images                                   | `sharp` (resize, EXIF strip, thumbnails), with an HEIC decode fallback                                                                          | Replaces pillow and pillow-heif                                                                                                     |
| PDFs                                     | `@react-pdf/renderer`                                                                                                                           | Invoices, receipts, statements, contracts, POs, transcripts. Removes the "HTML print view" shortcuts.                               |
| Email                                    | `resend` (Node SDK) with React Email templates in the 3 languages                                                                               | Same provider as today                                                                                                              |
| Payments                                 | MTN MoMo and Flutterwave over `fetch`, plus webhook route handlers                                                                              | Port of `app/modules/payments`                                                                                                      |
| AI assistant                             | `@anthropic-ai/sdk` streaming. Retrieval uses **pgvector** in the same Postgres.                                                                | Replaces the mock SSE assistant. Default model is the latest Claude, set in config.                                                 |
| Logging and tracing                      | `pino` structured logs, plus OpenTelemetry through `instrumentation.ts`                                                                         | Request ID carried end to end (`x-request-id`)                                                                                      |
| Tests                                    | vitest for units and services; a contract runner comparing mocks and real handlers; Playwright end to end against the real backend; k6 for load |                                                                                                                                     |

### 2.3 Folder layout (one level under each folder, matching the components rule)

```
src/
  app/(endpoints)/api/[...path]/route.ts   ← export { GET, POST, PUT, PATCH, DELETE } from "@/server/core/http"
  app/(endpoints)/api/stream/route.ts      ← SSE (needs its own streaming response)
  app/(endpoints)/webhooks/[provider]/route.ts
  instrumentation.ts                        ← OTel + start pg-boss + register cron
  server/
    core/        env, db, redis, http (router, envelope, errors), auth, authz, audit,
                 ratelimit, idempotency, concurrency (If-Match), storage, email, pdf,
                 jobs, events (pub/sub), money, i18n, crypto, pagination, openapi
    db/          schema/*.ts (Drizzle tables per domain), migrations/, seed.ts
    modules/     one file group per domain:
                   <domain>.routes.ts   route table (method, path, roles, permission, stepUp, rateLimit, zod in/out)
                   <domain>.service.ts  business rules, transactions (callable from RSC and routes)
                   <domain>.jobs.ts     queue and cron handlers
                 domains: auth, catalogue, applications, documents, chat, realtime, payments,
                 subscriptions, deadlines, notifications, ops, agent, work, workforce, field,
                 finance, procurement, system, marketing, cms, booking, assistant, compliance, reports
```

Rule: `src/server/**` imports only `server-only`-safe code and is never imported by client components. `scripts/check-layers.mjs` is extended to enforce this.

### 2.4 One route-table entry (the pattern every endpoint follows)

```ts
route("POST", "/api/finance/invoices/:id/void", {
  auth: ["staff:finance_manager"], // role gate
  permission: "finance.invoice.void", // fine-grained check (system roles matrix)
  stepUp: true, // reauth within N minutes, else 401 step_up_required
  rateLimit: "write", // Redis sliding window per user and IP
  idempotent: true, // Idempotency-Key replay-safe
  ifMatch: true, // optimistic concurrency → 409 version_conflict
  body: VoidInvoiceIn,
  out: InvoiceOut, // zod 4; output also strips fields the role may not see
  audit: "finance.invoice.voided", // appended to the hash-chained audit log
  handler: (ctx, { id }, body) => finance.voidInvoice(ctx, id, body),
});
```

`http.ts` applies these in order: request ID → rate limit → session → role → permission → step-up → validation → idempotency → transaction → handler → output strip → envelope → audit (`after()`) → events (pub/sub). Errors become the same `errorType`s that `error-copy.ts` already understands: `validation`, `forbidden`, `not_found`, `version_conflict`, `step_up_required`, `rate_limited`, `payment_in_progress`, `stream_in_progress`, `session_closed`, and the rest.

---

## 3. Performance and concurrency targets

- **Runtime:** Node runtime, `output: "standalone"`, at least 2 instances on Railway behind its load balancer. Everything is stateless; state lives in Postgres and Redis.
- **Database:**
  - postgres.js pool per instance of `max = (pg max_connections − reserve) / instances`. Use PgBouncer in transaction mode if more instances are added.
  - Every list endpoint uses keyset pagination and has a covering index. No N+1 queries: services load with joins or `inArray` batches.
  - Money changes run in `SERIALIZABLE`, or with `SELECT … FOR UPDATE` on ledger and period rows, with retry on serialization failure.
  - Money is stored as integer RWF (minor units), never floats.
- **Caching:**
  - Public catalogue, CMS, pricing, FAQ and knowledge use `cacheComponents` with `use cache`, `cacheLife` and `cacheTag`.
  - Publish calls `revalidateTag` / `updateTag`.
  - A shared **Redis cache handler** keeps several instances consistent; set `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` and a deployment ID per the self-hosting guide.
- **Hot reads:** dashboard counters and nav badges are cached in Redis for 15–60 s and invalidated by domain events.
- **Uploads and downloads:** presigned and direct to storage. Exports and PDFs run as jobs and return a download link, never blocking a request.
- **Streaming:** SSE and the assistant stream are backpressure-aware. Redis pub/sub fans events out to the instance holding each connection.
- **Budgets (k6-verified in P13):**
  - read p95 < 150 ms;
  - write p95 < 350 ms;
  - error rate < 0.1%;
  - the throughput target per instance is `PLACEHOLDER(target-rps)` until you set it.

## 4. Security baseline (enforced by `core/http.ts`, not per handler)

- **Sessions:** httpOnly, `Secure`, `SameSite=Lax` access and refresh cookies (same names as today: `hebuza_access`, `hebuza_refresh`).
- **Request forgery:** mutations require a same-origin `Origin` header plus `SameSite`. Server Actions also get Next's built-in origin check.
- **Access checks:** role and permission are declared per route, and a test fails any route that has no `auth` declared. Data is scoped in services: client sees own org only, agents see assigned cases, field agents see their visits.
- **Step-up:** re-authentication within `PLACEHOLDER`/policy minutes is required for money, roles, break-glass and exports.
- **Abuse limits:** per-route rate limits, plus login and OTP lockout as in FastAPI `core/ratelimit.py`.
- **Webhooks:** HMAC or signature checks, timestamp window, and an idempotent event store.
- **Audit:** an append-only, hash-chained table (`/system/audit/integrity` verifies it), with sensitive-read logging.
- **Personal data:** PII fields are Fernet-encrypted at rest, values are redacted in logs, and the retention jobs and data-request (DSR) export and erase are real.
- **Secrets:** read only through `core/env.ts` (zod-validated at boot; the build fails if any is missing). `server-only` import guards and React taint APIs stop secrets reaching the client.

---

## 5. Phases

Each phase ends with a **gate** that must pass before the next starts:

1. tsc clean;
2. vitest green;
3. **contract tests**: every MSW handler of the phase's mock files is replayed against the real handler, and the response shape and `errorType` must match;
4. Playwright journeys for the affected workspaces pass against the real backend, with that module's mocks off;
5. `check:layers` and lint;
6. a written self-review against §3 and §4: what could break under load, what an attacker could try, what data could leak.

Mocks are switched off **per module** (`MOCK_MODULES=finance,procurement,…`), so finished modules run real while the others stay mocked.

### P0 — Foundation

- **Core setup:**
  - `src/server/core/*` from §2.3;
  - the catch-all `/api` route with the route table;
  - the envelope and error mapping;
  - request ID and pino;
  - OpenTelemetry in `instrumentation.ts`.
- **Database:** Drizzle connected to the existing database, with `drizzle-kit pull` producing all 50 tables. Alembic stays the migration owner until P3 cutover; after that, drizzle-kit owns migrations.
- **Infrastructure services:** Redis, the storage presigner, Resend, the PDF renderer base, and pg-boss started from `instrumentation.ts` with a cron registry.
- **Contract and frontend switch-over:**
  - zod-openapi generator, then regenerate `schema.d.ts` from the Next server;
  - remove the `/api` rewrite in `next.config.ts`;
  - `MOCK_MODULES` switch;
  - contract-test runner;
  - local `docker-compose` (Postgres with pgvector, Redis, MinIO) copied from the server repo.
- **Gate:** `/health/ready` checks the database, Redis and storage; one sample endpoint passes through the full pipeline; load smoke test.

### P1 — Auth and identity (port from Python)

- **Port from Python:** signup; login with OTP; `pre_2fa` token, TOTP and recovery codes; trusted devices; refresh rotation with reuse detection; forgot and reset password; set password from invite; sessions list and revoke; lockout and rate limits.
- **New, for staff (from the mocks):** the step-up endpoint, impersonation (view-as), MFA setup.
- **UI to rewire:** the auth organisms (`organisms/auth/*`), `/team/*`, `/login/2fa`, `settings/security`, and the session-expiry modal (it reads the real `expiresAt`).
- **Python tests ported:** `tests/test_auth*`.

### P2 — Catalogue, categories, platform, CMS read side

- **Port from Python:** services and the versioned structure engine (draft and publish), categories and subcategories, platform settings, the contact form.
- **New:** the CMS content store, replacing `mocks/cms-store.ts` and `src/server/mock-cms.ts`:
  - entries, versions, locales, scheduling, redirects, media library;
  - public reads with `use cache` and tags;
  - preview tokens and the RSS feed served from the database.
- **UI:** public site organisms, `/services/*`, `/knowledge`, `/updates`, `/pricing`, `/faq`, `/ops/catalogue`, `/marketing/content|landing|media|seo|faqs`.

### P3 — Client core: applications, documents, deadlines, notifications, realtime

- **Port from Python:**
  - applications and cases;
  - the apply wizard and submit (idempotent);
  - assignment and oversight;
  - documents with quality checks;
  - shared documents and the library;
  - deadlines with the daily job;
  - notifications with the digest job;
  - realtime SSE tickets and the hub.
- **New:** document requests, deliverables with the ZIP download job, client `/me/*` dashboard aggregates, the `/track/:code` public tracker, the help/ticket endpoints.
- **Jobs:** `deadlines_daily`, `notifications_digest`, `process_attachment` (sharp and HEIC), `cleanup_orphan_*`.
- **Cutover:** Alembic is retired and drizzle-kit owns migrations.

### P4 — Payments, subscriptions, ledger foundation

- **Port from Python:** MoMo and Flutterwave initiation; the webhooks; the reconcile job; bank transfer with proof; subscriptions.
- **New:** the double-entry **ledger core**: accounts, journal, entries, periods. Every money event posts balanced entries, which keeps the Ops and Finance totals consistent.
- **UI:** `/pay/*`, including the return page, client `/billing`, field MoMo collection.

### P5 — Ops, staff agent, chat

- **Port from Python:** chat (41 endpoints), lanes, mentions, attachments, disputes, SLA sweep, retention archive; agents roster, skills, metrics; analytics.
- **New, from `handlers-ops-*` and `handlers-agent-*`:**
  - today board, intake and triage, assign and auto-assign, reviews, SLA, tickets, statuses settings;
  - compliance rules (with a holidays table);
  - conversations and handoffs;
  - agent cases, workbench, offers, inbox templates, calendar, earnings, performance, profile and onboarding.

### P6 — Finance (from `handlers-finance-*`, ~110 handlers)

- **Billing:** quotes → invoices (numbering, void, credit notes), receivables and ageing, payments (record and proofs), refunds (request, review, approve, pay).
- **Payouts:** batches and agent fees.
- **Reconciliation:** statement import (a real CSV parser) with matching rules.
- **Revenue and close:** revenue rules and recognition, period close and reopen, approvals with the four-eyes check by user ID.
- **Reports and exports:** the report catalogue with drill-down, exports (CSV, XLSX, PDF, bank, MoMo, journal) as jobs, finance settings with history.
- **Gate:** the property test "ledger always balances" and the concurrency test (parallel payment plus void).

### P7 — Procurement (from `handlers-procurement-*`)

- **Spend flow:** purchase requests, then POs, then GRN (goods received), then bills, then payments.
- **Bills:** duplicate-invoice detection, recurring bills, no-PO justification, payables queue and pay runs.
- **Vendors:** vendors with KYC, bank-change lock with verification, supplier statements.
- **Other records:** contracts and obligations, deposits and returns, budgets and spend.
- **Approvals:** approval limits, exec approvals, same-user lock.
- **Reports and settings:** reports and settings.

### P8 — Field (from `handlers-field`, `x_field/*`)

- **Visits:** prepare bundle, visits (arrive with GPS, checklist, evidence, checkout), MoMo and cash collection, custody chain and cash confirm queue, receipts.
- **Money:** expenses with L1 and L2 approval by user ID, earnings.
- **Offline sync:** the outbox sync endpoint is idempotent per item with conflict detection (version vectors). The conflict-review endpoint is `/api/x_field/conflicts`.
- **Ops and finance views:** ops field queue, finance field view.

### P9 — External agents and workforce (from `handlers-work-*`, `handlers-workforce`)

- **Joining:** `/join` apply, status, and the application review (ops).
- **Onboarding:** onboarding and identity (KYC), contract sign (PDF), licence invoice.
- **Work:** jobs and offers, scoped case access with watermarking, deliverables.
- **Firm management:** firm team, availability and capacity, earnings and statements.
- **Workforce:** directory, worker profile, offboarding.

### P10 — System admin (from `handlers-system-*`)

- **Users and roles:** users and identity checks, roles (builder, matrix, separation-of-duties rules), access reviews and campaigns, offboarding.
- **Privileged access and approvals:** break-glass, approvals.
- **Audit:** audit, sensitive log and integrity verifier.
- **Integrations and notifications:** the integrations registry with credential rotation, notification templates with lint and test-send.
- **Settings:** platform settings and feature flags, maintenance banner and status posts.
- **Operations:** incidents, backups view.
- **Privacy:** data requests (export and erase jobs), retention policies, legal hold, processors register.

### P11 — Marketing (from `handlers-marketing-*`)

- **CRM:** leads (pipeline, merge, convert, lost), customers, unified inbox.
- **Audience and outreach:** segments (live count), campaigns (wizard, send job, consent gating), sequences (step jobs), templates.
- **Growth and feedback:** referrals (rewards), testimonials, feedback and NPS.
- **Insights and settings:** insights reports, SEO settings, the 404 log, social import.
- **Links:** campaign and referral link tracking (`/c`, `/r`) writes to the database instead of `cms-store`.

### P12 — Booking and AI assistant (from `handlers-booking`, `assistant-world`)

- **Booking:**
  - consultation types and the intake builder;
  - adviser availability and overrides;
  - the slot engine (timezone Africa/Kigali; holds with TTL in Redis);
  - book, pay, confirm, reschedule, cancel, no-show;
  - waitlist offers;
  - manage-by-token;
  - the callback queue;
  - ops board;
  - analytics.
- **Assistant:**
  - Claude streaming over SSE;
  - tools: search knowledge, recommend services, check case status, start a booking, capture a lead, hand off to a human;
  - guardrails (PII notice, no legal advice beyond the knowledge base, citations required);
  - free limit and rate limit, spend cap;
  - knowledge sources (ingest → chunk → embed into pgvector, with a review queue);
  - eval runs, transcripts, the copilot for staff, and drafts.

### P13 — Cutover and hardening

- **Remove mocks:**
  - all `MOCK_MODULES` are off in production;
  - MSW stays for the Storybook-like `/design/*` pages and unit tests only;
  - delete `src/server/mock-cms.ts` and the `/mock-cms` route.
- **Clear shortcuts:** close every `shortcut:` comment that says "when the API exists" (~150 of 222); `/ponytail-debt` lists them.
- **Final test runs:** the full Playwright suite on real data; k6 load against the §3 budgets; the security review (`/security-review`); backup and restore drill.
- **Deploy:** Railway with 2+ Next instances, Postgres (pgvector), Redis and storage; health checks; zero-downtime migrations (expand → migrate → contract).
- **Retire FastAPI:** after a parallel-run window where both read the same database.

---

## 6. What is not Next.js (and why that's fine)

| Item                                  | Decision                                                                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres, Redis, object storage       | External services. Every architecture needs them.                                                                                                                                 |
| Jobs and cron                         | Run **inside** the Next process with pg-boss, as you asked. If job load ever slows requests, run the same build with `WORKER_ONLY=1` as a second Railway service. No code change. |
| Serverless hosting (Vercel functions) | Not used. SSE, assistant streams and in-process jobs need a long-lived Node server, so this is self-hosted `next start` on Railway.                                               |

## 7. Decisions you need to make (defaults apply if you say nothing)

1. **Is FastAPI live with real users?** The default assumes yes and keeps the same database through introspection, so no data move is needed. If no, we can still keep it and drop the unused tables later.
2. **`PLACEHOLDER(target-rps)`** and expected users. The default is 2 instances, sized after the P13 load test.
3. **Business values** in `src/mocks/policy.ts` (fees, hours, numbers) move to the `platform_settings` table. They stay `PLACEHOLDER` until you supply them.
4. **AI model and monthly spend cap** for the assistant. The default is the latest Claude Sonnet, with `PLACEHOLDER(ai-monthly-cap)`.
5. **Repo hygiene:** `tests/` (unit and e2e) and `photos/` are currently missing from the working folder. Restore them or confirm they were deleted on purpose; each phase's gate needs the tests.

## 8. How the work is run

- **One agent per phase, run one after another** (the standing rule), each given this file and the phase section.
- After each phase you get a short report: endpoints done, contract results, journeys passing, issues found in the self-review.
- **Commit after each green gate,** only when you say commit.
