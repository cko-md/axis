"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AxisReflectiveCard } from "@/components/ui/axis/AxisReflectiveCard";
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
      <AxisReflectiveCard className="module-hero-shell module-hero-shell--compact">
        <div className="eyebrow">Capital · Fund</div>
        <h1 className="hero-title">{activeLabel}</h1>
        <p className="sub mail-hero-meta">Chart-safe Tier 1 surfaces · live when connected</p>
      </AxisReflectiveCard>
      <FundSubNav />
      {children}
    </div>
  );
}
