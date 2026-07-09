"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useStrava, type StravaActivity, type PaceUnit } from "@/lib/hooks/useStrava";
import { RouteMap } from "@/components/vitality/RouteMap";
import { WorkoutDetailModal } from "./WorkoutDetailModal";
import { AIRegimenModal } from "./AIRegimenModal";
import { createPortal } from "react-dom";
import { createClient } from "@/lib/supabase/client";
import { openComposioOAuthPopup } from "@/lib/auth/openOAuthPopup";
import { callAiAction } from "@/lib/ai/callAction";
import { useWebViewer } from "@/lib/hooks/useWebViewer";
import { DIET_LABEL, DIETS, RECIPES, recipeUrl, type Diet } from "@/lib/recipes";
import { useNutritionProtocol } from "@/lib/hooks/useNutritionProtocol";
import { useVitalityLogs, type MeditationSession } from "@/lib/hooks/useVitalityLogs";
import { AxisGlassPanel } from "@/components/ui/axis/AxisGlassPanel";
import { ModuleInteractiveHero } from "@/components/ui/axis/ModuleInteractiveHero";

const TABS = [
  { id: "fit-health", label: "Health" },
  { id: "fit-nutrition", label: "Nutrition" },
  { id: "fit-meditation", label: "Meditation" },
  { id: "fit-run", label: "Running" },
  { id: "fit-strength", label: "Strength & Conditioning" },
  { id: "fit-yoga", label: "Yoga & Pilates" },
];

const MED_TYPES = [
  { id: "breath", label: "Focused Breath", desc: "Anchor attention to the breath cycle" },
  { id: "body-scan", label: "Body Scan", desc: "Progressive awareness from feet to crown" },
  { id: "loving", label: "Loving-Kindness", desc: "Cultivate compassion outward from self" },
  { id: "open", label: "Open Monitoring", desc: "Witness thoughts without engagement" },
  { id: "nidra", label: "Yoga Nidra", desc: "Conscious sleep / deep restoration" },
  { id: "box", label: "Box Breathing", desc: "4-4-4-4 tactical breath regulation" },
] as const;
type MedType = (typeof MED_TYPES)[number]["id"];

type MedSession = {
  id: string;
  date: string;
  type: MedType;
  durationMin: number;
  moodBefore: number;
  moodAfter: number;
  notes: string;
};

const PACE_UNIT_KEY = "axis-pace-unit";
const PR_GOALS_KEY = "axis-pr-goals";

// ── race goals ────────────────────────────────────────────────────────────────

type RaceType = "5k" | "10k" | "half" | "marathon" | "custom";

const RACE_TYPES: Array<{ id: RaceType; label: string }> = [
  { id: "5k", label: "5K" },
  { id: "10k", label: "10K" },
  { id: "half", label: "Half Marathon" },
  { id: "marathon", label: "Marathon" },
  { id: "custom", label: "Custom" },
];

type RaceGoal = {
  id: string;
  raceType: RaceType;
  customLabel?: string;
  currentTime: string;
  targetTime: string;
};

const DEFAULT_GOALS: RaceGoal[] = [
  { id: "g1", raceType: "half", currentTime: "1:34:00", targetTime: "1:29:00" },
];

function raceGoalLabel(g: RaceGoal): string {
  if (g.raceType === "custom") return g.customLabel?.trim() || "Custom";
  return RACE_TYPES.find((r) => r.id === g.raceType)?.label ?? g.raceType;
}

/** Parse "h:mm:ss" or "mm:ss" into total seconds; returns 0 on parse failure. */
function timeToSeconds(t: string): number {
  const parts = t.split(":").map((p) => parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] ?? 0;
}

/** Progress toward target from an implicit baseline (current time at 0%, target time at 100%).
 * Since we don't track a fixed start point, approximate using how close current is to target
 * relative to a generous 20%-of-current buffer below target — clamped to [0,100]. */
function goalProgressPct(g: RaceGoal): number {
  const cur = timeToSeconds(g.currentTime);
  const tgt = timeToSeconds(g.targetTime);
  if (!cur || !tgt || tgt >= cur) return tgt && cur && tgt <= cur ? 100 : 0;
  const buffer = cur * 0.08; // assume training started ~8% slower than "current"
  const start = cur + buffer;
  const pct = ((start - cur) / (start - tgt)) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

type FeedItem = { id: string; title: string; url: string; source: string; date: string };

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1d";
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

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

/**
 * These cards are curated placeholders (title/channel/duration), not results from
 * a live YouTube Data API call — there's no YOUTUBE_API_KEY configured for this
 * app, and wiring the real Data API v3 search endpoint would cost a quota-limited
 * key for what's a recommendations list, not user-supplied content. Clicking a
 * card opens the matching YouTube search instead of a dead, non-interactive tile —
 * mirrors VaultModule's toYouTubeEmbedUrl() pattern of resolving straight to the
 * official youtube.com surface rather than proxying it.
 */
function youtubeSearchUrl(v: Video): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${v.t} ${v.c}`)}`;
}

const RUN_VIDEOS: Video[] = [
  { t: "Perfect Running Form — 5 Drills to Fix It", c: "The Run Experience", d: "11:38", tag: "Form & Drills", g: "" },
  { t: "How to Run Your First Sub-1:30 Half", c: "Sage Running", d: "16:21", tag: "Race Strategy", g: "" },
  { t: "Zone 2 Explained — Why Easy Runs Matter", c: "Göran Winblad", d: "13:05", tag: "Training", g: "" },
  { t: "Marathon Pace Workouts That Work", c: "Stephen Scullion", d: "18:44", tag: "Training", g: "" },
  { t: "2026 Carbon Super-Trainer Shootout", c: "Believe in the Run", d: "21:12", tag: "Gear Reviews", g: "" },
  { t: "Cadence & Stride: Run Faster, Injure Less", c: "James Dunne", d: "09:57", tag: "Form & Drills", g: "" },
];

const YOGA_VIDEOS: Video[] = [
  { t: "20-Min Yoga for Runners — Deep Hip Opener", c: "Yoga With Adriene", d: "20:14", tag: "Yoga for Runners", g: "" },
  { t: "Pilates Core Burn — No Equipment, 15 Min", c: "Move With Nicole", d: "15:02", tag: "Pilates Core", g: "" },
  { t: "Post-Run Stretch & Mobility Flow", c: "The Run Experience", d: "12:46", tag: "Mobility", g: "" },
  { t: "Restorative Yoga for Recovery Days", c: "Yoga With Kassandra", d: "25:31", tag: "Recovery / Restorative", g: "" },
  { t: "Pilates for Posture & Spine Health", c: "Lottie Murphy", d: "18:09", tag: "Pilates Core", g: "" },
  { t: "Hip & Hamstring Yoga for Tight Runners", c: "Breathe and Flow", d: "22:55", tag: "Yoga for Runners", g: "" },
];

const RUN_CHIPS = ["All", "Form & Drills", "Training", "Race Strategy", "Gear Reviews"];
const YOGA_CHIPS = ["All", "Yoga for Runners", "Pilates Core", "Mobility", "Recovery / Restorative"];

// ── helpers ───────────────────────────────────────────────────────────────────

const UNIT_LABELS: Record<PaceUnit, string> = { km: "km", mi: "mi" };
const METRES_PER_MILE = 1609.34;

/** Convert metres to the given unit (km or mi), rounded to 1dp. */
function metresToUnit(m: number, unit: PaceUnit = "km"): number {
  const divisor = unit === "mi" ? METRES_PER_MILE : 1000;
  return Math.round((m / divisor) * 10) / 10;
}

/** Convert m/s to a pace string like "5:12", per-km or per-mile depending on `unit`. */
function speedToPace(mps: number, unit: PaceUnit = "km"): string {
  if (!mps || mps <= 0) return "—";
  const distPerUnit = unit === "mi" ? METRES_PER_MILE : 1000;
  const secPerUnit = distPerUnit / mps;
  const mins = Math.floor(secPerUnit / 60);
  const secs = Math.round(secPerUnit % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function sportLabel(a: StravaActivity): string {
  const t = a.sport_type || a.type;
  if (t === "Run") return "Run";
  if (t === "Ride" || t === "VirtualRide") return "Ride";
  if (t === "Swim") return "Swim";
  return t;
}

// ── sub-components ────────────────────────────────────────────────────────────

function AiIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
    </svg>
  );
}

function VidCard({ v }: { v: Video }) {
  const href = youtubeSearchUrl(v);
  return (
    <a className="vid" href={href} target="_blank" rel="noopener noreferrer" title={`Find “${v.t}” on YouTube`} style={{ display: "block", textDecoration: "none", color: "inherit", cursor: "pointer" }}>
      <div className="vthumb" style={{ background: v.g || "linear-gradient(135deg, var(--surface-2), var(--surface-3))" }}>
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
    </a>
  );
}

