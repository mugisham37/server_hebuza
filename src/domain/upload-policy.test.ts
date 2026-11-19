import { expect, it } from "vitest";
import { uploadProblem } from "./upload-policy";

it("blocks active content, macros and oversize files", () => {
  expect(uploadProblem({ contentType: "application/pdf", size: 1000, purpose: "case" })).toBeNull();
  expect(uploadProblem({ contentType: "image/svg+xml", size: 1000, purpose: "case" })).toBe("blocked_type");
  expect(uploadProblem({ contentType: "application/octet-stream", size: 1000, purpose: "case", filename: "x.docm" })).toBe("blocked_type");
  expect(uploadProblem({ contentType: "application/pdf", size: 11 * 1024 * 1024, purpose: "case" })).toBe("too_large");
  expect(uploadProblem({ contentType: "audio/webm", size: 11 * 1024 * 1024, purpose: "chat" })).toBeNull();
  expect(uploadProblem({ contentType: "nonsense", size: 1, purpose: "case" })).toBe("bad_type");
});
