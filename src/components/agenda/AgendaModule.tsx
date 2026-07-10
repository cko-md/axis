"use client";

import * as Sentry from "@sentry/nextjs";
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
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { fetchTodayMergedEvents } from "@/lib/calendar/today-events";
import {
  useTasks,
  rankTasks,
  doneTodayTasks,
  isTaskOverdue,
  isTaskStale,
  taskRankReason,
  type Task,
  type TaskCategory,
} from "@/lib/hooks/useTasks";
import { usePeople, personIsDue, personFootLabel } from "@/lib/hooks/usePeople";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { buildTodayRanking, type TodayItem } from "@/components/agenda/today-ranking";
import type { ScheduleEvent } from "@/lib/types";

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


function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

const SortableRow = memo(function SortableRow({ step, checked, onToggle }: { step: RoutineStep; checked: boolean; onToggle: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: step.id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div ref={setNodeRef} style={style} className="mr-row">
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={`Mark "${step.title}" ${checked ? "incomplete" : "complete"}`}
        className={checked ? "mr-check done" : "mr-check"}
        onClick={onToggle}
        style={{ background: "none", padding: 0 }}
      />
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

const TASK_OPEN_STYLE: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "none",
  border: "none",
  padding: 0,
  color: "inherit",
  cursor: "pointer",
};

const TaskBlock = memo(function TaskBlock({
  title,
  category,
  tasks,
  onAdd,
  onToggle,
  onDelete,
  onOpen,
}: {
  title: string;
  category: TaskCategory;
  tasks: Task[];
  onAdd: (title: string) => void | Promise<void>;
  onToggle: (id: string) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
  onOpen: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  // Rank by priority×deadline (rankTasks) instead of raw insertion order —
  // otherwise "top 3" is whichever 3 happened to be created first, not the 3
  // that actually matter most today (CAL-4: remove placeholder ranking).
  const catTasks = rankTasks(tasks.filter((t) => t.category === category || (category === "clinical" && t.category === "life")));
  const visibleTasks = expanded ? catTasks : catTasks.slice(0, 3);
  const tasklistId = `tasklist-${category}`;

  return (
    <div className="card">
      <h2 className="sec">{title}<span className="rule" /></h2>
      <div id={tasklistId} className="tasklist" style={{ marginTop: 14 }}>
        {visibleTasks.map((t) => (
          <div key={t.id} className={t.status === "done" ? "task done" : "task"}>
            <button
              type="button"
              role="checkbox"
              aria-checked={t.status === "done"}
              aria-label={`Mark "${t.title}" complete`}
              className={t.status === "done" ? "check done" : "check"}
              onClick={() => onToggle(t.id)}
              style={{ background: "none", padding: 0 }}
            />
            <div className="task-main">
              <button
                type="button"
                style={TASK_OPEN_STYLE}
                onClick={() => onOpen(t.id)}
                aria-label={`Open details for "${t.title}"`}
              >
                <div className="task-title">{t.title}</div>
                <div className="task-meta">
                  <span className={`pill ${t.priority}`}>{t.priority.toUpperCase()}</span>
                  {t.effort && <span>{t.effort}</span>}
                  {t.deadline && <span>due {new Date(t.deadline).toLocaleDateString()}</span>}
                </div>
              </button>
            </div>
            <div className="rowact">
              <button type="button" className="del" title="Delete" aria-label={`Delete "${t.title}"`} onClick={() => onDelete(t.id)}>×</button>
            </div>
          </div>
        ))}
      </div>
      {catTasks.length > 3 && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          style={TASK_TOGGLE_STYLE}
          aria-expanded={expanded}
          aria-controls={tasklistId}
        >
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
              void onAdd(draft.trim());
              setDraft("");
            }
          }}
        />
      </div>
    </div>
  );
});

const TODAY_ROW_ICON: Record<TodayItem["kind"], string> = { event: "◷", task: "○", "follow-up": "◉" };

// One row for the merged Today ranking (CAL-4). Complete/route actions vary
// by item kind: a task completes in place, an event/follow-up routes to its
// owning module (Schedule/People) since editing those lives there.
const TodayRow = memo(function TodayRow({
  item,
  onToggleTask,
  onOpenTask,
  onNavigate,
}: {
  item: TodayItem;
  onToggleTask: (id: string) => void | Promise<void>;
  onOpenTask: (id: string) => void;
  onNavigate: (href: string) => void;
}) {
  const isTask = item.kind === "task";
  return (
    <div className={isTask && item.source.status === "done" ? "task done" : "task"}>
      {isTask ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={item.source.status === "done"}
          aria-label={`Mark "${item.title}" complete`}
          className={item.source.status === "done" ? "check done" : "check"}
          onClick={() => onToggleTask(item.id)}
          style={{ background: "none", padding: 0 }}
        />
      ) : (
        <span aria-hidden="true" style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-faint)", width: 16, textAlign: "center", flexShrink: 0 }}>
          {TODAY_ROW_ICON[item.kind]}
        </span>
      )}
      <div className="task-main">
        <button
          type="button"
          style={TASK_OPEN_STYLE}
          onClick={() => (isTask ? onOpenTask(item.id) : onNavigate(item.kind === "event" ? "/schedule" : "/people"))}
          aria-label={item.kind === "event" ? `Open "${item.title}" in Schedule` : item.kind === "follow-up" ? `Open "${item.title}" in People` : `Open details for "${item.title}"`}
        >
          <div className="task-title">{item.title}</div>
          <div className="task-meta">
            {item.kind === "event" && <span>{item.time || "All day"}</span>}
            {item.kind === "task" && <span className={`pill ${item.priority}`}>{item.priority.toUpperCase()}</span>}
            {item.kind === "follow-up" && <span>{item.footLabel}</span>}
          </div>
        </button>
      </div>
    </div>
  );
});

