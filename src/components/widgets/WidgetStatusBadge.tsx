"use client";

import { motion, useReducedMotion } from "motion/react";
import type { WidgetStatus } from "@/lib/widgets/types";

export const WIDGET_STATUS_LABELS: Record<WidgetStatus, string> = {
  fresh: "Fresh",
  live: "Live",
  loading: "Loading",
  refreshing: "Refreshing",
  stale: "Stale",
  error: "Error",
  empty: "Empty",
  disconnected: "Disconnected",
  setup_required: "Setup required",
  lab: "Lab",
  disabled: "Disabled",
};

type Props = {
  status: WidgetStatus;
  className?: string;
};

export function widgetStatusLabel(status: WidgetStatus) {
  return WIDGET_STATUS_LABELS[status];
}

export function WidgetStatusBadge({ status, className = "" }: Props) {
  const reduceMotion = useReducedMotion();
  const shouldPulse = !reduceMotion && (status === "refreshing" || status === "loading" || status === "error");

  return (
    <motion.span
      key={status}
      className={`widget-status-badge widget-status-${status} ${className}`.trim()}
      data-status={status}
      aria-label={`Widget status: ${WIDGET_STATUS_LABELS[status]}`}
      initial={reduceMotion ? false : { opacity: 0.72 }}
      animate={shouldPulse ? { opacity: [0.78, 1, 0.78] } : { opacity: 1 }}
      transition={{ duration: status === "error" ? 1.3 : 1, repeat: shouldPulse ? Infinity : 0, ease: "easeInOut" }}
    >
      {WIDGET_STATUS_LABELS[status]}
    </motion.span>
  );
}