function ChipRow({ chips, active, onPick }: { chips: string[]; active: string; onPick: (c: string) => void }) {
  return (
    <div className="chips" style={{ marginBottom: 16 }}>
      {chips.map((c) => (
        <button key={c} type="button" className={`chip${active === c ? " on" : ""}`} aria-pressed={active === c} onClick={() => onPick(c)}>
          {c}
        </button>
      ))}
    </div>
  );
}

// Inline editor for a single session
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
    <div style={{ border: "1px solid var(--line)", borderRadius: "var(--r)", padding: 10, background: "var(--surface-2)", display: "flex", flexDirection: "column", gap: 8 }}>
      <input style={editFieldStyle} value={session.title} placeholder="Session title…" onChange={(e) => onChange({ title: e.target.value })} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <select aria-label="Session type" style={editFieldStyle} value={session.kind} onChange={(e) => onChange({ kind: e.target.value as TrainingKind })}>
          {KIND_ORDER.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
        </select>
        <select aria-label="Intensity" style={editFieldStyle} value={session.intensity} onChange={(e) => onChange({ intensity: e.target.value as TrainingIntensity })}>
          {INTENSITY_ORDER.map((i) => <option key={i} value={i}>{INTENSITY_LABELS[i]}</option>)}
        </select>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 8, alignItems: "center" }}>
        <input style={{ ...editFieldStyle, width: 92 }} type="number" min={0} value={session.duration_min} onChange={(e) => onChange({ duration_min: Math.max(0, Number(e.target.value) || 0) })} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-faint)" }}>minutes</span>
      </div>
      <input style={editFieldStyle} value={session.notes ?? ""} placeholder="Notes (e.g. 8 km · Z3-4)" onChange={(e) => onChange({ notes: e.target.value || null })} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--ink-dim)", cursor: "pointer" }}>
          <input type="checkbox" checked={session.completed} onChange={() => onChange({ completed: !session.completed })} />
          Completed
        </label>
        <button type="button" className="del" title="Remove session" aria-label="Remove session" onClick={onRemove} style={{ fontSize: 16 }}>×</button>
      </div>
    </div>
  );
}

function TrainingWeekPlanner() {
  const { toast } = useToast();
  const { sessions, loading, loadError, persistence, signedIn, addSession, updateSession, removeSession, toggleComplete } = useTrainingWeek();
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
  const volumePct = Math.min(100, Math.round((totalVolume / 600) * 100));

  return (
    <div className="card tick" style={{ marginBottom: 18 }}>
      <h2 className="sec">
        Training Week<span className="rule" />
        <span className="count">{persistence === "supabase" ? "Synced" : signedIn ? "Local draft" : "Demo"}</span>
        <button type="button" className="rings-edit" aria-label={editing ? "Done editing" : "Edit plan"} onClick={() => { setEditing((v) => !v); setOpenDay(null); }} style={{ background: "none", border: "none", padding: 0 }}>
          {editing ? "✓" : "✎"}
        </button>
      </h2>

      {loadError ? (
        <p className="dr-note" style={{ color: "var(--clay)", marginTop: 10 }}>{loadError}</p>
      ) : null}

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
              <div key={label} className={cls} style={{ cursor: editing ? "default" : "pointer", minHeight: editing ? "auto" : 88 }} onClick={() => { if (!editing) setOpenDay(isOpen ? null : dow); }}>
                <div className="tw-dow">{label}</div>
                {day.length === 0 && !editing && <div className="tw-meta" style={{ color: "var(--ink-faint)" }}>—</div>}
                {!editing && day.map((s) => (
                  <div key={s.id} onClick={(e) => { e.stopPropagation(); setDetailSession(s); }} title="View workout detail" style={{ cursor: "pointer", position: "relative" }}>
                    <div className="tw-sess" style={{ textDecoration: s.completed ? "line-through" : "none", color: s.completed ? "var(--ink-faint)" : "var(--ink-2)", paddingRight: 20 }}>
                      {s.title || KIND_LABELS[s.kind]}
                    </div>
                    <div className="tw-meta">{sessionMeta(s)}</div>
                    {s.intensity === "key" && <span className="tw-tag">KEY</span>}
                    <button type="button" onClick={(e) => { e.stopPropagation(); toggleComplete(s.id); }} title="Toggle complete" aria-pressed={s.completed} aria-label="Toggle complete" style={{ position: "absolute", top: 0, right: 0, fontFamily: "var(--mono)", fontSize: 10, color: s.completed ? "var(--up)" : "var(--line)", cursor: "pointer", lineHeight: 1, padding: "2px 4px", transition: "color .15s", background: "none", border: "none" }}>
                      {s.completed ? "✓" : "○"}
                    </button>
                  </div>
                ))}
                {editing && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
                    {day.map((s) => (
                      <SessionEditor key={s.id} session={s} onChange={(patch) => updateSession(s.id, patch)} onRemove={() => removeSession(s.id)} />
                    ))}
                    <button type="button" className="savebtn" style={{ marginTop: 0 }} onClick={() => addSession({ dow, kind: "run", title: "New Session", duration_min: 30 })}>
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
        <button type="button" className="sig-go" onClick={async () => {
          const supabase = createClient();
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) { toast("Sign in to sync to Schedule.", "warn", "Vitality"); return; }
          const today = new Date();
          const monday = new Date(today);
          monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
          monday.setHours(7, 0, 0, 0);
          const DOW_MAP: Record<string, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
          const rows = sessions.filter(s => !s.completed).map(s => {
            const start = new Date(monday);
            start.setDate(monday.getDate() + (DOW_MAP[s.dow] ?? 0));
            const end = new Date(start);
            end.setMinutes(end.getMinutes() + (s.duration_min ?? 60));
            return {
              user_id: user.id,
              title: `${s.title} (${s.duration_min ?? 60}min)`,
              start_at: start.toISOString(),
              end_at: end.toISOString(),
              description: [s.kind, s.intensity, s.notes].filter(Boolean).join(" · "),
              updated_at: new Date().toISOString(),
            };
          });
          if (!rows.length) { toast("No incomplete sessions to push.", "info", "Vitality"); return; }
          const { error } = await supabase.from("schedule_events").insert(rows);
          if (error) toast(error.message, "error", "Vitality");
          else toast(`${rows.length} session${rows.length > 1 ? "s" : ""} added to Schedule.`, "success", "Vitality");
        }}>
          ⤳ Push to Schedule &amp; Agenda
        </button>
        <button type="button" className="feed-manage" onClick={() => { setEditing((v) => !v); setOpenDay(null); }}>
          {editing ? "Done editing" : "Edit plan"}
        </button>
      </div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", marginTop: 9 }}>
        {editing ? "Add, edit, or remove sessions per day. Changes save automatically." : "Click a session to view / log details. Use ○ to mark complete."}
      </div>

      <WorkoutDetailModal session={detailSession} onClose={() => setDetailSession(null)} onToggleComplete={(id) => { toggleComplete(id); setDetailSession((s) => (s && s.id === id ? { ...s, completed: !s.completed } : s)); }} />
    </div>
  );
}

// ── Apple Health "How to Sync" modal ──────────────────────────────────────────

function AppleHealthModal({ onClose }: { onClose: () => void }) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      style={{ position: "fixed", inset: 0, zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.7)", backdropFilter: "blur(6px)" }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={{ width: "min(560px, 94vw)", maxHeight: "92vh", background: "var(--surface)", border: "1px solid var(--line-strong)", borderRadius: "var(--r)", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 28px 72px rgba(0,0,0,.6)" }}>
        {/* Header */}
        <div style={{ padding: "15px 20px 13px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--accent)", textTransform: "uppercase", letterSpacing: ".12em", marginBottom: 3 }}>Apple Health</div>
            <h2 style={{ fontFamily: "var(--display)", fontSize: 20, color: "var(--ink)", margin: 0, letterSpacing: ".02em" }}>How to Sync Health Data</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: "none", border: "none", color: "var(--ink-faint)", fontSize: 18, cursor: "pointer", lineHeight: 1 }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 22px" }}>
          <p style={{ fontFamily: "var(--serif)", fontSize: 13, color: "var(--ink-dim)", lineHeight: 1.65, marginBottom: 20 }}>
            Apple Health data is stored on-device and cannot be read directly by a web app. Here are the available sync paths:
          </p>

          {/* Option 1 */}
          <div style={{ border: "1px solid var(--line)", borderRadius: "var(--r)", padding: "14px 16px", marginBottom: 12, background: "var(--surface-2)" }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--accent)", textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 6 }}>Option 1 · Best</div>
            <div style={{ fontFamily: "var(--sans)", fontSize: 13, fontWeight: 500, color: "var(--ink)", marginBottom: 6 }}>AXIS iOS App (Coming Soon)</div>
            <p style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.55, margin: 0 }}>
              The AXIS native iOS app will connect to HealthKit directly, syncing resting HR, HRV, sleep, VO2 Max and activity data in real time. Join the waitlist below.
            </p>
            <div style={{ marginTop: 10 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".08em", padding: "5px 12px", border: "1px solid var(--accent)", borderRadius: "var(--r)", color: "var(--accent)", opacity: 0.7, cursor: "not-allowed" }}>
                Waitlist — coming soon
              </span>
            </div>
          </div>

          {/* Option 2 */}
          <div style={{ border: "1px solid var(--line)", borderRadius: "var(--r)", padding: "14px 16px", marginBottom: 12, background: "var(--surface-2)" }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--marine)", textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 6 }}>Option 2 · Available now</div>
            <div style={{ fontFamily: "var(--sans)", fontSize: 13, fontWeight: 500, color: "var(--ink)", marginBottom: 6 }}>Connect Strava → Running data</div>
            <p style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.55, margin: 0 }}>
              If your wearable (Garmin, Whoop, Polar, Wahoo) syncs to Strava, connect Strava in the Running tab. AXIS will pull your runs, rides, paces, and weekly mileage. Works today — go to the Running tab to connect.
            </p>
          </div>

          {/* Option 3 */}
          <div style={{ border: "1px solid var(--line)", borderRadius: "var(--r)", padding: "14px 16px", background: "var(--surface-2)" }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-faint)", textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 6 }}>Option 3 · Manual</div>
            <div style={{ fontFamily: "var(--sans)", fontSize: 13, fontWeight: 500, color: "var(--ink)", marginBottom: 6 }}>Export from Health app</div>
            <p style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.55, margin: 0 }}>
              In the iOS Health app, tap your profile → Export All Health Data. AXIS will support importing this zip file in a future update to back-fill your history.
            </p>
            <div style={{ marginTop: 8, fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)" }}>Import feature — not yet available</div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: "11px 20px", borderTop: "1px solid var(--line)" }}>
          <button type="button" onClick={onClose} style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".07em", textTransform: "uppercase", padding: "5px 12px", border: "1px solid var(--line)", borderRadius: "var(--r)", background: "transparent", color: "var(--ink-dim)", cursor: "pointer" }}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Strava activity feed ──────────────────────────────────────────────────────

