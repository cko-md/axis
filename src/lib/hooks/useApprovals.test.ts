import { describe, expect, it } from "vitest";
import { isRoutineResumeUrl } from "./useApprovals";

describe("approval routine resume URL", () => {
  it("accepts only the fixed owner-authenticated routine resume route", () => {
    expect(isRoutineResumeUrl(
      "/api/routines/runs/11111111-1111-4111-8111-111111111111/resume",
    )).toBe(true);
    expect(isRoutineResumeUrl("/api/routines/runs/not-a-uuid/resume")).toBe(false);
    expect(isRoutineResumeUrl("https://example.com/api/routines/runs/11111111-1111-4111-8111-111111111111/resume")).toBe(false);
    expect(isRoutineResumeUrl("/api/routines/runs/11111111-1111-4111-8111-111111111111/resume?next=https://example.com")).toBe(false);
  });
});
