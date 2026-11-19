# Audit B — catalogue, booking, chat, notifications, AI assistant, CMS, deadlines

Spec: `cleanup/Project/spec/05-modules/*.md`. Code: `systeme/server`, `systeme/web`. Paths are relative to those roots.

**Issue that affects several modules:** the public site does not read the backend for the catalogue or for CMS content.
- `web/src/lib/catalogue.ts:36-41` serves `src/content/seed/services.json`. The comment says "Dummy catalogue until the backend exists".
- `web/src/lib/marketing/cms/read.ts:12-15` serves `seedEntries()`.

So the server has catalogue and CMS publish/admin APIs, and the admin screens call them, but nothing published there reaches `/services`, `/knowledge`, `/faq`, `/legal` or `/updates`. Every public-facing CAT and CMS row below is capped at PARTIAL for this reason.
- The web API client falls back to MSW mocks when `API_URL` is unset (`web/next.config.ts:30`).

## Catalogue (CAT)
| F-ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| F-CAT-01 | Category tree | P1 | DONE | Public tree from `/api/service-categories` (web `lib/catalogue.ts`); static file only supplies art. |
| F-CAT-02 | Service record | P1 | DONE | Public pages read `/api/services*` (seed deleted). |
| F-CAT-03 | Versioned form builder | P1 | DONE | `service_structure_versions`; draft/publish/versions/in-flight-count routes at `catalogue.controller.ts:132-162`; `applications.structureVersionId` pins each case. Web: `ops/catalogue/[slug]` calls `/structure/*`. |
| F-CAT-04 | Pricing modes | P1 | DONE | `pricingMode`, `service_price_bands`, `urgentSurcharge*`, `governmentFee` in tiers. Web: `services/[slug]` price card and the urgent toggle (`organisms/site/interactive.tsx:90`). Public data comes from the seed. |
| F-CAT-05 | Structured service facts | P1 | DONE | `eligibility`, `deliverables`, `turnaround_days_min/max`, `delivery_mode` on services; admin facts panel; shown on service page. |
| F-CAT-06 | Catalogue search | P1 | DONE | `GET /services?q=&category=&max_price=&max_days=&engagement=&mode=` (pg_trgm on generated `search_text`) + facets (`domain/catalogue/search.ts`); catalogue box calls it. |
| F-CAT-07 | Dedicated service pages | P1 | DONE | Per-locale SEO + `locale_slugs` with hreflang, 308 to locale slug, BreadcrumbList; per-service CMS FAQs (FAQPage). |
| F-CAT-08 | Consultation-only services | P1 | DONE | `services.engagement_type`; consultation CTA → `/book?service=`. |
| F-CAT-09 | Related & bundled | P2 | DONE | `related_slugs` manual links first, then family. |
| F-CAT-10 | Price change approval | P2 | DONE | `service_price_changes`: pricing saves are pending; finance (not proposer) decides; effective-date cron; in `/finance/approvals`. |
| F-CAT-11 | Service availability | P2 | DONE | Status set `draft/published/paused/archived` (`catalogue.service.ts:63`); the public page renders the paused state. W:components/organisms/ops/catalogue.tsx |
| F-CAT-12 | Revenue rule per service | P2 | DONE | `services.revenue_agent_bps` used by `allocateCase` via `withServiceDefault` (below explicit service rules). W:components/organisms/ops/service-facts.tsx |
| F-CAT-13 | Indicative fee explainer | P3 | DONE | `fee_explainer` {rw,en,fr} under the price card. W:components/organisms/ops/service-facts.tsx |
| F-CAT-14 | Cross-border flag | P3 | DONE | `markets[]` (ISO codes) in facts, "Where" and JSON-LD areaServed. W:components/organisms/ops/service-facts.tsx |

