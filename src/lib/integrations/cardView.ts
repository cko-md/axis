import { providerRiskProfile, type IntegrationRiskLevel } from "./risk";
import type { ApprovalRequirement } from "@/lib/security/actionPolicy";
import type { ProviderDescriptor } from "./registry";
import type { IntegrationTransport } from "./types";

export type IntegrationCardTone = "neutral" | "info" | "warning" | "danger";

export type IntegrationCardView = {
  riskLevel: IntegrationRiskLevel;
  riskLabel: string;
  approvalLabel: string;
  capabilityLabel: string;
  highestClassLabel: string;
  tone: IntegrationCardTone;
};

const RISK_LABEL: Record<IntegrationRiskLevel, string> = {
  read_only: "Read-only",
  writes: "Writes",
  sends: "Sends",
  destructive: "Destructive",
};

const APPROVAL_LABEL: Record<ApprovalRequirement, string> = {
  auto: "Auto",
  approval: "Approval",
  approval_step_up: "Step-up",
};

const TONE: Record<IntegrationRiskLevel, IntegrationCardTone> = {
  read_only: "neutral",
  writes: "info",
  sends: "warning",
  destructive: "danger",
};

function classLabel(value: string) {
  return value.toLowerCase().replaceAll("_", " ");
}

export function integrationCardView(
  descriptor: ProviderDescriptor,
  transport: IntegrationTransport,
): IntegrationCardView | null {
  const profile = providerRiskProfile(descriptor, transport);
  if (!profile) return null;
  return {
    riskLevel: profile.riskLevel,
    riskLabel: RISK_LABEL[profile.riskLevel],
    approvalLabel: APPROVAL_LABEL[profile.approvalDefault],
    capabilityLabel: `${profile.enabledCount} cap${profile.enabledCount === 1 ? "" : "s"}`,
    highestClassLabel: classLabel(profile.highestClass),
    tone: TONE[profile.riskLevel],
  };
}
