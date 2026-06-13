"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { createClient } from "@/lib/supabase/client";
import { DEFAULT_WIDGET_IDS, getWidgetById, WIDGET_CATALOG } from "@/lib/store/widgets";
import { formatDateLong } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { FeaturedPhotos } from "@/components/console/FeaturedPhotos";
import { useWidgetData } from "@/lib/hooks/useWidgetData";
import { useSignals } from "@/lib/hooks/useSignals";
import { rankTasks, useTasks, type Task } from "@/lib/hooks/useTasks";
import { Card } from "@/components/ui/Card";

/* ── constants ─────────────────────────────────────────────────── */

const CONSOLE_SECTION_ORDER_KEY = "axis-console-sections";
const DEFAULT_SECTION_ORDER = [
  "widgets",
  "photos",
  "daily-rings",
  "todays-arc",
  "focus-ranked",
  "weekly-devotional",
  "stoic-maxim",
  "markets-body",
] as const;

type SectionId = (typeof DEFAULT_SECTION_ORDER)[number];

/* ── HeroLine ──────────────────────────────────────────────────── */

function HeroLine({ tasks }: { tasks: Task[] }) {
  const open = tasks.filter((t) => t.status !== "done");
  const today = new Date();
  const dueToday = open.filter(
    (t) => t.deadline && new Date(t.deadline).toDateString() === today.toDateString(),
  );
  const overdue = open.filter((t) => t.status === "overdue");

  if (open.length === 0) {
    return (
      <h1 className="hero-title">
        A clear slate — <em>capture a thought below</em>
        <br />
        and let the console file it.
      </h1>
    );
  }

  return (
    <h1 className="hero-title">
      {open.length} open {open.length === 1 ? "task" : "tasks"},{" "}
      <em>
        {overdue.length > 0
          ? `${overdue.length} overdue`
          : dueToday.length > 0
            ? `${dueToday.length} due today`
            : "nothing overdue"}
      </em>
      ,<br />
      and the morning block is yours.
    </h1>
  );
}

/* ── DraggableBlock ────────────────────────────────────────────── */

function DraggableBlock({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        position: "relative",
      }}
    >
      <div
        {...attributes}
        {...listeners}
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          cursor: "grab",
          color: "var(--ink-faint)",
          fontSize: 14,
          zIndex: 2,
          lineHeight: 1,
          padding: "2px 4px",
          borderRadius: "var(--r)",
        }}
        className="block-drag-handle"
        title="Drag to reorder"
      >
        ⠿
      </div>
      {children}
    </div>
  );
}

/* ── ConsoleModule ─────────────────────────────────────────────── */

