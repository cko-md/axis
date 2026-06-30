import type { WidgetStatus } from "@/lib/widgets/types";

const STATUS_LABELS: Record<WidgetStatus, string> = {
  fresh: "Fresh",
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
  return STATUS_LABELS[status];
}

export function WidgetStatusBadge({ status, className = "" }: Props) {
  return (
    <span className={`widget-status-badge widget-status-${status} ${className}`.trim()}>
      {STATUS_LABELS[status]}
    </span>
  );
}
