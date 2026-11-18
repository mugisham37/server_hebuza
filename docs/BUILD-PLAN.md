# HEBUZA POSIBA — Backend build & integration plan (master)

Status: PLAN. Execution starts on "go". Owner of this file: the **Conductor** (main Claude session). Every wave
reads this file first; the Conductor updates §12 (progress log) after each wave.

Decisions in this file are final unless a wave finds a hard blocker; then the Conductor records the change in §13.

---

## 0. Goals and non-negotiables

1. Every screen in the frontend (public, client, agent, ops, field, work, finance, procurement, marketing, system,
   exec, partners, booking, assistant) works against a real backend: real data, real permissions, real money rules.
2. **Security first** — this is what HEBUZA sells. Tenant/role isolation, audit trail, encryption, no data leaks.
3. **Scale**: thousands of concurrent users, heavy document traffic, realtime chat, bursty payments; horizontal
   scaling of API and workers with no code change.
4. **Quality bar = "least code that is fully correct"**: no duplication, one source of truth per rule, use the
   framework's built-ins before writing anything, small modules, shared domain package. Working ≠ done.
5. **Build first, test last.** During Phases 1–7 no Playwright, no e2e, no test suites, no full-repo lint runs.
   Allowed during build: `tsc --noEmit` on the touched package only (fast) and the Conductor's code review.
   Phase 8 is the single, complete test + hardening phase.

---

## 1. Final technology decisions

