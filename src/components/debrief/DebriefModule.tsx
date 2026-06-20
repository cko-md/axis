"use client";

import { useEffect, useState } from "react";
import { useNotes } from "@/lib/hooks/useNotes";
import type { Note } from "@/lib/hooks/useNotes";
import { useTasks } from "@/lib/hooks/useTasks";
import { useToast } from "@/components/ui/Toast";

const DEBRIEF_FOLDER = "Debrief";
const REMINDER_KEY   = "debrief-reminder";
const DEFAULT_DAY    = 0;  // Sunday
const DEFAULT_HOUR   = 19; // 7 PM

const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

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
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 9,
          textTransform: "uppercase",
          letterSpacing: ".1em",
          color: "var(--ink-faint)",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <textarea
        placeholder={placeholder}
        rows={3}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          width: "100%",
          padding: "10px 13px",
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

function PastReflectionRow({ note }: { note: Note }) {
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
  const { notes, createNote, updateNote } = useNotes();
  const { tasks, loading, addTask } = useTasks();
  const { toast }                  = useToast();

  const [signedIn,      setSignedIn]      = useState(false);
  const [wins,          setWins]          = useState("");
  const [challenges,    setChallenges]    = useState("");
  const [focus,         setFocus]         = useState("");
  const [saving,        setSaving]        = useState(false);
  const [reminderDay,   setReminderDay]   = useState(DEFAULT_DAY);
  const [reminderHour,  setReminderHour]  = useState(DEFAULT_HOUR);
  const [reminderSet,   setReminderSet]   = useState(false);
  const [showConfig,    setShowConfig]    = useState(false);
  const [pastOpen,      setPastOpen]      = useState(false);
  const [aiSummary,     setAiSummary]     = useState<string | null>(null);
  const [summarizing,   setSummarizing]   = useState(false);

  useEffect(() => {
    import("@/lib/supabase/client").then(({ createClient }) => {
      createClient().auth.getUser().then(({ data }) => setSignedIn(!!data.user));
    });
  }, []);

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
    try {
      const stored = localStorage.getItem(REMINDER_KEY);
      if (stored) {
        const { day, hour } = JSON.parse(stored) as { day: number; hour: number };
        setReminderDay(day ?? DEFAULT_DAY);
        setReminderHour(hour ?? DEFAULT_HOUR);
        setReminderSet(true);
      }
    } catch { /* ignore */ }
  }, []);

  // Past reflections: all notes in the Debrief folder, newest first
  const pastReflections = notes
    .filter((n) => n.folder === DEBRIEF_FOLDER)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const generateWeeklySummary = async () => {
    const last7 = pastReflections.slice(0, 7);
    if (last7.length === 0) { toast("No past reflections to summarize.", "warn", "Debrief"); return; }
    setSummarizing(true);
    setAiSummary(null);
    try {
      const combined = last7.map((n) => `## ${n.title}\n${n.body ?? ""}`).join("\n\n---\n\n");
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "debrief_summary", text: combined.slice(0, 6000) }),
      });
      const data = (await res.json()) as { summary?: string };
      setAiSummary(data.summary ?? "No summary generated.");
    } catch {
      setAiSummary("Unable to generate summary — check your connection.");
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
      const note  = await createNote(`Week of ${label}`, DEBRIEF_FOLDER);
      if (note) await updateNote(note.id, { body });
      toast("Reflection saved to Notes › Debrief", "success", "Debrief");
      setWins("");
      setChallenges("");
      setFocus("");
    } catch {
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
    await addTask({
      title:    `Weekly Debrief · Review + Plan — ${DAY_NAMES[reminderDay]} ${hourFmt}`,
      category: "personal",
      priority: "med",
      effort:   "30m",
      deadline: dateStr,
    } as Parameters<typeof addTask>[0]);
    localStorage.setItem(REMINDER_KEY, JSON.stringify({ day: reminderDay, hour: reminderHour }));
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
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16, alignItems: "start" }}>
        <div className="card tick">
          <h2 className="sec">Wins<span className="rule" /><span className="count">this week</span></h2>
          <div style={{ marginTop: 12 }}>
            {(!signedIn || loading ? DEMO_WINS.map((t) => ({ id: t, title: t })) : taskWins).map((t) => (
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
          <div style={{ marginTop: 12 }}>
            {(!signedIn || loading ? DEMO_FRICTION : friction.map((t) => ({
              title: t.title,
              badge: t.status === "overdue" ? "overdue" : "14d idle",
              cls: t.status === "overdue" ? "hi" : "med",
            }))).map((f) => (
              <div key={f.title} className="task">
                <div className="check" />
                <div className="task-main">
                  <div className="task-title">{f.title}</div>
                  <div className="task-meta"><span className={`pill ${f.cls}`}>{f.badge}</span></div>
                </div>
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
            {(signedIn && !loading ? [
              ["Tasks completed", String(completedCount), completedCount > 0 ? "up" : ""],
              ["Open tasks",      String(openCount),      ""],
            ] : [
              ["Deep-work hours", "22.5h", ""],
              ["Tasks completed", "19",    "up"],
              ["Run volume",      "38 km", ""],
              ["Savings rate",    "28%",   "up"],
              ["French lessons",  "4 / 5", ""],
            ]).map(([k, v, cls]) => (
              <div key={k} className="metricrow">
                <span className="metric-k">{k}</span>
                <span className={`metric-v${cls ? " " + cls : ""}`}>{v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="divider" />

      {/* ── Weekly Reflection card ── */}
      <div className="card" style={{ maxWidth: "min(720px,92vw)" }}>
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
            borderLeft: "3px solid var(--accent)",
            paddingLeft: 12,
          }}
        >
          What moved the needle this week, and what will you say no to next week to protect the manuscript?
        </p>

        {/* structured prompts */}
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

        {/* save button */}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
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
          <div style={{ marginTop: 24 }}>
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
        )}
      </div>
    </>
  );
}
