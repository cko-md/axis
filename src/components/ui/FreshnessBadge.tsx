"use client";

import { classifyFreshness, type FreshnessSla, type FreshnessTier } from "@/lib/fund/provenance";
import {
  freshnessBadgeView,
  relativeTimeShort,
  type FreshnessTone,
} from "@/lib/fund/freshnessBadge";

/**
 * A small, tokenized data-freshness pill (§17: every financially material view
 * must distinguish fresh / delayed / stale / unknown, and never present delayed
 * data as real-time).
 *
 * Pass a pre-computed `tier`, or pass `retrievedAt` + `sla` and let the badge
 * classify it via the pure `classifyFreshness`. When a timestamp is available it
 * is shown as a relative "as of" caption and exposed to assistive tech.
 */
const TONE_COLOR: Record<FreshnessTone, string> = {
  positive: "var(--up)",
  caution: "var(--clay-2, var(--gold-deep))",
  negative: "var(--down)",
  muted: "var(--ink-faint)",
};

export function FreshnessBadge({
  tier: tierProp,
  retrievedAt,
  sla,
  showRelative = true,
  now,
}: {
  /** Explicit tier; if omitted it is derived from retrievedAt + sla. */
  tier?: FreshnessTier;
  /** ISO timestamp / Date the value was retrieved (for derivation + caption). */
  retrievedAt?: string | Date | null;
  /** Freshness thresholds; required when deriving the tier from retrievedAt. */
  sla?: FreshnessSla;
  /** Show the relative "as of" caption next to the pill. */
  showRelative?: boolean;
  /** Reference time, for deterministic rendering/tests. */
  now?: number;
}) {
  const tier: FreshnessTier =
    tierProp ?? (sla ? classifyFreshness(retrievedAt, sla, now) : "unknown");
  const view = freshnessBadgeView(tier);
  const color = TONE_COLOR[view.tone];
  const relative = showRelative ? relativeTimeShort(retrievedAt, now) : null;

  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
      title={relative ? `${view.description} Updated ${relative}.` : view.description}
    >
      <span
        role="status"
        aria-label={`Data freshness: ${view.label}. ${view.description}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          fontSize: 11,
          fontWeight: 600,
          lineHeight: 1,
          padding: "3px 7px",
          borderRadius: 999,
          color,
          background: `color-mix(in srgb, ${color} 14%, transparent)`,
          border: `1px solid color-mix(in srgb, ${color} 34%, transparent)`,
          whiteSpace: "nowrap",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: color,
            boxShadow: view.tone === "positive" ? `0 0 6px ${color}` : "none",
          }}
        />
        {view.label}
      </span>
      {relative && (
        <span style={{ fontSize: 11, color: "var(--ink-faint)", whiteSpace: "nowrap" }}>
          {relative}
        </span>
      )}
    </span>
  );
}
