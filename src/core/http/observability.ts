// OBS-metrics + OBS-tracing without extra dependencies.
// - Prometheus text format on GET /metrics, only with `Authorization: Bearer $METRICS_TOKEN` (unset → 404).
// - OpenTelemetry-compatible request spans (W3C traceparent in/out) exported as OTLP/HTTP JSON to
//   $OTEL_EXPORTER_OTLP_ENDPOINT/v1/traces every 5 s (unset → only the traceparent header is propagated).
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

const BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
type Series = { count: number; sum: number; buckets: number[] };
const http = new Map<string, Series>(); // key: method|route|status
let inflight = 0;
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export function observe(method: string, route: string, status: number, seconds: number) {
  const k = `${method}|${route}|${status}`;
  const s = http.get(k) ?? { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
  s.count++;
  s.sum += seconds;
  BUCKETS.forEach((b, i) => { if (seconds <= b) s.buckets[i]++; });
  http.set(k, s);
}

export function metricsText(extra: Record<string, number> = {}) {
  const out = [
    "# HELP http_requests_total HTTP requests by route and status.", "# TYPE http_requests_total counter",
    ...[...http].map(([k, s]) => { const [m, r, st] = k.split("|"); return `http_requests_total{method="${m}",route="${esc(r)}",status="${st}"} ${s.count}`; }),
    "# HELP http_request_duration_seconds Request latency.", "# TYPE http_request_duration_seconds histogram",
    ...[...http].flatMap(([k, s]) => {
      const [m, r, st] = k.split("|"), l = `method="${m}",route="${esc(r)}",status="${st}"`;
      return [...BUCKETS.map((b, i) => `http_request_duration_seconds_bucket{${l},le="${b}"} ${s.buckets[i]}`),
        `http_request_duration_seconds_bucket{${l},le="+Inf"} ${s.count}`, `http_request_duration_seconds_sum{${l}} ${s.sum.toFixed(6)}`, `http_request_duration_seconds_count{${l}} ${s.count}`];
    }),
    "# TYPE http_requests_in_flight gauge", `http_requests_in_flight ${inflight}`,
    "# TYPE process_resident_memory_bytes gauge", `process_resident_memory_bytes ${process.memoryUsage().rss}`,
    "# TYPE process_uptime_seconds gauge", `process_uptime_seconds ${Math.round(process.uptime())}`,
    ...[...new Set(Object.keys(extra).map((k) => k.split("{")[0]))].flatMap((n) => [`# TYPE ${n} gauge`, ...Object.entries(extra).filter(([k]) => k.split("{")[0] === n).map(([k, v]) => `${k} ${v}`)]),
  ];
  return `${out.join("\n")}\n`;
}

/** W3C traceparent: 00-<32 hex trace>-<16 hex parent>-<flags>. */
export function parseTraceparent(h?: string) {
  const m = h?.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/);
  return m && !/^0+$/.test(m[1]) ? { traceId: m[1], parentId: m[2] } : null;
}

type Span = { traceId: string; spanId: string; parentSpanId?: string; name: string; start: bigint; end: bigint; attrs: Record<string, string | number> };
const queue: Span[] = [];

export function installObservability(app: FastifyInstance, env: { metricsToken?: string; otelEndpoint?: string; service: string; queueDepth?: () => Promise<Record<string, number>> }) {
  const t0 = new WeakMap<FastifyRequest, { at: bigint; traceId: string; spanId: string; parent?: string }>();
  app.addHook("onRequest", async (req, reply) => {
    inflight++;
    const p = parseTraceparent(req.headers.traceparent as string | undefined);
    const ctx = { at: process.hrtime.bigint(), traceId: p?.traceId ?? randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex"), parent: p?.parentId };
    t0.set(req, ctx);
    void reply.header("traceparent", `00-${ctx.traceId}-${ctx.spanId}-01`);
  });
  app.addHook("onResponse", async (req, reply) => {
    inflight--;
    const c = t0.get(req);
    if (!c) return;
    const end = process.hrtime.bigint();
    const route = req.routeOptions?.url ?? "unmatched";
    observe(req.method, route, reply.statusCode, Number(end - c.at) / 1e9);
    if (env.otelEndpoint && queue.length < 5_000)
      queue.push({ traceId: c.traceId, spanId: c.spanId, parentSpanId: c.parent, name: `${req.method} ${route}`, start: c.at, end, attrs: { "http.method": req.method, "http.route": route, "http.status_code": reply.statusCode } });
  });
  app.get("/metrics", async (req, reply) => {
    const want = env.metricsToken, got = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!want || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) return reply.code(404).send();
    return reply.type("text/plain; version=0.0.4").send(metricsText(await env.queueDepth?.().catch(() => ({})) ?? {}));
  });
  if (env.otelEndpoint) {
    // hrtime is monotonic; anchor it to wall-clock once to produce Unix nanos.
    const anchor = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint();
    const url = `${env.otelEndpoint.replace(/\/$/, "")}/v1/traces`;
    setInterval(() => {
      const batch = queue.splice(0, 500);
      if (!batch.length) return;
      const body = { resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: env.service } }] }, scopeSpans: [{ scope: { name: "hebuza-http" }, spans: batch.map((s) => ({
        traceId: s.traceId, spanId: s.spanId, ...(s.parentSpanId && { parentSpanId: s.parentSpanId }), name: s.name, kind: 2,
        startTimeUnixNano: String(anchor + s.start), endTimeUnixNano: String(anchor + s.end),
        attributes: Object.entries(s.attrs).map(([key, v]) => ({ key, value: typeof v === "number" ? { intValue: v } : { stringValue: v } })),
      })) }] }] };
      void fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5_000) }).catch(() => {});
    }, 5_000).unref();
  }
}
