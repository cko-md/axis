import { describe, expect, it } from "vitest";
import {
  parseRoutineIntegrationRequirements,
  routineIntegrationRequirementView,
  summarizeRoutineIntegrations,
  type RoutineIntegrationRequirement,
} from "./integrationRequirements";

const requirements: RoutineIntegrationRequirement[] = [
  {
    key: "polygon.market_prices",
    label: "Market prices",
    provider: "polygon",
    domain: "market_data",
    required: true,
    enabledByDefault: false,
    purpose: "Read live quote provenance.",
    capabilities: ["read:quotes"],
    actionClass: "READ",
  },
  {
    key: "public.order_approval_boundary",
    label: "Public brokerage order boundary",
    provider: "public",
    domain: "brokerage",
    required: true,
    enabledByDefault: false,
    purpose: "Create approval-gated order tickets.",
    capabilities: ["draft:order_ticket", "approval:financial_execution"],
    actionClass: "FINANCIAL_EXECUTION",
    touchesSensitiveData: true,
  },
];

describe("routine integration requirements", () => {
  it("derives approval posture from the action policy", () => {
    const view = routineIntegrationRequirementView(requirements[1]);

    expect(view.approval.requirement).toBe("approval_step_up");
    expect(view.approval.reasons.join(" ")).toContain("FINANCIAL_EXECUTION");
  });

  it("summarizes required integrations and highest action class", () => {
    const summary = summarizeRoutineIntegrations(requirements);

    expect(summary).toMatchObject({
      required: 2,
      optional: 0,
      enabledByDefault: 0,
      highestActionClass: "FINANCIAL_EXECUTION",
      approvalDefault: "approval_step_up",
      humanApprovalRequired: true,
    });
  });

  it("parses JSON-safe requirements and rejects malformed values", () => {
    expect(parseRoutineIntegrationRequirements(requirements)).toEqual(requirements);
    expect(parseRoutineIntegrationRequirements(undefined)).toEqual([]);
    expect(parseRoutineIntegrationRequirements([{ ...requirements[0], actionClass: "ROOT" }])).toBeNull();
    expect(parseRoutineIntegrationRequirements([{ ...requirements[0], capabilities: [""] }])).toBeNull();
  });
});
