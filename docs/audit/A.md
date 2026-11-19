# Audit A: identity, client portal, orgs, requests, documents, deliverables, feedback

Date 2026-11-19. Read-only audit of `server/src` + `web/src` against `spec/05-modules`. Paths: S = `server/src/`, W = `web/src/`.
Heads-up: much state lives in the generic `system_records` JSON table (ops "x" case data, orgs, consents, tickets, reviews). That still counts as persisted, but nothing in it has a schema or constraints.

## identity-and-access (IAM)
| F-ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| F-IAM-01 | Multi-role users | P1 | PARTIAL | Roles come from `users.role` plus `system_records userMeta.extraRoles` (S modules/auth/auth.service.ts:195-211). There is no `user_roles` table, no `active_role` and no web role switcher. Legacy `staff:admin` maps to 3 roles (S domain/auth/roles.ts:65, marked shortcut) |
| F-IAM-02 | Permission registry | P1 | DONE | `can()` registry; system roles/matrix pages (W app/[locale]/(system)/system/roles/matrix/page.tsx; S system.governance.controller.ts:39) |
| F-IAM-03 | Ownership checks (404) | P1 | PARTIAL | `can()`/`assertCanRead` is used in documents, applications, agent and booking (12 call sites). There is no single `authorize()` gate. Some paths return 403 `forbidden()` instead of 404 (S modules/documents/documents.service.ts:464,489) |
| F-IAM-04 | Client signup/login + OTP gate | P1 | DONE | Signup, login and verify-otp (S auth.controller.ts:37-73). Submit is blocked when unverified (S applications.service.ts:614-617), and so is deliverable download (documents.service.ts:465-468). W (auth)/signup, verify |
| F-IAM-05 | SMS OTP | P1 | PARTIAL | SmsService exists (S core/notify/sms.service.ts:53), but OTP goes by SMS only when the user has no email (auth.service.ts:283-301). No WhatsApp fallback and no separate phone verification |
| F-IAM-06 | TOTP MFA | P1 | DONE | S auth.mfa.ts (enrol/verify/step-up), pre-2FA cookie (auth.service.ts:533-548). W (auth)/login/2fa, team/mfa/setup. Note: the pre-2FA TTL is 5 min, not the spec's 10 min |
| F-IAM-07 | Backup codes | P1 | DONE | backup codes hashed with Argon2id (legacy sha256 rows still verify). Issued and regenerated (S auth.mfa.ts:98, auth.controller.ts:272). The file header says they are hashed with sha256, but the spec requires Argon2 |
| F-IAM-08 | Trusted devices | P1 | DONE | trusted devices never skip MFA for staff:finance / staff:sysadmin (login + trust creation). 7-day device cookie and list/revoke (auth.mfa.ts:205-225, auth.controller.ts:282-292). The spec's "never for sysadmin/finance" exclusion is not enforced |
| F-IAM-09 | MFA recovery | P1 | DONE | `auth/team/access-request` kind two_factor (auth.controller.ts:114), admin `staff/users/:id/mfa-reset` (system.users.controller.ts:85), W system/users/[id] |
| F-IAM-10 | Staff lockout | P1 | DONE | verified from 90e4816: staff 10/24h lockout until unlock request. One generic lockout: 5 tries / 15 min, auto-expiring (auth.service.ts:59-60,386-404). The staff rule (10/24h, locked until an unlock access request) is missing. The admin unlock route exists (system.users.controller.ts:94) |
| F-IAM-11 | Session policy | P1 | DONE | verified from 90e4816 + dcf7344: idle (real activity) + absolute session end. `platform_settings.session_timeout_minutes` is stored (platform.service.ts:15). There is no per-role idle enforcement in refresh, no absolute 24h/8h lifetime (refresh lives 30d, core/auth/tokens.ts:15) and no 2-min warning modal in web |
| F-IAM-12 | IP allowlist | P2 | DONE | Closed 2026-11-19: PlatformGuard CIDR allowlist for sysadmin/finance. (was PARTIAL) |
| F-IAM-13 | Session management | P1 | DONE | me/sessions list/revoke and admin revoke (auth.controller.ts:196-325). W components/organisms/client/settings-security.tsx. No geo-IP (shortcut) |
| F-IAM-14 | Invitations | P1 | DONE | staff/users/invitations, auth/invite/:token, set-password, forced MFA setup (W (auth)/team/invite/[token]). Expiry/terms+NDA step not verified |
| F-IAM-15 | Impersonation | P2 | DONE | user notified (in-app + email) when an impersonation ends, with date and reason. Reason ≥10 chars, protected targets, audited start/end (S auth.admin.ts:155-251), banner in W (system)/layout.tsx. No "notify user afterwards" |
| F-IAM-16 | Password policy | P1 | DONE | verified from 0e0cfb7: client min 10, staff 12 + classes, HIBP breach check at signup/reset. Staff need ≥12 chars (auth.rules.ts:48), but clients need only ≥8, not 10 (auth.dto.ts:37). `PasswordService.isBreached` (core/auth/password.ts:21) is never called |
| F-IAM-17 | Seed admin fix | P1 | DONE | verified from 0e0cfb7: admin-create never overwrites; TOTP enrolment forced at first sign-in. `admin-create.ts:27` uses `onConflictDoUpdate`, which overwrites the password (the B13 bug the spec says to fix). It also creates the admin with twofa off rather than forced MFA at first sign-in |
| F-IAM-18 | Forgot password | P1 | PARTIAL | forgot/reset routes exist (auth.controller.ts:79-89). For staff, MFA after reset relies on the normal login MFA; there is no explicit post-reset MFA requirement |
| F-IAM-19 | Personal data export | P2 | PARTIAL | me/data-export builds a JSON synchronously (S account.service.ts:217-260). It has only profile, apps, notifications and consents: no messages, invoices, documents, ZIP, email link or 24h expiry. W settings-privacy.tsx |
| F-IAM-20 | Account deletion | P1 | DONE | verified from 90e4816 + 38c73ce: 14-day cooling-off, sweep, finance pseudonymisation. `DELETE /api/auth/account` anonymises immediately and is blocked when cases are open (auth.service.ts:962-1000). There is no 14-day cooling-off and no retention pseudonymisation of finance records |
| F-IAM-21 | Consent/terms | P1 | DONE | Closed 2026-11-19: settings consents append to the versioned consent ledger per channel. (was PARTIAL) |
| F-IAM-22 | Company representatives | P2 | PARTIAL | See ORG: org roles owner/admin/member live in a per-user JSON doc |
| F-IAM-23 | Access reviews | P3 | DONE | Quarterly job (S system.jobs.ts:69), W system/access-reviews |
| F-IAM-24 | Customer ID | P1 | DONE | verified from 40c0d27/0e0cfb7: users.customer_no assigned + backfilled, shown in session/admin/CRM. `customerNo` exists only in the system store seed (seed/system.ts:467). There is no `users` column or sequence and nothing is assigned at signup |

