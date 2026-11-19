import { expect, it } from "vitest";
import { ipAllowed } from "./ip-allow";

it("checks v4/v6 CIDRs", () => {
  expect(ipAllowed("41.186.20.10", ["41.186.20.0/24"])).toBe(true);
  expect(ipAllowed("::ffff:41.186.20.10", ["41.186.20.0/24"])).toBe(true);
  expect(ipAllowed("41.186.21.10", ["41.186.20.0/24"])).toBe(false);
  expect(ipAllowed("2001:db8::1", ["2001:db8::/32"])).toBe(true);
  expect(ipAllowed("10.0.0.1", ["10.0.0.1"])).toBe(true);
  expect(ipAllowed("garbage", ["10.0.0.0/8"])).toBe(false);
});
