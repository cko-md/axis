"use client";

import { Fragment } from "react";
import { useRouter } from "next/navigation";
import { getWidgetById } from "@/lib/store/widgets";
import type { WidgetData } from "@/lib/hooks/useWidgetData";
import { WidgetActionMenu, WidgetDetailDrawer, WidgetShell } from "@/components/widgets";
import { StatusCallout } from "@/components/ui/StatusCallout";
import { getWidgetDefinition } from "@/lib/widgets/registry";
import { resolveWidgetTileActivation, widgetLegacyStatusLabel, widgetRuntimeStatus } from "@/components/console/widget-grid-model";
import { InteractiveWidgetTile } from "@/components/console/InteractiveWidgetTile";
import { WidgetMiniViz } from "@/components/console/WidgetMiniViz";

type WidgetTexts = Record<string, { v: string; k: string }>;

type Props = {
  widgetIds: string[];
  widgetTexts: WidgetTexts;
  liveData: Record<string, WidgetData>;
  editing: boolean;
  expandedWidget: string | null;
  detailWidgetId: string | null;
  onEditingChange: (editing: boolean | ((editing: boolean) => boolean)) => void;
  onExpandedWidgetChange: (widgetId: string | null) => void;
  onDetailWidgetChange: (widgetId: string | null) => void;
  onWidgetTextsChange: (texts: WidgetTexts) => void;
  onSwapIndexChange: (index: number | null) => void;
  onPickerOpenChange: (open: boolean) => void;
  onSave: (ids: string[], texts: WidgetTexts) => void | Promise<void>;
  onRefreshOne: (id: string) => void | Promise<void>;
  onRefreshAll: () => void | Promise<void>;
  onToast: (message: string, tone?: "success" | "error" | "warn" | "info", title?: string) => void;
};

const W = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...props} />
);

const WIDGET_ICONS: Record<string, React.ReactNode> = {
  weather: <W><circle cx="8" cy="8" r="2.8"/><line x1="8" y1="1.5" x2="8" y2="3"/><line x1="8" y1="13" x2="8" y2="14.5"/><line x1="1.5" y1="8" x2="3" y2="8"/><line x1="13" y1="8" x2="14.5" y2="8"/><line x1="3.4" y1="3.4" x2="4.4" y2="4.4"/><line x1="11.6" y1="11.6" x2="12.6" y2="12.6"/><line x1="3.4" y1="12.6" x2="4.4" y2="11.6"/><line x1="11.6" y1="4.4" x2="12.6" y2="3.4"/></W>,
  daylight: <W><path d="M2 11 a6 6 0 0 1 12 0"/><line x1="8" y1="2.5" x2="8" y2="4"/><line x1="2.4" y1="7" x2="3.7" y2="7.7"/><line x1="13.6" y1="7" x2="12.3" y2="7.7"/><line x1="1" y1="11" x2="15" y2="11"/></W>,
  air: <W><path d="M2 5.5 h7 a2.5 2.5 0 0 1 0 5"/><path d="M2 8.5 h5 a2 2 0 0 1 0 4"/><line x1="2" y1="11.5" x2="5" y2="11.5"/></W>,
  agenda: <W strokeWidth="1.3"><rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><line x1="2.5" y1="7" x2="13.5" y2="7"/><line x1="5.5" y1="2" x2="5.5" y2="5"/><line x1="10.5" y1="2" x2="10.5" y2="5"/><rect x="5" y="9" width="2" height="2" rx="0.5" fill="currentColor" stroke="none"/><rect x="9" y="9" width="2" height="2" rx="0.5" fill="currentColor" stroke="none"/></W>,
  markets: <W><polyline points="2,12 5.5,8.5 8.5,10 13.5,4.5"/><polyline points="10.5,4.5 13.5,4.5 13.5,7.5"/></W>,
  run: <W><polyline points="9.5,2 5,9 8.5,9 6.5,14 12,7 8.5,7"/></W>,
  sleep: <W><path d="M12.5 11.5 A5.5 5.5 0 1 1 4.5 3.5 A4 4 0 0 0 12.5 11.5Z"/></W>,
  hrv: <W><polyline points="1,8 4,8 5.5,5 7,11 8.5,6.5 10,9.5 11.5,8 15,8"/></W>,
  heartrate: <W><path d="M8 13 C6 11 2 8.5 2 5.5 A3 3 0 0 1 8 4.2 A3 3 0 0 1 14 5.5 C14 8.5 10 11 8 13Z"/></W>,
  vo2max: <W><path d="M8 4 v8"/><path d="M8 6.5 C8 6.5 4.5 6.5 4.5 9.5 C4.5 11.5 6 12.5 8 11.5"/><path d="M8 6.5 C8 6.5 11.5 6.5 11.5 9.5 C11.5 11.5 10 12.5 8 11.5"/></W>,
  hydration: <W><path d="M8 2 C8 2 3.5 8 3.5 11 A4.5 4.5 0 0 0 12.5 11 C12.5 8 8 2 8 2Z"/><line x1="6" y1="11" x2="7" y2="9" strokeWidth="1" opacity="0.7"/></W>,
  location: <W><path d="M8 1.5 A4 4 0 0 1 12 5.5 C12 9 8 14.5 8 14.5 C8 14.5 4 9 4 5.5 A4 4 0 0 1 8 1.5Z"/><circle cx="8" cy="5.5" r="1.5" fill="currentColor" stroke="none"/></W>,
};