| Concern                               | Decision                                                                                                                                                                                                                                                        | Why (one line)                                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Repo                                  | **pnpm workspaces + Turborepo**                                                                                                                                                                                                                                 | shared packages, cached builds, one lockfile                                                                                      |
| API                                   | **NestJS 11 + Fastify adapter**, Node 22 LTS                                                                                                                                                                                                                    | structure (modules/DI/guards/interceptors) + speed                                                                                |
| Worker                                | **NestJS standalone app** (`createApplicationContext`) sharing the same modules                                                                                                                                                                                 | one codebase, no HTTP                                                                                                             |
| DB                                    | **PostgreSQL 16** + **Drizzle ORM** (reuse the 19 schemas from tag `backend-in-next-final`)                                                                                                                                                                     | typed SQL, no magic, migrations as SQL                                                                                            |
| DB scale                              | PgBouncer (transaction pooling), read replica for reports, monthly partitioning for audit/messages/events/ledger lines                                                                                                                                          | big tables stay fast                                                                                                              |
| Cache / queues / pubsub / rate limits | **Redis 7** (one cluster, separate logical DBs)                                                                                                                                                                                                                 | one dependency for four jobs                                                                                                      |
| Jobs                                  | **BullMQ** (`@nestjs/bullmq`), repeatable jobs for crons, transactional **outbox** table → BullMQ                                                                                                                                                               | no lost side effects                                                                                                              |
| Validation                            | **Zod** everywhere (`nestjs-zod`), schemas live in `web/src/lib/api`                                                                                                                                                                                          | same schema in form + API                                                                                                         |
| Contract                              | `server/openapi.json` stays the source of truth; API generates its spec and CI diffs it                                                                                                                                                              | frontend never breaks silently                                                                                                    |
| Frontend ↔ API bridge                 | **Keep `openapi-fetch` + TanStack Query** (already in 181 files). **No Axios.**                                                                                                                                                                                 | typed per path from the contract, ~6 KB, uses `fetch` (works in RSC + browser + MSW); Axios adds weight and loses the path typing |
| Auth                                  | Own auth module: **argon2id**, JWT access (10 min, EdDSA keys) + rotating refresh (30 d, family revocation), httpOnly `Secure` `SameSite=Lax` cookies, TOTP 2FA + SMS/email OTP, step-up token for sensitive actions, **WebAuthn passkeys** for staff (phase 7) | no per-user SaaS cost, full control, already designed in the frontend                                                             |
| AuthZ                                 | RBAC matrix from `src/lib/auth` (moved to `server/src/domain`) + **row scope** in services + **Postgres Row-Level Security** as a second wall for client-owned tables                                                                                             | defence in depth                                                                                                                  |
| Files                                 | **S3-compatible: Cloudflare R2** (no egress fees) — presigned direct upload/download, never through the API; **ClamAV** scan in worker; `sharp` thumbnails; per-object SSE                                                                                      | heavy documents don't touch API memory                                                                                            |
| Realtime                              | **SSE** (`/api/realtime/stream`) + Redis pub/sub fan-out; chat send via REST                                                                                                                                                                                    | works behind any proxy, scales horizontally, frontend already built for it                                                        |
| Email / SMS / WhatsApp                | Resend (email), adapter interface for SMS/WhatsApp (Africa's Talking / Twilio / Meta WA Cloud)                                                                                                                                                                  | swap providers without code change                                                                                                |
| Payments                              | MTN MoMo + Airtel Money + Flutterwave adapters, signed webhooks, idempotency, **double-entry ledger**                                                                                                                                                           | money correctness                                                                                                                 |
| PDF                                   | `@react-pdf/renderer` in worker                                                                                                                                                                                                                                 | invoices/receipts/statements                                                                                                      |
| AI                                    | **Anthropic TypeScript SDK** (latest Claude models), **pgvector** for KB, `AiModule` with budgets, redaction, tool-use, streaming                                                                                                                               | first-class TS support                                                                                                            |
| Search                                | Postgres full-text (`tsvector` + trigram)                                                                                                                                                                                                                       | no Elastic until proven needed                                                                                                    |
| Observability                         | pino (JSON) → OpenTelemetry traces/metrics/logs → Grafana stack (or Better Stack) ; Sentry for errors                                                                                                                                                           | one trace id from browser to DB                                                                                                   |
| Config/secrets                        | `@nestjs/config` + Zod-validated env; secrets in the platform secret store, never in git                                                                                                                                                                        | fail fast on bad config                                                                                                           |
| Deploy                                | Docker images (distroless), **Fly.io or Render** first (cheap, multi-region-ready), Postgres managed (Neon/Render/Supabase-managed PG), Redis managed (Upstash/Render), R2                                                                                      | low ops cost; k8s later if needed                                                                                                 |
| CI                                    | GitHub Actions + Turbo remote cache                                                                                                                                                                                                                             | fast                                                                                                                              |

Rejected (recorded so nobody re-opens it): Axios, Prisma (heavier, worse SQL control), GraphQL (contract is REST
and done), WebSockets/Socket.IO (SSE covers server→client; client→server is REST), Elasticsearch, microservices
(modular monolith + workers is enough; split only by measured need), Python (see chat decision; optional ML sidecar
only).

---

## 2. Target repository layout

```
hebuza/                              (this repo, converted)
├─ apps/
│  ├─ web/                 ← the current Next.js app moved here unchanged (src/, public/, next.config.ts …)
│  ├─ api/                 ← NestJS HTTP (Fastify)
│  │  └─ src/
│  │     ├─ main.ts        (bootstrap: helmet, cookies, cors, versioning, zod pipe, envelope, shutdown hooks)
│  │     ├─ app.module.ts
│  │     ├─ core/          (cross-cutting: auth guard, authz, envelope, errors, idempotency, audit, rate limit,
│  │     │                  request context (AsyncLocalStorage), db tx, outbox, storage, mail, health)
│  │     └─ modules/<domain>/  <domain>.module.ts · .controller.ts · .service.ts · .repo.ts · .events.ts
│  └─ worker/              ← NestJS standalone: imports the same modules' *.jobs.ts + processors, no controllers
├─ packages/
│  ├─ domain/              ← pure TS: money (bps, VAT, round-half-up), state machines, SoD/4-eyes, policies,
│  │                         RBAC matrix, case statuses, booking rules, field rules (moved from web/src/lib)
│  ├─ contract/            ← openapi.json, generated `paths` types, shared Zod schemas, error types, envelope
│  ├─ db/                  ← Drizzle schemas, migrations (SQL), seed, RLS policies, partition DDL
│  ├─ config/              ← tsconfig bases, eslint config, Zod env schema
│  └─ mocks/               ← MSW handlers + worlds (moved from web/src/mocks) — dev/demo only
├─ infra/                  ← docker-compose (dev: pg, pgbouncer, redis, minio, clamav, mailpit), Dockerfiles, deploy
├─ docs/                   ← contract README, JOBS.md, SECURITY.md, RUNBOOK.md, ADRs
├─ turbo.json · pnpm-workspace.yaml · BUILD-PLAN.md
```

Import rules (enforced by `check:layers`, extended):

- `server/src/domain` imports nothing but itself (pure, no I/O).
- `web/src/lib/api` imports only `zod`.
- `web` imports `domain`, `contract`, `mocks` (boot only). Never `db`, never `api`.
- `server` / `apps/worker` import `domain`, `contract`, `db`. Never `web`, never `mocks`.
- Inside web: atoms → molecules → organisms unchanged.

---

## 3. Backend architecture rules (apply to every module)

1. **Controller = HTTP only** (≤ ~5 lines per handler): Zod DTO in, call service, return data. The global
   interceptor wraps `{ success, message, errorType, data }`; the global filter maps `AppError` → status + errorType.
2. **Service = the rules**, runs inside `db.tx()`; repo = queries only. No business logic in repos or controllers.
3. **One transaction per command**: state change + audit row + outbox event commit together. Optimistic
   concurrency via `version` column → 409 `conflict`.
4. **State machines only in `server/src/domain`**; services call `assertTransition(machine, from, to, actor)`.
   The frontend renders the allowed actions from the same table.
5. **Side effects never inline**: email, SMS, PDF, AI indexing, webhooks out, notifications → outbox → BullMQ.
6. **Idempotency**: `idempotency-key` required on every money/submit POST; stored (key, user, hash, response) 24 h.
7. **Pagination**: keyset `{ items, nextCursor }` everywhere; max limit 100.
8. **Request context** (AsyncLocalStorage): user, roles, scopes, request id, locale, ip → available to audit/log.
9. **Errors**: one `AppError(status, errorType, message, fields?)`. Never leak stack/SQL to clients.
10. **Framework power first**: guards (`@Roles`, `@Scope`, `@StepUp`), interceptors (envelope, idempotency, audit,
    timing), pipes (Zod), `@nestjs/throttler` with Redis storage, `@nestjs/terminus` health, `@nestjs/schedule` not
    used (BullMQ repeatables instead, so only one worker runs a cron), `@nestjs/event-emitter` for in-process
    domain events → outbox, `ClsModule` for context. Write a custom piece only when none of these fits.

---

## 4. Security plan (built in from Phase 1, verified in Phase 8)

**Identity & sessions**

- argon2id (m=64 MB, t=3), breached-password check (k-anonymity HIBP range API), lockout + progressive delay,
  login attempts table, rate limit per IP + per account.
- JWT access 10 min, signed EdDSA with rotating key ids (JWKS internal); refresh token opaque, hashed in DB,
  rotation with reuse detection → revoke the whole family.
- Cookies httpOnly, Secure, SameSite=Lax, `__Host-` prefix in prod; CSRF: SameSite + Origin check + double-submit
  token on state-changing requests from browsers.
- 2FA: TOTP (encrypted secret), SMS/email OTP fallback, recovery codes (hashed); staff must have 2FA; step-up
  (re-auth within 5 min) for payouts, refunds, role changes, exports, deletes.
- Device/session list, remote sign-out, new-device alert.

**Authorization**

- Deny by default. RBAC matrix + per-row scope (own client, assigned agent, org, partner). Every repo query takes
  the scope. Postgres **RLS** on client-owned tables using `app.user_id` set per transaction.
- Separation of duties + 4-eyes enforced in domain for money and role changes (maker ≠ checker).
- IDs exposed are UUIDv7 / public references, never sequential ints.

**Data protection**

- TLS everywhere; DB at rest encryption (provider) + **field-level encryption** (AES-256-GCM, envelope keys) for
  national ID, TIN, bank/MoMo numbers, TOTP secrets, health/legal notes. Blind index (HMAC) for lookups.
- Files: private bucket, presigned URLs (5 min), content-type sniffing, size caps, ClamAV scan → quarantine,
  EXIF strip on images, per-document access check on every download, watermark on sensitive PDFs.
- PII redaction in logs (pino redact paths) and before any AI call.
- Retention + deletion jobs (GDPR-style + Rwanda Law 058/2021 on personal data): export my data, delete my data.
- Backups: PITR on Postgres, daily encrypted snapshots, quarterly restore drill.

**Application hardening**

- Helmet headers, strict CORS allow-list, body size limits, Zod on every input (strip unknown keys), parameterised
  SQL only (Drizzle), SSRF guard on any outbound URL, webhook HMAC + timestamp + replay window, rate limits per
  route class (auth 10/min, write 60/min, read 600/min), slow-request timeout, request id on everything.
- Audit log: append-only table, hash-chained, partitioned, exported daily to cold storage (WORM bucket).
- Supply chain: pnpm lockfile, `pnpm audit` + Renovate, pinned Docker base images, SBOM in CI, secret scanning.
- Admin surfaces: IP allow-list option, mandatory 2FA, session 8 h max.

Deliverable: `docs/SECURITY.md` (threat model STRIDE per module + controls table) written in Phase 1, completed in 8.

---

## 5. Scale & heavy-data plan

- **Stateless API** instances behind a load balancer; sessions are JWT + Redis; any instance serves any request.
- **PgBouncer** in front of Postgres; Drizzle pool small per instance; hot read paths cached in Redis with tag
  invalidation from the outbox; reports read from replica.
- **Partitioning** (monthly): `audit_events`, `chat_messages`, `notifications`, `ledger_lines`, `realtime_events`,
  `login_attempts`. Indexes designed per query in the repo file (comment lists the query it serves).
- **Files never stream through the API**: presigned PUT (multipart for > 100 MB), worker post-processing (scan,
  thumbnail, text extraction for search/AI), CDN for public assets.
- **Queues** with priorities: `critical` (payments, auth mail), `default`, `bulk` (exports, reindex, campaigns).
  Concurrency per queue, retries with backoff, dead-letter queue + admin replay screen.
- **Realtime**: SSE connections spread across instances; Redis pub/sub channel per user/room; heartbeat 25 s;
  `Last-Event-ID` replay from a 24 h event table.
- **Backpressure**: rate limits, queue length alarms, timeouts, circuit breakers on providers (MoMo, SMS, AI).
- **Load targets** (verified Phase 8 with k6): 2,000 concurrent users, p95 < 300 ms reads / < 600 ms writes,
  500 msgs/s chat fan-out, 50 concurrent 50 MB uploads, zero lost payment webhooks.

---

## 6. Module catalogue (what each module must deliver)

Each row = one Nest module in `server/src/modules/<name>` (+ jobs in worker). Endpoints are those in the
contract for that prefix; reference implementation is in git tag `backend-in-next-final` → `src/server/modules/`.

| #   | Module                     | Scope highlights                                                                                                                                        |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **auth**                   | signup, OTP, login (client/staff/team), 2FA, step-up, refresh, sign-out, invites, claim codes, access requests, password reset, passkeys (P7)           |
| 2   | **account**                | profile, avatar, settings, sessions/devices, consents, notification prefs, data export/delete                                                           |
| 3   | **system**                 | users & roles, config, feature flags, governance change-requests (4-eyes), templates, audit viewer, ops tools                                           |
| 4   | **catalogue**              | families, categories, subcategories, services, price bands, requirements, steps, publish/pause                                                          |
| 5   | **subscriptions**          | plans, subscriptions, focus, usage limits, renewals (job)                                                                                               |
| 6   | **booking**                | availability, holds, booking, reschedule/cancel, waitlist, reminders, no-show sweep, manage-link tokens                                                 |
| 7   | **applications**           | cases: create, lookup, summary, state machine, assignment, partner, pricing, link client, cancel                                                        |
| 8   | **documents**              | client vault, kinds, replace/versioning, shared docs, papers, reference batch, presigned upload/download, scan                                          |
| 9   | **chat**                   | conversations per case, messages, attachments, edits/history, pins, reactions, mentions, templates, claim/handoff, disputes, transcripts, read receipts |
| 10  | **notifications**          | in-app, email, SMS, WhatsApp; preferences; digests; delivery status                                                                                     |
| 11  | **realtime**               | SSE stream, focus/presence, event replay                                                                                                                |
| 12  | **ops**                    | workload, queues, assignment/auto-assign, oversight, SLA, deadlines, admin people/clients/agents/partners                                               |
| 13  | **work** (agent workbench) | offers, cases, deliverables, QC, obligations, statements, earnings, skills, papers                                                                      |
| 14  | **field**                  | visits, check-in (geo), expenses (SoD), cash custody + ageing, offline sync endpoint                                                                    |
| 15  | **workforce**              | staff directory, applications to join, onboarding, performance                                                                                          |
| 16  | **partners**               | partner orgs, cases, documents, payouts                                                                                                                 |
| 17  | **ledger**                 | double-entry accounts, journals, lines, period close, trial balance — the money core                                                                    |
| 18  | **payments**               | intents, MoMo/Airtel/Flutterwave adapters, webhooks, reconciliation, refunds                                                                            |
| 19  | **finance**                | quotes, invoices, receivables, approvals, payouts, revenue recognition, FX, VAT, numbering series                                                       |
| 20  | **procurement**            | vendors, requests, POs, receipts, bills, deposits, spend, 3-way match, approvals                                                                        |
| 21  | **reports**                | exec dashboards, exports (CSV/XLSX/PDF) via bulk queue, scheduled reports                                                                               |
| 22  | **marketing**              | leads/CRM, campaigns, referrals, short links (`/r`, `/c`), attribution, insights                                                                        |
| 23  | **cms**                    | entries, variants per locale, blocks, preview tokens, publish schedule, redirects, RSS, sitemap feed, revalidate webhook to web                         |
| 24  | **assistant (AI)**         | public assistant, intake, handoff, KB (pgvector) index, staff copilot, evals, budgets, ratings                                                          |
| 25  | **compliance**             | consents, retention, DSAR, policy versions                                                                                                              |
| 26  | **platform**               | public settings, status board, health/ready, track (`/api/track`)                                                                                       |

Domain packages to move into `server/src/domain` first (Phase 0): `lib/money`, `lib/domain`, `lib/auth` (matrix,
roles), `lib/finance/{states,rules}`, `lib/field/rules`, `lib/booking/rules`, `lib/ops/transitions`,
`lib/marketing/{policy,cms/rules}`, `lib/policy`, `lib/pricing`.

---

## 7. Frontend integration plan (atoms → molecules → organisms)

The frontend already talks HTTP through `src/lib/api/client.ts` (`openapi-fetch`) and per-domain hooks in
`src/lib/<domain>/api.ts` with TanStack Query. Integration is therefore mostly **removal and tightening**, not rewiring.

1. **One bridge**: `web/src/lib/api` generates `paths`; `web/src/lib/api/client.ts` stays the only HTTP
   entry. The ~20 raw `fetch("/api/...")` calls (login-forms, receipts, track, interactive, status-board,
   deliverables, settings-profile, assistant, work/agent statements, upload, booking/assistant) are converted to
   `api.GET/POST` or a typed `download()` helper. Rule after integration: no `fetch("/api` outside `lib/api`.
2. **Layer contract**: atoms = no data; molecules = props only; organisms = call hooks from `lib/<domain>`; hooks
   own query keys (`qk`), invalidation and optimistic updates. Any organism that builds URLs or parses envelopes
   itself is fixed.
3. **Types**: every hook returns contract types (`components["schemas"][...]`); view-model mapping functions live
   in `lib/<domain>` (one per resource) — no inline casts (`as unknown as`) in components.
4. **Mock cleanup** per module as it goes live: delete that module's MSW handlers + world; remove `DemoValue`
   usages for real values; remove type imports from `@/mocks` (`AuditEvent` → contract type). When all modules are
   live, `packages/mocks` remains only for Storybook/design pages and the demo build (flag off in prod).
5. **Auth on the web**: proxy guard keeps reading `hebuza_access` (verify signature with the public JWKS — not just
   decode); SSR pages that need user data use a server `api` client forwarding cookies; RSC prefetch returns
   (`HydrationBoundary`) for heavy workspace pages.
6. **Realtime**: one `useRealtime()` EventSource per tab, dispatching to query invalidations by event type.
7. **Uploads**: `uploadFile()` switches to presign → PUT to R2 → confirm; progress UI via XHR upload events.
8. **Errors**: `errorCopy` maps every `errorType` the API emits (checked against contract enum).

---

## 8. Orchestration model (Claude Code)

**Roles**

- **Conductor** (main session, this file's owner): plans waves, writes each agent brief, owns cross-cutting files
  (`app.module.ts`, `packages/*` index files, contract, this plan), reviews every agent's diff against the quality
  bar (§9), merges, updates §12. Never delegates review of its own architecture decisions.
- **Builders** (≤ 4 per wave, per the 403-risk rule): each owns a disjoint set of files (one module or one package).
  Brief = goal, files owned, reference files (old `src/server/modules/<x>`), contract paths, done-definition.
- **Integrator** (1 per wave, or the Conductor): wires modules into `app.module.ts`/worker, resolves shared
  types, runs package typecheck.
- **Reviewer** (fresh agent, not anchored): reads the wave's diff cold against §9 and §4; returns findings only.
  Conductor applies or sends back. This is the "refine & iterate" loop — a wave is not closed until the reviewer
  finds nothing material.

**Communication between agents**

- Agents message each other with `SendMessage` (by agent name) for interface questions, e.g. finance builder asks
  ledger builder for `postJournal()` signature. Rule: the **owner** of a file answers and changes it; nobody edits
  files they don't own.
- Shared decisions are written to `docs/INTERFACES.md` (append-only: who exports what, signature, status) so later
  waves and fresh agents don't need the conversation.
- Dependencies: a wave only starts modules whose dependencies (§10 order) are closed.

**Wave loop** (repeated until the plan is done)

1. Conductor writes briefs (from §6 rows + reference code + contract paths).
2. Builders build (no tests, only `tsc -p <their package>`).
3. Integrator wires + typechecks the touched packages.
4. Reviewer pass → findings → fix round (max 2 rounds, then Conductor decides).
5. Frontend integration for those modules (§7), mocks for them removed.
6. Conductor updates §12 + `docs/INTERFACES.md`, commits only if the user asked for commits.

**Speed rules**: no Playwright, no e2e, no vitest, no full-repo lint, no `next build` during Phases 1–7. No
re-reading files already in context. Agents report in ≤ 15 lines. If 403/usage limits hit → drop to sequential and
tell the user.

---

## 9. Quality bar (the reviewer's checklist)

- No duplicated logic: rules live once in `server/src/domain`; queries once in the repo; no copy-pasted handlers.
- Framework built-ins used (guard/interceptor/pipe/BullMQ/terminus/throttler/cls) instead of hand-rolled code.
- Controllers thin; services transactional; side effects through outbox.
- Every input Zod-validated; every query scoped; every money/state change audited and idempotent.
- No `any`, no `as unknown as`, no dead code, no commented-out code, no TODO without `shortcut:` format.
- Names match the contract; response shapes match `openapi.json` exactly.
- Indexes exist for every list/filter query; no N+1 (use joins / `inArray` batch loads).
- Secrets never logged; PII redacted; errors don't leak internals.
- Smallest correct diff; a reader understands each function at a glance.

---

## 10. Phases and stages (execution order)

Dependencies: P0 → P1 → P2 → (P3 ∥ P4) → P5 → P6 → P7 → P8. Inside a phase, stages in the same wave run in parallel.

### Phase 0 — Monorepo reorganisation (Conductor + 1 builder)

- 0.1 Create pnpm workspace + turbo; move current app to `web` (git mv, history kept); fix paths/aliases.
- 0.2 Extract `server/src/domain` (files listed in §6), `web/src/lib/api` (openapi + schema.d.ts + zod), `packages/mocks`; web imports updated.
- 0.3 Restore `server/src/db` from tag `backend-in-next-final` (`src/server/db`): schemas, relations, migrations, seed.
- 0.4 `infra/docker-compose.yml` (postgres+pgvector, pgbouncer, redis, minio, clamav, mailpit), `.env.example` per app.
- 0.5 `packages/config` (tsconfig bases, eslint), `check:layers` updated for package rules.
- Exit: `pnpm -r typecheck` on web passes; web runs exactly as today.

### Phase 1 — API & worker foundation (Wave 1: 4 builders)

- A: `server` bootstrap (Fastify, helmet, cookies, cors, zod pipe, envelope interceptor, error filter, versioning, cls request context, pino+OTel, terminus health).
- B: `core/db` (Drizzle + pool + `tx()` + RLS session vars), outbox table + relay, idempotency interceptor, audit service (hash chain), pagination helper.
- C: `core/auth` (argon2, JWT EdDSA + JWKS, refresh rotation, cookies, guards `@Public/@Roles/@Scope/@StepUp`, rate limiter on Redis, CSRF).
- D: `apps/worker` bootstrap (BullMQ queues, repeatable crons registry, outbox consumer, DLQ), `core/storage` (R2 presign + scan pipeline), `core/mail`/`sms` adapters, `core/crypto` (field encryption, blind index).
- Docs: `docs/SECURITY.md` threat model v1, `docs/INTERFACES.md` seeded.

### Phase 2 — Identity & catalogue (Wave 2)

auth · account · system (users/roles/config/governance/audit viewer) · catalogue + subscriptions/plans · platform.
Frontend: login/signup/2FA/settings/system workspace + public catalogue switch to real API; remove those mocks.

### Phase 3 — Client core (Wave 3) — parallel with Phase 4 where independent

applications · documents (presign, versions, scan) · booking · notifications · realtime (SSE) · chat.
Chat decisions: messages in partitioned table, attachments via documents module, fan-out via Redis pub/sub → SSE,
read receipts batched, edits keep history, full-text search per conversation, retention policy per case.
Frontend: client portal, booking flow, chat, vault, notifications.

### Phase 4 — Delivery operations (Wave 4)

ops (+ admin people/clients/agents/partners/oversight/deadlines) · work (agent workbench) · field (offline sync) · workforce · partners.
Frontend: ops, agent, work, field, partners workspaces.

### Phase 5 — Money (Waves 5a, 5b — strict order)

- 5a: **ledger** (accounts, journals, invariants: debits = credits, immutable posted lines, period lock) then **payments** (intents, adapters, webhooks, reconciliation).
- 5b: **finance** (quotes, invoices, receivables, approvals 4-eyes, payouts, refunds, revenue, VAT, FX, numbering) and **procurement** (vendors, POs, receipts, bills, deposits, 3-way match, spend); **reports** (exports via bulk queue, replica reads).
  Frontend: finance, procurement, exec workspaces.

### Phase 6 — Engagement (Wave 6)

marketing (CRM, campaigns, referrals, short links + click counting) · cms (entries, preview, schedule, redirects, revalidate webhook to web, RSS/sitemap from API) · compliance (consents, retention, DSAR).
Frontend: marketing editor, public site reads CMS from API (with seed fallback), proxy reads live slugs/redirects.

### Phase 7 — AI (Wave 7)

assistant (public + intake + handoff), KB indexing (CMS + catalogue → chunks → embeddings in pgvector), staff
copilot with tool-use over scoped read APIs, budgets per session/user, redaction, eval job, rating loop. Passkeys
for staff. Frontend: assistant + copilot surfaces.

### Phase 8 — Test, harden, deploy (the only test phase)

- 8.1 Full lint + typecheck + `check:*` across the monorepo; fix all.
- 8.2 Unit tests for `server/src/domain` (money, machines, SoD) — highest value, cheap.
- 8.3 API integration tests per module (Testcontainers Postgres/Redis) on the critical paths: auth, permissions matrix (every role × every route → expected 2xx/403), money flows, webhooks, uploads.
- 8.4 Contract test: generated OpenAPI == `server/openapi.json`.
- 8.5 Playwright e2e per persona (client, agent, ops, field, finance, procurement, marketing, system, exec, partner) on the real stack + axe accessibility + visual snapshots.
- 8.6 Security: OWASP ZAP baseline, dependency audit, secret scan, authz fuzz (IDOR attempts on every `:id`), rate-limit checks, webhook replay tests; pen-test checklist in `docs/SECURITY.md`.
- 8.7 Load: k6 scenarios against §5 targets; tune indexes/pools/queues.
- 8.8 Deploy: Docker images, staging → production, migrations job, backups/PITR, alerts, runbook (`docs/RUNBOOK.md`), mocks flag off in prod.
- Exit: every persona's journey passes, targets met, zero high/critical findings.

---

## 11. Definition of done (per module)

1. All contract paths for the module implemented; response shapes identical to the contract.
2. Permissions + scope + audit + idempotency in place; jobs registered in the worker.
3. Frontend pages for it read real data; its mocks deleted; no `@/mocks` imports left for it.
4. Reviewer pass clean against §9 and §4.
5. Entry in `docs/INTERFACES.md`; §12 updated.

## 12. Progress log (Conductor updates)

| Phase/Wave               | Status  | Notes                                                                     |
| ------------------------ | ------- | ------------------------------------------------------------------------- |
| Frontend-only conversion | done    | backend archived at tag `backend-in-next-final`; 227/227 endpoints mocked |
| P0                       | pending |                                                                           |

## 13. Decision changes

- 2026-11-18: monorepo split into `server/` + `web/` (no workspace; see SPLIT-PLAN.md). §2 layout is historical.
