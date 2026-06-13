"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

type RegimenItem = {
  name: string;
  sets?: number;
  reps?: string;
  rest?: string;
  zone?: string;
  dist?: string;
  pace?: string;
};

type PlanDay = {
  dow: number;
  title: string;
  kind: string;
  duration_min: number;
  intensity: string;
  notes?: string;
  items: RegimenItem[];
};

type PlanResult = { days: PlanDay[]; summary: string };

const DOW_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const INTENSITY_COLOR: Record<string, string> = {
  easy: "var(--up)",
  moderate: "var(--accent)",
  hard: "var(--hi)",
  key: "#3f6fb0",
};

const fieldStyle: React.CSSProperties = {
  background: "var(--surface-2)",
  border: "1px solid var(--line)",
  borderRadius: 4,
  padding: "6px 9px",
  color: "var(--ink)",
  fontFamily: "var(--sans)",
  fontSize: 12.5,
  width: "100%",
  outline: "none",
};

const selStyle: React.CSSProperties = { ...fieldStyle, cursor: "pointer" };

type Props = {
  discipline: "run" | "lift";
  open: boolean;
  onClose: () => void;
  onApply?: (days: PlanDay[]) => void;
};

export function AIRegimenModal({ discipline, open, onClose, onApply }: Props) {
  const [daysPerWeek, setDaysPerWeek] = useState(discipline === "run" ? 4 : 3);
  const [level, setLevel] = useState("intermediate");
  const [goal, setGoal] = useState(
    discipline === "run" ? "sub-1:30 half marathon" : "hypertrophy + strength base",
  );
  const [loading, setLoading] = useState(false);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const generate = async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "regimenPlan",
          text: goal,
          body: JSON.stringify({ discipline, daysPerWeek, currentLevel: level, goal }),
        }),
      });
      const data = (await res.json()) as PlanResult;
      setPlan(data);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1001,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,.7)",
        backdropFilter: "blur(6px)",
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          width: "min(720px, 96vw)",
          maxHeight: "92vh",
          background: "var(--surface)",
          border: "1px solid var(--line-strong)",
          borderRadius: "var(--r)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 28px 72px rgba(0,0,0,.6)",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "15px 20px 13px",
            borderBottom: "1px solid var(--line)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div>
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 9.5,
                color: "var(--accent)",
                textTransform: "uppercase",
                letterSpacing: ".12em",
                marginBottom: 3,
              }}
            >
              ✦ AI Regimen Builder
            </div>
            <h2
              style={{
                fontFamily: "var(--display)",
                fontSize: 20,
                color: "var(--ink)",
                margin: 0,
                letterSpacing: ".02em",
              }}
            >
              {discipline === "run" ? "Running Plan" : "Strength Program"}
            </h2>
          </div>
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
            }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "18px 20px" }}>
          {!plan && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <FormLabel>Goal</FormLabel>
                <input
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  placeholder={
                    discipline === "run"
                      ? "e.g. sub-90 min half marathon, base building…"
                      : "e.g. hypertrophy, powerlifting, hybrid athlete…"
                  }
                  style={{ ...fieldStyle, marginTop: 5 }}
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <FormLabel>
                    {discipline === "run" ? "Training days / week" : "Lifting days / week"}
                  </FormLabel>
                  <select
                    value={daysPerWeek}
                    onChange={(e) => setDaysPerWeek(Number(e.target.value))}
                    style={{ ...selStyle, marginTop: 5 }}
                  >
                    {[2, 3, 4, 5, 6].map((n) => (
                      <option key={n} value={n}>
                        {n} days
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <FormLabel>Current level</FormLabel>
                  <select
                    value={level}
                    onChange={(e) => setLevel(e.target.value)}
                    style={{ ...selStyle, marginTop: 5 }}
                  >
                    {["beginner", "intermediate", "advanced", "competitive"].map((l) => (
                      <option key={l} value={l}>
                        {l.charAt(0).toUpperCase() + l.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {error && (
                <p
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 10.5,
                    color: "var(--hi)",
                    margin: 0,
                  }}
                >
                  Could not reach the assistant. Check your API key and try again.
                </p>
              )}

              <button
                type="button"
                onClick={generate}
                disabled={loading}
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 10,
                  letterSpacing: ".09em",
                  textTransform: "uppercase",
                  padding: "9px 18px",
                  border: "1px solid var(--accent)",
                  borderRadius: "var(--r)",
                  background: "transparent",
                  color: "var(--accent)",
                  cursor: loading ? "wait" : "pointer",
                  opacity: loading ? 0.65 : 1,
                  alignSelf: "flex-start",
                }}
              >
                {loading ? "Generating…" : "✦ Generate Plan"}
              </button>
            </div>
          )}

          {plan && (
            <div>
              <p
                style={{
                  fontFamily: "var(--serif)",
                  fontSize: 13,
                  color: "var(--ink-dim)",
                  lineHeight: 1.65,
                  marginBottom: 18,
                }}
              >
                {plan.summary}
              </p>

              {(!plan.days || plan.days.length === 0) && (
                <p style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--hi)" }}>
                  No plan returned. Check your API key or try again.
                </p>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {(plan.days ?? []).map((day, i) => (
                  <div
                    key={i}
                    style={{
                      border: "1px solid var(--line)",
                      borderRadius: "var(--r)",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "9px 12px",
                        background: "var(--surface-2)",
                        borderBottom: day.items?.length ? "1px solid var(--line)" : "none",
                      }}
                    >
                      <span
                        style={{
                          fontFamily: "var(--mono)",
                          fontSize: 10,
                          color: "var(--ink-faint)",
                          minWidth: 28,
                          textTransform: "uppercase",
                        }}
                      >
                        {DOW_SHORT[day.dow] ?? `D${day.dow}`}
                      </span>
                      <span
                        style={{
                          fontFamily: "var(--sans)",
                          fontSize: 12.5,
                          fontWeight: 500,
                          color: "var(--ink)",
                          flex: 1,
                        }}
                      >
                        {day.title}
                      </span>
                      <span
                        style={{
                          fontFamily: "var(--mono)",
                          fontSize: 9.5,
                          color: INTENSITY_COLOR[day.intensity] ?? "var(--ink-dim)",
                          textTransform: "uppercase",
                        }}
                      >
                        {day.intensity}
                      </span>
                      {day.duration_min > 0 && (
                        <span
                          style={{
                            fontFamily: "var(--mono)",
                            fontSize: 9.5,
                            color: "var(--ink-faint)",
                          }}
                        >
                          {day.duration_min}m
                        </span>
                      )}
                    </div>
                    {day.items?.length > 0 && (
                      <div
                        style={{
                          padding: "8px 12px",
                          display: "flex",
                          flexDirection: "column",
                          gap: 4,
                        }}
                      >
                        {day.items.map((item, j) => (
                          <div key={j} style={{ display: "flex", gap: 10, alignItems: "center" }}>
                            <span
                              style={{
                                fontFamily: "var(--sans)",
                                fontSize: 12,
                                color: "var(--ink)",
                                flex: 1,
                              }}
                            >
                              {item.name}
                            </span>
                            {(item.sets || item.reps) && (
                              <span
                                style={{
                                  fontFamily: "var(--mono)",
                                  fontSize: 10,
                                  color: "var(--ink-dim)",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {item.sets ? `${item.sets}×` : ""}
                                {item.reps ?? ""}
                              </span>
                            )}
                            {(item.dist || item.zone) && (
                              <span
                                style={{
                                  fontFamily: "var(--mono)",
                                  fontSize: 10,
                                  color: "#3f6fb0",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {item.dist ?? item.zone}
                              </span>
                            )}
                            {item.rest && (
                              <span
                                style={{
                                  fontFamily: "var(--mono)",
                                  fontSize: 9.5,
                                  color: "var(--ink-faint)",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {item.rest}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "11px 20px",
            borderTop: "1px solid var(--line)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          {plan ? (
            <>
              <button
                type="button"
                onClick={() => setPlan(null)}
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 10,
                  letterSpacing: ".07em",
                  textTransform: "uppercase",
                  padding: "5px 12px",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--r)",
                  background: "transparent",
                  color: "var(--ink-dim)",
                  cursor: "pointer",
                }}
              >
                ← Regenerate
              </button>
              <div style={{ display: "flex", gap: 8 }}>
                {onApply && (
                  <button
                    type="button"
                    onClick={() => {
                      onApply(plan.days);
                      onClose();
                    }}
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 10,
                      letterSpacing: ".08em",
                      textTransform: "uppercase",
                      padding: "6px 16px",
                      border: "1px solid var(--accent)",
                      borderRadius: "var(--r)",
                      background: "var(--accent)",
                      color: "var(--ground)",
                      cursor: "pointer",
                    }}
                  >
                    Apply to Training Week
                  </button>
                )}
                <button
                  type="button"
                  onClick={onClose}
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 10,
                    letterSpacing: ".07em",
                    textTransform: "uppercase",
                    padding: "5px 12px",
                    border: "1px solid var(--line)",
                    borderRadius: "var(--r)",
                    background: "transparent",
                    color: "var(--ink-dim)",
                    cursor: "pointer",
                  }}
                >
                  Close
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              onClick={onClose}
              style={{
                fontFamily: "var(--mono)",
                fontSize: 10,
                letterSpacing: ".07em",
                textTransform: "uppercase",
                padding: "5px 12px",
                border: "1px solid var(--line)",
                borderRadius: "var(--r)",
                background: "transparent",
                color: "var(--ink-dim)",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function FormLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "var(--mono)",
        fontSize: 9.5,
        color: "var(--ink-faint)",
        textTransform: "uppercase",
        letterSpacing: ".1em",
      }}
    >
      {children}
    </div>
  );
}
