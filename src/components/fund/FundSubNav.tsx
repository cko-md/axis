"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/fund", label: "Overview" },
  { href: "/fund/spending", label: "Spending" },
  { href: "/fund/cashflow", label: "Cash Flow" },
  { href: "/fund/net-worth", label: "Net Worth" },
  { href: "/fund/investing", label: "Investing" },
  { href: "/fund/watchlist", label: "Watchlist" },
  { href: "/fund/market", label: "Market" },
  { href: "/fund/forecasting", label: "Forecasting" },
  { href: "/fund/advisor", label: "Advisor" },
];

/** Secondary nav for the Finance module — one Sidebar entry ("Fund"), many sub-pages here. */
export function FundSubNav() {
  const pathname = usePathname();
  return (
    <div className="subtabbar" style={{ marginBottom: 20 }}>
      {ITEMS.map((item) => {
        const active = item.href === "/fund" ? pathname === "/fund" : pathname.startsWith(item.href);
        return (
          <Link key={item.href} href={item.href} className={`subtab${active ? " on" : ""}`}>
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}
