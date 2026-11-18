import { timingSafeEqual } from "node:crypto";
// Real client IP behind Railway. Trust only our own infrastructure, never a header a client could forge:
//  · direct API call:  client → Railway edge (100.64/10) → api            XFF = "client"
//  · via the web:      client → edge → web (private fd…) → [edge egress] → api   XFF = "client, edge"
// A Railway edge hop is trusted; a private-network (web) hop is trusted together with the one edge hop in front of it.
// Behind Cloudflare (Phase L) a request with a valid x-origin-auth carries the client in cf-connecting-ip (originGate).
const RAILWAY_EDGE = /^(::ffff:)?100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./; // 100.64.0.0/10
const PRIVATE_NET = /^(fd|fc)[0-9a-f]{2}:/i; // Railway private network (IPv6 ULA)
const LOCAL = /^(::1|127\.|::ffff:127\.)/;

/** chain[0] = socket address, then X-Forwarded-For entries nearest-first. Returns the first untrusted hop (the client). */
export function clientIpFromChain(chain: string[]): string {
  let viaWeb = false;
  for (let i = 0; i < chain.length; i++) {
    const a = chain[i];
    const trusted = i === 0 ? RAILWAY_EDGE.test(a) || PRIVATE_NET.test(a) || LOCAL.test(a) : i === 1 && viaWeb;
    if (i === 0) viaWeb = PRIVATE_NET.test(a);
    if (!trusted) return a;
  }
  return chain[chain.length - 1] ?? "";
}

/** For Fastify `trustProxy`: same rule, asked hop by hop (sync, in order, per request). */
export function makeTrustProxy() {
  let viaWeb = false;
  return (addr: string, i: number) => {
    if (i === 0) {
      viaWeb = PRIVATE_NET.test(addr);
      return RAILWAY_EDGE.test(addr) || viaWeb || LOCAL.test(addr);
    }
    return i === 1 && viaWeb;
  };
}

export const xffChain = (remote: string | undefined, xff: string | string[] | undefined) => [
  remote ?? "",
  ...String(xff ?? "").split(",").map((s) => s.trim()).filter(Boolean).reverse(),
];

/** Constant-time check of the Cloudflare Transform Rule header against ORIGIN_AUTH_SECRET. */
export function originAuthOk(header: string | string[] | undefined, secret: string): boolean {
  const a = Buffer.from(typeof header === "string" ? header : ""), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Req = { url: string; headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string } };
/** Origin gate (dormant without a secret): "forbidden" for requests that bypassed Cloudflare, else the client IP to use
 *  (cf-connecting-ip when the request came through Cloudflare) or undefined to keep Fastify's. */
export function originGate(req: Req, secret: string | undefined): "forbidden" | string | undefined {
  if (!secret) return undefined;
  if (originAuthOk(req.headers["x-origin-auth"], secret)) {
    const cf = req.headers["cf-connecting-ip"];
    return typeof cf === "string" && cf ? cf : undefined;
  }
  const path = req.url.split("?")[0];
  if (path === "/health" || path === "/health/ready" || PRIVATE_NET.test(req.socket.remoteAddress ?? "")) return undefined;
  return "forbidden";
}