## client-portal (CLP)
| F-ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| F-CLP-01 | Registration & login | P1 | DONE | as IAM-04 |
| F-CLP-02 | Password recovery | P1 | PARTIAL | Email link, plus SMS only when the user has no email (IAM-05). W (auth)/forgot, reset |
| F-CLP-03 | Profile | P1 | PARTIAL | `PATCH me/profile` accepts only name and phone (S auth.dto.ts:100-103), plus avatar (account.controller.ts:35-41). Missing: language persistence, address, encrypted national ID |
| F-CLP-04 | Customer ID | P1 | MISSING | No `CUS-YYYY-NNNNN` generation and nothing shown in the portal or invoices (see IAM-24) |
| F-CLP-05 | Dashboard | P1 | PARTIAL | me/dashboard returns needs, requests and paymentsDue (S applications.service.ts:468-485). Missing cards: deadlines, open quotes, recent messages, released deliverables, subscription. W components/organisms/client/dashboard.tsx |
| F-CLP-06 | Requests list | P1 | PARTIAL | Tabs, search by code and service filter (W client/requests.tsx:25). No group (RG) view, because groups do not exist |
| F-CLP-07 | Quotes & invoices | P1 | DONE | W client/billing.tsx:687 accept/decline; receipts (S payments.controller.ts:53). Audited in FIN group |
| F-CLP-08 | Documents & deliverables | P1 | PARTIAL | Library works (W (client)/documents, vault.tsx). The "Results" tab reads the `deliverables` table, which only the seed writes (see DLV-01) |
| F-CLP-09 | Messages | P1 | DONE | W (client)/messages/page.tsx; S chat.controller.ts |
| F-CLP-10 | Consultations | P2 | DONE | W (client)/bookings; S booking.controller.ts:136 |
| F-CLP-11 | Feedback & complaints | P2 | PARTIAL | Rate (deliverables.tsx:372) and complaint ticket (help.tsx:39) work. But client tickets go to `support_tickets` (S applications/support.service.ts), not the ops ticket register |
| F-CLP-12 | Reminders hub | P2 | MISSING | No hub and no snooze/done. Only dashboard "needs" |
| F-CLP-13 | History & request again | P2 | PARTIAL | W client/history.tsx:72 links to `/apply/{slug}`. Nothing is cloned (no answers or documents reused) |
| F-CLP-14 | Consent centre | P1 | PARTIAL | me/consents GET/PUT (account.controller.ts:20-23), W settings-privacy.tsx. Missing: profile_reuse, per-channel marketing, AI history, timestamped log |
| F-CLP-15 | Data export & deletion | P1 | PARTIAL | see IAM-19/20 (JSON only, no PDF, immediate deletion) |
| F-CLP-16 | Company switcher | P2 | PARTIAL | `PUT me/orgs/active` sets the org and the JWT carries `scopes.orgId` (auth.service.ts:209), but no query is scoped by org |
| F-CLP-17 | Notification preferences | P1 | DONE | W client/settings-channels.tsx, `notification_preferences` table |
| F-CLP-18 | Security page | P2 | DONE | W (client)/settings/security, settings-security.tsx (sessions + sign out others) |

