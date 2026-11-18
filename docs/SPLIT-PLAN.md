# SPLIT PLAN — `web/` + `server/` (no monorepo)

Status: PLAN. Nothing changes until "go".

## 0. Goal

Two self-contained projects that only talk over HTTP:

```
hebuza/
├─ web/      Next.js frontend           → deploy anywhere (Vercel, Render, Docker)
└─ server/   NestJS API + worker + DB   → deploy anywhere (Render, Fly, Docker)
```

- No pnpm workspace, no shared packages, no Turborepo. Each folder has its own `package.json`, lockfile, `.env.example`, Dockerfile, README and CI job. Each folder can be pushed alone to its own GitHub repo, or both can sit in one repo as two folders. Both work unchanged.
- `server/` is one backend: the API, the worker, the database schema, migrations, seed and business rules all live inside it.
- The worker is the API's right-hand man. They share code, database, Redis and queues. The API keeps working when the worker is down, but it warns loudly everywhere.

## 1. Target layout

```
server/
├─ package.json  pnpm-lock.yaml  tsconfig.json  tsup.config.ts  Dockerfile  .env.example  README.md
├─ drizzle.config.ts
├─ src/
│  ├─ main.ts            HTTP API entry
│  ├─ worker.ts          worker entry (same code, no HTTP)
│  ├─ app.module.ts  worker.module.ts
│  ├─ core/              http, auth, db, queue, storage, notify, crypto, config   (unchanged)
│  ├─ modules/           27 feature modules                                      (unchanged)
│  ├─ domain/            ← was packages/domain (money, VAT, state machines, roles, rules)
│  └─ db/
│     ├─ schema/         ← was packages/db/src/schema*.ts + relations
│     ├─ migrations/     ← was packages/db/src/migrations
│     └─ seed/           ← was packages/db/src/seed
├─ test/                 authz matrix, abuse, load
└─ openapi.json          ← generated contract (published at GET /api/openapi.json)

web/
├─ package.json  pnpm-lock.yaml  next.config.ts  tsconfig.json  Dockerfile  .env.example  README.md
├─ src/                  app, components (atoms/molecules/organisms), lib, content, mocks   (unchanged)
├─ src/lib/api/schema.d.ts   ← generated FROM the server's openapi.json (typed client)
├─ src/shared/           ← the small pure subset of domain the UI needs (see §3)
└─ e2e/
```

The root of the repo keeps only `README.md`, `docs/` and `.github/workflows/` (one job per folder).

## 2. How web and server talk (HTTP only)

- **Client library:** keep `openapi-fetch` + TanStack Query. Pushback on Axios: it would lose the per-endpoint typing we have now (every call is checked against the server contract at compile time). `openapi-fetch` is fetch-based, ~6 KB, and works in the browser, in Server Components and with MSW. It does the same job Axios would, with types.
- **Contract, no shared package:** the server serves `GET /api/openapi.json`. The web runs `pnpm api:types` (`openapi-typescript $API_URL/api/openapi.json -o src/lib/api/schema.d.ts`) and commits the result. CI checks the committed file matches the live/staging server, so drift is caught.
- **Deploying on two providers** (e.g. web on Vercel, server on Render), recommended way: the web keeps proxying `/api/*` to the server (`next.config` rewrites, `API_URL=https://api.hebuza.rw`). The browser only ever talks to the web's own domain, so the httpOnly login cookies stay first-party: no CORS and no third-party-cookie problems on Safari or iOS.
- **Other clients** (mobile, partners, a second website): they call the server directly with `Authorization: Bearer` (already supported), and their origins go in `WEB_ORIGIN` (CORS allow-list).
- **Custom domains (optional):** `app.hebuza.rw` + `api.hebuza.rw` with the cookie `Domain=.hebuza.rw`. Then the browser could also call the API directly; the proxy stays the default.

## 3. Where the shared code goes

`packages/domain` today is used by both sides. After the split:

- **server owns the rules** (`server/src/domain/`): all of it. The server is the authority on money, permissions and state transitions.
- **web keeps only display helpers** (`web/src/shared/`): copies of the pure files the UI needs (money formatting, case-status labels and tones, role names, booking time helpers, i18n config and dictionaries, field geo).
  - Each copied file gets a header: `// Mirror of server/src/domain/<file> — UI only; the server enforces`.
  - A CI check compares the mirrored files' hashes against the server copies and warns on drift.
  - Anything the UI only uses to _predict_ an outcome stays a prediction; the server's answer wins.
- **`packages/contract`** is replaced by server-generated `openapi.json` + web-generated `schema.d.ts` (§2).
- **`packages/db`** moves into `server/src/db/`, because only the server touches the database.
- **`packages/config`:** each folder gets its own `tsconfig.json`.

## 4. API ↔ worker: tight coupling, survives worker outages

They are one codebase and one Docker image with two start commands. They share Postgres and Redis.

**How they communicate (unchanged):**