function WidgetIcon({ id }: { id: string }) {
  return WIDGET_ICONS[id] ?? WIDGET_ICONS.agenda;
}

function widgetIconStyle(id: string, raw?: Record<string, unknown>): { background: string; color: string } {
  if (id === "air") {
    const aqi = (raw?.aqi as number) ?? 0;
    if (aqi <= 50) return { background: "color-mix(in srgb, #7fa86a 14%, transparent)", color: "var(--sage, #7fa86a)" };
    if (aqi <= 100) return { background: "color-mix(in srgb, #c9a463 14%, transparent)", color: "var(--gold-2)" };
    return { background: "color-mix(in srgb, #c2603f 14%, transparent)", color: "var(--clay, #c2603f)" };
  }
  if (id === "markets") {
    const chg = (raw?.chg as number) ?? 0;
    if (chg > 0) return { background: "color-mix(in srgb, #7fa86a 12%, transparent)", color: "var(--up)" };
    if (chg < 0) return { background: "color-mix(in srgb, #c2603f 12%, transparent)", color: "var(--down)" };
  }
  return { background: "color-mix(in srgb, var(--gold) 12%, transparent)", color: "var(--gold-2)" };
}

function WidgetSecondLine({ id, raw }: { id: string; raw?: Record<string, unknown> }) {
  if (!raw) return null;
  if (id === "weather" && raw.humidity !== undefined) {
    return <div className="tb-raw">Humidity {String(raw.humidity)}%</div>;
  }
  if (id === "air" && raw.uv !== undefined) {
    const aqi = raw.aqi as number;
    const label = aqi <= 50 ? "Good" : aqi <= 100 ? "Moderate" : "Poor";
    return <div className="tb-raw">AQI {aqi} · UV {String(raw.uv)} · {label}</div>;
  }
  if (id === "markets" && raw.chg !== undefined) {
    const sign = (raw.chg as number) >= 0 ? "▴" : "▾";
    return <div className="tb-raw">SPY {sign}{Math.abs(raw.chg as number).toFixed(2)}%</div>;
  }
  if (id === "run" && raw.km !== undefined) {
    return <div className="tb-raw">{String(raw.km)} km this week · {Number(raw.streak) > 0 ? `${raw.streak}-day streak` : "no active streak"}</div>;
  }
  return null;
}

