"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  type TrainingSession,
  DOW_LABELS,
  KIND_LABELS,
  INTENSITY_LABELS,
} from "@/lib/hooks/useTrainingWeek";

export type RegimenItem = {
  name: string;
  sets?: number;
  reps?: string;
  weight?: string;
  rest?: string;
  zone?: string;
  dist?: string;
  pace?: string;
};

export type WorkoutLog = {
  sessionId: string;
  items: RegimenItem[];
  warmup?: string;
  cooldown?: string;
  actualDuration?: number;
  rpe?: number;
  logNotes?: string;
  loggedAt?: string;
  aiGenerated?: boolean;
};

const LS_PREFIX = "axis.workout_log.";

function readLog(id: string): WorkoutLog | null {
  try {
    const raw = localStorage.getItem(LS_PREFIX + id);
    return raw ? (JSON.parse(raw) as WorkoutLog) : null;
  } catch {
    return null;
  }
}

function writeLog(log: WorkoutLog) {
  try {
    localStorage.setItem(LS_PREFIX + log.sessionId, JSON.stringify(log));
  } catch {}
}

function defaultItems(session: TrainingSession): RegimenItem[] {
  if (session.kind === "run") {
    const km = Math.round(session.duration_min * 0.16 * 10) / 10;
    if (session.intensity === "easy")
      return [{ name: "Easy run", dist: `${km} km`, zone: "Z1-2" }];
    if (session.intensity === "hard")
      return [
        { name: "Warm-up jog", dist: "2 km", zone: "Z2" },
        { name: "Intervals", reps: "6", dist: "800m", zone: "Z4-5", rest: "90s jog" },
        { name: "Cool-down jog", dist: "2 km", zone: "Z1-2" },
      ];
    if (session.intensity === "key")
      return [{ name: "Long run", dist: `${km} km`, zone: "Z2", pace: "comfortable" }];
    return [{ name: "Tempo run", dist: `${km} km`, zone: "Z3-4" }];
  }
  if (session.kind === "lift")
    return [
      { name: "Compound A", sets: 4, reps: "5-8", rest: "3 min" },
      { name: "Compound B", sets: 3, reps: "8-12", rest: "2 min" },
      { name: "Accessory A", sets: 3, reps: "12-15", rest: "60s" },
      { name: "Accessory B", sets: 3, reps: "15-20", rest: "60s" },
    ];
  if (session.kind === "mobility")
    return [
      { name: "Hip flexor flow", dist: "3 min" },
      { name: "Thoracic rotation", dist: "3 min" },
      { name: "Hamstring / pigeon", dist: "4 min" },
      { name: "Box breathing", dist: "3 min" },
    ];
  return [{ name: session.title || "Session", dist: `${session.duration_min} min` }];
}

function defaultWarmup(kind: string) {
  if (kind === "run") return "5–10 min easy jog + 4 dynamic drills";
  if (kind === "lift") return "5 min cardio + joint mobility circuit";
  return undefined;
}
function defaultCooldown(kind: string) {
  if (kind === "run") return "5 min easy walk + full-body stretch";
  if (kind === "lift") return "Foam roll quads / lats + static hold stretches";
  return undefined;
}

const INTENSITY_COLORS: Record<string, string> = {
  easy: "var(--up)",
  moderate: "var(--accent)",
  hard: "var(--hi)",
  key: "#3f6fb0",
};

const fieldStyle: React.CSSProperties = {
  background: "var(--surface-2)",
  border: "1px solid var(--line)",
  borderRadius: 4,
  padding: "5px 8px",
  color: "var(--ink)",
  fontFamily: "var(--sans)",
  fontSize: 12,
  width: "100%",
  outline: "none",
};

type Props = {
  session: TrainingSession | null;
  onClose: () => void;
  onToggleComplete: (id: string) => void;
};

