import type { ProviderCapabilities, ProviderDescriptor } from "./registry";

/**
 * Technical adapter capability remains truthfully recorded in registry.ts.
 * This separate, temporary release policy removes mail mutation affordances
 * until the durable command/receipt/reconciliation path is live end to end.
 */
export const GOVERNED_MAIL_MUTATION_ENTRYPOINTS = [
  "MailModule/MessagePanel",
  "ComposeModal",
  "ControlRoomModule",
] as const;

const MAIL_MUTATION_KEYS = ["send", "reply", "markRead", "archive", "delete"] as const;

export function governedMailCapabilities(
  capabilities: ProviderCapabilities | undefined,
): ProviderCapabilities | undefined {
  if (!capabilities) return undefined;
  return {
    ...capabilities,
    ...Object.fromEntries(MAIL_MUTATION_KEYS.map((key) => [key, false])),
  } as ProviderCapabilities;
}

/** A non-mutating descriptor view for release-policy-facing surfaces. */
export function governedMailDescriptor(descriptor: ProviderDescriptor): ProviderDescriptor {
  if (descriptor.domain !== "mail") return descriptor;
  return {
    ...descriptor,
    capabilities: Object.fromEntries(
      Object.entries(descriptor.capabilities).map(([transport, capabilities]) => [
        transport,
        governedMailCapabilities(capabilities),
      ]),
    ) as ProviderDescriptor["capabilities"],
  };
}
