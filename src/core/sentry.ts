// Imported first by main.ts/worker.ts. SENTRY_DSN unset → nothing initialised; captureException calls are no-ops.
import * as Sentry from "@sentry/nestjs";

if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV, release: process.env.GIT_SHA, tracesSampleRate: 0.1 });
}