## Consultation booking (BKG)
| F-ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| F-BKG-01 | Consultation types | P2 | DONE | `bkg_types` (`schema-booking.ts:43`) with buffer, notice, horizon, maxPerDay and intake; admin routes at `booking.controller.ts:258-268`; web `ops/bookings`. |
| F-BKG-02 | Adviser availability | P2 | DONE | Slots also skip advisers on workforce leave (`agent_profiles.status=leave` until `on_leave_until`, `advisersOf`). W:components/organisms/booking/flow.tsx |
| F-BKG-03 | Slot engine | P2 | DONE | `domain/booking/rules.ts:11` (holdMin 10); `pickAdviser` (`booking.service.ts:630`); advisory-lock holds (l.590). External busy time is not included because F-BKG-10 is not built. W:components/organisms/booking/flow.tsx |
| F-BKG-04 | Public booking page | P2 | DONE | `(public)/book`, `book/[type]`, `book/confirmed/[ref]`; `lib/booking/api.ts:33-38`. |
| F-BKG-05 | Free consultation request | P1 | DONE | `POST consultation-requests` (`booking.controller.ts:110`) plus the admin queue (l.248); web `book/callback`. |
| F-BKG-06 | Paid booking | P2 | DONE | Settled client booking payment emits `finance.booking.settled` → issued + paid FIN invoice (`bookingSettled`, idempotent per payment id). Guests (no account) stay on `bkg_payments` only. |
| F-BKG-07 | Video meeting link | P2 | DONE | Rooms are real Jitsi Meet URLs (`meet.jit.si/hbz-<random>`), no account needed. |
| F-BKG-08 | Reminders | P2 | DONE | Seeded `booking` event rule with chain whatsapp→sms→email; booking notices go through `notifications.notify`, which follows the rule chain. backend-only: reminder rule chain via notifications |
| F-BKG-09 | Reschedule & cancel | P2 | DONE | `rules.ts:12,123-146` (12 h cutoff, max 2 reschedules, refund/forfeit, tested in `rules.test.ts`); manage-by-token and `/me/bookings` routes; web `book/manage/[token]`, `(client)/bookings/[id]`. |
| F-BKG-10 | Calendar sync | P3 | DONE | Google/Microsoft OAuth (`booking.calendar.ts`: start/callback, encrypted refresh token in `bkg_calendar_links`), confirmed bookings pushed as events; adviser UI on `/agent/calendar`. Dormant until `GOOGLE_OAUTH_*`/`MS_OAUTH_*`. |
| F-BKG-11 | Outcome & conversion | P2 | DONE | Completed outcome emits `booking.outcome_recorded`; marketing worker moves the matching open lead to `qualified` with the recommended services (`bookingOutcome`). Quotes: existing `quoteRequest`. W:components/organisms/booking/staff.tsx |
| F-BKG-12 | No-show handling | P2 | DONE | `autoNoShowMin 15`, `noShowLimit 2` force prepayment (`rules.ts:14`, `booking.service.ts:530,918`); sweep cron. W:components/organisms/booking/staff.tsx W:components/organisms/booking/manage.tsx |
| F-BKG-13 | Waitlist | P3 | DONE | `bkg_waitlist`, `POST bookings/waitlist`, FIFO offer job (`booking.service.ts:1427`). The 30-min claim window was not verified. |
| F-BKG-14 | Calendar views | P2 | DONE | `agent/calendar`, `ops/bookings` board, admin reassign/auto-reassign (`booking.service.ts:1824-1943`). |