## company-profiles (ORG)
| F-ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| F-ORG-01 | Company profile | P2 | MISSING | The org is `{id,name,members}` JSON (S account.service.ts:45). No TIN/RDB/type/address and no create endpoint |
| F-ORG-02 | Authorised representatives | P2 | PARTIAL | Members with owner/admin/member and remove member (account.controller.ts:53). Roles do not match the spec, and the data is stored per user, not shared |
| F-ORG-03 | Invitations | P2 | PARTIAL | `POST me/orgs/:id/invites` records a pending invite only, with no mail, accept or expiry (account.service.ts:318, shortcut) |
| F-ORG-04 | Verification | P2 | MISSING | — |
| F-ORG-05 | Company customer ID | P2 | MISSING | — |
| F-ORG-06 | Profile reuse in forms | P2 | MISSING | No binding of structure fields to profile paths |
| F-ORG-07 | Company document vault | P2 | MISSING | — |
| F-ORG-08 | Party switcher | P2 | PARTIAL | W client/orgs.tsx + me/orgs/active. Data is not scoped by it |
| F-ORG-09 | Company timeline | P2 | MISSING | — |

## service-request-lifecycle (REQ)
| F-ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| F-REQ-01 | Submit single-service | P1 | DONE | `applications/submit`, server-side fee (S applications.service.ts:613-721), W flow/apply-wizard.tsx. No idempotency key on submit |
| F-REQ-02 | Service basket | P1 | PARTIAL | The basket is client-side localStorage and submits N separate cases in sequence (W apply-wizard.tsx:84,286). No request group, `RG-` code or combined payment |
| F-REQ-03 | Reference numbers | P1 | PARTIAL | `HBZ-` case code and mail (applications.service.ts:1160-1170). No RG code |
| F-REQ-04 | Canonical status machine | P1 | DONE | 16 statuses (S domain/domain/case-status.ts:2-38), transition table `movesFor` (domain/ops/transitions.ts:146) enforced in `transitionTx` (applications.service.ts:786-817) |
| F-REQ-05 | Configurable sub-statuses | P2 | DONE | S catalogue.service.ts:1296-1343, W ops/settings/statuses |
| F-REQ-06 | External outcome | P1 | PARTIAL | The agent records the outcome in ops JSON (S agent.service.ts:856). The client view derives the outcome from status instead ("shortcut: no outcome column", applications.service.ts:486). No reference/institution/date column. The UI shows it separately (W request-detail.tsx:161-172) |
| F-REQ-07 | Completeness review | P1 | DONE | `checklist/complete`, `document-request`, `documents/:doc/decision` (S ops.cases.controller.ts:163-196), domain/ops/completeness.ts |
| F-REQ-08 | SLA pause | P1 | PARTIAL | `pausesSla` flags exist (case-status.ts:23-38), but there is no paused-time tracking and `sla_deadline` is never recalculated on resume |
| F-REQ-09 | Public tracking | P1 | DONE | `track/:code` + `verify` (applications.controller.ts:40-46), W (public)/track/[code]. Coarse status, contact unlocks detail |
| F-REQ-10 | Claim guest case | P1 | PARTIAL | `POST applications/claim` matches code + phone (S account.service.ts:340-347) with no OTP step. W auth/recovery-forms.tsx |
| F-REQ-11 | Client cancellation | P1 | PARTIAL | The rule exists for the client actor (transitions.ts:166-174), but there is no client endpoint or button, and no cancellation-request flow after `in_progress` |
| F-REQ-12 | Assisted submission | P2 | MISSING | No staff "submit on behalf" with consent and claim invite (only field visit purpose `assisted_application`, field.service.ts:705) |
| F-REQ-13 | Request again | P2 | PARTIAL | see CLP-13 |
| F-REQ-14 | AI draft intake | P3 | PARTIAL | `ai_drafts` exist (assistant.engine.ts:1125). Draft → submitted case with client confirm not verified |
| F-REQ-15 | Case timeline | P1 | DONE | `admin/applications/:code/timeline` (ops.cases.controller.ts:210), client timeline (W request-detail.tsx:82,185), me/activity |
| F-REQ-16 | Completion record | P1 | MISSING | Only `completedAt` is set (applications.service.ts:803). No frozen snapshot of assignees, fee, payment, allocation or message count |
| F-REQ-17 | Refund states | P2 | PARTIAL | Statuses exist (case-status.ts:37-38). Linking to RFD and returning to the previous status on decline is not verified here |
| F-REQ-18 | Guest upload guard | P1 | PARTIAL | Case upload needs auth and rejects terminal cases (documents.service.ts:751). There is no held-case check and no 30-day rule |

