/**
 * Integration risk model (program §16) — maps a provider's capabilities to the
 * security kernel's action taxonomy so the Control Room / integration cards can
 * organize integrations "by capability and risk, not logo count", and so a
 * routine enabling an integration inherits the right approval defaults.
 *
 * Pure and dependency-light (composes actionPolicy + the registry types) so the
 * classification is unit-tested and reused identically by UI and routine setup.
 */

import { decideApproval, type ActionClass, type ApprovalRequirement } from "@/lib/security/actionPolicy";
import type { ProviderCapabilities, ProviderDescriptor } from "./registry";
import type { IntegrationTransport } from "./types";

/** The capability flags on ProviderCapabilities, in a stable order. */
export const CAPABILITY_KEYS = [
  "list",
  "read",
  "send",
  "reply",
  "markRead",
  "archive",
  "delete",
  "attachmentDownload",
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/** Map each capability to the action class it exercises. */
const CAPABILITY_ACTION_CLASS: Readonly<Record<CapabilityKey, ActionClass>> = {
  list: "READ",
  read: "READ",
  attachmentDownload: "READ",
  markRead: "INTERNAL_WRITE",
  archive: "INTERNAL_WRITE",
  send: "EXTERNAL_COMMUNICATION",
  reply: "EXTERNAL_COMMUNICATION",
  delete: "DESTRUCTIVE_ADMIN",
};

export function capabilityActionClass(cap: CapabilityKey): ActionClass {
  return CAPABILITY_ACTION_CLASS[cap];
}

/** Coarse risk tier for a provider+transport, for badge/sorting. */
export type IntegrationRiskLevel = "read_only" | "writes" | "sends" | "destructive";

const CLASS_RANK: Record<ActionClass, number> = {
  READ: 0,
  DRAFT: 1,
  SIMULATE: 1,
  INTERNAL_WRITE: 2,
  EXTERNAL_COMMUNICATION: 3,
  FINANCIAL_EXECUTION: 4,
  DESTRUCTIVE_ADMIN: 5,
};

export type IntegrationRiskProfile = {
  /** Enabled capability keys, split by what they do. */
  readCaps: CapabilityKey[];
  writeCaps: CapabilityKey[];
  sendCaps: CapabilityKey[];
  destructiveCaps: CapabilityKey[];
  /** The most privileged action class this integration can reach. */
  highestClass: ActionClass;
  riskLevel: IntegrationRiskLevel;
  /** Approval default for the most privileged capability (from the kernel). */
  approvalDefault: ApprovalRequirement;
  /** Count of enabled capabilities — a proxy for tool/context impact (§16). */
  enabledCount: number;
};

function riskLevelForClass(cls: ActionClass): IntegrationRiskLevel {
  if (cls === "DESTRUCTIVE_ADMIN" || cls === "FINANCIAL_EXECUTION") return "destructive";
  if (cls === "EXTERNAL_COMMUNICATION") return "sends";
  if (cls === "INTERNAL_WRITE") return "writes";
  return "read_only";
}

/**
 * Derive the risk profile for a set of enabled capabilities. Disabled
 * capabilities (a `false` flag, i.e. the adapter returns not_supported) never
 * contribute risk.
 */
export function capabilitiesRiskProfile(caps: ProviderCapabilities): IntegrationRiskProfile {
  const enabled = CAPABILITY_KEYS.filter((k) => caps[k]);
  const readCaps: CapabilityKey[] = [];
  const writeCaps: CapabilityKey[] = [];
  const sendCaps: CapabilityKey[] = [];
  const destructiveCaps: CapabilityKey[] = [];

  let highestClass: ActionClass = "READ";
  for (const cap of enabled) {
    const cls = capabilityActionClass(cap);
    if (CLASS_RANK[cls] > CLASS_RANK[highestClass]) highestClass = cls;
    if (cls === "READ") readCaps.push(cap);
    else if (cls === "INTERNAL_WRITE") writeCaps.push(cap);
    else if (cls === "EXTERNAL_COMMUNICATION") sendCaps.push(cap);
    else destructiveCaps.push(cap);
  }

  return {
    readCaps,
    writeCaps,
    sendCaps,
    destructiveCaps,
    highestClass,
    riskLevel: riskLevelForClass(highestClass),
    approvalDefault: decideApproval({ actionClass: highestClass }).requirement,
    enabledCount: enabled.length,
  };
}

/** Risk profile for a specific provider descriptor over a transport. */
export function providerRiskProfile(
  descriptor: ProviderDescriptor,
  transport: IntegrationTransport,
): IntegrationRiskProfile | undefined {
  const caps = descriptor.capabilities[transport];
  return caps ? capabilitiesRiskProfile(caps) : undefined;
}
