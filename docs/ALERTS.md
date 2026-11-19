# Alerting (OBS-alert)

Sources, in order of how fast they page:

| Signal | Where | Fires when | Severity |
|---|---|---|---|
| Synthetic check | `web/.github/workflows/synthetic.yml` (hourly) | health, home, service page or login page fails | page (failed workflow → on-call) |
| Prometheus rules | `infra/prometheus/alerts.yml` on `GET /metrics` (Bearer `METRICS_TOKEN`) | 5xx > 1 % 5 min, p95 > 500 ms 10 min, queue backlog > 500, > 10 dead letters/h, scrape down, RSS > 900 MB | page / ticket |
| Worker heartbeat | `/api/status`, `/health/ready` (`core/queue/worker-monitor.ts`) | worker missing for > heartbeat TTL | page (via the readiness probe and `ApiDown`) |
| Backups | `/system/ops?tab=backups` (`BACKUP_STATUS_*`) | latest status older than 26 h | ticket (check daily; wire to Prometheus blackbox if needed) |
| Errors | Sentry (`SENTRY_DSN`) | new issue / regression | ticket |
| Traces | OTLP collector (`OTEL_EXPORTER_OTLP_ENDPOINT`) | — (investigation, not alerting) | — |

Page = phone/SMS to the on-call; ticket = next business day. Every page links a runbook section. Silence an alert only with
an incident open on `/system/ops/incidents`.