## Chat & communications (MSG)
| F-ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| F-MSG-01 | Case conversation | P1 | DONE | Lanes client/team/internal; `chat/conversations/by-application`; web `agent/inbox`, `requests/[ref]`. |
| F-MSG-02 | Direct conversations | P1 | DONE | `staff_dm` (`chat.service.ts:1373-1394`). |
| F-MSG-03 | Support conversation | P1 | DONE | Closed 2026-11-19: assistant handoff → case conversation note / support ticket / handoff queue; inbound channels → tickets. (was PARTIAL) W:components/organisms/ops/handoff.tsx W:components/organisms/client/ticket.tsx |
| F-MSG-04 | Rich messages | P1 | DONE | 15-min edit window plus history (`chat.service.ts:67,1031`); `message_edits`, reactions, pins, mentions, references. |
| F-MSG-05 | Structured cards | P1/P2 | DONE | Closed 2026-11-19: six typed cards (domain/chat/rules), agent composer + client thread, quotation accept/decline. (was PARTIAL) |
| F-MSG-06 | Receipts & presence | P1 | DONE | read seq (`conversations/{id}/read`), `typing` (l.869), `realtime/focus`. |
| F-MSG-07 | Realtime + offline | P1 | DONE | SSE `realtime/stream`; `client_msg_id` idempotency; web `lib/agent/outbox.ts`. W:components/organisms/client/thread.tsx W:components/organisms/agent/inbox.tsx |
| F-MSG-08 | Templates | P1 | DONE | `chat_templates`, `/render` (`chat.service.ts:1975`), web `agent/inbox/templates`. |
| F-MSG-09 | Disputes | P1 | DONE | Disputes and resolve routes (`chat.controller.ts:200-210`, `chat.service.ts:2147`). The 4 h SLA timer was not verified. |
| F-MSG-10 | Oversight console | P1 | DONE | `admin/chat/*` list/counts/metrics/claim/transcript PDF (`chat.service.ts:96,1649,1753`); web `ops/conversations`. |
| F-MSG-11 | Search | P2 | DONE | Closed 2026-11-19: GIN tsvector full-text search, ranked, substring fallback. (was PARTIAL) W:components/organisms/agent/inbox.tsx W:components/organisms/ops/conversations.tsx |
| F-MSG-12 | Omnichannel threading | P2 | DONE | Closed 2026-11-19: inbound SMS/WhatsApp threads into support tickets (notifications.delivery thread()). (was MISSING) backend-only: inbound channel threading into tickets |
| F-MSG-13 | Enquiry SLA & escalation | P1 | DONE | Closed 2026-11-19: support first-response SLA in business hours + SM→exec escalation cron. (was MISSING) backend-only: SLA timer + escalation cron |
| F-MSG-14 | Complaint flag | P2 | DONE | Closed 2026-11-19: flag case conversation as complaint → FBK ticket; ops conversation action. (was MISSING) |
| F-MSG-15 | Retention & legal hold | P1 | DONE | Closed 2026-11-19: retention archival cron + legal hold endpoint. (was MISSING) W:components/organisms/ops/conversations.tsx (legal hold place/release), W:components/organisms/system/dsr.tsx |
| F-MSG-16 | Attachment safety | P1 | DONE | Goes through the `documents.finalize` job (sniff, scan, EXIF strip; `chat.service.ts:724`) and short-lived download URLs. HEIC→JPEG was not verified. backend-only: documents.finalize scan pipeline |
| F-MSG-17 | Conversation summary | P3 | DONE | `assistant/copilot/{kind}` "summarise" (`assistant.controller.ts:136`). |
| F-MSG-18 | Read-only after closure | P1 | DONE | Closed 2026-11-19: client lane read-only 30 days after close (409 lane_closed → support). (was MISSING) backend-only: server 409 lane_closed rule |
## Notifications & channels (NTF)
| F-ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| F-NTF-01 | Event catalogue | P1 | DONE | Closed 2026-11-19: delivery applies console event rules (notifications.delivery.ts dispatch). (was PARTIAL) |
| F-NTF-02 | In-app centre | P1 | DONE | `notifications.controller.ts:12-18`, SSE emit (`notifications.jobs.ts:37`), web `(client)/notifications`, `organisms/client/notifications.tsx`. |
| F-NTF-03 | Email | P1 | DONE | Closed 2026-11-19: bounce/complaint webhook → suppression; List-Unsubscribe on non-security mail. (was PARTIAL) |
| F-NTF-04 | WhatsApp Business | P2 | DONE | Closed 2026-11-19: WhatsApp Cloud API driver + approved templates + Meta webhook (dormant until keys, flags.whatsapp_channel). (was MISSING) backend-only: WhatsApp provider driver + webhook |
| F-NTF-05 | SMS | P1/P2 | DONE | Closed 2026-11-19: GSM-7/UCS-2 segment costing (smsSegments); sender id AT_SENDER_ID. (was PARTIAL) backend-only: SMS driver segment costing |
| F-NTF-06 | Channel router & fallback | P2 | DONE | Closed 2026-11-19: ordered fallback chain per rule; final failure falls through. (was MISSING) W:components/organisms/system/notifications.tsx |
| F-NTF-07 | Preferences | P1 | DONE | Closed 2026-11-19: per-category matrix + email switch enforced (domain/notify/delivery.ts planDelivery). (was PARTIAL) W:components/organisms/client/settings-channels.tsx |
| F-NTF-08 | Quiet hours | P2 | DONE | Closed 2026-11-19: quiet hours defer the send job (Kigali time), critical/security exempt. (was PARTIAL) W:components/organisms/client/settings-channels.tsx |
| F-NTF-09 | Consent ledger | P1 | DONE | Closed 2026-11-19: consent_ledger table, POST /api/consent (cookie banner), STOP/HAGARIKA/START inbound. (was MISSING) |
| F-NTF-10 | Template registry | P2 | DONE | Closed 2026-11-19: sends use active templates per language; Meta submission + status polling with WHATSAPP_WABA_ID. (was PARTIAL) W:components/organisms/system/notifications.tsx W:components/organisms/system/template-editor.tsx |
| F-NTF-11 | Delivery tracking | P1 | DONE | Closed 2026-11-19: notification_deliveries + per-send job with backoff + Resend/AT/Meta status webhooks; console reads the table. (was MISSING) W:components/organisms/system/notifications.tsx |
| F-NTF-12 | Cost metering & caps | P2 | DONE | Closed 2026-11-19: per-delivery cost, monthly spend from deliveries, budget cap in delivery. (was PARTIAL) W:components/organisms/system/notifications.tsx |
| F-NTF-13 | Inbound channels | P2 | DONE | Closed 2026-11-19: inbound SMS/WhatsApp: STOP/START + threading into the client's support ticket. (was MISSING) backend-only: inbound SMS/WhatsApp webhooks |
| F-NTF-14 | Digests | P1 | DONE | Closed 2026-11-19: daily staff digest (notifications.staff_digest). (was PARTIAL) backend-only: digest cron |
| F-NTF-15 | Suppression & dedupe | P1 | DONE | Closed 2026-11-19: 10-min dedupe window + suppression list. (was PARTIAL) W:components/organisms/system/notifications.tsx |
| F-NTF-16 | Secure links | P1 | DONE | Messages carry a title, body and portal link only (`notifications.jobs.ts:43`); the manage token is sealed in the outbox. backend-only: message composition rule |
| F-NTF-17 | Manual send | P2 | DONE | Closed 2026-11-19: message-client dialog on the ops case page. (was DONE) |
| F-NTF-18 | Web push | P3 | DONE | Closed 2026-11-19: payload-less Web Push (VAPID), settings toggle, SW handlers. (was MISSING) |
## AI assistant (AIA)
| F-ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| F-AIA-01 | Chat widget | P3 | DONE | `organisms/booking/launcher-lazy.tsx`, `assistant.tsx`; `(public)/assistant`; mounted in the public and client layouts; streaming sessions API. |
| F-AIA-02 | Approved KB | P3 | DONE | KB sources are the CMS/catalogue tables the public site now renders (no seed), so AI and site agree. backend-only: KB sourcing from CMS tables |
| F-AIA-03 | Model routing | P3 | DONE | Anthropic SDK (`assistant.engine.ts:8`); model is config-driven; fast model for copilot (l.767). backend-only: model routing config |
| F-AIA-04 | Tools | P3 | DONE | `estimate_fee` tool over the published catalogue (fixed tiers, range bands with min/max clamp, quote); unit test. backend-only: assistant tool |
| F-AIA-05 | Guided intake & draft | P3 | DONE | `ai_drafts`, `GET assistant/drafts/:id`; the draft is handed to the wizard, so the assistant never submits. |
| F-AIA-06 | Human escalation | P3 | DONE | Portal client with no case gets a real support ticket (`createTicket`, ref used as handoff ticketRef). |
| F-AIA-07 | Guardrails | P3 | DONE | Regex input/output guards (`assistant.engine.ts:133-176`). backend-only: guardrail regex |
| F-AIA-08 | PII protection | P3 | DONE | `maskPii` before storage and before the model (`assistant.engine.ts:135,854`). backend-only: PII masking |
| F-AIA-09 | Logs & retention | P3 | DONE | `ai_sessions`/`ai_messages`/`ai_usage`, rating route, nightly retention purge (`assistant.jobs.ts:20`). |
| F-AIA-10 | Cost control | P3 | DONE | `budgetUsd`, token counters in Redis, `ai_usage` monthly cap (`assistant.engine.ts:66,798`). The per-IP 30/day cap was not verified. backend-only: token budget caps |
| F-AIA-11 | Data-use guarantees | P3 | N/A | Contract/DPA work, not code. Only Anthropic and Voyage are called. |
| F-AIA-12 | Eval set & QA | P3 | DONE | EVAL_SET ≥150 cases (en/fr/rw per guardrail and intent; `EXTRA_CASES`), rw/fr intent patterns; `intent-i18n.test.ts` checks every case routes as expected (no bare-word false refusals). backend-only: eval set test |
| F-AIA-13 | Staff copilot | P3 | DONE | `POST assistant/copilot/{kind}`; used in the agent case view. |
| F-AIA-14 | Kill switch | P3 | DONE | `ai_settings.enabled`, `assistant/status`, admin settings PUT. |
| F-AIA-15 | Documented limitations | P3 | DONE | `(public)/assistant/about/page.tsx`. |

