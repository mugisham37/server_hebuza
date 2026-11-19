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
| F-CAT-01 | Category tree | P1 | PARTIAL | Server: CRUD at `modules/catalogue/catalogue.controller.ts:31-78`; colour and icon columns on `services`. Web: the public tree comes from the seed plus the static `content/families` file, not `/api/service-categories`. |
| F-CAT-02 | Service record | P1 | PARTIAL | Server: localised columns in `db/schema/schema.ts` (services) plus tiers. Admin: `ops/catalogue/[slug]`. Public page reads the seed. |
| F-CAT-03 | Versioned form builder | P1 | DONE | `service_structure_versions`; draft/publish/versions/in-flight-count routes at `catalogue.controller.ts:132-162`; `applications.structureVersionId` pins each case. Web: `ops/catalogue/[slug]` calls `/structure/*`. |
| F-CAT-04 | Pricing modes | P1 | DONE | `pricingMode`, `service_price_bands`, `urgentSurcharge*`, `governmentFee` in tiers. Web: `services/[slug]` price card and the urgent toggle (`organisms/site/interactive.tsx:90`). Public data comes from the seed. |
| F-CAT-05 | Structured service facts | P1 | PARTIAL | Only `required_documents` exists, derived from the structure (`catalogue.service.ts:220`). No `eligibility[]`, `deliverables[]`, `turnaround_days_min/max` or `delivery_mode` columns; turnaround exists only as `etaBusinessDays` per tier. |
| F-CAT-06 | Catalogue search | P1 | PARTIAL | Client-side fuzzy search over the seed (`web/src/components/molecules/site/search.ts:1`). No server FTS, `pg_trgm` or facets; `GET /services` has no query parameter (`catalogue.controller.ts:21`). |
| F-CAT-07 | Dedicated service pages | P1 | PARTIAL | `services/[slug]/page.tsx` emits `Service` JSON-LD (l.56). The FAQ block is generic site copy (l.193), not per service. No FAQPage or BreadcrumbList on this page. No per-language SEO slug, meta or OG fields on the service record. |
| F-CAT-08 | Consultation-only services | P1 | MISSING | No `engagement_type` enum on services, and the service page CTA does not switch to booking. |
| F-CAT-09 | Related & bundled | P2 | PARTIAL | "Related" is just the first 3 services in the same family (`services/[slug]/page.tsx:50`). No manual links, no "often together", no basket suggestions. |
| F-CAT-10 | Price change approval | P2 | MISSING | Pricing PUT writes directly. No pending change, finance approval or effective date. |
| F-CAT-11 | Service availability | P2 | DONE | Status set `draft/published/paused/archived` (`catalogue.service.ts:63`); the public page renders the paused state. |
| F-CAT-12 | Revenue rule per service | P2 | PARTIAL | Revenue rules live in finance (`finance/revenue/rules/new`). There is no per-service default % on the catalogue record; not verified further. |
| F-CAT-13 | Indicative fee explainer | P3 | MISSING | No approved explainer text field. |
| F-CAT-14 | Cross-border flag | P3 | MISSING | No `markets[]` field and no currency display. |

