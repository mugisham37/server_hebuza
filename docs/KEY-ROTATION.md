# Key rotation runbook (SEC-rotation)

Rotate on schedule (yearly), on staff departure with access to secrets, and at once on suspected compromise. Every
rotation is a change request on `/system/approvals` (two people) and leaves an audit row.

| Secret | Dual-key support | Steps |
|---|---|---|
| `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` (Ed25519) | `JWT_PUBLIC_KEY_PREVIOUS` verifies old tokens; `/.well-known/jwks.json` publishes both kids | 1. Generate a new keypair. 2. Set `JWT_PUBLIC_KEY_PREVIOUS` = current public key, then the new private/public pair; deploy api + worker. 3. Wait ≥ the refresh-token lifetime (24 h client / 8 h staff / 4 h sysadmin). 4. Remove `JWT_PUBLIC_KEY_PREVIOUS`; deploy. Compromise: skip step 3 and revoke all sessions (`update auth_sessions set revoked_at = now()`). |
| `FIELD_KEY` (AES-256-GCM, PII + TOTP secrets) | `FIELD_KEY_PREVIOUS` decrypts old ciphertexts; `CryptoService.reencrypt()` rewrites one value | 1. Set `FIELD_KEY_PREVIOUS` = current, `FIELD_KEY` = new; deploy. New writes use the new key. 2. Run the re-encryption job over every encrypted column (staff TOTP secrets, sealed outbox payloads, worker private fields, system secrets) calling `reencrypt()` and saving non-null results. 3. Verify a sample decrypts with only the new key (staging: unset the previous key). 4. Remove `FIELD_KEY_PREVIOUS`; deploy. |
| `BLIND_INDEX_KEY` | none (deterministic index) | Plan a window: set the new key, recompute every blind index column in one job, pending OTPs re-issue. ICS feed links change (users re-subscribe). |
| `NOTIFY_WEBHOOK_TOKEN` | `NOTIFY_WEBHOOK_TOKEN_PREVIOUS` still accepted | 1. Move the current value to `_PREVIOUS`, set a new token; deploy. 2. Update the URLs at Resend, Africa's Talking and Meta. 3. Remove `_PREVIOUS` once providers show deliveries on the new URL. |
| `RESEND_WEBHOOK_SECRET`, `WHATSAPP_APP_SECRET` | provider-side overlap (Resend supports two signing secrets briefly; Meta app secret reset is immediate) | Rotate at the provider, update env, deploy within minutes. |
| `PAYMENTS_WEBHOOK_SECRET`, `FLUTTERWAVE_WEBHOOK_SECRET` | none | Rotate in a quiet hour; in-flight callback URLs signed with the old secret fail and are recovered by the payment status poll. |
| `METRICS_TOKEN` | none (scraper config) | Update the Prometheus scrape secret and env in the same change. |
| `REVALIDATE_SECRET` | none | Update web + api in one release. |
| Provider API keys (Resend, AT, Meta, MTN, Airtel, Flutterwave, Anthropic, R2) | provider-side (create new, then revoke old) | Create the new key, update env, deploy, confirm traffic, revoke the old key. |
| Backup age key | recipient list | Add the new recipient to `BACKUP_AGE_RECIPIENT` (age supports several `-r`), keep the old private key until the oldest backup encrypted with it expires (12 months monthly tier). |

After any rotation: `pnpm smoke:prod`, sign in as a staff test user (MFA), check `/system/integrations` health, and record
the rotation date on `/system/integrations/<key>`.
