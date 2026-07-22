"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { ModuleInteractiveHero } from "@/components/ui/axis/ModuleInteractiveHero";
import { FundSubNav } from "@/components/fund/FundSubNav";
import { FreshnessBadge } from "@/components/ui/FreshnessBadge";
import {
  deriveConnectionHealth,
  type ConnectionHealth,
  type ConnectionHealthTone,
} from "@/lib/fund/connectionHealth";
import { FRESHNESS_SLAS } from "@/lib/fund/provenance";
import { semanticToneColor, type SemanticToneKey } from "@/lib/design/statusTokens";

const PAGE_LABELS: Record<string, string> = {
  "/fund": "Overview",
  "/fund/spending": "Spending",
  "/fund/cashflow": "Cash Flow",
  "/fund/net-worth": "Net Worth",
  "/fund/investing": "Investing",
  "/fund/watchlist": "Watchlist",
  "/fund/market": "Market",
  "/fund/forecasting": "Forecasting",
  "/fund/advisor": "Advisor",
};

type Props = {
  children: ReactNode;
};

type ProviderStatusResponse = {
  configured?: boolean;
  linked?: boolean;
  provider?: string;
  source?: string;
  latestConnection?: {
    institution?: string | null;
    status?: string | null;
    updatedAt?: string | null;
  } | null;
  error?: string;
};

type ProviderStatuses = {
  polygon: ProviderStatusResponse;
  plaid: ProviderStatusResponse;
  publicCom: ProviderStatusResponse;
};

const EMPTY_STATUS: ProviderStatusResponse = { configured: false };

const HEALTH_TONE_KEY: Record<ConnectionHealthTone, SemanticToneKey> = {
  positive: "success",
  caution: "warning",
  muted: "muted",
  negative: "danger",
};

const HEALTH_TONE_STYLES: Record<ConnectionHealthTone, { color: string; border: string; background: string }> = {
  positive: {
    color: semanticToneColor(HEALTH_TONE_KEY.positive),
    border: `color-mix(in srgb, ${semanticToneColor(HEALTH_TONE_KEY.positive)} 34%, transparent)`,
    background: `color-mix(in srgb, ${semanticToneColor(HEALTH_TONE_KEY.positive)} 12%, transparent)`,
  },
  caution: {
    color: semanticToneColor(HEALTH_TONE_KEY.caution),
    border: `color-mix(in srgb, ${semanticToneColor(HEALTH_TONE_KEY.caution)} 34%, transparent)`,
    background: `color-mix(in srgb, ${semanticToneColor(HEALTH_TONE_KEY.caution)} 12%, transparent)`,
  },
  muted: {
    color: semanticToneColor(HEALTH_TONE_KEY.muted),
    border: "var(--line)",
    background: "color-mix(in srgb, var(--surface) 54%, transparent)",
  },
  negative: {
    color: semanticToneColor(HEALTH_TONE_KEY.negative),
    border: `color-mix(in srgb, ${semanticToneColor(HEALTH_TONE_KEY.negative)} 34%, transparent)`,
    background: `color-mix(in srgb, ${semanticToneColor(HEALTH_TONE_KEY.negative)} 12%, transparent)`,
  },
};

