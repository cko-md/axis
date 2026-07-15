import { decideApproval, type ActionClass, type ApprovalDecision } from "@/lib/security/actionPolicy";

export type RoutineIntegrationDomain =
  | "supabase"
  | "market_data"
  | "banking"
  | "brokerage"
  | "ai";

export type RoutineIntegrationRequirement = {
  key: string;
  label: string;
  provider: string;
  domain: RoutineIntegrationDomain;
  required: boolean;
  enabledByDefault?: boolean;
  purpose: string;
  capabilities: string[];
  actionClass: ActionClass;
  touchesSensitiveData?: boolean;
  usesUntrustedExternalContent?: boolean;
  explicitlyTrusted?: boolean;
};

export type RoutineIntegrationRequirementView = RoutineIntegrationRequirement & {
  approval: ApprovalDecision;
};

export type RoutineIntegrationSummary = {
  required: number;
  optional: number;
  enabledByDefault: number;
  highestActionClass: ActionClass;
  approvalDefault: ApprovalDecision["requirement"];
  humanApprovalRequired: boolean;
};

const ACTION_CLASS_RANK: Readonly<Record<ActionClass, number>> = {
  READ: 0,
  DRAFT: 1,
  SIMULATE: 2,
  INTERNAL_WRITE: 3,
  EXTERNAL_COMMUNICATION: 4,
  FINANCIAL_EXECUTION: 5,
  DESTRUCTIVE_ADMIN: 6,
};

const ACTION_CLASSES = new Set<ActionClass>([
  "READ",
  "DRAFT",
  "SIMULATE",
  "INTERNAL_WRITE",
  "EXTERNAL_COMMUNICATION",
  "FINANCIAL_EXECUTION",
  "DESTRUCTIVE_ADMIN",
]);

const DOMAINS = new Set<RoutineIntegrationDomain>([
  "supabase",
  "market_data",
  "banking",
  "brokerage",
  "ai",
]);

export function routineIntegrationRequirementView(
  requirement: RoutineIntegrationRequirement,
): RoutineIntegrationRequirementView {
  return {
    ...requirement,
    approval: decideApproval({
      actionClass: requirement.actionClass,
      touchesSensitiveData: requirement.touchesSensitiveData,
      usesUntrustedExternalContent: requirement.usesUntrustedExternalContent,
      explicitlyTrusted: requirement.explicitlyTrusted,
    }),
  };
}

export function summarizeRoutineIntegrations(
  requirements: readonly RoutineIntegrationRequirement[] = [],
): RoutineIntegrationSummary {
  const views = requirements.map(routineIntegrationRequirementView);
  const required = requirements.filter((requirement) => requirement.required).length;
  const highestActionClass = requirements.reduce<ActionClass>((highest, requirement) => {
    return ACTION_CLASS_RANK[requirement.actionClass] > ACTION_CLASS_RANK[highest]
      ? requirement.actionClass
      : highest;
  }, "READ");
  const highestApproval = decideApproval({
    actionClass: highestActionClass,
    touchesSensitiveData: requirements.some((requirement) => requirement.touchesSensitiveData),
    usesUntrustedExternalContent: requirements.some((requirement) => requirement.usesUntrustedExternalContent),
  }).requirement;

  return {
    required,
    optional: requirements.length - required,
    enabledByDefault: requirements.filter((requirement) => requirement.enabledByDefault === true).length,
    highestActionClass,
    approvalDefault: highestApproval,
    humanApprovalRequired: views.some((view) => view.approval.requirement !== "auto"),
  };
}

export function parseRoutineIntegrationRequirements(value: unknown): RoutineIntegrationRequirement[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const parsed: RoutineIntegrationRequirement[] = [];

  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (typeof record.key !== "string" || !record.key) return null;
    if (typeof record.label !== "string" || !record.label) return null;
    if (typeof record.provider !== "string" || !record.provider) return null;
    if (typeof record.domain !== "string" || !DOMAINS.has(record.domain as RoutineIntegrationDomain)) return null;
    if (typeof record.required !== "boolean") return null;
    if (record.enabledByDefault !== undefined && typeof record.enabledByDefault !== "boolean") return null;
    if (typeof record.purpose !== "string" || !record.purpose) return null;
    if (!Array.isArray(record.capabilities) || !record.capabilities.every((cap) => typeof cap === "string" && cap)) return null;
    if (typeof record.actionClass !== "string" || !ACTION_CLASSES.has(record.actionClass as ActionClass)) return null;
    if (record.touchesSensitiveData !== undefined && typeof record.touchesSensitiveData !== "boolean") return null;
    if (record.usesUntrustedExternalContent !== undefined && typeof record.usesUntrustedExternalContent !== "boolean") return null;
    if (record.explicitlyTrusted !== undefined && typeof record.explicitlyTrusted !== "boolean") return null;

    parsed.push({
      key: record.key,
      label: record.label,
      provider: record.provider,
      domain: record.domain as RoutineIntegrationDomain,
      required: record.required,
      ...(record.enabledByDefault !== undefined ? { enabledByDefault: record.enabledByDefault } : {}),
      purpose: record.purpose,
      capabilities: record.capabilities,
      actionClass: record.actionClass as ActionClass,
      ...(record.touchesSensitiveData !== undefined ? { touchesSensitiveData: record.touchesSensitiveData } : {}),
      ...(record.usesUntrustedExternalContent !== undefined ? { usesUntrustedExternalContent: record.usesUntrustedExternalContent } : {}),
      ...(record.explicitlyTrusted !== undefined ? { explicitlyTrusted: record.explicitlyTrusted } : {}),
    });
  }

  return parsed;
}
