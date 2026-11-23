# k6 load tests

- `mixed.js`: 2,000 concurrent VUs, mixed public/API/client/write traffic. Thresholds: p95 < 500 ms, error rate < 1%
  (pages p95 < 800 ms, API p95 < 400 ms). Exit code ≠ 0 when a threshold fails.
- Run only against staging, with seeded demo data and `RATE_LIMIT_FACTOR` raised:
  `k6 run -e BASE_URL=https://staging.hebuza.rw -e API_URL=https://api-staging.hebuza.rw test/k6/mixed.js`
- Smaller smoke: `k6 run --vus 20 --duration 1m test/k6/mixed.js` (the scenario stages are overridden by --vus/--duration).
- Paths used: check them against the deployed route table before a run (`/api/services`, `/api/service-categories`,
  `/api/track/:code`, `/api/me/dashboard`, `/api/notifications`, `/api/consent`, `/api/auth/login`).
