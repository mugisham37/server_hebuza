// k6 mixed-traffic load test (Phase 6): ramps to 2,000 concurrent virtual users for 10 min.
// Run against staging only: k6 run -e BASE_URL=https://staging.hebuza.rw -e API_URL=https://api-staging.hebuza.rw test/k6/mixed.js
// Mix (per iteration, weighted): 55% public browsing (web pages), 20% public API reads, 10% tracking lookups,
// 10% signed-in client reads, 5% writes (consent/assistant-free). Thresholds fail the run: p95 < 500 ms, errors < 1%.
// The API's per-IP rate limiter must be relaxed for the run (RATE_LIMIT_FACTOR on staging) or traffic sent from many IPs.
import http from "k6/http";
import { check, group, sleep } from "k6";
import { Rate } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const API = __ENV.API_URL || "http://localhost:4000";
const CLIENT_EMAIL = __ENV.CLIENT_EMAIL || "client@example.test";
const CLIENT_PASSWORD = __ENV.CLIENT_PASSWORD || "Demo-pass-1";
const errors = new Rate("errors");

export const options = {
  scenarios: {
    mixed: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "2m", target: 500 },
        { duration: "3m", target: 2000 },
        { duration: "10m", target: 2000 },
        { duration: "2m", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<500"],
    http_req_failed: ["rate<0.01"],
    errors: ["rate<0.01"],
    "http_req_duration{kind:api}": ["p(95)<400"],
    "http_req_duration{kind:page}": ["p(95)<800"],
  },
  noConnectionReuse: false,
  discardResponseBodies: true,
};

const PAGES = ["/rw", "/en", "/en/services", "/en/pricing", "/en/how-it-works", "/en/faq", "/en/knowledge", "/en/about", "/fr/services"];
const API_READS = ["/api/services?limit=20", "/api/service-categories", "/health"];
const ok = (r, name) => errors.add(!check(r, { [name]: (x) => x.status >= 200 && x.status < 400 }));
const pick = (a) => a[Math.floor(Math.random() * a.length)];

export function setup() {
  const r = http.post(`${API}/api/auth/login`, JSON.stringify({ identifier: CLIENT_EMAIL, password: CLIENT_PASSWORD }), {
    headers: { "content-type": "application/json", origin: BASE }, responseType: "text",
  });
  const cookie = Object.entries(r.cookies || {}).map(([k, v]) => `${k}=${v[0].value}`).join("; ");
  return { cookie };
}

export default function (data) {
  const roll = Math.random();
  if (roll < 0.55) group("public pages", () => ok(http.get(`${BASE}${pick(PAGES)}`, { tags: { kind: "page" } }), "page 2xx"));
  else if (roll < 0.75) group("public api", () => ok(http.get(`${API}${pick(API_READS)}`, { tags: { kind: "api" } }), "api 2xx"));
  else if (roll < 0.85) group("tracking", () => {
    const r = http.get(`${API}/api/track/HBZ-2RT8LM`, { tags: { kind: "api" } });
    errors.add(!check(r, { "track 2xx/404": (x) => x.status < 400 || x.status === 404 }));
  });
  else if (roll < 0.95) group("client reads", () => {
    const h = { headers: { cookie: data.cookie }, tags: { kind: "api" } };
    ok(http.get(`${API}/api/me/dashboard`, h), "dashboard");
    ok(http.get(`${API}/api/notifications?limit=20`, h), "notifications");
  });
  else group("writes", () => {
    const body = JSON.stringify({ anon_id: `k6-${__VU}-${__ITER}`, source: "cookie_banner", purposes: { cookies_analytics: false, cookies_marketing: false } });
    ok(http.post(`${API}/api/consent`, body, { headers: { "content-type": "application/json", origin: BASE }, tags: { kind: "api" } }), "consent");
  });
  sleep(1 + Math.random() * 2); // think time
}
