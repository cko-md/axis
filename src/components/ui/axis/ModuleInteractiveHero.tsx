"use client";

import type { ReactNode } from "react";
import { AxisReflectiveCard } from "@/components/ui/axis/AxisReflectiveCard";
import { semanticToneColor, type SemanticToneKey } from "@/lib/design/statusTokens";

/**
 * Stat tone. The three legacy values (default/accent/warn) are kept so the
 * original Fund/Vitality/Literature call sites don't have to change; the full
 * semantic set (success/alert/danger/muted) maps through statusTokens so a new
 * header can express "live/fresh" vs "stale/failed" distinctly, styled by the
 * single source of status colors rather than ad-hoc inline colors.
 */
export type HeroStatTone =
  | "default"
  | "accent"
  | "warn"
  | SemanticToneKey;

type Stat = {
  label: string;
  value: string;
  tone?: HeroStatTone;
  /** Small caption under the value (e.g. "updated 4m ago"). */
  hint?: string;
};

type Action = {
  label: string;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  /** Draw the button as the primary affordance. */
  primary?: boolean;
};

type Props = {
  eyebrow: string;
  title: string;
  subtitle?: ReactNode;
  stats?: Stat[];
  actions?: Action[];
  compact?: boolean;
  /** Render a stat skeleton instead of values while first-load is in flight. */
  loading?: boolean;
  children?: ReactNode;
};

function toneStyle(tone: HeroStatTone | undefined): React.CSSProperties | undefined {
  if (!tone || tone === "default") return undefined;
  // Map the two legacy aliases onto the semantic palette.
  const key: SemanticToneKey =
    tone === "warn" ? "warning" : tone === "accent" ? "accent" : tone;
  return { color: semanticToneColor(key) };
}

export function ModuleInteractiveHero({
  eyebrow,
  title,
  subtitle,
  stats = [],
  actions = [],
  compact,
  loading = false,
  children,
}: Props) {
  const showStats = loading || stats.length > 0;
  return (
    <AxisReflectiveCard className={`module-hero-shell module-interactive-hero${compact ? " module-hero-shell--compact" : ""}`}>
      <div className="module-hero-top">
        <div className="module-hero-copy">
          <div className="eyebrow">{eyebrow}</div>
          <h1 className="hero-title">{title}</h1>
          {subtitle ? <p className="sub mail-hero-meta">{subtitle}</p> : null}
        </div>
        {actions.length > 0 && (
          <div className="module-hero-actions">
            {actions.map((action) => {
              const className = `feed-manage module-hero-action${action.primary ? " module-hero-action--primary" : ""}`;
              if (action.href) {
                return (
                  <a
                    key={action.label}
                    href={action.href}
                    className={className}
                    aria-disabled={action.disabled}
                  >
                    {action.label}
                  </a>
                );
              }
              return (
                <button
                  key={action.label}
                  type="button"
                  className={className}
                  onClick={action.onClick}
                  disabled={action.disabled}
                >
                  {action.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {showStats && (
        <div className="module-hero-stats" role="list">
          {loading
            ? Array.from({ length: Math.max(stats.length, 3) }).map((_, i) => (
                <div key={i} className="module-hero-stat module-hero-stat--loading" role="listitem" aria-hidden>
                  <span className="module-hero-stat-v">—</span>
                  <span className="module-hero-stat-k">Loading</span>
                </div>
              ))
            : stats.map((stat) => (
                <div
                  key={stat.label}
                  className="module-hero-stat"
                  role="listitem"
                >
                  <span className="module-hero-stat-v" style={toneStyle(stat.tone)}>{stat.value}</span>
                  <span className="module-hero-stat-k">{stat.label}</span>
                  {stat.hint ? <span className="module-hero-stat-hint">{stat.hint}</span> : null}
                </div>
              ))}
        </div>
      )}
      {children}
    </AxisReflectiveCard>
  );
}
