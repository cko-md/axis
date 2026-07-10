"use client";

import * as Sentry from "@sentry/nextjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNotes } from "@/lib/hooks/useNotes";
import { useTasks } from "@/lib/hooks/useTasks";
import { useObjectives } from "@/lib/hooks/useObjectives";
import { useToast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import { buildAiRequestBody } from "@/lib/ai/actions";

const DEBRIEF_FOLDER = "Debrief";
const REMINDER_KEY   = "debrief-reminder";
const DEFAULT_DAY    = 0;  // Sunday
const DEFAULT_HOUR   = 19; // 7 PM

const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

type ReviewType = "daily" | "weekly";

type DebriefEntry = {
  id: string;
  user_id: string;
  review_date: string;
  review_type: ReviewType;
  wins: string;
  challenges: string;
  focus: string;
  summary: string;
  completed_task_ids: string[];
  missed_task_ids: string[];
  calendar_event_ids: string[];
  objective_ids: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

type ScheduleEvent = {
  id: string;
  title: string;
  description: string | null;
  start_at: string;
  end_at: string;
};

type ExternalEvent = {
  id?: string;
  externalId?: string;
  title?: string;
  summary?: string;
  start?: string;
  start_at?: string;
  end?: string;
  end_at?: string;
  source?: string;
};

function localIsoDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayBounds(date: string) {
  const start = new Date(`${date}T00:00:00`);
  const end = new Date(`${date}T23:59:59.999`);
  return { start, end };
}

function nextOccurrence(dayOfWeek: number, hour = 19): Date {
  const now   = new Date();
  const today = now.getDay();
  let daysUntil = (dayOfWeek - today + 7) % 7;
  if (daysUntil === 0 && now.getHours() >= hour) daysUntil = 7;
  const next = new Date(now);
  next.setDate(now.getDate() + daysUntil);
  next.setHours(hour, 0, 0, 0);
  return next;
}

async function readAiSummary(res: Response): Promise<string> {
  if (!res.ok) {
    throw new Error(`AI summary request failed: ${res.status}`);
  }
  const data = (await res.json()) as { summary?: string };
  const summary = data.summary?.trim();
  if (!summary) throw new Error("AI summary response was empty");
  if (/API key required|check your API key/i.test(summary)) {
    throw new Error("AI summary unavailable — configure a model key in Control Room.");
  }
  return summary;
}

type DebriefReminderPrefs = { day: number; hour: number; taskId?: string | null };

const DEMO_WINS = ["AANS abstract submitted", "Cohort 2 chart review (80%)", "4 zone-2 runs · 38 km"];
const DEMO_FRICTION = [
  { title: "Data-use agreement signature", badge: "2 weeks idle", cls: "hi" },
  { title: "IRB amendment — UIA cohort",   badge: "blocked on PI",  cls: "med" },
];

/* ---------- small sub-components ---------- */

function PromptField({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <div style={{ marginBottom: 22 }}>
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: ".1em",
          color: "var(--ink-faint)",
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <textarea
        placeholder={placeholder}
        rows={4}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          width: "100%",
          padding: "12px 15px",
          background: "var(--glass)",
          border: `1px solid ${focused ? "var(--line-strong)" : "var(--line)"}`,
          borderRadius: "var(--r)",
          color: "var(--ink)",
          fontFamily: "var(--serif)",
          fontSize: 14,
          lineHeight: 1.65,
          resize: "vertical",
          outline: "none",
          transition: "border-color .15s",
          boxSizing: "border-box",
        }}
      />
    </div>
  );
}

function PastReflectionRow({ note }: { note: { id: string; title: string; body: string; created_at: string } }) {
  const [expanded, setExpanded] = useState(false);
  const date = new Date(note.created_at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div
      style={{
        borderTop: "1px solid var(--line)",
        paddingTop: 10,
        paddingBottom: 10,
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span
          style={{
            fontFamily: "var(--serif)",
            fontSize: 13.5,
            color: "var(--ink)",
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {note.title}
        </span>
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            color: "var(--ink-faint)",
            flexShrink: 0,
            letterSpacing: ".03em",
          }}
        >
          {date}
        </span>
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            color: "var(--ink-faint)",
            flexShrink: 0,
            lineHeight: 1,
          }}
        >
          {expanded ? "▲" : "▼"}
        </span>
      </button>

      {expanded && note.body && (
        <div
          style={{
            marginTop: 10,
            padding: "10px 13px",
            background: "var(--surface-2)",
            borderRadius: "var(--r)",
            fontFamily: "var(--serif)",
            fontSize: 13.5,
            lineHeight: 1.7,
            color: "var(--ink-dim)",
            whiteSpace: "pre-wrap",
          }}
        >
          {note.body}
        </div>
      )}
    </div>
  );
}

