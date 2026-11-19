# Audit D — assignment/workload, workforce, partners, CRM, settings, audit trail, cross-cutting, journeys

Date: 2026-11-19. Read-only audit of `server/src` + `web/src` against `cleanup/Project/spec`.
Paths: `S:` = `server/src/`, `W:` = `web/src/`, `WA:` = `web/src/app/[locale]/`.
Note: most module data lives in generic record tables (`ops_records`, `mkt_records`, `system_records`, `finance_records`) keyed by `kind`, not the per-entity tables the spec names. Rated on behaviour, not table names.

## Assignment & workload (ASN)

| ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| F-ASN-01 | Manual assign | P1 | DONE | S:modules/ops/ops.assign.controller.ts:27, ops.cases.ts:366 `assign()`; brief/instructions :67/:72; WA:(ops)/ops/assign/[ref]/page.tsx |
| F-ASN-02 | Match suggestions | P1 | DONE | S:domain/ops/ranking.ts:44 (score + reasons + ineligible); ops.assign.controller.ts:38; W:lib/ops/api.ts used by assign/handoff screens |
| F-ASN-03 | Offer / accept / reject / TTL | P1 | DONE | auto re-offer: autoAssign skips agents whose offer on the case timed out/was declined; the 5-min cron offers the next ranked candidate. Offers S:ops.assign.controller.ts:87/92, accept/decline S:modules/agent/agent.controller.ts:230/240, expiry cron S:modules/ops/ops.jobs.ts:16 (TTL S:domain/policy.ts:30 = 4h). Gap: timeout returns case to queue + notifies manager; no automatic re-offer to next ranked candidate |
| F-ASN-04 | Reassign / hand back | P1 | DONE | handback S:modules/work/work.controller.ts:206; reassign ops.assign.controller.ts:104; history via logEvent (ops.cases.ts:346). Chat-participant `left_reason` update not verified |
| F-ASN-05 | Availability & leave | P1 | DONE | manual assign + ranking exclude leave/off-duty; leave approval flags open cases due during the leave to the approver. S:agent.controller.ts:66 (duty), :477/:482 availability, :487-497 leave; approval sets on_leave_until S:modules/ops/ops.manage.ts:288; ranking excludes onLeave (ranking.ts:56); UI W:components/organisms/agent/calendar.tsx. Gap: manual `assign()` (ops.cases.ts:366) only checks capacity, ignores leave; on-duty toggle not used by ranking; no "open cases flagged before leave" |
| F-ASN-06 | Workload view | P1 | DONE | S:ops.oversight.controller.ts:36/41; W:components/organisms/ops/workload.tsx (table + heatmap), WA:(ops)/ops/workload/page.tsx |
| F-ASN-07 | Auto-assign rules | P2 | DONE | per-service assignMode manual|suggest|auto + score threshold (rankAgents); UI in handoff rules. S:ops.cases.ts:1536-1600 + cron ops.jobs.ts:61; per-service PUT ops.assign.controller.ts:123; UI handoff.tsx. Gap: modes are roundRobin/leastLoaded/skill, not spec `manual |suggest|auto`; no score threshold |
| F-ASN-08 | Overdue escalation 80/100/150% | P1 | DONE | verified: `ops.sla_sweep` notifies assignee at 80%, manager/SMs at 100%, executives at 150% (claimed once per step). Only breach stamping (S:ops.jobs.ts:44, S:modules/deadlines/deadlines.service.ts:279). Gap: no 80% assignee reminder, no 100% SM escalation notice, no 150% exec digest |
| F-ASN-09 | Assignment restrictions | P2 | DONE | verified from 0a6541c: assignment_blocks feed conflictWith; contract expiry enforced in ineligibleReason. ranking.ts:59 has `conflictWith`, but it is never populated (S:modules/ops/lib/store.ts:495-515); no "never assign X to Y" store; contract expiry only shown in assignContext (ops.cases.ts:1160), not enforced; manual assign bypasses all |
| F-ASN-10 | Field visit tasks | P2 | DONE | S:modules/field/field.controller.ts:81 (create visit from case), :20 day plan; WA:(agent)/agent/field |
| F-ASN-11 | Multi-assignee | P2 | DONE | lead + helpers + per-case reviewer (reviewer_id), helpers/reviewer notified; reviewer picker in assign. `helpers[]` on assign (ops.cases.ts:376). Gap: no per-case roles (reviewer/helper/lead), helpers get no access/notification path verified |
| F-ASN-12 | Instructions packet | P1 | DONE | S:work.controller.ts:187 (assignee) / :466 (staff write); permission-filtered docs :178 (audited); W:components/organisms/agent/work-scoped.tsx |

## Workforce (WRK)

| ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| F-WRK-01 | Unified worker profile | P1 | DONE | wave 5: agent_profiles is the unified worker profile + work contacts/social links (private stays shielded); partner data step in migration-notes.md. S:modules/workforce/workforce.service.ts:251/369 over `agent_profiles` (S:db/schema/schema-ops.ts:86) + `staff_profiles` + legacy `partner_profiles` (schema.ts:325); UI WA:(ops)/ops/workforce/[id]. Gap: no single `worker_profiles` table; work vs private contacts, social links not modelled |
| F-WRK-02 | Structured CV | P2 | DONE | wave 5: structured CV on staff profile, CV text searchable in the directory. cv {education, experience, expertise} in onboarding blob S:modules/agent/agent.service.ts:2526; W:components/organisms/agent/onboarding.tsx:544. Gap: not shown/searchable on staff worker profile; languages/summary not structured |
| F-WRK-03 | Qualification verification | P2 | DONE | wave 5: worker document (NDA/SLA/licence/agreement) expiry reminders 60/30/7/0. S:work.controller.ts:152-162 (credentials), staff decision :422; expiry sweep S:modules/work/work.jobs.ts:42; W:components/organisms/agent/work-credentials.tsx |
| F-WRK-04 | Engagement contracts | P2 | DONE | wave 5: `POST staff/workers/:id/contracts` versions + profile panel; worker signs in /work/contract. Worker side: S:work.controller.ts:294/348/353/358 (view/sign/renew/notice); W:work-contract.tsx. Gap: no staff endpoint/screen to create/version contracts (records only seeded, kind "contract") |
| F-WRK-05 | Expiry & renewal reminders | P2 | DONE | wave 4: `ops.contract_expiry` 60/30/7/0 to worker + SMs; expired contract already blocks assignment (ineligibleReason). Credential expiry → not_cleared (work.jobs.ts:42). Gap: no 60/30/7/0 reminders for contract/NDA/licence to worker+SM; contract expiry does not block assignment |
| F-WRK-06 | Authorised services | P1 | DONE | verified: manual assign runs ineligibleReason (ops.cases.ts assign). services[] + skill requests (agent.controller.ts:462/467); ranking `notAuthorised` (ranking.ts:51). Gap: manual assign ignores authorisation; proficiency 0–1 float, not 1–5 |
| F-WRK-07 | Rate card & share terms | P2 | DONE | wave 4: assignContext reads the finance revenue rule for the service (no hardcoded 70/30). worker request S:work.controller.ts:363, manager/finance action :487; W:lib/work/f.ts. Gap: effective-dating not verified; assignContext still uses hardcoded 70/30 (ops.cases.ts:1157) |
| F-WRK-08 | Recurring licence fees | P3 | DONE | as specified: licence fee worker→HEBUZA from the effective finance setting (reverse direction not in spec). wave 5: licence amount from the effective finance setting (no PLACEHOLDER); HEBUZA→worker direction still undefined in spec. monthly licence invoices S:work.jobs.ts:1, POLICY.licenceFeeMonthly (policy.ts:8), S:work.controller.ts:329/368. Gap: only worker→HEBUZA direction; amount is PLACEHOLDER |
| F-WRK-09 | Availability & leave | P1 | DONE | wave 5: daily intake limit (`daily_cap`) separate from concurrent cap; off-duty blocks assignment; drawer field. see F-ASN-05; daily cap S:ops.oversight.controller.ts:46. Gap: no separate max-concurrent vs daily cap; on-duty not enforced |
| F-WRK-10 | Workload view | P1 | DONE | S:ops.oversight.controller.ts:41; W:ops/workload.tsx drawer |
| F-WRK-11 | Performance KPIs | P2 | DONE | wave 5: first-pass approval, reassignment rate, 90-day earned share on staff worker profile. S:agent.controller.ts:393; W:components/organisms/agent/performance.tsx. Gap: first-pass approval, reassignment rate, revenue not all computed; no staff per-worker KPI view verified |
| F-WRK-12 | Onboarding checklist / cleared gate | P1 | DONE | verified: deliverable upload runs `gate()` (agent.service.ts uploadDeliverable); manual assign checks clearance. clearance flow S:work.controller.ts:123-147, :422; ranking `notCleared`. Gap: manual assign (ops.cases.ts:366) and deliverable upload do not check clearance (B16 not fully fixed) |
| F-WRK-13 | Suspend / terminate / reactivate | P1 | DONE | S:workforce.service.ts:480-592 (revokeAllSessions, isActive=false, reassignment wizard, audit); WA:(ops)/ops/workforce/[id]/offboard |
| F-WRK-14 | Talent directory | P2 | DONE | wave 5: web directory filters through the API. wave 4: `GET staff/workers` filters service/language/district/available/minRating/type/q. list S:workforce.controller.ts:12 (no query filters); W:lib/workforce.ts. Gap: server-side filter by service/language/district/availability/rating |
| F-WRK-15 | Private-data shield | P1 | DONE | reveal-with-reason + audit S:workforce.service.ts:373-396 (SM only) |
| F-WRK-16 | Public team profile (opt-in) | P2 | DONE | wave 5: worker opt-in (`me/team-profile`), marketing approval (/marketing/team), approved workers on /about/team. WA:(public)/about/team/page.tsx uses static `TEAM`; no opt-in field or marketing approval |
| F-WRK-17 | Field visit scheduling | P2 | DONE | S:field.controller.ts:81, :20; W:components/organisms/field/* |
| F-WRK-18 | GPS/photo check-in/out | P2 | DONE | S:field.controller.ts:26/28; flags incl. low_accuracy (S:domain/field/types.ts:8) |
| F-WRK-19 | Pickup/hand-back receipt | P2 | DONE | S:field.controller.ts:35-43, OTP :51; receipt PDF :37; custody receive :73 |
| F-WRK-20 | Offline field mode | P2 | DONE | W:lib/field/queue.ts, sync.ts, store.ts; conflicts S:field.controller.ts:64/65; outbox page |
| F-WRK-21 | Cash-collection rules | P2 | DONE | S:field.controller.ts:54/55/80; 48h escalation FIELD_POLICY (policy.ts). Per-service enable via flag `field_cash` not enforced server-side |
| F-WRK-22 | Worker earnings view | P2 | DONE | S:work.controller.ts:222-232, agent.controller.ts:342-358; W:work-earnings.tsx, work-statement.tsx |
| F-WRK-23 | Worker history | P2 | DONE | S:workforce.controller.ts:33 → workforce.service.ts:671 |
| F-WRK-24 | Rename partner → ext:agent | P1 | DONE | wave 5: ext:agent kept distinct from PRT partners; legacy partner_profiles migration SQL in migration-notes.md; /dashboard/work redirect verified. role `ext:agent` + /work workspace exist. Gap: `partner_profiles`/`partner_documents` tables and names remain (schema.ts:111/325); no redirect from `/dashboard/work` verified |

## Institutional partners (PRT)

| ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| F-PRT-01 | Partner registry | P3 | MISSING | no schema/module; WA:(partners)/partners/[[...rest]]/page.tsx renders `PlannedPage` placeholder |
| F-PRT-02 | Contact persons | P3 | MISSING | — |
| F-PRT-03 | Agreements | P3 | MISSING | — |
| F-PRT-04 | Objectives & action plans | P3 | MISSING | — |
| F-PRT-05 | Meetings | P3 | MISSING | — |
| F-PRT-06 | Correspondence & documents | P3 | MISSING | — |
| F-PRT-07 | Joint projects | P3 | MISSING | — |
| F-PRT-08 | Referrals | P3 | MISSING | CRM referrals exist (client programme only) — not partner-linked |
| F-PRT-09 | Partner revenue sharing | P3 | MISSING | — |
| F-PRT-10 | Reminders | P3 | MISSING | — |
| F-PRT-11 | Scorecard | P3 | MISSING | — |
| F-PRT-12 | Full history / PDF | P3 | MISSING | — |
| F-PRT-13 | Public partner logos | P3 | PARTIAL | static strip only (as before); no `shown_on_website` flag |

## CRM, leads & campaigns (CRM)

| ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| F-CRM-01 | Customer ID HBC-YYYY-NNNNNN + Luhn | P1 | DONE | `HBC-YYYY-NNNNNN-C` per-year `customer_sequences` + Luhn (`domain/marketing/customer-no.ts`), assigned at signup. |
| F-CRM-02 | Contact & company records, dedupe, merge | P1 | DONE | S:domain/marketing/dedupe.ts (E.164/email), merge S:marketing.crm.controller.ts:50 (audited); TIN dedupe not verified |
| F-CRM-03 | Lead capture | P1 | DONE | public S:marketing.crm.controller.ts:20, manual :65, import :55; W:components/organisms/site/lead-form.tsx |
| F-CRM-04 | Pipeline | P1 | DONE | S:domain/marketing/lead-machine.ts:4-14 (stages, lost reason required); W:components/organisms/marketing/leads.tsx |
| F-CRM-05 | Conversion linkage | P2 | DONE | convert S:marketing.crm.ts:661; auto via cron marketing.jobs.ts:215 + matchLead |
| F-CRM-06 | Customer 360 timeline | P1 | DONE | S:marketing.crm.controller.ts:143; W:organisms/marketing/customers.tsx, WA:(marketing)/marketing/customers/[id] |
| F-CRM-07 | Attribution | P1 | DONE | W:lib/marketing/attribution.ts (utm/gclid/fbclid, consent-gated via tracking.tsx:13); stored on lead (marketing.dto.ts) |
| F-CRM-08 | Follow-up automation | P2 | DONE | sequences S:marketing.campaigns.controller.ts:134-164, cron marketing.jobs.ts:182; W:organisms/marketing/sequences.tsx |
| F-CRM-09 | Segments | P2 | DONE | S:marketing.campaigns.controller.ts:28-53 (preview); W:organisms/marketing/segments.tsx |
| F-CRM-10 | Campaigns | P2 | DONE | S:marketing.campaigns.controller.ts:60-98, send cron marketing.jobs.ts:120; W:marketing/campaigns.tsx, wizard.tsx |
| F-CRM-11 | Service recommendations | P2 | DONE | `rec_rule` records + `recommend()` (unit test), `GET/PUT admin/mkt/recommendation-rules`, editor `/marketing/customers/rules`; customer 360 uses it. |
| F-CRM-12 | Tax/compliance reminders | P2 | PARTIAL | compliance calendar exists (S:modules/compliance). Gap: no marketing-category reminder to consented non-subscribers |
| F-CRM-13 | Renewal reminders | P2 | PARTIAL | subscription renewals in SUB; client-registered licence expiry (`client_document_expiry`) reminder path not verified |
| F-CRM-14 | Re-engagement | P2 | PARTIAL | inactive rule S:marketing.campaigns.controller.ts:169. Gap: auto segment + reactivation tracking not verified |
| F-CRM-15 | GA4 + Consent Mode + MP | P2 | DONE | `marketing.ga4_event` Measurement Protocol forwarder from consented `site_events` (dormant until `GA4_MEASUREMENT_ID`/`GA4_API_SECRET`). |
| F-CRM-16 | First-party visitor analytics | P2 | DONE | `site_events` + `POST /api/events` (consent-gated page_view beacon in `tracking.tsx`), `GET admin/mkt/events/summary`. |
| F-CRM-17 | Social media monitoring | P3 | PARTIAL | manual entry + CSV import S:marketing.insights.controller.ts:65-75; no Meta/LinkedIn API |
| F-CRM-18 | Tasks & notes | P2 | DONE | S:marketing.crm.controller.ts:98-113 |
| F-CRM-19 | Enquiries inbox | P1 | DONE | S:marketing.crm.controller.ts:121-131; WA:(marketing)/marketing/inbox |
| F-CRM-20 | Promotions | P3 | MISSING | no promo-code model or invoice hook |
| F-CRM-21 | Referral tracking | P3 | DONE | S:marketing.insights.controller.ts:99-109, links/r/:code :187; WA:(marketing)/marketing/referrals (partner/agent referrer types not verified) |

## Settings & configuration (SET)

| ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| F-SET-01 | Typed settings registry | P1 | DONE | S:domain/system/settings-registry.ts:57-97; S:modules/system/system.config.controller.ts:46/51; WA:(system)/system/settings/[group]. (Values kept in system_records world, not a `settings` table) |
| F-SET-02 | Change approval | P2 | DONE | requiresApproval → change request S:system.config.ts:156-186; decision S:system.ops.controller.ts:84; finance effective-dated S:finance.core.controller.ts:87/92 |
| F-SET-03 | Audit of changes | P1 | DONE | `config.setting.changed` with before/after S:system.config.ts:75/107-114 |
| F-SET-04 | Custom sub-statuses | P1 | DONE | S:modules/catalogue/catalogue.controller.ts:169-189; WA:(ops)/ops/settings/statuses |
| F-SET-05 | SLA & working calendar | P1 | PARTIAL | holidays GET S:modules/compliance/compliance.controller.ts:49, UI W:organisms/ops/sla.tsx. Gap: business hours hardcoded PLACEHOLDER (policy.ts businessHours); holiday table not editable via API |
| F-SET-06 | Numbering formats | P1 | PARTIAL | finance sequences + read view S:finance.core.controller.ts:77. Gap: customer numbering placeholder (see CRM-01); registry entry readonly |
| F-SET-07 | Company & tax identity | P1 | PARTIAL | registry `general.company_identity` readonly string (settings-registry.ts:64); bank accounts S:finance.core.controller.ts:99. Gap: TIN/VAT/EBM/logo/footer editable fields |
| F-SET-08 | Payment methods matrix | P1 | PARTIAL | only `flags.card_payments`. Gap: per-method enable/limits/fees per context |
| F-SET-09 | Channel configuration | P2 | PARTIAL | rules/templates/costs S:system.config.controller.ts:111-167. Gap: sender IDs, WhatsApp number, global quiet hours (only per-user prefs, notifications.service.ts:31) |
| F-SET-10 | Languages | P2 | PARTIAL | missing-translation report S:system.config.ts:235, POST :71. Gap: `i18n.enabled_locales` readonly (needs deploy) |
| F-SET-11 | Maintenance mode | P1 | DONE | Closed 2026-11-19: PlatformGuard: API read-only for clients when on or in the scheduled window. (was PARTIAL) |
| F-SET-12 | Feature flags | P1 | DONE | Closed 2026-11-19: PlatformGuard route flags (assistant, booking, field cash) + WhatsApp in delivery. (was PARTIAL) |
| F-SET-13 | Export/import | P3 | PARTIAL | export S:system.config.controller.ts:56; no import |
| F-SET-14 | Remove dead settings | P1 | PARTIAL | columns still present S:db/schema/schema.ts:907-909 (`data_retention`, `compact_tables`, `enforce_2fa`) |

## Audit trail (AUD)

| ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| F-AUD-01 | Mandatory category | P1 | DONE | Closed 2026-11-19: audit_log.kind = catalogue category; prefix map. (was PARTIAL) |
| F-AUD-02 | Event catalogue + CI test | P1 | DONE | Closed 2026-11-19: audit-catalogue.test.ts scans all emitted codes. (was PARTIAL) |
| F-AUD-03 | Before/after diff | P1 | DONE | Closed 2026-11-19: @Route audits snapshot before (core/http/audit-before.ts) + auditBefore(). (was PARTIAL) |
| F-AUD-04 | Tamper evidence | P2 | DONE | chain cols schema.ts:161-163, advisory lock audit.ts:46, append-only trigger migrations/0001; daily verify S:modules/system/system.jobs.ts:62; UI WA:(system)/system/audit/integrity |
| F-AUD-05 | Sensitive-read logging | P1 | DONE | Closed 2026-11-19: document_access.document.viewed on staff case-document views. (was PARTIAL) |
| F-AUD-06 | Request context | P1 | DONE | Closed 2026-11-19: request id, user agent, session id in hash-chained details. (was PARTIAL) |
| F-AUD-07 | Audit viewer | P1 | DONE | S:system.audit.controller.ts:14/48; W:components/organisms/system/audit.tsx, WA:(system)/system/audit |
| F-AUD-08 | Export | P2 | DONE | S:system.audit.controller.ts:39, csv/pdf + `data_export.audit.exported` (system.audit.ts:505) |
| F-AUD-09 | Retention / archive | P3 | MISSING | no archive job to R2 `audit-archive` |
| F-AUD-10 | Per-resource history | P2 | PARTIAL | cases S:ops.cases.controller.ts:230 + W:ops/record.tsx; users S:system.users.controller.ts:56; workers history. Gap: invoices Activity tab not verified |

## Cross-cutting

### Accessibility
| ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| A11Y-skip | Skip link / landmarks | P1 | DONE | WA:(public)/layout.tsx:23, W:organisms/layout/workspace-shell.tsx:229 |
| A11Y-motion | Reduced motion | P1 | DONE | W:components/atoms/motion.tsx |
| A11Y-axe | axe in e2e every route/locale | P1 | DONE | Closed 2026-11-19: axe WCAG A/AA in every e2e visit(). (was PARTIAL) |
| A11Y-lint | eslint-plugin-jsx-a11y | P1 | PARTIAL | only what eslint-config-next bundles; not enabled explicitly |
| A11Y-stmt | /accessibility statement | P1 | DONE | WA:(public)/accessibility/page.tsx |
| A11Y-manual | Manual keyboard/SR passes | P1 | N/A | process, not code |

### Backups & DR
| ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| BDR-design | Automated PITR/dumps to 2nd provider | P1 | DONE | Closed 2026-11-19: server/backup/backup.sh daily age-encrypted pg_dump to R2. (was MISSING) |
| BDR-runbook | Restore runbook | P1 | DONE | Closed 2026-11-19: docs/RESILIENCE.md §4 + backup/restore.sh. (was PARTIAL) |
| BDR-drill | Monthly automated restore test | P1 | MISSING | /system/ops backups/drills tabs read seeded `w.backups` (S:modules/system/system.world.ts:154, S:db/seed/system.ts) — fake data |
| BDR-monitor | Backup monitoring/alerts | P1 | DONE | Closed 2026-11-19: system console reads status/LATEST-<env>.json (BACKUP_STATUS_*), stale > 26 h shows not ok. (was MISSING) |
### i18n
| ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| I18N-urls | Locale-prefixed URLs + negotiation | P1 | DONE | WA: routes, W:proxy.ts:66-69 |
| I18N-locales | rw/en/fr dictionaries | P1 | DONE | S:domain/i18n/dictionaries/*, web content per locale |
| I18N-report | Missing-translation report | P2 | DONE | S:system.config.ts:235 |
| I18N-ci | CI key-parity check | P1 | DONE | Closed 2026-11-19: web scripts/check-i18n.mjs in CI. (was PARTIAL) |
### Observability
| ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| OBS-logs | Structured logs + request id | P1 | DONE | S:core/http/logger.ts (pino, redaction), S:core/http/context.ts |
| OBS-errors | Sentry web/api/worker | P1 | DONE | S:core/sentry.ts, W:lib/observability.ts |
| OBS-metrics | Metrics | P2 | MISSING | no prom/OTel metrics |
| OBS-tracing | Tracing | P2 | MISSING | — |
| OBS-status | Public status page | P1 | PARTIAL | live probe S:modules/platform/platform.status.ts (fake array fixed); spec wants external uptime provider at status.hebuza.rw |
| OBS-alert | Alerting/on-call | P1 | PARTIAL | worker heartbeat/monitor S:core/queue/worker-monitor.ts; no external pager |
| OBS-pilot | Pilot reporting C3.20 | P3 | PARTIAL | reports module exists (group-other audit) |

### Performance & low bandwidth
| ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| PRF-pwa | PWA/service worker | P1 | DONE | W:components/organisms/layout/service-worker.tsx, next.config.ts:73-75 |
| PRF-saver | Data-saver mode | P2 | PARTIAL | field only (W:lib/field/net.ts, prefs.ts); not app-wide |
| PRF-lists | Pagination / virtualisation | P1 | PARTIAL | S:core/db/pagination.ts; virtualisation not verified |
| PRF-k6 | k6 load test | P1 | MISSING | no k6 scripts |
| PRF-budget | Lighthouse/bundle budgets in CI | P1 | MISSING | — |
| PRF-cdn | Cloudflare CDN | P1 | PARTIAL | documented in server/docs/DEPLOYMENT-RAILWAY-CLOUDFLARE.md; ops, not code |

### Privacy & data protection
| ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| PRV-banner | Cookie banner, Consent Mode v2 | P1 | DONE | W:components/organisms/site/cookie-consent + tracking.tsx |
| PRV-ledger | Consent ledger (profile reuse, per-channel marketing) | P1 | DONE | Closed 2026-11-19: consent_ledger (see F-NTF-09). (was PARTIAL) |
| PRV-dsr | Data-subject requests | P1 | DONE | S:system.ops.controller.ts:139-149; WA:(system)/system/privacy/requests/[id], client WA:(client)/settings/privacy |
| PRV-processors | Processor register / map | P1 | DONE | S:system.ops.controller.ts:100-115 |
| PRV-retention | Retention enforcement | P1 | PARTIAL | dry-run/changes S:system.ops.controller.ts:124-134; cron only counts (system.jobs.ts:76-93); AI + lead retention crons do delete (assistant.jobs.ts:20, marketing.jobs.ts:232) |
| PRV-ai | AI minimisation | P2 | PARTIAL | covered by AIA audit (other group) |
| PRV-breach | 48h breach notification | P1 | PARTIAL | incidents S:system.ops.controller.ts:198-225; no NCSA 48h timer/template verified |
| PRV-residency | Data residency | P1 | N/A | decision Q-PRV-02 |

### Security
| ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| SEC-headers | HTTP headers | P1 | DONE | Closed 2026-11-19: CSP enforced (web/next.config.ts), API no-store + helmet. (was PARTIAL) |
| SEC-rate | Rate limits | P1 | DONE | S:core/auth/rate.ts, throttle.ts, `@Route({limit})` |
| SEC-upload | Upload malware scan | P1 | DONE | ClamAV S:core/storage/scan.processor.ts |
| SEC-pwd | Password hashing | P1 | DONE | S:core/auth/password.ts (argon2) |
| SEC-enc | Field encryption at rest | P1 | DONE | S:core/crypto/crypto.service.ts (Fernet; e.g. field_visits.client_enc) |
| SEC-rotation | Key rotation | P2 | PARTIAL | service-account rotate S:system.users.controller.ts:117; no data-key rotation procedure |
| SEC-csrf | CSRF / session | P1 | DONE | S:core/auth/csrf.ts, cookies.ts |
| SEC-vuln | Dependency scanning | P1 | DONE | Closed 2026-11-19: pnpm audit --prod in both CIs. (was PARTIAL) |
| SEC-ir | Incident response | P1 | DONE | incidents module (see PRV-breach) |

### SEO & analytics
| ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| SEO-urls | Locale URLs + hreflang | P1 | DONE | W:app/sitemap.ts, W:lib/seo.ts, WA:layout.tsx |
| SEO-crawl | sitemap / robots | P1 | DONE | W:app/sitemap.ts, robots.ts |
| SEO-meta | generateMetadata + OG | P1 | DONE | W:lib/seo.ts `pageMeta`; WA:(public)/services/[slug]/opengraph-image.tsx |
| SEO-jsonld | Structured data | P1 | DONE | WA:(public)/page.tsx, faq, pricing, knowledge/[slug] |
| SEO-ga4 | GA4 after consent | P2 | DONE | W:organisms/site/tracking.tsx |
| SEO-mp | Server-side conversions (MP) | P2 | MISSING | no Measurement Protocol calls |
| SEO-utm | UTM capture | P2 | DONE | W:lib/marketing/attribution.ts |
| SEO-gadata | GA4 Data API → daily_web_metrics | P3 | MISSING | — |
| SEO-landing | Landing pages | P2 | DONE | WA:(campaign)/campaign/[slug], marketing/landing editor |

## Journeys

| ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| FA-F1 | Receive field tasks | P2 | DONE | S:field.controller.ts:20/24/25; WA:(agent)/agent/field |
| FA-F2 | Prepare offline | P2 | DONE | S:field.controller.ts:22; WA:(agent)/agent/field/prepare |
| FA-F3 | Visit (check-in, scan, receipt, checkout, MoMo) | P2 | DONE | S:field.controller.ts:26-52; WA:.../field/visits/[visitId] |
| FA-F4 | Sync | P2 | DONE | W:lib/field/sync.ts; outbox page |
| FA-F5 | Hand over originals | P2 | DONE | S:field.controller.ts:73 |
| FA-F6 | Earnings & expenses | P2 | DONE | S:field.controller.ts:58-62; WA:.../field/expenses, earnings |
| EX-E1 | Apply / onboard | P2 | DONE | S:work.controller.ts:56-147; WA:(public)/join-us, (work)/work/onboarding/[step] |
| EX-E2 | Home & offers | P2 | DONE | WA:(work)/work/offers; counter S:work.controller.ts:173 |
| EX-E3 | Work a task (least privilege) | P2 | DONE | scope/access requests S:work.controller.ts:118/192/197 |
| EX-E4 | Earnings, statements, licence | P2 | DONE | S:work.controller.ts:222-329 |
| EX-E5 | Contract lifecycle | P2 | PARTIAL | sign/renew/notice exist; no expiry reminders (WRK-05) |
| EX-E6 | Firm accounts | P2 | DONE | S:work.controller.ts:391-406; WA:(work)/work/team |
| PM-1..8 | Partner manager journeys | P3 | MISSING | placeholder workspace only |
| SA-S1 | Users & roles | P1 | DONE | S:system.users.controller.ts; WA:(system)/system/users |
| SA-S2 | Roles & permissions | P1 | DONE | S:system.governance.controller.ts:39-113 |
| SA-S3 | Platform settings | P1 | PARTIAL | see SET gaps (flags, maintenance, identity) |
| SA-S4 | Integrations | P1 | DONE | S:system.config.controller.ts:76-105 |
| SA-S5 | Monitoring & incidents | P1 | PARTIAL | incidents real; monitoring/posture views partly seeded |
| SA-S6 | Backups & recovery | P1 | PARTIAL | screens show seeded data; restore POST S:system.ops.controller.ts:175 not wired to real infra |
| SA-S7 | Audit | P1 | DONE | see AUD-07/04 |
| SA-S8 | Data-protection requests | P1 | DONE | see PRV-dsr |

## Gaps (by phase)

### P1
| gap | effort | build |
|---|---|---|
| Manual assign bypasses leave/clearance/authorisation/contract (ASN-05/09, WRK-06/12) | S | In `assign()` S:modules/ops/ops.cases.ts:366 run the same eligibility as ranking.ts:50-60 (+ contract expired); 409 with reason; override only via existing `assign-override` |
| SLA 80/100/150 escalation (ASN-08) | M | Extend `ops.sla_sweep` cron: per open case compute elapsed % of SLA (pause-aware), claim offsets in `deadline_notifications` (80→assignee notify, 100→SM notify + breach, 150→exec digest queue) |
| Offer timeout re-offer (ASN-03) | S | In ops.jobs.ts offerExpiry, after timeout call ranking and create next offer (skip prior decliners) |
| Customer ID (CRM-01, SET-06) | M | `customer_sequences(year, n)` gapless; Luhn digit helper + test; assign on signup/first conversion; show on invoices/receipts; add to global search |
| Feature flags enforcement (SET-12) | S | server guard `requireFlag(key)` on AI, booking, field cash, WhatsApp routes; `useFlag` in nav/screens |
| Maintenance mode (SET-11) | S | Global API write guard reading registry `maintenance.on` for client roles; banner in public/client layouts; cron honouring `maintenance.window` |
| Dead settings (SET-14) | S | migration dropping 3 columns from `platform_settings`; remove legacy reads (applications.service.ts:610) |
| Company/tax identity, payment matrix (SET-07/08) | M | make `general.company_identity` an object (legal name, TIN, VAT, EBM, address, logo, footer) with requiresApproval; `payments.methods` matrix setting enforced in payments intent creation; screens in /system/settings/general and /finance/settings |
| Business hours & holiday CRUD (SET-05) | S | `sla.business_hours` setting; POST/PATCH/DELETE `public-holidays`; edit UI in ops/sla.tsx |
| Audit category/context (AUD-01/03/06) | M | add `category` enum column (backfill from catalogue), `user_agent`, `request_id`, `session_id` cols filled from request context; make @Route audit codes catalogue codes and include before/after |
| Audit catalogue CI test (AUD-02) | S | jest test greps every AUDIT_CATALOGUE key for a call site |
| Sensitive-read logging (AUD-05) | S | `document_access.document.viewed/downloaded` on every client-document download route (agent/ops/documents controllers) |
| Worker unified profile + private contacts (WRK-01) | M | either `worker_profiles` view over agent/staff profiles or add work/private contact + links columns to `agent_profiles`; show in ops worker profile |
| Rename partner → ext:agent leftovers (WRK-24) | S | rename `partner_profiles`/`partner_documents` tables via migration; redirect `/dashboard/work` |
| On-duty/availability in ranking (WRK-09) | S | include `onDuty` and working hours in ranking filter |
| CSP enforced (SEC-headers) | S | switch `Content-Security-Policy-Report-Only` to enforcing after report review |
| axe in e2e + jsx-a11y (A11Y) | S | add axe check to web/e2e smoke over routes × locales; enable `plugin:jsx-a11y/recommended` |
| Backups + drill automation (BDR) | L | scheduled pg_dump/wal-g to second-provider bucket (encrypted), restore-test job into ephemeral DB with row counts; feed `/system/ops` backups/drills from real job results instead of seed |
| k6 + perf budgets (PRF) | M | k6 script for login/track/apply/pay; Lighthouse CI budget |
| Retention enforcement (PRV-retention) | M | per-category purge/anonymise jobs (cases 7y, finance 10y, chat 7y) instead of count-only system_retention_due |
| Metrics/alerting (OBS) | M | prom-client /metrics (internal), external uptime provider + status.hebuza.rw |

### P2
| gap | effort | build |
|---|---|---|
| Auto-assign modes + threshold (ASN-07) | S | per-service `{mode: manual|suggest|auto, minScore}`; auto uses rankAgents top ≥ minScore |
| Assignment restrictions (ASN-09) | M | `assignment_blocks(agent_id, client_id, reason)` + conflict declaration on worker profile; populate `conflictWith` in store.ts; SM screen on client and worker pages |
| Multi-assignee roles (ASN-11) | M | `case_assignees(case, user, role lead|helper|reviewer)`; access + notifications for helpers; assign screen role picker |
| Contracts staff CRUD + reminders (WRK-04/05) | M | staff POST/PATCH `staff/workers/:id/contracts` with versions; cron 60/30/7/0 reminders (worker+SM); expiry → not_cleared |
| Structured CV on staff view (WRK-02) | S | expose cv in workforce detail + talent search |
| Talent directory filters (WRK-14) | S | query params on GET staff/workers (service, language, district, availability, rating, external, field) |
| Public team opt-in (WRK-16) | M | `public_profile {opt_in, fields, approved_by}`; marketing approval queue; About/team reads approved profiles |
| Rate-card effective dating (WRK-07) | S | effective_from on rates; assignContext reads it instead of hardcoded 70/30 |
| KPIs (WRK-11) | M | compute first-pass approval, reassignment, acceptance, revenue in reports; staff worker KPI tab |
| First-party analytics (CRM-16) | M | `web_events` table + POST /events (anonymous id, truncated IP, 13-month purge); in-app reports |
| GA4 Measurement Protocol (CRM-15, SEO-mp) | S | server emits purchase/submit events on payment confirm/case submit (no PII) |
| Recommendations rules (CRM-11) | M | rules records + editor in marketing; replace placeholder in marketing.crm.ts:1147 |
| Compliance marketing reminders (CRM-12/13/14) | M | job joining CAL obligations × consented contacts; licence expiry reminders; inactive auto-segment + reactivation metric |
| Channel config (SET-09) | S | settings for senders/WhatsApp number/global quiet hours enforced in notify dispatch |
| Languages toggle (SET-10) | S | make `i18n.enabled_locales` editable for CMS/catalogue content |
| Per-resource Activity tab for invoices (AUD-10) | S | reuse admin/ops/audit/:kind/:id for invoice pages |
| Data-saver app-wide (PRF) | S | lift field prefs to global setting (disable images/prefetch) |

### P3
| gap | effort | build |
|---|---|---|
| Institutional partners module (PRT-01..13, PM journeys) | L | new `prt_*` tables (partners, contacts, agreements+obligations, objectives/actions, meetings, correspondence, projects, referrals, share terms), reminders cron, scorecard, history PDF; `/partners` workspace replacing PlannedPage; `shown_on_website` feeding home strip |
| Promotions (CRM-20) | M | `promo_codes` + validation at invoice creation; campaign link param |
| Audit archive (AUD-09) | M | monthly JSONL + hash manifest to R2 `audit-archive`; retention by category |
| Settings import (SET-13) | S | POST staff/settings/import (validate via registry, secrets excluded, approval-gated) |
| Licence fee both directions (WRK-08) | S | direction flag on contract; payable line when HEBUZA owes |
| Social APIs (CRM-17) | M | Meta Graph/LinkedIn pull jobs |
| GA4 Data API daily metrics (SEO-gadata) | M | daily job into `daily_web_metrics` |

## Open questions — decision implied by code

| ID | Decision implied |
|---|---|
| Q-REV-01 | default: spec recommendation (not verified in group D) |
| Q-REV-02 | default: spec recommendation |
| Q-REV-03 | 30/70 (POLICY.defaultAgentBps 3000; REVENUE_RULE 70/30 ops.cases.ts:1157); field flat per-visit fee 5,000 PLACEHOLDER (FIELD_POLICY.perVisitFee) |
| Q-REV-04 | default: spec recommendation |
| Q-REV-05 | Monthly, payout day **5** (POLICY.payoutDay) — differs from spec "by the 7th" |
| Q-REV-06 | WHT 15% on external payouts (POLICY.whtBps 1500) |
| Q-REV-07 | default: spec recommendation |
| Q-REV-08 | default: spec recommendation |
| Q-RFD-01 | Stage-based bps (before_work 100%, in_progress 50%, submitted 25%, completed 0) PLACEHOLDER (POLICY.refundPolicyBps) |
| Q-RFD-02 | Exec above 200,000 (POLICY.refundExecLimit) — differs from spec 500,000 |
| Q-FIN-01 | VAT 18% assumed (POLICY.vatBps) |
| Q-FIN-02 | pay-later integration toggle exists (system.config.controller.ts:81); default off |
| Q-FIN-03 | ≥200,000 → 50% deposit (POLICY.depositThreshold/depositBps) |
| Q-FIN-04 | default: spec recommendation |
| Q-FIN-05 | 2nd finance >500,000, exec >1,000,000 (POLICY.manualConfirm*) — stricter than spec (spec: any manual confirmation maker+checker) |
| Q-FIN-06 | default: spec recommendation (accounting-export page exists) |
| Q-SUB-01..03 | default: spec recommendation |
| Q-OPS-01 | default: spec recommendation |
| Q-OPS-02 | Mon–Fri 08:00–17:00 Kigali hardcoded PLACEHOLDER (POLICY.businessHours); holidays table |
| Q-OPS-03 | paused: on_hold, awaiting_client_documents, awaiting… (ops.jobs.ts:54) — matches spec |
| Q-OPS-04 | default: spec recommendation |
| Q-OPS-05 | Claim endpoint exists but is SM triage claim (ops.cases.ts claim), agents get offers only — matches default |
| Q-OPS-06 | 4 h, business hours (POLICY.offerTtlMs) |
| Q-OPS-07 | single branch "Sonatube / Kicukiro" (registry general.branches) |
| Q-OPS-08 | both — `field_agents` capability table on any agent (schema-field.ts:23) |
| Q-OPS-09 | 300 m radius (FIELD_POLICY.radiusM; notes workforce §12 says 500) + low-accuracy flag 100 m; OTP/signature receipt |
| Q-OPS-10 | `HBC-YYYY-` + 5 chars from row id (placeholder; not sequential) |
| Q-OPS-11 | INV-YYYY-NNNNN etc. via finance sequences |
| Q-OPS-12 | consultation price 20,000 PLACEHOLDER (POLICY.consultationPrice) |
| Q-OPS-13 | default: spec recommendation (second-approval endpoints exist) |
| Q-INT-01..10 | default: spec recommendation (not verified in group D) |
| Q-AI-01..05 | default: spec recommendation (assistant.retention cron exists) |
| Q-PRV-01, 02, 04 | N/A in code (business decisions) |
| Q-PRV-03 | partial: accounts 2y count only; lead retention cron; other periods not enforced |
| Q-SEC-01, 02 | RUNBOOK: 35-day retention, monthly drill (stricter than quarterly) — not automated |
| Q-SEC-03 | staff 30 min idle / 8 h absolute; sysadmin 4 h absolute; client 60 min / 24 h (settings-registry.ts:69-74) |
| Q-SEC-04 | optional allowlists for sysadmin + finance, default empty (settings-registry.ts:75-76) |
| Q-SEC-05 | N/A |
| Q-PRJ-01..05 | N/A |
