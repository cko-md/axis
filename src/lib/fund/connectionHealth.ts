import {
  classifyFreshness,
  FRESHNESS_SLAS,
  type FreshnessSla,
  type FreshnessTier,
} from "./provenance";

export type ConnectionHealthStatus =
  | "connected"
  | "configured"
  | "not_configured"
  | "degraded";

export type ConnectionHealthTone = "positive" | "caution" | "muted" | "negative";

export type ConnectionHealthInput = {
  provider: "plaid" | "public" | "polygon" | string;
  label: string;
  configured: boolean;
  linked?: boolean | null;
  lastSyncedAt?: string | Date | null;
  error?: boolean;
  freshnessSla?: FreshnessSla;
  now?: number;
};

export type ConnectionHealth = {
  provider: string;
  label: string;
  status: ConnectionHealthStatus;
  statusLabel: string;
  tone: ConnectionHealthTone;
  freshness: FreshnessTier;
  provenanceLabel: string;
  lastSyncedAt: string | Date | null;
};

export function deriveConnectionHealth(input: ConnectionHealthInput): ConnectionHealth {
  const lastSyncedAt = input.lastSyncedAt ?? null;
  const freshness = classifyFreshness(
    lastSyncedAt,
    input.freshnessSla ?? FRESHNESS_SLAS.accountBalance,
    input.now,
  );

  if (input.error) {
    return {
      provider: input.provider,
      label: input.label,
      status: "degraded",
      statusLabel: "Needs attention",
      tone: "negative",
      freshness,
      provenanceLabel: freshness === "unknown" ? "Provider error" : "Last known provider data",
      lastSyncedAt,
    };
  }

  if (!input.configured) {
    return {
      provider: input.provider,
      label: input.label,
      status: "not_configured",
      statusLabel: "Not configured",
      tone: "muted",
      freshness: "unknown",
      provenanceLabel: "No server-side provider credentials",
      lastSyncedAt: null,
    };
  }

  if (input.linked === true) {
    return {
      provider: input.provider,
      label: input.label,
      status: "connected",
      statusLabel: "Connected",
      tone: freshness === "stale" ? "caution" : "positive",
      freshness,
      provenanceLabel: lastSyncedAt ? "User-linked provider record" : "User-linked provider",
      lastSyncedAt,
    };
  }

  return {
    provider: input.provider,
    label: input.label,
    status: "configured",
    statusLabel: "Configured",
    tone: "caution",
    freshness,
    provenanceLabel: "Server-side provider credentials",
    lastSyncedAt,
  };
}
