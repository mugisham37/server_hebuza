# Backend interfaces (append-only registry)

Owner of each block answers questions and changes its files. Others import only what is listed here.
Path alias: `@/*` → `server/src/*`. Domain via `@/domain/*`, schema via `@/db/schema`; the web gets the contract from `GET /api/openapi.json`.

## Layout (server/src)

```
main.ts            HTTP bootstrap (Fastify)                 — W1-A
worker.ts          worker bootstrap (Nest standalone)       — W1-D
app.module.ts      HTTP root module                         — W1-A (Conductor merges later modules)
worker.module.ts   worker root module                       — W1-D
core/config/       env.ts (Zod env), config.module.ts       — W1-A
core/http/         envelope.interceptor.ts, errors.ts (AppError + filter), context.ts (CLS), health.controller.ts, logger.ts — W1-A
core/db/           db.module.ts, db.ts, tx.ts, outbox.ts, idempotency.ts, audit.ts, pagination.ts — W1-B
core/auth/         auth-core.module.ts, password.ts, tokens.ts, cookies.ts, guards.ts, decorators.ts, csrf.ts, throttle.ts — W1-C
core/queue/        queue.module.ts, queues.ts, cron.ts, outbox.relay.ts — W1-D
core/storage/      storage.module.ts, storage.service.ts, scan.processor.ts — W1-D
core/notify/       mail.service.ts, sms.service.ts       — W1-D
core/crypto/       crypto.service.ts                        — W1-D
modules/<name>/    <name>.module.ts · .controller.ts · .service.ts · .repo.ts · .jobs.ts (worker only) · .dto.ts
```

## W1-A — config & http

- `Env` (Zod-parsed `process.env`); `ConfigModule` is global; inject `ConfigService<Env, true>`.
  Keys: `NODE_ENV, PORT, WEB_ORIGIN, DATABASE_URL, REDIS_URL, JWT_PRIVATE_KEY, JWT_PUBLIC_KEY, FIELD_KEY, BLIND_INDEX_KEY, S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, S3_REGION, RESEND_API_KEY?, MAIL_FROM, SMS_PROVIDER?, ANTHROPIC_API_KEY?, CLAMAV_HOST?, LOG_LEVEL`.
- `class AppError extends Error { constructor(status: number, errorType: string, message: string, fields?: Record<string,string>) }`
  helpers: `notFound(what)`, `forbidden()`, `conflict(msg)`, `invalid(fields)`.
- Global filter → `{ success:false, message, errorType, data:null }` (+ `detail:[{loc:["body",f],msg}]` for 422). Zod errors → 422 `validation`.
- Global interceptor wraps any return value `x` → `{ success:true, message:"OK", errorType:null, data:x }`. Controllers return raw data. `@RawResponse()` skips wrapping (files, SSE).
- `RequestContext` via nestjs-cls: `ctx.get("user") : SessionUser | null`, `ctx.get("requestId")`, `ctx.get("ip")`, `ctx.get("locale")`.
  `type SessionUser = { id: string; roles: Role[]; scopes: { orgId?: string; partnerId?: string; agentId?: string }; stepUpAt?: number; sid: string }` (Role from `@/domain/auth/roles`).
- Health: `GET /health`, `GET /health/ready` (db + redis) via terminus.

## W1-B — db

- `DB` injection token → `Db` (drizzle client over `postgres` with `{ schema }` from `@/db/schema`). `type Tx` = transaction client.
- `TxService.run<T>(fn: (tx: Tx) => Promise<T>): Promise<T>` — sets `app.user_id`, `app.roles` via `set_config(...,true)` for RLS; retries serialization failures 3×.
- `OutboxService.add(tx, { type: string; payload: unknown; queue?: "critical"|"default"|"bulk"; runAt?: Date })` — insert into `outbox` table (add table to `@/db/schema` schema-system.ts + migration).
- `AuditService.record(tx, { action: string; entity: string; entityId: string; before?: unknown; after?: unknown; reason?: string })` — hash-chained `audit_log` row; actor/ip/requestId from context.
- `@Idempotent()` decorator + `IdempotencyInterceptor` — requires `idempotency-key` header, stores (key,userId,bodyHash,status,response) 24 h in `idempotency_keys`; replays identical response; 409 on body mismatch.
- `pageQuery` Zod `{ cursor?: string; limit: 1..100 default 20 }`; `page(rows, limit, keyOf) → { items, nextCursor }`; `decodeCursor`.
- `versioned(tx, table, id, expectedVersion, patch)` → 409 `conflict` on stale version.
- Built (W1-B): `TxService.run(fn)`; `TxService.runAsSystem(fn)` (worker/cron only, throws inside an HTTP request) sets `app.roles='system'`. RLS (migration 0003) is FORCEd on `applications, client_documents, conversation_participants, notifications, payments`: queries on those tables MUST go through `TxService.run`, raw `DB` sees no rows. Bypass is per table (see 0003 header): payments → finance/sysadmin/system; applications → case staff (staff:agent, staff:service_manager, staff:sysadmin, system) + ext:agent where `assigned_agent_id = app.user_id`; client_documents/conversation_participants → case staff; notifications → owner + system only (write them from the worker). Idempotency: in-flight keys older than 60 s are reclaimable; only AppError <500 frees the key.
- `versioned(...)` lives in `core/db/db.ts`; table needs a single-column PK and an integer `version` column. Idempotency body mismatch/in-flight → 409 `conflict`; missing header → 400. `canonical()`/`linkHash()`/`GENESIS` exported from `core/db/audit.ts` for the chain verifier.
- `outbox` (id, type, payload, queue, run_at, sent_at) + `idempotency_keys` in `schema-system.ts` (migration 0002). W1-D: relay `where sent_at is null and run_at <= now()` with `for update skip locked`, purge `idempotency_keys` older than 24 h. `@/db/schema` index now re-exports all `schema-*.ts`. Optional env `DB_POOL_MAX` (default 10) — W1-A may add to `Env`.

## W1-C — auth core

