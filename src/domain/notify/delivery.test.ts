import { describe, expect, it } from "vitest";
import type { EventRuleVM } from "../system/types";
import {
  categoryOf,
  isStopKeyword,
  planDelivery,
  quietUntil,
  renderTemplate,
  validPushEndpoint,
} from "./delivery";

const rule = (o: Partial<EventRuleVM> = {}): EventRuleVM => ({
  event: "case.documents_requested",
  critical: false,
  security: false,
  priority: "normal",
  channels: { email: true, sms: true, whatsapp: true, inapp: true },
  chain: ["whatsapp", "sms"],
  quietHours: "defer",
  ...o,
});
// 23:30 Kigali = 21:30Z
const night = new Date("2026-11-19T21:30:00Z");
const day = new Date("2026-11-19T10:00:00Z");
const quiet = { on: true, from: "22:00", to: "07:00" };

describe("quietUntil", () => {
  it("wraps midnight and ends at 07:00 Kigali", () => {
    expect(quietUntil(night, quiet)?.toISOString()).toBe(
      "2026-11-20T05:00:00.000Z",
    );
    expect(quietUntil(day, quiet)).toBeNull();
    expect(quietUntil(night, { ...quiet, on: false })).toBeNull();
  });
});

describe("planDelivery", () => {
  it("rule channels + chain; email stays parallel", () => {
    const p = planDelivery({
      kind: "case.documents_requested",
      requested: ["email"],
      rule: rule(),
      prefs: { email_enabled: true },
      now: day,
    });
    expect(p).toEqual({
      parallel: ["email"],
      chain: ["whatsapp", "sms"],
      muted: [],
      deferUntil: null,
    });
  });
  it("preference matrix mutes a category channel, not security", () => {
    const prefs = {
      email_enabled: false,
      matrix: { documents: { sms: false } },
    };
    const p = planDelivery({
      kind: "document.requested",
      requested: ["sms", "email"],
      prefs,
      now: day,
    });
    expect(p.parallel).toEqual([]);
    expect(p.muted).toEqual(["sms", "email"]);
    const s = planDelivery({
      kind: "auth.unusual_login",
      requested: ["email"],
      prefs,
      now: night,
    });
    expect(s.parallel).toEqual(["email"]);
    expect(s.deferUntil).toBeNull();
  });
  it("defers in quiet hours unless critical", () => {
    expect(
      planDelivery({
        kind: "x",
        requested: ["sms"],
        prefs: { email_enabled: true, quiet },
        now: night,
      }).deferUntil,
    ).not.toBeNull();
    expect(
      planDelivery({
        kind: "x",
        requested: ["sms"],
        rule: rule({ critical: true, quietHours: "send" }),
        prefs: { email_enabled: true, quiet },
        now: night,
      }).deferUntil,
    ).toBeNull();
  });
});

it("categoryOf / stop / render", () => {
  expect(categoryOf("fin.payment.confirmed")).toBe("payments");
  expect(categoryOf("status_update")).toBe("requests");
  expect(isStopKeyword(" Hagarika ")).toBe(true);
  expect(isStopKeyword("STOP.")).toBe(true);
  expect(isStopKeyword("stop it now")).toBe(false);
  expect(renderTemplate("Hi {{name}}, {{x}}!", { name: "Ana" })).toBe(
    "Hi Ana, !",
  );
});

it("push endpoint allowlist", () => {
  expect(validPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
  expect(validPushEndpoint("https://web.push.apple.com/QJ")).toBe(true);
  expect(validPushEndpoint("https://169.254.169.254/latest")).toBe(false);
  expect(validPushEndpoint("http://fcm.googleapis.com/x")).toBe(false);
  expect(validPushEndpoint("https://fcm.googleapis.com:8443/x")).toBe(false);
});