function StravaActivityRow({ a, unit = "km" }: { a: StravaActivity; unit?: PaceUnit }) {
  const isRun = a.sport_type === "Run" || a.type === "Run";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: "1px solid var(--line)" }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", minWidth: 68 }}>{fmtDate(a.start_date)}</div>
      <div style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--ink)", flex: 1 }}>{a.name}</div>
      <div style={{ minWidth: 56, display: "flex", justifyContent: "center", alignItems: "center" }}>
        {a.map?.summary_polyline ? <RouteMap polyline={a.map.summary_polyline} width={52} height={30} /> : null}
      </div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: isRun ? "var(--accent)" : "var(--marine)", minWidth: 30 }}>{sportLabel(a)}</div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-2)", minWidth: 44, textAlign: "right" }}>{metresToUnit(a.distance, unit)} {UNIT_LABELS[unit]}</div>
      {isRun && <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-dim)", minWidth: 44, textAlign: "right" }}>{speedToPace(a.average_speed, unit)}/{UNIT_LABELS[unit]}</div>}
    </div>
  );
}

// ── Strava run list with expand/collapse ─────────────────────────────────────

function StravaRunList({ activities, unit = "km" }: { activities: StravaActivity[]; unit?: PaceUnit }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? activities : activities.slice(0, 3);
  return (
    <div className="card" style={{ padding: "4px 14px 4px" }}>
      {visible.map((a) => <StravaActivityRow key={a.id} a={a} unit={unit} />)}
      {activities.length > 3 && (
        <button type="button" onClick={() => setExpanded((e) => !e)} style={TOGGLE_BTN_STYLE}>
          {expanded ? "▲ Collapse" : `▼ Show all ${activities.length}`}
        </button>
      )}
    </div>
  );
}

// ── Real RSS briefing list (bug 7: replaces static fake headlines) ───────────

function BriefingList({ feedUrls, emptyLabel, artlink, columns }: { feedUrls: string[]; emptyLabel: string; artlink?: boolean; columns?: boolean }) {
  const { open: openInApp } = useWebViewer();
  const [items, setItems] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch("/api/feeds/cached", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedUrls }),
      });
      const data = (await res.json()) as { items?: FeedItem[] };
      setItems(data.items ?? []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedUrls.join("|")]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const id = setInterval(() => void load(), 4 * 60 * 1000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div style={{ marginTop: 12 }}>
      {loading && !items.length && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-faint)", padding: "8px 0" }}>Loading…</div>
      )}
      {!loading && error && !items.length && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-faint)", padding: "8px 0" }}>{emptyLabel}</div>
      )}
      {!loading && !error && !items.length && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-faint)", padding: "8px 0" }}>{emptyLabel}</div>
      )}
      <div style={columns ? { columnCount: 2, columnGap: 28 } : undefined}>
        {items.map((it) => (
          <div
            key={it.id}
            className={`hl${artlink ? " artlink" : ""}`}
            role="button"
            tabIndex={0}
            style={{ cursor: "pointer", breakInside: "avoid" }}
            onClick={() => openInApp(it.url, it.title)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openInApp(it.url, it.title); } }}
          >
            <div className="cat">{it.source.split(" ")[0] || "News"}</div>
            <div>
              <div className="ht">{it.title}</div>
              <div className="hs">{it.source.toUpperCase()} · {relTime(it.date)}</div>
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="rings-edit"
        aria-label="Refresh"
        title="Refresh"
        onClick={load}
        disabled={loading}
        style={{ background: "none", border: "none", padding: "4px 0", fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", cursor: loading ? "default" : "pointer" }}
      >
        {loading ? "…" : "↻ Refresh"}
      </button>
    </div>
  );
}

// ── Meditation session list with expand/collapse ──────────────────────────────

const TOGGLE_BTN_STYLE: React.CSSProperties = {
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

function MedSessionList({ sessions }: { sessions: MedSession[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? sessions : sessions.slice(0, 3);
  return (
    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
      {visible.map((s) => (
        <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", background: "var(--glass)", borderRadius: "var(--r)", border: "1px solid var(--line)" }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--ink-faint)", minWidth: 64 }}>
            {new Date(s.date).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--ink)", flex: 1 }}>{MED_TYPES.find((t) => t.id === s.type)?.label}</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-dim)" }}>{s.durationMin}m</div>
          <div style={{ fontSize: 12 }}>{["😞", "😕", "😐", "🙂", "😊"][s.moodBefore - 1]} → {["😞", "😕", "😐", "🙂", "😊"][s.moodAfter - 1]}</div>
        </div>
      ))}
      {sessions.length > 3 && (
        <button type="button" onClick={() => setExpanded((e) => !e)} style={TOGGLE_BTN_STYLE}>
          {expanded ? "▲ Collapse" : `▼ Show all ${sessions.length}`}
        </button>
      )}
    </div>
  );
}

// ── Meditation Tab ────────────────────────────────────────────────────────────