export function FundPremiumShell({ children }: Props) {
  const pathname = usePathname();
  const [providers, setProviders] = useState<ProviderStatuses>({
    polygon: EMPTY_STATUS,
    plaid: EMPTY_STATUS,
    publicCom: EMPTY_STATUS,
  });
  const [refreshing, setRefreshing] = useState(false);

  const refreshStatuses = useCallback(async () => {
    setRefreshing(true);
    try {
      const [massive, plaid, brokerage] = await Promise.all([
        fetch("/api/massive/status").then((r) => r.json()).catch(() => ({ error: "STATUS_UNAVAILABLE" })),
        fetch("/api/plaid/status").then((r) => r.json()).catch(() => ({ error: "STATUS_UNAVAILABLE" })),
        fetch("/api/brokerage/status").then((r) => r.json()).catch(() => ({ error: "STATUS_UNAVAILABLE" })),
      ]);
      setProviders({ polygon: massive, plaid, publicCom: brokerage });
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatuses();
  }, [refreshStatuses]);

  const providerHealth = useMemo<ConnectionHealth[]>(() => [
    deriveConnectionHealth({
      provider: "plaid",
      label: "Plaid",
      configured: !!providers.plaid.configured,
      linked: providers.plaid.linked,
      lastSyncedAt: providers.plaid.latestConnection?.updatedAt ?? null,
      error: !!providers.plaid.error || providers.plaid.latestConnection?.status === "error",
      freshnessSla: FRESHNESS_SLAS.accountBalance,
    }),
    deriveConnectionHealth({
      provider: "public",
      label: "Public",
      configured: !!providers.publicCom.configured,
      linked: providers.publicCom.linked,
      lastSyncedAt: providers.publicCom.latestConnection?.updatedAt ?? null,
      error: !!providers.publicCom.error || providers.publicCom.latestConnection?.status === "error",
      freshnessSla: FRESHNESS_SLAS.holdings,
    }),
    deriveConnectionHealth({
      provider: "polygon",
      label: "Polygon",
      configured: !!providers.polygon.configured,
      linked: providers.polygon.linked,
      lastSyncedAt: providers.polygon.latestConnection?.updatedAt ?? null,
      error: !!providers.polygon.error,
      freshnessSla: FRESHNESS_SLAS.marketPrice,
    }),
  ], [providers]);

  const activeLabel = Object.entries(PAGE_LABELS).find(([href]) =>
    href === "/fund" ? pathname === "/fund" : pathname.startsWith(href),
  )?.[1] ?? "Fund";

  const enabledCount = providerHealth.filter((provider) => provider.status === "connected" || provider.status === "configured").length;
  const linkedCount = providerHealth.filter((provider) => provider.status === "connected").length;
  const modeLabel = enabledCount === 3
    ? linkedCount > 0 ? `${linkedCount} linked · all enabled` : "All providers enabled"
    : enabledCount > 0
      ? `${enabledCount}/3 providers enabled`
      : "Demo / manual mode";
  const polygonHealth = providerHealth.find((provider) => provider.provider === "polygon");
  const quotesEnabled = polygonHealth?.status === "connected" || polygonHealth?.status === "configured";
  // Subtitle now reflects real connection state instead of a fixed slogan.
  const subtitle = linkedCount > 0
    ? `${linkedCount} provider${linkedCount === 1 ? "" : "s"} linked · Tier 1 surfaces live`
    : enabledCount > 0
      ? "Providers configured · link an account for live data"
      : "Demo / manual mode · connect a provider for live data";

  return (
    <div className="module-stage fund-stage">
      <ModuleInteractiveHero
        compact
        eyebrow="Capital · Fund"
        title={activeLabel}
        subtitle={subtitle}
        stats={[
          { label: "Surface", value: activeLabel },
          { label: "Mode", value: modeLabel, tone: linkedCount > 0 ? "success" : enabledCount > 0 ? "accent" : "warn" },
          {
            label: "Quotes",
            value: quotesEnabled ? "Enabled" : "Not configured",
            tone: quotesEnabled ? "accent" : "muted",
          },
        ]}
        actions={[
          { label: refreshing ? "Refreshing…" : "Refresh status", onClick: () => void refreshStatuses(), disabled: refreshing },
          { label: "Watchlist", href: "/fund/watchlist" },
          { label: "Connections", href: "/control-room" },
        ]}
      >
        <div
          aria-label="Fund provider connection health"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 10,
            marginTop: 16,
          }}
        >
          {providerHealth.map((provider) => {
            const tone = HEALTH_TONE_STYLES[provider.tone];
            return (
              <div
                key={provider.provider}
                style={{
                  display: "grid",
                  gap: 7,
                  minWidth: 0,
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: `1px solid ${tone.border}`,
                  background: tone.background,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ink-strong)" }}>{provider.label}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: tone.color, whiteSpace: "nowrap" }}>
                    {provider.statusLabel}
                  </span>
                </div>
                <span style={{ fontSize: 11, color: "var(--ink-faint)", minWidth: 0 }}>
                  {provider.provenanceLabel}
                </span>
                <FreshnessBadge
                  tier={provider.freshness}
                  retrievedAt={provider.lastSyncedAt}
                  sla={provider.provider === "polygon" ? FRESHNESS_SLAS.marketPrice : FRESHNESS_SLAS.accountBalance}
                />
              </div>
            );
          })}
        </div>
      </ModuleInteractiveHero>
      <FundSubNav />
      {children}
    </div>
  );
}