## Consultation booking (BKG)
| F-ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| F-BKG-01 | Consultation types | P2 | DONE | `bkg_types` (`schema-booking.ts:43`) with buffer, notice, horizon, maxPerDay and intake; admin routes at `booking.controller.ts:258-268`; web `ops/bookings`. |
| F-BKG-02 | Adviser availability | P2 | PARTIAL | `agent/availability` GET/PUT (`booking.controller.ts:203-208`) with overrides. No sync with WRK leave was found. |
| F-BKG-03 | Slot engine | P2 | DONE | `domain/booking/rules.ts:11` (holdMin 10); `pickAdviser` (`booking.service.ts:630`); advisory-lock holds (l.590). External busy time is not included because F-BKG-10 is not built. |
| F-BKG-04 | Public booking page | P2 | DONE | `(public)/book`, `book/[type]`, `book/confirmed/[ref]`; `lib/booking/api.ts:33-38`. |
| F-BKG-05 | Free consultation request | P1 | DONE | `POST consultation-requests` (`booking.controller.ts:110`) plus the admin queue (l.248); web `book/callback`. |
| F-BKG-06 | Paid booking | P2 | PARTIAL | `pending_payment`, pay window and expiry with auto-refund (`booking.service.ts:993-1148`). It uses its own `bkg_payments` table, not a FIN invoice. |
| F-BKG-07 | Video meeting link | P2 | PARTIAL | `joinUrl` is a random `meet.google.com/hbz-…` string (`booking.service.ts:121,649`), not a real Meet or Jitsi room. Join-window gating exists (`rules.ts`). |
| F-BKG-08 | Reminders | P2 | PARTIAL | `planReminders` and the `booking.reminders` cron (`booking.jobs.ts:107`); ICS generation exists. Delivery uses the NTF job, which has no WhatsApp→SMS→email fallback chain (see F-NTF-06). |
| F-BKG-09 | Reschedule & cancel | P2 | DONE | `rules.ts:12,123-146` (12 h cutoff, max 2 reschedules, refund/forfeit, tested in `rules.test.ts`); manage-by-token and `/me/bookings` routes; web `book/manage/[token]`, `(client)/bookings/[id]`. |
| F-BKG-10 | Calendar sync | P3 | MISSING | No Google or Microsoft OAuth. |
| F-BKG-11 | Outcome & conversion | P2 | PARTIAL | Outcome, notes, recommended services and start links (`booking.service.ts:1616-1633`); web `agent/bookings/[id]`. Creating a quote and updating the CRM stage were not verified. |
| F-BKG-12 | No-show handling | P2 | DONE | `autoNoShowMin 15`, `noShowLimit 2` force prepayment (`rules.ts:14`, `booking.service.ts:530,918`); sweep cron. |
| F-BKG-13 | Waitlist | P3 | DONE | `bkg_waitlist`, `POST bookings/waitlist`, FIFO offer job (`booking.service.ts:1427`). The 30-min claim window was not verified. |
| F-BKG-14 | Calendar views | P2 | DONE | `agent/calendar`, `ops/bookings` board, admin reassign/auto-reassign (`booking.service.ts:1824-1943`). |

## Chat & communications (MSG)
| F-ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| F-MSG-01 | Case conversation | P1 | DONE | Lanes client/team/internal; `chat/conversations/by-application`; web `agent/inbox`, `requests/[ref]`. |
| F-MSG-02 | Direct conversations | P1 | DONE | `staff_dm` (`chat.service.ts:1373-1394`). |
| F-MSG-03 | Support conversation | P1 | PARTIAL | Support kind exists (`chat.service.ts:290`) with link-to-case (l.1709). Visitor/AI handoff and inbound channels do not create one (see F-AIA-06, F-MSG-12). |
| F-MSG-04 | Rich messages | P1 | DONE | 15-min edit window plus history (`chat.service.ts:67,1031`); `message_edits`, reactions, pins, mentions, references. |
| F-MSG-05 | Structured cards | P1/P2 | PARTIAL | A generic `card` route by staff (`chat.service.ts:1179`) and an appointment ICS (l.1240). No typed kinds or links for payment_request, document_request, quotation (accept/decline), deliverable_ready or visit_checkin. |
| F-MSG-06 | Receipts & presence | P1 | DONE | read seq (`conversations/{id}/read`), `typing` (l.869), `realtime/focus`. |
| F-MSG-07 | Realtime + offline | P1 | DONE | SSE `realtime/stream`; `client_msg_id` idempotency; web `lib/agent/outbox.ts`. |
| F-MSG-08 | Templates | P1 | DONE | `chat_templates`, `/render` (`chat.service.ts:1975`), web `agent/inbox/templates`. |
| F-MSG-09 | Disputes | P1 | DONE | Disputes and resolve routes (`chat.controller.ts:200-210`, `chat.service.ts:2147`). The 4 h SLA timer was not verified. |
| F-MSG-10 | Oversight console | P1 | DONE | `admin/chat/*` list/counts/metrics/claim/transcript PDF (`chat.service.ts:96,1649,1753`); web `ops/conversations`. |
| F-MSG-11 | Search | P2 | PARTIAL | Search is `ilike` only (`chat.service.ts:837`). No tsvector or global search. |
| F-MSG-12 | Omnichannel threading | P2 | MISSING | No inbound WhatsApp/SMS/email to conversation path. |
| F-MSG-13 | Enquiry SLA & escalation | P1 | MISSING | No first-response timer, business-hours calendar or escalation chain for support conversations. |
| F-MSG-14 | Complaint flag | P2 | MISSING | No convert-to-FBK action. |
| F-MSG-15 | Retention & legal hold | P1 | MISSING | No `chat_retention_years` archival job and no legal-hold flag. |
| F-MSG-16 | Attachment safety | P1 | DONE | Goes through the `documents.finalize` job (sniff, scan, EXIF strip; `chat.service.ts:724`) and short-lived download URLs. HEIC→JPEG was not verified. |
| F-MSG-17 | Conversation summary | P3 | DONE | `assistant/copilot/{kind}` "summarise" (`assistant.controller.ts:136`). |
| F-MSG-18 | Read-only after closure | P1 | MISSING | No rule that closes the client lane 30 days after closure or reopens it as a support enquiry. |