function deadlineForInput(deadline: string | null) {
  if (!deadline) return "";
  return deadline.slice(0, 10);
}

function safeInternalHref(value: unknown) {
  if (typeof value !== "string") return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  return value;
}

function taskSourceLink(task: Task) {
  const metadata = task.metadata ?? {};
  const route = safeInternalHref(metadata.source_route);
  const type = typeof metadata.source_object_type === "string" ? metadata.source_object_type : null;
  const sourceId = typeof metadata.source_object_id === "string" ? metadata.source_object_id : null;
  const signalId = typeof metadata.source_signal_id === "string" ? metadata.source_signal_id : null;
  const noteId = typeof metadata.source_note_id === "string" ? metadata.source_note_id : null;

  if (route) return { href: route, label: "Open source" };
  if (signalId || type === "signal") return { href: "/dispatch", label: "Open in Dispatch" };
  if (noteId || type === "note") return { href: "/notes", label: "Open in Notes" };
  if (type === "mail_message" || sourceId || metadata.mail_provider) return { href: "/mail", label: "Open in Mail" };
  return null;
}

function defaultFocusStart(task: Task) {
  if (task.deadline) {
    const deadline = new Date(task.deadline);
    if (!Number.isNaN(deadline.getTime())) {
      deadline.setHours(9, 0, 0, 0);
      return deadline;
    }
  }
  const start = new Date();
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 1);
  return start;
}

function effortToMinutes(effort: string | null) {
  if (!effort) return 60;
  const lower = effort.toLowerCase();
  const hourMatch = lower.match(/(\d+(?:\.\d+)?)\s*h/);
  if (hourMatch) return Math.max(15, Math.round(Number(hourMatch[1]) * 60));
  const minuteMatch = lower.match(/(\d+)\s*m/);
  if (minuteMatch) return Math.max(15, Number(minuteMatch[1]));
  if (lower.includes("15")) return 15;
  if (lower.includes("30")) return 30;
  if (lower.includes("2")) return 120;
  return 60;
}

function normalizeTaskCategory(value: unknown): TaskCategory | null {
  if (value === "research" || value === "clinical" || value === "life" || value === "personal") return value;
  return null;
}

