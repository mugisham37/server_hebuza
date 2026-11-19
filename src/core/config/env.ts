import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().default(4000),
  WEB_ORIGIN: z.string().min(1), // comma-separated allow-list
  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  REDIS_URL: z.string().url(),
  JWT_PRIVATE_KEY: z.string().min(1),
  JWT_PUBLIC_KEY: z.string().min(1),
  FIELD_KEY: z.string().min(1),
  BLIND_INDEX_KEY: z.string().min(1),
  S3_ENDPOINT: z.string().url(),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_REGION: z.string().default("us-east-1"),
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().min(1),
  SMS_PROVIDER: z.string().optional(),
  // Africa's Talking (SMS_PROVIDER=africastalking). AT_USERNAME "sandbox" uses the sandbox host.
  AT_USERNAME: z.string().optional(),
  AT_API_KEY: z.string().optional(),
  AT_SENDER_ID: z.string().optional(),
  // Cloudflare AI Gateway in front of Anthropic: https://gateway.ai.cloudflare.com/v1/<account>/<gateway> + its run token.
  AI_GATEWAY_URL: z.string().url().optional(),
  AI_GATEWAY_TOKEN: z.string().optional(),
  // Daily audit-log copy to the locked R2 bucket (write-only token scoped to that bucket).
  AUDIT_S3_BUCKET: z.string().optional(),
  AUDIT_S3_ACCESS_KEY: z.string().optional(),
  AUDIT_S3_SECRET_KEY: z.string().optional(),
  // Provider delivery webhooks + inbound SMS (STOP) are accepted only on /api/webhooks/notify/<token>/...; unset → 404.
  WHATSAPP_APP_SECRET: z.string().optional(), // Meta app secret: X-Hub-Signature-256 on the WhatsApp webhook
  WHATSAPP_VERIFY_TOKEN: z.string().optional(), // hub.verify_token for the webhook subscription handshake
  RESEND_WEBHOOK_SECRET: z.string().optional(), // whsec_… from the Resend webhook; set → svix signature required
  NOTIFY_WEBHOOK_TOKEN: z.string().min(24).optional(),
  // Read-only view of the external backup job's status (server/backup/backup.sh → status/LATEST-<env>.json). Unset → dormant.
  BACKUP_STATUS_ENDPOINT: z.string().url().optional(),
  BACKUP_STATUS_BUCKET: z.string().optional(),
  BACKUP_STATUS_ACCESS_KEY: z.string().optional(),
  BACKUP_STATUS_SECRET_KEY: z.string().optional(),
  BACKUP_STATUS_ENV: z.string().optional(), // RAILWAY_ENVIRONMENT_NAME of the backed-up env; default "production"
  ANTHROPIC_API_KEY: z.string().optional(),
  VOYAGE_API_KEY: z.string().optional(), // assistant embeddings (voyage-3.5); unset → full-text retrieval only
  AI_MODEL: z.string().default("claude-sonnet-5-5"), // public assistant answers
  AI_FAST_MODEL: z.string().default("claude-haiku-5-5"), // copilot rewrites + eval runs
  AI_DAILY_TOKEN_BUDGET: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(2_000_000), // all sessions, per Kigali day (Redis)
  AI_SESSION_TOKEN_BUDGET: z.coerce.number().int().positive().default(60_000), // in+out per assistant session
  TURNSTILE_SECRET_KEY: z.string().optional(),
  CLAMAV_HOST: z.string().optional(),
  REVALIDATE_SECRET: z.string().min(32).optional(), // HMAC key for the web /hooks/revalidate webhook (cms)
  // payments (all optional: a method without keys answers through the dev stub, production 503)
  MTN_MOMO_SUBSCRIPTION_KEY: z.string().optional(),
  MTN_MOMO_API_USER: z.string().optional(),
  MTN_MOMO_API_KEY: z.string().optional(),
  MTN_MOMO_TARGET_ENVIRONMENT: z.string().optional(), // "sandbox" (default) or the MTN production target
  AIRTEL_CLIENT_ID: z.string().optional(),
  AIRTEL_CLIENT_SECRET: z.string().optional(),
  AIRTEL_BASE_URL: z.string().url().optional(),
  FLUTTERWAVE_SECRET_KEY: z.string().optional(),
  FLUTTERWAVE_WEBHOOK_SECRET: z.string().optional(),
  PAYMENTS_STUB: z.enum(["true", "false"]).default("false").transform((v) => v === "true"), // dev stub driver + unsigned MoMo callbacks
  PAYMENTS_WEBHOOK_SECRET: z.string().optional(), // HMAC for the MoMo callback URL (required in production)
  API_PUBLIC_URL: z.string().url().optional(), // public API origin for gateway callbacks and feed links; default WEB_ORIGIN
  // marketing WhatsApp (unset → sends are logged)
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  RATE_LIMIT_FACTOR: z.coerce.number().min(1).max(1000).default(1), // staging test runs only; forced to 1 in production (core/auth/rate.ts)
  WORKER_MODE: z.enum(["separate", "inline", "off"]).default("separate"), // inline: API process also runs jobs; off: no worker monitor (tests)
  ORIGIN_AUTH_SECRET: z.string().min(32).optional(), // Phase L: Cloudflare Transform Rule header x-origin-auth; unset → no gate
  SENTRY_DSN: z.string().url().optional(), // unset → Sentry off (core/sentry.ts)
  GIT_SHA: z.string().optional(), // appended to package.json version for the API/worker version check
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
}).superRefine((e, ctx) => {
  // Fail closed at boot: dev conveniences that accept unsigned money callbacks must never reach production.
  if (e.NODE_ENV !== "production") return;
  if (e.PAYMENTS_STUB) ctx.addIssue({ code: "custom", path: ["PAYMENTS_STUB"], message: "must be false in production" });
  if (!e.PAYMENTS_WEBHOOK_SECRET) ctx.addIssue({ code: "custom", path: ["PAYMENTS_WEBHOOK_SECRET"], message: "required in production" });
});
export type Env = z.infer<typeof envSchema>;