## Notifications & channels (NTF)
| F-ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| F-NTF-01 | Event catalogue | P1 | PARTIAL | `system/notifications/rules` config (`system.config.ts:532`) is held in the system "world" store. `NotificationsJobs.deliver` does not consult it; each caller hardcodes its channels. |
| F-NTF-02 | In-app centre | P1 | DONE | `notifications.controller.ts:12-18`, SSE emit (`notifications.jobs.ts:37`), web `(client)/notifications`, `organisms/client/notifications.tsx`. |
| F-NTF-03 | Email | P1 | PARTIAL | Sent through `core/notify/mail.service.ts`; HTML is just escaped text. No bounce/complaint webhook to suppression and no List-Unsubscribe on transactional mail. |
| F-NTF-04 | WhatsApp Business | P2 | MISSING | WhatsApp is routed through SMS (`notifications.jobs.ts:46` shortcut). No Cloud API and no 24 h window. |
| F-NTF-05 | SMS | P1/P2 | PARTIAL | `core/notify/sms.service.ts` exists and is used for OTP. GSM-7 segmenting and the sender-ID config were not verified. |
| F-NTF-06 | Channel router & fallback | P2 | MISSING | Channels are sent in parallel, best-effort, with no ordered fallback. |
| F-NTF-07 | Preferences | P1 | PARTIAL | `notification_preferences` with matrix/quiet JSON (`notifications.service.ts:96-110`); web `settings/notifications`. `deliver` checks only `email_enabled`; the per-category matrix, language and digest frequency are not enforced. |
| F-NTF-08 | Quiet hours | P2 | PARTIAL | Stored in preferences and in booking rules. `deliver` does not defer messages. |
| F-NTF-09 | Consent ledger | P1 | MISSING | Consent exists only per CRM lead (`marketing.crm.controller.ts:71`). No ledger rows with source/IP/policy version, and no STOP/HAGARIKA handling. |
| F-NTF-10 | Template registry | P2 | PARTIAL | Lint, versions and Meta review are simulated in the system world store (`system.config.ts:583-777`); web `system/notifications/templates/[key]`. Sends do not use these templates. |
| F-NTF-11 | Delivery tracking | P1 | MISSING | No `notification_deliveries` table. The system console shows seeded rows (`system.config.ts:786`). No provider webhooks and no backoff retries per channel. |
| F-NTF-12 | Cost metering & caps | P2 | PARTIAL | Budget config UI and API (`system.config.ts:799-822`). No per-delivery cost and no cap enforcement in `deliver`. Marketing campaigns have their own cap. |
| F-NTF-13 | Inbound channels | P2 | MISSING | — |
| F-NTF-14 | Digests | P1 | PARTIAL | Hourly client unread digest (`notifications.jobs.ts:53`). No daily staff or weekly exec digest. |
| F-NTF-15 | Suppression & dedupe | P1 | PARTIAL | Job-id idempotency only (`notifications.jobs.ts:34`). No event+recipient dedupe window and no suppression list. |
| F-NTF-16 | Secure links | P1 | DONE | Messages carry a title, body and portal link only (`notifications.jobs.ts:43`); the manage token is sealed in the outbox. |
| F-NTF-17 | Manual send | P2 | MISSING | No send-template-to-client from the client profile. |
| F-NTF-18 | Web push | P3 | MISSING | — |

