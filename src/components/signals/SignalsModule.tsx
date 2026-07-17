"use client";

import { useCallback, useMemo, useState } from "react";
import * as Sentry from "@sentry/nextjs";
import { SkeletonCard } from "@/components/ui/Skeleton";
import {
  classifySignal,
  classifySignals,
  isSignalArchived,
  isSignalSnoozed,
  isSignalVisible,
  signalArchivedAt,
  signalDismissedAt,
  signalSnoozedUntil,
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
import { todayLocalIso } from "@/lib/calendar/event-dates";
import { useNotes } from "@/lib/hooks/useNotes";
import { normalizeName, triageSignalToPerson, usePeople } from "@/lib/hooks/usePeople";
import { deriveSeverity, normalizeSignalKey, type SignalSeverity } from "@/lib/signals/severity";
import { Modal } from "@/components/ui/Modal";
import { StatusCallout } from "@/components/ui/StatusCallout";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import styles from "./SignalsModule.module.css";

const CHIPS = ["All", "Critical", "Actionable", "Information", "Noise", "Routed", "Unread", "Snoozed", "Archived"] as const;
type Chip = (typeof CHIPS)[number];

const GROUPS: { key: SignalSeverity | "routed"; label: string }[] = [
  { key: "critical", label: "Critical" },
  { key: "actionable", label: "Actionable" },
  { key: "informational", label: "Information" },
  { key: "noise", label: "Noise" },
  { key: "routed", label: "Routed" },
];

const destLabel = (id: string) => DESTINATIONS.find((d) => d.id === id)?.label ?? id;

// tasks.category has a CHECK constraint — the AI route may emit "admin"; map it to a valid value.
const VALID_CATEGORIES: TaskCategory[] = ["research", "clinical", "life", "personal"];
const safeCategory = (c: string): TaskCategory => (VALID_CATEGORIES as string[]).includes(c) ? (c as TaskCategory) : "research";

// The AI classifier emits a free-form destination string; clamp it to a real
// routable destination so "AI triage all" can route every signal (anything it
// doesn't recognise falls back to Agenda, the safe catch-all for action items).
const VALID_DESTINATIONS: RouteDestination[] = DESTINATIONS.map((d) => d.id);
const safeDestination = (d: string): RouteDestination =>
  (VALID_DESTINATIONS as string[]).includes(d) ? (d as RouteDestination) : "agenda";

type RouteVia = "ai" | "manual" | "rule";
type RouteArtifacts = {
  taskId?: string;
  taskTitle?: string;
  noteId?: string;
  noteTitle?: string;
  personId?: string;
  personName?: string;
};

function asError(error: unknown, fallback: string) {
  return error instanceof Error ? error : new Error(fallback);
}

function artifactMetadata(artifacts: RouteArtifacts): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (artifacts.taskId) metadata.routed_task_id = artifacts.taskId;
  if (artifacts.taskTitle) metadata.routed_task_title = artifacts.taskTitle;
  if (artifacts.noteId) metadata.routed_note_id = artifacts.noteId;
  if (artifacts.noteTitle) metadata.routed_note_title = artifacts.noteTitle;
  if (artifacts.personId) metadata.routed_person_id = artifacts.personId;
  if (artifacts.personName) metadata.routed_person_name = artifacts.personName;
  return metadata;
}

function linkedTaskTitle(signal: Signal) {
  return typeof signal.metadata?.routed_task_title === "string"
    ? signal.metadata.routed_task_title
    : null;
}

function linkedNoteTitle(signal: Signal) {
  return typeof signal.metadata?.routed_note_title === "string"
    ? signal.metadata.routed_note_title
    : null;
}

