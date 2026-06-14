"use client";

import { useCallback, useMemo, useState } from "react";
import {
  classifySignal,
  classifySignals,
  useSignals,
  type Signal,
  type SignalType,
  type SignalClassification,
} from "@/lib/hooks/useSignals";
import {
  DESTINATIONS,
  findMatchingRoute,
  useSignalRoutes,
  type RouteDestination,
  type RoutePriority,
  type SignalRoute,
} from "@/lib/hooks/useSignalRoutes";
import { triageSignalToTask, useTasks, type TaskCategory, type TaskPriority } from "@/lib/hooks/useTasks";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import styles from "./SignalsModule.module.css";

const CHIPS = ["All", "Action", "Awaiting", "FYI", "Routed", "Unread"] as const;
type Chip = (typeof CHIPS)[number];

const GROUPS: { key: SignalType | "routed"; label: string }[] = [
  { key: "action", label: "Action" },
  { key: "awaiting", label: "Awaiting" },
  { key: "fyi", label: "FYI" },
  { key: "routed", label: "Routed" },
];

const destLabel = (id: string) => DESTINATIONS.find((d) => d.id === id)?.label ?? id;

// tasks.category has a CHECK constraint — the AI route may emit "admin"; map it to a valid value.
const VALID_CATEGORIES: TaskCategory[] = ["research", "clinical", "life", "personal"];
const safeCategory = (c: string): TaskCategory => (VALID_CATEGORIES as string[]).includes(c) ? (c as TaskCategory) : "research";

function pillClass(type: SignalType) {
  if (type === "action") return "hi";
  if (type === "awaiting") return "med";
  return "lo";
}

function applyChip(signals: Signal[], chip: Chip) {
  switch (chip) {
    case "All":
      return signals;
    case "Routed":
      return signals.filter((s) => s.routed_at);
    case "Unread":
      return signals.filter((s) => !s.read_at);
    case "Action":
      return signals.filter((s) => s.signal_type === "action" && !s.routed_at);
    case "Awaiting":
      return signals.filter((s) => s.signal_type === "awaiting" && !s.routed_at);
    case "FYI":
      return signals.filter((s) => s.signal_type === "fyi" && !s.routed_at);
    default:
      return signals;
  }
}