- `PasswordService.hash/verify` (argon2id m=65536,t=3,p=1), `isBreached(pw)` (HIBP range, fail-open with log).
- `TokenService.signAccess(user): string` (EdDSA, 10 min, kid), `verifyAccess(token): SessionUser`, `issueRefresh(tx,userId,sid,familyId?)`, `rotateRefresh(tx, raw)` (reuse → revoke family), `revokeSession(tx,sid)`, `jwks()`.
- `CookieService.set(reply, access, refresh)`, `clear(reply)`; names `hebuza_access` (path /), `hebuza_refresh` (path /api/auth); httpOnly, Secure in prod, SameSite=Lax.
- Global `AuthGuard` (APP_GUARD): reads cookie or `Authorization: Bearer`, sets context user; 401 `unauthenticated` unless `@Public()`.
- Decorators: `@Public()`, `@Permit(...perms: Permission[])` (Permission from `@/domain/auth/permissions`, checked against MATRIX), `@StepUp()` (requires `x-step-up-token` valid ≤ 5 min → 401 `step_up_required`), `@CurrentUser()` param.
- `CsrfGuard` (APP_GUARD): state-changing requests must have allowed `Origin`/`Referer` (WEB_ORIGIN) — skip for webhooks (`@Webhook()` decorator marks route public+no-csrf).
- Throttling: `ThrottlerModule` with Redis storage; throttlers `default` 600/min (all routes) + `write` 60/min (non-GET/HEAD); `@Limit("auth"|"write"|"read")` = `@Throttle({ default: 10|60|600 per min })`.
- W1-C built: import `AuthCoreModule` from `core/auth/auth-core.module` (global; registers APP_GUARDs Throttler → Csrf → Auth). No schema change (uses existing `refresh_tokens` + `auth_sessions`; sid = family id = `auth_sessions.id`, auth module inserts the session row first).
  - `TokenService.signStepUp(user)` / `verifyStepUp(raw,user)` (JWT typ `step_up`, 5 min, bound to sid). Step-up is also enforced automatically for any `@Permit` perm in `STEP_UP`.
  - `rotateRefresh(tx, raw) → { refresh, userId, sid }`; caller loads roles/scopes and calls `signAccess`. Errors: 401 `unauthenticated` / `refresh_reuse`; 403 `forbidden` / `csrf`.
  - `@Permit(a,b)` = any-of, area-level (`can(user, p)` without resource ctx); row scope stays in services. `req.user` + `cls "user"` set on every HTTP request (also on public routes when a valid token is sent).
  - Dev: non-PEM `JWT_PRIVATE_KEY` outside production → ephemeral Ed25519 keypair + warning. PEMs may use literal `\\n`.
  - `core/auth/otp.ts`: `totp.{secret,uri}`, `totp.verify(token,secret) → step|null` + `claimTotpStep(tx,userId,step) → boolean` (replay guard on `staff_profiles.totp_last_step`, migration 0004), `newOtp() → {code,hash,expiresAt}`, `checkOtp(tx, table, idCol, id, code) → ok|bad|dead` (atomic attempt++ while attempts<5 and unexpired; table needs `code_hash, attempts, expires_at`).

## W1-D — worker, queue, storage, notify, crypto

- Queues (BullMQ): `critical`, `default`, `bulk`. `QueueService.add(queue, name, data, opts?)`.
- Job handlers: `@Job("name")` method decorator on any provider in a module imported by `WorkerModule`; one processor per queue dispatches by job name. `@Cron("name", "*/5 * * * *")` registers a repeatable job (only workers run them).
- Outbox relay (worker): polls `outbox` (SKIP LOCKED, batch 100, 1 s) → `QueueService.add` → marks sent. Events can also be published to Redis channel `rt:<userId>` / `rt:room:<id>` for realtime when `payload.realtime` is set.
- `StorageService.presignPut({ key, contentType, size, purpose }) → { url, key, expiresAt }`, `presignGet(key, filename?)`, `head(key)`, `delete(key)`, `putObject(key, body, type)`; keys `u/<userId>/<purpose>/<uuid>`. Scan job `storage.scan` (ClamAV INSTREAM; infected → quarantine prefix + event).
- `MailService.send({ to, subject, html, text?, tags? })` (Resend; logs only when no key), `SmsService.send({ to, text })` (adapter). Without a provider: dev logs masked recipient (+subject) only, production throws. Env `TRUST_PROXY` (hops, default 1). Relay purges sent outbox >7 d and idempotency_keys >24 h daily (`outbox.purge` cron); realtime publishes after commit; `REDIS` token = BullMQ's shared connection.
- `CryptoService.encrypt(plain): string` / `decrypt(cipher)` (AES-256-GCM, versioned `v1:` prefix, key from FIELD_KEY), `blindIndex(value): string` (HMAC-SHA256, BLIND_INDEX_KEY).
- W1-D impl notes: `QueueModule` (global) exports `QueueService` + `REDIS` token (ioredis). `JobExplorer`/`OutboxRelay` are provided only in `WorkerModule`. Handlers get `(data, job)`; `@Cron` jobs run on `default`. Defaults: 5 attempts, exp backoff 2 s, keep 1k complete / 10k failed (DLQ; `queue.dlq` log on final failure). Relay assumes `outbox(id, type, payload jsonb, queue, run_at, sent_at, created_at)`, jobId `ob_<id>`; `payload.realtime = { userId?, roomId? }`. `StorageService.key(userId, purpose)` builds keys; `head()` → null when missing; scan job data `{ key }`, `CLAMAV_HOST` = `host[:port]`. Modules: `StorageModule`, `NotifyModule` (in mail.service.ts), `CryptoModule` (in crypto.service.ts), all global; `safeEqual(a,b)` exported from crypto.service.ts.

## W2-D — notifications & realtime

- `NotificationsModule` (modules/notifications; import it in your module) exports `NotificationsService`.
  `notify(tx, { userId, kind, title, body?, link?, channels?: ("email"|"sms"|"whatsapp")[], conversationId?, data?: { type, vars? } })` — call inside your business `TxService.run` tx; adds outbox event `notifications.deliver`. Worker job inserts the in-app row (`runAsSystem`), emits realtime `notification` `{ notification }`, then sends channels best-effort (email respects `email_enabled`; sms/whatsapp → `SmsService` to `users.phone_e164`; whatsapp has no provider yet). Cron `notifications.digest` hourly.
- `RealtimeModule` exports `RealtimeService`: `emit(userId, type, payload)` (replayable, Redis stream `rtlog:<uid>` 500 entries/24 h, then PUBLISH `rt:<uid>`), `focusOf(userId) → string|null` (set by `POST /api/realtime/focus {focus}` , TTL 120 s). Outbox events with `payload.realtime.userId` are delivered live but NOT replayable; use `emit` if replay matters. `rt:room:*` not routed to streams yet.
- SSE: `POST /api/realtime/ticket` → `{ticket, expires_in}`; `GET /api/realtime/stream?ticket=…[&last_event_id=…]` (or `Last-Event-ID` header). Frames `id: <streamId>\ndata: {"type","at",...payload}` (payload minus `realtime`); `: ping` every 25 s; closes at 30 min or user deactivated.

## Wave 2 integration (conductor)