function snoozeUntil(hours: number) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function metadataWithout(signal: Signal, keys: string[]) {
  const next = { ...(signal.metadata ?? {}) };
  for (const key of keys) delete next[key];
  return next;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function signalNoteBody(signal: Signal) {
  const body = signal.body?.trim() || "No additional detail.";
  return [
    `<p>${escapeHtml(body).replace(/\n/g, "<br />")}</p>`,
    `<hr />`,
    `<p><strong>Source:</strong> ${escapeHtml(signal.source)}</p>`,
    `<p><strong>Signal:</strong> ${escapeHtml(signal.title)}</p>`,
  ].join("");
}

type SourceLink = {
  label: string;
  href: string;
  external: boolean;
  detail?: string;
};

function safeMetadataHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.startsWith("/")) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return url.toString();
  } catch {
    return null;
  }
  return null;
}

function sourceLinkFor(signal: Signal): SourceLink | null {
  const metadataHref = safeMetadataHref(signal.metadata?.source_route) ?? safeMetadataHref(signal.metadata?.source_url);
  const external = Boolean(metadataHref && !metadataHref.startsWith("/"));
  const type = typeof signal.metadata?.source_object_type === "string" ? signal.metadata.source_object_type : signal.source;
  const id = typeof signal.metadata?.source_object_id === "string" ? signal.metadata.source_object_id : null;
  if (metadataHref) {
    return {
      label: `Open ${type}`,
      href: metadataHref,
      external,
      detail: id ? `${type} · ${id}` : type,
    };
  }

  const source = signal.source.toLowerCase();
  if (source.includes("mail")) return { label: "Open Mail", href: "/mail", external: false, detail: "Mail source" };
  if (source.includes("calendar")) return { label: "Open Schedule", href: "/schedule", external: false, detail: "Calendar source" };
  if (source.includes("task") || source.includes("agenda")) return { label: "Open Agenda", href: "/agenda", external: false, detail: "Task source" };
  if (source.includes("note")) return { label: "Open Notes", href: "/notes", external: false, detail: "Note source" };
  if (source.includes("github") || source.includes("pipeline")) return { label: "Open Pipeline", href: "/pipeline", external: false, detail: "Pipeline source" };
  if (source.includes("fund") || source.includes("polygon") || source.includes("market")) return { label: "Open Fund", href: "/fund", external: false, detail: "Fund source" };
  return null;
}

function routeFailureMessage(destination: RouteDestination) {
  if (destination === "agenda") return "Could not complete task conversion. Signal was not routed.";
  if (destination === "notes") return "Could not complete note conversion. Signal was not routed.";
  return `Could not route to ${destLabel(destination)}. Signal was not routed.`;
}

function captureDispatchFailure(
  error: unknown,
  context: {
    op: "route_signal" | "triage_signal" | "manage_signal" | "scan_platform" | "capture_signal" | "delete_signal";
    signal?: Pick<Signal, "id" | "signal_type" | "source">;
    phase: "detail" | "batch" | "toolbar";
    destination?: RouteDestination;
    via?: RouteVia;
    action?: "dismiss" | "archive" | "snooze" | "restore";
  },
) {
  Sentry.captureException(asError(error, "Dispatch action failed"), {
    tags: {
      area: "dispatch",
      op: context.op,
      phase: context.phase,
      destination: context.destination ?? "none",
      via: context.via ?? "none",
      action: context.action ?? "none",
      signal_type: context.signal?.signal_type ?? "none",
      source: context.signal?.source.slice(0, 40) ?? "none",
    },
    extra: context.signal ? { signal_id: context.signal.id } : undefined,
  });
}

function pillClass(type: SignalType) {
  if (type === "action") return "hi";
  if (type === "awaiting") return "med";
  return "lo";
}

function severityPillClass(severity: SignalSeverity) {
  if (severity === "critical") return "hi";
  if (severity === "actionable") return "med";
  if (severity === "informational") return "lo";
  return styles.noisePill;
}

