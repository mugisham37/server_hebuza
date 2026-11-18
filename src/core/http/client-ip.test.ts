import { describe, expect, it } from "vitest";
import { clientIpFromChain, originGate, xffChain } from "./client-ip";

describe("clientIpFromChain", () => {
  it("direct via Railway edge", () => expect(clientIpFromChain(xffChain("::ffff:100.64.0.1", "102.22.142.51"))).toBe("102.22.142.51"));
  it("via web proxy", () => expect(clientIpFromChain(xffChain("fd12:bfcf:40e3:1:b000:1cc:638c:f700", "102.22.142.51, 152.233.56.193"))).toBe("102.22.142.51"));
  it("forged XFF on direct call is ignored", () => expect(clientIpFromChain(xffChain("::ffff:100.64.0.1", "6.6.6.6, 102.22.142.51"))).toBe("102.22.142.51"));
  it("forged XFF via web is ignored", () => expect(clientIpFromChain(xffChain("fd12::1", "6.6.6.6, 102.22.142.51, 152.233.56.193"))).toBe("102.22.142.51"));
  it("untrusted socket is the client", () => expect(clientIpFromChain(xffChain("8.8.8.8", "6.6.6.6"))).toBe("8.8.8.8"));
});

describe("originGate", () => {
  const S = "s".repeat(32);
  const req = (h: Record<string, string>, url = "/api/x", addr = "::ffff:100.64.0.1") => ({ url, headers: h, socket: { remoteAddress: addr } });
  it("dormant without secret", () => expect(originGate(req({}), undefined)).toBeUndefined());
  it("blocks requests that bypass Cloudflare", () => expect(originGate(req({ "x-origin-auth": "wrong" }), S)).toBe("forbidden"));
  it("health checks exempt", () => expect(originGate(req({}, "/health/ready?x=1"), S)).toBeUndefined());
  it("private network exempt", () => expect(originGate(req({}, "/api/x", "fd12::1"), S)).toBeUndefined());
  it("valid header → cf-connecting-ip", () => expect(originGate(req({ "x-origin-auth": S, "cf-connecting-ip": "102.22.142.51" }), S)).toBe("102.22.142.51"));
  it("valid header without cf ip keeps Fastify's", () => expect(originGate(req({ "x-origin-auth": S }), S)).toBeUndefined());
});