## CMS & knowledge centre (CMS)
| F-ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| F-CMS-01 | Content types | P1/P2 | DONE | Public site reads `GET /api/content/entries` (seed deleted). |
| F-CMS-02 | Block editor | P1 | DONE | JSON blocks (`BlockShape`, `RichDoc`) in `marketing/content/[entryId]`. |
| F-CMS-03 | Multilingual entries | P1 | DONE | Variant routes, fallback (`resolveVariant`), `/translate` (machine-translation draft). |
| F-CMS-04 | Workflow | P1 | DONE | submit/approve/request-changes/schedule/publish/archive, versions and restore, comments, locks (`cms.controller.ts:32-147`). |
| F-CMS-05 | SEO fields | P1 | DONE | Variant SEO reaches public pages via the CMS reader. W:components/organisms/marketing/seo.tsx |
| F-CMS-06 | Media library | P1 | DONE | `admin/cms/media` CRUD, complete, usage (`marketing.insights.controller.ts:116-143`); web `marketing/media`. WebP/AVIF variants were not verified. |
| F-CMS-07 | Navigation & site settings | P1 | DONE | `GET /api/content/site`; header, mobile and footer read CMS nav + settings. |
| F-CMS-08 | Knowledge centre | P2 | DONE | `cms_feedback` + `POST /content/feedback` from `Helpful`; subscribe writes `consent_ledger`. |
| F-CMS-09 | FAQs | P1 | DONE | `/faq` and per-service FAQs from CMS (`serviceSlugs`). W:components/organisms/marketing/faqs.tsx W:components/organisms/site/faq-browser.tsx |
| F-CMS-10 | Regulatory updates | P2 | DONE | Publish links compliance-calendar rules (shown on `/updates/[slug]`) and creates a draft campaign (`cms.regulatory_published`). |
| F-CMS-11 | Landing pages | P2 | DONE | `campaign/[slug]` reads CMS landing pages. |
| F-CMS-12 | Team & credentials | P1 | DONE | SM credential verify (`POST admin/cms/entries/:id/credential`), Verified badge on `/about/team` (CMS-fed). |
| F-CMS-13 | Service page content | P1 | DONE | Service page: CAT facts + CMS FAQs. W:components/organisms/ops/service-facts.tsx W:components/organisms/marketing/faqs.tsx |
| F-CMS-14 | Legal documents | P1 | DONE | Legal docs are CMS `legal_doc`; `GET/POST /api/me/terms[/accept]` compares acceptance with the published terms+privacy version; `TermsGate` re-accept dialog for signed-in users. |
| F-CMS-15 | Cookie consent | P1 | DONE | `organisms/site/cookie-consent.tsx` banner + preferences (necessary/analytics/marketing), re-prompt on VERSION bump, localised; each choice POSTs `/api/consent` (notifications.controller, NTF consent ledger purposes cookies_analytics/cookies_marketing); Consent Mode v2 in `tracking.tsx` |
| F-CMS-16 | Redirects & slugs | P1 | DONE | `cms_redirects`, `cms_not_found`, `content/not-found` logging, UI. W:components/organisms/marketing/seo.tsx |
| F-CMS-17 | Preview & caching | P1 | DONE | Draft-mode preview routes (`/preview`), revalidate tags end to end (catalogue writes too), sitemap per-locale. |
| F-CMS-18 | Status page | P2 | DONE | `/status` reads live `GET /api/status` (already). |
| F-CMS-19 | Testimonials & logos | P2 | DONE | `admin/fbk/testimonials` with a consent check (`marketing.insights.ts:752`); web `marketing/testimonials`. |