/* ---------- main component ---------- */

export function DebriefModule() {
  const supabase = useMemo(() => createClient(), []);
  const { notes, refresh: refreshNotes } = useNotes();
  const { tasks, loading, addTask, updateTask, toggleDone, deleteTask } = useTasks();
  const { objectives } = useObjectives();
  const { toast }                  = useToast();

  const [signedIn,      setSignedIn]      = useState(false);
  const [reviewDate,    setReviewDate]    = useState(localIsoDay());
  const [dailyEntry,    setDailyEntry]    = useState<DebriefEntry | null>(null);
  const [dailyWins,     setDailyWins]     = useState("");
  const [dailyChallenges, setDailyChallenges] = useState("");
  const [dailyFocus,    setDailyFocus]    = useState("");
  const [dailySummary,  setDailySummary]  = useState("");
  const [dailySaving,   setDailySaving]   = useState(false);
  const [dailyLoading,  setDailyLoading]  = useState(false);
  const [dailyLoadError, setDailyLoadError] = useState<string | null>(null);
  const [weeklySummaryError, setWeeklySummaryError] = useState<string | null>(null);
  const [dailyEntries, setDailyEntries] = useState<DebriefEntry[]>([]);
  const [events,        setEvents]        = useState<ScheduleEvent[]>([]);
  const [externalEvents, setExternalEvents] = useState<ExternalEvent[]>([]);
  const [eventError,    setEventError]    = useState<string | null>(null);
  const [nextAction,    setNextAction]    = useState("");
  const [wins,          setWins]          = useState("");
  const [challenges,    setChallenges]    = useState("");
  const [focus,         setFocus]         = useState("");
  const [saving,        setSaving]        = useState(false);
  const [reminderDay,   setReminderDay]   = useState(DEFAULT_DAY);
  const [reminderHour,  setReminderHour]  = useState(DEFAULT_HOUR);
  const [reminderSet,   setReminderSet]   = useState(false);
  const [reminderTaskId, setReminderTaskId] = useState<string | null>(null);
  const [showConfig,    setShowConfig]    = useState(false);
  const [pastOpen,      setPastOpen]      = useState(false);
  const [aiSummary,     setAiSummary]     = useState<string | null>(null);
  const [summarizing,   setSummarizing]   = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setSignedIn(!!data.user));
  }, [supabase]);

  const selectedBounds = useMemo(() => dayBounds(reviewDate), [reviewDate]);

  const completedToday = useMemo(
    () => tasks.filter((t) => {
      const doneAt = t.completed_at ?? (t.status === "done" ? t.updated_at : null);
      if (!doneAt) return false;
      const time = new Date(doneAt).getTime();
      return time >= selectedBounds.start.getTime() && time <= selectedBounds.end.getTime();
    }),
    [selectedBounds, tasks],
  );

  const missedToday = useMemo(
    () => tasks.filter((t) => {
      if (t.status === "done") return false;
      if (t.status === "overdue") return true;
      if (!t.deadline) return false;
      const deadline = new Date(`${t.deadline}T23:59:59`).getTime();
      return deadline <= selectedBounds.end.getTime();
    }),
    [selectedBounds, tasks],
  );

  const dueObjectives = useMemo(
    () => objectives.filter((objective) => objective.key_results.some((kr) => kr.current_value < kr.target_value)).slice(0, 4),
    [objectives],
  );

  const loadDailyReview = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    setSignedIn(!!user);
    if (!user) return;
    setDailyLoading(true);
    setDailyLoadError(null);
    setEventError(null);
    const [{ data: entry, error: entryError }, { data: localEvents, error: eventsError }] = await Promise.all([
      supabase
        .from("debrief_entries")
        .select("*")
        .eq("user_id", user.id)
        .eq("review_date", reviewDate)
        .eq("review_type", "daily")
        .maybeSingle(),
      supabase
        .from("schedule_events")
        .select("id,title,description,start_at,end_at")
        .eq("user_id", user.id)
        .gte("start_at", selectedBounds.start.toISOString())
        .lte("start_at", selectedBounds.end.toISOString())
        .order("start_at", { ascending: true }),
    ]);
    if (entryError) {
      setDailyLoadError("Could not load today's debrief.");
      Sentry.captureException(entryError, { tags: { area: "debrief", op: "load_daily_entry" } });
    }
    if (eventsError) {
      setEventError("Local calendar events could not be loaded.");
    }
    const row = entry as DebriefEntry | null;
    setDailyEntry(row);
    setDailyWins(row?.wins ?? "");
    setDailyChallenges(row?.challenges ?? "");
    setDailyFocus(row?.focus ?? "");
    setDailySummary(row?.summary ?? "");
    setEvents((localEvents ?? []) as ScheduleEvent[]);
    try {
      const params = new URLSearchParams({
        start: selectedBounds.start.toISOString(),
        end: selectedBounds.end.toISOString(),
      });
      const res = await fetch(`/api/calendar/external?${params.toString()}`);
      if (res.ok) {
        const data = (await res.json()) as { events?: ExternalEvent[] };
        setExternalEvents(data.events ?? []);
      } else {
        setExternalEvents([]);
        setEventError("Connected calendar events could not be refreshed.");
      }
    } catch {
      setExternalEvents([]);
      setEventError("Connected calendar events could not be refreshed.");
    } finally {
      setDailyLoading(false);
    }
  }, [reviewDate, selectedBounds.end, selectedBounds.start, supabase, toast]);

  useEffect(() => {
    void loadDailyReview();
  }, [loadDailyReview]);

  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const fortAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const taskWins = tasks.filter((t) => t.status === "done" && new Date(t.updated_at).getTime() >= weekAgo)
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, 5);
  const friction = tasks.filter(
    (t) => t.status === "overdue" || (t.status === "open" && new Date(t.updated_at).getTime() < fortAgo)
  ).slice(0, 4);
  const completedCount = tasks.filter((t) => t.status === "done" && new Date(t.updated_at).getTime() >= weekAgo).length;
  const openCount = tasks.filter((t) => t.status === "open" || t.status === "overdue").length;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setDailyEntries([]);
        return;
      }
      const { data, error } = await supabase
        .from("debrief_entries")
        .select("id, review_date, wins, challenges, focus, summary, updated_at, review_type")
        .eq("user_id", user.id)
        .eq("review_type", "daily")
        .order("review_date", { ascending: false })
        .limit(20);
      if (!cancelled) {
        if (error) Sentry.captureException(error, { tags: { area: "debrief", op: "load_daily_history" } });
        else setDailyEntries((data ?? []) as DebriefEntry[]);
      }
    })();
    return () => { cancelled = true; };
  }, [supabase, dailyEntry?.updated_at]);

  const loadReminderPrefs = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from("user_preferences")
      .select("debrief_reminder")
      .eq("user_id", user.id)
      .maybeSingle();
    const prefs = (data as { debrief_reminder?: DebriefReminderPrefs | null } | null)?.debrief_reminder;
    if (prefs && typeof prefs.day === "number" && typeof prefs.hour === "number") {
      setReminderDay(prefs.day);
      setReminderHour(prefs.hour);
      setReminderTaskId(prefs.taskId ?? null);
      setReminderSet(true);
      return;
    }
    try {
      const stored = localStorage.getItem(REMINDER_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as DebriefReminderPrefs;
        setReminderDay(parsed.day ?? DEFAULT_DAY);
        setReminderHour(parsed.hour ?? DEFAULT_HOUR);
        setReminderTaskId(parsed.taskId ?? null);
        setReminderSet(true);
      }
    } catch { /* ignore */ }
  }, [supabase]);

  useEffect(() => {
    void loadReminderPrefs();
  }, [loadReminderPrefs]);

  const persistReminderPrefs = useCallback(async (prefs: DebriefReminderPrefs) => {
    localStorage.setItem(REMINDER_KEY, JSON.stringify(prefs));
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return true;
    const { error } = await supabase.from("user_preferences").upsert({
      user_id: user.id,
      debrief_reminder: prefs,
      updated_at: new Date().toISOString(),
    } as never, { onConflict: "user_id" });
    if (error) {
      toast("Reminder saved on this device only — cloud sync failed.", "warn", "Debrief");
      return false;
    }
    return true;
  }, [supabase, toast]);

  // Past reflections: weekly notes + saved daily debrief entries
  const pastReflections = useMemo(() => {
    const weekly = notes
      .filter((n) => n.folder === DEBRIEF_FOLDER)
      .map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body ?? "",
        created_at: n.created_at,
        kind: "weekly" as const,
      }));
    const daily = dailyEntries.map((entry) => ({
      id: entry.id,
      title: `Daily · ${entry.review_date}`,
      body: [entry.wins, entry.challenges, entry.focus, entry.summary].filter(Boolean).join("\n\n"),
      created_at: entry.updated_at,
      kind: "daily" as const,
    }));
    return [...weekly, ...daily].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [notes, dailyEntries]);

  const generateWeeklySummary = async () => {
    const last7 = pastReflections.slice(0, 7);
    if (last7.length === 0) { toast("No past reflections to summarize.", "warn", "Debrief"); return; }
    setSummarizing(true);
    setAiSummary(null);
    setWeeklySummaryError(null);
    try {
      const combined = last7.map((n) => `## ${n.title}\n${n.body}`).join("\n\n---\n\n");
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildAiRequestBody("debriefSummary", { text: combined.slice(0, 6000) })),
      });
      setAiSummary(await readAiSummary(res));
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error("Weekly debrief summary failed"), {
        tags: { area: "debrief", op: "weekly_summary" },
      });
      setWeeklySummaryError(error instanceof Error ? error.message : "Weekly summary is unavailable right now.");
    } finally {
      setSummarizing(false);
    }
  };

  const allCalendarEvents = useMemo(
    () => [
      ...events.map((event) => ({
        id: event.id,
        title: event.title,
        start: event.start_at,
        source: "axis",
      })),
      ...externalEvents.map((event) => ({
        id: event.id ?? event.externalId ?? `${event.source ?? "calendar"}-${event.start_at ?? event.start ?? event.title ?? "event"}`,
        title: event.title ?? event.summary ?? "Calendar event",
        start: event.start_at ?? event.start ?? "",
        source: event.source ?? "calendar",
      })),
    ].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()),
    [events, externalEvents],
  );

  const dailyHasContent = dailyWins.trim() || dailyChallenges.trim() || dailyFocus.trim() || dailySummary.trim();

  const saveDailyReview = async () => {
    if (!dailyHasContent) {
      toast("Write a reflection first.", "warn", "Debrief");
      return;
    }
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      toast("Sign in to save debriefs.", "warn", "Debrief");
      return;
    }
    setDailySaving(true);
    const payload = {
      user_id: user.id,
      review_date: reviewDate,
      review_type: "daily" as const,
      wins: dailyWins.trim(),
      challenges: dailyChallenges.trim(),
      focus: dailyFocus.trim(),
      summary: dailySummary.trim(),
      completed_task_ids: completedToday.map((task) => task.id),
      missed_task_ids: missedToday.map((task) => task.id),
      calendar_event_ids: events.map((event) => event.id),
      objective_ids: dueObjectives.map((objective) => objective.id),
      metadata: {
        external_calendar_events: externalEvents.map((event) => ({
          id: event.id ?? event.externalId ?? null,
          title: event.title ?? event.summary ?? "Calendar event",
          source: event.source ?? "calendar",
          start: event.start_at ?? event.start ?? null,
        })),
      },
    };
    const { data, error } = await supabase
      .from("debrief_entries")
      .upsert(payload, { onConflict: "user_id,review_date,review_type" })
      .select()
      .single();
    setDailySaving(false);
    if (error || !data) {
      Sentry.captureException(error ?? new Error("Daily debrief save failed"), {
        tags: { area: "debrief", op: "save_daily_entry" },
      });
      toast("Could not save daily debrief.", "error", "Debrief");
      return;
    }
    setDailyEntry(data as DebriefEntry);
    setDailyEntries((prev) => {
      const next = prev.filter((entry) => entry.id !== (data as DebriefEntry).id);
      return [(data as DebriefEntry), ...next].sort((a, b) => b.review_date.localeCompare(a.review_date));
    });
    toast("Daily debrief saved.", "success", "Debrief");
  };

  const createTaskFromReview = async () => {
    const title = nextAction.trim() || dailyFocus.trim();
    if (!title) {
      toast("Add a next action or focus first.", "warn", "Debrief");
      return;
    }
    const task = await addTask({
      title,
      category: "personal",
      priority: "med",
      metadata: {
        source_object_type: "debrief",
        source_object_id: dailyEntry?.id ?? null,
        source_route: "/debrief",
        review_date: reviewDate,
      },
    });
    if (!task) {
      toast("Could not create task.", "error", "Debrief");
      return;
    }
    setNextAction("");
    toast("Next action added to Tasks.", "success", "Debrief");
  };

  const generateDailySummary = async () => {
    const text = [
      `Completed tasks: ${completedToday.map((task) => task.title).join("; ") || "none"}`,
      `Missed/overdue tasks: ${missedToday.map((task) => task.title).join("; ") || "none"}`,
      `Calendar: ${allCalendarEvents.map((event) => event.title).join("; ") || "none"}`,
      `Wins: ${dailyWins}`,
      `Challenges: ${dailyChallenges}`,
      `Focus: ${dailyFocus}`,
    ].join("\n");
    setSummarizing(true);
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildAiRequestBody("debriefSummary", { text: text.slice(0, 6000) })),
      });
      setDailySummary(await readAiSummary(res));
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error("Daily debrief summary failed"), {
        tags: { area: "debrief", op: "daily_summary" },
      });
      toast("AI summary is unavailable right now — try again later.", "error", "Debrief");
    } finally {
      setSummarizing(false);
    }
  };

  const hasContent = wins.trim() || challenges.trim() || focus.trim();

  const saveReflection = async () => {
    if (!hasContent) { toast("Write something first", "warn", "Debrief"); return; }
    setSaving(true);
    try {
      const now   = new Date();
      const label = now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
      const body  = [
        wins.trim()       ? `**Wins:**\n${wins.trim()}`             : "",
        challenges.trim() ? `**Challenges:**\n${challenges.trim()}` : "",
        focus.trim()      ? `**Focus:**\n${focus.trim()}`           : "",
      ].filter(Boolean).join("\n\n");
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        toast("Sign in to save reflections.", "warn", "Debrief");
        return;
      }
      const { data, error } = await supabase
        .from("notes")
        .insert({
          user_id: user.id,
          title: `Week of ${label}`,
          body,
          folder: DEBRIEF_FOLDER,
          tags: [],
        })
        .select()
        .single();
      if (error || !data) {
        Sentry.captureException(error ?? new Error("Weekly reflection save failed"), {
          tags: { area: "debrief", op: "save_weekly_reflection" },
        });
        toast("Could not save reflection.", "error", "Debrief");
        return;
      }
      toast("Reflection saved to Notes › Debrief", "success", "Debrief");
      setWins("");
      setChallenges("");
      setFocus("");
      void refreshNotes();
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error("Weekly reflection save failed"), {
        tags: { area: "debrief", op: "save_weekly_reflection" },
      });
      toast("Could not save — check your connection", "error", "Debrief");
    } finally {
      setSaving(false);
    }
  };

  const scheduleReminder = async () => {
    const next    = nextOccurrence(reminderDay, reminderHour);
    const dateStr = next.toISOString().split("T")[0];
    const label   = next.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
    const hourFmt = reminderHour === 0 ? "12 AM" : reminderHour < 12 ? `${reminderHour} AM` : reminderHour === 12 ? "12 PM" : `${reminderHour - 12} PM`;
    const title = `Weekly Debrief · Review + Plan — ${DAY_NAMES[reminderDay]} ${hourFmt}`;
    const taskPatch = {
      title,
      category: "personal" as const,
      priority: "med" as const,
      effort: "30m" as const,
      deadline: dateStr,
      metadata: {
        source_object_type: "debrief_reminder",
        source_route: "/debrief",
      },
    };

    let task = reminderTaskId && tasks.some((t) => t.id === reminderTaskId)
      ? await updateTask(reminderTaskId, taskPatch)
      : null;

    if (!task) {
      if (reminderTaskId) await deleteTask(reminderTaskId);
      task = await addTask(taskPatch as Parameters<typeof addTask>[0]);
    }

    if (!task) {
      toast("Could not add reminder to Agenda.", "error", "Debrief");
      return;
    }
    await persistReminderPrefs({ day: reminderDay, hour: reminderHour, taskId: task.id });
    setReminderTaskId(task.id);
    setReminderSet(true);
    setShowConfig(false);
    toast(`Reminder added to Agenda for ${label}`, "success", "Debrief");
  };

  const nextDate = reminderSet
    ? nextOccurrence(reminderDay, reminderHour).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })
    : null;

  return (
    <>
      <div className="divider" />
      <div className="card tick" style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
          <div>
            <div className="seclabel">Daily Debrief</div>
            <div style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 4 }}>
              {dailyEntry ? `Saved ${new Date(dailyEntry.updated_at).toLocaleString()}` : "Open today, review the facts, save the reflection."}
            </div>
          </div>
          <input
            type="date"
            value={reviewDate}
            onChange={(e) => setReviewDate(e.target.value || localIsoDay())}
            style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: "var(--r)", color: "var(--ink)", padding: "7px 10px", fontSize: 12 }}
          />
        </div>

        {dailyLoadError && (
          <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--down)" }}>
            {dailyLoadError}{" "}
            <button type="button" className="savebtn" onClick={() => void loadDailyReview()}>Retry</button>
          </p>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 18 }}>
          <div style={{ border: "1px solid var(--line)", borderRadius: "var(--r)", padding: 12, background: "var(--surface-2)" }}>
            <div className="seclabel">Completed tasks</div>
            <div className="tasklist" style={{ marginTop: 8 }}>
              {completedToday.length === 0 ? (
                <p style={{ margin: 0, fontSize: 12, color: "var(--ink-faint)" }}>No completed tasks on this date.</p>
              ) : completedToday.map((task) => (
                <div key={task.id} className="task">
                  <div className="check done" />
                  <div className="task-main">
                    <div className="task-title" style={{ textDecoration: "line-through", color: "var(--ink-faint)" }}>{task.title}</div>
                    <div className="task-meta">{task.category}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ border: "1px solid var(--line)", borderRadius: "var(--r)", padding: 12, background: "var(--surface-2)" }}>
            <div className="seclabel">Missed / overdue</div>
            <div className="tasklist" style={{ marginTop: 8 }}>
              {missedToday.length === 0 ? (
                <p style={{ margin: 0, fontSize: 12, color: "var(--ink-faint)" }}>No missed tasks.</p>
              ) : missedToday.slice(0, 6).map((task) => (
                <div key={task.id} className="task">
                  <button type="button" className="check" aria-label={`Mark ${task.title} done`} onClick={() => toggleDone(task.id)} />
                  <div className="task-main">
                    <div className="task-title">{task.title}</div>
                    <div className="task-meta">{task.deadline ?? "no deadline"} · {task.status}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ border: "1px solid var(--line)", borderRadius: "var(--r)", padding: 12, background: "var(--surface-2)" }}>
            <div className="seclabel">Calendar</div>
            <div className="tasklist" style={{ marginTop: 8 }}>
              {dailyLoading ? (
                <p style={{ margin: 0, fontSize: 12, color: "var(--ink-faint)" }}>Loading calendar…</p>
              ) : allCalendarEvents.length === 0 ? (
                <p style={{ margin: 0, fontSize: 12, color: "var(--ink-faint)" }}>{eventError ?? "No events on this date."}</p>
              ) : allCalendarEvents.slice(0, 6).map((event) => (
                <div key={`${event.source}-${event.id}`} className="task">
                  <div className="task-main">
                    <div className="task-title">{event.title}</div>
                    <div className="task-meta">{event.start ? new Date(event.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "all day"} · {event.source}</div>
                  </div>
                </div>
              ))}
              {eventError && allCalendarEvents.length > 0 && (
                <p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--down)" }}>{eventError}</p>
              )}
            </div>
          </div>
        </div>

        <div style={{ maxWidth: 760 }}>
          <PromptField
            label="What went well today?"
            placeholder="Completed work, useful meetings, progress signals…"
            value={dailyWins}
            onChange={setDailyWins}
          />
          <PromptField
            label="What slipped or created friction?"
            placeholder="Missed work, blockers, context switches, energy drains…"
            value={dailyChallenges}
            onChange={setDailyChallenges}
          />
          <PromptField
            label="Next focus"
            placeholder="One concrete next action or decision for tomorrow…"
            value={dailyFocus}
            onChange={setDailyFocus}
          />
          <PromptField
            label="Summary"
            placeholder="Optional AI or personal summary…"
            value={dailySummary}
            onChange={setDailySummary}
          />
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", maxWidth: 760 }}>
          <button type="button" className="sig-go" onClick={saveDailyReview} disabled={dailySaving || !dailyHasContent} style={{ opacity: !dailyHasContent ? 0.45 : 1 }}>
            {dailySaving ? "Saving…" : dailyEntry ? "Update daily debrief" : "Save daily debrief"}
          </button>
          <button type="button" className="savebtn" onClick={generateDailySummary} disabled={summarizing}>
            {summarizing ? "Summarizing…" : "✦ Summarize"}
          </button>
          <input
            value={nextAction}
            onChange={(e) => setNextAction(e.target.value)}
            placeholder="Next action → task"
            style={{ flex: 1, minWidth: 180, background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: "var(--r)", color: "var(--ink)", padding: "8px 10px", fontSize: 12 }}
          />
          <button type="button" className="savebtn" onClick={createTaskFromReview}>Add Task</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16, alignItems: "start" }}>
        <div className="card tick">
          <h2 className="sec">Wins<span className="rule" /><span className="count">this week</span></h2>
          {!signedIn && (
            <p style={{ margin: "8px 0 0", fontSize: 11, color: "var(--ink-faint)" }}>Demo data — sign in to see your completed tasks.</p>
          )}
          <div style={{ marginTop: 12 }}>
            {signedIn && loading ? (
              <div style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 4 }}>Loading completed tasks…</div>
            ) : (!signedIn ? DEMO_WINS.map((t) => ({ id: t, title: t })) : taskWins).map((t) => (
              <div key={typeof t === "string" ? t : t.id} className="task">
                <div className="check done" />
                <div className="task-main">
                  <div className="task-title" style={{ textDecoration: "line-through", color: "var(--ink-faint)" }}>
                    {typeof t === "string" ? t : t.title}
                  </div>
                </div>
              </div>
            ))}
            {signedIn && !loading && taskWins.length === 0 && (
              <div style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 4 }}>No tasks completed this week yet.</div>
            )}
          </div>
        </div>

        <div className="card">
          <h2 className="sec">Friction<span className="rule" /><span className="count">overdue · idle</span></h2>
          {!signedIn && (
            <p style={{ margin: "8px 0 0", fontSize: 11, color: "var(--ink-faint)" }}>Demo data — sign in to triage your real friction items.</p>
          )}
          <div style={{ marginTop: 12 }}>
            {signedIn && loading ? (
              <div style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 4 }}>Loading friction items…</div>
            ) : (!signedIn ? DEMO_FRICTION.map((f) => ({ ...f, id: null })) : friction.map((t) => ({
              id: t.id,
              title: t.title,
              badge: t.status === "overdue" ? "overdue" : "14d idle",
              cls: t.status === "overdue" ? "hi" : "med",
            }))).map((f) => (
              <div key={f.id ?? f.title} className="task">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={false}
                  aria-label={`Mark "${f.title}" complete`}
                  className="check"
                  disabled={!f.id}
                  onClick={() => f.id && toggleDone(f.id)}
                  style={{ background: "none", padding: 0 }}
                />
                <div className="task-main">
                  <div className="task-title">{f.title}</div>
                  <div className="task-meta"><span className={`pill ${f.cls}`}>{f.badge}</span></div>
                </div>
                {f.id && (
                  <button
                    type="button"
                    onClick={() => deleteTask(f.id as string)}
                    title="Delete"
                    aria-label={`Delete "${f.title}"`}
                    style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--ink-faint)", cursor: "pointer", fontSize: 14, padding: "0 4px", flexShrink: 0 }}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            {signedIn && !loading && friction.length === 0 && (
              <div style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 4 }}>No friction items — clean slate.</div>
            )}
          </div>
        </div>

        <div className="card">
          <h2 className="sec">Metrics<span className="rule" /></h2>
          <div style={{ marginTop: 12 }}>
            {signedIn && loading ? (
              <div style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 4 }}>Loading metrics…</div>
            ) : signedIn ? (
              [
                ["Tasks completed", String(completedCount), completedCount > 0 ? "up" : ""],
                ["Open tasks",      String(openCount),      ""],
              ].map(([k, v, cls]) => (
                <div key={k} className="metricrow">
                  <span className="metric-k">{k}</span>
                  <span className={`metric-v${cls ? " " + cls : ""}`}>{v}</span>
                </div>
              ))
            ) : (
              <p style={{ margin: 0, fontSize: 12, color: "var(--ink-faint)" }}>Sign in to see live task metrics.</p>
            )}
          </div>
        </div>
      </div>

      <div className="divider" />

      {/* ── Weekly Reflection card ── */}
      <div className="card tick">
        {/* header row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div className="seclabel">Weekly Reflection</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {nextDate && !showConfig && (
              <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", letterSpacing: ".06em" }}>
                next: {nextDate}
              </span>
            )}
            <button
              type="button"
              className="savebtn"
              style={{ fontSize: 10.5, padding: "4px 10px" }}
              onClick={() => setShowConfig((v) => !v)}
            >
              {reminderSet ? "⏰ Reminder" : "+ Set Reminder"}
            </button>
          </div>
        </div>

        {/* reminder config panel */}
        {showConfig && (
          <div style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: "var(--r)", padding: "12px 14px", marginBottom: 16, display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 9, textTransform: "uppercase", letterSpacing: ".1em", color: "var(--ink-faint)", marginBottom: 5 }}>Day</div>
              <select
                value={reminderDay}
                onChange={(e) => setReminderDay(Number(e.target.value))}
                style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "var(--r)", padding: "5px 9px", color: "var(--ink)", fontSize: 12, fontFamily: "var(--sans)" }}
              >
                {DAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 9, textTransform: "uppercase", letterSpacing: ".1em", color: "var(--ink-faint)", marginBottom: 5 }}>Time</div>
              <select
                value={reminderHour}
                onChange={(e) => setReminderHour(Number(e.target.value))}
                style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "var(--r)", padding: "5px 9px", color: "var(--ink)", fontSize: 12, fontFamily: "var(--sans)" }}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {h === 0 ? "12:00 AM" : h < 12 ? `${h}:00 AM` : h === 12 ? "12:00 PM" : `${h - 12}:00 PM`}
                  </option>
                ))}
              </select>
            </div>
            <button type="button" className="sig-go" style={{ fontSize: 11 }} onClick={scheduleReminder}>
              Add to Agenda
            </button>
            <button type="button" className="savebtn" style={{ fontSize: 11 }} onClick={() => setShowConfig(false)}>
              Cancel
            </button>
          </div>
        )}

        {/* editorial intro line */}
        <p
          style={{
            color: "var(--ink-dim)",
            fontFamily: "var(--serif)",
            fontSize: 16,
            lineHeight: 1.5,
            marginBottom: 20,
            marginTop: 0,
            maxWidth: "68ch",
            borderLeft: "3px solid var(--accent)",
            paddingLeft: 12,
          }}
        >
          What moved the needle this week, and what will you say no to next week to protect the manuscript?
        </p>

        <div className="divider" style={{ margin: "18px 0" }} />

        {/* structured prompts */}
        <div style={{ maxWidth: 720 }}>
          <PromptField
            label="What went well?"
            placeholder="Wins, progress, moments of flow…"
            value={wins}
            onChange={setWins}
          />
          <PromptField
            label="What was hard?"
            placeholder="Blockers, friction, energy drains…"
            value={challenges}
            onChange={setChallenges}
          />
          <PromptField
            label="Priority for next week?"
            placeholder="One clear focus, one thing you'll protect…"
            value={focus}
            onChange={setFocus}
          />
        </div>

        {/* save button */}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4, maxWidth: 720 }}>
          <button
            type="button"
            className="sig-go"
            onClick={saveReflection}
            disabled={saving || !hasContent}
            style={{ opacity: !hasContent ? 0.45 : 1 }}
          >
            {saving ? "Saving…" : "Save to Notes"}
          </button>
        </div>

        {/* past reflections collapsible */}
        {signedIn && (
          <>
          <div className="divider" style={{ margin: "22px 0 0" }} />
          <div style={{ marginTop: 22 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button
              type="button"
              onClick={() => setPastOpen((v) => !v)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                flex: 1,
              }}
            >
              <span
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 9,
                  textTransform: "uppercase",
                  letterSpacing: ".1em",
                  color: "var(--ink-faint)",
                }}
              >
                Past reflections
              </span>
              {pastReflections.length > 0 && (
                <span
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 9,
                    color: "var(--ink-faint)",
                    opacity: 0.6,
                  }}
                >
                  ({pastReflections.length})
                </span>
              )}
              <span
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 9,
                  color: "var(--ink-faint)",
                  lineHeight: 1,
                }}
              >
                {pastOpen ? "▲" : "▼"}
              </span>
            </button>

            {pastReflections.length > 0 && (
              <button
                type="button"
                onClick={() => void generateWeeklySummary()}
                disabled={summarizing}
                style={{
                  marginLeft: "auto",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontFamily: "var(--mono)",
                  fontSize: 9,
                  color: summarizing ? "var(--ink-faint)" : "var(--gold)",
                  background: "none",
                  border: "none",
                  cursor: summarizing ? "default" : "pointer",
                  padding: 0,
                  opacity: summarizing ? 0.6 : 1,
                }}
              >
                {summarizing ? "Synthesizing…" : "✦ Weekly summary"}
              </button>
            )}
            </div>

            {weeklySummaryError && (
              <p style={{ marginTop: 10, fontSize: 12, color: "var(--down)" }}>
                {weeklySummaryError}{" "}
                <button type="button" className="savebtn" onClick={() => void generateWeeklySummary()}>Retry</button>
              </p>
            )}

            {aiSummary && (
              <div
                style={{
                  marginTop: 10,
                  padding: "10px 14px",
                  background: "var(--glass)",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--r, 8px)",
                  fontSize: 12,
                  color: "var(--ink)",
                  lineHeight: 1.7,
                  position: "relative",
                }}
              >
                <button
                  type="button"
                  onClick={() => setAiSummary(null)}
                  style={{ position: "absolute", top: 6, right: 8, background: "none", border: "none", color: "var(--ink-faint)", cursor: "pointer", fontSize: 14 }}
                >
                  ×
                </button>
                <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--gold)", letterSpacing: ".1em", marginBottom: 6, textTransform: "uppercase" }}>✦ AI SYNTHESIS</div>
                {aiSummary}
              </div>
            )}

            {pastOpen && (
              <div style={{ marginTop: 8 }}>
                {pastReflections.length === 0 ? (
                  <div
                    style={{
                      borderTop: "1px solid var(--line)",
                      paddingTop: 12,
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                      color: "var(--ink-faint)",
                    }}
                  >
                    No past reflections yet.
                  </div>
                ) : (
                  pastReflections.map((note) => (
                    <PastReflectionRow key={note.id} note={note} />
                  ))
                )}
              </div>
            )}
          </div>
          </>
        )}
      </div>
    </>
  );
}
