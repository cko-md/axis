"use client";

import type { KeyboardEvent, ReactNode } from "react";
import type { WidgetStatus } from "@/lib/widgets/types";
import { WidgetStatusBadge } from "@/components/widgets/WidgetStatusBadge";

type Props = {
  title: string;
  icon: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  status: WidgetStatus;
  updatedAt?: string;
  source?: string;
  provider?: string;
  loading?: boolean;
  stale?: boolean;
  error?: boolean;
  lab?: boolean;
  disconnected?: boolean;
  onPrimaryAction?: () => void;
  titleText?: string;
  actionSlot?: ReactNode;
  miniVisualizationSlot?: ReactNode;
  children?: ReactNode;
};

function formatUpdatedAt(updatedAt?: string) {
  if (!updatedAt) return null;
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function WidgetShell({
  title,
  icon,
  value,
  hint,
  status,
  updatedAt,
  source,
  provider,
  onPrimaryAction,
  titleText,
  actionSlot,
  miniVisualizationSlot,
  children,
}: Props) {
  const interactive = Boolean(onPrimaryAction);
  const updated = formatUpdatedAt(updatedAt);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onPrimaryAction?.();
  };

  return (
    <div
      className={`widget-shell${interactive ? " widget-shell-interactive" : ""}`}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onPrimaryAction}
      onKeyDown={handleKeyDown}
      title={titleText}
      aria-label={interactive ? `${title}: ${typeof value === "string" ? value : "open details"}` : undefined}
      data-status={status}
    >
      <div className="widget-shell-icon">{icon}</div>
      <div className="widget-shell-body">
        <div className="widget-shell-topline">
          <span className="widget-shell-title">{title}</span>
          <WidgetStatusBadge status={status} />
        </div>
        <div className="widget-shell-value">{value}</div>
        {hint ? <div className="widget-shell-hint">{hint}</div> : null}
        {children}
        <div className="widget-shell-meta">
          {provider ? <span>{provider}</span> : source ? <span>{source}</span> : null}
          {updated ? <span>Updated {updated}</span> : null}
        </div>
      </div>
      {miniVisualizationSlot ? <div className="widget-shell-mini">{miniVisualizationSlot}</div> : null}
      {actionSlot ? <div className="widget-shell-actions" onClick={(event) => event.stopPropagation()}>{actionSlot}</div> : null}
    </div>
  );
}
