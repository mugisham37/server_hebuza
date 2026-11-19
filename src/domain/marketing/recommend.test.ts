import { describe, expect, it } from "vitest";
import { recommend } from "./recommend";

const rules = [
  { id: "a", ifUsed: "company-registration", recommend: ["vat-registration", "tax-filing"], active: true },
  { id: "b", ifUsed: "*", recommend: ["company-registration"], active: true },
  { id: "c", ifUsed: "vat-registration", recommend: ["tax-filing", "payroll"], active: false },
];
describe("recommend (F-CRM-11)", () => {
  it("unions matching rules, drops used services, caps at 3", () => {
    expect(recommend(["company-registration"], rules)).toEqual(["vat-registration", "tax-filing"]);
    expect(recommend([], rules)).toEqual(["company-registration"]);
    expect(recommend(["vat-registration"], rules.filter((r) => r.id !== "b"), ["x"])).toEqual(["x"]);
  });
});
