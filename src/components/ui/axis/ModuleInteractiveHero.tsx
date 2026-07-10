"use client";

import type { ReactNode } from "react";
import { AxisReflectiveCard } from "@/components/ui/axis/AxisReflectiveCard";

type Stat = {
  label: string;
  value: string;
  tone?: "default" | "accent" | "warn";
};

type Action = {
  label: string;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
};

type Props = {
  eyebrow: string;
  title: string;
  subtitle?: string;
  stats?: Stat[];
  actions?: Action[];
  compact?: boolean;
  children?: ReactNode;
};

export function ModuleInteractiveHero({
  eyebrow,
  title,
  subtitle,
  stats = [],
  actions = [],
  compact,
  children,
}: Props) {
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
              const className = "feed-manage module-hero-action";
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
      {stats.length > 0 && (
        <div className="module-hero-stats" role="list">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className={`module-hero-stat${stat.tone === "accent" ? " is-accent" : ""}${stat.tone === "warn" ? " is-warn" : ""}`}
              role="listitem"
            >
              <span className="module-hero-stat-v">{stat.value}</span>
              <span className="module-hero-stat-k">{stat.label}</span>
            </div>
          ))}
        </div>
      )}
      {children}
    </AxisReflectiveCard>
  );
}
