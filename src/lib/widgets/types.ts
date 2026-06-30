import type { ReactNode } from "react";

export type WidgetStatus =
  | "fresh"
  | "live"
  | "loading"
  | "refreshing"
  | "stale"
  | "error"
  | "empty"
  | "disconnected"
  | "setup_required"
  | "lab"
  | "disabled";

export type WidgetFreshness = {
  fetchedAt?: string;
  cachedAt?: string;
  staleAfterSeconds: number;
  refreshPolicy: "manual" | "interval" | "background" | "on-focus";
};

export type WidgetAction = {
  id: string;
  label: string;
  kind: "refresh" | "navigate" | "open-drawer" | "create" | "configure" | "hide";
  href?: string;
  destructive?: boolean;
  disabledReason?: string;
};

export type WidgetDataSource = {
  provider:
    | "supabase"
    | "open-meteo"
    | "polygon"
    | "massive"
    | "strava"
    | "spotify"
    | "composio"
    | "browser"
    | "local"
    | "manual"
    | "none";
  endpoint?: string;
  cacheKey: string;
  requiresAuth: boolean;
  requiresLocation?: boolean;
  requiresConnection?: string;
};

export type WidgetDetailConfig = {
  type: "drawer" | "route" | "none";
  title: string;
  route?: string;
  sections?: string[];
};

export type WidgetDefinition<TData = unknown> = {
  id: string;
  label: string;
  category: string;
  ownerModule: string;
  icon: ReactNode;
  statusDefault: WidgetStatus;
  source: WidgetDataSource;
  freshness: WidgetFreshness;
  primaryAction: WidgetAction;
  secondaryActions: WidgetAction[];
  detail: WidgetDetailConfig;
  renderModes: Array<"compact" | "wide" | "full" | "drawer">;
  sentryArea: string;
  parse?: (data: unknown) => TData;
};

export type WidgetRuntimeState<TData = unknown> = {
  definition: WidgetDefinition<TData>;
  status: WidgetStatus;
  value: string;
  hint: string;
  data?: TData;
  error?: { code: string; message: string; retryable: boolean };
  freshness: WidgetFreshness;
  fallback?: boolean;
};
