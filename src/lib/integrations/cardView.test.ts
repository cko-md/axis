import { describe, expect, it } from "vitest";
import { integrationCardView } from "./cardView";
import { getProviderDescriptor } from "./registry";

describe("integrationCardView", () => {
  it("summarizes direct Gmail as a destructive step-up integration", () => {
    const gmail = getProviderDescriptor("mail", "gmail");
    expect(gmail).toBeDefined();
    const view = integrationCardView(gmail!, "direct");

    expect(view).toMatchObject({
      riskLevel: "destructive",
      riskLabel: "Destructive",
      approvalLabel: "Step-up",
      highestClassLabel: "destructive admin",
      tone: "danger",
    });
    expect(view?.capabilityLabel).toBe("8 caps");
  });

  it("reflects Composio Outlook's narrower current capability surface", () => {
    const outlook = getProviderDescriptor("mail", "outlook");
    expect(outlook).toBeDefined();
    const view = integrationCardView(outlook!, "composio");

    expect(view).toMatchObject({
      riskLevel: "sends",
      riskLabel: "Sends",
      approvalLabel: "Approval",
      highestClassLabel: "external communication",
      tone: "warning",
    });
  });
});