## AI assistant (AIA)
| F-ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| F-AIA-01 | Chat widget | P3 | DONE | `organisms/booking/launcher-lazy.tsx`, `assistant.tsx`; `(public)/assistant`; mounted in the public and client layouts; streaming sessions API. |
| F-AIA-02 | Approved KB | P3 | PARTIAL | `ai_kb_sources`/`chunks`/`embeddings` and reindex (`assistant.engine.ts:6,267`). Sources come from the CMS and catalogue tables, which the public site does not serve (see top). pgvector is only used when the Voyage key is set. |
| F-AIA-03 | Model routing | P3 | DONE | Anthropic SDK (`assistant.engine.ts:8`); model is config-driven; fast model for copilot (l.767). |
| F-AIA-04 | Tools | P3 | PARTIAL | A deterministic router handles case status, booking, intake, lead and handoff; Claude gets 3 read tools (`assistant.engine.ts:1-5`). No `estimate_fee` against the pricing engine and no `create_booking_hold` tool was found. |
| F-AIA-05 | Guided intake & draft | P3 | DONE | `ai_drafts`, `GET assistant/drafts/:id`; the draft is handed to the wizard, so the assistant never submits. |
| F-AIA-06 | Human escalation | P3 | PARTIAL | `ai_handoffs` plus a claim queue (`ops/assistant`). It writes a case-thread note only when the client has a case; otherwise it uses a synthetic `ai-<id>` id (`assistant.engine.ts:525-550`) and no MSG support conversation is created. |
| F-AIA-07 | Guardrails | P3 | DONE | Regex input/output guards (`assistant.engine.ts:133-176`). |
| F-AIA-08 | PII protection | P3 | DONE | `maskPii` before storage and before the model (`assistant.engine.ts:135,854`). |
| F-AIA-09 | Logs & retention | P3 | DONE | `ai_sessions`/`ai_messages`/`ai_usage`, rating route, nightly retention purge (`assistant.jobs.ts:20`). |
| F-AIA-10 | Cost control | P3 | DONE | `budgetUsd`, token counters in Redis, `ai_usage` monthly cap (`assistant.engine.ts:66,798`). The per-IP 30/day cap was not verified. |
| F-AIA-11 | Data-use guarantees | P3 | N/A | Contract/DPA work, not code. Only Anthropic and Voyage are called. |
| F-AIA-12 | Eval set & QA | P3 | PARTIAL | The runner is real and blocks deploy below 95% (`assistant.service.ts:1215-1320`), but `EVAL_SET` has about 12 base cases plus a few fr/rw (l.1644-1718), against the 150 required. |
| F-AIA-13 | Staff copilot | P3 | DONE | `POST assistant/copilot/{kind}`; used in the agent case view. |
| F-AIA-14 | Kill switch | P3 | DONE | `ai_settings.enabled`, `assistant/status`, admin settings PUT. |
| F-AIA-15 | Documented limitations | P3 | DONE | `(public)/assistant/about/page.tsx`. |

