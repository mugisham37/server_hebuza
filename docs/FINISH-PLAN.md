# FINISH PLAN — close every hole, complete the spec, prove it in production

Status: **PLAN**. Execution starts on "go". This file covers both repos: `server_hebuza` (API + worker + DB) and `web_hebuza` (Next.js).

**Definition of done:**

- Every contract clause and every feature ID in the spec (`~/Desktop/cleanup/Project/spec`: 429 `F-*` IDs, 26 modules, 14 journeys, 8 cross-cutting areas) is built, connected end to end, tested, and verified on staging and production.
- No dummy data or dead code remains.
- Every local check is fast.
- Production is proven under load.

**Items left to the owner:** only items needing money, subscriptions, domains or third-party accounts (§11).

## 0. Ground rules (apply to every phase)

1. **Spec is the yardstick.** `spec/03-traceability.md` maps each contract clause to its F-IDs, and `spec/05-modules/*.md` define the behaviour. Anything in those files that the code doesn't do is a bug or a missing feature.
2. **Find → fix → move on.** No asking between steps. Each fix:
   - is the smallest root-cause change;
   - includes its test;
   - is committed with the F-ID or clause in the message;
   - is pushed; CI then auto-deploys to staging.
3. **Production promotion** happens at the end of each milestone (M1–M4, §10) via _Actions → deploy → Run workflow → production_, after a staging smoke run.
4. **Never:**
   - print secrets;
   - seed production with demo data;
   - weaken authz to make a test pass;
   - skip the design system: `check:design`, `check:layers`, the theme guide, and atoms → molecules → organisms.
5. **Every UI change:**
   - all states (loading, empty, error, offline, permission-denied);
   - responsive at 360, 768, 1280 and 1920 px;
   - rw/en/fr copy;
   - keyboard and screen-reader accessible (axe clean);
   - low-bandwidth friendly (spec `06-cross-cutting/performance-and-low-bandwidth.md`).
6. **Speed is a feature.** Any check slower than its budget (§4) gets investigated and fixed before moving on.
7. **Waves of ≤4 parallel agents** with strict file ownership. A fresh reviewer agent checks each wave against the spec and the quality bar before the next wave starts.

## 1. Phase 0: stabilise and inventory (first hour)

| Step | What                                                                                                                                                                                                                                                                                                                                                                           | Output                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| 0.1  | Both repos clean, CI green, staging and prod healthy. Recover the work of the two agents interrupted by the session restart (e2e fixes, dormant domain/Pro code): inspect `git log`, finish or redo what didn't land.                                                                                                                                                          | baseline commit hashes                                   |
| 0.2  | **Production history scan.** Railway logs and metrics for api, worker, web and backup (MCP `get_logs`, `http_error_rate`, `http_response_time`, `service_metrics`), staging and prod, since first deploy. Collect every 5xx, crash, restart, failed job, slow endpoint (p95), memory growth and failed cron. Check the worker DLQ (failed BullMQ jobs) and unsent outbox rows. | `docs/PROD-FINDINGS.md`: each finding becomes a fix task |
| 0.3  | **Repo inventory.** Run `knip` (unused files, exports, deps) on both repos; `depcheck`; list large files; stale docs; leftover scripts; root folder leftovers (`.ref/`, root `README.md`, root `render.yaml`, root `.github/`, root `.env*` examples, `docs/` remnants).                                                                                                       | cleanup list for Phase 2                                 |
| 0.4  | **Timing baseline** (§4): cold and warm `tsc`, `eslint`, `vitest`, `build`, Docker build, e2e, CI run, for both repos.                                                                                                                                                                                                                                                         | baseline table in this file                              |

## 2. Phase 1: spec audit (traceability matrix)

Goal: one authoritative list of what is BUILT / PARTIAL / MISSING versus the spec, per F-ID, with evidence.

