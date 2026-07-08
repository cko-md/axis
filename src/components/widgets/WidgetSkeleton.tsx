import { AxisLoadingSheen } from "@/components/ui/axis/AxisLoadingSheen";

type Props = {
  variant?: "compact" | "wide";
  className?: string;
  label?: string;
};

export function WidgetSkeleton({ variant = "compact", className = "", label = "Loading widget" }: Props) {
  return (
    <div
      className={`widget-skeleton widget-skeleton-${variant} ${className}`.trim()}
      role="status"
      aria-label={label}
      aria-live="polite"
    >
      <AxisLoadingSheen
        className="widget-skeleton-icon"
        width={28}
        height={28}
        borderRadius="var(--r)"
      />
      <div className="widget-skeleton-body" aria-hidden="true">
        <AxisLoadingSheen className="widget-skeleton-line widget-skeleton-line-short" height={9} />
        <AxisLoadingSheen className="widget-skeleton-line widget-skeleton-line-value" height={12} />
        <AxisLoadingSheen className="widget-skeleton-line widget-skeleton-line-hint" height={9} />
      </div>
    </div>
  );
}
