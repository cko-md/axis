import type { WidgetStatus } from "@/lib/widgets/types";

export type WidgetMotionMode = "standard" | "reduced";

export const WIDGET_MOTION = {
  shellEntry: { duration: 0.16, ease: "easeOut" },
  valueEntry: { duration: 0.2, ease: "easeOut" },
  iconRefresh: { duration: 1.2, ease: "linear" },
  statusPulse: { duration: 1, ease: "easeInOut" },
  statusErrorPulse: { duration: 1.3, ease: "easeInOut" },
  drawerBackdrop: { duration: 0.16, ease: "easeOut" },
  drawerPanel: { duration: 0.22, ease: [0.2, 0.8, 0.2, 1] },
} as const;

export function widgetMotionMode(prefersReducedMotion: boolean | null): WidgetMotionMode {
  return prefersReducedMotion ? "reduced" : "standard";
}

export function shouldAnimateWidgetStatus(status: WidgetStatus, mode: WidgetMotionMode) {
  return mode === "standard" && (status === "refreshing" || status === "loading" || status === "error");
}

export function shouldSpinWidgetIcon(status: WidgetStatus, mode: WidgetMotionMode) {
  return mode === "standard" && (status === "loading" || status === "refreshing");
}
