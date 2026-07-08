import type { LucideIcon } from "lucide-react";
import {
  AlertCircle,
  Ban,
  CircleDot,
  Clock,
  FlaskConical,
  Info,
  Loader2,
  PlugZap,
  Unplug,
} from "lucide-react";
import type { StatusCalloutKind } from "@/components/ui/StatusCallout";
import type { WidgetStatus } from "@/lib/widgets/types";

/** Semantic status glyphs — stroke 1.6, token-colored via currentColor. */
export const STATUS_ICON_MAP: Record<string, LucideIcon> = {
  live: CircleDot,
  fresh: CircleDot,
  loading: Loader2,
  refreshing: Loader2,
  stale: Clock,
  error: AlertCircle,
  lab: FlaskConical,
  disconnected: Unplug,
  setup_required: PlugZap,
  empty: Info,
  disabled: Ban,
  info: Info,
};

export function statusIconForWidget(status: WidgetStatus): LucideIcon {
  switch (status) {
    case "fresh":
    case "live":
      return CircleDot;
    case "loading":
    case "refreshing":
      return Loader2;
    case "stale":
      return Clock;
    case "error":
      return AlertCircle;
    case "lab":
      return FlaskConical;
    case "disconnected":
      return Unplug;
    case "setup_required":
      return PlugZap;
    case "empty":
      return Info;
    case "disabled":
      return Ban;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function statusIconForCallout(kind: StatusCalloutKind): LucideIcon {
  switch (kind) {
    case "loading":
      return Loader2;
    case "empty":
      return Info;
    case "error":
      return AlertCircle;
    case "stale":
      return Clock;
    case "disconnected":
      return Unplug;
    case "setup_required":
      return PlugZap;
    case "success":
      return CircleDot;
    case "info":
      return Info;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}
