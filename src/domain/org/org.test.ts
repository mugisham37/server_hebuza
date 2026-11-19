import { describe, expect, it } from "vitest";
import { canManageMember, isTin, orgCan } from "./org";

describe("org rules", () => {
  it("roles", () => {
    expect(orgCan("viewer", "view")).toBe(true);
    expect(orgCan("viewer", "submit")).toBe(false);
    expect(orgCan("admin", "pay")).toBe(true);
    expect(orgCan(null, "view")).toBe(false);
  });
  it("owner is protected", () => {
    expect(canManageMember("admin", "owner")).toBe(false);
    expect(canManageMember("admin", "viewer")).toBe(true);
    expect(canManageMember("viewer", "viewer")).toBe(false);
  });
  it("tin", () => { expect(isTin("123456789")).toBe(true); expect(isTin("12345678")).toBe(false); });
});
