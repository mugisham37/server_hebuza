# HEBUZA security

## Threat model (summary)

| Asset                             | Threats                                                   | Primary controls                                                                                                                                                                                                                   |
| --------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client case data, documents, PII  | IDOR across clients, staff over-reach, bulk scraping      | Per-route role/permission guard (`@Route` auth + `Permit` MATRIX), service-level ownership/scope checks, Postgres RLS (FORCE RLS, request GUCs), field-level encryption + blind indexes                                            |
| Accounts / sessions               | credential stuffing, OTP brute force, session theft, CSRF | argon2 hashes, 10/min per-IP auth limiter (Redis), account lockout, OTP attempt cap (5, then burned), TOTP with replay guard for all staff, httpOnly cookies + Origin-checked CSRF guard, step-up tokens for sensitive permissions |
| Money (payments, payouts, ledger) | forged gateway callbacks, double submission, tampering    | HMAC-verified webhooks (fail closed; prod boot refuses the stub), Idempotency-Key on money/chat writes (same key+body → same response, different body → 409), balanced-ledger DB trigger, audit log                                |
| Staff impersonation               | abuse of view-as                                          | sysadmin only + step-up, time-boxed, audited, **read-only** (every non-GET → 403 `impersonation_read_only`)                                                                                                                        |
| Uploads                           | malware, oversized payloads                               | presigned uploads, ClamAV quarantine, 1 MB JSON body limit (413 envelope; 40 MB only on field routes), multipart limits                                                                                                            |
| Platform                          | XSS/clickjacking, supply chain, leaked secrets            | helmet, HSTS/XFO/CSP (enforced, see below), `pnpm audit` in CI, no secrets in git (`.env*` ignored), distroless non-root images                                                                                                  |

Trust boundaries: browser → web (Next proxy) → api; gateways → api webhooks; api/worker → Postgres/Redis/S3/providers.
`TRUST_PROXY` must equal the real proxy hop count or client IPs (and thus rate limits) become spoofable.

## Two-factor sign-in (2026-11-23)

TOTP is optional for every role. Setting `security.mfa_staff` = `suggested` (default) | `required` (sysadmin, approval). Users with 2FA on are challenged at sign-in (trusted devices skipped except finance/sysadmin); others get a suggestion (`GET auth/mfa/status` → `suggest`, `POST auth/mfa/snooze` hides it until the next password sign-in). `required` sets the `mfa_required` claim for un-enrolled team/ext-agent accounts and the web proxy forces setup. Step-up uses the TOTP code when enrolled, else the account password (audited `auth.step_up`, `after.method`). `POST auth/mfa/disable` needs a code or the password.

## Pen-test checklist (P8.6)

- [x] Authz matrix: every route × every persona (automated, below). - [x] IDOR on every single-`:id` GET with real ids.
- [x] Rate limit, OTP cap, idempotency, webhook signature, body limit, CSRF, view-as (automated, below).
- [x] Dependency audit, secret scan (below). - [x] OWASP ZAP baseline workflow (`web/.github/workflows/zap-baseline.yml`, run it against staging). - [x] Enforce CSP.
- [ ] External pen test before GA. - [ ] Restore drill (RUNBOOK §Backups).

## Results — Phase 8.5 (2026-11-18, local stack)