- `dto(schema)` (`core/http/dto.ts`) replaces `createZodDto` everywhere.
- `AppError(status, errorType, message, fields?, data?)`: `data` is emitted as the envelope `data` (any status). Used: auth 423 `{ lockoutUntil }`, system 409 `sod_conflict {conflicts}`, `role_in_use {members}`, change decisions `{state}`.
- `SessionUser.act?: string` / access-token claim `act` = real actor on a view-as token. `AuthGuard` → 403 `impersonation_read_only` for non-GET/HEAD unless `@ImpersonationOk()` (sign-out, DELETE auth/session, DELETE staff/impersonate, realtime ticket). Audit rows: `actorId` = actor, `details.impersonatorId/viewAs`. Refresh re-issues the view-as token while `auth_impersonations` is open; TTL capped at `until`. `TokenService.signAccess(u, ttl?)`.
- `AuthService.access(tx, user, sid, view?)` is the only principal builder (login, refresh, view-as): roles = `users.role` ∪ unexpired `system_records(userMeta).extraRoles`; scopes `partnerId`/`agentId` (= user id when a partner/agent/field-agent profile exists), `orgId` = account active org. `AuthService.revokeAllSessions` / `issueResetToken` are the only implementations (system calls them via `deps.auth`).
- `CryptoService.seal(obj, keys)` / `unseal(obj, keys)`: auth.mail/auth.sms payload `text` is sealed (carries OTP/reset link).
- Migration 0005: SECURITY DEFINER `public_service_volume(days)`, `guest_application(code)`, `claim_application(id)` (raise `app.roles` to system for their body only).
- `emitRealtime(redis, userId, type, payload)` (core/queue/outbox.relay): the relay now routes `payload.realtime.userId` through the replay stream too; `RealtimeService.emit` delegates to it.
- `NotificationsService.insert(tx, n, id?)` is on-conflict-do-nothing; the deliver job uses `ntf_<jobId>`.
- Subscriptions worker: `@Job("auth.user.signed_up")` → trial for clients; `@Cron("subscriptions.expire", "30 0 * * *")`.
- System settings write-through busts `PublicCache("platform")` after commit (`SystemDeps.cache`).
- Pure shared files moved to `@/domain`: `system/{approvals,audit,audit-catalogue,governance,incidents,integrations,privacy,settings-registry,templates,types}`, `ops/{rules,ranking}`, `i18n/dictionaries/*.json` (web + api import from there).

## W3-B — booking

- `BookingModule` (modules/booking) exports `BookingService`; worker side `BookingWorkerModule`. 37 routes = reference table (public `consultation-*`/`bookings/*`, `me/bookings/*`, `agent/bookings|availability`, `admin/bookings|consultation-requests|consultation-types`).
- `BookingService.settle(txId)` — payment webhook nudge (payments module): re-reads `bkg_payments` and confirms/late-refunds the booking. shortcut: no gateway in the API yet — `pay` settles via a dev stub, production answers 503 `unavailable`.
- Outbox events (payload JSON):
  - `booking.refund_requested` `{ bookingId, reference, refund: { ref: "RFD-YYYY-NNNN", amount, kind: "refund"|"credit" } }` — **finance consumes**; booking registers a placeholder `@Job` with that name that only logs — finance deletes it when taking over the name.
  - `booking.lead_captured` `{ leadId, name, phone?, email?, source }` (`phone`/`email` sealed with `CryptoService.seal`) — **marketing CRM consumes**; same placeholder rule.
  - `booking.notify` `{ kind, bookingId, token? (sealed) }`, `booking.waitlist.offer` `{ typeSlug, date }` — internal.
- Crons: `booking.sweep` (every minute: settle open payments, auto no-show, expire lapsed holds → waitlist offers), `booking.reminders` (*/5).
- Clients (bookings with `client_id`) are messaged through `NotificationsService.notify` (kind `booking`, data.type `booking.<kind>`); guests by email/SMS at the booking contact (manage link only to guests).
- Holds: per-Kigali-day `pg_advisory_xact_lock(hashtext('bkg:'+day))` inside the tx (also taken by late-payment confirm and reassign). Manage tokens stored as sha256 (`token_hash`, unique).
- Optional env read via `ConfigService`: `TURNSTILE_SECRET_KEY` (captcha; dev accepts `mock-ok`) — Conductor: add to `Env`. Base URL for links = first `WEB_ORIGIN`.
- Seed: `seedBooking(db, { encrypt })` in `server/src/db/seed/booking.ts` (run after seedAuth: advisers link to `mock-agent`, `mock-ext`, `mock-sm`).

## W3-D — ops (modules/ops)

- `OpsModule` exports `OpsRunner`: `run(req, ctx => …)` runs a reference-style handler in `TxService.run` with `Ctx = { db: Tx, session (SessionUser + role), ip, req.headers.get, audit, stepUp(): Promise<boolean> }`; `read(db => …)` for reads. `@Req()` (ops.runner) gives the raw request.
- `lib/store.ts` (pure functions over a `Tx`): `loadCase(db, code, lock?)`, `loadCases`, `saveCase(db, row, appPatch)` (ops_case_meta upsert, version+1), `logEvent`, `eventsOf`, `agentsAll`, `agentOr404`, `clientsOf`, `namesOf`, `factsOf`, `rec{List,Get,Put,Seq,Ids,Delete}` (ops_records), `holidays`, types `OpsX`, `CaseRow`, `AgentRow`. The agent module (W3) should import these instead of re-querying.
- `lib/ctx.ts`: `notify(tx, {userId, kind, title, body?, href?})` (= outbox `notifications.deliver`) and `publish(tx, type, {audience, data})` (outbox row per audience user, realtime) for plain-function callers; `SYSTEM` session for crons.
- `ops.cases.ts` exports `autoAssign(tx, code, SYSTEM)`, `offerNow`, `OfferData`; `ops.manage.ts` exports `openReview`, `openApproval`, `openTicket` (agent/feedback modules open records through these).
- Worker: `OpsWorkerModule` crons `ops.offer_expiry` (*/5), `ops.sla_sweep` (*/10), `ops.auto_assign` (*/5).
- Seed: `seedOps(db)` in server/src/db/seed/ops.ts (after seedAuth + seedCatalogue).

## W3-A — applications, documents, deadlines

