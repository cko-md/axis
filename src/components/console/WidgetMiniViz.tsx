"use client";

type Props = {
  widgetId: string;
  raw?: Record<string, unknown>;
};

function MarketsBar({ chg }: { chg: number }) {
  const width = Math.min(100, Math.abs(chg) * 20);
  const positive = chg >= 0;
  return (
    <div className="widget-mini-viz widget-mini-viz--bar" aria-hidden>
      <div
        className={`widget-mini-viz__fill${positive ? " up" : " down"}`}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

function AqiGauge({ aqi }: { aqi: number }) {
  const ratio = Math.min(1, Math.max(0, aqi / 150));
  const stroke = 2 * Math.PI * 14;
  return (
    <svg className="widget-mini-viz widget-mini-viz--ring" viewBox="0 0 36 36" aria-hidden>
      <circle cx="18" cy="18" r="14" fill="none" stroke="var(--line)" strokeWidth="3" />
      <circle
        cx="18"
        cy="18"
        r="14"
        fill="none"
        stroke={aqi <= 50 ? "var(--sage, #7fa86a)" : aqi <= 100 ? "var(--gold-2)" : "var(--clay)"}
        strokeWidth="3"
        strokeDasharray={stroke}
        strokeDashoffset={stroke * (1 - ratio)}
        strokeLinecap="round"
        transform="rotate(-90 18 18)"
      />
    </svg>
  );
}

function RunProgress({ km }: { km: number }) {
  const goal = 50;
  const ratio = Math.min(1, km / goal);
  return (
    <div className="widget-mini-viz widget-mini-viz--progress" aria-hidden>
      <div className="widget-mini-viz__track">
        <div className="widget-mini-viz__fill up" style={{ width: `${ratio * 100}%` }} />
      </div>
      <span className="widget-mini-viz__caption">{km}km</span>
    </div>
  );
}

function AgendaPills({ events, tasks }: { events: number; tasks: number }) {
  return (
    <div className="widget-mini-viz widget-mini-viz--pills" aria-hidden>
      <span>{events} ev</span>
      <span>{tasks} tk</span>
    </div>
  );
}

export function WidgetMiniViz({ widgetId, raw }: Props) {
  if (!raw) return null;
  if (widgetId === "markets" && typeof raw.chg === "number") {
    return <MarketsBar chg={raw.chg} />;
  }
  if (widgetId === "air" && typeof raw.aqi === "number") {
    return <AqiGauge aqi={raw.aqi} />;
  }
  if (widgetId === "run" && typeof raw.km === "number") {
    return <RunProgress km={raw.km} />;
  }
  if (widgetId === "agenda") {
    const events = typeof raw.eventsToday === "number" ? raw.eventsToday : 0;
    const tasks = typeof raw.openTasks === "number" ? raw.openTasks : 0;
    return <AgendaPills events={events} tasks={tasks} />;
  }
  return null;
}
