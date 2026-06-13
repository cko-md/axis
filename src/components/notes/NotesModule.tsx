"use client";

import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useNotes, isLocked, visibleTags, type Note } from "@/lib/hooks/useNotes";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { NotesEditor } from "./NotesEditor";
import styles from "./NotesEditor.module.css";

const DEFAULT_FOLDERS = ["All Notes", "Research", "Manuscripts", "Grants", "Clinical", "Personal"];
const FOLDER_ORDER_KEY = "axis-notes-folder-order";

function SortableFolder({
  folder,
  active,
  count,
  onPick,
}: {
  folder: string;
  active: string;
  count: number;
  onPick: (f: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: folder });
  return (
    <div
      ref={setNodeRef}
      suppressHydrationWarning
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      {...attributes}
    >
      <div
        className={folder === active ? "coll on" : "coll"}
        style={{ display: "flex", alignItems: "center", gap: 8 }}
        onClick={() => onPick(folder)}
      >
        <span
          {...listeners}
          className="block-drag-handle"
          style={{ cursor: "grab", fontSize: 12, color: "var(--ink-faint)", flexShrink: 0 }}
          onClick={(e) => e.stopPropagation()}
        >
          ⠿
        </span>
        {FOLDER_ICON}
        {folder}
        <span className="cc">{count}</span>
      </div>
    </div>
  );
}

const FOLDER_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M3 7l2-3h6l2 3h6v13H3z" />
  </svg>
);

const LOCK_ICON = (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="11" width="14" height="9" rx="1.5" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);
const UNLOCK_ICON = (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="11" width="14" height="9" rx="1.5" />
    <path d="M8 11V8a4 4 0 0 1 7.5-2" />
  </svg>
);

type RouteSuggestion = {
  destination: "research" | "literature" | "task";
  label: string;
  reason: string;
  tags: string[];
};