## documents (DOC)
| F-ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| F-DOC-01 | Client library | P1 | DONE | me/documents CRUD (S documents.controller.ts:18-44), versions table, W client/vault.tsx |
| F-DOC-02 | Attach from library | P1 | DONE | `me/documents/:id/attach` (controller:39), used by W apply-wizard.tsx:297 |
| F-DOC-03 | Requirement uploads | P1 | DONE | `applications/:code/documents` with requirement_key (documents.service.ts:746-785) |
| F-DOC-04 | QC review | P1 | DONE | agent `documents/:id/qc` (agent.controller.ts:162), ops `documents/:doc/decision` (ops.cases.controller.ts:163) |
| F-DOC-05 | Version history | P1 | DONE | Closed 2026-11-19: restore endpoint me/documents/:id/versions/:v/restore. (was PARTIAL) |
| F-DOC-06 | Expiry tracking | P2 | DONE | Closed 2026-11-19: 60/30/0-day expiry reminders (documents.expiry cron). (was PARTIAL) |
| F-DOC-07 | Access log | P1 | DONE | `document.viewed` audit on staff file open (S account.service.ts:466), W system/audit/sensitive |
| F-DOC-08 | Malware scan | P2 | DONE | ClamAV INSTREAM job (S core/storage/scan.processor.ts:13-49), `infected` quarantine (documents.service.ts:561-570) |
| F-DOC-09 | Retention engine | P2 | PARTIAL | Retention policy, dry-run and changes (S system.ops.ts:680, privacy/retention routes) and an orphan-version purge (documents.service.ts:607). No per-class nightly flag → SM approve → crypto-shred |
| F-DOC-10 | Company vault | P2 | MISSING | see ORG-07 |
| F-DOC-11 | Guest upload guard | P1 | PARTIAL | see REQ-18 |
| F-DOC-12 | OCR / auto-classify | P3 | MISSING | placeholder only (ops.cases.ts:860) |
| F-DOC-13 | Shared docs with members | P1 | DONE | agent/papers (agent.controller.ts:439-449), partner_documents, work contract docs |