function TaskDetailModal({
  task,
  open,
  saving,
  scheduling,
  suggesting,
  onClose,
  onSave,
  onToggle,
  onDelete,
  onSchedule,
  onSuggest,
}: {
  task: Task | null;
  open: boolean;
  saving: "save" | "toggle" | "delete" | null;
  scheduling: boolean;
  suggesting: boolean;
  onClose: () => void;
  onSave: (patch: Pick<Task, "title" | "priority" | "category"> & { effort: string | null; deadline: string | null }) => Promise<void>;
  onToggle: () => Promise<void>;
  onDelete: () => Promise<void>;
  onSchedule: () => Promise<void>;
  onSuggest: () => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<Task["priority"]>("med");
  const [category, setCategory] = useState<TaskCategory>("research");
  const [effort, setEffort] = useState("");
  const [deadline, setDeadline] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!task) return;
    setTitle(task.title);
    setPriority(task.priority);
    setCategory(task.category);
    setEffort(task.effort ?? "");
    setDeadline(deadlineForInput(task.deadline));
    setConfirmDelete(false);
  }, [task]);

  if (!task) return null;

  const completedLabel = task.completed_at
    ? new Date(task.completed_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;
  const canSave = title.trim().length > 0 && !saving;
  const sourceLink = taskSourceLink(task);
  const rankReason = taskRankReason(task);
  const overdue = isTaskOverdue(task);
  const stale = isTaskStale(task);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Task Detail"
      footer={(
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={!!saving}>Close</Button>
          <Button
            type="button"
            variant="secondary"
            loading={saving === "toggle"}
            onClick={() => void onToggle()}
          >
            {task.status === "done" ? "Reopen" : "Complete"}
          </Button>
          <Button type="button" variant="secondary" loading={scheduling} onClick={() => void onSchedule()}>
            Schedule
          </Button>
          <Button
            type="button"
            variant="primary"
            loading={saving === "save"}
            disabled={!canSave}
            onClick={() => void onSave({
              title: title.trim(),
              priority,
              category,
              effort: effort.trim() || null,
              deadline: deadline || null,
            })}
          >
            Save
          </Button>
        </>
      )}
    >
      <div style={{ display: "grid", gap: 12 }}>
        <label style={{ display: "grid", gap: 5 }}>
          <span className="task-meta">Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 4, padding: "8px 9px", color: "var(--ink)" }}
          />
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <label style={{ display: "grid", gap: 5 }}>
            <span className="task-meta">Priority</span>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as Task["priority"])}
              style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 4, padding: "8px 9px", color: "var(--ink)" }}
            >
              <option value="hi">High</option>
              <option value="med">Medium</option>
              <option value="lo">Low</option>
            </select>
          </label>
          <label style={{ display: "grid", gap: 5 }}>
            <span className="task-meta">Category</span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as TaskCategory)}
              style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 4, padding: "8px 9px", color: "var(--ink)" }}
            >
              <option value="research">Research</option>
              <option value="clinical">Clinical</option>
              <option value="life">Life</option>
              <option value="personal">Personal</option>
            </select>
          </label>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <label style={{ display: "grid", gap: 5 }}>
            <span className="task-meta">Effort</span>
            <input
              value={effort}
              onChange={(e) => setEffort(e.target.value)}
              placeholder="30m, ~1h..."
              style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 4, padding: "8px 9px", color: "var(--ink)" }}
            />
          </label>
          <label style={{ display: "grid", gap: 5 }}>
            <span className="task-meta">Deadline</span>
            <input
              type="date"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 4, padding: "8px 9px", color: "var(--ink)" }}
            />
          </label>
        </div>
        <div className="task-meta">
          <span className={`pill ${task.priority}`}>{task.status.toUpperCase()}</span>
          {overdue && <span className="pill hi">OVERDUE</span>}
          {stale && <span className="pill lo">STALE</span>}
          <span>Created {new Date(task.created_at).toLocaleDateString()}</span>
          {completedLabel && <span>Completed {completedLabel}</span>}
        </div>
        <div style={{ display: "grid", gap: 8, border: "1px solid var(--line)", borderRadius: 6, padding: 10, background: "var(--surface-2)" }}>
          <div className="task-meta">Rank: {rankReason.explanation}</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {sourceLink && (
              <a
                href={sourceLink.href}
                style={{ color: "var(--accent)", fontSize: 12, textDecoration: "none", alignSelf: "center" }}
              >
                {sourceLink.label}
              </a>
            )}
            <Button type="button" variant="ghost" loading={suggesting} onClick={() => void onSuggest()}>
              Suggest priority
            </Button>
          </div>
        </div>
        <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
          {confirmDelete ? (
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
              <span style={{ color: "var(--ink-dim)", fontSize: 12 }}>Delete this task permanently?</span>
              <div style={{ display: "flex", gap: 8 }}>
                <Button type="button" variant="ghost" onClick={() => setConfirmDelete(false)} disabled={!!saving}>Cancel</Button>
                <Button type="button" variant="danger" loading={saving === "delete"} onClick={() => void onDelete()}>Delete</Button>
              </div>
            </div>
          ) : (
            <Button type="button" variant="danger" onClick={() => setConfirmDelete(true)} disabled={!!saving}>Delete task</Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function AgendaModule() {
  const { tasks, addTask, updateTask, toggleDone, deleteTask, error: taskError, clearError: clearTaskError } = useTasks();
  const { people } = usePeople();
  const dueContacts = people.filter((p) => personIsDue(p)).sort((a, b) => {
    const da = a.follow_up_on ?? "9999";
    const db = b.follow_up_on ?? "9999";
    return da.localeCompare(db);
  });
  const { toast } = useToast();
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [todayEvents, setTodayEvents] = useState<ScheduleEvent[]>([]);
  const [todayEventsLoading, setTodayEventsLoading] = useState(true);
  const [todayEventsError, setTodayEventsError] = useState<string | null>(null);
  const [routine, setRoutine] = useState<RoutineStep[]>(DEFAULT_ROUTINE);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [tuneOpen, setTuneOpen] = useState(false);
  const [newStep, setNewStep] = useState("");
  const [nightRoutine, setNightRoutine] = useState<RoutineStep[]>(DEFAULT_NIGHT_ROUTINE);
  const [nightChecks, setNightChecks] = useState<Record<string, boolean>>({});
  const [nightTuneOpen, setNightTuneOpen] = useState(false);
  const [newNightStep, setNewNightStep] = useState("");
  const [filterPri, setFilterPri] = useState<string>("all");
  const [statFilter, setStatFilter] = useState<"open" | "overdue" | "done" | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [rebuildingMorning, setRebuildingMorning] = useState(false);
  const [rebuildingNight, setRebuildingNight] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskAction, setTaskAction] = useState<"save" | "toggle" | "delete" | null>(null);
  const [schedulingTask, setSchedulingTask] = useState(false);
  const [suggestingTask, setSuggestingTask] = useState(false);

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? null,
    [selectedTaskId, tasks],
  );

  useEffect(() => {
    if (selectedTaskId && !selectedTask) setSelectedTaskId(null);
  }, [selectedTask, selectedTaskId]);

  useEffect(() => {
    if (taskError) toast(taskError.message, "error", "Agenda");
  }, [taskError, toast]);

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

  // CAL-4: today's owned schedule_events (live) + last-known external events
  // from calendar_event_cache (CAL-3's cache-first table) — real data for the
  // merged Today ranking, not a placeholder. A live external re-fetch isn't
  // triggered from here; Schedule keeps that cache warm on its own visits.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setTodayEventsLoading(true);
      setTodayEventsError(null);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        if (!cancelled) { setTodayEvents([]); setTodayEventsLoading(false); }
        return;
      }

      try {
        const merged = await fetchTodayMergedEvents(supabase, user.id, new Date());
        if (cancelled) return;
        setTodayEvents(merged.map((event) => ({
          id: event.id,
          title: event.title,
          description: event.description ?? null,
          location: null,
          attendees: [],
          start_at: event.start_at,
          end_at: event.end_at,
          color_class: (event.color_class as "a" | "b" | "c" | "or") || "a",
          all_day: event.all_day ?? false,
          ...(event.source ? { source: event.source } : {}),
        })));
      } catch {
        if (!cancelled) setTodayEventsError("Could not load today's events.");
      } finally {
        if (!cancelled) setTodayEventsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [supabase]);

  const saveNightRoutine = useCallback(async (steps: RoutineStep[]) => {
    setNightRoutine(steps);
    localStorage.setItem("axis-night-routine", JSON.stringify(steps));
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      await supabase.from("user_preferences").upsert({ user_id: user.id, night_routine: steps, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    }
  }, [supabase]);

  const toggleNightCheck = (id: string) => {
    const key = todayKey();
    const next = { ...nightChecks, [id]: !nightChecks[id] };
    setNightChecks(next);
    localStorage.setItem(`axis-night-routine-checks-${key}`, JSON.stringify(next));
    const persistNight = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { error } = await supabase.from("user_preferences").upsert({ user_id: user.id, night_routine_checks: { [key]: next }, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
      if (error) toast("Night routine check could not sync to Supabase.", "error", "Routine");
    };
    persistNight().catch(() => toast("Night routine check could not sync.", "error", "Routine"));
  };

  const saveRoutine = useCallback(async (steps: RoutineStep[]) => {
    setRoutine(steps);
    localStorage.setItem("axis-morning-routine", JSON.stringify(steps));
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      await supabase.from("user_preferences").upsert({ user_id: user.id, morning_routine: steps, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    }
  }, [supabase]);

  const toggleCheck = (id: string) => {
    const key = todayKey();
    // Side effects stay outside the state updater (StrictMode double-invokes updaters)
    const next = { ...checks, [id]: !checks[id] };
    setChecks(next);
    localStorage.setItem(`axis-routine-checks-${key}`, JSON.stringify(next));
    persistChecks(key, next).catch(() => toast("Morning routine check could not sync.", "error", "Routine"));
  };

  // Only today's checks are kept server-side — yesterday's reset is intentional
  const persistChecks = async (key: string, next: Record<string, boolean>) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { error } = await supabase
      .from("user_preferences")
      .upsert(
        { user_id: user.id, routine_checks: { [key]: next }, updated_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );
    if (error) throw error;
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
  const doneToday = doneTodayTasks(tasks);
  const allDone = tasks.filter((t) => t.status === "done");

  const activePool = statFilter === "overdue" ? overdue : statFilter === "done" ? doneToday : open;
  const filtered = filterPri === "all" ? activePool : activePool.filter((t) => t.priority === filterPri);
  const todayItems = useMemo(
    () => buildTodayRanking(todayEvents, tasks, dueContacts, new Date(), 8),
    [todayEvents, tasks, dueContacts],
  );

  const rebuildRoutine = useCallback(
    async (type: "morning" | "night") => {
      const isNight = type === "night";
      if (isNight) setRebuildingNight(true);
      else setRebuildingMorning(true);
      try {
        const res = await fetch("/api/agenda/rebuild", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type,
            currentSteps: isNight ? nightRoutine : routine,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.steps) {
          toast(data.error === "Unauthorized" ? "Sign in to use AI rebuild." : "AI rebuild failed — try again.", "error", "Routine");
          return;
        }
        if (isNight) {
          await saveNightRoutine(data.steps);
        } else {
          await saveRoutine(data.steps);
        }
        toast(`${isNight ? "Night" : "Morning"} routine rebuilt by AI.`, "success", "Routine");
      } catch {
        toast("Network error — try again.", "error", "Routine");
      } finally {
        if (isNight) setRebuildingNight(false);
        else setRebuildingMorning(false);
      }
    },
    [routine, nightRoutine, toast, saveRoutine, saveNightRoutine],
  );

  const handleToggleTask = useCallback(async (id: string) => {
    clearTaskError();
    setTaskAction("toggle");
    try {
      const updated = await toggleDone(id);
      if (updated) toast(updated.status === "done" ? "Task completed." : "Task reopened.", "success", "Agenda");
    } finally {
      setTaskAction(null);
    }
  }, [clearTaskError, toast, toggleDone]);

  const handleDeleteTask = useCallback(async (id: string) => {
    clearTaskError();
    setTaskAction("delete");
    try {
      const deleted = await deleteTask(id);
      if (deleted) {
        setSelectedTaskId((current) => (current === id ? null : current));
        toast("Task deleted.", "success", "Agenda");
      }
    } finally {
      setTaskAction(null);
    }
  }, [clearTaskError, deleteTask, toast]);

  const handleSaveTask = useCallback(async (
    id: string,
    patch: Pick<Task, "title" | "priority" | "category"> & { effort: string | null; deadline: string | null },
  ) => {
    clearTaskError();
    setTaskAction("save");
    try {
      const updated = await updateTask(id, patch);
      if (updated) toast("Task updated.", "success", "Agenda");
    } finally {
      setTaskAction(null);
    }
  }, [clearTaskError, toast, updateTask]);

  const handleScheduleTask = useCallback(async (task: Task) => {
    clearTaskError();
    setSchedulingTask(true);
    try {
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) {
        toast("Sign in to schedule tasks.", "error", "Agenda");
        return;
      }
      const start = defaultFocusStart(task);
      const end = new Date(start.getTime() + effortToMinutes(task.effort) * 60_000);
      const { data, error } = await supabase
        .from("schedule_events")
        .insert({
          user_id: user.id,
          title: `Focus: ${task.title}`,
          description: "Created from Agenda task.",
          start_at: start.toISOString(),
          end_at: end.toISOString(),
          color_class: task.priority === "hi" ? "b" : "a",
        })
        .select("id")
        .single();
      if (error || !data) {
        Sentry.captureException(new Error("Agenda task scheduling failed"), {
          tags: { area: "agenda", operation: "schedule_task", supabase_code: error?.code ?? "unknown" },
          extra: { task_id: task.id },
        });
        toast("Could not schedule task — check your connection and retry.", "error", "Agenda");
        return;
      }
      await updateTask(task.id, {
        metadata: {
          ...(task.metadata ?? {}),
          scheduled_event_id: data.id,
          scheduled_at: new Date().toISOString(),
        },
      });
      toast("Focus block added to Schedule.", "success", "Agenda");
    } finally {
      setSchedulingTask(false);
    }
  }, [clearTaskError, supabase, toast, updateTask]);

  const handleSuggestTask = useCallback(async (task: Task) => {
    clearTaskError();
    setSuggestingTask(true);
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "triage",
          text: task.title,
          body: JSON.stringify({
            effort: task.effort,
            deadline: task.deadline,
          }),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<Pick<Task, "title" | "priority" | "category">> & { effort?: string; error?: string };
      const category = normalizeTaskCategory(data.category);
      if (!res.ok || !data.priority || !category) {
        toast(data.error ?? "AI suggestion unavailable — try again.", "error", "Agenda");
        return;
      }
      const updated = await updateTask(task.id, {
        priority: data.priority,
        category,
        effort: data.effort ?? task.effort,
        metadata: {
          ...(task.metadata ?? {}),
          ai_suggested_at: new Date().toISOString(),
        },
      });
      if (updated) toast("AI suggestion applied.", "success", "Agenda");
    } catch (error) {
      Sentry.captureException(error, {
        tags: { area: "agenda", operation: "suggest_task" },
        extra: { task_id: task.id },
      });
      toast("AI suggestion failed — check your connection and retry.", "error", "Agenda");
    } finally {
      setSuggestingTask(false);
    }
  }, [clearTaskError, toast, updateTask]);

  const parseAndAdd = useCallback(async (title: string, category: TaskCategory) => {
    const lower = title.toLowerCase();
    let priority: "hi" | "med" | "lo" = "med";
    if (/high|urgent/.test(lower)) priority = "hi";
    if (/low/.test(lower)) priority = "lo";
    clearTaskError();
    const created = await addTask({ title, category, priority });
    if (created) toast("Task added.", "success", "Agenda");
  }, [addTask, clearTaskError, toast]);

  const addResearch = useCallback((t: string) => parseAndAdd(t, "research"), [parseAndAdd]);
  const addClinical = useCallback((t: string) => parseAndAdd(t, "life"), [parseAndAdd]);

  return (
    <>
      <div className="divider" />
      <h2 className="sec" style={{ marginBottom: 14 }}>
        Today<span className="rule" />
        {!todayEventsLoading && !todayEventsError && <span className="count">{todayItems.length}</span>}
      </h2>
      <div className="card" style={{ marginBottom: 16 }}>
        {todayEventsLoading ? (
          <div className="empty-state" style={{ padding: "12px 0" }}>Loading today…</div>
        ) : todayEventsError ? (
          <div className="empty-state" style={{ padding: "12px 0", color: "var(--clay)" }}>{todayEventsError}</div>
        ) : todayItems.length === 0 ? (
          <div className="empty-state" style={{ padding: "12px 0" }}>Nothing on deck — add a task, schedule an event, or check People.</div>
        ) : (
          <div className="tasklist">
            {todayItems.map((item) => (
              <TodayRow
                key={`${item.kind}-${item.id}`}
                item={item}
                onToggleTask={handleToggleTask}
                onOpenTask={setSelectedTaskId}
                onNavigate={(href) => router.push(href)}
              />
            ))}
          </div>
        )}
      </div>
      <div className="stat-strip">
        <div
          className={`card stat tick${statFilter === null ? " on" : ""}`}
          style={{ cursor: "pointer" }}
          onClick={() => setStatFilter(statFilter === null ? null : null)}
          title="Show open tasks"
        >
          <div className="sv">{open.length}</div>
          <div className="sk">Open</div>
        </div>
        <div
          className={`card stat${statFilter === "overdue" ? " tick on" : ""}`}
          style={{ cursor: "pointer" }}
          onClick={() => setStatFilter((f) => f === "overdue" ? null : "overdue")}
          title="Show overdue tasks"
        >
          <div className="sv">{overdue.length}</div>
          <div className="sk">Overdue</div>
        </div>
        <div
          className={`card stat${statFilter === "done" ? " tick on" : ""}`}
          style={{ cursor: "pointer" }}
          onClick={() => setStatFilter((f) => f === "done" ? null : "done")}
          title="Show tasks completed today"
        >
          <div className="sv">{doneToday.length}</div>
          <div className="sk">Done today</div>
        </div>
      </div>
      <div className="chips" style={{ marginBottom: 12 }}>
        {["all", "hi", "med", "lo"].map((p) => (
          <button
            key={p}
            type="button"
            className={filterPri === p ? "chip on" : "chip"}
            aria-pressed={filterPri === p}
            onClick={() => setFilterPri(p)}
          >
            {p === "all" ? "All priorities" : p.toUpperCase()}
          </button>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16, alignItems: "start" }}>
        <TaskBlock title="Research" category="research" tasks={filtered} onAdd={addResearch} onToggle={handleToggleTask} onDelete={handleDeleteTask} onOpen={setSelectedTaskId} />
        <TaskBlock title="Clinical & Life" category="clinical" tasks={filtered} onAdd={addClinical} onToggle={handleToggleTask} onDelete={handleDeleteTask} onOpen={setSelectedTaskId} />
      </div>

      {allDone.length > 0 && (
        <>
          <div className="divider" style={{ marginTop: 8 }} />
          <div
            className="seclabel"
            style={{ cursor: "pointer", userSelect: "none" }}
            role="button"
            tabIndex={0}
            aria-expanded={historyOpen}
            aria-controls="agenda-history-list"
            onClick={() => setHistoryOpen((o) => !o)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setHistoryOpen((o) => !o);
              }
            }}
          >
            History
            <span className="rule" style={{ background: "var(--line)" }} />
            <span style={{ fontFamily: "var(--mono)", fontSize: "9.5px" }}>
              {allDone.length} completed · {historyOpen ? "▲ hide" : "▼ show"}
            </span>
          </div>
          {historyOpen && (
            <div id="agenda-history-list" style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              {allDone.map((t) => (
                <div key={t.id} className="task done" style={{ opacity: 0.6 }}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={true}
                    aria-label={`Reopen "${t.title}"`}
                    className="check done"
                    onClick={() => void handleToggleTask(t.id)}
                    title="Reopen"
                    style={{ background: "var(--accent)", padding: 0 }}
                  />
                  <div className="task-main">
                    <button
                      type="button"
                      style={TASK_OPEN_STYLE}
                      onClick={() => setSelectedTaskId(t.id)}
                      aria-label={`Open details for "${t.title}"`}
                    >
                      <div className="task-title" style={{ textDecoration: "line-through" }}>{t.title}</div>
                      <div className="task-meta">
                        {t.completed_at
                          ? new Date(t.completed_at).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                          : "completed"}
                      </div>
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleDeleteTask(t.id)}
                    title="Delete"
                    style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--ink-faint)", cursor: "pointer", fontSize: 14, padding: "0 4px" }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <div className="divider" />
      <h2 className="sec" style={{ marginBottom: 14 }}>Reach Out<span className="rule" /><span className="count">{dueContacts.length} due</span></h2>
      <div className="card">
        {dueContacts.length === 0 ? (
          <div className="empty-state" style={{ padding: "12px 0" }}>No follow-ups due — add contacts with follow-up dates in People.</div>
        ) : dueContacts.map((p) => (
          <div key={p.id} className="outreach-row">
            <div className="or-av">{(p.name[0] ?? "?").toUpperCase()}</div>
            <div className="or-b"><div className="or-n">{p.name}</div><div className="or-w">{p.note || p.role}</div></div>
            <span className="or-due">{personFootLabel(p)}</span>
            <button type="button" className="or-go">Message</button>
          </div>
        ))}
      </div>
      <div className="divider" />
      <h2 className="sec" style={{ marginBottom: 14 }}>Morning Routine<span className="rule" /><span className="count">~75 min · {doneCount}/{routine.length}</span></h2>
      <div className="routine-grid">
        <div className="card mr-card tick">
          {/* autoScroll off: fixed-position shell elements trigger dnd-kit's scroll warning, and the list is short */}
          <DndContext id="agenda-morning-routine" sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} autoScroll={false}>
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
          <button
            type="button"
            className="aibtn"
            disabled={rebuildingMorning}
            onClick={() => void rebuildRoutine("morning")}
          >
            {rebuildingMorning ? "✦ Rebuilding…" : "✦ Rebuild with AI"}
          </button>
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
          <button
            type="button"
            className="savebtn"
            style={{ marginTop: 8 }}
            onClick={() => setTuneOpen(!tuneOpen)}
            aria-expanded={tuneOpen}
            aria-controls="morning-routine-editor"
          >
            {tuneOpen ? "Hide editor" : "Edit times & titles"}
          </button>
          {tuneOpen && (
          <div id="morning-routine-editor">
          {routine.map((s, i) => (
            <div key={s.id} style={{ display: "grid", gridTemplateColumns: "60px 1fr auto", gap: 8, marginTop: 8, alignItems: "center" }}>
              <input aria-label="Step time" value={s.time} onChange={(e) => {
                const next = [...routine];
                next[i] = { ...s, time: e.target.value };
                saveRoutine(next);
              }} style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 4, padding: 4, color: "var(--ink)" }} />
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <input aria-label="Step title" value={s.title} onChange={(e) => {
                  const next = [...routine];
                  next[i] = { ...s, title: e.target.value };
                  saveRoutine(next);
                }} style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 4, padding: 4, color: "var(--ink)" }} />
                <input aria-label="Step sub-note" value={s.sub} placeholder="Sub-note (optional)" onChange={(e) => {
                  const next = [...routine];
                  next[i] = { ...s, sub: e.target.value };
                  saveRoutine(next);
                }} style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 4, padding: 4, color: "var(--ink-dim)", fontSize: 11 }} />
              </div>
              <button
                type="button"
                onClick={() => saveRoutine(routine.filter((_, j) => j !== i))}
                title="Delete step"
                aria-label="Delete step"
                style={{ background: "none", border: "none", color: "var(--ink-faint)", cursor: "pointer", fontSize: 16, padding: "0 2px", lineHeight: 1 }}
              >
                ×
              </button>
            </div>
          ))}
          </div>
          )}
        </div>
      </div>

      <div className="divider" />
      <h2 className="sec" style={{ marginBottom: 14 }}>Nighttime Routine<span className="rule" /><span className="count">~90 min · {nightDoneCount}/{nightRoutine.length}</span></h2>
      <div className="routine-grid">
        <div className="card mr-card tick">
          <DndContext id="agenda-night-routine" sensors={sensors} collisionDetection={closestCenter} onDragEnd={onNightDragEnd} autoScroll={false}>
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
          <button
            type="button"
            className="aibtn"
            disabled={rebuildingNight}
            onClick={() => void rebuildRoutine("night")}
          >
            {rebuildingNight ? "✦ Rebuilding…" : "✦ Rebuild with AI"}
          </button>
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
          <button
            type="button"
            className="savebtn"
            style={{ marginTop: 8 }}
            onClick={() => setNightTuneOpen(!nightTuneOpen)}
            aria-expanded={nightTuneOpen}
            aria-controls="night-routine-editor"
          >
            {nightTuneOpen ? "Hide editor" : "Edit times & titles"}
          </button>
          {nightTuneOpen && (
          <div id="night-routine-editor">
          {nightRoutine.map((s, i) => (
            <div key={s.id} style={{ display: "grid", gridTemplateColumns: "60px 1fr auto", gap: 8, marginTop: 8, alignItems: "center" }}>
              <input aria-label="Step time" value={s.time} onChange={(e) => {
                const next = [...nightRoutine];
                next[i] = { ...s, time: e.target.value };
                saveNightRoutine(next);
              }} style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 4, padding: 4, color: "var(--ink)" }} />
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <input aria-label="Step title" value={s.title} onChange={(e) => {
                  const next = [...nightRoutine];
                  next[i] = { ...s, title: e.target.value };
                  saveNightRoutine(next);
                }} style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 4, padding: 4, color: "var(--ink)" }} />
                <input aria-label="Step sub-note" value={s.sub} placeholder="Sub-note (optional)" onChange={(e) => {
                  const next = [...nightRoutine];
                  next[i] = { ...s, sub: e.target.value };
                  saveNightRoutine(next);
                }} style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 4, padding: 4, color: "var(--ink-dim)", fontSize: 11 }} />
              </div>
              <button
                type="button"
                onClick={() => saveNightRoutine(nightRoutine.filter((_, j) => j !== i))}
                title="Delete step"
                aria-label="Delete step"
                style={{ background: "none", border: "none", color: "var(--ink-faint)", cursor: "pointer", fontSize: 16, padding: "0 2px", lineHeight: 1 }}
              >
                ×
              </button>
            </div>
          ))}
          </div>
          )}
        </div>
      </div>
      <TaskDetailModal
        task={selectedTask}
        open={!!selectedTask}
        saving={taskAction}
        scheduling={schedulingTask}
        suggesting={suggestingTask}
        onClose={() => setSelectedTaskId(null)}
        onSave={(patch) => selectedTask ? handleSaveTask(selectedTask.id, patch) : Promise.resolve()}
        onToggle={() => selectedTask ? handleToggleTask(selectedTask.id) : Promise.resolve()}
        onDelete={() => selectedTask ? handleDeleteTask(selectedTask.id) : Promise.resolve()}
        onSchedule={() => selectedTask ? handleScheduleTask(selectedTask) : Promise.resolve()}
        onSuggest={() => selectedTask ? handleSuggestTask(selectedTask) : Promise.resolve()}
      />
    </>
  );
}
