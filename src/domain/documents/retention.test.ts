import { describe, expect, it } from "vitest";
import { classOf, expired } from "./retention";

describe("retention", () => {
  it("classes", () => {
    expect(classOf("case", "national_id")).toBe("id_document");
    expect(classOf("case", "other")).toBe("case_document");
    expect(classOf("deliverable")).toBe("deliverable");
  });
  it("expiry", () => {
    expect(expired("case_document", "2020-01-01T00:00:00Z", new Date("2025-01-02T00:00:00Z"))).toBe(true);
    expect(expired("deliverable", "2020-01-01T00:00:00Z", new Date("2025-01-02T00:00:00Z"))).toBe(false);
  });
});
