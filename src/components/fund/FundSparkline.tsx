"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";

/**
 * Shared 90-day sparkline, extracted from the old inline FundChart in
 * FundModule.tsx so Position, Watchlist, and Market pages can all use it
 * instead of duplicating the SVG. Hand-rolled SVG per Atelier convention —
 * no chart library.
 */
export function FundSparkline({ symbol, live }: { symbol: string; live?: boolean }) {
  const [points, setPoints] = useState<number[]>([]);

  useEffect(() => {
    async function load() {
      if (live) {
        const to = new Date().toISOString().slice(0, 10);
        const from = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
        const res = await fetch(`/api/massive/history?symbol=${symbol}&from=${from}&to=${to}`);
        if (res.ok) {
          const data = await res.json();
          setPoints((data.bars ?? []).map((b: { c: number }) => b.c));
          return;
        }
      }
      setPoints([100, 102, 101, 105, 103, 108, 110, 109, 112, 115]);
    }
    load();
  }, [symbol, live]);

  if (!points.length) return null;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const norm = points.map((p, i) => {
    const x = (i / (points.length - 1)) * 160;
    const y = 34 - ((p - min) / (max - min || 1)) * 28;
    return `${x},${y}`;
  });

  return (
    <Card className="mt-4">
      <div className="seclabel">
        {symbol} · 90d {live ? "live" : "simulated"}
      </div>
      <svg viewBox="0 0 160 34" className="mt-2 h-10 w-full" preserveAspectRatio="none">
        <polyline fill="none" stroke="var(--accent)" strokeWidth="2" points={norm.join(" ")} />
      </svg>
    </Card>
  );
}