- **API → worker:** a transactional outbox row in Postgres, which the worker's relay moves into BullMQ jobs on Redis (`critical`, `default`, `bulk`). Nothing is lost if the worker is down; rows wait in the outbox.
- **Worker → API / clients:** Redis pub/sub (`rt:*`) for realtime events; the API's SSE stream pushes them to browsers.
- **Shared state:** the same Postgres tables and the same Redis.

**New: worker heartbeat and warnings**

1. The worker writes `worker:heartbeat` to Redis every 10 s (TTL 30 s), with version, queues, host and uptime.
2. The API checks it every 15 s through `WorkerMonitor`:
   - Missing → log `WARN worker offline: emails, notifications, scans, schedules are paused (N jobs waiting)` once per state change, then every 5 minutes while still down.
   - Back → log `INFO worker online`.
3. `GET /health/ready` stays **200** (the API still serves) with `"worker": "down"` and `status: "degraded"`, so the hosting provider doesn't restart a healthy API.
4. `GET /api/status` (public status page) shows "Background processing delayed".
5. The staff UI shell shows a small banner for sysadmin/ops roles: "Background worker offline since 14:02 — notifications and scans delayed".
6. At boot, the API logs one line saying whether a worker is present.
7. Version check: if the worker version ≠ API version (a half-finished deploy), the API logs a warning.

**New: inline mode, for one-service deploys**

- `WORKER_MODE=separate` (default): API only; run `node dist/worker.js` as a second service.
- `WORKER_MODE=inline`: the API process also starts the worker modules. Useful for a single Render/Fly instance or local dev.
- `WORKER_MODE=off`: API only, no warning spam (tests).

**Other languages (future):** BullMQ has an official Python client, so a Python worker (ML, OCR) can consume the same Redis queues without touching the API. The plan only documents this.

## 5. Code changes required

| Area        | Change                                                                                                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Move        | `apps/web → web`, `apps/api → server`, `packages/domain → server/src/domain` (+ web mirror subset), `packages/db/src → server/src/db`, delete `packages/contract` and `packages/config`, delete `pnpm-workspace.yaml`, `turbo.json`, root `package.json`           |
| Imports     | server: `@hebuza/domain/*` → `@/domain/*`, `@hebuza/db` → `@/db` (tsconfig `paths` + tsup alias). web: `@hebuza/domain/*` → `@/shared/*`, `@hebuza/contract` → `@/lib/api/schema`                                                                                  |
| Server      | `GET /api/openapi.json` (public, cached); `WorkerMonitor` + heartbeat; `WORKER_MODE`; `/health/ready` and `/api/status` worker field; drizzle config + migrate/seed scripts inside server                                                                          |
| Web         | `api:types` script; worker banner in the staff shell (reads `/api/status`); proxy guard keeps `JWT_PUBLIC_KEY`                                                                                                                                                     |
| Docker      | `server/Dockerfile` (targets: `runtime` for api/worker, `migrate`); `web/Dockerfile` slimmed (standalone output only, target < 300 MB from 2.74 GB)                                                                                                                |
| CI          | `.github/workflows/server.yml` (typecheck, lint, domain tests, authz matrix, build) and `web.yml` (typecheck, lint, check:layers/design, contract-drift check, build, e2e), each path-filtered                                                                     |
| Deploy docs | `docs/DEPLOY.md`: Render (server: web service `api` + background worker `worker` + migrate pre-deploy command; managed Postgres with pgvector, Redis); Vercel (web: root `web/`, env `API_URL`, `JWT_PUBLIC_KEY`, `REVALIDATE_SECRET`); env var tables per service |

## 6. Phases (each ends with typecheck + build of the touched folder)

1. **Finish and commit the in-flight Phase 8.4 work** (exec dashboard, requirements, CRM revenue, e2e reset).
2. **Move server:** `git mv`, inline domain and db, fix imports, its own package.json and lockfile, `pnpm install` inside `server/`, build, boot against the stack, smoke.
3. **Move web:** `git mv`, the `shared/` mirror subset, generated `schema.d.ts` from the running server, its own package.json and lockfile, build.
4. **Worker coupling:** heartbeat, monitor, warnings, `WORKER_MODE`, status and health fields, staff banner.
5. **Docker + CI + deploy docs** (slim web image).
6. **Verification:**
   - start the server with no worker → API serves, warnings appear, status shows degraded;
   - start the worker → recovers, outbox drains;
   - full e2e suite (20 journeys) with web and server started from their own folders;
   - authz matrix.
7. **Delete the MSW dummy data** (planned Phase 8 step), final full run, commit.

## 7. Risks and trade-offs (accepted)

- The UI's copies of the domain rules can drift from the server's. Mitigations: the hash-check CI warning, and the rule that the server is the authority.
- The contract sync is no longer atomic. A server change that breaks the web is caught by the web's drift check, not in the same commit. Deploy order: server first (additive changes), then web.
- Two lockfiles mean dependency upgrades happen twice.
