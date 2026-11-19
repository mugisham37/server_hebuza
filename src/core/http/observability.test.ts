import { expect, it } from "vitest";
import { metricsText, observe, parseTraceparent } from "./observability";

it("prometheus text + traceparent", () => {
  observe("GET", "/api/x", 200, 0.03);
  const t = metricsText({ queue_waiting: 3 });
  expect(t).toContain('http_requests_total{method="GET",route="/api/x",status="200"} 1');
  expect(t).toContain('le="0.05"} 1');
  expect(t).toContain("queue_waiting 3");
  expect(parseTraceparent("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")?.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
  expect(parseTraceparent("bad")).toBeNull();
});
