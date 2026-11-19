import { expect, it } from "vitest";
import { parseSettingsImport } from "./settings-registry";

it("imports editable keys only", () => {
  const r = parseSettingsImport(JSON.stringify({ "maintenance.on": { key: "maintenance.on", value: true }, "general.time_zone": "x", "nope.key": 1, "sla.business_start_hour": 7 }));
  expect(r.values).toEqual({ "maintenance.on": true, "sla.business_start_hour": 7 });
  expect(r.skipped.sort()).toEqual(["general.time_zone", "nope.key"]);
  expect(() => parseSettingsImport("[1]")).toThrow();
});