function MeditationTab({ rawSessions, addSession }: { rawSessions: MeditationSession[]; addSession: ReturnType<typeof useVitalityLogs>["addSession"] }) {
  const { toast } = useToast();

  const sessions: MedSession[] = useMemo(
    () => rawSessions.map((s) => ({
      id: s.id,
      date: s.occurred_at,
      type: s.type as MedType,
      durationMin: s.duration_min,
      moodBefore: s.mood_before,
      moodAfter: s.mood_after,
      notes: s.notes,
    })),
    [rawSessions],
  );
  const [medType, setMedType] = useState<MedType>("breath");
  const [duration, setDuration] = useState(10);
  const [moodBefore, setMoodBefore] = useState(3);
  const [moodAfter, setMoodAfter] = useState(3);
  const [notes, setNotes] = useState("");
  const [timerSec, setTimerSec] = useState(10 * 60);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [showAppleHealth, setShowAppleHealth] = useState(false);

  useEffect(() => { setTimerSec(duration * 60); setDone(false); }, [duration]);

  useEffect(() => {
    if (!running) return;
    timerRef.current = setInterval(() => {
      setTimerSec((s) => {
        if (s <= 1) {
          clearInterval(timerRef.current!);
          setRunning(false);
          setDone(true);
          toast("Session complete — log your mood below.", "success", "Meditation");
          if ("Notification" in window && Notification.permission === "granted") {
            new Notification("Axis · Meditation", { body: "Session complete. Take a moment to return." });
          }
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(timerRef.current!);
  }, [running, toast]);

  const fetchSuggestion = async () => {
    setAiLoading(true);
    const hour = new Date().getHours();
    const timeCtx = hour < 9 ? "morning" : hour < 13 ? "late morning" : hour < 17 ? "afternoon" : "evening";
    const prompt = `I'm planning a meditation session ${timeCtx}. Suggest the single best meditation type and duration for right now (2 sentences max). Types available: focused breath, body scan, loving-kindness, open monitoring, yoga nidra, box breathing.`;
    const result = await callAiAction("capture", { text: prompt });
    setAiSuggestion(
      result.ok
        ? result.data.action || result.data.label
        : "Try a 10-minute focused breath session — ideal for any time of day.",
    );
    setAiLoading(false);
  };

  const saveSession = async () => {
    const result = await addSession({ type: medType, durationMin: duration, moodBefore, moodAfter, notes });
    if (!result) {
      toast("Failed to log session — sign in to save.", "error", "Meditation");
      return;
    }
    setDone(false); setNotes(""); setMoodAfter(3);
    toast("Session logged.", "success", "Meditation");
  };

  const todaySessions = sessions.filter((s) => new Date(s.date).toDateString() === new Date().toDateString());
  const totalMindfulMin = sessions.reduce((a, s) => a + s.durationMin, 0);
  const streak = (() => {
    let s = 0; const today = new Date();
    for (let i = 0; i < 30; i++) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const ds = d.toDateString();
      if (sessions.some((ss) => new Date(ss.date).toDateString() === ds)) s++;
      else break;
    }
    return s;
  })();

  const timerMin = Math.floor(timerSec / 60).toString().padStart(2, "0");
  const timerS = (timerSec % 60).toString().padStart(2, "0");
  const progress = 1 - timerSec / (duration * 60);
  const r = 46; const circ = 2 * Math.PI * r;

  return (
    <div className={`subpanel on`}>
      {/* stats row */}
      <div className="ftop" style={{ gridTemplateColumns: "repeat(3,1fr)", marginBottom: 18 }}>
        <div className="card tick">
          <div className="seclabel">Streak</div>
          <div className="bigmetric">{streak}<span style={{ fontSize: 15, color: "var(--ink-faint)" }}> day{streak !== 1 ? "s" : ""}</span></div>
        </div>
        <div className="card">
          <div className="seclabel">Today</div>
          <div className="bigmetric">{todaySessions.length}<span style={{ fontSize: 15, color: "var(--ink-faint)" }}> session{todaySessions.length !== 1 ? "s" : ""}</span></div>
        </div>
        <div className="card">
          <div className="seclabel">Total Mindful Time</div>
          <div className="bigmetric">{totalMindfulMin}<span style={{ fontSize: 15, color: "var(--ink-faint)" }}> min</span></div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.1fr", gap: 16, alignItems: "start" }}>
        {/* timer */}
        <div className="card tick" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: 20 }}>
          <svg width="120" height="120" viewBox="0 0 120 120">
            <circle cx="60" cy="60" r={r} fill="none" stroke="var(--line)" strokeWidth="6" />
            <circle
              cx="60" cy="60" r={r} fill="none"
              stroke="var(--accent-2)" strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={circ}
              strokeDashoffset={circ * (1 - progress)}
              transform="rotate(-90 60 60)"
              style={{ transition: "stroke-dashoffset 1s linear" }}
            />
            <text x="60" y="55" textAnchor="middle" style={{ fill: "var(--ink)", fontFamily: "var(--narrow)", fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
              {timerMin}:{timerS}
            </text>
            <text x="60" y="72" textAnchor="middle" style={{ fill: "var(--ink-faint)", fontFamily: "var(--mono)", fontSize: 9 }}>
              {done ? "COMPLETE" : running ? "FOCUS" : "READY"}
            </text>
          </svg>
          <div style={{ display: "flex", gap: 6 }}>
            {[5, 10, 15, 20].map((d) => (
              <button key={d} type="button" className="btn-secondary" style={{ fontSize: 10, padding: "4px 8px", background: duration === d ? "var(--glass-2)" : undefined, borderColor: duration === d ? "var(--accent)" : undefined }} onClick={() => { if (!running) setDuration(d); }}>
                {d}m
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn-secondary" style={{ minWidth: 72 }} onClick={() => setRunning((r) => !r)}>
              {running ? "Pause" : done ? "Again" : timerSec < duration * 60 ? "Resume" : "Begin"}
            </button>
            <button type="button" className="btn-secondary" onClick={() => { setRunning(false); setDone(false); setTimerSec(duration * 60); }}>
              Reset
            </button>
          </div>
        </div>

        {/* session config + AI */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="card">
            <h2 className="sec">Session Type<span className="rule" /></h2>
            <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              {MED_TYPES.map((mt) => (
                <button key={mt.id} type="button" onClick={() => setMedType(mt.id)}
                  style={{ padding: "8px 10px", background: medType === mt.id ? "rgba(63,111,176,.12)" : "var(--glass)", border: `1px solid ${medType === mt.id ? "var(--accent-2)" : "var(--line)"}`, borderRadius: "var(--r)", cursor: "pointer", textAlign: "left", transition: ".14s" }}>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: medType === mt.id ? "var(--accent-2)" : "var(--ink)", marginBottom: 2 }}>{mt.label}</div>
                  <div style={{ fontSize: 9.5, color: "var(--ink-faint)", fontFamily: "var(--mono)", lineHeight: 1.4 }}>{mt.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="card">
            <h2 className="sec">
              AI Coach<span className="rule" />
              <button type="button" className="feed-manage" onClick={fetchSuggestion} disabled={aiLoading}>{aiLoading ? "Thinking…" : "✦ Suggest"}</button>
            </h2>
            {aiSuggestion ? (
              <p style={{ fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.6, marginTop: 10 }}>{aiSuggestion}</p>
            ) : (
              <p style={{ fontSize: 11, color: "var(--ink-faint)", marginTop: 10 }}>Click Suggest for a personalised recommendation based on your time of day and recent training.</p>
            )}
          </div>
        </div>
      </div>

      {/* mood logging */}
      {(done || todaySessions.length > 0) && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2 className="sec">Log This Session<span className="rule" /></h2>
          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", marginBottom: 6, textTransform: "uppercase", letterSpacing: ".08em" }}>Mood Before</div>
              <div style={{ display: "flex", gap: 6 }}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} type="button" onClick={() => setMoodBefore(n)}
                    style={{ width: 28, height: 28, borderRadius: "50%", border: `1.5px solid ${moodBefore === n ? "var(--accent)" : "var(--line)"}`, background: moodBefore === n ? "var(--glass-2)" : "transparent", cursor: "pointer", fontSize: 13 }}>
                    {["😞", "😕", "😐", "🙂", "😊"][n - 1]}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", marginBottom: 6, textTransform: "uppercase", letterSpacing: ".08em" }}>Mood After</div>
              <div style={{ display: "flex", gap: 6 }}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} type="button" onClick={() => setMoodAfter(n)}
                    style={{ width: 28, height: 28, borderRadius: "50%", border: `1.5px solid ${moodAfter === n ? "var(--up)" : "var(--line)"}`, background: moodAfter === n ? "var(--glass-2)" : "transparent", cursor: "pointer", fontSize: 13 }}>
                    {["😞", "😕", "😐", "🙂", "😊"][n - 1]}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes — insights, distractions, intentions…"
            style={{ marginTop: 10, width: "100%", background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: "var(--r)", padding: "7px 10px", color: "var(--ink)", fontSize: 12, fontFamily: "var(--sans)", boxSizing: "border-box" }}
          />
          <button type="button" className="sig-go" style={{ marginTop: 10 }} onClick={saveSession}>Save Session</button>
        </div>
      )}

      {/* recent log */}
      {sessions.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2 className="sec">Recent Sessions<span className="rule" /><span className="count">{sessions.length}</span></h2>
          <MedSessionList sessions={sessions} />
        </div>
      )}

      {/* Supper Club wellness link */}
      <div className="card" style={{ marginTop: 16, opacity: 0.8 }}>
        <h2 className="sec">Holistic Integration<span className="rule" /></h2>
        <p style={{ fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.6, marginTop: 10 }}>
          Meditation data feeds into your Vitality readiness score alongside HRV, sleep, and training load. Your Supper Club recipes adapt macros on rest/recovery days when mindful minutes exceed 20.
        </p>
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, padding: "4px 9px", border: "1px solid var(--line)", borderRadius: "var(--r)", color: "var(--ink-faint)" }}>→ Supper Club sync</span>
          <button type="button" onClick={() => setShowAppleHealth(true)} style={{ fontFamily: "var(--mono)", fontSize: 9.5, padding: "4px 9px", border: "1px solid var(--line)", borderRadius: "var(--r)", color: "var(--ink-faint)", background: "none", cursor: "pointer" }}>→ Apple Health (iOS)</button>
        </div>
      </div>
      {showAppleHealth && <AppleHealthModal onClose={() => setShowAppleHealth(false)} />}
    </div>
  );
}

// ── Health Metrics Panel ──────────────────────────────────────────────────────

const HEALTH_DEVICES = [
  {
    id: "oura",
    name: "Oura Ring",
    icon: "◎",
    description: "HRV · sleep stages · readiness · body temp",
    metrics: ["HRV", "Sleep", "Readiness", "Resting HR"],
    color: "var(--gold)",
    comingSoon: true,
    badge: "Coming soon",
  },
  {
    id: "garmin",
    name: "Garmin Connect",
    icon: "⬡",
    description: "VO₂ max · training load · GPS activities · recovery",
    metrics: ["VO₂ Max", "Training Load", "Steps", "Resting HR"],
    color: "var(--marine)",
    comingSoon: true,
    badge: "Coming soon",
  },
  {
    id: "whoop",
    name: "Whoop",
    icon: "◑",
    description: "Recovery score · strain · sleep performance · SpO₂",
    metrics: ["Recovery", "Strain", "Sleep", "HRV"],
    color: "#7c6fad",
    comingSoon: true,
    badge: "Coming soon",
  },
  {
    id: "fitbit",
    name: "Fitbit",
    icon: "◌",
    description: "Steps · active zone minutes · sleep · resting HR",
    metrics: ["Steps", "Active Minutes", "Sleep", "Resting HR"],
    color: "#4fa89c",
    comingSoon: true,
    badge: "Coming soon",
  },
  {
    id: "apple_health",
    name: "Apple Health",
    icon: "⬟",
    description: "HealthKit native sync — requires AXIS iOS app",
    metrics: ["All metrics via HealthKit"],
    color: "var(--ink-faint)",
    comingSoon: true,
    badge: "iOS only",
  },
];

const HEALTH_METRICS = [
  { id: "hr",        label: "Resting HR",  unit: "bpm",        icon: "♥",  sources: ["oura", "garmin", "whoop", "fitbit"] },
  { id: "hrv",       label: "HRV",         unit: "ms",         icon: "〰", sources: ["oura", "whoop"] },
  { id: "sleep",     label: "Sleep",       unit: "hrs",        icon: "☾",  sources: ["oura", "whoop", "garmin", "fitbit"] },
  { id: "vo2max",    label: "VO₂ Max",     unit: "mL/kg·min",  icon: "↑",  sources: ["garmin"] },
  { id: "readiness", label: "Readiness",   unit: "/ 100",      icon: "◈",  sources: ["oura", "whoop"] },
  { id: "steps",     label: "Steps",       unit: "today",      icon: "⬆",  sources: ["garmin", "fitbit"] },
];

function HealthMetricsPanel() {
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connected, setConnected]   = useState<Set<string>>(new Set());
  const [devicesOpen, setDevicesOpen] = useState(false);
  const { toast } = useToast();

  const handleConnect = async (deviceId: string) => {
    setConnecting(deviceId);
    try {
      const res = await fetch(`/api/health/${deviceId}/connect`, { method: "GET" });
      if (res.redirected || res.ok) {
        // OAuth redirect: open in same tab
        const data = (await res.json().catch(() => ({}))) as { url?: string; message?: string };
        if (data.url) { window.location.href = data.url; return; }
      }
      toast("OAuth setup required — coming soon.", "info", `${deviceId} connection`);
    } catch {
      toast("Could not reach the health API.", "error", "Connection error");
    } finally {
      setConnecting(null);
    }
  };

  const anyConnected = connected.size > 0;

  return (
    <>
      {/* Metric grid — shown empty until connected */}
      <div className="card" style={{ padding: "18px 20px" }}>
        <h2 className="sec">
          Live Metrics
          <span className="rule" />
          <span className="count" style={{ color: anyConnected ? "var(--up)" : "var(--ink-faint)" }}>
            {anyConnected ? `${connected.size} device${connected.size > 1 ? "s" : ""} syncing` : "no device connected"}
          </span>
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 10, marginTop: 14 }}>
          {HEALTH_METRICS.map((m) => {
            const hasSource = m.sources.some((s) => connected.has(s));
            return (
              <div key={m.id} style={{
                background: "var(--surface-2)",
                border: "1px solid var(--line)",
                borderRadius: "var(--r)",
                padding: "14px 14px 12px",
                display: "flex",
                flexDirection: "column",
                gap: 4,
                opacity: hasSource ? 1 : 0.5,
              }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--ink-faint)", textTransform: "uppercase", letterSpacing: ".1em" }}>{m.label}</span>
                  <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>{m.icon}</span>
                </div>
                <div style={{ fontFamily: "var(--display)", fontSize: 26, color: hasSource ? "var(--ink)" : "var(--ink-faint)", lineHeight: 1 }}>
                  —
                </div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--ink-faint)" }}>{m.unit}</div>
              </div>
            );
          })}
        </div>
        {!anyConnected && (
          <p style={{ fontFamily: "var(--sans)", fontSize: 11, color: "var(--ink-faint)", margin: "12px 0 0", lineHeight: 1.6 }}>
            Connect a wearable below to stream live data into your health dashboard.
          </p>
        )}
      </div>

      {/* Device connection cards — collapsed by default; none are wired up yet */}
      <div className="card" style={{ padding: "18px 20px", marginTop: 12 }}>
        <h2 className="sec">
          Devices
          <span className="rule" />
          <span className="count" style={{ color: "var(--ink-faint)" }}>
            {connected.size > 0 ? `${connected.size} connected` : `${HEALTH_DEVICES.length} coming soon`}
          </span>
        </h2>
        <button
          type="button"
          onClick={() => setDevicesOpen((o) => !o)}
          style={{
            background: "none", border: "none", color: "var(--ink-faint)", fontSize: 11,
            fontFamily: "var(--mono)", letterSpacing: ".08em", cursor: "pointer",
            padding: "6px 0", display: "block", width: "100%", textAlign: "center",
          }}
          aria-expanded={devicesOpen}
        >
          {devicesOpen ? "▲ Collapse" : `▼ Show wearable integrations (${HEALTH_DEVICES.length})`}
        </button>
        {devicesOpen && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
          {HEALTH_DEVICES.map((d) => {
            const isConnected = connected.has(d.id);
            const isConnecting = connecting === d.id;
            return (
              <div key={d.id} style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                padding: "13px 15px",
                background: "var(--surface-2)",
                border: `1px solid ${isConnected ? d.color : "var(--line)"}`,
                borderRadius: "var(--r)",
                opacity: d.comingSoon ? 0.45 : 1,
              }}>
                <div style={{
                  width: 36, height: 36,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 16,
                  color: d.comingSoon ? "var(--ink-faint)" : d.color,
                  border: `1.5px solid ${d.comingSoon ? "var(--line)" : d.color}`,
                  borderRadius: "50%",
                  flexShrink: 0,
                }}>
                  {d.icon}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontFamily: "var(--sans)", fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>{d.name}</span>
                    {d.comingSoon && (
                      <span style={{ fontFamily: "var(--mono)", fontSize: 8.5, color: "var(--ink-faint)", border: "1px solid var(--line)", borderRadius: 2, padding: "1px 5px", textTransform: "uppercase", letterSpacing: ".08em" }}>{d.badge}</span>
                    )}
                    {isConnected && (
                      <span style={{ fontFamily: "var(--mono)", fontSize: 8.5, color: "var(--up)", border: "1px solid var(--up)", borderRadius: 2, padding: "1px 5px", textTransform: "uppercase", letterSpacing: ".08em" }}>syncing</span>
                    )}
                  </div>
                  <div style={{ fontFamily: "var(--sans)", fontSize: 11, color: "var(--ink-faint)", marginTop: 2, lineHeight: 1.4 }}>{d.description}</div>
                  <div style={{ display: "flex", gap: 5, marginTop: 6, flexWrap: "wrap" }}>
                    {d.metrics.map((label) => (
                      <span key={label} style={{ fontFamily: "var(--mono)", fontSize: 8.5, color: "var(--ink-faint)", border: "1px solid var(--line)", borderRadius: 2, padding: "1px 5px" }}>{label}</span>
                    ))}
                  </div>
                </div>
                {!d.comingSoon && (
                  <button
                    type="button"
                    disabled={isConnecting}
                    onClick={() => isConnected
                      ? setConnected((p) => { const n = new Set(p); n.delete(d.id); return n; })
                      : handleConnect(d.id)
                    }
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 9.5,
                      padding: "5px 12px",
                      border: `1px solid ${isConnected ? "var(--line)" : d.color}`,
                      borderRadius: "var(--r)",
                      color: isConnected ? "var(--ink-faint)" : d.color,
                      background: "none",
                      cursor: isConnecting ? "default" : "pointer",
                      flexShrink: 0,
                      letterSpacing: ".06em",
                      opacity: isConnecting ? 0.6 : 1,
                    }}
                  >
                    {isConnecting ? "Connecting…" : isConnected ? "Disconnect" : "Connect →"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        )}
        {devicesOpen && (
        <p style={{ fontFamily: "var(--mono)", fontSize: 8.5, color: "var(--ink-faint)", marginTop: 14, lineHeight: 1.6, letterSpacing: ".06em" }}>
          OAUTH 2.0 · END-TO-END ENCRYPTED · NO DATA SOLD
        </p>
        )}
      </div>
    </>
  );
}

// ── Editable fitness routine card (Strength & Conditioning / Yoga & Pilates) ─

// ── Main VitalityModule ───────────────────────────────────────────────────────

const CRONOMETER_OPENED_KEY = "axis-cronometer-opened";

export function VitalityModule() {
  const { toast } = useToast();
  const [tab, setTab] = useState("fit-health");
  const [runChip, setRunChip] = useState("All");
  const [yogaChip, setYogaChip] = useState("All");
  const { sessions: medSessions, addSession, meals, addMeal, removeMeal, loadError: vitalityLogsError } = useVitalityLogs();
  const [mealInput, setMealInput] = useState("");
  const [mealParsing, setMealParsing] = useState(false);
  const [savedRecipes, setSavedRecipes] = useState<Record<string, boolean>>({ r1: true, r3: true, r4: true });
  const [regimenModal, setRegimenModal] = useState<"run" | "lift" | "mobility" | null>(null);
  const [cronometerOpened, setCronometerOpened] = useState(false);
  const [paceUnit, setPaceUnit] = useState<PaceUnit>("km");
  const [raceGoals, setRaceGoals] = useState<RaceGoal[]>(() => {
    if (typeof window === "undefined") return DEFAULT_GOALS;
    try {
      const raw = localStorage.getItem(PR_GOALS_KEY);
      return raw ? (JSON.parse(raw) as RaceGoal[]) : DEFAULT_GOALS;
    } catch { return DEFAULT_GOALS; }
  });
  const [activeGoalId, setActiveGoalId] = useState<string>(() => raceGoals[0]?.id ?? "g1");

  useEffect(() => {
    try { setCronometerOpened(localStorage.getItem(CRONOMETER_OPENED_KEY) === "1"); } catch {}
    try {
      const storedUnit = localStorage.getItem(PACE_UNIT_KEY);
      if (storedUnit === "km" || storedUnit === "mi") setPaceUnit(storedUnit);
    } catch {}
  }, []);

  const { status: stravaStatus, summary: stravaSummary, activities: stravaActivities, highlights: stravaHighlights, loading: stravaLoading, disconnect: stravaDisconnect, setUnit: setStravaUnit, refetchStatus: refetchStravaStatus } = useStrava(paceUnit);
  const { open: openInApp } = useWebViewer();
  const { protocol: nutritionProtocol, updateProtocol, cycleDiet: cycleNutritionDiet, loadError: nutritionLoadError } = useNutritionProtocol();
  const stravaConnected = stravaStatus?.connected ?? false;

  const changePaceUnit = (u: PaceUnit) => {
    setPaceUnit(u);
    setStravaUnit(u);
    try { localStorage.setItem(PACE_UNIT_KEY, u); } catch {}
  };

  const activeGoal = raceGoals.find((g) => g.id === activeGoalId) ?? raceGoals[0] ?? DEFAULT_GOALS[0];

  const persistGoals = (next: RaceGoal[]) => {
    setRaceGoals(next);
    try { localStorage.setItem(PR_GOALS_KEY, JSON.stringify(next)); } catch {}
  };

  const updateActiveGoal = (patch: Partial<RaceGoal>) => {
    persistGoals(raceGoals.map((g) => (g.id === activeGoalId ? { ...g, ...patch } : g)));
  };

  const addGoal = () => {
    const id = `g_${Date.now().toString(36)}`;
    const next: RaceGoal = { id, raceType: "10k", currentTime: "0:50:00", targetTime: "0:45:00" };
    persistGoals([...raceGoals, next]);
    setActiveGoalId(id);
  };

  const removeGoal = (id: string) => {
    if (raceGoals.length <= 1) return;
    const next = raceGoals.filter((g) => g.id !== id);
    persistGoals(next);
    if (activeGoalId === id) setActiveGoalId(next[0]?.id ?? "");
  };

  const toggleRecipe = (id: string) => {
    setSavedRecipes((s) => ({ ...s, [id]: !s[id] }));
    const r = RECIPES.find((r) => r.id === id);
    if (r && !savedRecipes[id]) toast(`"${r.t}" saved to Supper Club`, "success", "Nutrition");
  };

  const openCronometer = () => {
    setCronometerOpened(true);
    try { localStorage.setItem(CRONOMETER_OPENED_KEY, "1"); } catch {}
    openInApp("https://cronometer.com/login/", "Cronometer");
  };

  const logMealWithAI = async () => {
    const text = mealInput.trim();
    if (!text) return;
    setMealParsing(true);
    // Previously misused mode:"capture" (returns {label,action,priority}, never
    // the meal JSON) so AI enrichment never fired — it always logged raw. Now
    // uses the dedicated typed meal-parse action; still logs raw on failure.
    try {
      const result = await callAiAction("mealParse", { text });
      const obj = result.ok ? result.data : null;
      await addMeal({
        emoji: obj?.emoji || "🍽️",
        title: obj?.title || text,
        timing: obj?.timing || "Logged",
        macros: obj?.macros || "—",
      });
      toast(obj?.title ? "Meal logged via AI" : "Meal logged", "success", "Nutrition");
    } finally {
      setMealInput("");
      setMealParsing(false);
    }
  };

  // Derived running stats — real Strava data when connected, otherwise stub
  const sampleWeeklyDist = paceUnit === "mi" ? metresToUnit(38000, "mi") : 38;
  const sampleAvgPace = paceUnit === "mi" ? "8:22" : "5:12";
  const weeklyDist = stravaConnected && stravaSummary ? stravaSummary.weeklyDist : sampleWeeklyDist;
  const weeklyDelta = stravaConnected && stravaSummary ? stravaSummary.weeklyKmDelta : 12;
  const avgPace = stravaConnected && stravaSummary ? stravaSummary.avgPace : sampleAvgPace;
  const runActivities = stravaConnected ? stravaActivities.filter((a) => a.sport_type === "Run" || a.type === "Run") : [];

  const activeTabLabel = TABS.find((t) => t.id === tab)?.label ?? "Health";

  return (
    <>
      <div className="module-stage vitality-stage">
        <ModuleInteractiveHero
          compact
          eyebrow="Wellness · Vitality"
          title={activeTabLabel}
          subtitle={
            stravaConnected
              ? `Strava synced · ${stravaStatus?.athlete?.name ?? "athlete"}`
              : "Connect Strava for live training data"
          }
          stats={[
            { label: "Strava", value: stravaConnected ? "Connected" : "Offline", tone: stravaConnected ? "accent" : "warn" },
            { label: "Tab", value: activeTabLabel },
          ]}
          actions={[
            {
              label: stravaConnected ? "Disconnect Strava" : "Connect Strava",
              onClick: () => {
                if (stravaConnected) stravaDisconnect();
                else {
                  openComposioOAuthPopup("strava", (status) => {
                    if (status === "ok") void refetchStravaStatus();
                  });
                }
              },
            },
            { label: "Training log", onClick: () => setTab("training") },
          ]}
        />

        <div className="module-layout-tools">
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {/* Strava badge — live when connected, faded when not */}
        {stravaConnected ? (
          <div
            className="selectbox"
            style={{ cursor: "pointer" }}
            role="button"
            tabIndex={0}
            title={`Connected as ${stravaStatus?.athlete?.name ?? "Strava"} · click to disconnect`}
            aria-label={`Connected as ${stravaStatus?.athlete?.name ?? "Strava"}, click to disconnect`}
            onClick={() => stravaDisconnect()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                stravaDisconnect();
              }
            }}
          >
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 2L3 14h4l2-4 2 4h4z" opacity=".7" /></svg>
            Synced: Strava
          </div>
        ) : (
          <button
            type="button"
            className="selectbox"
            style={{ opacity: 0.45, cursor: "pointer", background: "none", border: "none" }}
            title={stravaStatus?.configured ? "Connect Strava" : "Set STRAVA_CLIENT_ID + STRAVA_CLIENT_SECRET to enable"}
            onClick={() => {
              openComposioOAuthPopup("strava", (status) => {
                if (status === "ok") void refetchStravaStatus();
              });
            }}
          >
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 2L3 14h4l2-4 2 4h4z" opacity=".7" /></svg>
            {stravaLoading ? "Strava…" : "Connect Strava"}
          </button>
        )}
      </div>
        </div>

        <AxisGlassPanel className="module-glass-zone vitality-workspace">
      <div className="subtabbar">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={`subtab${tab === t.id ? " on" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── MEDITATION TAB ───────────────────────────────────────────────────── */}
      <div className={`subpanel${tab === "fit-meditation" ? " on" : ""}`} id="fit-meditation">
        {vitalityLogsError && (
          <p className="dr-note" style={{ color: "var(--clay)", marginBottom: 12 }}>{vitalityLogsError}</p>
        )}
        {tab === "fit-meditation" && <MeditationTab rawSessions={medSessions} addSession={addSession} />}
      </div>

      {/* ── RUNNING TAB ──────────────────────────────────────────────────────── */}
      <div className={`subpanel${tab === "fit-run" ? " on" : ""}`} id="fit-run">
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
          <div style={{ display: "inline-flex", border: "1px solid var(--line)", borderRadius: "var(--r)", overflow: "hidden" }}>
            {(["km", "mi"] as PaceUnit[]).map((u) => (
              <button
                key={u}
                type="button"
                aria-pressed={paceUnit === u}
                onClick={() => changePaceUnit(u)}
                style={{
                  fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase",
                  padding: "4px 10px", border: "none", cursor: "pointer",
                  background: paceUnit === u ? "var(--accent)" : "transparent",
                  color: paceUnit === u ? "var(--on-accent, #fff)" : "var(--ink-dim)",
                }}
              >
                {u}
              </button>
            ))}
          </div>
        </div>
        <div className="ftop">
          <div className="card tick">
            <div className="seclabel">This Week</div>
            <div className="bigmetric">{weeklyDist}<span style={{ fontSize: 18, color: "var(--ink-faint)" }}> {UNIT_LABELS[paceUnit]}</span></div>
            {stravaConnected ? (
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: weeklyDelta >= 0 ? "var(--up)" : "var(--hi)", marginTop: 4 }}>
                {weeklyDelta >= 0 ? "▴" : "▾"} {Math.abs(weeklyDelta)}% vs last week
              </div>
            ) : (
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-faint)", marginTop: 4 }}>▴ 12% vs last week · sample</div>
            )}
          </div>
          <div className="card">
            <div className="seclabel">Avg Pace</div>
            <div className="bigmetric">{avgPace}<span style={{ fontSize: 18, color: "var(--ink-faint)" }}> /{UNIT_LABELS[paceUnit]}</span></div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-dim)", marginTop: 4 }}>
              {stravaConnected ? "from Strava" : "Zone 2 · HR 142 · sample"}
            </div>
          </div>
          <div className="card">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div className="seclabel">Goal · {raceGoalLabel(activeGoal)}</div>
              <div style={{ display: "flex", gap: 4 }}>
                <select
                  aria-label="Select race goal"
                  value={activeGoalId}
                  onChange={(e) => setActiveGoalId(e.target.value)}
                  style={{ ...editFieldStyle, width: "auto", fontSize: 9.5, padding: "2px 4px" }}
                >
                  {raceGoals.map((g) => <option key={g.id} value={g.id}>{raceGoalLabel(g)}</option>)}
                </select>
                <button type="button" className="rings-edit" title="Add goal" aria-label="Add goal" onClick={addGoal} style={{ background: "none", border: "none", padding: 0, fontSize: 13 }}>+</button>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
              <input
                aria-label="Current time"
                value={activeGoal.currentTime}
                onChange={(e) => updateActiveGoal({ currentTime: e.target.value })}
                placeholder="1:34:00"
                style={{ ...editFieldStyle, width: 64, fontSize: 13, padding: "3px 5px" }}
              />
              <span style={{ color: "var(--ink-faint)" }}>→</span>
              <input
                aria-label="Target time"
                value={activeGoal.targetTime}
                onChange={(e) => updateActiveGoal({ targetTime: e.target.value })}
                placeholder="1:29:00"
                style={{ ...editFieldStyle, width: 64, fontSize: 13, padding: "3px 5px" }}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
              <select
                aria-label="Race type"
                value={activeGoal.raceType}
                onChange={(e) => updateActiveGoal({ raceType: e.target.value as RaceType })}
                style={{ ...editFieldStyle, fontSize: 10 }}
              >
                {RACE_TYPES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
              {activeGoal.raceType === "custom" && (
                <input
                  aria-label="Custom race label"
                  value={activeGoal.customLabel ?? ""}
                  placeholder="Race name"
                  onChange={(e) => updateActiveGoal({ customLabel: e.target.value })}
                  style={{ ...editFieldStyle, fontSize: 10 }}
                />
              )}
              {raceGoals.length > 1 && (
                <button type="button" className="del" title="Remove goal" aria-label="Remove goal" onClick={() => removeGoal(activeGoalId)} style={{ fontSize: 13, flexShrink: 0 }}>×</button>
              )}
            </div>
            <div className="track" style={{ marginTop: 8 }}><div style={{ width: `${goalProgressPct(activeGoal)}%` }} /></div>
          </div>
        </div>

        {/* Strava highlights — kudos, PRs, achievements */}
        {stravaConnected && stravaHighlights && (stravaHighlights.totalKudos > 0 || stravaHighlights.prActivityCount > 0) && (
          <div className="card" style={{ marginTop: 14 }}>
            <h2 className="sec">
              Highlights<span className="rule" />
              <span className="count">👏 {stravaHighlights.totalKudos} kudos</span>
            </h2>
            {stravaHighlights.prActivities.length > 0 ? (
              <div style={{ marginTop: 10 }}>
                {stravaHighlights.prActivities.map((a) => (
                  <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: "1px solid var(--line)" }}>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", minWidth: 68 }}>{fmtDate(a.start_date)}</div>
                    <div style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--ink)", flex: 1 }}>{a.name}</div>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-2)", minWidth: 44, textAlign: "right" }}>{metresToUnit(a.distance, paceUnit)} {UNIT_LABELS[paceUnit]}</div>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 8.5, padding: "2px 6px", borderRadius: 2, border: "1px solid var(--gold)", color: "var(--gold)", textTransform: "uppercase", letterSpacing: ".06em" }}>
                      {(a.pr_count ?? 0) > 0 ? "PR" : "Achievement"}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ fontSize: 11, color: "var(--ink-faint)", marginTop: 10 }}>No PRs or achievements yet this period — keep training.</p>
            )}
          </div>
        )}

        {/* Strava connect prompt if not connected */}
        {!stravaConnected && !stravaLoading && (
          <div style={{ marginTop: 2, padding: "10px 14px", background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: "var(--r)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div>
              <div style={{ fontFamily: "var(--sans)", fontSize: 12, fontWeight: 500, color: "var(--ink)", marginBottom: 2 }}>Connect Strava for live data</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-faint)" }}>Weekly mileage, pace trends, and recent activities pulled from your real runs.</div>
            </div>
            <button
              type="button"
              style={{ flexShrink: 0, fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".08em", textTransform: "uppercase", padding: "6px 14px", border: "1px solid var(--accent)", borderRadius: "var(--r)", background: "transparent", color: "var(--accent)", whiteSpace: "nowrap", cursor: "pointer" }}
              onClick={() => {
                openComposioOAuthPopup("strava", (status) => {
                  if (status === "ok") void refetchStravaStatus();
                });
              }}
            >
              Connect Strava →
            </button>
          </div>
        )}

        <div className="divider" />
        <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 16, alignItems: "start" }}>
          <div className="card">
            <h2 className="sec">
              Training Plan · This Week<span className="rule" />
              <span className="count">{stravaConnected ? "Strava-informed" : "Adaptive"}</span>
            </h2>
            <svg viewBox="0 0 320 90" style={{ width: "100%", height: 90, margin: "12px 0" }}>
              <polyline fill="none" stroke="var(--accent)" strokeWidth="2" points="0,60 50,55 100,30 150,62 200,48 250,20 300,70" />
              <line x1="0" y1="80" x2="320" y2="80" stroke="var(--line)" />
            </svg>
            <div className="ex"><span>Mon — Easy 6 km</span><span className="es">Z2</span></div>
            <div className="ex"><span>Wed — Intervals 6×800m</span><span className="es">Z4</span></div>
            <div className="ex"><span>Sat — Long run 16 km</span><span className="es">Z2</span></div>
            <div style={{ marginTop: 14 }}>
              <button type="button" className="aibtn" onClick={() => setRegimenModal("run")} style={{ cursor: "pointer" }}>
                <AiIcon />{stravaConnected ? "Re-plan with AI + Strava data →" : "Re-plan with AI → Schedule"}
              </button>
            </div>
          </div>
          <div className="card">
            <h2 className="sec">Running Briefing<span className="rule" /></h2>
            <BriefingList
              emptyLabel="No reads available right now."
              feedUrls={[
                "https://www.letsrun.com/feed/",
                "https://www.runnersworld.com/rss/all.xml/",
                "https://www.dcrainmaker.com/feed",
                "https://www.outsideonline.com/feed",
              ]}
            />
          </div>
        </div>

        {/* Strava recent activities */}
        {stravaConnected && runActivities.length > 0 && (
          <>
            <div className="divider" />
            <h2 className="sec" style={{ marginBottom: 10 }}>
              Recent Runs<span className="rule" />
              <span className="count">Strava · live</span>
            </h2>
            <StravaRunList activities={runActivities} />
          </>
        )}

        <div className="divider" />
        <h2 className="sec" style={{ marginBottom: 14 }}>Running Videos<span className="rule" /><span className="count">Curated · YouTube</span></h2>
        <ChipRow chips={RUN_CHIPS} active={runChip} onPick={setRunChip} />
        <div className="vidgrid" id="runVids">
          {RUN_VIDEOS.filter((v) => runChip === "All" || v.tag === runChip).map((v) => <VidCard key={v.t} v={v} />)}
        </div>
      </div>

      {/* ── STRENGTH TAB ──────────────────────────────────────────────────────── */}
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
          <button type="button" className="aibtn" onClick={() => setRegimenModal("lift")} style={{ cursor: "pointer" }}>
            <AiIcon />Build a Session with AI
          </button>
        </div>
        <div className="divider" />
        <h2 className="sec" style={{ marginBottom: 14 }}>Strength &amp; Conditioning Reads<span className="rule" /></h2>
        <BriefingList
          artlink
          columns
          emptyLabel="No reads available right now."
          feedUrls={[
            "https://www.menshealth.com/rss/fitness.xml/",
            "https://www.muscleandfitness.com/feed/",
            "https://www.gq.com/feed/rss",
          ]}
        />
      </div>

      {/* ── YOGA TAB ──────────────────────────────────────────────────────────── */}
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
            <button type="button" className="aibtn" onClick={() => setRegimenModal("lift")} style={{ cursor: "pointer" }}>
              <AiIcon />Build a Flow with AI
            </button>
          </div>
        </div>
        <h2 className="sec" style={{ marginBottom: 14 }}>Yoga &amp; Pilates Videos<span className="rule" /><span className="count">Curated · YouTube</span></h2>
        <ChipRow chips={YOGA_CHIPS} active={yogaChip} onPick={setYogaChip} />
        <div className="vidgrid" id="yogaVids">
          {YOGA_VIDEOS.filter((v) => yogaChip === "All" || v.tag === yogaChip).map((v) => <VidCard key={v.t} v={v} />)}
        </div>
      </div>

      {/* ── NUTRITION TAB ─────────────────────────────────────────────────────── */}
      <div className={`subpanel${tab === "fit-nutrition" ? " on" : ""}`} id="fit-nutrition">
        {nutritionLoadError && (
          <p className="dr-note" style={{ color: "var(--clay)", marginBottom: 12 }}>{nutritionLoadError}</p>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "0 0 18px" }}>
          <div className="selectbox" onClick={cycleNutritionDiet} title="Click to cycle diet protocol" role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); cycleNutritionDiet(); } }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 3v18M5 8c0 4 3 5 7 5M19 8c0 4-3 5-7 5" /></svg>
            <span>Diet: {DIET_LABEL[nutritionProtocol?.diet_protocol ?? "high-protein"]}</span>
          </div>
          <div
            className="selectbox"
            onClick={openCronometer}
            title={cronometerOpened ? "Open Cronometer again" : "Not connected — tap to open Cronometer"}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openCronometer(); } }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 12h4l2-7 4 14 2-7h4" /></svg>
            {cronometerOpened ? "Cronometer · opened" : "Open Cronometer"}
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
                <div className="meal" key={meal.id}>
                  <div className="meal-ic">{meal.emoji}</div>
                  <div className="meal-b">
                    <div className="meal-t">{meal.title}</div>
                    <div className="meal-m">{meal.timing}</div>
                  </div>
                  <div className="meal-k">{meal.macros}</div>
                  <button type="button" className="meal-x" title="Remove" aria-label={`Remove ${meal.title}`} onClick={() => removeMeal(meal.id)}>✕</button>
                </div>
              ))}
            </div>
            <div className="addtask" style={{ marginTop: 12, display: "flex", gap: 6 }}>
              <input
                placeholder="+ Log a meal… (try 'oatmeal &amp; eggs, 520 kcal, P30')"
                value={mealInput}
                onChange={(e) => setMealInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && logMealWithAI()}
                style={{ flex: 1 }}
              />
              <button type="button" className="sig-go" style={{ fontSize: 10, padding: "6px 12px", flexShrink: 0 }} onClick={logMealWithAI} disabled={mealParsing}>
                {mealParsing ? "…" : "✦ Log"}
              </button>
            </div>
            <div style={{ fontSize: 10, color: "var(--ink-faint)", fontFamily: "var(--mono)", marginTop: 6 }}>AI parses food, estimates macros. Star recipes above to save to Supper Club.</div>
          </div>
          <div className="card">
            <h2 className="sec">Targets &amp; Notes<span className="rule" /></h2>
            <div style={{ marginTop: 12 }}>
              <div className="metricrow">
                <span className="metric-k">Diet protocol</span>
                <select
                  className="metric-v"
                  style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 4, padding: "3px 6px", fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-2)" }}
                  value={nutritionProtocol?.diet_protocol ?? "high-protein"}
                  onChange={(e) => updateProtocol({ diet_protocol: e.target.value as Diet })}
                >
                  {DIETS.map((d) => <option key={d} value={d}>{DIET_LABEL[d]}</option>)}
                </select>
              </div>
              <div className="metricrow">
                <span className="metric-k">Protein target</span>
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={nutritionProtocol?.protein_target_g_per_lb ?? 1.0}
                    onChange={(e) => updateProtocol({ protein_target_g_per_lb: Math.max(0, Number(e.target.value) || 0) })}
                    style={{ width: 52, background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 4, padding: "3px 6px", fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-2)" }}
                  />
                  <span className="metric-v" style={{ fontSize: 11 }}>g/lb</span>
                </span>
              </div>
              <div className="metricrow">
                <span className="metric-k">Hydration</span>
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={nutritionProtocol?.hydration_current_l ?? 0}
                    onChange={(e) => updateProtocol({ hydration_current_l: Math.max(0, Number(e.target.value) || 0) })}
                    style={{ width: 44, background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 4, padding: "3px 6px", fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-2)" }}
                  />
                  <span className="metric-v" style={{ fontSize: 11 }}>/</span>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={nutritionProtocol?.hydration_target_l ?? 3.0}
                    onChange={(e) => updateProtocol({ hydration_target_l: Math.max(0, Number(e.target.value) || 0) })}
                    style={{ width: 44, background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 4, padding: "3px 6px", fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-2)" }}
                  />
                  <span className="metric-v" style={{ fontSize: 11 }}>L</span>
                </span>
              </div>
              <div className="metricrow">
                <span className="metric-k">Training-day carbs</span>
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span className="metric-v up" style={{ fontSize: 11 }}>+</span>
                  <input
                    type="number"
                    min={0}
                    value={nutritionProtocol?.training_day_carb_bump_g ?? 40}
                    onChange={(e) => updateProtocol({ training_day_carb_bump_g: Math.max(0, Number(e.target.value) || 0) })}
                    style={{ width: 48, background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 4, padding: "3px 6px", fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-2)" }}
                  />
                  <span className="metric-v up" style={{ fontSize: 11 }}>g</span>
                </span>
              </div>
              <textarea
                value={nutritionProtocol?.notes ?? ""}
                onChange={(e) => updateProtocol({ notes: e.target.value })}
                placeholder="On long-run days AXIS nudges carbs up and front-loads them. Macros adapt to your selected protocol."
                rows={3}
                style={{ width: "100%", marginTop: 12, resize: "vertical", background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: "var(--r)", padding: "8px 10px", fontFamily: "var(--sans)", fontSize: 11, color: "var(--ink-dim)", lineHeight: 1.55, boxSizing: "border-box" }}
              />
            </div>
          </div>
        </div>
        <div className="divider" />
        <h2 className="sec" style={{ marginBottom: 6 }}>
          Recommended Recipes<span className="rule" /><span className="count">{DIET_LABEL[nutritionProtocol?.diet_protocol ?? "high-protein"]}</span>
          <button type="button" className="rings-edit" aria-label="Refresh recipes" title="Refresh recipes" style={{ background: "none", border: "none", padding: 0 }}>↻</button>
        </h2>
        <div className="recipe-grid" id="nutritionRecipes">
          {RECIPES.filter((r) => r.diets.includes(nutritionProtocol?.diet_protocol ?? "high-protein")).map((r) => (
            <div className="recipe" key={r.id} onClick={() => openInApp(recipeUrl(r), r.t)}>
              <div className="rc-img" style={{ background: r.g }}>
                <span className="rc-diet">{DIET_LABEL[r.diets[0]]}</span>
                <button
                  type="button"
                  className={`rc-save${savedRecipes[r.id] ? " on" : ""}`}
                  title="Save to Supper Club"
                  aria-pressed={!!savedRecipes[r.id]}
                  aria-label="Save to Supper Club"
                  onClick={(e) => { e.stopPropagation(); toggleRecipe(r.id); }}
                >
                  {savedRecipes[r.id] ? "★" : "☆"}
                </button>
              </div>
              <div className="rc-b">
                <div className="rc-t">{r.t}</div>
                <div className="rc-meta"><span>{r.kcal} kcal</span>{r.p != null && <span>P {r.p}g</span>}<span>{r.time}</span></div>
                <div className="rc-src">{r.src} ↗</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── HEALTH TAB ────────────────────────────────────────────────────────── */}
      <div className={`subpanel${tab === "fit-health" ? " on" : ""}`} id="fit-health">
        <TrainingWeekPlanner />
        <div className="divider" />
        <HealthMetricsPanel />
      </div>
        </AxisGlassPanel>
      </div>

      {/* ── Modals ─────────────────────────────────────────────────────────────── */}
      {regimenModal && (
        <AIRegimenModal
          discipline={regimenModal}
          open={true}
          onClose={() => setRegimenModal(null)}
          stravaContext={regimenModal === "run" && stravaConnected && stravaSummary ? stravaSummary.stravaContext : undefined}
        />
      )}

    </>
  );
}
