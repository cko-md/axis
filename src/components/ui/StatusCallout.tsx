import type { ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { statusIconForCallout } from "@/lib/icons/status-icons";

export type StatusCalloutKind =
  | "loading"
  | "empty"
  | "error"
  | "stale"
  | "disconnected"
  | "setup_required"
  | "success"
  | "info";

type Props = {
  kind: StatusCalloutKind;
  title?: ReactNode;
  children: ReactNode;
  actionSlot?: ReactNode;
  className?: string;
};

export const STATUS_CALLOUT_LABELS: Record<StatusCalloutKind, string> = {
  loading: "Loading",
  empty: "Empty",
  error: "Error",
  stale: "Stale",
  disconnected: "Disconnected",
  setup_required: "Setup required",
  success: "Success",
  info: "Info",
};

export function statusCalloutRole(kind: StatusCalloutKind) {
  return kind === "error" ? "alert" : "status";
}

export function StatusCallout({ kind, title, children, actionSlot, className = "" }: Props) {
  const label = STATUS_CALLOUT_LABELS[kind];

  return (
    <div
      className={`status-callout status-callout-${kind} ${className}`.trim()}
      role={statusCalloutRole(kind)}
      aria-label={typeof title === "string" ? title : label}
      data-kind={kind}
    >
      <div className="status-callout-body">
        <div className="status-callout-label">
          <Icon icon={statusIconForCallout(kind)} size="xs" className="inline mr-1.5 align-[-2px]" aria-hidden />
          {label}
        </div>
        {title ? <strong>{title}</strong> : null}
        <div className="status-callout-message">{children}</div>
      </div>
      {actionSlot ? <div className="status-callout-action">{actionSlot}</div> : null}
    </div>
  );
}