function applyChip(signals: Signal[], chip: Chip, severityFor: (signal: Signal) => SignalSeverity) {
  switch (chip) {
    case "All":
      return signals.filter((s) => isSignalVisible(s));
    case "Routed":
      return signals.filter((s) => s.routed_at && isSignalVisible(s));
    case "Unread":
      return signals.filter((s) => !s.read_at && isSignalVisible(s));
    case "Critical":
      return signals.filter((s) => !s.routed_at && isSignalVisible(s) && severityFor(s) === "critical");
    case "Actionable":
      return signals.filter((s) => !s.routed_at && isSignalVisible(s) && severityFor(s) === "actionable");
    case "Information":
      return signals.filter((s) => !s.routed_at && isSignalVisible(s) && severityFor(s) === "informational");
    case "Noise":
      return signals.filter((s) => !s.routed_at && isSignalVisible(s) && severityFor(s) === "noise");
    case "Snoozed":
      return signals.filter((s) => !isSignalArchived(s) && isSignalSnoozed(s));
    case "Archived":
      return signals.filter((s) => isSignalArchived(s));
    default:
      return signals;
  }
}

export function SignalsModule() {
  const { signals, loading, loadError, capture, markRead, routeTo, updateSignal, deleteSignal, applyClassification, refresh: refreshSignals } = useSignals();
  const { routes, loadError: routesLoadError, addRoute, updateRoute, deleteRoute } = useSignalRoutes();
  const { addTask } = useTasks();
  const { createNote, updateNote } = useNotes();
  const { people, addPerson, updatePerson } = usePeople();
  const { toast } = useToast();

  const [activeChip, setActiveChip] = useState<Chip>("All");
  const [selected, setSelected] = useState<Signal | null>(null);
  const [suggestion, setSuggestion] = useState<SignalClassification | null>(null);
  const [thinking, setThinking] = useState(false);
  const [batching, setBatching] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [draft, setDraft] = useState("");
  const [routesOpen, setRoutesOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [routingDestination, setRoutingDestination] = useState<RouteDestination | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);

  const resolvedTitleOwners = useMemo(() => {
    const owners = new Map<string, Set<string>>();
    for (const signal of signals) {
      if (!signal.routed_at && !signalDismissedAt(signal) && !isSignalArchived(signal)) continue;
      const key = normalizeSignalKey(signal.title);
      if (!key) continue;
      const ids = owners.get(key) ?? new Set<string>();
      ids.add(signal.id);
      owners.set(key, ids);
    }
    return owners;
  }, [signals]);
  const severityFor = useCallback((signal: Signal) => {
    const resolvedOwners = resolvedTitleOwners.get(normalizeSignalKey(signal.title));
    return deriveSeverity({
      signalType: signal.signal_type,
      priority: typeof signal.metadata?.ai_priority === "string" ? signal.metadata.ai_priority : null,
      isRedundant: Boolean(resolvedOwners && (resolvedOwners.size > 1 || !resolvedOwners.has(signal.id))),
    });
  }, [resolvedTitleOwners]);
  const filtered = useMemo(
    () => applyChip(signals, activeChip, severityFor),
    [signals, activeChip, severityFor],
  );

  // The default queue is ordered by deterministic attention tier, with completed routing separate.
  const grouped = useMemo(() => {
    const grouping = activeChip === "All";
    if (!grouping) return null;
    const buckets: Record<string, Signal[]> = {
      critical: [], actionable: [], informational: [], noise: [], routed: [],
    };
    for (const s of filtered) {
      if (s.routed_at || isSignalArchived(s) || isSignalSnoozed(s)) buckets.routed.push(s);
      else buckets[severityFor(s)].push(s);
    }
    return buckets;
  }, [filtered, activeChip, severityFor]);

  // Live count of the always-selected signal (keeps detail panel in sync after edits).
  const live = selected ? signals.find((s) => s.id === selected.id) ?? selected : null;
  const sourceLink = live ? sourceLinkFor(live) : null;

  const openDetail = (s: Signal) => {
    setSelected(s);
    setRouteError(null);
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
    setRouteError(null);
  };

  const dismissSignal = async (s: Signal) => {
    const at = new Date().toISOString();
    const updated = await updateSignal(s.id, {
      read_at: s.read_at ?? at,
      metadata: { ...(s.metadata ?? {}), dismissed_at: at, archived_at: at },
    });
    if (!updated) {
      captureDispatchFailure(new Error("Signal dismiss update failed"), { op: "manage_signal", signal: s, phase: "detail", action: "dismiss" });
      toast("Could not dismiss signal.", "error", "Dispatch");
      return;
    }
    toast("Signal dismissed.", "success", "Dispatch");
    closeDetail();
  };

  const archiveSignal = async (s: Signal) => {
    const at = new Date().toISOString();
    const updated = await updateSignal(s.id, {
      read_at: s.read_at ?? at,
      metadata: { ...(s.metadata ?? {}), archived_at: at },
    });
    if (!updated) {
      captureDispatchFailure(new Error("Signal archive update failed"), { op: "manage_signal", signal: s, phase: "detail", action: "archive" });
      toast("Could not archive signal.", "error", "Dispatch");
      return;
    }
    toast("Signal archived.", "success", "Dispatch");
    closeDetail();
  };

  const snoozeSignal = async (s: Signal, hours: number) => {
    const until = snoozeUntil(hours);
    const updated = await updateSignal(s.id, {
      read_at: s.read_at ?? new Date().toISOString(),
      metadata: {
        ...metadataWithout(s, ["archived_at", "dismissed_at"]),
        snoozed_until: until,
      },
    });
    if (!updated) {
      captureDispatchFailure(new Error("Signal snooze update failed"), { op: "manage_signal", signal: s, phase: "detail", action: "snooze" });
      toast("Could not snooze signal.", "error", "Dispatch");
      return;
    }
    toast(`Signal snoozed until ${new Date(until).toLocaleString()}.`, "success", "Dispatch");
    closeDetail();
  };

  const restoreSignal = async (s: Signal) => {
    const updated = await updateSignal(s.id, {
      metadata: metadataWithout(s, ["archived_at", "dismissed_at", "snoozed_until"]),
    });
    if (!updated) {
      captureDispatchFailure(new Error("Signal restore update failed"), { op: "manage_signal", signal: s, phase: "detail", action: "restore" });
      toast("Could not restore signal.", "error", "Dispatch");
      return;
    }
    toast("Signal restored.", "success", "Dispatch");
  };

  // AI triage a single signal: classify, store on signal, surface suggestion + matching user route.
  const triageOne = async (s: Signal) => {
    setThinking(true);
    setRouteError(null);
    toast("Triaging with AI…", "info", "AI Triage");
    try {
      const c = await classifySignal(s);
      const updated = await applyClassification(s.id, c);
      if (!updated) throw new Error("Signal classification update failed");
      setSuggestion(c);
      const rule = findMatchingRoute(routes, { ...s, signal_type: c.signal_type });
      toast(
        rule
          ? `Matches your route “${rule.label}” → ${destLabel(rule.destination)}`
          : `Suggested → ${destLabel(safeDestination(c.destination))} · ${c.priority}`,
        "success",
        "AI Triage",
      );
    } catch (error) {
      captureDispatchFailure(error, { op: "triage_signal", signal: s, phase: "detail" });
      toast("AI triage failed. Nothing was changed.", "error", "AI Triage");
    } finally {
      setThinking(false);
    }
  };

  const materializeDestination = async (s: Signal, destination: RouteDestination, priority: RoutePriority | "hi" | "med" | "lo"): Promise<RouteArtifacts> => {
    if (destination === "agenda") {
      const triaged = await triageSignalToTask(s);
      const pri: TaskPriority = priority === "keep" ? triaged.priority : (priority as TaskPriority);
      const task = await addTask({
        title: triaged.title,
        category: safeCategory(triaged.category),
        priority: pri,
        effort: triaged.effort,
        metadata: {
          created_via: "dispatch_signal",
          source_signal_id: s.id,
          source_signal_type: s.signal_type,
          source_signal_source: s.source,
        },
      });
      if (!task) throw new Error("Task creation failed");
      return { taskId: task.id, taskTitle: task.title };
    } else if (destination === "notes") {
      const note = await createNote(s.title, "All Notes");
      if (!note) throw new Error("Note creation failed");
      await updateNote(note.id, {
        body: signalNoteBody(s),
        tags: ["dispatch", `signal:${s.id}`],
      });
      return { noteId: note.id, noteTitle: note.title };
    } else if (destination === "people") {
      const triaged = await triageSignalToPerson(s);
      const target = normalizeName(triaged.name);
      const matched = people.find((p) => normalizeName(p.name) === target);
      const result = matched
        ? await updatePerson(matched.id, { last_contact_on: todayLocalIso() })
        : await addPerson({ name: triaged.name, role: triaged.role, note: triaged.note, tag: triaged.tag });
      if ("error" in result && result.error) throw new Error(result.error);
      return { personId: result.data?.id, personName: result.data?.name ?? triaged.name };
    }
    return {};
  };

  // Commit a route: materialise the side-effect first, then stamp the signal.
  const commitRoute = async (s: Signal, destination: string, priority: RoutePriority | "hi" | "med" | "lo", via: RouteVia) => {
    const target = safeDestination(destination);
    if (s.routed_at) {
      toast("Signal is already routed.", "info", "Dispatch");
      return;
    }
    setRoutingDestination(target);
    setRouteError(null);
    try {
      const artifacts = await materializeDestination(s, target, priority);
      const routed = await routeTo(s.id, target, via, artifactMetadata(artifacts));
      if (!routed) throw new Error("Signal route update failed");
      toast(
        target === "agenda"
          ? "Task created and signal routed."
          : target === "notes"
            ? "Note created and signal routed."
            : `Routed → ${destLabel(target)}`,
        "success",
        "Signals",
      );
      closeDetail();
    } catch (error) {
      const message = routeFailureMessage(target);
      setRouteError(message);
      captureDispatchFailure(error, { op: "route_signal", signal: s, phase: "detail", destination: target, via });
      toast(message, "error", "Dispatch");
    } finally {
      setRoutingDestination(null);
    }
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

  // AI triage ALL un-routed signals in one batch — classify each, then actually
  // route it: to a matching user rule's destination when one exists, otherwise
  // to the AI's own suggested destination. Nothing is left merely "classified
  // but unrouted" — triage means route, so the inbox clears in one pass.
  const triageAll = async () => {
    const pending = signals.filter((s) => !s.routed_at && isSignalVisible(s));
    if (pending.length === 0) {
      toast("Nothing to triage — all signals routed", "info", "AI Triage");
      return;
    }
    setBatching(true);
    toast(`Triaging ${pending.length} signals…`, "info", "AI Triage");
    try {
      const results = await classifySignals(pending);
      let routed = 0;
      let viaRules = 0;
      let failed = 0;
      for (const c of results) {
        const s = pending.find((x) => x.id === c.id);
        if (!s) continue;
        let target = safeDestination(c.destination);
        let via: "ai" | "rule" = "ai";
        try {
          const updated = await applyClassification(s.id, c);
          if (!updated) throw new Error("Signal classification update failed");
          const rule = findMatchingRoute(routes, { ...s, signal_type: c.signal_type });
          if (rule) {
            target = rule.destination;
            via = "rule";
            await commitRouteSilent(s, target, rule.set_priority, via);
            viaRules += 1;
          } else {
            // No user rule — route to the AI's suggested destination so it doesn't
            // linger as unrouted.
            await commitRouteSilent(s, target, c.priority, via);
          }
          routed += 1;
        } catch (error) {
          failed += 1;
          captureDispatchFailure(error, { op: "route_signal", signal: s, phase: "batch", destination: target, via });
        }
      }
      if (failed > 0) {
        toast(
          `Routed ${routed} signal${routed === 1 ? "" : "s"} · ${failed} failed`,
          routed > 0 ? "warn" : "error",
          "AI Triage",
        );
        return;
      }
      toast(
        viaRules > 0
          ? `Routed ${routed} signal${routed === 1 ? "" : "s"} · ${viaRules} via your rules`
          : `Routed ${routed} signal${routed === 1 ? "" : "s"} to their suggested destinations`,
        "success",
        "AI Triage",
      );
    } catch (error) {
      Sentry.captureException(asError(error, "Dispatch batch triage failed"), {
        tags: { area: "dispatch", op: "triage_all" },
      });
      toast("AI triage failed. No signals were routed.", "error", "AI Triage");
    } finally {
      setBatching(false);
    }
  };

  // Like commitRoute but without toast/close — used inside batch loops. `via`
  // is "rule" for user-rule matches, "ai" for AI-suggested fallbacks.
  const commitRouteSilent = async (s: Signal, destination: RouteDestination, priority: RoutePriority | "hi" | "med" | "lo", via: "ai" | "rule") => {
    const artifacts = await materializeDestination(s, destination, priority);
    const routed = await routeTo(s.id, destination, via, artifactMetadata(artifacts));
    if (!routed) throw new Error("Signal route update failed");
  };

  // Scan platform modules for new signals via AI — server does the read+AI+insert, we just refresh.
  const scanPlatform = useCallback(async () => {
    setScanning(true);
    toast("Scanning platform…", "info", "Dispatch");
    try {
      const res = await fetch("/api/signals/scan", { method: "POST" });
      const data = await res.json() as { created?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Scan failed");
      const captured = data.created ?? 0;
      if (captured > 0) await refreshSignals();
      toast(captured > 0 ? `${captured} new signal${captured === 1 ? "" : "s"} surfaced` : "Platform looks clear", "success", "Dispatch");
    } catch (error) {
      captureDispatchFailure(error, { op: "scan_platform", phase: "toolbar" });
      toast("Scan failed — check connection", "error", "Dispatch");
    } finally {
      setScanning(false);
    }
  }, [refreshSignals, toast]);

  const handleCapture = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    const created = await capture(text, "action", "capture");
    if (created) {
      toast("Signal captured", "success", "Signals");
      return;
    }
    // Never silently drop typed input — restore the draft so nothing is lost.
    setDraft(text);
    captureDispatchFailure(new Error("Signal capture insert failed"), { op: "capture_signal", phase: "toolbar" });
    toast("Could not capture signal. Your text was restored.", "error", "Dispatch");
  };

  if (loading) return (
    <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: 8 }}>
      {Array.from({ length: 5 }).map((_, i) => <SkeletonCard key={i} rows={2} />)}
    </div>
  );

  const renderRow = (s: Signal) => (
    <div key={s.id} className={s.routed_at || isSignalArchived(s) || isSignalSnoozed(s) ? "task routed" : s.read_at ? "task done" : "task"} onClick={() => editingId !== s.id && openDetail(s)} style={{ cursor: "pointer" }}>
      <div
        className={s.read_at ? "check done" : "check"}
        onClick={(e) => {
          e.stopPropagation();
          void markRead(s.id).then((updated) => {
            if (!updated) toast("Could not mark signal read.", "error", "Dispatch");
          });
        }}
      />
      <div className="task-main">
        {editingId === s.id ? (
          <input
            autoFocus
            value={editTitle}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setEditTitle(e.target.value)}
            onBlur={() => {
              if (editTitle.trim() && editTitle !== s.title) {
                void updateSignal(s.id, { title: editTitle.trim() }).then((updated) => {
                  if (!updated) toast("Could not rename signal.", "error", "Dispatch");
                });
              }
              setEditingId(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.currentTarget.blur(); }
              if (e.key === "Escape") { setEditingId(null); }
            }}
            style={{ width: "100%", background: "transparent", border: "none", borderBottom: "1px solid var(--line)", color: "var(--ink)", fontSize: 13, fontFamily: "inherit", padding: "0 0 2px", outline: "none" }}
          />
        ) : (
          <div
            className="task-title"
            onDoubleClick={(e) => { e.stopPropagation(); setEditingId(s.id); setEditTitle(s.title); }}
          >
            {s.title}
          </div>
        )}
        <div className="task-meta" style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
          <span className={`pill ${severityPillClass(severityFor(s))}`}>{severityFor(s).toUpperCase()}</span>
          <span>
            {s.source} · {isSignalArchived(s) ? "archived" : isSignalSnoozed(s) ? `snoozed until ${new Date(signalSnoozedUntil(s) ?? "").toLocaleString()}` : s.route_target ? `routed → ${destLabel(s.route_target)}` : "unrouted"}
          </span>
          {!s.routed_at && s.metadata?.ai_destination && (
            <span className={styles.aiBadge}>AI → {destLabel(s.metadata.ai_destination)}</span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (!window.confirm("Delete this signal permanently?")) return;
          void deleteSignal(s.id).then((deleted) => {
            if (deleted) {
              toast("Signal deleted.", "success", "Dispatch");
            } else {
              captureDispatchFailure(new Error("Signal delete failed"), { op: "delete_signal", signal: s, phase: "detail" });
              toast("Could not delete signal.", "error", "Dispatch");
            }
          });
        }}
        title="Delete signal"
        style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--ink-faint)", cursor: "pointer", fontSize: 14, padding: "0 4px", flexShrink: 0 }}
      >
        ×
      </button>
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
          <button key={chip} type="button" className={chip === activeChip ? "chip on" : "chip"} aria-pressed={chip === activeChip} onClick={() => setActiveChip(chip)}>
            {chip}
          </button>
        ))}
      </div>

      {loadError && (
        <div style={{ margin: "0 0 12px" }}>
          <StatusCallout
            kind="error"
            title="Signals could not be loaded"
            actionSlot={
              <button type="button" className="savebtn" onClick={() => { void refreshSignals(); }}>
                Retry
              </button>
            }
          >
            {loadError} {signals.length > 0 ? "Showing the last loaded signals." : ""}
          </StatusCallout>
        </div>
      )}

      <div className="card">
        {filtered.length === 0 ? (
          <p className={styles.emptyMini}>
            {signals.length === 0
              ? "No signals yet. Capture one above or scan your connected workspaces when you want a review pass."
              : "No signals match this filter."}
          </p>
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
              {live.source} · {severityFor(live)} · {live.signal_type} · {new Date(live.created_at).toLocaleString()}
              {live.routed_at && ` · routed → ${destLabel(live.route_target ?? "")}`}
              {signalArchivedAt(live) && ` · archived ${new Date(signalArchivedAt(live) ?? "").toLocaleString()}`}
              {signalDismissedAt(live) && ` · dismissed`}
              {signalSnoozedUntil(live) && ` · snoozed until ${new Date(signalSnoozedUntil(live) ?? "").toLocaleString()}`}
            </div>

            {sourceLink && (
              <div className={styles.linkedArtifact}>
                <div>
                  <span>Source object</span>
                  <strong>{sourceLink.detail ?? live.source}</strong>
                </div>
                <a
                  className="savebtn"
                  href={sourceLink.href}
                  target={sourceLink.external ? "_blank" : undefined}
                  rel={sourceLink.external ? "noreferrer" : undefined}
                >
                  {sourceLink.label}
                </a>
              </div>
            )}

            {live.routed_at && (
              <div className={styles.routeStatus}>
                <span>{live.route_target ? `Routed to ${destLabel(live.route_target)}` : "Routed"}</span>
                {typeof live.metadata?.routed_task_id === "string" && <span>Task linked</span>}
              </div>
            )}

            {live.routed_at && typeof live.metadata?.routed_task_id === "string" && (
              <div className={styles.linkedArtifact}>
                <div>
                  <span>Created task</span>
                  <strong>{linkedTaskTitle(live) ?? live.title}</strong>
                </div>
                <a className="savebtn" href="/agenda">
                  Open Agenda
                </a>
              </div>
            )}

            {live.routed_at && typeof live.metadata?.routed_note_id === "string" && (
              <div className={styles.linkedArtifact}>
                <div>
                  <span>Created note</span>
                  <strong>{linkedNoteTitle(live) ?? live.title}</strong>
                </div>
                <a className="savebtn" href="/notes">
                  Open Notes
                </a>
              </div>
            )}

            <div className={styles.detailAction}>
              <Button
                variant="primary"
                loading={routingDestination === "agenda"}
                disabled={!!live.routed_at || !!routingDestination}
                onClick={() => commitRoute(live, "agenda", "keep", "manual")}
              >
                {live.routed_at ? "Routed" : "Convert to task"}
              </Button>
            </div>

            {routeError && (
              <div className={styles.routeError} role="alert">
                {routeError}
              </div>
            )}

            <div className={styles.manageActions}>
              <button type="button" className="savebtn" disabled={!!routingDestination} onClick={() => snoozeSignal(live, 4)}>
                Snooze 4h
              </button>
              <button type="button" className="savebtn" disabled={!!routingDestination} onClick={() => snoozeSignal(live, 24)}>
                Snooze 1d
              </button>
              <button type="button" className="savebtn" disabled={!!routingDestination} onClick={() => archiveSignal(live)}>
                Archive
              </button>
              <button type="button" className="savebtn" disabled={!!routingDestination} onClick={() => dismissSignal(live)}>
                Dismiss
              </button>
              {(isSignalArchived(live) || isSignalSnoozed(live)) && (
                <button type="button" className="aibtn" disabled={!!routingDestination} onClick={() => restoreSignal(live)}>
                  Restore
                </button>
              )}
            </div>

            {suggestion && (
              <div className={styles.suggest}>
                <div className={styles.suggestHead}>
                  AI suggestion
                  <span className={`pill ${pillClass(suggestion.signal_type)}`}>{suggestion.signal_type.toUpperCase()}</span>
                </div>
                <div className={styles.suggestBody}>
                  Route to <strong style={{ color: "var(--ink)" }}>{destLabel(safeDestination(suggestion.destination))}</strong> at{" "}
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
                  disabled={!!live.routed_at || !!routingDestination}
                  onClick={() => commitRoute(live, safeDestination(suggestion.destination), suggestion.priority, "ai")}
                >
                  Route → {destLabel(safeDestination(suggestion.destination))}
                </button>
              </div>
            )}

            <div className="seclabel" style={{ marginTop: 14 }}>
              Route to
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
              {DESTINATIONS.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className="capt-pill"
                  disabled={!!live.routed_at || !!routingDestination}
                  onClick={() => commitRoute(live, r.id, "keep", "manual")}
                >
                  {r.label}
                </button>
              ))}
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="aibtn" onClick={() => triageOne(live)} disabled={thinking || !!routingDestination}>
                {thinking ? "Thinking…" : suggestion ? "Re-run AI triage" : "AI triage"}
              </button>
              {findMatchingRoute(routes, live) && (
                <button type="button" className="savebtn" disabled={!!live.routed_at || !!routingDestination} onClick={() => applyMatchingRoute(live)}>
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
        loadError={routesLoadError}
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
  loadError: string | null;
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

function RoutesModal({ open, onClose, routes, loadError, addRoute, updateRoute, deleteRoute }: RoutesModalProps) {
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
      const updated = await updateRoute(editing.id, input);
      toast(updated ? "Route updated" : "Could not update route", updated ? "success" : "error", "Routes");
      if (!updated) return; // keep the form open so edits aren't lost
    } else {
      const r = await addRoute(input);
      toast(r ? "Route created" : "Could not create route", r ? "success" : "error", "Routes");
      if (!r) return;
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

      {loadError && (
        <StatusCallout kind="error" title="Routing rules unavailable">
          {loadError} Rule-based routing is paused until they load — AI triage will use its own suggestions.
        </StatusCallout>
      )}

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
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => {
                  void updateRoute(r.id, { enabled: !r.enabled }).then((updated) => {
                    if (!updated) toast("Could not update route", "error", "Routes");
                  });
                }}
              >
                {r.enabled ? "Disable" : "Enable"}
              </button>
              <button type="button" className={styles.iconBtn} onClick={() => startEdit(r)}>
                Edit
              </button>
              <button
                type="button"
                className={`${styles.iconBtn} ${styles.danger}`}
                onClick={() => {
                  if (!window.confirm(`Delete the route “${r.label}”?`)) return;
                  void deleteRoute(r.id).then((deleted) => {
                    toast(deleted ? "Route deleted" : "Could not delete route", deleted ? "success" : "error", "Routes");
                  });
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