export function WorkoutDetailModal({ session, onClose, onToggleComplete }: Props) {
  const [log, setLog] = useState<WorkoutLog | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!session) return;
    const existing = readLog(session.id);
    if (existing) {
      setLog(existing);
    } else {
      setLog({
        sessionId: session.id,
        items: defaultItems(session),
        warmup: defaultWarmup(session.kind),
        cooldown: defaultCooldown(session.kind),
      });
    }
    setSaved(false);
  }, [session?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (session) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [session, onClose]);

  const generateWithAI = useCallback(async () => {
    if (!session) return;
    setAiLoading(true);
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "regimen",
          text: session.title,
          body: JSON.stringify({
            kind: session.kind,
            duration_min: session.duration_min,
            intensity: session.intensity,
            notes: session.notes,
          }),
        }),
      });
      const data = (await res.json()) as {
        warmup?: string;
        items?: RegimenItem[];
        cooldown?: string;
      };
      if (data.items?.length) {
        setLog((prev) =>
          prev
            ? {
                ...prev,
                warmup: data.warmup ?? prev.warmup,
                items: data.items!,
                cooldown: data.cooldown ?? prev.cooldown,
                aiGenerated: true,
              }
            : prev,
        );
      }
    } catch {
      // ignore — keep existing regimen
    } finally {
      setAiLoading(false);
    }
  }, [session]);

  const patchItem = useCallback(
    (idx: number, patch: Partial<RegimenItem>) =>
      setLog((l) =>
        l ? { ...l, items: l.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)) } : l,
      ),
    [],
  );

  const removeItem = useCallback(
    (idx: number) =>
      setLog((l) => (l ? { ...l, items: l.items.filter((_, i) => i !== idx) } : l)),
    [],
  );

  const addItem = useCallback(
    () => setLog((l) => (l ? { ...l, items: [...l.items, { name: "" }] } : l)),
    [],
  );

  const save = useCallback(() => {
    if (!log) return;
    writeLog({ ...log, loggedAt: new Date().toISOString() });
    setSaved(true);
    setTimeout(() => setSaved(false), 2200);
  }, [log]);

  if (!session || typeof document === "undefined") return null;

  const dayLabel = DOW_LABELS[session.dow];
  const ic = INTENSITY_COLORS[session.intensity] ?? "var(--ink-dim)";

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.65)",
        backdropFilter: "blur(6px)",
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          width: "min(660px, 96vw)",
          maxHeight: "90vh",
          background: "var(--surface)",
          border: "1px solid var(--line-strong)",
          borderRadius: "var(--r)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 28px 72px rgba(0,0,0,.55)",
        }}
      >
        {/* ── Header ── */}
        <div
          style={{
            padding: "16px 20px 14px",
            borderBottom: "1px solid var(--line)",
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
          }}
        >
          <div style={{ flex: 1 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                marginBottom: 5,
              }}
            >
              {[dayLabel, KIND_LABELS[session.kind]].map((s) => (
                <span
                  key={s}
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 9.5,
                    color: "var(--ink-faint)",
                    textTransform: "uppercase",
                    letterSpacing: ".1em",
                  }}
                >
                  {s}
                </span>
              ))}
              <span
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 9.5,
                  color: ic,
                  textTransform: "uppercase",
                  letterSpacing: ".08em",
                  marginLeft: 2,
                }}
              >
                · {INTENSITY_LABELS[session.intensity]}
              </span>
            </div>
            <h2
              style={{
                fontFamily: "var(--display)",
                fontSize: 23,
                color: "var(--ink)",
                letterSpacing: ".02em",
                margin: 0,
                lineHeight: 1.1,
              }}
            >
              {session.title}
            </h2>
            {(session.duration_min > 0 || session.notes) && (
              <div
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 10.5,
                  color: "var(--ink-dim)",
                  marginTop: 5,
                }}
              >
                {session.duration_min > 0 && `${session.duration_min} min planned`}
                {session.notes ? ` · ${session.notes}` : ""}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => {
                onToggleComplete(session.id);
                onClose();
              }}
              style={{
                fontFamily: "var(--mono)",
                fontSize: 9.5,
                letterSpacing: ".07em",
                textTransform: "uppercase",
                padding: "5px 11px",
                border: "1px solid",
                borderColor: session.completed ? "var(--up)" : "var(--line)",
                borderRadius: "var(--r)",
                background: session.completed ? "var(--up)" : "transparent",
                color: session.completed ? "#fff" : "var(--ink-dim)",
                cursor: "pointer",
                transition: "all .15s",
              }}
            >
              {session.completed ? "✓ Done" : "Mark Done"}
            </button>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: "none",
                border: "none",
                color: "var(--ink-faint)",
                fontSize: 18,
                cursor: "pointer",
                lineHeight: 1,
                padding: 4,
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* ── Scrollable body ── */}
        <div style={{ flex: 1, overflowY: "auto", padding: "18px 20px" }}>
          {log && (
            <>
              {/* Warm-up */}
              {log.warmup !== undefined && (
                <div style={{ marginBottom: 16 }}>
                  <Label>Warm-up</Label>
                  <input
                    value={log.warmup}
                    onChange={(e) => setLog((l) => (l ? { ...l, warmup: e.target.value } : l))}
                    style={{ ...fieldStyle, color: "var(--ink-dim)" }}
                  />
                </div>
              )}

              {/* Regimen */}
              <div style={{ marginBottom: 16 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 9,
                  }}
                >
                  <Label>
                    Regimen{log.aiGenerated ? " · AI-generated" : ""}
                  </Label>
                  <button
                    type="button"
                    onClick={generateWithAI}
                    disabled={aiLoading}
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 9.5,
                      letterSpacing: ".07em",
                      textTransform: "uppercase",
                      padding: "3px 9px",
                      border: "1px solid var(--line)",
                      borderRadius: "var(--r)",
                      background: "transparent",
                      color: "var(--accent)",
                      cursor: aiLoading ? "wait" : "pointer",
                      opacity: aiLoading ? 0.6 : 1,
                    }}
                  >
                    {aiLoading ? "Generating…" : "✦ Design with AI"}
                  </button>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {log.items.map((item, idx) => (
                    <RegimenRow
                      key={idx}
                      item={item}
                      onChange={(patch) => patchItem(idx, patch)}
                      onRemove={() => removeItem(idx)}
                    />
                  ))}
                  <button
                    type="button"
                    onClick={addItem}
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 9.5,
                      letterSpacing: ".07em",
                      textTransform: "uppercase",
                      padding: "6px 10px",
                      border: "1px dashed var(--line)",
                      borderRadius: "var(--r)",
                      background: "transparent",
                      color: "var(--ink-faint)",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    + Add exercise / interval
                  </button>
                </div>
              </div>

              {/* Cool-down */}
              {log.cooldown !== undefined && (
                <div style={{ marginBottom: 16 }}>
                  <Label>Cool-down</Label>
                  <input
                    value={log.cooldown}
                    onChange={(e) => setLog((l) => (l ? { ...l, cooldown: e.target.value } : l))}
                    style={{ ...fieldStyle, color: "var(--ink-dim)" }}
                  />
                </div>
              )}

              <div style={{ height: 1, background: "var(--line)", margin: "20px 0" }} />

              {/* Log Actual */}
              <div>
                <Label>Log Actual</Label>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 10,
                    marginBottom: 10,
                    marginTop: 8,
                  }}
                >
                  <div>
                    <SubLabel>Duration (min)</SubLabel>
                    <input
                      type="number"
                      value={log.actualDuration ?? ""}
                      placeholder={String(session.duration_min)}
                      onChange={(e) =>
                        setLog((l) =>
                          l
                            ? { ...l, actualDuration: Number(e.target.value) || undefined }
                            : l,
                        )
                      }
                      style={fieldStyle}
                    />
                  </div>
                  <div>
                    <SubLabel>RPE (1–10)</SubLabel>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={log.rpe ?? ""}
                      placeholder="7"
                      onChange={(e) =>
                        setLog((l) =>
                          l
                            ? {
                                ...l,
                                rpe: Math.max(1, Math.min(10, Number(e.target.value))),
                              }
                            : l,
                        )
                      }
                      style={fieldStyle}
                    />
                  </div>
                </div>
                <SubLabel>Session notes</SubLabel>
                <textarea
                  value={log.logNotes ?? ""}
                  onChange={(e) =>
                    setLog((l) => (l ? { ...l, logNotes: e.target.value } : l))
                  }
                  placeholder="How did it feel? What went well or needs adjustment…"
                  rows={3}
                  style={{
                    ...fieldStyle,
                    marginTop: 5,
                    resize: "vertical",
                    lineHeight: 1.65,
                    fontFamily: "var(--serif)",
                    fontSize: 12.5,
                  }}
                />
              </div>
            </>
          )}
        </div>

        {/* ── Footer ── */}
        <div
          style={{
            padding: "11px 20px",
            borderTop: "1px solid var(--line)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 9.5,
              color: "var(--ink-faint)",
            }}
          >
            {log?.loggedAt
              ? `Logged ${new Date(log.loggedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}`
              : "Not yet logged"}
          </span>
          <button
            type="button"
            onClick={save}
            style={{
              fontFamily: "var(--mono)",
              fontSize: 10,
              letterSpacing: ".08em",
              textTransform: "uppercase",
              padding: "6px 16px",
              border: "1px solid",
              borderColor: saved ? "var(--up)" : "var(--accent)",
              borderRadius: "var(--r)",
              background: saved ? "var(--up)" : "transparent",
              color: saved ? "#fff" : "var(--accent)",
              cursor: "pointer",
              transition: "all .2s",
            }}
          >
            {saved ? "Saved ✓" : "Save Log"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "var(--mono)",
        fontSize: 9.5,
        color: "var(--ink-faint)",
        textTransform: "uppercase",
        letterSpacing: ".1em",
        marginBottom: 2,
      }}
    >
      {children}
    </div>
  );
}

