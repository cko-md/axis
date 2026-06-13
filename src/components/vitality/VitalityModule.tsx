"use client";

import { useMemo, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import {
  useTrainingWeek,
  DOW_LABELS,
  KIND_LABELS,
  INTENSITY_LABELS,
  type TrainingSession,
  type TrainingKind,
  type TrainingIntensity,
} from "@/lib/hooks/useTrainingWeek";
import { WorkoutDetailModal } from "./WorkoutDetailModal";
import { AIRegimenModal } from "./AIRegimenModal";

const TABS = [
  { id: "fit-health", label: "Health" },
  { id: "fit-nutrition", label: "Nutrition" },
  { id: "fit-run", label: "Running" },
  { id: "fit-strength", label: "Strength & Conditioning" },
  { id: "fit-yoga", label: "Yoga & Pilates" },
];

const KIND_ORDER: TrainingKind[] = ["run", "lift", "mobility", "rest", "other"];
const INTENSITY_ORDER: TrainingIntensity[] = ["easy", "moderate", "hard", "key"];

const editFieldStyle: React.CSSProperties = {
  background: "var(--surface-2)",
  border: "1px solid var(--line)",
  borderRadius: 4,
  padding: "5px 7px",
  color: "var(--ink)",
  fontFamily: "var(--sans)",
  fontSize: 12,
  width: "100%",
};

// Compact summary line under the day title, e.g. "45m · Lower" or "Recovery"
function sessionMeta(s: TrainingSession) {
  const bits: string[] = [];
  if (s.duration_min > 0) bits.push(`${s.duration_min}m`);
  if (s.notes) bits.push(s.notes);
  if (!bits.length) bits.push(KIND_LABELS[s.kind]);
  return bits.join(" · ");
}

type Video = { t: string; c: string; d: string; tag: string; g: string };

const RUN_VIDEOS: Video[] = [
  { t: "Perfect Running Form — 5 Drills to Fix It", c: "The Run Experience", d: "11:38", tag: "Form & Drills", g: "linear-gradient(135deg,#1c3142,#0e1620)" },
  { t: "How to Run Your First Sub-1:30 Half", c: "Sage Running", d: "16:21", tag: "Race Strategy", g: "linear-gradient(135deg,#23304a,#10141f)" },
  { t: "Zone 2 Explained — Why Easy Runs Matter", c: "Göran Winblad", d: "13:05", tag: "Training", g: "linear-gradient(135deg,#1f3a3a,#0e1818)" },
  { t: "Marathon Pace Workouts That Work", c: "Stephen Scullion", d: "18:44", tag: "Training", g: "linear-gradient(135deg,#2a2c44,#11121d)" },
  { t: "2026 Carbon Super-Trainer Shootout", c: "Believe in the Run", d: "21:12", tag: "Gear Reviews", g: "linear-gradient(135deg,#2c2734,#141018)" },
  { t: "Cadence & Stride: Run Faster, Injure Less", c: "James Dunne", d: "09:57", tag: "Form & Drills", g: "linear-gradient(135deg,#1d3540,#0e171d)" },
];

const YOGA_VIDEOS: Video[] = [
  { t: "20-Min Yoga for Runners — Deep Hip Opener", c: "Yoga With Adriene", d: "20:14", tag: "Yoga for Runners", g: "linear-gradient(135deg,#2a2440,#12101c)" },
  { t: "Pilates Core Burn — No Equipment, 15 Min", c: "Move With Nicole", d: "15:02", tag: "Pilates Core", g: "linear-gradient(135deg,#15303a,#0e171c)" },
  { t: "Post-Run Stretch & Mobility Flow", c: "The Run Experience", d: "12:46", tag: "Mobility", g: "linear-gradient(135deg,#26303f,#101620)" },
  { t: "Restorative Yoga for Recovery Days", c: "Yoga With Kassandra", d: "25:31", tag: "Recovery / Restorative", g: "linear-gradient(135deg,#2c2632,#141017)" },
  { t: "Pilates for Posture & Spine Health", c: "Lottie Murphy", d: "18:09", tag: "Pilates Core", g: "linear-gradient(135deg,#1f3340,#0f181f)" },
  { t: "Hip & Hamstring Yoga for Tight Runners", c: "Breathe and Flow", d: "22:55", tag: "Yoga for Runners", g: "linear-gradient(135deg,#28323f,#10161f)" },
];

const RUN_CHIPS = ["All", "Form & Drills", "Training", "Race Strategy", "Gear Reviews"];
const YOGA_CHIPS = ["All", "Yoga for Runners", "Pilates Core", "Mobility", "Recovery / Restorative"];

const RECIPES = [
  { id: "r1", t: "Sheet-Pan Salmon, Sweet Potato & Broccoli", diet: "High-Protein", kcal: 530, p: 42, time: "30 min", src: "Serious Eats", g: "linear-gradient(135deg,#c2603f,#5a2a1f)" },
  { id: "r2", t: "Greek Yogurt Bowl, Berries & Toasted Oats", diet: "High-Protein", kcal: 410, p: 32, time: "5 min", src: "Bon Appétit", g: "linear-gradient(135deg,#7a5cc2,#2c2150)" },
  { id: "r3", t: "Chicken, Quinoa & Charred Greens Bowl", diet: "High-Protein", kcal: 620, p: 48, time: "25 min", src: "NYT Cooking", g: "linear-gradient(135deg,#4f9e6a,#1d3a28)" },
  { id: "r4", t: "Jollof-Spiced Brown Rice & Grilled Chicken", diet: "High-Protein", kcal: 640, p: 44, time: "40 min", src: "My Active Kitchen", g: "linear-gradient(135deg,#d06a2c,#5a2510)" },
];

const INITIAL_MEALS = [
  { ic: "☕", t: "Greek yogurt, berries, granola", m: "Breakfast · 07:40", k: "P 32 · 410" },
  { ic: "🥗", t: "Chicken, quinoa & greens bowl", m: "Lunch · 12:50", k: "P 48 · 620" },
  { ic: "🥤", t: "Whey + banana (post-run)", m: "Snack · 16:10", k: "P 30 · 280" },
  { ic: "🍽️", t: "Salmon, sweet potato, broccoli", m: "Dinner · planned", k: "P 32 · 530" },
];

function AiIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
    </svg>
  );
}