## Deadlines & compliance calendar (CAL)
| F-ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| F-CAL-01 | Deadline rules per service | P1 | DONE | `service_deadline_rules`, `compliance-calendar` CRUD (`compliance.controller.ts:22-49`); web `ops/compliance-rules`. |
| F-CAL-02 | National compliance calendar | P2 | DONE | Closed 2026-11-19: national statutory calendar seeded (seedCompliance: RRA/RSSB/RDB rules, verified=false pending legal check) + holidays. (was PARTIAL) W:components/organisms/ops/compliance-rules.tsx |
| F-CAL-03 | Obligation generation | P2 | DONE | Closed 2026-11-19: org compliance profile (VAT, VAT period, employer) → generateOrgObligations. (was PARTIAL) W:components/organisms/client/orgs.tsx |
| F-CAL-04 | Client compliance calendar | P2 | DONE | Closed 2026-11-19: GET me/obligations + ICS feed + /dashboard/calendar. (was MISSING) |
| F-CAL-05 | Agent/manager calendar | P1 | DONE | `GET agent/calendar` (`agent.controller.ts:81`), `POST agent/obligations/:id/:action`; web `agent/calendar`. |
| F-CAL-06 | Reminders multi-channel | P2 | DONE | Closed 2026-11-19: client reminders on email/SMS/WhatsApp via delivery rules. (was PARTIAL) W:components/organisms/client/reminders.tsx |
| F-CAL-07 | Auto-case creation | P2 | DONE | Closed 2026-11-19: deadlines.autocase opens the case via ApplicationsService at lead time. (was MISSING) backend-only: autocase cron |
| F-CAL-08 | Missed & escalation | P1 | DONE | Closed 2026-11-19: missed → client notice, case flagged urgent, managers alerted. (was PARTIAL) backend-only: missed-deadline escalation cron |
| F-CAL-09 | Holiday calendar | P2 | DONE | `compliance_holidays`, `public-holidays`, weekend/holiday roll (`compliance.service.ts:2,54`). W:components/organisms/ops/sla.tsx |
| F-CAL-10 | Case SLA & due dates | P1 | DONE | Closed 2026-11-19: agent proposes due date → manager approval (proposeDue/openApproval); SM direct change audited. (was PARTIAL) W:components/organisms/agent/workbench-dialogs.tsx W:components/organisms/ops/case.tsx |
| F-CAL-11 | Contract/renewal reminders | P2 | DONE | Closed 2026-11-19: shared expiry engine (domain/expiry + core/db/reminder-claim) used by worker contracts. (was PARTIAL) backend-only: shared expiry engine |
## Gaps (by phase)

