// F-IAM-12: CIDR allowlist check (IPv4 + IPv6, IPv4-mapped IPv6 normalised) on node's BlockList.
import { BlockList, isIP } from "node:net";

const cache = new Map<string, BlockList>();
export function ipAllowed(ip: string, cidrs: readonly string[]): boolean {
  const addr = ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  const v = isIP(addr);
  if (!v) return false;
  const key = cidrs.join(",");
  let bl = cache.get(key);
  if (!bl) {
    bl = new BlockList();
    for (const c of cidrs) {
      const [a, bits] = c.split("/");
      const t = isIP(a);
      if (!t) continue;
      bl.addSubnet(a, bits ? Number(bits) : t === 4 ? 32 : 128, t === 4 ? "ipv4" : "ipv6");
    }
    cache.set(key, bl);
  }
  return bl.check(addr, v === 4 ? "ipv4" : "ipv6");
}