- HTTP entry `DocumentsModule` (imports + re-exports `ApplicationsModule`); worker entry `DocumentsWorkerModule` (carries `DeadlinesWorkerModule`). Import `ApplicationsModule` / `DocumentsModule` to use the services.
- `ApplicationsService` (modules/applications): `getForActor(tx, me, code, { forUpdate? }) → App` (owner/assignee/all-cases role via `can("req.case.read")`, else 404); `transition(tx, me, app, to, actor, facts?, note?)` — the only status writer: `movesFor` from `@/domain/ops/transitions` (409 `invalid_transition` / `transition_blocked` data `{guard}`, 422 reason required), optimistic on the old status (409 `conflict`), writes `application_status_history`, notifies the client, audits `application.status_changed`. Pure helpers exported from `applications.service.ts`: `appByCode, assertCanRead, money, paidRows, stepOf, STEPS, isTerminal, timeline, summary, normalizePhone, isValidNationalId, recordFeedback, publicApp`.
- `SupportService.reply(tx, staffId, ref, body, status?)` — staff answer on a client ticket (+ notification).
- `DocumentsService` (modules/documents): library/case uploads are presigned PUTs. `POST /api/me/documents` and `POST /api/applications/:code/documents` take JSON `{ filename, mime, size, … }` (no multipart) and return the row + `upload: { url, key, expiresAt }`. Outbox `documents.finalize` runs after the 5-min PUT window: missing object / sniffed type ≠ declared → row rejected + object deleted; else `storage.scan` queued, images EXIF-stripped + `.thumb.jpg`, case uploads activated (replace previous version of the requirement, fulfil the document request, notify the assignee). Downloads (`me/documents/:id/download`, `deliverables/:id/{preview,download}`) are 302 redirects after a per-document check. Cron `documents.orphans` 03:30.
- Deadlines (modules/deadlines/deadlines.service.ts, pure + tx functions): `addDays, addBusinessDays, kigaliToday, kigaliDate, endOfKigaliDay, daysBetween, occurrences, nextOccurrence, deadlineState, initialDue(tx, svc, preferred)`, `runDaily(tx, notify)`. Cron `deadlines.daily` 05:00 UTC (07:00 Kigali).
- Migration 0006 `w3a_public_tracker`: policy `guest_insert` (unowned application insert without a user), SECURITY DEFINER `public_application(code, idempotency_key) → jsonb`, `public_paid_payments(code) → setof jsonb` (tracker + guest replay).
- Guest tracking-code email reuses the `auth.mail` job (sealed `text`).
- Seeds: `seedApplications(db)` then `seedDocuments(db, { put? })` (server/src/db/seed/{applications,documents}.ts; set `app.roles=system` in their own tx).

## W3-C — chat & workforce

