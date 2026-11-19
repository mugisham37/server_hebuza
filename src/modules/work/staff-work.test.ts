import { describe, expect, it, vi } from "vitest";

const ext = {
  status: "pending_verification",
  onboarding: { submittedAt: "2026-11-01", changes: [] },
  payoutDest: { method: "momo", label: "MoMo", last4: "1234", status: "pending_verification", coolingUntil: null },
  invoices: [{ id: "i1", status: "received", key: "secret/key" }, { id: "i2", status: "accepted", key: "k" }],
};
vi.mock("./work.store", async (orig) => ({
  ...(await orig<object>()),
  loadExt: vi.fn(async () => ext),
  rateOwner: vi.fn((uid: string) => `owner:${uid}`),
  loadRates: vi.fn(async () => [{ serviceId: "s1", status: "proposed" }, { serviceId: "s2", status: "active" }]),
}));
vi.mock("../ops/lib/store", async (orig) => ({
  ...(await orig<object>()),
  recList: vi.fn(async (_db: unknown, kind: string) =>
    kind === "work_access"
      ? [{ data: { id: "a1", status: "pending" } }, { data: { id: "a2", status: "granted" } }]
      : [{ ownerId: "u1", data: ext }, { ownerId: "u2", data: { payoutDest: { status: "verified" } } }, { ownerId: "u3", data: {} }]),
}));

const { staffWork, pendingDestinations } = await import("./work.service");
const db = {} as never;

describe("staffWork (staff decision panel)", () => {
  it("returns only pending items, strips invoice storage keys", async () => {
    const r = await staffWork(db, "u1");
    expect(r.rateOwner).toBe("owner:u1");
    expect(r.invoices).toEqual([{ id: "i1", status: "received" }]);
    expect(r.rates).toEqual([{ serviceId: "s1", status: "proposed" }]);
    expect(r.access).toEqual([{ id: "a1", status: "pending" }]);
    expect(r.payoutDest?.status).toBe("pending_verification");
  });
});

describe("pendingDestinations (finance queue)", () => {
  it("maps SQL rows to worker id + name + destination, falling back to the id", async () => {
    const rows = [{ workerId: "u1", name: "Grace", dest: ext.payoutDest }, { workerId: "u9", name: null, dest: ext.payoutDest }];
    const chain: Record<string, unknown> = {};
    for (const k of ["select", "from", "leftJoin", "where"]) chain[k] = () => chain;
    chain.orderBy = async () => rows;
    expect(await pendingDestinations(chain as never)).toEqual([
      { workerId: "u1", name: "Grace", ...ext.payoutDest },
      { workerId: "u9", name: "u9", ...ext.payoutDest },
    ]);
  });
});