- **Method:** 4 Explore-style agents in parallel, each owning a group of modules. Each agent reads its `05-modules/*.md` and the related journeys, then checks every F-ID against the code: server route + service + schema, and web screen + hook.
- **Status per F-ID:** `DONE` (file:line evidence) / `PARTIAL` (what's missing) / `MISSING` / `N/A` (P0 project deliverable or explicitly out of scope).
- **Module groups:**
  - **A:** identity-and-access, client-portal, company-profiles, service-request-lifecycle, documents, deliverables-and-review, feedback-complaints-ratings.
  - **B:** catalogue, consultation-booking, chat-and-communications, notifications-and-channels, ai-assistant, cms-knowledge-centre, deadlines-and-compliance-calendar.
  - **C:** quotes-invoices-payments, refunds-and-credit-notes, revenue-sharing-and-payouts, subscriptions, suppliers-landlords-payables, dashboards-and-reports.
  - **D:** assignment-and-workload, workforce, institutional-partners, crm-leads-campaigns, settings-and-configuration, audit-trail, plus the 8 cross-cutting docs.
- **Journeys:** each of the 14 `04-journeys/*.md` is walked step by step against the live staging app and becomes a checklist (step → screen → API → result).
- **Contract clauses:** every row of `03-traceability.md` is re-rated with evidence. `11-open-questions.md` items get a recorded decision (default: the spec's recommendation).
- **Output:** `docs/TRACEABILITY.md`, with a matrix, a gap list sorted by contract phase (P1 → P2 → P3) and an effort size per gap. This drives Phase 5.

## 3. Phase 2: clean-up (code, data, repos, environments)

**Web: dummy data out, real API only**

- Delete `src/mocks/**` (MSW worlds and handlers), `public/mockServiceWorker.js`, the `@/mocks/boot` import, `msw` and the `msw` package.json block, `check-mocks.mjs` and its script, `NEXT_PUBLIC_API_MOCKING`, `DemoValue` and demo pills, and the mock persona switcher on `/design`. Keep `/design` as a component showcase driven by static props, not mocks.
- Remove remaining mock-only code paths (`mock-ok` captcha fallback → dev-only Turnstile test keys; MSW-era comments; `lib/client/types.ts` aliases if unused; `@ts-expect-error` mock fixes).
- Every web data path goes through the typed client. Lint rule: no `fetch("/api` outside `lib/api` (the field offline engine is documented as the exception). Grep proves zero `@/mocks` imports.
- **Local development uses the real stack:** `docker compose` (infra) + `pnpm dev` in server/ + web/. One command per repo: `pnpm dev`. The web reads `API_URL=http://localhost:4000`. README "run locally in 3 commands".

**Server**

- Remove unused modules, files and exports found by knip.
- Remove dev-only leftovers: `openapi.json` duplication (keep the generated copy only), unused scripts, stale `docs/*` (keep ARCHITECTURE, DEPLOYED, RUNBOOK, SECURITY, DEPLOYMENT, TRACEABILITY, FINISH-PLAN; archive old wave plans into `docs/archive/`).
- Seeds:
  - **demo seed:** staging and local only;
  - **reference seed:** production;
  - **test fixtures:** created through the API inside tests, so they never depend on seed state.
- Test artefacts (`test-results/`, `playwright-report/`, `e2e-out/`, screenshots, `*.tsbuildinfo`, `dist/`, coverage) are git-ignored everywhere and deleted locally.

**Environments**

- **Staging:** add the "reseed staging" workflow (dispatch-only, staging-guarded). Purge test files from R2 `hebuza-files-staging` older than 7 days (lifecycle rule `tmp/` and `e2e/` prefixes; tests upload under `e2e/`).
- **Production:** verify there are zero demo rows (users, cases, invoices from the seed persona list) and zero test uploads in `hebuza-files-prod`. Remove any that exist. Rotate the staging secrets that leaked earlier (done) and confirm no stale variables (e.g. `TRUST_PROXY`, `ALLOW_SEED`) remain.
- **Railway and Cloudflare:** remove unused resources, keep tokens scoped, and review AI Gateway / Turnstile / R2 settings against `DEPLOYED.md`.

**Root folder:** the root is not a repo, so the only rule is that nothing needed lives outside `server/` and `web/`. Delete `.ref/` once Phase 1 confirms nothing still needs the old reference, plus the root leftovers.

## 4. Phase 3: speed (every check fast, then kept fast)

Budgets are **warm** (cached) local runs on this machine. Cold CI is allowed 3× the budget.

| Check                    | Budget                           | Levers                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| server `tsc`             | < 15 s                           | `incremental` + `tsBuildInfoFile`; `skipLibCheck`; exclude `test/`, `dist/`; isolatedDeclarations not needed                                                                                                                                                                                                                                                                                           |
| web `tsc`                | < 30 s                           | `incremental`; exclude mocks (deleted) and e2e from the main project; separate `tsconfig.e2e.json`; check whether `next typegen` reruns needlessly                                                                                                                                                                                                                                                     |
| eslint (each)            | < 15 s                           | `--cache --cache-location .eslintcache`; typed rules only where needed (`parserOptions.projectService` scoped); ignore generated `schema.d.ts`, `openapi.json`, `dist`, `.next`                                                                                                                                                                                                                        |
| unit tests               | < 10 s                           | vitest `pool: threads`; no DB in unit tests                                                                                                                                                                                                                                                                                                                                                            |
| server build (tsup)      | < 20 s                           | already fast; check sourcemap/minify settings                                                                                                                                                                                                                                                                                                                                                          |
| web build (`next build`) | < 3 min cold, < 60 s warm        | Turbopack build + filesystem cache (enabled); check page count (≈9.7k prerendered pages caused the 2.7 GB image). Reduce prerender fan-out: `generateStaticParams` for locales × services, so only real pages are prerendered and the long tail is built on demand. Trim client bundles (analyze), lazy-load heavy organisms (charts, editors), check that `reactCompiler` doesn't explode build time. |
| Docker builds            | web image < 300 MB; api < 400 MB | standalone output; prune devDeps; `.dockerignore`                                                                                                                                                                                                                                                                                                                                                      |
| e2e (20 journeys)        | < 5 min                          | Run against `next start` (prod build), never `next dev` (dev compile caused 3-minute first loads). Log in once per persona via `storageState` + global setup. Create data via API, not UI. Shard across workers (4–6). Retries 0 locally, 1 in CI.                                                                                                                                                     |
| CI per push              | < 8 min                          | pnpm store + Next + eslint + tsbuildinfo caches; parallel jobs (typecheck / lint / test / build); path filters                                                                                                                                                                                                                                                                                         |

Any regression over budget fails CI (`scripts/check-budget` with the timings).

## 5. Phase 4: connectivity and configuration parity (local = staging = prod)

- **One origin model everywhere.** The browser talks only to the web origin; `/api/*` is rewritten to the API (private network on Railway, `localhost:4000` locally). Verify cookies (`__Host-` in prod?), SameSite and Secure flags per environment; CORS allow-list from `WEB_ORIGIN` (comma list) including the future domain placeholders (`https://hebuza.rw`, `https://www.hebuza.rw`), harmless until DNS exists.
- **Dormant domain code** (ORIGIN_AUTH_SECRET guard, CF-Connecting-IP, Turnstile domain list, R2 CORS origins, `NEXT_PUBLIC_SITE_URL`, sitemap/robots/canonical URLs) is ready. A single `docs/DOMAIN-SWITCH.md` checklist turns it on in about 15 minutes.
- **`.env.example` per repo** lists every variable (from `env.ts`) with comments. A boot-time check logs which optional features are off (mail, SMS, AI, payments, Sentry) so ops see it at a glance.
- **Realtime (SSE) through the web rewrite:** verify streaming isn't buffered on Railway and Next. If it is, point the EventSource at the API origin with the ticket (already supported).
- **Security headers:** move CSP from report-only to enforced after a clean report window. Add `report-to` endpoint logging.

## 6. Phase 5: complete the spec (build what's missing)

Driven by `docs/TRACEABILITY.md`. Order: contract phase P1 → P2 → P3, then cross-cutting.

For each gap (feature or PARTIAL):

1. **Backend:** schema + migration, service rules in domain, route with authz/scope/audit/idempotency, `out` schema (typed response), jobs/notifications, contract regenerated.
2. **Frontend:**
   - the screen built from existing atoms/molecules (new ones only if the design system lacks them), following `DESIGN-SYSTEM.md` and the image-prompt boards in `cleanup/Project/image-prompts/<area>` as the visual reference;
   - all states and responsive breakpoints;
   - rw/en/fr;
   - realtime updates where the module says "live".
3. **Tests:** domain unit test for new rules; the authz matrix picks up new routes automatically; an e2e step added to the owning journey.
4. Commit with F-ID, push, CI, staging. The reviewer agent checks against the module spec.

Known gaps to confirm in the audit (from earlier work):

- **Payments:** gateway flows code-complete but untested without keys. Verify with each provider's sandbox the moment keys exist; until then, keep the contract tests with stubbed providers.
- **Notifications:** WhatsApp and SMS channels exist as drivers; message templates per event and per language need checking.
- **Dashboards and reports:** exec summary built; check every report the spec lists (finance, ops SLA, marketing funnel, AI usage).
- **Refunds and credit notes, revenue sharing and payouts, suppliers/landlords/payables:** verify the full lifecycle, PDFs, exports and approvals.
- **CMS knowledge centre:** editor → publish → revalidate → public page → assistant index, end to end.
- **Institutional partners and company profiles:** multi-user organisations, roles inside an org.
- **Feedback, complaints and ratings:** complaint workflow with SLA.
- **Accessibility, i18n, SEO, privacy (DSAR export/delete), observability, backups:** each cross-cutting doc gets its own checklist and evidence.

## 7. Phase 6: verification (local, staging, production)

| Layer                | What                                                                                                                                                                                                         | Where                                      | Pass bar                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Unit                 | domain rules (money, VAT, transitions, SoD, field, booking, crypto) + new rules                                                                                                                              | local + CI                                 | 100% pass                                                                                |
| API integration      | each module's critical paths against a real DB (Testcontainers or the compose stack)                                                                                                                         | CI                                         | pass                                                                                     |
| Authz matrix + IDOR  | every route × 15 personas                                                                                                                                                                                    | staging after each milestone               | 0 violations                                                                             |
| Abuse checks         | rate limits, OTP caps, idempotency, webhook signatures, CSRF, body limits, impersonation                                                                                                                     | staging                                    | all pass (payments signature checks with stub secrets)                                   |
| E2E journeys         | 14 spec journeys + persona smoke                                                                                                                                                                             | local (prod build) + staging               | all green, < 5 min                                                                       |
| Accessibility        | axe on every route group; keyboard pass on critical flows                                                                                                                                                    | staging                                    | 0 serious/critical                                                                       |
| Performance          | Lighthouse mobile (Slow 4G, mid-tier phone) on public pages + client portal; Core Web Vitals                                                                                                                 | staging + prod                             | LCP < 2.5 s, CLS < 0.1, INP < 200 ms; JS < budget                                        |
| Low bandwidth        | apply/track/booking flows on throttled 3G                                                                                                                                                                    | staging                                    | usable, offline banners correct                                                          |
| Load                 | k6/autocannon scenarios: public browse, login, case list, chat send, upload presign, search. Ramp to the spec's concurrency target (default 2,000 concurrent users / 300 rps) on **staging** sized like prod | staging                                    | p95 < 300 ms reads, < 600 ms writes, 0 errors. Bottlenecks fixed (indexes, caching, N+1) |
| Security             | OWASP ZAP baseline + authenticated scan, dependency audit, secret scan, header check                                                                                                                         | staging                                    | no high/critical                                                                         |
| Resilience drills    | worker down → API degraded + banner → recovery drains outbox; Redis restart; Postgres restart; deploy during traffic (zero-downtime); backup → restore into scratch DB with audit-chain verify               | staging (+ restore drill from prod backup) | each documented in RUNBOOK with timings                                                  |
| Production smoke     | after every promotion: health, status page, catalogue, login (admin), upload, assistant FAQ, backup ran, watchdog green                                                                                      | prod                                       | scripted `pnpm smoke:prod`                                                               |
| Synthetic monitoring | hourly prod smoke (GitHub Actions cron) with failure alert by email via GitHub                                                                                                                               | prod                                       | running                                                                                  |

## 8. Phase 7: production hardening extras (no domain or payment needed)

- **Sentry:** SDK wired and dormant (activates with `SENTRY_DSN`).
- **Log hygiene:** structured logs, no PII, request id end to end (web → api → worker).
- **Database:**
  - slow query log;
  - indexes for every list filter found under load;
  - `pg_stat_statements` review;
  - connection math documented;
  - the audit export check (first run tonight → verify object + hash).
- **Queues:** DLQ review screen for sysadmin (spec settings/observability), job retry/replay.
- **Backups:** monthly restore-drill workflow (GitHub Actions, staging scratch DB) and a second-provider copy (optional, owner decision).
- **Cost guardrails:** Railway usage alert ($20, set); AI Gateway spend alert; R2 lifecycle (set).

## 9. Phase 8: handover

- **Docs:** `README.md` per repo (run locally in 3 commands), `ARCHITECTURE.md` (diagram, modules, data flow), `DEPLOYED.md`, `RUNBOOK.md` (incidents, drills, rotations), `SECURITY.md`, `TRACEABILITY.md` (final: every F-ID DONE or owner-deferred), `DOMAIN-SWITCH.md`, `KEYS.md` (what each provider key turns on, webhook URLs to register).
- **Final report:** contract clause → evidence, test results, load results, known limits, owner actions.

## 10. Milestones (each ends with promotion to production + prod smoke)

| Milestone                  | Contents                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **M1: clean and fast**     | Phases 0, 2, 3, 4 (no new features). Dummy data gone, real API only, checks within budget, parity verified.     |
| **M2: P1 complete**        | All P1 F-IDs DONE; journeys for client, visitor, internal agent, service manager green.                         |
| **M3: P2 complete**        | Workforce, finance, CRM, channels, MFA; journeys for finance, field, external agent, marketing, partner green.  |
| **M4: P3 + cross-cutting** | AI, procurement, institutional partners, CMS, dashboards; all 14 journeys; Phase 6 full verification + Phase 7. |
| **M5: handover**           | Phase 8 docs and final report.                                                                                  |

Each milestone runs: wave build → reviewer → fix → full checks → staging verify → promote → prod smoke.

## 11. Owner-only items (everything else is done by the build)

| Item                                                                                                                | Unlocks                                         |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Resend key (+ verified domain for `no-reply@hebuza.rw`)                                                             | email, OTP by email, watchdog alerts            |
| Africa's Talking (or other SMS) account                                                                             | SMS OTP and notifications                       |
| Anthropic key (+ optional Voyage)                                                                                   | AI assistant beyond FAQ                         |
| MTN MoMo, Airtel Money, Flutterwave sandbox → live keys; register webhook URLs from `KEYS.md`                       | payments                                        |
| Sentry DSN (optional)                                                                                               | error tracking                                  |
| Railway Pro                                                                                                         | PITR, replicas (shared web cache already built) |
| Domain on Cloudflare                                                                                                | Phase L per `DOMAIN-SWITCH.md`                  |
| Production admin first sign-in + 2FA; revoke the pasted GitHub token; store the backup key offline; repo visibility | security housekeeping                           |

When each key is added to `~/.config/hebuza/providers.env` and `set-vars.mjs` is run, the feature switches on with no code change. A provider sandbox test run is included in `KEYS.md`.
