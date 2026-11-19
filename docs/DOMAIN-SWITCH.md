# Switching domains

Moving the platform to a new domain (e.g. from `*.up.railway.app` or a staging host to `hebuza.rw`, or a rename).
Do it in this order; each step is reversible until the old domain is removed.

## 1. DNS and TLS (Cloudflare)
1. Add the zone; set SSL/TLS **Full (strict)**, Always Use HTTPS, TLS ≥ 1.2.
2. Railway → each service → Settings → Networking → Custom domain: web `hebuza.rw` + `www`, api `api.hebuza.rw`.
   Create the CNAMEs Railway shows (proxied). Wait for Railway's certificate to be issued.
3. Re-apply the Transform Rule `x-origin-auth` (`ORIGIN_AUTH_SECRET`), WAF/cache rules and Turnstile hostnames for the new zone.

## 2. Server variables (Railway, api + worker)
- `WEB_ORIGIN` = new web origin(s) (CORS + cookie origin checks).
- `API_PUBLIC_URL` = new api origin — gateway callback URLs and `.ics` feed links are generated from it.
- `MAIL_FROM` on a domain verified in Resend (add SPF/DKIM/DMARC records for the new domain first).
Redeploy api and worker.

## 3. Web variables
`NEXT_PUBLIC_SITE_URL` (canonical URLs, sitemap, OG), `API_URL` unchanged (private network). Redeploy.

## 4. Providers (see KEYS.md → Webhook URLs)
- Flutterwave webhook → `<new api>/api/payments/webhooks/flutterwave`; allowed redirect domains.
- MTN/Airtel: whitelist the new callback host (MoMo callback URLs are sent per request, so in-flight prompts keep the old host — keep it serving until they expire, 1 h).
- Resend + Africa's Talking webhooks → `<new api>/api/webhooks/notify/<token>/...`.
- Turnstile widget hostnames; Google/Meta analytics properties; R2 CORS (`hebuza-files` allowed origin = new web origin).
- WhatsApp Business display/website URL.

## 5. Verify
- `https://api.<new>/health/ready` green; login sets cookies on the new host; a presigned upload works (R2 CORS).
- A MoMo sandbox payment settles via callback; a Resend test event reaches the notify webhook.
- `curl -I https://<new>/` shows HSTS; sitemap and canonical tags use the new host.

## 6. Retire the old domain
Redirect old → new (Cloudflare Redirect Rule, 301, path preserved) for at least 90 days; then remove the old custom
domains and disable `*.up.railway.app`. Rotate `ORIGIN_AUTH_SECRET` if the old host was ever public.
Users must sign in again only if the cookie domain changed (sessions are host-scoped).
