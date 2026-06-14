"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
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
import { useTasks, type Task, type TaskCategory } from "@/lib/hooks/useTasks";
import { useToast } from "@/components/ui/Toast";

type RoutineStep = { id: string; time: string; title: string; sub: string };

const DEFAULT_NIGHT_ROUTINE: RoutineStep[] = [
  { id: "n1", time: "21:30", title: "Screen cap · warm light on", sub: "No bright screens after this point" },
  { id: "n2", time: "21:40", title: "Prep tomorrow's top 3", sub: "Write in Agenda before closing laptop" },
  { id: "n3", time: "21:55", title: "Physical reading", sub: "Book only — no phone or tablet" },
  { id: "n4", time: "22:20", title: "Light mobility or stretch", sub: "10 min floor routine" },
  { id: "n5", time: "22:35", title: "Skin care & hygiene", sub: "Consistent wind-down signal to the body" },
  { id: "n6", time: "22:45", title: "Gratitude + wins review", sub: "Three things, written or spoken" },
  { id: "n7", time: "23:00", title: "Lights out", sub: "Cool room, dark, no devices" },
];

const DEFAULT_ROUTINE: RoutineStep[] = [
  { id: "1", time: "05:45", title: "Wake · no snooze, lights on", sub: "Phone stays face-down until step 4" },
  { id: "2", time: "05:50", title: "Hydrate + electrolytes", sub: "16 oz water before coffee" },
  { id: "3", time: "06:00", title: "Zone-2 run or mobility", sub: "Run days: 6–8 km easy · off days: 15-min flow" },
  { id: "4", time: "06:50", title: "Shower + cold finish", sub: "30s cold to close" },
  { id: "5", time: "07:05", title: "Devotional + Stoic page", sub: "From the Today board · 10 min" },
  { id: "6", time: "07:20", title: "Protein breakfast + espresso", sub: "~40g protein" },
  { id: "7", time: "07:40", title: "Set top 3 + first deep-work block", sub: "No email until first block is done" },
];

const OUTREACH = [
  { init: "A", name: "Dr. Adeyemi", why: "IRB amendment sign-off", due: "today" },
  { init: "C", name: "Chidi O.", why: "Reply re: visit dates", due: "today" },
  { init: "R", name: "Riku Tanaka", why: "Nudge Fine–Gray code review", due: "Wed" },
];

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

const SortableRow = memo(function SortableRow({ step, checked, onToggle }: { step: RoutineStep; checked: boolean; onToggle: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: step.id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div ref={setNodeRef} style={style} className="mr-row">
      <div className={checked ? "mr-check done" : "mr-check"} onClick={onToggle} />
      <div className="mr-time" {...attributes} {...listeners} style={{ cursor: "grab" }}>{step.time}</div>
      <div className="mr-main">
        <div className="mr-t">{step.title}</div>
        <div className="mr-s">{step.sub}</div>
      </div>
    </div>
  );
});

const TASK_TOGGLE_STYLE: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--ink-faint)",
  fontSize: 11,
  fontFamily: "var(--mono)",
  letterSpacing: ".08em",
  cursor: "pointer",
  padding: "6px 0",
  display: "block",
  width: "100%",
  textAlign: "center",
};

const TaskBlock = memo(function TaskBlock({
  title,
  category,
  tasks,
  onAdd,
  onToggle,
  onDelete,
}: {
  title: string;
  category: TaskCategory;
  tasks: Task[];
  onAdd: (title: string) => void;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const catTasks = tasks.filter((t) => t.category === category || (category === "clinical" && t.category === "life"));
  const visibleTasks = expanded ? catTasks : catTasks.slice(0, 3);

  return (
    <div className="card">
      <h2 className="sec">{title}<span className="rule" /></h2>
      <div className="tasklist" style={{ marginTop: 14 }}>
        {visibleTasks.map((t) => (
          <div key={t.id} className={t.status === "done" ? "task done" : "task"}>
            <div className={t.status === "done" ? "check done" : "check"} onClick={() => onToggle(t.id)} />
            <div className="task-main">
              <div className="task-title">{t.title}</div>
              <div className="task-meta">
                <span className={`pill ${t.priority}`}>{t.priority.toUpperCase()}</span>
                {t.effort && <span>{t.effort}</span>}
                {t.deadline && <span>due {new Date(t.deadline).toLocaleDateString()}</span>}
              </div>
            </div>
            <div className="rowact">
              <button type="button" className="del" title="Delete" onClick={() => onDelete(t.id)}>×</button>
            </div>
          </div>
        ))}
      </div>
      {catTasks.length > 3 && (
        <button type="button" onClick={() => setExpanded((e) => !e)} style={TASK_TOGGLE_STYLE}>
          {expanded ? "▲ Collapse" : `▼ Show all ${catTasks.length}`}
        </button>
      )}
      <div className="addtask">
        <input
          placeholder="+ Add task…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) {
              onAdd(draft.trim());
              setDraft("");
            }
          }}
        />
      </div>
    </div>
  );
});

