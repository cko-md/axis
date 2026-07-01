import type { WidgetDataSource } from "@/lib/widgets/types";

export type WidgetProviderFailureMeta = {
  widget: string;
  provider: WidgetDataSource["provider"];
  status?: number;
  code: string;
};

export function widgetEndpointErrorCode(status: number) {
  return status === 401 ? "UNAUTHORIZED" : "WIDGET_ENDPOINT_FAILED";
}

export function shouldCaptureWidgetEndpointStatus(status: number) {
  return status >= 500;
}

export function widgetProviderFailureTags(meta: WidgetProviderFailureMeta) {
  return {
    widget: meta.widget,
    provider: meta.provider,
    code: meta.code,
    ...(meta.status !== undefined ? { status: String(meta.status) } : {}),
  };
}