export function ConsoleModule() {
  const supabase = useMemo(() => createClient(), []);
  const { toast } = useToast();
  const { capture } = useSignals();
  const { tasks, toggleDone } = useTasks();
  const [widgetIds, setWidgetIds] = useState<string[]>(DEFAULT_WIDGET_IDS);
  const [widgetTexts, setWidgetTexts] = useState<Record<string, { v: string; k: string }>>({});
  const [editing, setEditing] = useState(false);
  const [expandedWidget, setExpandedWidget] = useState<string | null>(null);
  const [swapIdx, setSwapIdx] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [captureText, setCaptureText] = useState("");
  const { data: liveData, refreshOne, refreshAll } = useWidgetData(widgetIds);

  // Section ordering state
  const [sectionOrder, setSectionOrder] = useState<SectionId[]>([...DEFAULT_SECTION_ORDER]);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  const topTasks = rankTasks(tasks).slice(0, 3);

  // Load section order from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(CONSOLE_SECTION_ORDER_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as SectionId[];
        // Validate: ensure all current default sections are present
        const allPresent = DEFAULT_SECTION_ORDER.every((id) => parsed.includes(id));
        if (allPresent && parsed.length === DEFAULT_SECTION_ORDER.length) {
          setSectionOrder(parsed);
        }
      }
    } catch {
      // ignore parse errors
    }
  }, []);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from("console_widgets")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) toast(error.message, "error", "Console");
    else if (data) {
      setWidgetIds(data.widget_ids?.length ? data.widget_ids : DEFAULT_WIDGET_IDS);
      setWidgetTexts((data.widget_texts as Record<string, { v: string; k: string }>) || {});
    }
    setLoading(false);
  }, [supabase, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (ids: string[], texts: Record<string, { v: string; k: string }>) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { error } = await supabase.from("console_widgets").upsert(
      {
        user_id: user.id,
        widget_ids: ids,
        sort_order: ids,
        widget_texts: texts,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) toast(error.message, "error", "Console");
    else toast("Widget layout saved.", "success", "Console");
  };

  const handleCapture = async () => {
    if (!captureText.trim()) return;
    const text = captureText.trim();
    setCaptureText("");
    await capture(text);
    fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "capture", text }),
    })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (d?.label && d?.action) {
          toast(`${d.label} · ${d.action}`, "info", "AI");
        } else {
          toast("Captured to Signals inbox", "success", "Console");
        }
      })
      .catch(() => toast("Captured to Signals inbox", "success", "Console"));
  };

  // dnd-kit sensors
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setSectionOrder((prev) => {
      const oldIndex = prev.indexOf(active.id as SectionId);
      const newIndex = prev.indexOf(over.id as SectionId);
      const next = arrayMove(prev, oldIndex, newIndex);
      try {
        localStorage.setItem(CONSOLE_SECTION_ORDER_KEY, JSON.stringify(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };

  if (loading) return <div className="empty-state">Loading console…</div>;

  // ── section render map ──────────────────────────────────────────

  const widgetsSection = (
    <DraggableBlock key="widgets" id="widgets">
      <div style={{ paddingTop: 4 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--space-2)" }}>
          <span className="seclabel" style={{ margin: 0 }}>Console Widgets</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="feed-manage" onClick={refreshAll}>Refresh</button>
            <button
              type="button"
              className="feed-manage"
              onClick={() => {
                if (editing) save(widgetIds, widgetTexts);
                setEditing((e) => !e);
              }}
            >
              {editing ? "Done" : "Customize"}
            </button>
          </div>
        </div>
        <div className="tidbits">
          {widgetIds.map((id, i) => {
            const w = getWidgetById(id);
            const live = liveData[id];
            const texts = widgetTexts[id];
            const value = editing ? (texts?.v ?? live?.v ?? w.value) : (live?.v ?? texts?.v ?? w.value);
            const hint = editing ? (texts?.k ?? live?.k ?? w.hint) : (live?.k ?? texts?.k ?? w.hint);
            return (
              <div
                key={`${id}-${i}`}
                className="tb"
                style={{ position: "relative", cursor: editing ? "default" : "pointer" }}
                onClick={() => !editing && setExpandedWidget(expandedWidget === id ? null : id)}
                title={expandedWidget === id ? "Click to collapse" : "Click to expand · double-click refreshes"}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  refreshOne(id);
                  toast("Widget refreshed", "success", w.label);
                }}
              >
                {editing && (
                  <button
                    type="button"
                    style={{ position: "absolute", right: 8, top: 8, fontFamily: "var(--mono)", fontSize: 10, color: "var(--accent-2)" }}
                    onClick={(e) => { e.stopPropagation(); setSwapIdx(i); setPickerOpen(true); }}
                  >
                    ⇄
                  </button>
                )}
                <div className="tb-ic">{w.icon}</div>
                <div>
                  <div className="tb-v" contentEditable={editing} suppressContentEditableWarning onBlur={(e) => {
                    const next = { ...widgetTexts, [id]: { v: e.currentTarget.textContent || value, k: hint } };
                    setWidgetTexts(next);
                  }}>{value}</div>
                  <div className="tb-k" contentEditable={editing} suppressContentEditableWarning onBlur={(e) => {
                    const next = { ...widgetTexts, [id]: { v: value, k: e.currentTarget.textContent || hint } };
                    setWidgetTexts(next);
                  }}>{expandedWidget === id ? `${hint} · tap to collapse` : hint}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </DraggableBlock>
  );

  const photosSection = (
    <DraggableBlock key="photos" id="photos">
      <FeaturedPhotos />
    </DraggableBlock>
  );

  const dailyRingsSection = (
    <DraggableBlock key="daily-rings" id="daily-rings">
      <Card tick>
        <h2 className="sec">Daily Rings<span className="rule" /><span className="count">74%</span></h2>
        <div className="rings-wrap">
          <svg className="rings" viewBox="0 0 120 120">
            <circle className="rbg" cx="60" cy="60" r="52" /><circle className="rfg r1" cx="60" cy="60" r="52" />
            <circle className="rbg" cx="60" cy="60" r="40" /><circle className="rfg r2" cx="60" cy="60" r="40" />
            <circle className="rbg" cx="60" cy="60" r="28" /><circle className="rfg r3" cx="60" cy="60" r="28" />
          </svg>
          <div className="rings-legend">
            <div className="rl-row"><span className="rl-dot" style={{ background: "var(--accent)" }} /><span className="rl-name">Deep work</span><span className="rl-v">3.0 / 4h</span></div>
            <div className="rl-row"><span className="rl-dot" style={{ background: "var(--up)" }} /><span className="rl-name">Movement</span><span className="rl-v">8 / 8 km</span></div>
            <div className="rl-row"><span className="rl-dot" style={{ background: "var(--accent-2)" }} /><span className="rl-name">Tasks</span><span className="rl-v">{tasks.filter((t) => t.status === "done").length} / {Math.max(tasks.length, 8)}</span></div>
          </div>
        </div>
      </Card>
    </DraggableBlock>
  );

  const todaysArcSection = (
    <DraggableBlock key="todays-arc" id="todays-arc">
      <Card tick>
        <h2 className="sec">Today&apos;s Arc<span className="rule" /><span className="count">Schedule</span></h2>
        <p style={{ marginTop: 12, color: "var(--ink-dim)", fontSize: 12 }}>Synced from Schedule module — add events on the Schedule page.</p>
      </Card>
    </DraggableBlock>
  );

  const focusRankedSection = (
    <DraggableBlock key="focus-ranked" id="focus-ranked">
      <Card>
        <h2 className="sec">Focus · Ranked<span className="rule" /><span className="count">Top {topTasks.length || 3}</span></h2>
        <div style={{ marginTop: 14 }}>
          {topTasks.length === 0 ? (
            <p style={{ color: "var(--ink-faint)", fontSize: 12 }}>Add tasks in Agenda to populate ranked focus.</p>
          ) : (
            topTasks.map((t) => (
              <div key={t.id} className={`task${t.status === "done" ? " done" : ""}`}>
                <div className={`check${t.status === "done" ? " done" : ""}`} onClick={() => toggleDone(t.id)} />
                <div className="task-main">
                  <div className="task-title">{t.title}</div>
                  <div className="task-meta">
                    <span className={`pill ${t.priority}`}>{t.priority.toUpperCase()}</span>
                    {t.effort && <span>{t.effort}</span>}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </Card>
    </DraggableBlock>
  );

  const weeklyDevotionalSection = (
    <DraggableBlock key="weekly-devotional" id="weekly-devotional">
      <Card tick className="devo">
        <div className="eyebrow" style={{ color: "var(--clay)" }}>Weekly Devotional · Day 4/7</div>
        <div className="verse">&ldquo;Whatever you do, work heartily, as for the Lord and not for men.&rdquo;</div>
        <div className="ref">COLOSSIANS 3:23 · ESV</div>
      </Card>
    </DraggableBlock>
  );

  const stoicMaximSection = (
    <DraggableBlock key="stoic-maxim" id="stoic-maxim">
      <Card tick className="quote-card">
        <div className="eyebrow" style={{ color: "var(--accent-2)" }}>Stoic Maxim of the Day</div>
        <div className="qtext">You have power over your mind — not outside events.</div>
        <div className="qauth">— Marcus Aurelius, <em>Meditations</em></div>
      </Card>
    </DraggableBlock>
  );

  const marketsBodySection = (
    <DraggableBlock key="markets-body" id="markets-body">
      <Card>
        <h2 className="sec">Markets &amp; Body<span className="rule" /><span className="count">{liveData.markets ? "Live" : "Cached"}</span></h2>
        <div style={{ marginTop: 12 }}>
          <div className="metricrow"><span className="metric-k">Markets</span><span className="metric-v">{liveData.markets?.v ?? "—"}</span></div>
          <div className="metricrow"><span className="metric-k">Hint</span><span className="metric-v" style={{ fontSize: 11 }}>{liveData.markets?.k ?? "Set POLYGON_API_KEY"}</span></div>
        </div>
      </Card>
    </DraggableBlock>
  );

  const sectionMap: Record<SectionId, React.ReactNode> = {
    "widgets": widgetsSection,
    "photos": photosSection,
    "daily-rings": dailyRingsSection,
    "todays-arc": todaysArcSection,
    "focus-ranked": focusRankedSection,
    "weekly-devotional": weeklyDevotionalSection,
    "stoic-maxim": stoicMaximSection,
    "markets-body": marketsBodySection,
  };

  // Minimal clone for DragOverlay — just a dim placeholder matching the handle
  const overlayNode = activeDragId ? (
    <div
      style={{
        background: "var(--glass-2)",
        border: "1px solid var(--line-strong)",
        borderRadius: "var(--rl)",
        padding: "12px 16px",
        opacity: 0.7,
        backdropFilter: "var(--blur)",
        WebkitBackdropFilter: "var(--blur)",
        color: "var(--ink-dim)",
        fontSize: 12,
        fontFamily: "var(--narrow)",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        cursor: "grabbing",
      }}
    >
      {activeDragId.replace(/-/g, " ")}
    </div>
  ) : null;

  return (
    <>
      <div className="eyebrow">{formatDateLong()}</div>
      <HeroLine tasks={tasks} />

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={sectionOrder} strategy={verticalListSortingStrategy}>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--section-gap)", marginTop: "var(--section-gap)" }}>
            {sectionOrder.map((id) => sectionMap[id])}
          </div>
        </SortableContext>
        <DragOverlay>{overlayNode}</DragOverlay>
      </DndContext>

      <div className="capture" style={{ marginTop: "var(--section-gap)" }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <input
          placeholder="Capture a thought, task, paper, or expense — I'll file and schedule it…"
          value={captureText}
          onChange={(e) => setCaptureText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleCapture()}
        />
        <span className="capt-pill">TASK</span>
        <span className="capt-pill">NOTE</span>
        <span className="capt-pill">PAPER</span>
        <button type="button" className="capt-go" onClick={handleCapture}>Capture</button>
      </div>

      <Modal open={pickerOpen} onClose={() => setPickerOpen(false)} title="Swap Widget" footer={<Button variant="ghost" onClick={() => setPickerOpen(false)}>Cancel</Button>}>
        <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
          {WIDGET_CATALOG.map((w) => (
            <button key={w.id} type="button" onClick={() => {
              if (swapIdx === null) return;
              const next = [...widgetIds];
              next[swapIdx] = w.id;
              setWidgetIds(next);
              save(next, widgetTexts);
              setPickerOpen(false);
              setSwapIdx(null);
            }} className="flex items-center gap-3 rounded border border-[var(--line)] p-3 text-left transition hover:border-[var(--accent-2)]">
              <span className="text-lg">{w.icon}</span>
              <span><strong className="block text-sm">{w.label}</strong></span>
            </button>
          ))}
        </div>
      </Modal>
    </>
  );
}