export function WidgetGrid({
  widgetIds,
  widgetTexts,
  liveData,
  editing,
  expandedWidget,
  detailWidgetId,
  onEditingChange,
  onExpandedWidgetChange,
  onDetailWidgetChange,
  onWidgetTextsChange,
  onSwapIndexChange,
  onPickerOpenChange,
  onSave,
  onRefreshOne,
  onRefreshAll,
  onToast,
}: Props) {
  const router = useRouter();

  return (
    <div style={{ paddingTop: 4 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4, marginBottom: "var(--space-2)" }}>
        <button type="button" className="feed-manage" onClick={() => { onRefreshAll(); }}>Refresh</button>
        <button
          type="button"
          className="feed-manage"
          onClick={() => {
            if (editing) onSave(widgetIds, widgetTexts);
            onEditingChange((current) => !current);
          }}
        >
          {editing ? "Done" : "Customize"}
        </button>
      </div>
      <div className="tidbits">
        {widgetIds.length === 0 ? (
          <StatusCallout kind="empty" title="No widgets yet">
            Customize your Command strip to add live weather, agenda, training, and market tiles.
          </StatusCallout>
        ) : null}
        {widgetIds.map((id, i) => {
          const w = getWidgetById(id);
          const definition = getWidgetDefinition(id);
          const live = liveData[id];
          const texts = widgetTexts[id];
          const value = editing ? (texts?.v ?? live?.v ?? w.value) : (live?.v ?? texts?.v ?? w.value);
          const hint = editing ? (texts?.k ?? live?.k ?? w.hint) : (live?.k ?? texts?.k ?? w.hint);
          const status = widgetRuntimeStatus(id, live, w.live);
          const shellIcon = definition?.icon ?? <WidgetIcon id={id} />;
          const primaryAction = definition?.primaryAction;
          if (primaryAction?.kind === "open-drawer") {
            const drawerOpen = detailWidgetId === id;
            return (
              <Fragment key={`${id}-${i}`}>
                <WidgetShell
                  title={definition?.label ?? w.label}
                  icon={shellIcon}
                  value={value}
                  hint={drawerOpen ? `${hint} · details open` : hint}
                  status={status}
                  updatedAt={live?.updatedAt}
                  provider={definition?.source.provider ?? "widget"}
                  loading={live?.loading}
                  stale={live?.stale}
                  error={live?.error}
                  lab={status === "lab"}
                  disconnected={status === "disconnected"}
                  miniVisualizationSlot={<WidgetMiniViz widgetId={id} raw={live?.raw} />}
                  onPrimaryAction={editing ? undefined : () => onDetailWidgetChange(id)}
                  titleText={drawerOpen ? "Details open" : "Open widget details"}
                  actionSlot={
                    <WidgetActionMenu
                      actions={editing ? [
                        { id: "swap", label: "Swap", kind: "configure" },
                        { id: "hide", label: "Hide placeholder", kind: "hide", disabledReason: "Hide arrives with saved widget preferences." },
                      ] : [
                        ...(definition?.secondaryActions ?? []),
                        definition?.primaryAction ?? { id: "open", label: "Open", kind: "open-drawer" },
                        { id: "configure", label: "Configure placeholder", kind: "configure", disabledReason: "Configuration arrives with widget settings." },
                        { id: "hide", label: "Hide placeholder", kind: "hide", disabledReason: "Hide arrives with saved widget preferences." },
                      ]}
                      handlers={{
                        refresh: () => {
                          onRefreshOne(id);
                          onToast("Widget refreshed", "success", w.label);
                        },
                        open: () => onDetailWidgetChange(id),
                        configure: () => {
                          if (editing) {
                            onSwapIndexChange(i);
                            onPickerOpenChange(true);
                          }
                        },
                      }}
                    />
                  }
                >
                  {!editing && live?.error && (
                    <div className="tb-raw" style={{ color: "var(--clay)" }}>
                      {live.stale ? "Showing last update" : "Refresh failed"}
                    </div>
                  )}
                </WidgetShell>
                <WidgetDetailDrawer
                  open={drawerOpen}
                  onClose={() => onDetailWidgetChange(null)}
                  title={definition?.detail.title ?? definition?.label ?? w.label}
                  subtitle={hint}
                  status={status}
                  source={definition?.source.provider ?? "widget"}
                  updatedAt={live?.updatedAt}
                  primaryActionSlot={
                    <button
                      type="button"
                      className="feed-manage"
                      onClick={() => {
                        onRefreshOne(id);
                        onToast("Widget refreshed", "success", w.label);
                      }}
                    >
                      Refresh
                    </button>
                  }
                >
                  <div className="widget-detail-current">
                    <span>Current value</span>
                    <strong>{value}</strong>
                  </div>
                  {live?.error ? (
                    <StatusCallout kind={live.stale ? "stale" : "error"} className="widget-detail-error">
                      {live.stale ? "The drawer is showing the last known widget state." : "The latest widget refresh failed."}
                    </StatusCallout>
                  ) : null}
                </WidgetDetailDrawer>
              </Fragment>
            );
          }
          const label = widgetLegacyStatusLabel(status);
          const activation = resolveWidgetTileActivation(id);
          const routeHref = activation?.kind === "navigate" ? activation.href : undefined;
          const handlePrimaryAction = () => {
            if (editing) return;
            if (routeHref) {
              router.push(routeHref);
              return;
            }
            onExpandedWidgetChange(expandedWidget === id ? null : id);
          };
          return (
            <InteractiveWidgetTile
              key={`${id}-${i}`}
              widgetId={id}
              label={w.label}
              value={value}
              hint={hint}
              status={status}
              expanded={expandedWidget === id}
              editing={editing}
              loading={live?.loading}
              stale={live?.stale}
              error={live?.error}
              raw={live?.raw}
              icon={<WidgetIcon id={id} />}
              iconStyle={widgetIconStyle(id, live?.raw)}
              statusLabel={label}
              activationLabel={routeHref ? activation?.label : expandedWidget === id ? `Collapse ${w.label}` : `Expand ${w.label}`}
              onPrimaryAction={handlePrimaryAction}
              onDoubleClickAction={() => {
                onRefreshOne(id);
                onToast("Widget refreshed", "success", w.label);
              }}
              onSwap={editing ? () => { onSwapIndexChange(i); onPickerOpenChange(true); } : undefined}
              onValueBlur={(nextValue) => {
                onWidgetTextsChange({ ...widgetTexts, [id]: { v: nextValue, k: hint } });
              }}
              onHintBlur={(nextHint) => {
                onWidgetTextsChange({ ...widgetTexts, [id]: { v: value, k: nextHint } });
              }}
              secondLine={<WidgetSecondLine id={id} raw={live?.raw} />}
            />
          );
        })}
      </div>
    </div>
  );
}
