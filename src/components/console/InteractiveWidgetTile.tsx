"use client";

import { type KeyboardEvent, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { WidgetStatus } from "@/lib/widgets/types";
import { WidgetStatusBadge } from "@/components/widgets/WidgetStatusBadge";
import { WIDGET_MOTION, widgetMotionMode } from "@/components/widgets/widgetMotion";
import { WidgetMiniViz } from "@/components/console/WidgetMiniViz";

type Props = {
  widgetId: string;
  label: string;
  value: string;
  hint: string;
  status: WidgetStatus;
  expanded: boolean;
  editing: boolean;
  loading?: boolean;
  stale?: boolean;
  error?: boolean;
  raw?: Record<string, unknown>;
  icon: ReactNode;
  iconStyle: { background: string; color: string };
  statusLabel: string;
  activationLabel?: string;
  onPrimaryAction: () => void;
  onDoubleClickAction?: () => void;
  onSwap?: () => void;
  onValueBlur: (value: string) => void;
  onHintBlur: (hint: string) => void;
  secondLine?: ReactNode;
};

export function InteractiveWidgetTile({
  widgetId,
  label,
  value,
  hint,
  status,
  expanded,
  editing,
  loading,
  stale,
  error,
  raw,
  icon,
  iconStyle,
  statusLabel,
  activationLabel,
  onPrimaryAction,
  onDoubleClickAction,
  onSwap,
  onValueBlur,
  onHintBlur,
  secondLine,
}: Props) {
  const reduceMotion = useReducedMotion();
  const motionMode = widgetMotionMode(reduceMotion);
  const motionEnabled = motionMode === "standard" && !editing;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onPrimaryAction();
    }
  };

  return (
    <motion.div
      className={`tb widget-tile-interactive${expanded ? " is-expanded" : ""}`}
      role={editing ? undefined : "button"}
      tabIndex={editing ? undefined : 0}
      aria-label={activationLabel ?? (expanded ? `Collapse ${label}` : `Expand ${label}`)}
      data-status={status}
      data-loading={loading ? "true" : undefined}
      data-stale={stale ? "true" : undefined}
      data-error={error ? "true" : undefined}
      onClick={editing ? undefined : onPrimaryAction}
      onDoubleClick={editing ? undefined : (e) => { e.stopPropagation(); onDoubleClickAction?.(); }}
      onKeyDown={handleKeyDown}
      layout={motionEnabled ? "position" : false}
      initial={motionEnabled ? { opacity: 0, y: 6 } : false}
      animate={motionEnabled ? { opacity: 1, y: 0 } : undefined}
      whileHover={motionEnabled ? { y: -2, scale: 1.01 } : undefined}
      whileTap={motionEnabled ? { scale: 0.99 } : undefined}
      transition={WIDGET_MOTION.shellEntry}
    >
      {editing && onSwap && (
        <button
          type="button"
          className="widget-tile-swap"
          onClick={(e) => { e.stopPropagation(); onSwap(); }}
        >
          ⇄
        </button>
      )}
      <div className="tb-ic" style={iconStyle}>{icon}</div>
      <div className="widget-tile-body">
        <div className="widget-tile-topline">
          <span className="widget-tile-label">{label}</span>
          <WidgetStatusBadge status={status} />
        </div>
        <motion.div
          key={`${status}-${value}`}
          className="tb-v widget-tile-value"
          contentEditable={editing}
          suppressContentEditableWarning
          onBlur={(e) => onValueBlur(e.currentTarget.textContent || value)}
          initial={motionEnabled ? { opacity: 0.75, y: 2 } : false}
          animate={motionEnabled ? { opacity: 1, y: 0 } : undefined}
          transition={WIDGET_MOTION.valueEntry}
        >
          {value}
          {!editing && <span className="widget-tile-status-label">· {statusLabel}</span>}
        </motion.div>
        <div
          className="tb-k"
          contentEditable={editing}
          suppressContentEditableWarning
          onBlur={(e) => onHintBlur(e.currentTarget.textContent || hint)}
        >
          {expanded ? `${hint} · tap to collapse` : hint}
        </div>
        {expanded && !editing && secondLine}
        {!editing && loading && (
          <div className="tb-raw">Refreshing…</div>
        )}
        {!editing && error && (
          <div className="tb-raw widget-tile-error">
            {stale ? "Showing last update · tap to retry details" : "Refresh failed · double-click to retry"}
          </div>
        )}
      </div>
      {!editing && (
        <div className="widget-tile-mini">
          <WidgetMiniViz widgetId={widgetId} raw={raw} />
        </div>
      )}
    </motion.div>
  );
}