### P1
1. **Public site reads the seed** (CAT-01/02/04/07, CMS-01/05/07/09/13/14/17). Size L. Replace `rawServices()` in `web/src/lib/catalogue.ts` with `GET /api/services` (+ `/services/:slug`), and `entries()` in `lib/marketing/cms/read.ts` with `GET /api/content/entries`, keeping the seed only as an outage fallback. Header and footer should read `content/manifest` (nav and settings).
2. **MSG-13 enquiry SLA and escalation.** Size M. Add `conversations.first_response_due_at` and `escalation_level`, plus a business-hours helper that reuses `compliance_holidays`. A cron escalates agent → SM → executive digest, and the `ops/conversations` filter shows breaches.
3. **NTF-11 delivery tracking.** Size M. Add a `notification_deliveries` table (id, notification_id, channel, provider_id, status, reason, cost, attempts). `deliver` writes one row per channel with backoff retries (max 5). Provider webhooks go at `POST /api/webhooks/{resend,sms}`. Point `system/notifications/deliveries` at the table.
4. **NTF-09 consent ledger.** Size M. Add `consent_events` (user/lead, channel, purpose, in/out, source, ip, ua, policy_version). Write to it from signup, `settings/notifications`, the cookie banner (CMS-15) and SMS/WA STOP/HAGARIKA inbound.
5. **NTF-01/07/15 router uses rules, preferences and dedupe.** Size M. `NotificationsJobs.deliver` should read event rules (move them from the world store into a table), apply the category×channel matrix, and use a Redis `SETNX ntf:{event}:{user}:{key}` dedupe window plus a `notification_suppressions` table.
6. **MSG-15 retention and legal hold.** Size S. Add `conversations.legal_hold` and `archived_at`, a nightly job archiving after `chat_retention_years`, and an ops toggle.
7. **MSG-18 read-only after closure.** Size S. In the send path, if the case is closed and more than 30 days have passed, reject the client lane and create a support conversation linked to the case.
8. **CAT-08 engagement_type.** Size S. Add the `services.engagement_type` enum; the service page CTA goes to `/book/[type]` for consultation types.
9. **CAT-05 structured facts.** Size M. Add `eligibility jsonb`, `deliverables jsonb`, `turnaround_days_min/max` and `delivery_mode` columns, editors in `ops/catalogue/[slug]`, and rendering on the service page.
10. **CAT-06 server search.** Size M. Add `pg_trgm` and a tsvector across rw/en/fr name, summary and tags; `GET /api/services?q=&category=&price=&turnaround=` with facets.
11. **CAT-07 SEO per language.** Size S. Add a slug/meta/OG per locale on services; FAQPage and BreadcrumbList JSON-LD; per-service FAQ entries.
12. **CAL-08 missed escalation.** Size S. `markMissed` should notify the agent/SM and the client (penalty info) and set `applications.flag`.
13. **CMS-14 re-accept terms.** Size S. Compare `terms_acceptances.policy_version` with the current legal doc version on session and show an interstitial.
14. **CMS-12 credential verification.** Size M. Add `team_credentials` (private doc, verified_by, issuer) with an SM verify action and a public "Verified" badge.
15. **MSG-05 typed cards.** Size M. Card kind enum with FK payloads (invoice_id, requirement_key, quote_id plus accept/decline endpoint, deliverable_id, visit_id) and renderers in the client thread.
16. **NTF-14 staff/exec digests.** Size S. Daily staff cron (overdue, due today) and a weekly exec cron.
17. **NTF-03 email.** Size S. Proper HTML template, a List-Unsubscribe header for marketing, and a Resend bounce webhook writing to suppressions.