export function AgendaModule() {
  const { tasks, addTask, toggleDone, deleteTask } = useTasks();
  const { toast } = useToast();
  const supabase = useMemo(() => createClient(), []);
  const [routine, setRoutine] = useState<RoutineStep[]>(DEFAULT_ROUTINE);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [tuneOpen, setTuneOpen] = useState(false);
  const [newStep, setNewStep] = useState("");
  const [nightRoutine, setNightRoutine] = useState<RoutineStep[]>(DEFAULT_NIGHT_ROUTINE);
  const [nightChecks, setNightChecks] = useState<Record<string, boolean>>({});
  const [nightTuneOpen, setNightTuneOpen] = useState(false);
  const [newNightStep, setNewNightStep] = useState("");
  const [filterPri, setFilterPri] = useState<string>("all");

  const loadRoutine = useCallback(async () => {
    const key = todayKey();
    const localChecks = localStorage.getItem(`axis-routine-checks-${key}`);
    if (localChecks) setChecks(JSON.parse(localChecks));

    const stored = localStorage.getItem("axis-morning-routine");
    if (stored) setRoutine(JSON.parse(stored));

    const nightStored = localStorage.getItem("axis-night-routine");
    if (nightStored) setNightRoutine(JSON.parse(nightStored));
    const nightLocalChecks = localStorage.getItem(`axis-night-routine-checks-${key}`);
    if (nightLocalChecks) setNightChecks(JSON.parse(nightLocalChecks));

    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data } = await supabase.from("user_preferences").select("morning_routine, routine_checks, night_routine, night_routine_checks").eq("user_id", user.id).maybeSingle();
      if (data?.morning_routine && Array.isArray(data.morning_routine) && data.morning_routine.length) {
        setRoutine(data.morning_routine as RoutineStep[]);
      }
      const rc = data?.routine_checks as Record<string, Record<string, boolean>> | undefined;
      if (rc?.[key]) setChecks(rc[key]);
      if (data?.night_routine && Array.isArray(data.night_routine) && (data.night_routine as RoutineStep[]).length) {
        setNightRoutine(data.night_routine as RoutineStep[]);
      }
      const nrc = data?.night_routine_checks as Record<string, Record<string, boolean>> | undefined;
      if (nrc?.[key]) setNightChecks(nrc[key]);
    }
  }, [supabase]);

  useEffect(() => {
    loadRoutine();
    const last = localStorage.getItem("axis-routine-date");
    if (last !== todayKey()) {
      setChecks({});
      setNightChecks({});
      localStorage.setItem("axis-routine-date", todayKey());
      localStorage.removeItem(`axis-routine-checks-${last}`);
      localStorage.removeItem(`axis-night-routine-checks-${last}`);
    }
  }, [loadRoutine]);

  const saveNightRoutine = async (steps: RoutineStep[]) => {
    setNightRoutine(steps);
    localStorage.setItem("axis-night-routine", JSON.stringify(steps));
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      await supabase.from("user_preferences").upsert({ user_id: user.id, night_routine: steps, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    }
  };

  const toggleNightCheck = (id: string) => {
    const key = todayKey();
    const next = { ...nightChecks, [id]: !nightChecks[id] };
    setNightChecks(next);
    localStorage.setItem(`axis-night-routine-checks-${key}`, JSON.stringify(next));
    const persistNight = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      await supabase.from("user_preferences").upsert({ user_id: user.id, night_routine_checks: { [key]: next }, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    };
    persistNight().catch(() => {});
  };

  const saveRoutine = async (steps: RoutineStep[]) => {
    setRoutine(steps);
    localStorage.setItem("axis-morning-routine", JSON.stringify(steps));
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      await supabase.from("user_preferences").upsert({ user_id: user.id, morning_routine: steps, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    }
  };

  const toggleCheck = (id: string) => {
    const key = todayKey();
    // Side effects stay outside the state updater (StrictMode double-invokes updaters)
    const next = { ...checks, [id]: !checks[id] };
    setChecks(next);
    localStorage.setItem(`axis-routine-checks-${key}`, JSON.stringify(next));
    persistChecks(key, next).catch(() => {});
  };

  // Only today's checks are kept server-side — yesterday's reset is intentional
  const persistChecks = async (key: string, next: Record<string, boolean>) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await supabase
      .from("user_preferences")
      .upsert(
        { user_id: user.id, routine_checks: { [key]: next }, updated_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );
  };

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = routine.findIndex((s) => s.id === active.id);
    const newIndex = routine.findIndex((s) => s.id === over.id);
    saveRoutine(arrayMove(routine, oldIndex, newIndex));
  };

  const onNightDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = nightRoutine.findIndex((s) => s.id === active.id);
    const newIndex = nightRoutine.findIndex((s) => s.id === over.id);
    saveNightRoutine(arrayMove(nightRoutine, oldIndex, newIndex));
  };

  const doneCount = routine.filter((s) => checks[s.id]).length;
  const nightDoneCount = nightRoutine.filter((s) => nightChecks[s.id]).length;
  const open = tasks.filter((t) => t.status !== "done");
  const overdue = tasks.filter((t) => t.status === "overdue");
  const filtered = filterPri === "all" ? open : open.filter((t) => t.priority === filterPri);

  const parseAndAdd = useCallback((title: string, category: TaskCategory) => {
    const lower = title.toLowerCase();
    let priority: "hi" | "med" | "lo" = "med";
    if (/high|urgent/.test(lower)) priority = "hi";
    if (/low/.test(lower)) priority = "lo";
    addTask({ title, category, priority });
  }, [addTask]);

  const addResearch = useCallback((t: string) => parseAndAdd(t, "research"), [parseAndAdd]);
  const addClinical = useCallback((t: string) => parseAndAdd(t, "life"), [parseAndAdd]);

  return (
    <>
      <div className="divider" />
      <div className="stat-strip">
        <div className="card stat tick"><div className="sv">{open.length}</div><div className="sk">Open</div></div>
        <div className="card stat"><div className="sv">{overdue.length}</div><div className="sk">Overdue</div></div>
        <div className="card stat"><div className="sv">{tasks.filter((t) => t.status === "done").length}</div><div className="sk">Done</div></div>
      </div>
      <div className="chips" style={{ marginBottom: 12 }}>
        {["all", "hi", "med", "lo"].map((p) => (
          <span key={p} className={filterPri === p ? "chip on" : "chip"} onClick={() => setFilterPri(p)}>{p === "all" ? "All priorities" : p.toUpperCase()}</span>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "start" }}>
        <TaskBlock title="Research" category="research" tasks={filtered} onAdd={addResearch} onToggle={toggleDone} onDelete={deleteTask} />
        <TaskBlock title="Clinical & Life" category="clinical" tasks={filtered} onAdd={addClinical} onToggle={toggleDone} onDelete={deleteTask} />
      </div>
      <div className="divider" />
      <h2 className="sec" style={{ marginBottom: 14 }}>Reach Out<span className="rule" /><span className="count">From People</span></h2>
      <div className="card">
        {OUTREACH.map((o) => (
          <div key={o.name} className="outreach-row">
            <div className="or-av">{o.init}</div>
            <div className="or-b"><div className="or-n">{o.name}</div><div className="or-w">{o.why}</div></div>
            <span className="or-due">due {o.due}</span>
            <button type="button" className="or-go">Message</button>
          </div>
        ))}
      </div>
      <div className="divider" />
      <h2 className="sec" style={{ marginBottom: 14 }}>Morning Routine<span className="rule" /><span className="count">~75 min · {doneCount}/{routine.length}</span></h2>
      <div className="routine-grid">
        <div className="card mr-card tick">
          {/* autoScroll off: fixed-position shell elements trigger dnd-kit's scroll warning, and the list is short */}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} autoScroll={false}>
            <SortableContext items={routine.map((s) => s.id)} strategy={verticalListSortingStrategy}>
              {routine.map((step) => (
                <SortableRow key={step.id} step={step} checked={!!checks[step.id]} onToggle={() => toggleCheck(step.id)} />
              ))}
            </SortableContext>
          </DndContext>
        </div>
        <div className="card" style={{ alignSelf: "start" }}>
          <div className="seclabel">Tune the Routine</div>
          <p style={{ fontSize: 11.5, color: "var(--ink-dim)", lineHeight: 1.55, marginBottom: 12 }}>
            Drag steps to reorder. Resets each morning. Saved to your preferences.
          </p>
          <span className="aibtn" onClick={() => toast("AI rebuild — Phase 4 stub", "info", "Routine")}>Rebuild with AI</span>
          <div className="addtask" style={{ marginTop: 8 }}>
            <input
              placeholder="+ Add a step…"
              value={newStep}
              onChange={(e) => setNewStep(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newStep.trim()) {
                  saveRoutine([...routine, { id: crypto.randomUUID(), time: "—", title: newStep.trim(), sub: "" }]);
                  setNewStep("");
                }
              }}
            />
          </div>
          <button type="button" className="savebtn" style={{ marginTop: 8 }} onClick={() => setTuneOpen(!tuneOpen)}>
            {tuneOpen ? "Hide editor" : "Edit times & titles"}
          </button>
          {tuneOpen && routine.map((s, i) => (
            <div key={s.id} style={{ display: "grid", gridTemplateColumns: "60px 1fr", gap: 8, marginTop: 8 }}>
              <input value={s.time} onChange={(e) => {
                const next = [...routine];
                next[i] = { ...s, time: e.target.value };
                saveRoutine(next);
              }} style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 4, padding: 4, color: "var(--ink)" }} />
              <input value={s.title} onChange={(e) => {
                const next = [...routine];
                next[i] = { ...s, title: e.target.value };
                saveRoutine(next);
              }} style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 4, padding: 4, color: "var(--ink)" }} />
            </div>
          ))}
        </div>
      </div>

      <div className="divider" />
      <h2 className="sec" style={{ marginBottom: 14 }}>Nighttime Routine<span className="rule" /><span className="count">~90 min · {nightDoneCount}/{nightRoutine.length}</span></h2>
      <div className="routine-grid">
        <div className="card mr-card tick">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onNightDragEnd} autoScroll={false}>
            <SortableContext items={nightRoutine.map((s) => s.id)} strategy={verticalListSortingStrategy}>
              {nightRoutine.map((step) => (
                <SortableRow key={step.id} step={step} checked={!!nightChecks[step.id]} onToggle={() => toggleNightCheck(step.id)} />
              ))}
            </SortableContext>
          </DndContext>
        </div>
        <div className="card" style={{ alignSelf: "start" }}>
          <div className="seclabel">Tune the Routine</div>
          <p style={{ fontSize: 11.5, color: "var(--ink-dim)", lineHeight: 1.55, marginBottom: 12 }}>
            Drag steps to reorder. Resets each night. Saved to your preferences.
          </p>
          <span className="aibtn" onClick={() => toast("AI rebuild — Phase 4 stub", "info", "Night Routine")}>Rebuild with AI</span>
          <div className="addtask" style={{ marginTop: 8 }}>
            <input
              placeholder="+ Add a step…"
              value={newNightStep}
              onChange={(e) => setNewNightStep(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newNightStep.trim()) {
                  saveNightRoutine([...nightRoutine, { id: crypto.randomUUID(), time: "—", title: newNightStep.trim(), sub: "" }]);
                  setNewNightStep("");
                }
              }}
            />
          </div>
          <button type="button" className="savebtn" style={{ marginTop: 8 }} onClick={() => setNightTuneOpen(!nightTuneOpen)}>
            {nightTuneOpen ? "Hide editor" : "Edit times & titles"}
          </button>
          {nightTuneOpen && nightRoutine.map((s, i) => (
            <div key={s.id} style={{ display: "grid", gridTemplateColumns: "60px 1fr", gap: 8, marginTop: 8 }}>
              <input value={s.time} onChange={(e) => {
                const next = [...nightRoutine];
                next[i] = { ...s, time: e.target.value };
                saveNightRoutine(next);
              }} style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 4, padding: 4, color: "var(--ink)" }} />
              <input value={s.title} onChange={(e) => {
                const next = [...nightRoutine];
                next[i] = { ...s, title: e.target.value };
                saveNightRoutine(next);
              }} style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 4, padding: 4, color: "var(--ink)" }} />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
