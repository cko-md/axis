"use client";

import { useId, type KeyboardEvent, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { WidgetStatus } from "@/lib/widgets/types";
import { WidgetStatusBadge } from "@/components/widgets/WidgetStatusBadge";
import { shouldSpinWidgetIcon, WIDGET_MOTION, widgetMotionMode } from "@/components/widgets/widgetMotion";

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

export function widgetShellAriaLabel(title: string, value: ReactNode) {
  return `${title}: ${typeof value === "string" ? value : "open details"}`;
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
  const hintId = useId();
  const metaId = useId();
  const interactive = Boolean(onPrimaryAction);
  const updated = formatUpdatedAt(updatedAt);
  const reduceMotion = useReducedMotion();
  const motionMode = widgetMotionMode(reduceMotion);
  const motionEnabled = motionMode === "standard";
  const spinIcon = shouldSpinWidgetIcon(status, motionMode);
  const stateKey = `${status}-${updatedAt ?? "never"}-${typeof value === "string" ? value : "node"}`;
  const describedBy = [
    hint ? hintId : null,
    provider || source || updated ? metaId : null,
  ].filter(Boolean).join(" ") || undefined;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onPrimaryAction?.();
  };

  return (
    <motion.div
      className={`widget-shell${interactive ? " widget-shell-interactive" : ""}`}
      role={interactive ? "button" : "group"}
      tabIndex={interactive ? 0 : undefined}
      onClick={onPrimaryAction}
      onKeyDown={handleKeyDown}
      title={titleText}
      aria-label={widgetShellAriaLabel(title, value)}
      aria-describedby={describedBy}
      aria-busy={loading ? "true" : undefined}
      aria-invalid={error ? "true" : undefined}
      data-status={status}
      data-loading={loading ? "true" : undefined}
      data-stale={stale ? "true" : undefined}
      data-error={error ? "true" : undefined}
      data-lab={lab ? "true" : undefined}
      data-disconnected={disconnected ? "true" : undefined}
      data-motion={motionMode}
      layout={motionEnabled ? "position" : false}
      initial={motionEnabled ? { opacity: 0, y: 4 } : false}
      animate={motionEnabled ? { opacity: 1, y: 0 } : undefined}
      whileHover={motionEnabled && interactive ? { y: -1 } : undefined}
      whileTap={motionEnabled && interactive ? { scale: 0.995 } : undefined}
      transition={WIDGET_MOTION.shellEntry}
    >
      <motion.div
        className="widget-shell-icon"
        animate={spinIcon ? { rotate: 360 } : { rotate: 0 }}
        transition={{ ...WIDGET_MOTION.iconRefresh, repeat: spinIcon ? Infinity : 0 }}
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
          transition={WIDGET_MOTION.valueEntry}
        >
          {value}
        </motion.div>
        {hint ? <div id={hintId} className="widget-shell-hint">{hint}</div> : null}
        {children}
        <div id={metaId} className="widget-shell-meta">
          {provider ? <span>{provider}</span> : source ? <span>{source}</span> : null}
          {updated ? <span>Updated {updated}</span> : null}
        </div>
      </div>
      {miniVisualizationSlot ? <div className="widget-shell-mini">{miniVisualizationSlot}</div> : null}
      {actionSlot ? <div className="widget-shell-actions" onClick={(event) => event.stopPropagation()}>{actionSlot}</div> : null}
    </motion.div>
  );
}