function VidCard({ v }: { v: Video }) {
  return (
    <div className="vid">
      <div className="vthumb" style={{ background: v.g }}>
        <span className="tag">{v.tag}</span>
        <div className="pl"><span /></div>
        <span className="dur">{v.d}</span>
      </div>
      <div className="vb">
        <div className="vt">{v.t}</div>
        <div className="vc">
          <span>{v.c}</span>
          <span>YouTube</span>
        </div>
      </div>
    </div>
  );
}

function ChipRow({ chips, active, onPick }: { chips: string[]; active: string; onPick: (c: string) => void }) {
  return (
    <div className="chips" style={{ marginBottom: 16 }}>
      {chips.map((c) => (
        <span key={c} className={`chip${active === c ? " on" : ""}`} onClick={() => onPick(c)}>
          {c}
        </span>
      ))}
    </div>
  );
}

// Inline editor for a single session, shown when a day cell is expanded.
function SessionEditor({
  session,
  onChange,
  onRemove,
}: {
  session: TrainingSession;
  onChange: (patch: Partial<TrainingSession>) => void;
  onRemove: () => void;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--line)",
        borderRadius: "var(--r)",
        padding: 10,
        background: "var(--surface-2)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <input
        style={editFieldStyle}
        value={session.title}
        placeholder="Session title…"
        onChange={(e) => onChange({ title: e.target.value })}
      />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <select style={editFieldStyle} value={session.kind} onChange={(e) => onChange({ kind: e.target.value as TrainingKind })}>
          {KIND_ORDER.map((k) => (
            <option key={k} value={k}>{KIND_LABELS[k]}</option>
          ))}
        </select>
        <select
          style={editFieldStyle}
          value={session.intensity}
          onChange={(e) => onChange({ intensity: e.target.value as TrainingIntensity })}
        >
          {INTENSITY_ORDER.map((i) => (
            <option key={i} value={i}>{INTENSITY_LABELS[i]}</option>
          ))}
        </select>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 8, alignItems: "center" }}>
        <input
          style={{ ...editFieldStyle, width: 92 }}
          type="number"
          min={0}
          value={session.duration_min}
          onChange={(e) => onChange({ duration_min: Math.max(0, Number(e.target.value) || 0) })}
        />
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-faint)" }}>minutes</span>
      </div>
      <input
        style={editFieldStyle}
        value={session.notes ?? ""}
        placeholder="Notes (e.g. 8 km · Z3-4)"
        onChange={(e) => onChange({ notes: e.target.value || null })}
      />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--ink-dim)", cursor: "pointer" }}>
          <input type="checkbox" checked={session.completed} onChange={() => onChange({ completed: !session.completed })} />
          Completed
        </label>
        <button type="button" className="del" title="Remove session" onClick={onRemove} style={{ fontSize: 16 }}>×</button>
      </div>
    </div>
  );
}

