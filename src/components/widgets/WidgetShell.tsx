"use client";

import type { KeyboardEvent, ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
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
  loading,
  stale,
  error,
  lab,
  disconnected,
  onPrimaryAction,
  titleText,
  actionSlot,
  miniVisualizationSlot,
  children,
}: Props) {
  const interactive = Boolean(onPrimaryAction);
  const updated = formatUpdatedAt(updatedAt);
  const reduceMotion = useReducedMotion();
  const motionEnabled = !reduceMotion;
  const stateKey = `${status}-${updatedAt ?? "never"}-${typeof value === "string" ? value : "node"}`;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onPrimaryAction?.();
  };

  return (
    <motion.div
      className={`widget-shell${interactive ? " widget-shell-interactive" : ""}`}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onPrimaryAction}
      onKeyDown={handleKeyDown}
      title={titleText}
      aria-label={interactive ? `${title}: ${typeof value === "string" ? value : "open details"}` : undefined}
      data-status={status}
      data-loading={loading ? "true" : undefined}
      data-stale={stale ? "true" : undefined}
      data-error={error ? "true" : undefined}
      data-lab={lab ? "true" : undefined}
      data-disconnected={disconnected ? "true" : undefined}
      layout={motionEnabled ? "position" : false}
      initial={motionEnabled ? { opacity: 0, y: 4 } : false}
      animate={motionEnabled ? { opacity: 1, y: 0 } : undefined}
      whileHover={motionEnabled && interactive ? { y: -1 } : undefined}
      whileTap={motionEnabled && interactive ? { scale: 0.995 } : undefined}
      transition={{ duration: 0.16, ease: "easeOut" }}
    >
      <motion.div
        className="widget-shell-icon"
        animate={motionEnabled && (status === "loading" || status === "refreshing") ? { rotate: 360 } : { rotate: 0 }}
        transition={{ duration: 1.2, ease: "linear", repeat: motionEnabled && (status === "loading" || status === "refreshing") ? Infinity : 0 }}
      >
        {icon}
      </motion.div>
      <div className="widget-shell-body">
        <div className="widget-shell-topline">
          <span className="widget-shell-title">{title}</span>
          <WidgetStatusBadge status={status} />
        </div>
        <motion.div
          key={stateKey}
          className="widget-shell-value"
          initial={motionEnabled ? { opacity: 0.72, y: status === "fresh" || status === "live" ? 3 : 0 } : false}
          animate={motionEnabled ? { opacity: 1, y: 0 } : undefined}
          transition={{ duration: 0.2, ease: "easeOut" }}
        >
          {value}
        </motion.div>
        {hint ? <div className="widget-shell-hint">{hint}</div> : null}
        {children}
        <div className="widget-shell-meta">
          {provider ? <span>{provider}</span> : source ? <span>{source}</span> : null}
          {updated ? <span>Updated {updated}</span> : null}
        </div>
      </div>
      {miniVisualizationSlot ? <div className="widget-shell-mini">{miniVisualizationSlot}</div> : null}
      {actionSlot ? <div className="widget-shell-actions" onClick={(event) => event.stopPropagation()}>{actionSlot}</div> : null}
    </motion.div>
  );
}
