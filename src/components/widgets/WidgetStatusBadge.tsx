"use client";

import { motion, useReducedMotion } from "motion/react";
import { Icon } from "@/components/ui/Icon";
import { statusIconForWidget } from "@/lib/icons/status-icons";
import type { WidgetStatus } from "@/lib/widgets/types";
import { shouldAnimateWidgetStatus, WIDGET_MOTION, widgetMotionMode } from "@/components/widgets/widgetMotion";

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
  const motionMode = widgetMotionMode(reduceMotion);
  const shouldPulse = shouldAnimateWidgetStatus(status, motionMode);
  const transition = status === "error" ? WIDGET_MOTION.statusErrorPulse : WIDGET_MOTION.statusPulse;

  return (
    <motion.span
      key={status}
      className={`widget-status-badge widget-status-${status} ${className}`.trim()}
      data-status={status}
      data-motion={motionMode}
      aria-label={`Widget status: ${WIDGET_STATUS_LABELS[status]}`}
      initial={motionMode === "reduced" ? false : { opacity: 0.72 }}
      animate={shouldPulse ? { opacity: [0.78, 1, 0.78] } : { opacity: 1 }}
      transition={{ ...transition, repeat: shouldPulse ? Infinity : 0 }}
    >
      <Icon
        icon={statusIconForWidget(status)}
        size="xs"
        className={`inline mr-1 align-[-2px]${status === "loading" || status === "refreshing" ? " animate-spin" : ""}`}
        aria-hidden
      />
      {WIDGET_STATUS_LABELS[status]}
    </motion.span>
  );
}