## CMS & knowledge centre (CMS)
| F-ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| F-CMS-01 | Content types | P1/P2 | PARTIAL | All 10 types exist (`web/src/shared/marketing/types.ts:8`) with admin screens under `marketing/*`. The public site renders the seed, not `cms_entries`. |
| F-CMS-02 | Block editor | P1 | DONE | JSON blocks (`BlockShape`, `RichDoc`) in `marketing/content/[entryId]`. |
| F-CMS-03 | Multilingual entries | P1 | DONE | Variant routes, fallback (`resolveVariant`), `/translate` (machine-translation draft). |
| F-CMS-04 | Workflow | P1 | DONE | submit/approve/request-changes/schedule/publish/archive, versions and restore, comments, locks (`cms.controller.ts:32-147`). |
| F-CMS-05 | SEO fields | P1 | PARTIAL | Per-variant SEO plus `marketing/seo` screen. These never reach public pages because of the seed reader. |
| F-CMS-06 | Media library | P1 | DONE | `admin/cms/media` CRUD, complete, usage (`marketing.insights.controller.ts:116-143`); web `marketing/media`. WebP/AVIF variants were not verified. |
| F-CMS-07 | Navigation & site settings | P1 | PARTIAL | `cms_nav` and `cms_site_settings` APIs plus UI. The public header and footer do not read them (seed and static content). |
| F-CMS-08 | Knowledge centre | P2 | PARTIAL | `/knowledge` with search and filters over the seed. The `Helpful` widget does not persist (no API). No regulatory-updates subscription. |
| F-CMS-09 | FAQs | P1 | PARTIAL | `/faq` reads seed FAQs (`lib/marketing/cms/read.ts`); `admin/assistant/unanswered` exists. No per-service FAQs on service pages. |
| F-CMS-10 | Regulatory updates | P2 | PARTIAL | Type, review_by and `/updates` pages exist. No auto-link to CAL rules and no campaign trigger. |
| F-CMS-11 | Landing pages | P2 | PARTIAL | `marketing/landing`, `campaign/[slug]`; public pages come from the seed. |
| F-CMS-12 | Team & credentials | P1 | PARTIAL | `team_member` type and `about/team`. No credential-document verification flow. |
| F-CMS-13 | Service page content | P1 | PARTIAL | Facts come from CAT (seed). No per-service CMS copy, FAQs or testimonials attached. |
| F-CMS-14 | Legal documents | P1 | PARTIAL | `legal/[doc]` (seed) and `terms_acceptances` (`auth.service.ts:456`). No re-accept prompt on material change. |
| F-CMS-15 | Cookie consent | P1 | PARTIAL | `organisms/site/cookie-consent.tsx` stores the choice in a first-party cookie only. Nothing is written to the NTF consent ledger; Consent Mode wiring is in `tracking.tsx`. |
| F-CMS-16 | Redirects & slugs | P1 | DONE | `cms_redirects`, `cms_not_found`, `content/not-found` logging, UI. |
| F-CMS-17 | Preview & caching | P1 | PARTIAL | `content/preview`, preview-token, revalidate, `content/rss`, `web/src/app/sitemap.ts`/`robots.ts`. Effective only for seed content. |
| F-CMS-18 | Status page | P2 | PARTIAL | `/status` renders `StatusBoard` from static content. No uptime feed. |
| F-CMS-19 | Testimonials & logos | P2 | DONE | `admin/fbk/testimonials` with a consent check (`marketing.insights.ts:752`); web `marketing/testimonials`. |

## Deadlines & compliance calendar (CAL)
| F-ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| F-CAL-01 | Deadline rules per service | P1 | DONE | `service_deadline_rules`, `compliance-calendar` CRUD (`compliance.controller.ts:22-49`); web `ops/compliance-rules`. |
| F-CAL-02 | National compliance calendar | P2 | PARTIAL | Rules plus holidays are editable; the §12 seeded statutory list was not verified. |
| F-CAL-03 | Obligation generation | P2 | PARTIAL | Generated for subscribed clients with a dedicated agent (`deadlines.service.ts:186-232`). No generation from ORG profile flags (VAT, employer). |
| F-CAL-04 | Client compliance calendar | P2 | MISSING | No `/dashboard/calendar`, no client obligations endpoint, no ICS feed, no "ask HEBUZA" action. |
| F-CAL-05 | Agent/manager calendar | P1 | DONE | `GET agent/calendar` (`agent.controller.ts:81`), `POST agent/obligations/:id/:action`; web `agent/calendar`. |
| F-CAL-06 | Reminders multi-channel | P2 | PARTIAL | `deadline_notifications` offsets; email only (`deadlines.service.ts:433`). |
| F-CAL-07 | Auto-case creation | P2 | MISSING | No application is created at `lead_days`. |
| F-CAL-08 | Missed & escalation | P1 | PARTIAL | `markMissed` only flips the status (`deadlines.service.ts:265`). No manager alert, no client penalty notice, no case flag. |
| F-CAL-09 | Holiday calendar | P2 | DONE | `compliance_holidays`, `public-holidays`, weekend/holiday roll (`compliance.service.ts:2,54`). |
| F-CAL-10 | Case SLA & due dates | P1 | PARTIAL | `dueAt/dueSource/clientPreferredDate` and `recordBreaches` (l.280). The propose/accept change flow was not verified. |
| F-CAL-11 | Contract/renewal reminders | P2 | PARTIAL | Each module (work, procurement) has its own expiry logic; there is no shared engine. |

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