function TrainingWeekPlanner() {
  const { toast } = useToast();
  const { sessions, loading, persistence, signedIn, addSession, updateSession, removeSession, toggleComplete } =
    useTrainingWeek();
  const [editing, setEditing] = useState(false);
  const [openDay, setOpenDay] = useState<number | null>(null);
  const [detailSession, setDetailSession] = useState<TrainingSession | null>(null);

  const byDay = useMemo(() => {
    const map: Record<number, TrainingSession[]> = {};
    for (let d = 0; d < 7; d++) map[d] = [];
    for (const s of sessions) (map[s.dow] ??= []).push(s);
    for (const d of Object.keys(map)) map[Number(d)].sort((a, b) => a.sort_order - b.sort_order);
    return map;
  }, [sessions]);

  const totalVolume = useMemo(() => sessions.reduce((sum, s) => sum + (s.duration_min || 0), 0), [sessions]);
  const plannedCount = sessions.filter((s) => s.kind !== "rest").length;
  const doneCount = sessions.filter((s) => s.completed).length;
  const donePct = plannedCount ? Math.round((doneCount / plannedCount) * 100) : 0;
  // Scale the volume bar against a 600-minute reference week so it reads as a fraction.
  const volumePct = Math.min(100, Math.round((totalVolume / 600) * 100));

  return (
    <div className="card tick" style={{ marginBottom: 18 }}>
      <h2 className="sec">
        Training Week<span className="rule" />
        <span className="count">{persistence === "supabase" ? "Synced" : signedIn ? "Local draft" : "Demo"}</span>
        <span
          className="rings-edit"
          title={editing ? "Done editing" : "Edit plan"}
          onClick={() => {
            setEditing((v) => !v);
            setOpenDay(null);
          }}
        >
          {editing ? "✓" : "✎"}
        </span>
      </h2>

      {/* Week metrics — Bebas numerals + gold unit + thin track bars */}
      <div className="ftop" style={{ gridTemplateColumns: "1fr 1fr 1fr", marginTop: 14 }}>
        <div className="card">
          <div className="seclabel">Weekly Volume</div>
          <div className="bigmetric">{totalVolume}<span style={{ fontSize: 15, color: "var(--ink-faint)" }}> min</span></div>
          <div className="track" style={{ marginTop: 8 }}><div style={{ width: `${volumePct}%` }} /></div>
        </div>
        <div className="card">
          <div className="seclabel">Sessions Done</div>
          <div className="bigmetric">{doneCount}<span style={{ fontSize: 15, color: "var(--ink-faint)" }}> / {plannedCount}</span></div>
          <div className="track" style={{ marginTop: 8 }}><div className={donePct >= 100 ? "good" : ""} style={{ width: `${donePct}%` }} /></div>
        </div>
        <div className="card">
          <div className="seclabel">Completion</div>
          <div className="bigmetric">{donePct}<span style={{ fontSize: 15, color: "var(--ink-faint)" }}> %</span></div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-dim)", marginTop: 8 }}>
            {sessions.length} session{sessions.length === 1 ? "" : "s"} planned
          </div>
        </div>
      </div>

      {loading ? (
        <div className="empty-state" style={{ marginTop: 14 }}>Loading your week…</div>
      ) : (
        <div className="train-week" id="trainWeek" style={{ marginTop: 14, alignItems: "start" }}>
          {DOW_LABELS.map((label, dow) => {
            const day = byDay[dow] ?? [];
            const isOpen = openDay === dow;
            const allRest = day.length > 0 && day.every((s) => s.kind === "rest");
            const hasKey = day.some((s) => s.intensity === "key");
            const cls = `tw-day${allRest ? " rest" : hasKey ? " key" : ""}`;
            return (
              <div
                key={label}
                className={cls}
                style={{ cursor: editing ? "default" : "pointer", minHeight: editing ? "auto" : 88 }}
                onClick={() => {
                  if (!editing) setOpenDay(isOpen ? null : dow);
                }}
              >
                <div className="tw-dow">{label}</div>

                {day.length === 0 && !editing && (
                  <div className="tw-meta" style={{ color: "var(--ink-faint)" }}>—</div>
                )}

                {/* View mode: click session to open detail; check icon to toggle complete */}
                {!editing &&
                  day.map((s) => (
                    <div
                      key={s.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        setDetailSession(s);
                      }}
                      title="View workout detail"
                      style={{ cursor: "pointer", position: "relative" }}
                    >
                      <div
                        className="tw-sess"
                        style={{
                          textDecoration: s.completed ? "line-through" : "none",
                          color: s.completed ? "var(--ink-faint)" : "var(--ink-2)",
                          paddingRight: 20,
                        }}
                      >
                        {s.title || KIND_LABELS[s.kind]}
                      </div>
                      <div className="tw-meta">{sessionMeta(s)}</div>
                      {s.intensity === "key" && <span className="tw-tag">KEY</span>}
                      <span
                        onClick={(e) => { e.stopPropagation(); toggleComplete(s.id); }}
                        title="Toggle complete"
                        style={{
                          position: "absolute", top: 0, right: 0,
                          fontFamily: "var(--mono)", fontSize: 10,
                          color: s.completed ? "var(--up)" : "var(--line)",
                          cursor: "pointer", lineHeight: 1, padding: "2px 4px",
                          transition: "color .15s",
                        }}
                      >
                        {s.completed ? "✓" : "○"}
                      </span>
                    </div>
                  ))}

                {/* Edit mode: inline editors + add button */}
                {editing && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
                    {day.map((s) => (
                      <SessionEditor
                        key={s.id}
                        session={s}
                        onChange={(patch) => updateSession(s.id, patch)}
                        onRemove={() => removeSession(s.id)}
                      />
                    ))}
                    <button
                      type="button"
                      className="savebtn"
                      style={{ marginTop: 0 }}
                      onClick={() => addSession({ dow, kind: "run", title: "New Session", duration_min: 30 })}
                    >
                      + Add session
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        <button
          type="button"
          className="sig-go"
          onClick={() => toast("Sessions surfaced to Schedule & Agenda", "success", "Vitality")}
        >
          ⤳ Push to Schedule &amp; Agenda
        </button>
        <button type="button" className="feed-manage" onClick={() => { setEditing((v) => !v); setOpenDay(null); }}>
          {editing ? "Done editing" : "Edit plan"}
        </button>
      </div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", marginTop: 9 }}>
        {editing
          ? "Add, edit, or remove sessions per day. Changes save automatically."
          : "Click a session to view / log details. Use ○ to mark complete."}
      </div>

      <WorkoutDetailModal
        session={detailSession}
        onClose={() => setDetailSession(null)}
        onToggleComplete={(id) => {
          toggleComplete(id);
          setDetailSession((s) => (s && s.id === id ? { ...s, completed: !s.completed } : s));
        }}
      />
    </div>
  );
}

export function VitalityModule() {
  const [tab, setTab] = useState("fit-health");
  const [runChip, setRunChip] = useState("All");
  const [yogaChip, setYogaChip] = useState("All");
  const [meals, setMeals] = useState(INITIAL_MEALS);
  const [savedRecipes, setSavedRecipes] = useState<Record<string, boolean>>({ r1: true, r3: true, r4: true });
  const [regimenModal, setRegimenModal] = useState<"run" | "lift" | null>(null);

  const toggleRecipe = (id: string) => setSavedRecipes((s) => ({ ...s, [id]: !s[id] }));

  return (
    <>
      <div className="modhead">
        <div className="eyebrow">Life</div>
        <div className="rule" />
        <div className="selectbox">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 2L3 14h4l2-4 2 4h4z" opacity=".7" /></svg>
          Synced: Strava
        </div>
      </div>
      <h1 className="hero">Vitality</h1>
      <p className="sub">Train, recover, and track — across disciplines.</p>

      <div className="subtabbar" style={{ marginTop: 20 }}>
        {TABS.map((t) => (
          <button key={t.id} type="button" className={`subtab${tab === t.id ? " on" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className={`subpanel${tab === "fit-run" ? " on" : ""}`} id="fit-run">
        <div className="ftop">
          <div className="card tick">
            <div className="seclabel">This Week</div>
            <div className="bigmetric">38<span style={{ fontSize: 18, color: "var(--ink-faint)" }}> km</span></div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--up)", marginTop: 4 }}>▴ 12% vs last week</div>
          </div>
          <div className="card">
            <div className="seclabel">Avg Pace</div>
            <div className="bigmetric">5:12<span style={{ fontSize: 18, color: "var(--ink-faint)" }}> /km</span></div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-dim)", marginTop: 4 }}>Zone 2 · HR 142</div>
          </div>
          <div className="card">
            <div className="seclabel">Goal · Half PR</div>
            <div className="bigmetric">1:34<span style={{ fontSize: 18, color: "var(--ink-faint)" }}> → 1:29</span></div>
            <div className="track" style={{ marginTop: 8 }}><div style={{ width: "70%" }} /></div>
          </div>
        </div>
        <div className="divider" />
        <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 16, alignItems: "start" }}>
          <div className="card">
            <h2 className="sec">Training Plan · This Week<span className="rule" /><span className="count">Adaptive</span></h2>
            <svg viewBox="0 0 320 90" style={{ width: "100%", height: 90, margin: "12px 0" }}>
              <polyline fill="none" stroke="var(--accent)" strokeWidth="2" points="0,60 50,55 100,30 150,62 200,48 250,20 300,70" />
              <line x1="0" y1="80" x2="320" y2="80" stroke="var(--line)" />
            </svg>
            <div className="ex"><span>Mon — Easy 6 km</span><span className="es">Z2</span></div>
            <div className="ex"><span>Wed — Intervals 6×800m</span><span className="es">Z4</span></div>
            <div className="ex"><span>Sat — Long run 16 km</span><span className="es">Z2</span></div>
            <div style={{ marginTop: 14 }}>
              <span className="aibtn" onClick={() => setRegimenModal("run")} style={{ cursor: "pointer" }}>
                <AiIcon />Re-plan with AI → Schedule
              </span>
            </div>
          </div>
          <div className="card">
            <h2 className="sec">Running Briefing<span className="rule" /></h2>
            <div style={{ marginTop: 12 }}>
              <div className="hl"><div className="cat">Athletes</div><div><div className="ht">Kiptum&apos;s training blocks: what the splits reveal</div><div className="hs">LETSRUN · 1d</div></div></div>
              <div className="hl"><div className="cat">Shoes</div><div><div className="ht">Super-trainer roundup: the daily-mileage carbon plates</div><div className="hs">DOCTORS OF RUNNING · 2d</div></div></div>
              <div className="hl"><div className="cat">Tech</div><div><div className="ht">New running-power metrics on wrist optical sensors</div><div className="hs">DC RAINMAKER · 3d</div></div></div>
              <div className="hl"><div className="cat">Gear</div><div><div className="ht">Hot-weather kit for summer base-building</div><div className="hs">OUTSIDE · 4d</div></div></div>
            </div>
          </div>
        </div>
        <div className="divider" />
        <h2 className="sec" style={{ marginBottom: 14 }}>Running Videos<span className="rule" /><span className="count">YouTube API</span></h2>
        <ChipRow chips={RUN_CHIPS} active={runChip} onPick={setRunChip} />
        <div className="vidgrid" id="runVids">
          {RUN_VIDEOS.filter((v) => runChip === "All" || v.tag === runChip).map((v) => <VidCard key={v.t} v={v} />)}
        </div>
      </div>

      <div className={`subpanel${tab === "fit-strength" ? " on" : ""}`} id="fit-strength">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, alignItems: "start" }}>
          <div className="routine">
            <div className="rn">Upper · Push</div>
            <div className="ex"><span>Incline DB Press</span><span className="es">4 × 8</span></div>
            <div className="ex"><span>Weighted Dips</span><span className="es">3 × 10</span></div>
            <div className="ex"><span>Lateral Raise</span><span className="es">3 × 15</span></div>
          </div>
          <div className="routine">
            <div className="rn">Lower · Posterior</div>
            <div className="ex"><span>Romanian Deadlift</span><span className="es">4 × 6</span></div>
            <div className="ex"><span>Bulgarian Split Squat</span><span className="es">3 × 10</span></div>
            <div className="ex"><span>Calf Raise</span><span className="es">4 × 15</span></div>
          </div>
          <div className="routine">
            <div className="rn">Conditioning · EMOM 20</div>
            <div className="ex"><span>Kettlebell swings</span><span className="es">15</span></div>
            <div className="ex"><span>Burpees</span><span className="es">12</span></div>
            <div className="ex"><span>Row</span><span className="es">250m</span></div>
            <div className="ex"><span>Rest</span><span className="es">—</span></div>
          </div>
        </div>
        <div style={{ marginTop: 16 }}>
          <span className="aibtn" onClick={() => setRegimenModal("lift")} style={{ cursor: "pointer" }}>
            <AiIcon />Build a Session with AI
          </span>
        </div>
        <div className="divider" />
        <h2 className="sec" style={{ marginBottom: 14 }}>Strength &amp; Conditioning Reads<span className="rule" /></h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 28px" }}>
          <div>
            <div className="hl artlink"><div className="cat">Lifting</div><div><div className="ht">How many hard sets actually build muscle</div><div className="hs">MEN&apos;S HEALTH · 1d</div></div></div>
            <div className="hl artlink"><div className="cat">Hybrid</div><div><div className="ht">Lifting and running without killing either</div><div className="hs">MEN&apos;S JOURNAL · 2d</div></div></div>
            <div className="hl artlink"><div className="cat">Program</div><div><div className="ht">Push/pull/legs for the time-crunched</div><div className="hs">MUSCLE &amp; STRENGTH · 3d</div></div></div>
          </div>
          <div>
            <div className="hl artlink"><div className="cat">HIIT</div><div><div className="ht">EMOM circuits that complement mileage</div><div className="hs">MEN&apos;S FITNESS · 3d</div></div></div>
            <div className="hl artlink"><div className="cat">Recovery</div><div><div className="ht">The recovery levers that actually move the needle</div><div className="hs">MUSCLE &amp; FITNESS · 4d</div></div></div>
            <div className="hl artlink"><div className="cat">GQ</div><div><div className="ht">Why lifting is the best thing for your wardrobe</div><div className="hs">GQ · 5d</div></div></div>
          </div>
        </div>
      </div>

      <div className={`subpanel${tab === "fit-yoga" ? " on" : ""}`} id="fit-yoga">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "start", marginBottom: 18 }}>
          <div className="routine">
            <div className="rn">Runner&apos;s Mobility · 15 min</div>
            <div className="ex"><span>Hip flexor flow</span><span className="es">3 min</span></div>
            <div className="ex"><span>Pigeon → thread the needle</span><span className="es">4 min</span></div>
            <div className="ex"><span>Pilates hundred + dead bug</span><span className="es">5 min</span></div>
            <div className="ex"><span>Box breathing</span><span className="es">3 min</span></div>
          </div>
          <div className="card" style={{ padding: 14 }}>
            <div className="seclabel">Build with AI</div>
            <p style={{ fontSize: 11.5, color: "var(--ink-dim)", lineHeight: 1.55, marginBottom: 12 }}>
              Generate a mobility or Pilates flow targeting your tight areas, then drop it into wind-down.
            </p>
            <span className="aibtn" onClick={() => setRegimenModal("lift")} style={{ cursor: "pointer" }}>
              <AiIcon />Build a Flow with AI
            </span>
          </div>
        </div>
        <h2 className="sec" style={{ marginBottom: 14 }}>Yoga &amp; Pilates Videos<span className="rule" /><span className="count">YouTube API</span></h2>
        <ChipRow chips={YOGA_CHIPS} active={yogaChip} onPick={setYogaChip} />
        <div className="vidgrid" id="yogaVids">
          {YOGA_VIDEOS.filter((v) => yogaChip === "All" || v.tag === yogaChip).map((v) => <VidCard key={v.t} v={v} />)}
        </div>
      </div>

      <div className={`subpanel${tab === "fit-nutrition" ? " on" : ""}`} id="fit-nutrition">
        <div className="modhead" style={{ margin: "0 0 18px" }}>
          <div className="rule" />
          <div className="selectbox">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 3v18M5 8c0 4 3 5 7 5M19 8c0 4-3 5-7 5" /></svg>
            <span>Diet: High-Protein</span>
          </div>
          <div className="selectbox">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 12h4l2-7 4 14 2-7h4" /></svg>
            Synced: Cronometer
          </div>
        </div>
        <div className="ftop" style={{ gridTemplateColumns: "1fr 1fr 1fr 1fr" }}>
          <div className="card tick">
            <div className="seclabel">Calories</div>
            <div className="bigmetric">1,840<span style={{ fontSize: 15, color: "var(--ink-faint)" }}> / 2,400</span></div>
            <div className="track" style={{ marginTop: 8 }}><div style={{ width: "77%" }} /></div>
          </div>
          <div className="card">
            <div className="seclabel">Protein</div>
            <div className="bigmetric">142<span style={{ fontSize: 15, color: "var(--ink-faint)" }}> / 180g</span></div>
            <div className="track" style={{ marginTop: 8 }}><div className="good" style={{ width: "79%" }} /></div>
          </div>
          <div className="card">
            <div className="seclabel">Carbs</div>
            <div className="bigmetric">186<span style={{ fontSize: 15, color: "var(--ink-faint)" }}> / 260g</span></div>
            <div className="track" style={{ marginTop: 8 }}><div style={{ width: "72%" }} /></div>
          </div>
          <div className="card">
            <div className="seclabel">Fat</div>
            <div className="bigmetric">58<span style={{ fontSize: 15, color: "var(--ink-faint)" }}> / 80g</span></div>
            <div className="track" style={{ marginTop: 8 }}><div style={{ width: "73%" }} /></div>
          </div>
        </div>
        <div className="divider" />
        <div style={{ display: "grid", gridTemplateColumns: "1.25fr 1fr", gap: 16, alignItems: "start" }}>
          <div className="card tick">
            <h2 className="sec">Today&apos;s Meals<span className="rule" /><span className="count">1,840 kcal</span></h2>
            <div className="meal-list">
              {meals.map((meal) => (
                <div className="meal" key={meal.t}>
                  <div className="meal-ic">{meal.ic}</div>
                  <div className="meal-b">
                    <div className="meal-t">{meal.t}</div>
                    <div className="meal-m">{meal.m}</div>
                  </div>
                  <div className="meal-k">{meal.k}</div>
                  <button
                    type="button"
                    className="meal-x"
                    title="Remove"
                    onClick={() => setMeals((ms) => ms.filter((m) => m !== meal))}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <div className="addtask" style={{ marginTop: 12 }}>
              <input placeholder="+ Log a meal… (try 'oatmeal & eggs, 520, P30')" />
            </div>
          </div>
          <div className="card">
            <h2 className="sec">Targets &amp; Notes<span className="rule" /></h2>
            <div style={{ marginTop: 12 }}>
              <div className="metricrow"><span className="metric-k">Diet protocol</span><span className="metric-v">High-Protein</span></div>
              <div className="metricrow"><span className="metric-k">Protein target</span><span className="metric-v">1.0 g/lb</span></div>
              <div className="metricrow"><span className="metric-k">Hydration</span><span className="metric-v">2.1 / 3.0 L</span></div>
              <div className="metricrow"><span className="metric-k">Training-day carbs</span><span className="metric-v up">+40g</span></div>
              <p style={{ fontSize: 11, color: "var(--ink-faint)", lineHeight: 1.55, marginTop: 12 }}>
                On long-run days AXIS nudges carbs up and front-loads them. Macros adapt to your selected protocol.
              </p>
            </div>
          </div>
        </div>
        <div className="divider" />
        <h2 className="sec" style={{ marginBottom: 6 }}>
          Recommended Recipes<span className="rule" /><span className="count">High-Protein</span>
          <span className="rings-edit" title="Refresh recipes">↻</span>
        </h2>
        <p className="sub" style={{ margin: "0 0 16px" }}>Sourced &amp; curated to your protocol. Tap to open; save to your Supper Club.</p>
        <div className="recipe-grid" id="nutritionRecipes">
          {RECIPES.map((r) => (
            <div className="recipe" key={r.id}>
              <div className="rc-img" style={{ background: r.g }}>
                <span className="rc-diet">{r.diet}</span>
                <span
                  className={`rc-save${savedRecipes[r.id] ? " on" : ""}`}
                  title="Save to Supper Club"
                  onClick={() => toggleRecipe(r.id)}
                >
                  {savedRecipes[r.id] ? "★" : "☆"}
                </span>
              </div>
              <div className="rc-b">
                <div className="rc-t">{r.t}</div>
                <div className="rc-meta"><span>{r.kcal} kcal</span><span>P {r.p}g</span><span>{r.time}</span></div>
                <div className="rc-src">{r.src} ↗</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className={`subpanel${tab === "fit-health" ? " on" : ""}`} id="fit-health">
        <TrainingWeekPlanner />
        <div className="modhead" style={{ margin: "0 0 18px" }}>
          <div className="rule" />
          <div className="selectbox">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 21s-7-4.5-9-9a5 5 0 0 1 9-2 5 5 0 0 1 9 2c-2 4.5-9 9-9 9z" /></svg>
            Synced: Apple Health
          </div>
        </div>
        <div className="ftop" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
          <div className="card tick">
            <div className="seclabel">Resting HR</div>
            <div className="bigmetric">48<span style={{ fontSize: 15, color: "var(--ink-faint)" }}> bpm</span></div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--up)", marginTop: 4 }}>▾ 2 · well-recovered</div>
          </div>
          <div className="card">
            <div className="seclabel">HRV</div>
            <div className="bigmetric">86<span style={{ fontSize: 15, color: "var(--ink-faint)" }}> ms</span></div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--up)", marginTop: 4 }}>▴ above baseline</div>
          </div>
          <div className="card">
            <div className="seclabel">Sleep</div>
            <div className="bigmetric">7:24<span style={{ fontSize: 15, color: "var(--ink-faint)" }}> h</span></div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-dim)", marginTop: 4 }}>82% efficiency</div>
          </div>
          <div className="card">
            <div className="seclabel">VO₂ Max</div>
            <div className="bigmetric">54<span style={{ fontSize: 15, color: "var(--ink-faint)" }}> ml/kg</span></div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--up)", marginTop: 4 }}>▴ excellent</div>
          </div>
        </div>
        <div className="divider" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "start" }}>
          <div className="card tick">
            <h2 className="sec">Readiness<span className="rule" /><span className="count">88 · Green</span></h2>
            <p style={{ fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.6, margin: "12px 0" }}>
              HRV above baseline and resting HR down — recovery is strong. AXIS kept today&apos;s intervals as planned and nudged
              bedtime to protect tomorrow&apos;s long run.
            </p>
            <div className="metricrow"><span className="metric-k">Recommendation</span><span className="metric-v up">Train as planned</span></div>
            <div className="metricrow"><span className="metric-k">Sleep target tonight</span><span className="metric-v">22:30 · 8h</span></div>
            <div className="metricrow"><span className="metric-k">Hydration goal</span><span className="metric-v">3.0 L (long-run eve)</span></div>
          </div>
          <div className="card">
            <h2 className="sec">7-Day Trend<span className="rule" /></h2>
            <svg viewBox="0 0 300 120" style={{ width: "100%", height: 120, marginTop: 10 }}>
              <polyline fill="none" stroke="var(--accent)" strokeWidth="2" points="0,70 50,64 100,72 150,50 200,58 250,40 300,46" />
              <polyline fill="none" stroke="var(--up)" strokeWidth="1.6" strokeDasharray="3 3" points="0,86 50,80 100,84 150,72 200,76 250,66 300,70" />
            </svg>
            <div style={{ display: "flex", gap: 16, fontFamily: "var(--mono)", fontSize: 9.5, marginTop: 6 }}>
              <span className="accent">▬ HRV</span>
              <span className="up">▬ Sleep h</span>
            </div>
          </div>
        </div>
        <div className="divider" />
        <div className="card">
          <h2 className="sec">Vitals &amp; Activity<span className="rule" /><span className="count">Apple Health</span></h2>
          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 28px" }}>
            <div>
              <div className="metricrow"><span className="metric-k">Steps today</span><span className="metric-v">9,140</span></div>
              <div className="metricrow"><span className="metric-k">Active energy</span><span className="metric-v">720 kcal</span></div>
              <div className="metricrow"><span className="metric-k">Exercise minutes</span><span className="metric-v up">52</span></div>
            </div>
            <div>
              <div className="metricrow"><span className="metric-k">Blood oxygen</span><span className="metric-v">98%</span></div>
              <div className="metricrow"><span className="metric-k">Respiratory rate</span><span className="metric-v">14 /min</span></div>
              <div className="metricrow"><span className="metric-k">Mindful minutes</span><span className="metric-v">10</span></div>
            </div>
          </div>
        </div>
      </div>

      {regimenModal && (
        <AIRegimenModal
          discipline={regimenModal}
          open={true}
          onClose={() => setRegimenModal(null)}
        />
      )}
    </>
  );
}
