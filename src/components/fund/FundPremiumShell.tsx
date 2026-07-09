"use client";

import type { ReactNode } from "react";
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

export function FundPremiumShell({ children }: Props) {
  const pathname = usePathname();
  const activeLabel = Object.entries(PAGE_LABELS).find(([href]) =>
    href === "/fund" ? pathname === "/fund" : pathname.startsWith(href),
  )?.[1] ?? "Fund";

  return (
    <div className="module-stage fund-stage">
      <ModuleInteractiveHero
        compact
        eyebrow="Capital · Fund"
        title={activeLabel}
        subtitle="Chart-safe Tier 1 surfaces · live when connected"
        stats={[
          { label: "Surface", value: activeLabel },
          { label: "Mode", value: "Live when connected", tone: "accent" },
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
