/**
 * Presentation layer for data-freshness — the pure mapping from a
 * {@link FreshnessTier} (produced by `classifyFreshness` in provenance.ts) to
 * the label, tone, and description a badge renders.
 *
 * The program's safety model (§17) requires every financially material data
 * view to distinguish fresh / delayed / stale / unknown, and to never present
 * delayed provider data as real-time. Keeping the copy and tone mapping here —
 * pure and unit-tested — means the badge component stays a thin renderer and the
 * user-facing wording is verified rather than scattered through JSX.
 */

import type { FreshnessTier } from "./provenance";

/** Visual/semantic tone a freshness badge uses. */
export type FreshnessTone = "positive" | "caution" | "negative" | "muted";

export type FreshnessBadgeView = {
  tier: FreshnessTier;
  /** Short pill label, e.g. "Live", "Delayed". */
  label: string;
  tone: FreshnessTone;
  /** Longer sentence for a tooltip / aria description. */
  description: string;
};

const VIEWS: Readonly<Record<FreshnessTier, Omit<FreshnessBadgeView, "tier">>> = {
  fresh: {
    label: "Live",
    tone: "positive",
    description: "Up to date — within its freshness window.",
  },
  delayed: {
    label: "Delayed",
    tone: "caution",
    description: "Older than the fresh window; not real-time.",
  },
  stale: {
    label: "Stale",
    tone: "negative",
    description: "Past its freshness SLA — refresh before relying on it.",
  },
  unknown: {
    label: "Unknown",
    tone: "muted",
    description: "No retrieval timestamp — freshness can't be verified.",
  },
};

/** Map a freshness tier to its badge view (label + tone + description). */
export function freshnessBadgeView(tier: FreshnessTier): FreshnessBadgeView {
  return { tier, ...VIEWS[tier] };
}

/**
 * Compact relative-time label for "as of" captions: "just now", "5m ago",
 * "3h ago", "2d ago", "6w ago". Returns null for missing/invalid/future
 * timestamps so callers render nothing rather than a misleading "0s ago".
 */
export function relativeTimeShort(
  at: string | Date | null | undefined,
  now: number = Date.now(),
): string | null {
  if (at == null) return null;
  const ms = at instanceof Date ? at.getTime() : Date.parse(at);
  if (!Number.isFinite(ms)) return null;

  const diff = now - ms;
  // Small clock-skew tolerance; anything clearly in the future is not shown.
  if (diff < -60_000) return null;
  const sec = Math.max(0, Math.floor(diff / 1000));

  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}