**Authz matrix** (`server/test/authz/matrix.ts`; oracle = live decorator metadata, not a hand list):
892 routes × 14 personas + anonymous = 10 816 requests; plus a client sweep of every GET on staff surfaces and an IDOR
replay (36 of client A's real ids × every single-param GET, 104 readable pairs replayed as client B).
Final: **0 violations** (no 5xx, anonymous always 401 on non-public, denied roles always 403, no cross-client reads).
773 "allowed by metadata but 403" are service-level role checks (`forbidden_role`, `not_field_agent`, `not_shared`) —
defence in depth, not holes. Public by design: `/track/:code` (status only; the code is the secret), `/links/c|r/:code`.

Bugs found and fixed (root cause in api):

1. **Every request validation error returned 500** (all routes): `nestjs-zod` pulls in `@nest-zod/z`, which installs a
   zod-3 global error map that throws under zod 4. Reset in `core/http/dto.ts` → proper 422 envelopes.
2. **Field-agent surface open to any signed-in user** (24 routes in `field.controller.ts` used `auth: "user"`, incl.
   scan/receipt PDFs, MoMo start, cash list, OTP): now `FIELD` roles (internal/external agents + service managers).
3. `GET /api/public/x/applications/services` (public /join) 500 for anonymous callers: `OpsRunner` assumed a session.
4. `GET /api/admin/clients/:id` 500 for unknown ids (guest fallback read `personalInfo` of a stub) → 404.
5. Production boot now refuses `PAYMENTS_STUB=true` or a missing `PAYMENTS_WEBHOOK_SECRET` (unsigned MoMo callbacks).

Noted, not changed: `/api/admin/public-holidays` is readable by clients (public reference data). `/api/reports/exec-summary`
returned 404 for finance mid-run while that module was being edited by another stream — re-check after 8.4 lands.

**Abuse checks** (`server/test/authz/abuse.ts`): login 11th attempt → 429 ✔; OTP wrong codes capped then burned (410) ✔;
idempotent replay identical (201/201) ✔, same key + different body → 409 ✔, missing key → 400 ✔; Flutterwave bad
signature → 401 ✔; MoMo bad signature accepted **only** because local `PAYMENTS_STUB=true` (prod boot now refuses it);
2 MB body → 413 envelope ✔; foreign Origin POST → 403 `csrf` ✔; view-as write → 403 `impersonation_read_only` ✔.

**Dependencies**: `pnpm audit --prod` had 4 high (sharp <0.35.5: libvips/libheif/librsvg; drizzle-orm <0.45.2: SQL
injection via identifier escaping). Upgraded `sharp` ^0.35.5 and `drizzle-orm` ^0.45.2 → **0 known vulnerabilities**; tsc clean.

**Secrets**: gitleaks/trufflehog not installed; regex scan of the tree and full git history for private keys, AWS/
Anthropic/GitHub/Slack/Resend/Flutterwave key shapes → no hits. `.env` files are git-ignored; committed `*.env.example`
hold placeholders only. Seed credentials (`server/src/db/seed/auth.ts`) are public demo values by design — the seed
refuses `NODE_ENV=production`.

**Load** (`server/test/load.ts`, 20 concurrent, 15 s, single API process, local): `GET /services` p95 186 ms (127 rps,
CPU-bound on a 120 KB unpaginated payload — cache at the edge); `GET /services/:slug` p95 77 ms; client case list p95
52 ms; SM case list p95 115 ms; chat send p95 1.17 s at 20 concurrent writers on **one** conversation (row
serialisation; 45 ms serial). 0 errors. No sequential-scan hot spots on non-trivial tables, so no index migration needed.

## Content-Security-Policy (F-SEC-04)

Enforced in `web/next.config.ts`. `script-src` keeps `'unsafe-inline'` on purpose:

- **Nonces don't fit this app.** Next only stamps nonces on per-request renders; the web app uses `cacheComponents` +
  partial prerendering, so the prerendered shell's inline scripts would carry no nonce and be blocked site-wide. Moving
  every page to dynamic rendering costs TTFB/CPU on low-bandwidth users for little gain.
- **Hashes aren't trivially safe either.** Next's inline bootstrap/flight scripts change per build and per route
  (streamed RSC payloads), and the Meta pixel/GTM snippets carry the pixel id; a hash list would need regenerating on
  every deploy and any miss blanks a page.
- **What limits the risk instead:** no `eval` in production, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`,
  `frame-ancestors 'none'`, an explicit host allowlist for scripts/frames/connect, React escaping everywhere,
  JSON-LD is serialised with `JSON.stringify` (data blocks are not executed), and no `dangerouslySetInnerHTML` with user
  content.
- **Upgrade path:** when the public pages no longer need prerendering, or Next ships nonces for prerendered output,
  switch `script-src` to `'nonce-…' 'strict-dynamic'` in `web/proxy.ts` and drop `'unsafe-inline'`.
