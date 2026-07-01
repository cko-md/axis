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
      <div className="widget-skeleton-icon" aria-hidden="true" />
      <div className="widget-skeleton-body" aria-hidden="true">
        <div className="widget-skeleton-line widget-skeleton-line-short" />
        <div className="widget-skeleton-line widget-skeleton-line-value" />
        <div className="widget-skeleton-line widget-skeleton-line-hint" />
      </div>
    </div>
  );
}
