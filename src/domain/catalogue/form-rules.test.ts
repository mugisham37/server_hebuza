import { describe, expect, it } from "vitest";
import { isVisible, validateAnswers, visibleAnswers, type FormRuleField } from "./form-rules";

const fields: FormRuleField[] = [
  { id: "kind", type: "select", required: true, options: ["ltd", "coop"] },
  { id: "tin", type: "text", required: true, visibleIf: { field: "kind", equals: "ltd" } },
  { id: "holders", type: "group", required: true, totalField: "pct", visibleIf: { field: "kind", equals: "ltd" },
    children: [{ id: "name", type: "text", required: true }, { id: "pct", type: "number", required: true }] },
];

describe("form rules", () => {
  it("visibility", () => {
    expect(isVisible(fields[1], { kind: "ltd" })).toBe(true);
    expect(isVisible(fields[1], { kind: "coop" })).toBe(false);
    expect(visibleAnswers(fields, { kind: "coop", tin: "1" })).toEqual({ kind: "coop" });
  });
  it("validation", () => {
    expect(validateAnswers(fields, { kind: "coop" })).toEqual({});
    expect(validateAnswers(fields, { kind: "x" })).toEqual({ kind: "option" });
    expect(validateAnswers(fields, { kind: "ltd", tin: "", holders: [{ name: "A", pct: 60 }, { name: "", pct: 30 }] }))
      .toEqual({ tin: "required", "holders.1.name": "required", holders: "total" });
  });
});