### P2
18. **NTF-04/06/13 WhatsApp Cloud plus fallback chain plus inbound.** Size L. Add a WhatsApp provider service, an ordered chain per event with "no delivered in N min" fallthrough, and inbound webhooks threading into MSG (F-MSG-12).
19. **CAL-04 client calendar.** Size M. `GET /api/me/obligations`, `/me/obligations.ics`, `POST /me/obligations/:id/request` (creates an application), and the `(client)/dashboard/calendar` page.
20. **CAL-07 auto-case.** Size S. The daily job creates the application at `lead_days` for covered obligations, assigned to the dedicated agent.
21. **CAL-03 org flags.** Size M. Generate obligations from org profile flags (VAT-registered, employer).
22. **CAT-10 price change approval.** Size M. `service_price_changes` (pending, effective_at, approved_by) and a finance approvals queue item.
23. **NTF-08/12 quiet-hours deferral and cost caps in `deliver`.** Size S/M.
24. **NTF-10 templates used by sends.** Size M. Persist templates in a DB table and render notifications by template key.
25. **MSG-11 FTS.** Size S. tsvector column plus GIN index, and a global SM search endpoint.
26. **MSG-14 complaint conversion.** Size S. `POST chat/conversations/:id/complaint` creates an FBK ticket with a link.
27. **BKG-07 real video rooms.** Size S. Jitsi room URL (free) or Google Calendar API Meet.
28. **BKG-06 FIN invoice.** Size M. Booking payment should create a FIN invoice instead of a standalone `bkg_payments` record.
29. **BKG-02 WRK leave sync.** Size S. Subtract approved leave from availability.
30. **CMS-08 knowledge feedback and subscribe.** Size S. Persist `Helpful` votes; regulatory subscribe writes a CRM lead with consent.
31. **CMS-18 status feed.** Size S. Read uptime and incidents from `system/ops`.
32. **NTF-17 manual send.** Size S. A "Send template" action in `marketing/customers/[id]` and `ops` client view, logged.
33. **CAT-09 related/bundles.** Size S. `service_links` table and a picker.
34. **CAL-11 shared reminder engine.** Size M.

### P3
35. **AIA-06 handoff creates an MSG support conversation.** Size S. Insert `conversations(kind='support')` with transcript and summary for visitors and clients without a case.
36. **AIA-12 eval set to 150 cases (50 per language).** Size M.
37. **AIA-04 missing tools.** Size S. Add `estimate_fee` (pricing engine) and `create_booking_hold`.
38. **CAT-13 fee explainer, CAT-14 markets.** Size S each.
39. **BKG-10 calendar sync.** Size L. **NTF-18 web push.** Size M.
