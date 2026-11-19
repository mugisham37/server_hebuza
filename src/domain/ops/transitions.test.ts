import { describe, expect, it } from "vitest";
import { canMove, clientCancelMode, commonMoves, movesFor } from "./transitions";
import { normalizeStatus } from "../domain/case-status";

describe("case status", () => {
  it("normalizes legacy values, unknown → received", () => {
    expect(normalizeStatus("assigned")).toBe("approved_assigned");
    expect(normalizeStatus("in_progress")).toBe("in_progress");
    expect(normalizeStatus("nope")).toBe("received");
  });
});

describe("case transitions", () => {
  it("received → under_review / rejected (manager only, rejection needs reason)", () => {
    expect(canMove({ status: "received" }, "under_review")).toBe(true);
    expect(movesFor({ status: "received" }).find((m) => m.to === "rejected")?.reason).toBe(true);
    expect(canMove({ status: "received" }, "rejected", "assignee")).toBe(false);
    expect(canMove({ status: "received" }, "completed_delivered")).toBe(false);
  });
  it("guards block approval until complete, paid and assigned", () => {
    const f = { status: "under_review" as const, complete: true, paid: true, assigneeChosen: false };
    expect(movesFor(f).find((m) => m.to === "approved_assigned")?.blocked).toBe("noAssignee");
    expect(canMove({ ...f, assigneeChosen: true }, "approved_assigned")).toBe(true);
    expect(canMove({ status: "under_review", fee: 100, paid: true }, "awaiting_payment")).toBe(false);
  });
  it("offer accept and undo", () => {
    expect(canMove({ status: "under_review", offer: "accept" }, "in_progress", "assignee")).toBe(true);
    expect(canMove({ status: "in_progress", offer: "accept" }, "approved_assigned", "assignee")).toBe(false);
    expect(canMove({ status: "approved_assigned", offer: "undo", previous: "under_review" }, "under_review", "assignee")).toBe(true);
    expect(canMove({ status: "approved_assigned", offer: "undo", previous: "in_progress" }, "in_progress", "assignee")).toBe(true); // via table
    expect(canMove({ status: "approved_assigned", offer: "undo", previous: "completed_delivered" }, "completed_delivered", "assignee")).toBe(false);
  });
  it("terminal statuses have no moves; client can't cancel after work started", () => {
    for (const s of ["cancelled", "rejected", "refunded"] as const) expect(movesFor({ status: s })).toEqual([]);
    expect(movesFor({ status: "under_review", workStarted: true }, "client").find((m) => m.to === "cancelled")?.blocked).toBe("workStarted");
    expect(canMove({ status: "in_progress" }, "cancelled", "client")).toBe(false);
  });
  it("on_hold resumes to previous non-terminal status", () => {
    expect(canMove({ status: "on_hold", previous: "in_progress" }, "in_progress")).toBe(true);
    expect(canMove({ status: "on_hold", previous: "cancelled" }, "under_review")).toBe(true);
  });
  it("commonMoves counts blockers", () => {
    const r = commonMoves([{ status: "in_progress", deliverablesUploaded: 1 }, { status: "in_progress" }], "assignee");
    expect(r.allowed).toContain("on_hold");
    expect(r.blockedCount.awaiting_internal_review).toBe(1);
  });
});

describe("clientCancelMode", () => {
  it("cancel early, request late, nothing when done", () => {
    expect(clientCancelMode("received")).toBe("cancel");
    expect(clientCancelMode("in_progress")).toBe("request");
    expect(clientCancelMode("completed_delivered")).toBeNull();
  });
});