function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "var(--mono)",
        fontSize: 9.5,
        color: "var(--ink-faint)",
        marginBottom: 4,
      }}
    >
      {children}
    </div>
  );
}

function RegimenRow({
  item,
  onChange,
  onRemove,
}: {
  item: RegimenItem;
  onChange: (p: Partial<RegimenItem>) => void;
  onRemove: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        background: "var(--surface-2)",
        border: "1px solid var(--line)",
        borderRadius: "var(--r)",
        padding: "7px 10px",
      }}
    >
      <input
        value={item.name}
        onChange={(e) => onChange({ name: e.target.value })}
        placeholder="Exercise / interval…"
        style={{
          flex: 2,
          background: "none",
          border: "none",
          color: "var(--ink)",
          fontFamily: "var(--sans)",
          fontSize: 12.5,
          outline: "none",
          minWidth: 0,
        }}
      />
      {/* Sets × Reps */}
      <input
        value={item.sets ?? ""}
        type="number"
        min={1}
        onChange={(e) => onChange({ sets: Number(e.target.value) || undefined })}
        placeholder="sets"
        title="Sets"
        style={{
          width: 38,
          background: "none",
          border: "none",
          borderBottom: "1px solid var(--line)",
          color: "var(--ink-dim)",
          fontFamily: "var(--mono)",
          fontSize: 10.5,
          outline: "none",
          textAlign: "center",
        }}
      />
      <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-faint)" }}>×</span>
      <input
        value={item.reps ?? ""}
        onChange={(e) => onChange({ reps: e.target.value || undefined })}
        placeholder="reps"
        title="Reps"
        style={{
          width: 44,
          background: "none",
          border: "none",
          borderBottom: "1px solid var(--line)",
          color: "var(--ink-dim)",
          fontFamily: "var(--mono)",
          fontSize: 10.5,
          outline: "none",
        }}
      />
      {/* Zone / dist / pace */}
      <input
        value={item.zone ?? item.dist ?? item.pace ?? ""}
        onChange={(e) => onChange({ zone: e.target.value || undefined, dist: undefined, pace: undefined })}
        placeholder="zone / dist"
        title="Zone or distance"
        style={{
          width: 58,
          background: "none",
          border: "none",
          borderBottom: "1px solid var(--line)",
          color: "#3f6fb0",
          fontFamily: "var(--mono)",
          fontSize: 10.5,
          outline: "none",
        }}
      />
      {/* Rest */}
      <input
        value={item.rest ?? ""}
        onChange={(e) => onChange({ rest: e.target.value || undefined })}
        placeholder="rest"
        title="Rest period"
        style={{
          width: 44,
          background: "none",
          border: "none",
          borderBottom: "1px solid var(--line)",
          color: "var(--ink-faint)",
          fontFamily: "var(--mono)",
          fontSize: 10,
          outline: "none",
        }}
      />
      <button
        type="button"
        onClick={onRemove}
        style={{
          background: "none",
          border: "none",
          color: "var(--ink-faint)",
          cursor: "pointer",
          fontSize: 14,
          lineHeight: 1,
          padding: "0 2px",
          flexShrink: 0,
        }}
      >
        ✕
      </button>
    </div>
  );
}
