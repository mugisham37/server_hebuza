import { expect, it } from "vitest";
import { classifyText } from "./classify";

it("suggests a kind from OCR text", () => {
  expect(classifyText("REPUBULIKA Y'U RWANDA INDANGAMUNTU 1199080012345678").kind).toBe("identity");
  expect(classifyText("Rwanda Revenue Authority — Tax clearance certificate, TIN 123456789").kind).toBe("tax");
  expect(classifyText("Certificate of domestic company registration, RDB").kind).toBe("company");
  expect(classifyText("hello")).toEqual({ kind: "other", confidence: 0 });
});