- `ChatModule` exports `ChatService`: `ensureCaseConversation(tx, applicationId)`, `postSystem(tx, conv, kind, content, payload?, lane="client")` (seq allocated under the conversation row lock), `access(tx, conv, user)` (the one lane rule; 404 when not visible). Conversation ids accept the `cv-<CODE>` alias.
- Realtime frames (`RealtimeService.emit`, after commit, to participants + case client (client lane only) + assigned agent): `chat.message {conversation_id, message}`, `chat.message_edited`, `chat.message_deleted {message_id}`, `chat.message_pinned`, `chat.reaction {message_id, reactions}`, `chat.read`/`chat.delivered {user_id, seq}`, `chat.typing {user_id, lane}`. Mentions + "other side" messages → `NotificationsService.notify` (skipped when the recipient's realtime focus is the conversation).
- Messages: keyset by `seq` (`before|before_seq`, `after|after_seq`) on the existing unique `(conversation_id, seq)` index; edits/deletes keep prior content in `message_edits`; read/delivered receipts = one forward-only update per (conversation, user).
- Attachments: `POST /api/chat/conversations/:id/attachments` JSON `{filename,mime,size}` → row + `upload` presigned PUT (StorageService, key `u/<uid>/chat/…`, `scan_status=pending`); multipart `file` ≤10 MB still accepted for the current web client. shortcut: no DocumentsService yet; switch to it when W3-A lands.
- Disputes are ops `ticket` records (`ops_records` kind `ticket`, id `tkt:<TKT-ref>`, `data.kind="dispute"`, `disputeId="dsp-<ref>"`) — same shape as ops.manage `Ticket`; claims are `ops_records` kind `conv_claim` id `cc:<conversationId>`.
- Transcript (`…/transcript.pdf?format=pdf|csv&include_internal=true`) needs `x-step-up-token` for internal notes; PDF is a dependency-free text PDF (`textPdf`).
- `WorkforceModule` (`/api/staff/workers*`) exports `WorkforceService`; facts in `ops_records` `wf_worker` (`wf:<userId>`, `privateEnc` = CryptoService ciphertext) and `wf_review`; reads `work_ext` / `offer` records of the work/ops modules. Invites reuse `AuthService.issueResetToken(tx, user, 7d)`.
- Seeds: `seedChat(db)` (global templates), `seedWorkforce(db)` (wf_worker + one review; after seedOps).

## Wave 3 integration (conductor)

- Migration 0007 `rls_readers`: `staff:executive` SELECT-only on `applications`, `client_documents`, `conversation_participants`; SECURITY DEFINER `service_active_counts() → (service_id, structure_version_id, n)` (non-terminal cases, used by catalogue) and `conversation_member_ids(conv) → setof varchar` (active participants, used by chat realtime fan-out).
- `@/domain/crypto` (server-only, node:crypto): `key32, encrypt(key, plain), decrypt(key, cipher), blindIndex(key, v)`; `CryptoService` delegates to it (same `v1:` format).
- Seed runner `pnpm --dir server db:seed` (`server/src/db/seed/index.ts`, needs DATABASE_URL + FIELD_KEY): one tx as `system`; wave 4/5 seeds go in its marked slot. `seedWorkforce(db, { encrypt })` now fills `privateEnc`.
- Env `TURNSTILE_SECRET_KEY?`: booking captcha fails closed in production without it; dev without it accepts `mock-ok` only.
- `POST /api/documents/:id/complete` (auth user; library doc, case document or chat attachment the caller uploaded): 409 `upload_missing` if the object is not there, else enqueues `documents.finalize` now (`{status:"finalizing"}`; `"done"` when the delayed run already happened). The delayed job stays as fallback. `FinalizeJob` gained `{ kind: "chat", id }`; chat attachments now go through `documents.finalize` (rejected → `scan_status=infected`).
- `AuthService.issueResetToken(tx, u, ttlS, purpose = "reset" | "invite")`: `"invite"` writes an invite-purpose token with invite wording (workforce + system staff invites use it).
- **Placeholder jobs wave 5 must take over** (delete the booking placeholder in `booking/booking.jobs.ts` when registering the real handler; job names must stay unique): `booking.refund_requested` → finance; `booking.lead_captured` → marketing CRM. No other placeholders exist.

## W4-D — cms & reports

- `CmsModule` exports `CmsService`; worker `CmsWorkerModule`. 35 reference routes (`admin/cms/*` 33 + `content/entries` + `contact`) + new public `GET content/manifest` (`{pages:[{path,type,locale,updatedAt,noindex}], redirects:[{from,to,code}]}` for proxy/sitemap), `GET content/rss?locale=` (`{locale, items}` newest 50, web renders XML), `GET content/preview?token=` (`{entry, lang}`), `POST content/not-found {path}` (feeds the 404 log).
- Public reads cached in `PublicCache` namespace `"cms"` (added to `CacheNs`). Every publishing write adds outbox `cms.revalidate {tags}` in its tx and busts the cache after commit; cron `cms.sweep-schedule` (every minute) publishes due schedules / stales overdue regulatory updates.
- Revalidate webhook (job): `POST <first WEB_ORIGIN>/hooks/revalidate` body `{tags}`, header `x-revalidate-signature: t=<ms>,v1=<hex HMAC-SHA256(REVALIDATE_SECRET, "<t>.<body>")>` — **web must implement** the route (verify + replay window, then `revalidateTag`). Optional env `REVALIDATE_SECRET` (≥32 chars; unset → job logs and skips).
- Preview tokens = `CryptoService.encrypt({id,l,exp})` base64url, 15 min (no separate secret).
- Contact form mail reuses `auth.mail` (sealed). shortcut: CRM lead capture lands with marketing.
- Seed: `seedCms(db)` in server/src/db/seed/cms.ts (imports web content `pages/{ld,lb}.ts` by relative path) — Conductor: add to seed/index.ts.
- `ReportsModule` exports `ReportsService` (`catalog/report/drill/startExport/exportJob` + `overview/cashPosition/journalPreview/journalExport` for finance); worker `ReportsWorkerModule`. 5 routes `reports/*` (staff:finance, staff:executive). Exports: outbox `reports.export {id}` on `bulk` → CSV via `StorageService.putObject` → notification (kind `report`); `GET reports/exports/:id` presigns per read. Cron `reports.scheduled` Mon 06:00 (weekly fin.revenue CSV to finance users). Reads `finance_records` through `reports.store.ts` (shortcut: switch to finance module exports).

## W4-A — field (modules/field)

- `FieldModule` exports `FieldService`; worker side `FieldWorkerModule`. 46 routes = reference table (`/api/field/*`, `/api/x_field/*`, `POST /api/finance/cash/:id/confirm`, `POST /api/staff/cases/:code/visits`).
- `FieldService.officeEdit(visitId, { windowStart?, windowEnd?, address?, status?: "cancelled", cancelledReason?, note? })` — the only office-side visit edit (ops reschedule/readdress/cancel); bumps `office_version` so stale agent ops conflict.
- Offline sync = the per-route agent writes (web `lib/field/sync.ts` op map). Replay by `(user, client_op_id)` in `field_ops` (+ Idempotency-Key); `base_version < office_version` → 409 `field_conflict`, `data.conflict = ConflictPayload` (office state, mine, autoMerged, needsReview); `resolution:"escalate"` files a `field_conflicts` row for SM review.
- Rules from `@/domain/field/rules` (decideExpense SoD, confirmCash 4-eyes, cashEscalated/cashNeedsTwo, fieldShare/withholding, overCap); check-in radius/accuracy = `field_settings` over `FIELD_POLICY`.
- Media: agent bodies carry data URLs (offline outbox) → `StorageService.putObject` under `field/<visitId|u-<uid>>/…` + outbox `storage.scan {key}`; served by `GET /api/x_field/media?key=` (302 presigned, owner/office check).
- Outbox jobs: `field.receipt.pdf {receiptId}`, `field.scan.assemble {scanId}`; cron `field.cash.escalate` hourly. Client OTP / client-absent SMS reuse `auth.sms` (sealed `text`). Notifications via `NotificationsService.notify` (`field.incident`, `field.expense.decided`, `wrk.visit_scheduled`, `field.cash.escalated`).
- shortcut: `POST x_field/visits/:id/momo` validates then answers 503 `unavailable` until the payments module (Wave 5) exposes reserve/initiate/settle; status/cancel read `field_momo` + `payments`.
- Seed: `seedField(db, { encrypt })` in server/src/db/seed/field.ts (after seedAuth).
- Conductor: move the pure parts of `web/src/lib/field/{geo,minimise}.ts` (`distanceM`, `checkinFlags`, `minimiseContact`) to `@/domain/field/`; field.service.ts holds a marked copy until then.

## W4-B — work (external agents, /join)

- `WorkModule` (modules/work; imports AuthModule, OpsModule, WorkforceModule) — 52 reference routes: `public/x/applications*` (join + OTP cookie `hebuza_join`), `ops/x/applications*`, `work/x/*`, `agent/x/offers/:id/counter`, `agent/x/cases/:code/{documents/:id/download,instructions,handback}`, `staff/workers/:id/*`, `staff/work/*`. Worker: `WorkWorkerModule` crons `work.licence.monthly` (`0 4 21 * *`), `work.credentials.sweep` (`30 0 * * *`).
- Plain functions over a `Tx` (no Nest deps), import from `modules/work/work.service`:
  - **Workforce (W3-C) must call, inside its tx:** `onExternalCreated(tx, uid, email)` after creating an external (opens `work_ext`, attaches a pending firm invite for that email), `onExternalStatus(tx, uid, to)` on status change of an external (replaces its raw `jsonb ||` status patch; terminated → ends all job scopes). Import the file, not WorkModule (WorkModule imports WorkforceModule).
  - Agent module hooks: `externalBlock(db, uid) → External` (summary.external), `assertCanAccept(db, uid, slug)` (offer accept), `assertCanDeliver(db, uid, ref, size)` (deliverable upload), `endAccess(ctx, uid, ref, unassign)` (ops reassign), `endAllAccess(db, uid, reason)`.
- Records (ops_records kinds): `work_ext` (`wx:<uid>`, state = WorkerStatus; `saveExt` mirrors status into `agent_profiles.clearance`), `work_firm`, `work_rates` (`wr:<owner>`), `work_scope`, `work_instr`, `work_access`, `work_app`, `work_seq`. Onboarding PII = `CryptoService.encrypt`.
- /join approval provisions via `WorkforceService.create` (own tx; reuses an existing ext:agent with that email on retry). Mail = sealed `auth.mail` outbox. Statement/contract/licence files = `textPdf` (chat) / CSV, no react-pdf.
- Reads finance payout batches from `finance_records` kind `batch` (`lines[].{workerId,status,method,destination.masked,providerRef,net}`) — finance keep that shape.
- Seed: `seedWork(db, { encrypt })` in server/src/db/seed/work.ts — run after seedWorkforce (Conductor: add the step to seed/index.ts).

## W4-C — agent workspace (modules/agent)

- `AgentModule` (HTTP only; imports OpsModule, DocumentsModule, ChatModule). 68 routes = 61 reference (`/api/agent/...`, `/api/agent/x/...`, public `GET /api/agent/ics/:token`) + openapi extras `POST agent/cases/:code/documents` (scope check → `DocumentsService.uploadCase`), `GET|PUT agent/settings`, `PATCH agent/profile`, `GET|POST agent/papers`, `GET agent/papers/:id/file` (302).
- Service = plain functions over the OpsRunner tx (`agent.service.ts`); injected services via `Deps { apps, chat, storage }`. Row scope: `myCase` (lead or helper; ex-assignee read-only 409 `reassigned`; else 404 `not_assigned`; externals via work `scoped()`).
- Agent status moves (`PATCH agent/cases/:code/status`, QC "move", submit-review) go through `ApplicationsService.transition(…, "assignee", facts)`. Offer accept/undo and the no-review auto-release still write the status directly (no machine rule for them).
- Uploads are JSON + presigned PUT: deliverables `{slot,name,size,type}` → `upload`, papers `{kind,filename,mime,size}` → `upload`. Papers are `ops_records` kind `agent_paper` (id `pp_…`, ownerId); settings live in `agent_profiles.ws.settings` (bank account stored as last 4 only).
- Copies of web `lib/agent/core` (`agentMoves, groupOf, CONFLICTS, DECLINE_REASONS`) and `shareOf` in `agent.lib.ts`; external guards re-exported from `modules/work/work.service`.
- Seed: `seedAgent(db)` (server/src/db/seed/agent.ts; after seedOps/seedWork).

## W5-A — ledger & payments

- `LedgerModule` (modules/ledger) exports `LedgerService` — **the only writer of `ledger_journals`/`ledger_entries`** (payments, finance, procurement call it inside their own tx):
  `post(tx, { sourceType, sourceId, memo, lines: {account, debit?, credit?}[], occurredAt?, createdBy?, reversesId? }) → { id, created }` — compacts lines, asserts ≥2 lines, one positive side each, whole RWF (`Number.isSafeInteger`), debits = credits; locks the Kigali-month period `FOR SHARE` (closed → 409 `period_locked`); idempotent on `(sourceType, sourceId)`. `reverse(tx, journalId, memo, by)` (mirror, dated now, idempotent), `journalOf(tx, type, id)`, `balance(tx, code)`, `trialBalance(tx)`, `closePeriod(tx, id, by)` (FOR UPDATE), `reopenPeriod(tx, id)`. No update/delete API: posted lines are corrected by reversal only.
  Pure exports: `ACCOUNTS` (full chart incl. finance codes 1200/2250/2350/4300/6100 + 1130 Airtel; upserted on boot), `cashAccount(method)`, `dr/cr` (signed), `assertBalanced`, `compact`, `periodOf`. `ledger.postings.ts`: `postInvoice/postCreditNote/postPayment/postCreditApplied/reverse/postRefund/postAllocation/postPayoutLine(ledger, tx, …)` (finance reference shapes; finance should use these, not re-implement).
- `PaymentsModule` (HTTP; exports `PaymentsService` + `LedgerModule`), worker `PaymentsWorkerModule`. 12 routes: reference 10 (`payments/initiate`, `payments/:transaction_id/status`, `payments/bank-transfer`, `applications/:code/payment/receipt`, `payments/webhooks/{momo,flutterwave}`, `me/invoices`, `me/receipts`, `GET|DELETE me/payment-methods[/:id]`) + `GET payments/:transaction_id` (status alias). No payments refund route: every refund is a finance.refunds record (4-eyes) → `disburseRefund` (capped at payment − earlier cash refunds, refund no = gateway idempotency key).
- `PaymentsService`: `initiate`, `initiateField({agentId, visitId, code, invoiceNo, phone: "2507…", amount})` (field MoMo; 409 `payment_in_progress` data `{id,state}`), `settle(txId, status, actorId, from?)` (**only payment status writer**: row lock, terminal once, journal + split + audit + outbox in one tx), `reconcile`, `reconcileSweep`, `decideBankTransfer(paymentId, approve, actorId, makerId?)` (actor ≠ maker; outbox `finance.bank_transfer.decide` from finance confirm (chain complete)/reject → settle with `from: "pending_verification"`). `declareBankTransfer` also writes the finance `payment` queue record (`gatewayPaymentId`, workflow only). Pure: `paymentLines`, `vatOf`, `splitAmounts`.
- Money txs: SERIALIZABLE, retried 3× on 40001/40P01, role `system` (payments RLS) — authorisation is enforced in code before every write. shortcut: private runner in PaymentsService until `TxService` takes an isolation option (Conductor).
- Providers (`PaymentsProvider`, driver interface `PaymentDriver`): MTN MoMo, Airtel Money, Flutterwave; a method without keys → `stub` (settles at once) only when `PAYMENTS_STUB=true` (default false), else 503 `unavailable`.
- Webhooks (`@Webhook()`): momo = callback URL `?sig=HMAC-SHA256(PAYMENTS_WEBHOOK_SECRET, transactionId)` (missing secret fails closed unless `PAYMENTS_STUB=true`) then status re-read from MTN; flutterwave = `verif-hash` == `FLUTTERWAVE_WEBHOOK_SECRET` (fail closed), `data.created_at` required and within 72 h, amount/currency must cover, success re-confirmed via `fetchStatus` (verify API). Replays: unique `(provider, event_key)` in `payment_webhook_events`. Booking ids (`bkp…`) → outbox `payment.settled {transactionId, booking:true}`.
- Outbox: `payment.settled` `{ transactionId, paymentId, applicationCode, planId, clientId, paidAt, realtime }` (queue critical) — consumer `PaymentsJobs` (booking → `BookingService.settle`; plan → `SubscriptionsService.activateFromPayment`, idempotent). `payment.refunded` `{transactionId, paymentId, amount}` — no consumer yet (finance may take the name). Jobs: `payments.reconcile` (delayed 2 min, jobId `rec_<tx>`), crons `payments.reconcile-sweep` */5, `ledger.trial-balance` 03:00.
- **Cash single source of truth**: gateway/client payments (`payments` table) post only via `PaymentsService.settle` (sourceType `payment`); finance manual bank/cash records post only via finance (`fin_payment`). Finance never posts a `gatewayPaymentId` record, refuses a manual payment whose reference is on `payments`, and can't reverse gateway cash (use finance.refunds). `post()` helper: 0 non-zero lines → null (no journal), 1 → throws.
- Partial (field) payments lower `applications.payment_amount`; the case flips to `paid` when nothing is left. Duplicate payment on a paid case → journal to 2400 refund-due, no revenue.
- Env (Conductor: add to `Env`, all optional): `MTN_MOMO_SUBSCRIPTION_KEY, MTN_MOMO_API_USER, MTN_MOMO_API_KEY, MTN_MOMO_TARGET_ENVIRONMENT, AIRTEL_CLIENT_ID, AIRTEL_CLIENT_SECRET, AIRTEL_BASE_URL, FLUTTERWAVE_SECRET_KEY, FLUTTERWAVE_WEBHOOK_SECRET, PAYMENTS_WEBHOOK_SECRET, API_PUBLIC_URL`.
- Seed: `seedPayments(db)` in server/src/db/seed/payments.ts (after seedApplications) — Conductor: add to seed/index.ts.

## W5-C — procurement (modules/procurement)

- `ProcurementModule` (HTTP; imports LedgerModule) exports `ProcurementStore`; worker `ProcurementWorkerModule`. 75 routes = 73 reference (`/api/procurement/*`) + `GET purchase-orders/:no/pdf` (302; 409 `pdf_pending` until rendered) + `GET vendors/:id/documents/:docId/file` (302).
- Runtime store engine kept (`procurement.world.ts` over `procurement_records`, like system.world): one advisory lock per write; state + audit + outbox + ledger journals commit in one tx. Step-up (`x-step-up-token`) checked in `write(…, { stepUp })` for approvals/money.
- Secrets: vendor TIN / bank numbers = `kind:"secret"` docs `{ enc: CryptoService.encrypt, hash: CryptoService.blindIndex }` (duplicate TIN lookup by blind index). Lists carry masked values only.
- Ledger (`LedgerService.post`, sourceType `procurement`): bill approve Dr 5200/Cr 2150; payment Dr 2150/Cr `cashAccount(method)`; advance applied Dr 2150/Cr 1300; void reverses approval + applied advances. Accounts 1300/2150/5200 inserted by `ProcurementStore.onApplicationBootstrap` — W5-A: adopt into `ACCOUNTS` and delete that hook. shortcut: deposit/advance payout + return/forfeit not posted (reference has no payout event).
- Mail = sealed `auth.mail` outbox (PO to supplier, remittance, statement, delivery chase). Outbox `procurement.po.pdf {no}` (on PO send) → text PDF in `procurement/po/<no>-v<version>.pdf`. Vendor documents: body `{filename,mime,size}` → response `upload` (presigned PUT, key `u/<uid>/procurement/…`) + delayed `storage.scan`.
- Crons: `procurement.daily` 05:00 UTC (contract reminders), `procurement.recurring_bills` `0 4 20 * *`.
- Pure rules/types copied from web `lib/procurement/{rules,types}` into `modules/procurement/lib/` — Conductor: move to `@/domain/procurement`.
- Seed: `seedProcurement(db, { encrypt, blind })` in server/src/db/seed/procurement.ts (after seedAuth) — Conductor: add to seed/index.ts (`blind` = `blindIndex(key32(BLIND_INDEX_KEY), v)`).

## W5-D — marketing (modules/marketing)

- `MarketingModule` (HTTP; controllers crm / campaigns / insights) + `MarketingWorkerModule`. 77 routes = 74 reference (`leads`, `admin/crm/*`, `admin/mkt/*`, `admin/notification-templates*`, `admin/fbk/*`, `admin/cms/media*`, `media/:id`, `admin/reports/export`) + new public `GET links/c/:code`, `GET links/r/:code` → `{ url }` (click counted by outbox `marketing.link_click` on `bulk`, never blocks; errors → web home) and `POST marketing/unsubscribe {token}`.
- **Web must**: switch `next.config` `/r/:code` and `/c/:code` redirects to a route handler that calls those endpoints and 302s to `url`; add an `/unsubscribe?token=` page that POSTs the token.
- Service = reference plain functions over `Caller = { db: Tx, session, ip, req, audits }` (`marketing.store.ts`); `MarketingRunner.run(req|null, c => …)` runs one in `TxService.run` and writes the domain audit rows (`record(c, …)`) with `AuditService` at the end of the tx; system callers without a collector go through outbox `marketing.audit`.
- `captureFrom(tx, "contact_form"|"booking", { name, contact?|phone?, email?, service? })` (marketing.crm.ts, plain function, call inside your tx) — the one CRM lead capture for other modules (cms contact form uses it). Worker consumes `booking.lead_captured` (booking placeholder deleted).
- Campaign sends: cron `mkt.campaign-send` (every minute) re-checks consent per recipient (contact channel consent `in`, not suppressed, has address, and for client contacts the account consent `system_records acct <uid>:consents.marketing === true`) then adds one outbox `marketing.send {campaignId, contactId}` on `bulk` per recipient; the job checks again and sends with an unsubscribe link (`<web>/unsubscribe?token=`, token = `CryptoService.encrypt` JSON base64url, no expiry). Sequences: `mkt.sequence-run` → `marketing.sequence_send` (bulk). Also `marketing.test_send`, `marketing.reply`; crons `mkt.conversion-sweep`, `mkt.contact-sync`, `mkt.link-check`, `mkt.lead-retention`.
- Optional env (ConfigService, untyped): `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` (unset → WhatsApp sends logged). Conductor: add to `Env`.
- `lib/*` = copies of pure `web/src/lib/marketing/*` (segment, consent, cost, approval, automation, export, lead-machine, dedupe, conversion, referral, reports, quiet-hours) + `lib/crm-types.ts`; Conductor may move them to `@/domain/marketing/`.
- Seed: `seedMarketing(db)` in server/src/db/seed/marketing.ts (after seedAuth) — Conductor: add the step to seed/index.ts.

## W5-B — finance (modules/finance)

- `FinanceModule` (HTTP; imports LedgerModule, ReportsModule) exports `FinRunner`; worker `FinanceWorkerModule`. 110 routes = reference 114 endpoints of `finance.routes` (action fan-outs `statements/lines/:id/:action`, `revenue/allocations/:id/:action` (non-approve), `revenue/rules/:id/:decision` served by one param route each, enum-checked → 404) + the 5 client routes from account (`GET me/quotations`, `POST me/quotations/:no/accept|decline`, `GET me/refunds/eligibility`, `GET|POST me/refunds`). Controllers: core (summary/approvals inbox/settings incl. VAT + numbering series/accounts/history/overview/journal), billing (quotes, invoices, receivables), payments (manual 4-eyes confirm, statements, periods), refunds (+ credit notes), revenue (allocations, rules, adjustments, fees, payouts), client.
- Service = reference plain functions over `Fin = { db, me, S (effective settings), D (party directory), rec, audits, deps }` (`finance.store.ts` `open(db, user, deps)`). `FinRunner.write(fn)` = SERIALIZABLE tx (RLS GUCs, retried 3× on 40001/40P01); `read(fn)` = `TxService.run`. `f.rec(...)` buffers `financial.<action>` / `config.<action>` entries written by `AuditService.record` as the last statements of the same tx. Maker-checker pending answers → `accepted(data)` → HTTP 202 (`AcceptedInterceptor`).
- Ledger: every settle/issue/credit/refund/allocation/payout posts through W5-A `ledger.postings.ts` (`f.deps.ledger`) inside the request tx.
- Read helpers for other modules (import the file, no Nest deps): `finance.store` `all/where/one/byRef/put/nextNo/settings/directory/syncParty` + types `Settings, Directory`; `finance.billing` `Inv`; `finance.revenue` `Alloc, Batch`. `reports.store.ts` now re-exports these (its duplicates deleted).
- Outbox/jobs: consumes `booking.refund_requested` (booking placeholder deleted) → refund record `RFD-…` (caseRef/invoiceNo = booking reference; `credit` → `completed_as_credit`, `refund` → `executing` + disburse). `finance.refund.disburse {no}`; crons `finance.refunds.sweep` */5, `finance.payments.sweep` */5, `finance.settings.apply` 22:05 UTC (00:05 Kigali). Invoice reminder mail = sealed `auth.mail` (runAt = quiet-hours end).
- shortcut: disbursement provider not wired — executing refunds fail safely (`execution_failed`, no money moved) whether or not `MTN_MOMO_*` are set; pay by bank with a proof. `payment.refunded` (W5-A) not consumed yet.
- Pure copies of web `lib/finance/{approvals,csv,money,numbering,recon,states}` + view types of `{b,c,d,e,f}.ts` in `modules/finance/lib/` — Conductor: move to `@/domain/finance/` (ageing/journal already there).
- Seed: `seedFinance(db, { encrypt })` in server/src/db/seed/finance.ts (JSON snapshot of the web finance mock world; after seedAuth) — Conductor: add to seed/index.ts.

## W6 — assistant (modules/assistant)

- `AssistantModule` (HTTP; imports Catalogue/Booking/Chat) exports `AssistantService`; worker `AssistantWorkerModule`. 22 routes = reference table (`assistant/status|sessions|sessions/:id/{messages,tool-answers,rating,handoff,lead}|drafts/:id|copilot/:kind`, `admin/kb-sources[/:id|/reindex[/:job]]`, `admin/assistant/{sessions[/:id],unanswered,evals/runs,evals/run,settings,handoffs[/:id/claim]}`). `messages`/`tool-answers` are SSE (`@RawResponse`, events meta/delta/citation/tool_card/notice/handoff/done/error); `status` adds `aiAvailable` (false without `ANTHROPIC_API_KEY` → KB-passage answers only, copilot deterministic text).
- Engine (`assistant.engine.ts`, plain functions over `Deps { run, services, types, slots, chat, ai }`): deterministic intent router as reference; knowledge path = FTS over `ai_kb_chunks` + Claude (`AI_MODEL`, default `claude-sonnet-5-5`, effort low, prompt cache on system+tools and the `<sources>` block) with 3 Zod-validated read tools: `find_services` (public catalogue), `booking_availability` (public slots), `application_status` (applications `track()` = public tracker definer fn). PII masked (`maskPii`) before storage and before the model; KB/user text in delimited data blocks. No DB tx is held across a model call.
- Budgets: monthly USD cap (`ai_settings.budget_usd` vs session cost), Redis `ai:tok:<day>` global daily tokens (`AI_DAILY_TOKEN_BUDGET`), Redis per-IP daily messages (`per_ip_daily`), per-session tokens (`AI_SESSION_TOKEN_BUDGET`, from `ai_sessions.tokens_*`), one stream per session (`ai:stream:<id>`). Copilot + evals use `AI_FAST_MODEL` (default `claude-haiku-5-5`).
- Handoff: `ai_handoffs` row (staff queue) + for portal clients with a case a staff-only system note in the case conversation (`ChatService.ensureCaseConversation/postSystem`). Lead → marketing `captureFrom(tx, "contact_form", …)` (shortcut: add an `"assistant"` source to captureFrom).
- Reindex: outbox `assistant.reindex {jobId}` (bulk) → one short tx per source id: own `ai_kb_sources`, `cms-<entryId>` (AI-approved, live locales), `svc-<slug>` (published catalogue services). Crons: `assistant.reindex-nightly` 02:15, `assistant.retention` 02:30, `assistant.stale` 06:00, `assistant.evals.weekly` Mon 05:00 (rolled-back tx).
- Env (added): `AI_MODEL`, `AI_FAST_MODEL`, `AI_DAILY_TOKEN_BUDGET`, `AI_SESSION_TOKEN_BUDGET`.
- Seed: `seedAssistant(db)` in server/src/db/seed/assistant.ts (after seedAuth) — Conductor: add to seed/index.ts.
- Schema needs (no migration written): `ai_kb_chunks.embedding vector(1024)` + ivfflat/hnsw index (only when pgvector exists and an embedding provider is chosen); `ai_usage` (or a cost column) if copilot spend must count toward the monthly USD cap.

## W5 integration (Conductor)

- `TxService.run(fn, { isolation: "serializable" })`, `runAsSystem(fn, opts)` (retry 40001/40P01 ×3); `runMoney(fn)` = SERIALIZABLE as role `system`, HTTP allowed (payments only; authorise in code first). Payments/finance private runners deleted.
- Migrations: 0009 `ledger_guards` (append-only triggers on ledger_journals/entries, only `created_by → NULL` allowed; deferred constraint triggers: every journal ≥2 lines, debits = credits at commit), 0010 `marketing_readers` (`marketing_client_cases(client)`, `marketing_request_count(from, to?)`, SECURITY DEFINER, role-gated), 0011 `scan_status` on application_documents, client_document_versions, field_scans (default `pending`).
- `ACCOUNTS` adds 1300/2150/5200 (procurement) + 5210 deposit deductions/forfeits; procurement boot hook deleted. Deposits: placed Dr 1300/Cr 2150, returned Dr bank/Cr 1300, deductions + forfeit Dr 5210/Cr 1300 (cash payout leg still unposted: no event).
- Booking pay → `PaymentsService.initiateBooking` / `bookingStatus` (same drivers, stub, callbacks); booking keeps its bkg_payments row and settle.
- Refunds: `finance.refund.disburse` = claim (tx) → `PaymentsService.disburseRefund` (Flutterwave gateway refund; MoMo/Airtel/bank → `manual`) → `refunded` + postRefund, or `execution_failed` with the reason. Stale claims (>15 min) → `execution_failed` "outcome unknown". `payment.refunded` removed (no staff refund route).
- AuditService writes `details.actorName` (one users lookup per tx per actor).
- `storage.scan` updates scan_status for kinds chat/case/library/field; library, case (work) and field scan downloads answer 410 `quarantined` when infected.
- Domain: `@/domain/finance/{approvals,csv,money,numbering,recon,states}`, `procurement/{rules,types}`, `marketing/{approval,automation,consent,conversion,cost,dedupe,export,lead-machine,quiet-hours,referral,reports,segment}`; web keeps thin wrappers only for UI extras (finance money/states, marketing export).
- Env: payments drivers, webhook secrets, `API_PUBLIC_URL` (also agent ICS feed base), WhatsApp keys typed in `Env`. Seed: payments → finance → procurement (BLIND_INDEX_KEY now required) → marketing.