// HTML → short plain-text preview for the list.
function preview(html: string): string {
  if (!html) return "Empty note";
  const text = html
    .replace(/<\/(p|div|h[1-6]|li|blockquote|pre|tr)>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || "Empty note";
}

export function NotesModule() {
  const { notes, loading, createNote, updateNote, updateNoteDebounced, deleteNote, toggleLock } = useNotes();
  const { toast } = useToast();

  const [folders, setFolders] = useState<string[]>(DEFAULT_FOLDERS);
  const [activeFolder, setActiveFolder] = useState("All Notes");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => {
    try {
      const stored = localStorage.getItem(FOLDER_ORDER_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as string[];
        if (DEFAULT_FOLDERS.every((f) => parsed.includes(f)) && parsed.length === DEFAULT_FOLDERS.length) {
          setFolders(parsed);
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  function handleFolderDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = folders.indexOf(active.id as string);
    const to = folders.indexOf(over.id as string);
    const next = arrayMove(folders, from, to);
    setFolders(next);
    localStorage.setItem(FOLDER_ORDER_KEY, JSON.stringify(next));
  }
  const [draft, setDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);

  const [routing, setRouting] = useState(false);
  const [suggestion, setSuggestion] = useState<RouteSuggestion | null>(null);

  // Always read the live note from the hook's array so edits/locks stay in sync.
  const selected = useMemo(() => notes.find((n) => n.id === selectedId) ?? null, [notes, selectedId]);
  const locked = selected ? isLocked(selected) : false;

  const filtered = useMemo(() => {
    if (activeFolder === "All Notes") return notes;
    return notes.filter((n) => n.folder === activeFolder);
  }, [notes, activeFolder]);

  const folderCounts = useMemo(() => {
    const c: Record<string, number> = {};
    notes.forEach((n) => {
      c[n.folder] = (c[n.folder] ?? 0) + 1;
    });
    c["All Notes"] = notes.length;
    return c;
  }, [notes]);

  // Auto-select the first note in view when nothing is open.
  useEffect(() => {
    if (!selectedId && filtered.length) setSelectedId(filtered[0].id);
  }, [filtered, selectedId]);

  const openNote = (n: Note) => {
    setSelectedId(n.id);
    setConfirmDelete(false);
    setSuggestion(null);
  };

  const handleNew = async () => {
    if (!draft.trim()) return;
    const n = await createNote(draft.trim(), activeFolder === "All Notes" ? "Research" : activeFolder);
    if (n) {
      setDraft("");
      openNote(n);
    }
  };

  const handleBodyChange = (html: string) => {
    if (!selected || locked) return;
    setSaving(true);
    updateNoteDebounced(selected.id, { body: html });
    // The dot clears shortly after the debounce window settles.
    window.clearTimeout((handleBodyChange as unknown as { _t?: number })._t);
    (handleBodyChange as unknown as { _t?: number })._t = window.setTimeout(() => setSaving(false), 900);
  };

  const handleTitleChange = (title: string) => {
    if (!selected || locked) return;
    setSaving(true);
    updateNoteDebounced(selected.id, { title });
    window.clearTimeout((handleTitleChange as unknown as { _t?: number })._t);
    (handleTitleChange as unknown as { _t?: number })._t = window.setTimeout(() => setSaving(false), 900);
  };

  const handleLock = async () => {
    if (!selected) return;
    const nowLocked = await toggleLock(selected.id);
    toast(nowLocked ? "Note locked — read-only" : "Note unlocked", nowLocked ? "info" : "success", "Notes");
  };

  const handleRoute = async () => {
    if (!selected) return;
    setRouting(true);
    setSuggestion(null);
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "route", text: selected.title, body: selected.body }),
      });
      const data = (await res.json()) as RouteSuggestion;
      setSuggestion(data);
    } catch {
      toast("Could not reach the router", "error", "Notes");
    } finally {
      setRouting(false);
    }
  };

  const acceptRoute = () => {
    if (!selected || !suggestion) return;
    const folderMap: Record<RouteSuggestion["destination"], string> = {
      research: "Research",
      literature: "Manuscripts",
      task: selected.folder,
    };
    if (suggestion.destination !== "task") {
      updateNote(selected.id, { folder: folderMap[suggestion.destination] });
      toast(`Filed into ${folderMap[suggestion.destination]}`, "success", "Routed");
    } else {
      // No tasks table write here — surface the suggestion as a confirmation.
      toast("Flagged as a task — add it in Agenda", "info", "Routed");
    }
    setSuggestion(null);
  };

  if (loading) return <div className="empty-state">Loading notes…</div>;

  return (
    <>
      <div className="modhead">
        <div className="eyebrow">Daily</div>
        <div className="rule" />
      </div>
      <h1 className="hero">Notes</h1>
      <p className="sub">Rich text, synced to Supabase. Press “/” for blocks.</p>
      <div className="divider" />

      <div style={{ display: "grid", gridTemplateColumns: "170px 250px 1fr", gap: 16, alignItems: "start" }}>
        {/* ── Folders (drag to reorder) ── */}
        <div>
          <div className="seclabel">Folders</div>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleFolderDragEnd}>
            <SortableContext items={folders} strategy={verticalListSortingStrategy}>
              {folders.map((f) => (
                <SortableFolder
                  key={f}
                  folder={f}
                  active={activeFolder}
                  count={folderCounts[f] ?? 0}
                  onPick={setActiveFolder}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>

        {/* ── Note list ── */}
        <div>
          <div className="capture" style={{ margin: "0 0 12px", padding: "9px 13px" }}>
            <input
              placeholder="New note…"
              style={{ padding: "3px 0", fontSize: 13 }}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleNew()}
            />
          </div>
          {filtered.length === 0 && (
            <p style={{ color: "var(--ink-faint)", fontSize: 12.5, padding: "4px 2px" }}>
              No notes in {activeFolder}. Type above to create one.
            </p>
          )}
          {filtered.map((n) => {
            const nLocked = isLocked(n);
            return (
              <div
                key={n.id}
                className="card"
                style={{
                  padding: 12,
                  borderLeft: selectedId === n.id ? "3px solid var(--accent)" : undefined,
                  marginBottom: 9,
                  cursor: "pointer",
                }}
                onClick={() => openNote(n)}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 13 }}>
                  {nLocked && <span style={{ color: "var(--gold)", display: "inline-flex" }}>{LOCK_ICON}</span>}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.title}</span>
                </div>
                <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 5, lineHeight: 1.5 }}>
                  {preview(n.body).slice(0, 88)}
                </div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", marginTop: 7 }}>
                  {n.folder} · {new Date(n.updated_at).toLocaleDateString()}
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Editor ── */}
        <div className="card">
          {selected ? (
            <>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                <input
                  value={selected.title}
                  readOnly={locked}
                  onChange={(e) => handleTitleChange(e.target.value)}
                  style={{
                    flex: 1,
                    fontFamily: "var(--serif)",
                    fontWeight: 400,
                    fontSize: 26,
                    marginBottom: 8,
                    background: "none",
                    border: "none",
                    color: "var(--ink)",
                    outline: "none",
                  }}
                />
                <button
                  type="button"
                  className={styles.btn}
                  onClick={handleLock}
                  title={locked ? "Unlock note" : "Lock note (read-only)"}
                  style={{ marginTop: 4, color: locked ? "var(--gold)" : "var(--ink-dim)" }}
                >
                  {locked ? LOCK_ICON : UNLOCK_ICON}
                </button>
              </div>

              <NotesEditor
                key={selected.id}
                content={selected.body}
                onChange={handleBodyChange}
                saving={saving}
                editable={!locked}
                onRoute={handleRoute}
                routing={routing}
              />

              {suggestion && (
                <div className={styles.routeCard}>
                  <div className={styles.routeEyebrow}>Suggested destination</div>
                  <div className={styles.routeDest}>{suggestion.label}</div>
                  <div className={styles.routeReason}>{suggestion.reason}</div>
                  {suggestion.tags?.length > 0 && (
                    <div className={styles.routeChips}>
                      {suggestion.tags.map((t) => (
                        <span key={t} className={styles.routeChip}>
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <Button variant="primary" onClick={acceptRoute}>
                      {suggestion.destination === "task" ? "Flag as task" : `Move to ${suggestion.label}`}
                    </Button>
                    <Button variant="ghost" onClick={() => setSuggestion(null)}>
                      Dismiss
                    </Button>
                  </div>
                </div>
              )}

              <button
                type="button"
                className="savebtn"
                style={{ marginTop: 12, ...(confirmDelete ? { color: "var(--down)", borderColor: "var(--down)" } : {}) }}
                onClick={() => {
                  if (locked) {
                    toast("Unlock the note before deleting", "warn", "Notes");
                    return;
                  }
                  if (!confirmDelete) {
                    setConfirmDelete(true);
                    return;
                  }
                  deleteNote(selected.id).then(() => {
                    setSelectedId(null);
                    setConfirmDelete(false);
                    toast("Note deleted", "success", "Notes");
                  });
                }}
                onBlur={() => setConfirmDelete(false)}
              >
                {confirmDelete ? "Click again to delete" : "Delete note"}
              </button>

              {visibleTags(selected).length > 0 && (
                <div className="chips" style={{ marginTop: 12 }}>
                  {visibleTags(selected).map((t) => (
                    <span key={t} className="chip">
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p style={{ color: "var(--ink-faint)" }}>Select or create a note to edit.</p>
          )}
        </div>
      </div>
    </>
  );
}
