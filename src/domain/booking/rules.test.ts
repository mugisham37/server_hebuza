import { describe, expect, it } from "vitest";
import { addDays, at, can, cancelOutcome, dayOf, hm, shouldAutoNoShow } from "./rules";

const H = 3600_000;
const startsAt = "2026-03-10T10:00:00Z", s = Date.parse(startsAt);
const b = { status: "confirmed" as const, startsAt, rescheduleCount: 0, paid: true, price: 20_000 };

describe("booking time helpers", () => {
  it("Kigali (UTC+2) day/time conversions", () => {
    expect(at("2026-03-10", "09:00")).toBe("2026-03-10T07:00:00.000Z");
    expect(dayOf("2026-03-09T23:30:00Z")).toBe("2026-03-10");
    expect(hm(545)).toBe("09:05");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });
});

describe("booking policy", () => {
  it("paid client cancel: full refund before 12h cutoff, forfeit after", () => {
    expect(cancelOutcome(b, "client", s - 13 * H)).toEqual({ refund: 20_000, creditOption: true, forfeited: false, allowed: true });
    expect(cancelOutcome(b, "client", s - 11 * H)).toEqual({ refund: 0, creditOption: false, forfeited: true, allowed: true });
    expect(cancelOutcome(b, "staff", s - H).refund).toBe(20_000);
    expect(cancelOutcome({ ...b, paid: false }, "client", s - H).allowed).toBe(false);
  });
  it("can: reschedule limit, cutoff, staff reason, outcome timing", () => {
    expect(can("reschedule", b, "client", s - 13 * H)).toEqual({ ok: true });
    expect(can("reschedule", { ...b, rescheduleCount: 2 }, "client", s - 13 * H)).toEqual({ ok: false, reason: "reschedule_limit" });
    expect(can("reschedule", b, "client", s - 11 * H)).toEqual({ ok: false, reason: "past_cutoff" });
    expect(can("cancel", b, "client", s - H)).toEqual({ ok: true });
    expect(can("cancel", b, "staff", s, " ")).toEqual({ ok: false, reason: "reason_required" });
    expect(can("cancel", { ...b, status: "completed" }, "staff", s, "x")).toEqual({ ok: false, reason: "terminal" });
    expect(can("outcome", b, "staff", s - 1)).toEqual({ ok: false, reason: "too_early_outcome" });
    expect(can("outcome", b, "staff", s)).toEqual({ ok: true });
  });
  it("auto no-show 15 min after end", () => {
    const e = { status: "confirmed" as const, endsAt: startsAt };
    expect(shouldAutoNoShow(e, s + 15 * 60_000)).toBe(false);
    expect(shouldAutoNoShow(e, s + 15 * 60_000 + 1)).toBe(true);
  });
});