## deliverables-and-review (DLV)
| F-ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| F-DLV-01 | Deliverable upload | P1 | PARTIAL | `agent/cases/:code/deliverables` (agent.controller.ts:260, agent.service.ts:1339-1347) saves into ops JSON slots. **Nothing outside `db/seed/documents.ts:52` inserts into the `deliverables` table, which is what the client reads** (documents.service.ts:355-372). sha256 and the 25 MB limit are not verified |
| F-DLV-02 | Submit for review | P1 | DONE | `submit-review` → `awaiting_internal_review` + openReview (agent.service.ts:1425-1432), W work/jobs/[ref] |
| F-DLV-03 | Review decision | P1 | DONE | 4-eyes `own_work` check (S ops.manage.ts:708-709), return/approve, second level, W ops/reviews/[id]. `review_required` is a hard-coded NO_REVIEW set (agent.service.ts:1405), not per-service config |
| F-DLV-04 | Release gate | P1 | PARTIAL | Approve-release is blocked when unpaid unless overridden (ops.manage.ts:715-716, override :748), and downloads check the balance (documents.service.ts:469-476). No plan/pay-later branches and no `held_for_payment` state. Release never reaches the `deliverables` table (see DLV-01) |
| F-DLV-05 | Watermarked preview | P2 | MISSING | `deliverables/:id/preview` returns the raw presigned file. No stamping (work.service.ts:1634 shortcut) |
| F-DLV-06 | Secure download links | P1 | PARTIAL | `deliverables/:id/download` checks auth and returns a presigned URL (documents.service.ts:794-799). No single-use 72h signed email/WA tokens |
| F-DLV-07 | Download log | P1 | DONE | `deliverable.downloaded` audit (documents.service.ts:797) |
| F-DLV-08 | Delivery receipt | P2 | PARTIAL | `deliverables/:id/receipt` records accepted/changes_requested and notifies the agent (documents.service.ts:482-500). It does not open an FBK complaint |
| F-DLV-09 | Deliverable vault | P1 | PARTIAL | W client/deliverables.tsx + me/deliverables exist but only show seeded rows (DLV-01). No "save to library" |
| F-DLV-10 | E-signature hook | P3 | MISSING | — |

## feedback-complaints-ratings (FBK)
| F-ID | title | phase | status | evidence / gap |
|---|---|---|---|---|
| F-FBK-01 | Case rating (CSAT) | P2 | DONE | wave 3: D+2/D+7 reminders (`ops.rating_reminders`), 7-day edit window in rateCase. `me/deliverables/:code/rating` with stars, tags and comment (documents.service.ts:810, rateCase ~:513), W deliverables.tsx:372. No D+2/D+7 reminders and no 7-day edit window |
| F-FBK-02 | NPS survey | P3 | DONE | wave 4: nps_responses table, GET/POST me/nps (after 2nd delivered case or 90 days, 180-day repeat), dashboard NPS card, marketing NPS reads real answers. Marketing feedback/NPS report (S marketing.insights.ts:838). No 90-day/2nd-case survey trigger |
| F-FBK-03 | Complaints register | P2 | DONE | wave 5: severity ladder critical 4 h / high 1 / normal 3 / low 5 business days, audited `severity` action + select. wave 4: unified register `admin/ops/register` + "All channels" tab; severity ladder still high/medium/low. Ops tickets with complaint/dispute/enquiry kinds, category, priority and responseDueAt (S ops.manage.ts:947-972), W ops/tickets. Severity uses high/medium/low rather than the spec's critical-4h SLA ladder. Client complaints go to a separate `support_tickets` table (support.service.ts) |
| F-FBK-04 | Dispute unification | P2 | DONE | wave 4: chat disputes are ops tickets; one register over ops, help desk and website enquiries. Ops tickets cover chat disputes (ops.manage.ts:1081-1118), but the chat module keeps its own `chat/.../disputes` (chat.controller.ts:194-210). There are two to three registers |
| F-FBK-05 | Enquiry inbox | P2 | DONE | wave 5: website enquiries assign/reply (email)/convert-to-lead/close from the register. wave 4: enquiries appear in the register; assign/reply/convert still in marketing inbox. `contact_inquiries` (cms.service.ts:1424) and W marketing/inbox. Assign/reply/convert-to-request not verified, and they are not tickets in the register |
| F-FBK-06 | Escalation ladder | P2 | DONE | wave 3: `ops.ticket_escalation` SM at response target, exec +24 h. Manual `escalate` action (ops.manage.ts ~1210). No SLA-driven job to SM/exec |
| F-FBK-07 | Resolution & follow-up | P2 | DONE | wave 4: resolution kind enum required on resolve; reopen only within 14 days. resolve/confirm/reopen/refund/credit/reassign actions (ops.manage.ts:1140-1240). There is no resolution-kind enum, and the 14-day reopen limit was not verified |
| F-FBK-08 | Low-rating alert | P2 | DONE | wave 3: `ops.low_rating` rating ≤2 → high complaint + SM alert. No rating ≤2 → complaint + SM alert |
| F-FBK-09 | Testimonials | P3 | DONE | S marketing.insights.ts:701, W marketing/testimonials |
| F-FBK-10 | Agent quality score | P2 | DONE | wave 3: `ops.quality_scores` CSAT/complaints/on-time → agent_profiles rating/onTime used by rankAgents. CSAT and complaint rate are not fed into WRK/ASN scoring (nothing found in agent/ops performance) |