export function SignalsModule() {
  const { signals, loading, capture, markRead, routeTo, updateSignal, applyClassification } = useSignals();
  const { routes, addRoute, updateRoute, deleteRoute } = useSignalRoutes();
  const { tasks, addTask } = useTasks();
  const { toast } = useToast();

  const [activeChip, setActiveChip] = useState<Chip>("All");
  const [selected, setSelected] = useState<Signal | null>(null);
  const [suggestion, setSuggestion] = useState<SignalClassification | null>(null);
  const [thinking, setThinking] = useState(false);
  const [batching, setBatching] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [draft, setDraft] = useState("");
  const [routesOpen, setRoutesOpen] = useState(false);

  const filtered = useMemo(() => applyChip(signals, activeChip), [signals, activeChip]);

  // Group the filtered set for display. When showing "All" we group by classification + routed.
  const grouped = useMemo(() => {
    const grouping = activeChip === "All";
    if (!grouping) return null;
    const buckets: Record<string, Signal[]> = { action: [], awaiting: [], fyi: [], routed: [] };
    for (const s of filtered) {
      if (s.routed_at) buckets.routed.push(s);
      else buckets[s.signal_type].push(s);
    }
    return buckets;
  }, [filtered, activeChip]);

  // Live count of the always-selected signal (keeps detail panel in sync after edits).
  const live = selected ? signals.find((s) => s.id === selected.id) ?? selected : null;

  const openDetail = (s: Signal) => {
    setSelected(s);
    // Show any previously-stored AI suggestion immediately.
    if (s.metadata?.ai_destination) {
      setSuggestion({
        signal_type: s.signal_type,
        priority: s.metadata.ai_priority ?? "med",
        destination: s.metadata.ai_destination,
        reason: s.metadata.ai_reason ?? "",
        confidence: s.metadata.ai_confidence ?? 0.6,
      });
    } else {
      setSuggestion(null);
    }
  };

  const closeDetail = () => {
    setSelected(null);
    setSuggestion(null);
  };

  // AI triage a single signal: classify, store on signal, surface suggestion + matching user route.
  const triageOne = async (s: Signal) => {
    setThinking(true);
    toast("Triaging with AI…", "info", "AI Triage");
    const c = await classifySignal(s);
    await applyClassification(s.id, c);
    setSuggestion(c);
    setThinking(false);
    const rule = findMatchingRoute(routes, { ...s, signal_type: c.signal_type });
    toast(
      rule
        ? `Matches your route “${rule.label}” → ${destLabel(rule.destination)}`
        : `Suggested → ${destLabel(c.destination)} · ${c.priority}`,
      "success",
      "AI Triage",
    );
  };

  // Commit a route: stamp signal, and for action/awaiting destined to agenda, materialise a task.
  const commitRoute = async (s: Signal, destination: string, priority: RoutePriority | "hi" | "med" | "lo", via: "ai" | "manual" | "rule") => {
    if (destination === "agenda") {
      const triaged = await triageSignalToTask(s);
      const pri: TaskPriority = priority === "keep" ? triaged.priority : (priority as TaskPriority);
      await addTask({
        title: triaged.title,
        category: safeCategory(triaged.category),
        priority: pri,
        effort: triaged.effort,
      });
    }
    await routeTo(s.id, destination, via);
    toast(`Routed → ${destLabel(destination)}`, "success", "Signals");
    closeDetail();
  };

  // Apply the best matching user route (if any) for the selected signal.
  const applyMatchingRoute = async (s: Signal) => {
    const rule = findMatchingRoute(routes, s);
    if (!rule) {
      toast("No route rule matches this signal", "warn", "Signals");
      return;
    }
    await commitRoute(s, rule.destination, rule.set_priority, "rule");
  };

  // AI triage ALL un-routed signals in one batch, auto-applying any matching user route.
  const triageAll = async () => {
    const pending = signals.filter((s) => !s.routed_at);
    if (pending.length === 0) {
      toast("Nothing to triage — all signals routed", "info", "AI Triage");
      return;
    }
    setBatching(true);
    toast(`Triaging ${pending.length} signals…`, "info", "AI Triage");
    const results = await classifySignals(pending);
    let autoRouted = 0;
    for (const c of results) {
      const s = pending.find((x) => x.id === c.id);
      if (!s) continue;
      await applyClassification(s.id, c);
      // Auto-route only when a user rule with auto_route matches.
      const rule = findMatchingRoute(routes, { ...s, signal_type: c.signal_type });
      if (rule?.auto_route) {
        await commitRouteSilent(s, rule.destination, rule.set_priority, "rule");
        autoRouted += 1;
      }
    }
    setBatching(false);
    toast(
      autoRouted > 0
        ? `Classified ${results.length} · auto-routed ${autoRouted} via your rules`
        : `Classified ${results.length} signals — review suggestions`,
      "success",
      "AI Triage",
    );
  };

  // Like commitRoute but without toast/close — used inside batch loops.
  const commitRouteSilent = async (s: Signal, destination: string, priority: RoutePriority, via: "rule") => {
    if (destination === "agenda") {
      const triaged = await triageSignalToTask(s);
      const pri: TaskPriority = priority === "keep" ? triaged.priority : (priority as TaskPriority);
      await addTask({ title: triaged.title, category: safeCategory(triaged.category), priority: pri, effort: triaged.effort });
    }
    await routeTo(s.id, destination, via);
  };

  // Scan platform modules for new signals via AI — reads tasks + existing signals for context.
  const scanPlatform = useCallback(async () => {
    setScanning(true);
    toast("Scanning platform…", "info", "Dispatch");
    try {
      const existingTitles = signals.map((s) => s.title).slice(0, 20).join("; ");
      const taskCtx = tasks.slice(0, 15).map((t) =>
        `[${t.priority.toUpperCase()}] ${t.title} (${t.category}, ${t.status}${t.deadline ? `, due ${t.deadline}` : ""})`
      ).join("\n");
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "companion",
          text: `You are the Axis dispatch intelligence. Scan the following platform context and identify up to 4 signals that genuinely need attention, routing, or action. Do NOT duplicate signals already in the inbox. Return ONLY a JSON array of objects with keys: title (string, <60 chars), body (string, <120 chars), signal_type ("action"|"awaiting"|"fyi"), source (string). No markdown, just raw JSON.\n\nCurrent tasks:\n${taskCtx || "No tasks."}\n\nAlready in inbox: ${existingTitles || "Empty"}`,
          body: JSON.stringify({ context: "dispatch scan", history: [], persona: "dispatch" }),
        }),
      });
      const data = await res.json() as { response?: string };
      const raw = (data.response ?? "").trim();
      const start = raw.indexOf("[");
      const end   = raw.lastIndexOf("]");
      if (start === -1 || end === -1) throw new Error("No JSON array");
      const items = JSON.parse(raw.slice(start, end + 1)) as Array<{ title: string; body?: string; signal_type?: string; source?: string }>;
      let captured = 0;
      for (const item of items.slice(0, 4)) {
        if (!item.title) continue;
        const type: SignalType = ["action","awaiting","fyi"].includes(item.signal_type ?? "") ? (item.signal_type as SignalType) : "fyi";
        const created = await capture(item.title, type, item.source ?? "Platform Scan");
        if (created && item.body) {
          await updateSignal(created.id, { body: item.body } as Partial<Signal>);
        }
        if (created) captured++;
      }
      toast(captured > 0 ? `${captured} new signal${captured === 1 ? "" : "s"} surfaced` : "Platform looks clear", "success", "Dispatch");
    } catch {
      toast("Scan failed — check connection", "error", "Dispatch");
    } finally {
      setScanning(false);
    }
  }, [signals, tasks, capture, updateSignal, toast]);

  const handleCapture = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    const created = await capture(text, "action", "capture");
    if (created) toast("Signal captured", "success", "Signals");
  };

  if (loading) return <div className="empty-state">Loading signals…</div>;

  const renderRow = (s: Signal) => (
    <div key={s.id} className={s.routed_at ? "task routed" : s.read_at ? "task done" : "task"} onClick={() => openDetail(s)} style={{ cursor: "pointer" }}>
      <div
        className={s.read_at ? "check done" : "check"}
        onClick={(e) => {
          e.stopPropagation();
          markRead(s.id);
        }}
      />
      <div className="task-main">
        <div className="task-title">{s.title}</div>
        <div className="task-meta" style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
          <span className={`pill ${pillClass(s.signal_type)}`}>{s.signal_type.toUpperCase()}</span>
          <span>
            {s.source} · {s.route_target ? `routed → ${destLabel(s.route_target)}` : "unrouted"}
          </span>
          {!s.routed_at && s.metadata?.ai_destination && (
            <span className={styles.aiBadge}>AI → {destLabel(s.metadata.ai_destination)}</span>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <>
        <div className={styles.headActions}>
          <button type="button" className="aibtn" onClick={scanning ? undefined : scanPlatform} title="Scan platform modules for new signals">
            {scanning ? "Scanning…" : "✦ Scan modules"}
          </button>
          <button type="button" className="aibtn" onClick={batching ? undefined : triageAll}>
            {batching ? "Triaging…" : "AI triage all"}
          </button>
          <button type="button" className="savebtn" onClick={() => setRoutesOpen(true)}>
            Routes
          </button>
        </div>
      <div className="divider" />

      <div className="capture" style={{ margin: "0 0 16px", padding: "9px 13px" }}>
        <input
          placeholder="Capture a signal…"
          style={{ padding: "3px 0", fontSize: 13 }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleCapture()}
        />
      </div>

      <div className="chips">
        {CHIPS.map((chip) => (
          <span key={chip} className={chip === activeChip ? "chip on" : "chip"} onClick={() => setActiveChip(chip)}>
            {chip}
          </span>
        ))}
      </div>

      <div className="card">
        {filtered.length === 0 ? (
          <p className={styles.emptyMini}>No signals match this filter.</p>
        ) : grouped ? (
          GROUPS.map((g) => {
            const rows = grouped[g.key];
            if (!rows || rows.length === 0) return null;
            return (
              <div key={g.key}>
                <div className={styles.groupLabel}>
                  {g.label}
                  <span className={styles.groupCount}>{rows.length}</span>
                </div>
                <div className="tasklist">{rows.map(renderRow)}</div>
              </div>
            );
          })
        ) : (
          <div className="tasklist">{filtered.map(renderRow)}</div>
        )}
      </div>

      {/* Per-signal detail panel */}
      <Modal open={!!live} onClose={closeDetail} title="Signal Detail" footer={<Button variant="ghost" onClick={closeDetail}>Close</Button>}>
        {live && (
          <div>
            <h3 style={{ fontSize: 16, marginBottom: 8 }}>{live.title}</h3>
            <p style={{ color: "var(--ink-dim)", marginBottom: 12, fontSize: 13 }}>{live.body ?? "No additional detail."}</p>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-faint)", marginBottom: 14 }}>
              {live.source} · {live.signal_type} · {new Date(live.created_at).toLocaleString()}
              {live.routed_at && ` · routed → ${destLabel(live.route_target ?? "")}`}
            </div>

            {suggestion && (
              <div className={styles.suggest}>
                <div className={styles.suggestHead}>
                  AI suggestion
                  <span className={`pill ${pillClass(suggestion.signal_type)}`}>{suggestion.signal_type.toUpperCase()}</span>
                </div>
                <div className={styles.suggestBody}>
                  Route to <strong style={{ color: "var(--ink)" }}>{destLabel(suggestion.destination)}</strong> at{" "}
                  <strong style={{ color: "var(--ink)" }}>{suggestion.priority}</strong> priority.
                  {suggestion.reason ? ` ${suggestion.reason}.` : ""}
                </div>
                <div className={styles.confBar}>
                  <div className={styles.confFill} style={{ width: `${Math.round(suggestion.confidence * 100)}%` }} />
                </div>
                <button
                  type="button"
                  className="aibtn"
                  style={{ marginTop: 10 }}
                  onClick={() => commitRoute(live, suggestion.destination, suggestion.priority, "ai")}
                >
                  Route → {destLabel(suggestion.destination)}
                </button>
              </div>
            )}

            <div className="seclabel" style={{ marginTop: 14 }}>
              Route to
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
              {DESTINATIONS.map((r) => (
                <button key={r.id} type="button" className="capt-pill" onClick={() => commitRoute(live, r.id, "keep", "manual")}>
                  {r.label}
                </button>
              ))}
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="aibtn" onClick={() => triageOne(live)} disabled={thinking}>
                {thinking ? "Thinking…" : suggestion ? "Re-run AI triage" : "AI triage"}
              </button>
              {findMatchingRoute(routes, live) && (
                <button type="button" className="savebtn" onClick={() => applyMatchingRoute(live)}>
                  Apply matched rule
                </button>
              )}
              {!live.read_at && (
                <button type="button" className="savebtn" onClick={() => updateSignal(live.id, { read_at: new Date().toISOString() })}>
                  Mark read
                </button>
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* Routing rules manager */}
      <RoutesModal
        open={routesOpen}
        onClose={() => setRoutesOpen(false)}
        routes={routes}
        addRoute={addRoute}
        updateRoute={updateRoute}
        deleteRoute={deleteRoute}
      />
    </>
  );
}

/* ── Routes manager ─────────────────────────────────────────────────────── */

type RoutesModalProps = {
  open: boolean;
  onClose: () => void;
  routes: SignalRoute[];
  addRoute: ReturnType<typeof useSignalRoutes>["addRoute"];
  updateRoute: ReturnType<typeof useSignalRoutes>["updateRoute"];
  deleteRoute: ReturnType<typeof useSignalRoutes>["deleteRoute"];
};

const PRIORITIES: { id: RoutePriority; label: string }[] = [
  { id: "keep", label: "Keep" },
  { id: "hi", label: "High" },
  { id: "med", label: "Medium" },
  { id: "lo", label: "Low" },
];

const TYPE_OPTS: { id: "" | SignalType; label: string }[] = [
  { id: "", label: "Any type" },
  { id: "action", label: "Action" },
  { id: "awaiting", label: "Awaiting" },
  { id: "fyi", label: "FYI" },
];

function RoutesModal({ open, onClose, routes, addRoute, updateRoute, deleteRoute }: RoutesModalProps) {
  const { toast } = useToast();
  const [editing, setEditing] = useState<SignalRoute | null>(null);
  const [showForm, setShowForm] = useState(false);

  // form state
  const [label, setLabel] = useState("");
  const [destination, setDestination] = useState<RouteDestination>("agenda");
  const [keyword, setKeyword] = useState("");
  const [matchType, setMatchType] = useState<"" | SignalType>("");
  const [source, setSource] = useState("");
  const [priority, setPriority] = useState<RoutePriority>("keep");
  const [autoRoute, setAutoRoute] = useState(false);

  const resetForm = () => {
    setEditing(null);
    setShowForm(false);
    setLabel("");
    setDestination("agenda");
    setKeyword("");
    setMatchType("");
    setSource("");
    setPriority("keep");
    setAutoRoute(false);
  };

  const startEdit = (r: SignalRoute) => {
    setEditing(r);
    setShowForm(true);
    setLabel(r.label);
    setDestination(r.destination);
    setKeyword(r.match_keyword ?? "");
    setMatchType(r.match_type ?? "");
    setSource(r.match_source ?? "");
    setPriority(r.set_priority);
    setAutoRoute(r.auto_route);
  };

  const save = async () => {
    if (!label.trim()) {
      toast("Name your route", "warn", "Routes");
      return;
    }
    if (!keyword.trim() && !matchType && !source.trim()) {
      toast("Add at least one matcher (keyword, type, or source)", "warn", "Routes");
      return;
    }
    const input = {
      label: label.trim(),
      destination,
      match_keyword: keyword.trim() || null,
      match_type: (matchType || null) as SignalType | null,
      match_source: source.trim() || null,
      set_priority: priority,
      auto_route: autoRoute,
    };
    if (editing) {
      await updateRoute(editing.id, input);
      toast("Route updated", "success", "Routes");
    } else {
      const r = await addRoute(input);
      toast(r ? "Route created" : "Could not create route", r ? "success" : "error", "Routes");
    }
    resetForm();
  };

  const summarise = (r: SignalRoute) => {
    const parts: string[] = [];
    if (r.match_keyword) parts.push(`keyword "${r.match_keyword}"`);
    if (r.match_type) parts.push(`type ${r.match_type}`);
    if (r.match_source) parts.push(`source ${r.match_source}`);
    const matchers = parts.length ? parts.join(" + ") : "no matcher";
    return `${matchers} → ${destLabel(r.destination)}${r.set_priority !== "keep" ? ` @ ${r.set_priority}` : ""}${r.auto_route ? " · auto" : ""}`;
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        resetForm();
        onClose();
      }}
      title="Routing Rules"
      footer={
        <>
          {!showForm && (
            <Button variant="primary" onClick={() => setShowForm(true)}>
              New route
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => {
              resetForm();
              onClose();
            }}
          >
            Close
          </Button>
        </>
      }
    >
      <p style={{ color: "var(--ink-dim)", fontSize: 12.5, marginBottom: 12, lineHeight: 1.55 }}>
        Match a signal by keyword, type, or source and send it to a destination at a chosen priority. Enable{" "}
        <em>auto-route</em> to apply during AI triage all.
      </p>

      {showForm && (
        <div style={{ borderBottom: "1px solid var(--line)", paddingBottom: 14, marginBottom: 14 }}>
          <div className={styles.formGrid}>
            <div className={`${styles.field} ${styles.full}`}>
              <span className={styles.fieldLabel}>Route name</span>
              <input className={styles.input} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. GitHub PRs → Pipeline" />
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Match keyword</span>
              <input className={styles.input} value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="optional" />
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Match source</span>
              <input className={styles.input} value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. GitHub" />
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Match type</span>
              <select className={styles.select} value={matchType} onChange={(e) => setMatchType(e.target.value as "" | SignalType)}>
                {TYPE_OPTS.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Destination</span>
              <select className={styles.select} value={destination} onChange={(e) => setDestination(e.target.value as RouteDestination)}>
                {DESTINATIONS.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Set priority</span>
              <select className={styles.select} value={priority} onChange={(e) => setPriority(e.target.value as RoutePriority)}>
                {PRIORITIES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <label className={`${styles.toggleRow} ${styles.full}`}>
              <input type="checkbox" checked={autoRoute} onChange={(e) => setAutoRoute(e.target.checked)} />
              Auto-route matching signals during “AI triage all”
            </label>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="savebtn" onClick={save}>
              {editing ? "Save changes" : "Add route"}
            </button>
            <button type="button" className="savebtn" onClick={resetForm}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {routes.length === 0 && !showForm ? (
        <p className={styles.emptyMini}>No routing rules yet. Create one to auto-classify and route signals.</p>
      ) : (
        routes.map((r) => (
          <div key={r.id} className={styles.routeRow}>
            <div>
              <div className={styles.routeName}>
                {r.label} {!r.enabled && <span style={{ color: "var(--ink-faint)", fontWeight: 400 }}>· off</span>}
              </div>
              <div className={styles.routeMeta}>{summarise(r)}</div>
            </div>
            <div className={styles.routeActions}>
              <button type="button" className={styles.iconBtn} onClick={() => updateRoute(r.id, { enabled: !r.enabled })}>
                {r.enabled ? "Disable" : "Enable"}
              </button>
              <button type="button" className={styles.iconBtn} onClick={() => startEdit(r)}>
                Edit
              </button>
              <button
                type="button"
                className={`${styles.iconBtn} ${styles.danger}`}
                onClick={() => {
                  deleteRoute(r.id);
                  toast("Route deleted", "success", "Routes");
                }}
              >
                Delete
              </button>
            </div>
          </div>
        ))
      )}
    </Modal>
  );
}
