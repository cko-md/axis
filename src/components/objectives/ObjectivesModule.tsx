"use client";

import { useMemo, useState } from "react";
import { formatProgressEntry, formatProgressTime, netProgress, type KeyResultProgressEntry } from "@/lib/objectives/progress";
import { Button } from "@/components/ui/Button";
import { ModuleInteractiveHero, type HeroStatTone } from "@/components/ui/axis/ModuleInteractiveHero";
import { Modal } from "@/components/ui/Modal";
import { StatusCallout } from "@/components/ui/StatusCallout";
import { useToast } from "@/components/ui/Toast";
import { useTasks } from "@/lib/hooks/useTasks";
import { useNotes } from "@/lib/hooks/useNotes";
import {
  useObjectives,
  habitHeat,
  habitPct,
  habitStreak,
  todayIso,
  type Objective,
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
  const { tasks, addTask } = useTasks();
  const { createNote, updateNote } = useNotes();
  const {
    objectives,
    habits,
    loading,
    loadError,
    signedIn,
    addObjective,
    updateObjective,
    deleteObjective,
    addKeyResult,
    updateKeyResult,
    deleteKeyResult,
    fetchKeyResultHistory,
    addHabit,
    deleteHabit,
    toggleHabitToday,
  } = useObjectives();

  const [scanOpen, setScanOpen] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [results, setResults] = useState<Array<{ target: string; module: string; confidence: string }>>([]);

  const [objModalOpen, setObjModalOpen] = useState(false);
  const [objForm, setObjForm] = useState({ title: "", descriptor: "" });
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailForm, setDetailForm] = useState({ title: "", descriptor: "" });
  const [krModalFor, setKrModalFor] = useState<string | null>(null);
  const [krForm, setKrForm] = useState({ title: "", target: "5" });
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [history, setHistory] = useState<KeyResultProgressEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [nextAction, setNextAction] = useState("");
  const [aiSuggestion, setAiSuggestion] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const [habitModalOpen, setHabitModalOpen] = useState(false);
  const [habitForm, setHabitForm] = useState({ icon: "✦", name: "" });
  const [pendingDeleteObjective, setPendingDeleteObjective] = useState<string | null>(null);

  const runScan = async () => {
    setScanOpen(true);
    setScanning(true);
    setResults([]);
    setScanError(null);
    try {
      const res = await fetch("/api/objectives/scan", { method: "POST" });
      const data = (await res.json()) as { results?: typeof results; error?: string };
      if (!res.ok) {
        setScanError(data.error ?? "Platform scan failed.");
        setResults([]);
      } else {
        setResults(data.results ?? []);
        if (data.error) setScanError(data.error);
        else if ((data.results ?? []).length === 0) setScanError("No objectives suggested from recent activity.");
      }
    } catch {
      setResults([]);
      setScanError("Could not reach the scan service.");
    }
    setScanning(false);
  };

  const objectiveProgress = (objective: Objective) => {
    const krCount = objective.key_results.length;
    return krCount
      ? Math.round(
          (objective.key_results.reduce(
            (s, kr) => s + Math.min(1, kr.target_value > 0 ? kr.current_value / kr.target_value : 0),
            0,
          ) /
            krCount) *
            100,
        )
      : 0;
  };

  const selectedObjective = useMemo(
    () => objectives.find((o) => o.id === detailId) ?? null,
    [detailId, objectives],
  );

  const linkedTasks = useMemo(() => {
    if (!selectedObjective) return [];
    return tasks.filter((task) => {
      const metadata = task.metadata ?? {};
      return metadata.objective_id === selectedObjective.id || metadata.source_object_id === selectedObjective.id;
    });
  }, [selectedObjective, tasks]);

  const openDetail = (objective: Objective) => {
    setDetailId(objective.id);
    setDetailForm({ title: objective.title, descriptor: objective.descriptor });
    setNextAction("");
    setAiSuggestion("");
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
    if (result.data) openDetail(result.data);
  };

  const saveObjectiveDetail = async () => {
    if (!selectedObjective) return;
    if (!detailForm.title.trim()) {
      toast("Give the objective a title.", "warn", "Objectives");
      return;
    }
    const result = await updateObjective(selectedObjective.id, {
      title: detailForm.title.trim(),
      descriptor: detailForm.descriptor.trim(),
    });
    if (result.error) {
      toast(result.error, "error", "Objectives");
      return;
    }
    toast("Objective updated.", "success", "Objectives");
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

  const loadHistory = async (krId: string) => {
    setHistoryLoading(true);
    try {
      setHistory(await fetchKeyResultHistory(krId));
    } finally {
      setHistoryLoading(false);
    }
  };

  const toggleHistory = async (krId: string) => {
    if (historyFor === krId) {
      setHistoryFor(null);
      return;
    }
    setHistoryFor(krId);
    await loadHistory(krId);
  };

  const stepKeyResult = async (kr: KeyResult, delta: number) => {
    const next = Math.min(Math.max(kr.current_value + delta, 0), kr.target_value);
    if (next === kr.current_value) return;
    const result = await updateKeyResult(kr.id, { current_value: next }, "manual");
    if (result.error) {
      toast(result.error, "error", "Objectives");
      return;
    }
    if (result.historyError) toast(result.historyError, "warn", "Objectives");
    // Keep an open history panel in sync with the change just made.
    if (historyFor === kr.id) void loadHistory(kr.id);
  };

  const createNextActionTask = async () => {
    if (!selectedObjective) return;
    const title = nextAction.trim() || aiSuggestion.trim();
    if (!title) {
      toast("Add a next action first.", "warn", "Objectives");
      return;
    }
    const task = await addTask({
      title,
      category: "personal",
      priority: "med",
      metadata: {
        source_object_type: "objective",
        source_object_id: selectedObjective.id,
        objective_id: selectedObjective.id,
        source_route: "/objectives",
      },
    });
    if (!task) {
      toast("Could not create task.", "error", "Objectives");
      return;
    }
    setNextAction("");
    toast("Next action added to Tasks.", "success", "Objectives");
  };

  const suggestNextAction = async () => {
    if (!selectedObjective || suggesting) return;
    setSuggesting(true);
    setAiSuggestion("");
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "pipeline-draft",
          text: selectedObjective.title,
          body: JSON.stringify({
            kind: "objective-next-action",
            descriptor: selectedObjective.descriptor,
            progress: objectiveProgress(selectedObjective),
            key_results: selectedObjective.key_results.map((kr) => ({
              title: kr.title,
              current: kr.current_value,
              target: kr.target_value,
            })),
            open_tasks: linkedTasks.filter((task) => task.status !== "done").map((task) => task.title),
          }),
        }),
      });
      const data = (await res.json()) as { draft?: string };
      const suggestion = data.draft?.trim() || `Define the next concrete action for "${selectedObjective.title}".`;
      setAiSuggestion(suggestion);
      setNextAction((current) => current || suggestion.split("\n")[0].replace(/^[-*]\s*/, ""));
    } catch {
      toast("Could not reach the assistant.", "error", "Objectives");
    } finally {
      setSuggesting(false);
    }
  };

  const createDebriefReview = async () => {
    if (!selectedObjective) return;
    const note = await createNote(`Objective review — ${selectedObjective.title}`, "Debrief");
    if (!note) {
      toast("Could not create Debrief review.", "error", "Objectives");
      return;
    }
    const body = [
      `<p><strong>${selectedObjective.title}</strong></p>`,
      selectedObjective.descriptor ? `<p>${selectedObjective.descriptor}</p>` : "",
      `<p>Progress: ${objectiveProgress(selectedObjective)}%</p>`,
      "<p><strong>Key results</strong></p>",
      `<ul>${selectedObjective.key_results.map((kr) => `<li>${kr.title}: ${kr.current_value} / ${kr.target_value}</li>`).join("")}</ul>`,
      linkedTasks.length ? "<p><strong>Linked tasks</strong></p>" : "",
      linkedTasks.length ? `<ul>${linkedTasks.map((task) => `<li>${task.title} — ${task.status}</li>`).join("")}</ul>` : "",
      "<p><strong>Review</strong></p><p></p>",
    ].filter(Boolean).join("");
    await updateNote(note.id, { body });
    toast("Objective review created in Debrief notes.", "success", "Objectives");
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

  // Header stats derived from already-loaded objectives/habits. When signed out
  // the module renders sample content (not real data), so the header says so
  // honestly rather than reporting an empty-looking "0 objectives".
  const heroStats = useMemo<{ label: string; value: string; tone?: HeroStatTone; hint?: string }[]>(() => {
    if (!signedIn) {
      return [{ label: "Status", value: "Sample", tone: "warn", hint: "Sign in to track yours" }];
    }
    const krList = objectives.flatMap((o) => o.key_results);
    const krProgress = krList.length
      ? Math.round(
          (krList.reduce(
            (s, kr) => s + Math.min(1, kr.target_value > 0 ? kr.current_value / kr.target_value : 0),
            0,
          ) /
            krList.length) *
            100,
        )
      : 0;
    const stats: { label: string; value: string; tone?: HeroStatTone; hint?: string }[] = [
      { label: "Objectives", value: String(objectives.length), tone: objectives.length > 0 ? "accent" : "default" },
    ];
    if (krList.length > 0) {
      stats.push({ label: "KR progress", value: `${krProgress}%`, tone: krProgress >= 100 ? "success" : "default" });
    }
    stats.push({ label: "Habits", value: String(habits.length), tone: habits.length > 0 ? "accent" : "default" });
    return stats;
  }, [signedIn, objectives, habits]);

  return (
    <>
      <ModuleInteractiveHero
        compact
        eyebrow="Plan · Objectives"
        title="Objectives"
        subtitle="Set outcomes, measure them with key results, and grow daily habits."
        loading={loading && objectives.length === 0}
        stats={heroStats}
        actions={[
          { label: "+ New objective", onClick: () => setObjModalOpen(true), primary: true },
          { label: "✦ Scan targets", onClick: () => void runScan() },
        ]}
      />

      <div className="divider" />
      <div className="crm-toolbar">
        <button type="button" className="sig-go" onClick={() => setObjModalOpen(true)}>+ New Objective</button>
        <button type="button" className="feed-manage" onClick={runScan}>✦ Scan platform for targets</button>
      </div>

      {loading ? (
        <div className="empty-state">Loading objectives…</div>
      ) : loadError ? (
        <StatusCallout kind="error" title="Objectives unavailable">{loadError}</StatusCallout>
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
            const rollup = objectiveProgress(o);
            return (
            <div className="goal" key={o.id} role="button" tabIndex={0} onClick={() => openDetail(o)} onKeyDown={(e) => e.key === "Enter" && openDetail(o)} style={{ cursor: "pointer" }}>
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
                <Button
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingDeleteObjective(o.id);
                  }}
                  aria-label="Remove objective"
                >
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
                    <button type="button" className="feed-manage" onClick={(e) => { e.stopPropagation(); stepKeyResult(kr, -1); }} aria-label="Decrement">−</button>
                    <button type="button" className="feed-manage" onClick={(e) => { e.stopPropagation(); stepKeyResult(kr, 1); }} aria-label="Increment">+</button>
                    <button
                      type="button"
                      className="feed-manage"
                      aria-label="Remove key result"
                      onClick={async (e) => {
                        e.stopPropagation();
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
                onClick={(e) => {
                  e.stopPropagation();
                  setKrModalFor(o.id);
                }}
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
        ) : scanError ? (
          <StatusCallout kind="info" title="Scan unavailable">{scanError}</StatusCallout>
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
        open={!!selectedObjective}
        onClose={() => setDetailId(null)}
        title="Objective detail"
        footer={
          <>
            <Button variant="ghost" onClick={() => selectedObjective && setKrModalFor(selectedObjective.id)}>+ Key result</Button>
            <Button variant="ghost" onClick={createDebriefReview}>Create Debrief review</Button>
            <Button variant="primary" onClick={saveObjectiveDetail}>Save objective</Button>
          </>
        }
      >
        {selectedObjective && (
          <div className="flex flex-col gap-3">
            <input
              className={inputCls}
              aria-label="Objective title"
              value={detailForm.title}
              onChange={(e) => setDetailForm({ ...detailForm, title: e.target.value })}
            />
            <input
              className={inputCls}
              aria-label="Objective descriptor"
              value={detailForm.descriptor}
              onChange={(e) => setDetailForm({ ...detailForm, descriptor: e.target.value })}
            />
            <div>
              <div className="seclabel">Progress</div>
              <div className="track" style={{ marginTop: 8 }}>
                <div style={{ width: `${objectiveProgress(selectedObjective)}%` }} />
              </div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-faint)", marginTop: 6 }}>
                {objectiveProgress(selectedObjective)}% across {selectedObjective.key_results.length} key result{selectedObjective.key_results.length === 1 ? "" : "s"}
              </div>
            </div>
            <div className="tasklist">
              {selectedObjective.key_results.map((kr) => (
                <div key={kr.id}>
                  <div className="task" style={{ alignItems: "center" }}>
                    <div className="task-main">
                      <div className="task-title">{kr.title}</div>
                      <div className="task-meta">{kr.current_value} / {kr.target_value}</div>
                    </div>
                    <button
                      type="button"
                      className="feed-manage"
                      aria-expanded={historyFor === kr.id}
                      title="Progress history"
                      onClick={() => toggleHistory(kr.id)}
                    >
                      {historyFor === kr.id ? "Hide" : "History"}
                    </button>
                    <button type="button" className="feed-manage" onClick={() => stepKeyResult(kr, -1)}>−</button>
                    <button type="button" className="feed-manage" onClick={() => stepKeyResult(kr, 1)}>+</button>
                  </div>
                  {historyFor === kr.id && (
                    <div style={{ padding: "6px 8px 10px 8px", borderLeft: "2px solid var(--line)", margin: "2px 0 8px 4px" }}>
                      {historyLoading ? (
                        <p style={{ color: "var(--ink-faint)", fontSize: 12, margin: 0 }}>Loading history…</p>
                      ) : history.length === 0 ? (
                        <p style={{ color: "var(--ink-faint)", fontSize: 12, margin: 0 }}>
                          No changes logged yet — use − / + to record progress.
                        </p>
                      ) : (
                        <>
                          <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-faint)", marginBottom: 6, letterSpacing: ".06em", textTransform: "uppercase" }}>
                            Progress log · net {netProgress(history) >= 0 ? "+" : "−"}{Math.abs(netProgress(history))}
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            {history.map((entry) => (
                              <div key={entry.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12 }}>
                                <span style={{ color: entry.delta >= 0 ? "var(--up)" : "var(--clay)" }}>{formatProgressEntry(entry)}</span>
                                <span style={{ color: "var(--ink-faint)" }}>{entry.new_value} / {kr.target_value}</span>
                                <span style={{ color: "var(--ink-faint)", fontVariantNumeric: "tabular-nums" }}>{formatProgressTime(entry.created_at)}</span>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {selectedObjective.key_results.length === 0 && (
                <p style={{ color: "var(--ink-faint)", fontSize: 13, margin: 0 }}>No key results yet.</p>
              )}
            </div>
            <div className="divider" style={{ margin: "6px 0" }} />
            <div>
              <div className="seclabel">Linked tasks</div>
              <div className="tasklist" style={{ marginTop: 8 }}>
                {linkedTasks.length === 0 ? (
                  <p style={{ color: "var(--ink-faint)", fontSize: 13, margin: 0 }}>No linked tasks yet. Add the next action below.</p>
                ) : linkedTasks.map((task) => (
                  <div key={task.id} className="task">
                    <div className={task.status === "done" ? "check done" : "check"} />
                    <div className="task-main">
                      <div className="task-title">{task.title}</div>
                      <div className="task-meta">{task.status} · {task.category}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                className={inputCls}
                style={{ flex: 1, minWidth: 220 }}
                placeholder="Next action"
                value={nextAction}
                onChange={(e) => setNextAction(e.target.value)}
              />
              <Button variant="ghost" onClick={suggestNextAction} disabled={suggesting}>
                {suggesting ? "Thinking…" : "✦ Suggest"}
              </Button>
              <Button variant="primary" onClick={createNextActionTask}>Add Task</Button>
            </div>
            {aiSuggestion && (
              <div style={{ fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.6, background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: "var(--r)", padding: 10, whiteSpace: "pre-wrap" }}>
                {aiSuggestion}
              </div>
            )}
          </div>
        )}
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
