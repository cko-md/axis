import type { WidgetDataSource, WidgetStatus } from "@/lib/widgets/types";

export const maxWidgetsPerBatch = 24;

export type WidgetPayload = {
  value?: string;
  hint?: string;
  raw?: Record<string, unknown>;
  fallback?: boolean;
  error?: boolean;
  partial?: boolean;
};

export type BatchWidgetError = {
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
};

export function dedupeWidgetIds(ids: string[]) {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(0, maxWidgetsPerBatch);
}

export function statusForWidgetPayload(payload: WidgetPayload, defaultStatus: WidgetStatus): WidgetStatus {
  if (payload.error) return "error";
  if (payload.partial) return "stale";
  if (payload.fallback) return defaultStatus;
  return "fresh";
}

export function widgetProviderTimeoutMs(provider: WidgetDataSource["provider"]) {
  if (provider === "open-meteo") return 4_500;
  if (provider === "polygon" || provider === "massive" || provider === "strava") return 5_500;
  if (provider === "supabase") return 3_000;
  return 2_000;
}

export function safeWidgetBatchError(
  code: string,
  message: string,
  retryable: boolean,
  status?: number,
): BatchWidgetError {
  return { code, message, retryable, ...(status !== undefined ? { status } : {}) };
}
