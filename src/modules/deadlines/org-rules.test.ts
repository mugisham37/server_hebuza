import { expect, it } from "vitest";
import { orgRuleCodes } from "./deadlines.service";

it("company profile → applicable statutory rules", () => {
  expect(orgRuleCodes({ orgType: "ltd", tin: "123456789", vatRegistered: true, vatPeriod: "monthly", employer: true }).sort())
    .toEqual(["RDB_ANNUAL_RETURN", "RRA_CIT_ANNUAL", "RRA_CIT_PREPAY", "RRA_PAYE", "RRA_VAT_MONTHLY", "RSSB_CONTRIB"]);
  expect(orgRuleCodes({ orgType: "sole_proprietor", tin: "123456789", vatRegistered: false, vatPeriod: "monthly", employer: false })).toEqual(["RRA_PIT_ANNUAL"]);
  expect(orgRuleCodes({ orgType: "ngo", tin: null, vatRegistered: true, vatPeriod: "quarterly", employer: false })).toEqual(["RRA_VAT_QUARTERLY"]);
});
