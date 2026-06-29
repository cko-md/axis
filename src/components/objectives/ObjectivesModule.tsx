"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import {
  useObjectives,
  habitHeat,
  habitPct,
  habitStreak,
  todayIso,
  type KeyResult,
} from "@/lib/hooks/useObjectives";

// Signed-out demo content — signed-in users only ever see their real data
const DEMO_HABITS = [
  { ic: "✍️", n: "Write 30 min", streak: "8-day streak", pct: "82%", seed: 3 },
  { ic: "🏃", n: "Move daily", streak: "21-day streak", pct: "95%", seed: 5 },
  { ic: "📖", n: "Read 1 paper", streak: "5-day streak", pct: "68%", seed: 2 },
];


function demoHeatLevels(seed: number): string[] {
  return Array.from({ length: 30 }, (_, i) => {
    const v = (Math.sin(i * 1.3 + seed) + 1) / 2;
    return v > 0.78 ? "l3" : v > 0.55 ? "l2" : v > 0.32 ? "l1" : "";
  });
}

const inputCls = "rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm";

export function ObjectivesModule() {
  const { toast } = useToast();
  const {
    objectives,
    habits,
    loading,
    signedIn,
    addObjective,
    deleteObjective,
    addKeyResult,
    updateKeyResult,
    deleteKeyResult,
    addHabit,
    deleteHabit,
    toggleHabitToday,
  } = useObjectives();

  const [scanOpen, setScanOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [results, setResults] = useState<Array<{ target: string; module: string; confidence: string }>>([]);

  const [objModalOpen, setObjModalOpen] = useState(false);
  const [objForm, setObjForm] = useState({ title: "", descriptor: "" });
  const [krModalFor, setKrModalFor] = useState<string | null>(null);
  const [krForm, setKrForm] = useState({ title: "", target: "5" });
  const [habitModalOpen, setHabitModalOpen] = useState(false);
  const [habitForm, setHabitForm] = useState({ icon: "✦", name: "" });
  const [pendingDeleteObjective, setPendingDeleteObjective] = useState<string | null>(null);

  const runScan = async () => {
    setScanOpen(true);
    setScanning(true);
    setResults([]);
    try {
      const res = await fetch("/api/objectives/scan", { method: "POST" });
      const data = await res.json();
      setResults(data.results ?? []);
    } catch {
      setResults([]);
    }
    setScanning(false);
  };

  const saveObjective = async () => {
    if (!objForm.title.trim()) {
      toast("Give the objective a title.", "warn", "Objectives");
      return;
    }
    if (!signedIn) {
      toast("Sign in to save objectives.", "warn", "Objectives");
      return;
    }
    const result = await addObjective(objForm.title.trim(), objForm.descriptor.trim());
    if (result.error) {
      toast(result.error, "error", "Objectives");
      return;
    }
    toast("Objective added.", "success", "Objectives");
    setObjModalOpen(false);
    setObjForm({ title: "", descriptor: "" });
  };

  const saveKeyResult = async () => {
    if (!krModalFor) return;
    const target = Number(krForm.target);
    if (!krForm.title.trim() || !Number.isFinite(target) || target <= 0) {
      toast("Key result needs a title and a positive target.", "warn", "Objectives");
      return;
    }
    const result = await addKeyResult(krModalFor, krForm.title.trim(), target);
    if (result.error) {
      toast(result.error, "error", "Objectives");
      return;
    }
    toast("Key result added.", "success", "Objectives");
    setKrModalFor(null);
    setKrForm({ title: "", target: "5" });
  };

  const stepKeyResult = async (kr: KeyResult, delta: number) => {
    const next = Math.min(Math.max(kr.current_value + delta, 0), kr.target_value);
    if (next === kr.current_value) return;
    const result = await updateKeyResult(kr.id, { current_value: next });
    if (result.error) toast(result.error, "error", "Objectives");
  };

  const saveHabit = async () => {
    if (!habitForm.name.trim()) {
      toast("Give the habit a name.", "warn", "Objectives");
      return;
    }
    const result = await addHabit(habitForm.icon.trim() || "✦", habitForm.name.trim());
    if (result.error) {
      toast(result.error, "error", "Objectives");
      return;
    }
    toast("Habit added.", "success", "Objectives");
    setHabitModalOpen(false);
    setHabitForm({ icon: "✦", name: "" });
  };

  const confirmDeleteObjective = async () => {
    if (!pendingDeleteObjective) return;
    const result = await deleteObjective(pendingDeleteObjective);
    if (result.error) toast(result.error, "error", "Objectives");
    else toast("Objective removed.", "info", "Objectives");
    setPendingDeleteObjective(null);
  };

  return (
    <>
      <div className="divider" />
      <div className="crm-toolbar">
        <button type="button" className="sig-go" onClick={() => setObjModalOpen(true)}>+ New Objective</button>
        <button type="button" className="feed-manage" onClick={runScan}>✦ Scan platform for targets</button>
      </div>

      {loading ? (
        <div className="empty-state">Loading objectives…</div>
      ) : !signedIn ? (
        <div>
          <div className="goal">
            <div className="go">Build a Publication Record That Earns a Top Residency Match</div>
            <div className="gq">Objective · Research Year 2026</div>
            <div className="kr"><div className="krt">First-author manuscripts submitted</div><div className="track"><div style={{ width: "60%" }} /></div><div className="krv">3 / 5</div></div>
          </div>
        </div>
      ) : objectives.length === 0 ? (
        <div className="empty-state">
          <strong>No objectives yet</strong>
          <p>Set an objective, then measure it with key results.</p>
        </div>
      ) : (
        <div>
          {objectives.map((o) => {
            const krCount = o.key_results.length;
            const rollup = krCount
              ? Math.round(
                  (o.key_results.reduce(
                    (s, kr) => s + Math.min(1, kr.target_value > 0 ? kr.current_value / kr.target_value : 0),
                    0,
                  ) /
                    krCount) *
                    100,
                )
              : 0;
            return (
            <div className="goal" key={o.id}>
              <div className="go" style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <span style={{ flex: 1 }}>{o.title}</span>
                {krCount > 0 && (
                  <span
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                      color: rollup >= 100 ? "var(--up)" : "var(--accent)",
                    }}
                  >
                    {rollup}%
                  </span>
                )}
                <Button variant="ghost" onClick={() => setPendingDeleteObjective(o.id)} aria-label="Remove objective">
                  ✕
                </Button>
              </div>
              {o.descriptor && <div className="gq">{o.descriptor}</div>}
              {krCount > 0 && (
                <div className="track" style={{ marginTop: 8, marginBottom: 2 }}>
                  <div style={{ width: `${rollup}%` }} />
                </div>
              )}
              {o.key_results.map((kr) => (
                <div className="kr" key={kr.id}>
                  <div className="krt">{kr.title}</div>
                  <div className="track">
                    <div style={{ width: `${Math.min(100, (kr.current_value / kr.target_value) * 100)}%` }} />
                  </div>
                  <div className="krv" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {kr.current_value} / {kr.target_value}
                    <button type="button" className="feed-manage" onClick={() => stepKeyResult(kr, -1)} aria-label="Decrement">−</button>
                    <button type="button" className="feed-manage" onClick={() => stepKeyResult(kr, 1)} aria-label="Increment">+</button>
                    <button
                      type="button"
                      className="feed-manage"
                      aria-label="Remove key result"
                      onClick={async () => {
                        const result = await deleteKeyResult(kr.id);
                        if (result.error) toast(result.error, "error", "Objectives");
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
              <button
                type="button"
                className="feed-manage"
                style={{ marginTop: 8 }}
                onClick={() => setKrModalFor(o.id)}
              >
                + Key result
              </button>
            </div>
            );
          })}
        </div>
      )}

      <div className="divider" />
      <h2 className="sec">
        Habit Heatmaps<span className="rule" />
        {signedIn && !loading && (
          <button type="button" className="feed-manage" onClick={() => setHabitModalOpen(true)}>+ New Habit</button>
        )}
      </h2>
      {loading ? null : !signedIn ? (
        <div className="habit-grid">
          {DEMO_HABITS.map((h) => (
            <div key={h.n} className="card habit">
              <div className="hab-top"><span>{h.ic}</span><span className="hab-n">{h.n}</span><span className="hab-p">{h.pct}</span></div>
              <div className="hab-streak">{h.streak}</div>
              <div className="heat">{demoHeatLevels(h.seed).map((l, i) => <i key={i} className={l} />)}</div>
            </div>
          ))}
        </div>
      ) : habits.length === 0 ? (
        <div className="empty-state">
          <strong>No habits yet</strong>
          <p>Add a daily habit and check it off to grow the heatmap.</p>
        </div>
      ) : (
        <div className="habit-grid">
          {habits.map((h) => {
            const streak = habitStreak(h);
            const doneToday = h.checks.includes(todayIso());
            return (
              <div key={h.id} className="card habit">
                <div className="hab-top">
                  <span>{h.icon}</span>
                  <span className="hab-n">{h.name}</span>
                  <span className="hab-p">{habitPct(h)}%</span>
                </div>
                <div className="hab-streak">{streak === 1 ? "1-day streak" : `${streak}-day streak`}</div>
                <div className="heat">{habitHeat(h).map((l, i) => <i key={i} className={l} />)}</div>
                <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                  <button
                    type="button"
                    className={doneToday ? "sig-go" : "feed-manage"}
                    onClick={async () => {
                      const result = await toggleHabitToday(h.id);
                      if (result.error) toast(result.error, "error", "Objectives");
                    }}
                  >
                    {doneToday ? "✓ Done today" : "Mark today"}
                  </button>
                  <button
                    type="button"
                    className="feed-manage"
                    aria-label="Remove habit"
                    onClick={async () => {
                      const result = await deleteHabit(h.id);
                      if (result.error) toast(result.error, "error", "Objectives");
                      else toast("Habit removed.", "info", "Objectives");
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        title="Platform scan"
        footer={
          !scanning && results.length > 0 ? (
            <Button
              variant="primary"
              onClick={async () => {
                for (const r of results) {
                  await addObjective(r.target, r.module);
                }
                setScanOpen(false);
                toast(`Imported ${results.length} objective${results.length === 1 ? "" : "s"}.`, "success", "Objectives");
              }}
            >
              Import all ({results.length})
            </Button>
          ) : undefined
        }
      >
        {scanning ? (
          <p style={{ color: "var(--ink-dim)" }}>Scanning Agenda, Pipeline, Signals, Objectives…</p>
        ) : (
          <div className="tasklist">
            {results.map((r) => (
              <div key={r.target} className="task" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div className="task-main" style={{ flex: 1 }}>
                  <div className="task-title">{r.target}</div>
                  <div className="task-meta">{r.module} · confidence {r.confidence}</div>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    await addObjective(r.target, r.module);
                    setResults((prev) => prev.filter((x) => x.target !== r.target));
                    toast(`"${r.target}" added.`, "success", "Objectives");
                  }}
                  style={{
                    fontSize: "11px",
                    padding: "3px 8px",
                    borderRadius: 4,
                    background: "var(--glass)",
                    border: "1px solid var(--line)",
                    color: "var(--ink-dim)",
                    cursor: "pointer",
                    flexShrink: 0,
                    whiteSpace: "nowrap",
                  }}
                >
                  + Import
                </button>
              </div>
            ))}
          </div>
        )}
      </Modal>

      <Modal
        open={objModalOpen}
        onClose={() => setObjModalOpen(false)}
        title="New objective"
        footer={
          <>
            <Button variant="ghost" onClick={() => setObjModalOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={saveObjective}>Save</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <input
            className={inputCls}
            placeholder="Objective — outcome you're aiming for"
            value={objForm.title}
            onChange={(e) => setObjForm({ ...objForm, title: e.target.value })}
          />
          <input
            className={inputCls}
            placeholder="Descriptor — e.g. Objective · Research Year 2026"
            value={objForm.descriptor}
            onChange={(e) => setObjForm({ ...objForm, descriptor: e.target.value })}
          />
        </div>
      </Modal>

      <Modal
        open={!!krModalFor}
        onClose={() => setKrModalFor(null)}
        title="New key result"
        footer={
          <>
            <Button variant="ghost" onClick={() => setKrModalFor(null)}>Cancel</Button>
            <Button variant="primary" onClick={saveKeyResult}>Save</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <input
            className={inputCls}
            placeholder="Key result — what you'll count"
            value={krForm.title}
            onChange={(e) => setKrForm({ ...krForm, title: e.target.value })}
          />
          <input
            type="number"
            min={1}
            className={inputCls}
            placeholder="Target"
            value={krForm.target}
            onChange={(e) => setKrForm({ ...krForm, target: e.target.value })}
          />
        </div>
      </Modal>

      <Modal
        open={habitModalOpen}
        onClose={() => setHabitModalOpen(false)}
        title="New habit"
        footer={
          <>
            <Button variant="ghost" onClick={() => setHabitModalOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={saveHabit}>Save</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <input
            className={inputCls}
            placeholder="Icon — emoji, e.g. ✍️"
            maxLength={4}
            value={habitForm.icon}
            onChange={(e) => setHabitForm({ ...habitForm, icon: e.target.value })}
          />
          <input
            className={inputCls}
            placeholder="Habit — e.g. Write 30 min"
            value={habitForm.name}
            onChange={(e) => setHabitForm({ ...habitForm, name: e.target.value })}
          />
        </div>
      </Modal>

      <Modal
        open={!!pendingDeleteObjective}
        onClose={() => setPendingDeleteObjective(null)}
        title="Remove objective"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDeleteObjective(null)}>Cancel</Button>
            <Button variant="danger" onClick={confirmDeleteObjective}>Remove</Button>
          </>
        }
      >
        <p style={{ fontSize: 13, color: "var(--ink-dim)" }}>
          Remove this objective and all of its key results?
        </p>
      </Modal>
    </>
  );
}