## Journeys (client-individual, company-rep, visitor, internal-agent, service-manager)
- Visitor → track → claim: works, but claim has no OTP (REQ-10).
- Client individual: works end to end until deliverables. Agent-uploaded files never reach the client's "Results" (DLV-01): **this breaks the core journey**.
- Company rep: blocked. There is no way to create an org, org data is not scoped, and invites are not sent (ORG).
- Internal agent: QC, deliverable upload, submit-review and outcome work (W (work)/work/jobs/[ref], (agent)/agent/cases/[ref]).
- Service manager: completeness, reviews with 4-eyes, override, tickets and SLA board work. SLA pause and the escalation job are missing.

## Gaps (by phase)
### P1
1. **DLV-01/04/09 deliverables never reach the client** (M). On final approve-release in `reviewDecision` (ops.manage.ts) and in the NO_REVIEW path (agent.service.ts:1405), insert or update `deliverables` rows from `r.x.slots` with sha256, version and `released_at` set once the gate passes. Otherwise store `held_for_payment` and release them on payment through a payment webhook hook.
2. **REQ-02/03 request groups** (M). Add a `request_groups` table (`RG-` code), `applications.group_id` and `POST applications/submit-basket` (one tx, N children, optional combined invoice). Wizard: submit the basket once. Client requests list: group view.
3. **IAM-24 / CLP-04 customer ID** (S). Add a `users.customer_no` column, a sequence assigned at signup and on claim, a backfill migration, and show it in settings, emails and invoices.
4. **REQ-16 completion record** (S). Add a `completion_record jsonb` on applications written in `transitionTx` when `to=completed_delivered`.
5. **REQ-08 SLA pause** (M). Add `sla_paused_at` and `sla_paused_ms` columns. In `transitionTx`, set them on entering a `pausesSla` status and on resume add the elapsed business time to `sla_deadline`.
6. **REQ-11 client cancellation** (S). Add `POST applications/:code/cancel` (client actor, uses `movesFor`), plus `cancel-request` that creates an SM approval after `in_progress`. Add a button in W request-detail.tsx.
7. **IAM-16 password policy** (S). Raise the client minimum to 10 (auth.dto.ts:37,72) and call `pw.isBreached()` in signup, reset and change.
8. **IAM-17 seed admin** (S). admin-create.ts: refuse if any sysadmin exists, use `onConflictDoNothing`, and set forced MFA.
9. **IAM-11 session policy** (M). Enforce idle time (last-seen on the session row) and absolute lifetime (24h client / 8h staff) in `rotateRefresh`. Add a web warning modal 2 min before expiry using `session.expiresAt`.
10. **IAM-10 staff lockout** (S). Add a staff door counter of 10/24h with no auto-expiry, unlocked through an access request.
11. **IAM-20 / CLP-15 deletion cooling-off** (M). Add a `deletion_requests` record with `scheduled_at=+14d` and cancel-on-login, plus a worker job that anonymises and pseudonymises retained finance PII.
12. **IAM-01 multi-role** (M). Add a `user_roles` table, migrate `users.role`, `active_role` claim, `PUT me/active-role` and a header role switcher.
13. **REQ-10 claim OTP** (S). `applications/claim` sends an OTP to the case's phone/email, then verifies it before linking.
14. **REQ-06 external outcome columns** (S). Add `external_outcome`, `_ref`, `_institution` and `_at` on applications, written by agent `outcome`, and read in `clientDetail` instead of `outcomeOf(status)`.
15. **DLV-06 signed links** (M). Add a `download_tokens` table (single-use, 72h) and `GET /d/:token` → login/OTP → 302.
16. **IAM-08 trusted devices** (S). Skip trust for sysadmin and finance in auth.mfa.ts:205.
17. **IAM-05 SMS OTP** (M). Phone verification route, with a channel cascade of SMS → WA template → email.
18. **IAM-21 / CLP-14 consents** (M). Store consents per channel plus profile_reuse and ai_history in a versioned `consent_events` log, and add the UI toggles.
19. **CLP-03 profile** (S). Extend `ProfileIn` with language, address and national ID (encrypted via CryptoService), and add the fields to settings-profile.tsx.
20. **CLP-05 dashboard** (S). Add deadlines, quotes, messages, deliverables and subscription to `me/dashboard`, and add the cards.
21. **DOC-05 restore** (S). `POST me/documents/:id/versions/:v/restore`.
22. **REQ-18 guard** (S). Reject uploads on `on_hold` and after 30 days without login in `uploadCase`.
23. **IAM-07** (S). Hash backup codes with Argon2.
24. **IAM-19 / CLP-15 export** (M). Turn the export into a worker job that builds a ZIP (messages, invoices, documents), emails a 24h link, and is audited as `data_export.client_data.exported`.

