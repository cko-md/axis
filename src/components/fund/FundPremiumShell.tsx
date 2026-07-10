"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ModuleInteractiveHero } from "@/components/ui/axis/ModuleInteractiveHero";
import { FundSubNav } from "@/components/fund/FundSubNav";

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

type ProviderStatus = {
  polygon: boolean;
  plaid: boolean;
  publicCom: boolean;
};

export function FundPremiumShell({ children }: Props) {
  const pathname = usePathname();
  const [providers, setProviders] = useState<ProviderStatus>({ polygon: false, plaid: false, publicCom: false });

  useEffect(() => {
    void Promise.all([
      fetch("/api/massive/status").then((r) => r.json()).catch(() => ({})),
      fetch("/api/plaid/status").then((r) => r.json()).catch(() => ({})),
      fetch("/api/brokerage/status").then((r) => r.json()).catch(() => ({})),
    ]).then(([massive, plaid, brokerage]) => {
      setProviders({
        polygon: !!massive?.configured,
        plaid: !!plaid?.configured,
        publicCom: !!brokerage?.configured,
      });
    });
  }, []);

  const activeLabel = Object.entries(PAGE_LABELS).find(([href]) =>
    href === "/fund" ? pathname === "/fund" : pathname.startsWith(href),
  )?.[1] ?? "Fund";

  const connectedCount = [providers.polygon, providers.plaid, providers.publicCom].filter(Boolean).length;
  const modeLabel = connectedCount === 3
    ? "All providers connected"
    : connectedCount > 0
      ? `${connectedCount}/3 providers connected`
      : "Demo / manual mode";

  return (
    <div className="module-stage fund-stage">
      <ModuleInteractiveHero
        compact
        eyebrow="Capital · Fund"
        title={activeLabel}
        subtitle="Chart-safe Tier 1 surfaces · live when connected"
        stats={[
          { label: "Surface", value: activeLabel },
          { label: "Mode", value: modeLabel, tone: connectedCount > 0 ? "accent" : "warn" },
          { label: "Quotes", value: providers.polygon ? "Live" : "Not configured", tone: providers.polygon ? "accent" : "default" },
        ]}
        actions={[
          { label: "Refresh quotes", href: "/fund/watchlist" },
          { label: "Connections", href: "/control-room" },
        ]}
      />
      <FundSubNav />
      {children}
    </div>
  );
}
