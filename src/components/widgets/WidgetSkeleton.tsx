type Props = {
  variant?: "compact" | "wide";
  className?: string;
};

export function WidgetSkeleton({ variant = "compact", className = "" }: Props) {
  return (
    <div
      className={`widget-skeleton widget-skeleton-${variant} ${className}`.trim()}
      aria-hidden="true"
    >
      <div className="widget-skeleton-icon" />
      <div className="widget-skeleton-body">
        <div className="widget-skeleton-line widget-skeleton-line-short" />
        <div className="widget-skeleton-line widget-skeleton-line-value" />
        <div className="widget-skeleton-line widget-skeleton-line-hint" />
      </div>
    </div>
  );
}