### P2
25. **ORG module** (L). Add `organisations` and `org_members` tables (profile fields, verification, customer no), `POST me/orgs`, emailed invites with 7-day accept, SM verify, an org-scoped document vault, and org scoping of applications/documents by `scopes.orgId`, plus a timeline.
26. **FBK register unification** (M). Merge `support_tickets` and chat disputes into the ops ticket register, with severity critical/high/normal → SLA.
27. **FBK-06 escalation job** (S). Add an ops.jobs cron to escalate overdue tickets to SM at 1× SLA and to exec at 2×.
28. **FBK-08 low-rating alert** (S). In `rateCase`, when stars ≤2, create a complaint ticket and notify the SM.
29. **FBK-01 rating reminders + edit window** (S). Outbox jobs at D+2 and D+7, and allow edits for 7 days.
30. **FBK-10 agent quality** (S). Feed CSAT and complaint rate into the agent performance score.
31. **DLV-05 watermark** (M). Worker job stamping PDFs and images. Preview serves the stamped copy while held.
32. **DLV-08 receipt → complaint** (S). On a not-OK receipt, open an FBK ticket linked to the deliverable.
33. **DOC-06 expiry** (S). Reminders at 60/30 days in deadlines and a warning/block when attaching expired documents.
34. **DOC-09 retention** (M). Nightly flag per class, then an SM approval queue, then crypto-shred.
35. **REQ-12 assisted submission** (M). Staff submit for a client with consent, plus a claim invite (ops intake).
36. **REQ-13 / CLP-13 request again** (S). `POST applications/:code/clone` → draft prefilled with answers and library documents.
37. **CLP-12 reminders hub** (M). Aggregate endpoint plus snooze/done state, and a client page.
38. **IAM-12 IP allowlist** (S). CIDR check in the auth guard using the trusted client IP.
39. **IAM-15** (S). Notify the target user when an impersonation ends.

### P3
40. DOC-12 OCR (L), DLV-10 e-sign (M), FBK-02 NPS trigger (S), REQ-14 AI draft → submit confirm (S).
