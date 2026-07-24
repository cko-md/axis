// Cross-domain provider registry: the single source of truth for "which
// providers exist, over which transports, and what each can do". API routes,
// Control Room, and the account pickers read capabilities from here instead of
// hardcoding provider lists. Adapter *instances* are not held here — domains own
// their own factory (e.g. mail/adapters/index.ts `resolveMailAdapter`) — this
// registry is intentionally dependency-light so it can be imported anywhere
// (including client components) without pulling in server-only adapter code.

import type { IntegrationDomain, IntegrationTransport } from "./types";

/** What an adapter for a (domain, provider, transport) can do. */
export interface ProviderCapabilities {
  list: boolean;
  read: boolean;
  send: boolean;
  reply: boolean;
  markRead: boolean;
  archive: boolean;
  delete: boolean;
  attachmentDownload: boolean;
}

export interface ProviderDescriptor {
  domain: IntegrationDomain;
  /** Stable provider id, also the value used in `MailMessage.provider`. */
  provider: string;
  /** Composio toolkit slug backing the `composio` transport, when applicable. */
  composioToolkit?: string;
  /** Transports this provider supports, in preference order. */
  transports: IntegrationTransport[];
  /** Human label for UI. */
  label: string;
  /**
   * Capabilities per transport. A capability `false` for a transport means the
   * adapter returns a `not_supported` structured error for that method — the UI
   * should hide the affordance rather than let it fail.
   */
  capabilities: Record<IntegrationTransport, ProviderCapabilities>;
}

const FULL: ProviderCapabilities = {
  list: true,
  read: true,
  send: true,
  reply: true,
  markRead: true,
  archive: true,
  delete: true,
  attachmentDownload: true,
};

const COMPOSIO_GMAIL: ProviderCapabilities = {
  list: true,
  read: true,
  send: false,
  reply: false,
  markRead: false,
  archive: false,
  delete: false,
  attachmentDownload: false,
};

// Phase 1A containment leaves every Composio Mail write disabled pending
// explicit provider-mutation approval. Cache-backed listing and detail reads
// remain available through the verified local-connection dispatch boundary.
const COMPOSIO_OUTLOOK: ProviderCapabilities = {
  list: true,
  read: true,
  send: false,
  reply: false,
  markRead: false,
  archive: false,
  delete: false,
  attachmentDownload: false,
};

export const INTEGRATION_REGISTRY: ProviderDescriptor[] = [
  {
    domain: "mail",
    provider: "gmail",
    composioToolkit: "gmail",
    transports: ["direct", "composio"],
    label: "Gmail",
    capabilities: { direct: FULL, composio: COMPOSIO_GMAIL },
  },
  {
    domain: "mail",
    provider: "outlook",
    composioToolkit: "outlook",
    transports: ["direct", "composio"],
    label: "Outlook",
    capabilities: { direct: FULL, composio: COMPOSIO_OUTLOOK },
  },
];

export function getProviderDescriptor(
  domain: IntegrationDomain,
  provider: string,
): ProviderDescriptor | undefined {
  return INTEGRATION_REGISTRY.find((p) => p.domain === domain && p.provider === provider);
}

export function listProviders(domain: IntegrationDomain): ProviderDescriptor[] {
  return INTEGRATION_REGISTRY.filter((p) => p.domain === domain);
}

export function getCapabilities(
  domain: IntegrationDomain,
  provider: string,
  transport: IntegrationTransport,
): ProviderCapabilities | undefined {
  return getProviderDescriptor(domain, provider)?.capabilities[transport];
}
